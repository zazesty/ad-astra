/**
 * Unit tests for ask_oracle's routing logic — buildSlots / capEffort /
 * buildRoutePlan. Pure, no network. Run after `npm run build`.
 */
import { buildSlots, capEffort, buildRoutePlan, assemble } from "../build/oracleEngine.js";

let passed = 0,
  failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

// minimal Classification factory
const C = (over = {}) => ({
  difficulty: "moderate",
  domains: ["x"],
  needs_x: false,
  needs_grounding: false,
  suggested_lens: "default",
  suggested_panel_n: 1,
  reasoning_effort: "high",
  rationale: "r",
  ...over,
});

console.log("Unit: capEffort");
ok(capEffort("high", "low") === "low", "caps high→low");
ok(capEffort("low", "high") === "low", "never raises low→high");
ok(capEffort("medium") === "medium", "no cap passthrough");

console.log("\nUnit: buildSlots — base / capabilities");
{
  const s = buildSlots(C(), {});
  ok(s.length === 1 && s[0].id === "auto", "trivial → single auto seat");
  ok(s[0].provider === "openrouter", "auto seat is openrouter");
}
{
  const s = buildSlots(C({ needs_x: true }), {});
  ok(s.some((x) => x.id === "grok-x" && x.provider === "grok-direct" && x.grok_grounding === "required"), "needs_x → required grok-direct seat");
}
{
  const s = buildSlots(C({ needs_grounding: true }), {});
  const g = s.find((x) => x.id === "gemini-grounded");
  ok(!!g && g.provider === "openrouter" && g.grounded === true, "needs_grounding → OR-native grounded gemini seat");
}
{
  // both capabilities but classifier only asked for 1 seat — neither dropped
  const s = buildSlots(C({ needs_x: true, needs_grounding: true, suggested_panel_n: 1 }), {});
  ok(s.length === 2, "capability seats never dropped below their count");
  ok(s.some((x) => x.id === "grok-x") && s.some((x) => x.id === "gemini-grounded"), "both capability seats present");
}

console.log("\nUnit: buildSlots — panel sizing & overrides");
{
  const s = buildSlots(C({ suggested_panel_n: 3 }), {});
  ok(s.length === 3, "panel_n=3 → 3 seats");
  ok(s.some((x) => x.provider === "grok-direct"), "default panel guarantees >=1 grok-direct seat (anti-monoculture)");
  ok(s.some((x) => x.provider === "openrouter" && /gemini/i.test(x.model_slug)), "default panel includes a gemini seat (cross-family)");
}
{
  // auto reappears only as OVERFLOW once ALL three families (gemini, grok, gpt) are seated
  const s = buildSlots(C({ suggested_panel_n: 4 }), {});
  ok(s.length === 4, "panel_n=4 → 4 seats");
  ok(s[3].model_slug === "openrouter/auto", "auto returns as the 4th overflow seat once gemini+grok+gpt are seated");
  const families = new Set(s.slice(0, 3).map((x) => (x.provider === "grok-direct" ? "grok" : /gemini/i.test(x.model_slug) ? "gemini" : "gpt")));
  ok(families.size === 3, "first 3 seats span three distinct families before the wildcard");
}

