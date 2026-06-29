/**
 * Unit tests for callOpenRouter timeout/abort vs retry behavior.
 * Run AFTER `npm run build`. Mocks global fetch — no network billed.
 */
import { callOpenRouter, OpenRouterError, isTransientError } from "../build/geminiCore.js";

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();