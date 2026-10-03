/**
 * Unit tests for callOpenRouter timeout/abort vs retry behavior.
 * Run AFTER `npm run build`. Mocks global fetch — no network billed.
 */
import { callOpenRouter, OpenRouterError, isTransientError, isOpenAiSolSlug } from "../build/geminiCore.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const realFetch = globalThis.fetch;

/** Simulate a hung fetch that rejects when AbortSignal fires. */
function hangingFetch() {
  return async (_url, init) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });
  };
}

async function run() {
  console.log("Unit: callOpenRouter timeout + retry");
  // AbortSignal.timeout() is unref'd, so the hang case would otherwise let
  // this process exit 0 before any assertion. Cleared before we exit.
  const keepAlive = setInterval(() => {}, 1000);

  // 1. Hang → single attempt, transient OpenRouterError, no retry loop.
  {
    let attempts = 0;
    globalThis.fetch = async (...args) => {
      attempts++;
      return hangingFetch()(...args);
    };
    const t0 = Date.now();
    let err;
    try {
      await callOpenRouter("sk-test", "gemini-2.5-flash", "hi", { attempt_timeout_ms: 80 });
    } catch (e) {
      err = e;
    }
    globalThis.fetch = realFetch;
    const elapsed = Date.now() - t0;
    check("hang: throws OpenRouterError", err instanceof OpenRouterError);
    check("hang: transient for failover", isTransientError(err));
    check("hang: only 1 fetch attempt", attempts === 1);
    check("hang: aborts quickly (< 500ms)", elapsed < 500);
  }

  // 2. 429 → retries internally before throwing.
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      return new Response("rate limited", { status: 429 });
    };
    let err;
    try {
      await callOpenRouter("sk-test", "gemini-2.5-flash", "hi", { attempt_timeout_ms: 5000 });
    } catch (e) {
      err = e;
    }
    globalThis.fetch = realFetch;
    check("429: throws after retries", err instanceof OpenRouterError && err.status === 429);
    check("429: retried 3 times", attempts === 3);
  }

  // 3. Success on second attempt after 503.
  {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts < 2) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    let text = "";
    try {
      const r = await callOpenRouter("sk-test", "gemini-2.5-flash", "hi", { attempt_timeout_ms: 5000 });
      text = r.text;
    } catch (e) {
      text = `ERR:${e.message}`;
    }
    globalThis.fetch = realFetch;
    check("503 then ok: succeeds", text === "ok");
    check("503 then ok: 2 attempts", attempts === 2);
  }

  // 4. Service tier: Sol fast, Gemini priority, everyone else unset.
  {
    async function tierFor(slug) {
      let body;
      globalThis.fetch = async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      await callOpenRouter("sk-test", slug, "hi", { attempt_timeout_ms: 5000 });
      globalThis.fetch = realFetch;
      return body;
    }
    const solSlugs = [
      "~openai/gpt-sol-latest",
      "openai/gpt-6.1-sol",
      "openai/gpt-6-sol",
      "openai/gpt-6.1-sol-pro",
      "openai/gpt-5.6-sol",
    ];
    for (const slug of solSlugs) {
      const body = await tierFor(slug);
      check(`sol tier fast: ${slug}`, body.service_tier === "fast" && body.provider === undefined);
      check(`sol detector: ${slug}`, isOpenAiSolSlug(slug));
    }
    const gemini = await tierFor("~google/gemini-flash-latest");
    check("gemini tier stays priority", gemini.service_tier === "priority");
    const bareGemini = await tierFor("gemini-2.5-flash");
    check("bare gemini tier stays priority", bareGemini.service_tier === "priority" && bareGemini.model === "google/gemini-2.5-flash");
    for (const slug of ["openai/gpt-6-luna", "openrouter/auto-beta", "~anthropic/claude-sonnet-latest", "x-ai/grok-4.6"]) {
      const body = await tierFor(slug);
      check(`no fast tier: ${slug}`, body.service_tier === undefined);
      check(`not a sol slug: ${slug}`, isOpenAiSolSlug(slug) === false);
    }
    check("luna word is not sol", isOpenAiSolSlug("openai/gpt-6.1-solution") === false);
  }

  clearInterval(keepAlive);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();