{
  // the exact failing case: a default 2-seat panel must be cross-family, no auto
  const s = buildSlots(C({ suggested_panel_n: 2 }), {});
  ok(s.length === 2, "panel_n=2 → 2 seats");
  const families = new Set(s.map((x) => (x.provider === "grok-direct" ? "grok" : /gemini/i.test(x.model_slug) ? "gemini" : x.model_slug)));
  ok(families.size === 2, "default 2-seat panel spans two families (gemini + grok), not a monoculture");
  ok(!s.some((x) => x.model_slug === "openrouter/auto"), "auto NOT used at n=2 — diversity slots fill first");
}
{
  // 3-seat Claude-caller panel: gemini → grok → gpt (three genuine cross-family
  // voices). auto is demoted to the 4th/overflow slot (was 3rd pre-2026-06-26).
  const s = buildSlots(C({ suggested_panel_n: 3 }), {});
  ok(s.length === 3, "panel_n=3 → 3 seats");
  ok(/gemini/i.test(s[0].model_slug), "default 3-seat: gemini leads (head slot 0)");
  ok(s[1].provider === "grok-direct", "default 3-seat: grok contrarian second (head slot 1)");
  ok(/gpt/i.test(s[2].model_slug), "default 3-seat: gpt is the 3rd cross-family voice (head slot 2, NEW 2026-06-26)");
  ok(!s.some((x) => x.model_slug === "openrouter/auto"), "auto NOT used at n=3 — three families fill before the wildcard");
}
{
  // a grok capability seat already covers the grok family → filler adds gemini, not a 2nd grok
  const s = buildSlots(C({ needs_x: true, suggested_panel_n: 2 }), {});
  ok(s[0].id === "grok-x", "grok-x capability seat leads");
  ok(s.some((x) => x.provider === "openrouter" && /gemini/i.test(x.model_slug)), "missing gemini family is the one seeded next (no redundant 2nd grok)");
}
{
  // caller-restricted pool is honored verbatim — diversity injection does NOT fire
  const s = buildSlots(C({ suggested_panel_n: 2 }), { model_slugs: ["~google/gemini-pro-latest"] });
  ok(s.every((x) => x.model_slug === "~google/gemini-pro-latest"), "model_slugs restriction overrides diversity (explicit caller intent wins)");
}
{
  // GROK CALLER (exclude_family:"grok"): the contrarian grok-direct seat is DROPPED
  // (Grok can't be its own dissenting voice) and replaced by gemini → gpt → auto.
  const s1 = buildSlots(C({ suggested_panel_n: 1 }), { exclude_family: "grok" });
  ok(s1.length === 1 && /gemini/i.test(s1[0].model_slug), "grok-caller n=1 → single gemini seat (not auto, not grok)");

  const s2 = buildSlots(C({ suggested_panel_n: 2 }), { exclude_family: "grok" });
  ok(s2.length === 2, "grok-caller n=2 → 2 seats");
  ok(s2.every((x) => x.provider !== "grok-direct" || !!x.grok_grounding), "grok-caller reasoning seats have NO grok-direct voice");
  ok(/gemini/i.test(s2[0].model_slug) && /gpt/i.test(s2[1].model_slug), "grok-caller n=2 → gemini then gpt (the two dissenting families)");

  const s3 = buildSlots(C({ suggested_panel_n: 3 }), { exclude_family: "grok" });
  ok(s3.length === 3, "grok-caller n=3 → 3 seats");
  ok(s3[2].model_slug === "openrouter/auto", "grok-caller n=3 → auto is the 3rd/overflow voice only");
  ok(!s3.some((x) => x.provider === "grok-direct" && !x.grok_grounding), "no grok-direct REASONING seat anywhere on a grok-caller panel");
}
{
  // GROK CALLER keeps capability seats — grok-x is data retrieval, NOT Grok's opinion
  const s = buildSlots(C({ needs_x: true, suggested_panel_n: 3 }), { exclude_family: "grok" });
  ok(s[0].id === "grok-x" && s[0].provider === "grok-direct", "grok-caller STILL seats the grok-x CAPABILITY seat (data, not opinion)");
  ok(!s.slice(1).some((x) => x.provider === "grok-direct"), "but no grok-direct REASONING seat among the rest");
  ok(/gemini/i.test(s[1].model_slug) && /gpt/i.test(s[2].model_slug), "reasoning voices fill gemini → gpt after the capability seat");
}
{
  const s = buildSlots(C({ needs_x: true, suggested_panel_n: 3 }), {});
  ok(s.length === 3 && s[0].id === "grok-x", "capability seat counts toward panel size, listed first");
}
{
  const s = buildSlots(C(), { n: 2 });
  ok(s.length === 2, "ov.n forces seat count");
}
{
  const s = buildSlots(C({ needs_x: true, needs_grounding: true }), { n: 1 });
  ok(s.length === 2, "ov.n still floored by capability seats");
}
{
  const s = buildSlots(C({ reasoning_effort: "high" }), { max_effort: "low" });
  ok(s.every((x) => x.reasoning_effort === "low"), "max_effort caps the CLASSIFIER's effort");
}
{
  // explicit reasoning_effort is the caller's intent — it WINS over max_effort
  const s = buildSlots(C(), { reasoning_effort: "high", max_effort: "low" });
  ok(s.every((x) => x.reasoning_effort === "high"), "explicit reasoning_effort beats max_effort");
}
{
  const s = buildSlots(C({ reasoning_effort: "high" }), { reasoning_effort: "low" });
  ok(s.every((x) => x.reasoning_effort === "low"), "explicit reasoning_effort overrides classifier (not raised)");
}
{
  const s = buildSlots(C(), { force_x: true, force_grounding: true });
  ok(s.some((x) => x.id === "grok-x") && s.some((x) => x.id === "gemini-grounded"), "force_x + force_grounding add both seats");
}
{
  const s = buildSlots(C({ suggested_panel_n: 2 }), { model_slugs: ["google/gemini-3.1-pro"] });
  ok(s.every((x) => x.model_slug === "google/gemini-3.1-pro"), "model_slugs pins the reasoning pool");
}
{
  const s = buildSlots(C(), { force_model: "x-ai/grok-4.3" });
  ok(s.some((x) => x.provider === "grok-direct" && !x.grok_grounding), "force_model grok → grok-direct reasoning seat (grounding off)");
}
{
  const s = buildSlots(C(), { lens: "austrian" });
  ok(s.every((x) => x.lens === "austrian"), "ov.lens overrides lens on every seat");
}

