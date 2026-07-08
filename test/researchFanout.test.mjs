/**
 * Unit tests for research_fanout pure helpers + timeouts shared module.
 *   node test/researchFanout.test.mjs
 */
import { coerceMode, dedupeCitations, ensureForceX, MAX_LEGS_HARD } from "../build/researchFanout.js";
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
