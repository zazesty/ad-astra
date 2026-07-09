/**
 * Unit tests for research_fanout pure helpers + timeouts shared module.
 *   node test/researchFanout.test.mjs
 */
import {
  coerceMode,
  dedupeCitations,
  ensureForceX,
  MAX_LEGS_HARD,
  summarizeLegs,
} from "../build/researchFanout.js";
import { withTimeout, remainingMs, seatBudgetMs } from "../build/timeouts.js";

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

console.log("Unit: research_fanout helpers + timeouts");

check("coerceMode default", coerceMode("nope") === "gemini_grounded");
check("coerceMode grok_x", coerceMode("grok_x") === "grok_x");
check("coerceMode x alias", coerceMode("x_search") === "grok_x");
check("coerceMode grok_grounded", coerceMode("grok") === "grok_grounded");

check("dedupeCitations order+unique", JSON.stringify(dedupeCitations(["a", "b", "a", ""])) === JSON.stringify(["a", "b"]));

const plans = ensureForceX([{ query: "q", mode: "gemini_grounded" }], true, 4);
check("ensureForceX adds grok_x", plans.some((p) => p.mode === "grok_x"));
check("ensureForceX respects max", ensureForceX([{ query: "q", mode: "gemini_grounded" }], true, 1).length === 1);
check("MAX_LEGS_HARD is 5", MAX_LEGS_HARD === 5);

const t0 = Date.now() - 10_000;
check("remainingMs", remainingMs(t0, 85_000) <= 75_000 && remainingMs(t0, 85_000) >= 74_000);
check("seatBudgetMs caps", seatBudgetMs(t0, 85_000, 45_000) === 45_000);

let timed = false;
try {
  await withTimeout(new Promise((r) => setTimeout(r, 500)), 30, "t");
} catch (e) {
  timed = /timed out/.test(e.message);
}
check("withTimeout fires", timed);

// E2 soak contract (offline): partial legs → degraded + citation union from ok only.
{
  const partial = summarizeLegs([
    {
      id: "leg-0",
      query: "a",
      mode: "gemini_grounded",
      status: "ok",
      answer: "yes",
      citations: ["https://a.example/1", "https://a.example/2"],
      latency_ms: 100,
    },
    {
      id: "leg-1",
      query: "b",
      mode: "gemini_grounded",
      status: "timeout",
      citations: ["https://should-drop.example"],
      latency_ms: 45_000,
      error: "leg-1 timed out after 45000ms",
    },
    {
      id: "leg-2",
      query: "c",
      mode: "grok_x",
      status: "ok",
      answer: "social",
      citations: ["https://a.example/1", "https://x.example/3"],
      latency_ms: 200,
    },
  ]);
  check("E2 partial degraded", partial.degraded === true);
  check("E2 okCount 2/3", partial.okCount === 2 && partial.slots_status === "2/3 legs ok");
  check(
    "E2 citation union ok-only + dedupe",
    JSON.stringify(partial.citations) ===
      JSON.stringify(["https://a.example/1", "https://a.example/2", "https://x.example/3"]),
  );

  const allOk = summarizeLegs([
    {
      id: "leg-0",
      query: "a",
      mode: "gemini_grounded",
      status: "ok",
      answer: "x",
      citations: ["https://only.example"],
      latency_ms: 1,
    },
  ]);
  check("E2 all-ok not degraded", allOk.degraded === false && allOk.okCount === 1);

  const none = summarizeLegs([
    {
      id: "leg-0",
      query: "a",
      mode: "gemini_grounded",
      status: "error",
      citations: [],
      latency_ms: 1,
      error: "boom",
    },
  ]);
  check("E2 zero-ok degraded empty cites", none.degraded === true && none.citations.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