console.log("\nUnit: buildRoutePlan");
{
  const s = buildSlots(C({ needs_x: true, needs_grounding: true, domains: ["econ"], rationale: "rx" }), {});
  const r = buildRoutePlan(s, C({ needs_x: true, needs_grounding: true, domains: ["econ"], rationale: "rx" }), "classifier", "google/gemini-3.1-flash-lite");
  ok(r.mode === "panel" && r.panel_n === 2, "mode/panel_n from seat count");
  ok(r.used_x_search === true && r.used_grounding === true, "capability flags surfaced");
  ok(r.models.includes("grok-4.3"), "grok placeholder resolved to grok-4.3 in models[]");
  ok(r.source === "classifier" && r.classifier_model === "google/gemini-3.1-flash-lite", "decided-by recorded");
  ok(r.classifier_error === undefined, "no error on clean path");
  ok(r.domains[0] === "econ" && r.rationale === "rx", "domains/rationale telemetry carried");
}
{
  const s = buildSlots(C(), {});
  const r = buildRoutePlan(s, C(), "prefilter", null, "boom");
  ok(r.source === "prefilter" && r.classifier_model === null && r.classifier_error === "boom", "fallback route carries classifier_error + null model");
}

console.log("\nUnit: assemble — REALIZED capability flags (route reflects what fired)");
{
  const cc = C({ needs_x: true, needs_grounding: true, suggested_panel_n: 2 });
  const seats = buildSlots(cc, {});
  const route = buildRoutePlan(seats, cc, "classifier", "m");
  ok(route.used_x_search === true && route.used_grounding === true, "planned flags both true pre-exec");
  const grokX = seats.find((s) => s.id === "grok-x");
  const grounded = seats.find((s) => s.id === "gemini-grounded");
  // grounded seat TIMED OUT, grok-x ok → grounding must drop to false, x stays true
  const resp = await assemble(
    {},
    route,
    [
      { seat: grokX, status: "ok", text: "t", citations: ["c"] },
      { seat: grounded, status: "timeout", error: "timed out" },
    ],
    {},
    false,
  );
  ok(resp.route.used_grounding === false, "timed-out grounded seat → used_grounding flips to false (no lie)");
  ok(resp.route.used_x_search === true, "ok grok-x seat → used_x_search stays true");
  ok(resp.degraded === true, "a non-ok seat marks the response degraded");
}
{
  const cc = C({ needs_grounding: true });
  const seats = buildSlots(cc, {});
  const route = buildRoutePlan(seats, cc, "classifier", "m");
  const grounded = seats.find((s) => s.id === "gemini-grounded");
  const resp = await assemble({}, route, [{ seat: grounded, status: "ok", text: "t", citations: ["c"] }], {}, false);
  ok(resp.route.used_grounding === true, "ok grounded seat → used_grounding stays true");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
