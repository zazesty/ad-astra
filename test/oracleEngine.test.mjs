/**
 * Unit tests for ask_oracle's routing logic — buildSlots / capEffort /
 * buildRoutePlan. Pure, no network. Run after `npm run build`.
 */
import {
  buildSlots,
  capEffort,
  buildRoutePlan,
  assemble,
  FUSION_MODEL_SLUG,
  DEFAULT_FUSION_PRESET,
} from "../build/oracleEngine.js";

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
  // Grok-primary default (2026-08): multi-seat = gemini → gpt → auto, NO grok opinion seat
  const s = buildSlots(C({ suggested_panel_n: 3 }), {});
  ok(s.length === 3, "panel_n=3 → 3 seats");
  ok(!s.some((x) => x.provider === "grok-direct" && !x.grok_grounding), "default panel has NO grok-direct reasoning seat (Grok-primary)");
  ok(s.some((x) => x.provider === "openrouter" && /gemini/i.test(x.model_slug)), "default panel includes a gemini seat");
  ok(s.some((x) => /gpt/i.test(x.model_slug)), "default panel includes a gpt seat");
}
{
  // overflow auto once gemini+gpt seated (no grok family in default pool)
  const s = buildSlots(C({ suggested_panel_n: 4 }), {});
  ok(s.length === 4, "panel_n=4 → 4 seats");
  ok(s[2].model_slug === "openrouter/auto", "auto is 3rd once gemini+gpt are seated");
  ok(/gemini/i.test(s[0].model_slug) && /gpt/i.test(s[1].model_slug), "default 4-seat head: gemini then gpt");
  ok(!s.some((x) => x.provider === "grok-direct" && !x.grok_grounding), "default 4-seat: still no grok-direct reasoning");
}

{
  // default 2-seat: gemini + gpt (not gemini + grok)
  const s = buildSlots(C({ suggested_panel_n: 2 }), {});
  ok(s.length === 2, "panel_n=2 → 2 seats");
  ok(/gemini/i.test(s[0].model_slug) && /gpt/i.test(s[1].model_slug), "default 2-seat: gemini + gpt");
  ok(!s.some((x) => x.model_slug === "openrouter/auto"), "auto NOT used at n=2 — diversity slots fill first");
  ok(!s.some((x) => x.provider === "grok-direct"), "default 2-seat: no grok-direct");
}
{
  // 3-seat Grok-primary: gemini → gpt → auto
  const s = buildSlots(C({ suggested_panel_n: 3 }), {});
  ok(s.length === 3, "panel_n=3 → 3 seats");
  ok(/gemini/i.test(s[0].model_slug), "default 3-seat: gemini leads");
  ok(/gpt/i.test(s[1].model_slug), "default 3-seat: gpt second");
  ok(s[2].model_slug === "openrouter/auto", "default 3-seat: auto is overflow 3rd");
}
{
  // opt-in full cross-family for non-Grok callers (exclude_family none/off)
  const s = buildSlots(C({ suggested_panel_n: 3 }), { exclude_family: "none" });
  ok(/gemini/i.test(s[0].model_slug), "none: gemini leads");
  ok(s[1].provider === "grok-direct", "none: grok contrarian second");
  ok(/gpt/i.test(s[2].model_slug), "none: gpt third");
}
{
  // a grok capability seat already covers the grok family → filler adds gemini, not a 2nd grok
  const s = buildSlots(C({ needs_x: true, suggested_panel_n: 2 }), {});
  ok(s[0].id === "grok-x", "grok-x capability seat leads");
  ok(s.some((x) => x.provider === "openrouter" && /gemini/i.test(x.model_slug)), "missing gemini family is the one seeded next (no redundant 2nd grok)");
}
{
  // exclude_family:"grok" is legacy synonym for default Grok-primary pool
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
  // DEFAULT keeps capability seats — grok-x is data retrieval, NOT Grok's opinion
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
  const s = buildSlots(C(), { lens: "austrian" });
  ok(s.every((x) => x.lens === "austrian"), "ov.lens overrides lens on every seat");
}

console.log("\nUnit: buildRoutePlan");
{
  const s = buildSlots(C({ needs_x: true, needs_grounding: true, domains: ["econ"], rationale: "rx" }), {});
  const r = buildRoutePlan(s, C({ needs_x: true, needs_grounding: true, domains: ["econ"], rationale: "rx" }), "classifier", "google/gemini-3.1-flash-lite");
  ok(r.mode === "panel" && r.panel_n === 2, "mode/panel_n from seat count");
  ok(r.used_x_search === true && r.used_grounding === true, "capability flags surfaced");
  ok(r.models.includes("grok-4.5"), "grok placeholder resolved to grok-4.5 in models[]");
  ok(r.source === "classifier" && r.classifier_model === "google/gemini-3.1-flash-lite", "decided-by recorded");
  ok(r.classifier_error === undefined, "no error on clean path");
  ok(r.domains[0] === "econ" && r.rationale === "rx", "domains/rationale telemetry carried");
}
{
  const s = buildSlots(C(), {});
  const r = buildRoutePlan(s, C(), "prefilter", null, "boom");
  ok(r.source === "prefilter" && r.classifier_model === null && r.classifier_error === "boom", "fallback route carries classifier_error + null model");
}

console.log("\nUnit: buildSlots — engine:fusion");
{
  const s = buildSlots(C(), { engine: "fusion" });
  ok(s.length === 1 && s[0].id === "fusion", "fusion engine → single fusion seat");
  ok(s[0].model_slug === FUSION_MODEL_SLUG, "fusion seat uses openrouter/fusion slug");
  ok(s[0].fusion_preset === DEFAULT_FUSION_PRESET, "default fusion_preset is general-budget");
}
{
  const s = buildSlots(C({ suggested_panel_n: 4 }), { engine: "fusion", n: 4, exclude_family: "grok" });
  ok(s.length === 1 && s[0].id === "fusion", "fusion ignores panel_size and exclude_family");
}
{
  const s = buildSlots(C(), { engine: "fusion", fusion_preset: "general-high" });
  ok(s[0].fusion_preset === "general-high", "fusion_preset override honored on seat");
}
{
  const s = buildSlots(C({ needs_x: true }), { engine: "fusion", force_grounding: true });
  ok(s.length === 3, "fusion + both capabilities → 2 capability + 1 fusion");
  ok(s.some((x) => x.id === "grok-x") && s.some((x) => x.id === "gemini-grounded"), "capability seats kept with fusion");
  ok(s[s.length - 1].id === "fusion", "fusion seat trails capabilities");
}
{
  const s = buildSlots(C(), {});
  ok(s.length === 1 && s[0].id === "auto", "default path unchanged without engine:fusion");
}

console.log("\nUnit: assemble — fusion synthesize + tags");
{
  const fusionSeat = {
    id: "fusion",
    provider: "openrouter",
    model_slug: FUSION_MODEL_SLUG,
    lens: "default",
    reasoning_effort: "high",
  };
  const route = { mode: "single", models: [FUSION_MODEL_SLUG], lens: "default", reasoning_effort: "high", used_x_search: false, used_grounding: false, panel_n: 1, source: "override", classifier_model: null, rationale: "r", engine: "fusion", fusion_preset: "general-budget" };
  const resp = await assemble({}, route, [{ seat: fusionSeat, status: "ok", text: "fusion answer" }], { synthesize: true }, false);
  ok(resp.answer === "fusion answer", "solo fusion + synthesize skips gemini judge");
  ok(!resp.raw, "synthesize path does not return raw");
}
{
  const fusionSeat = {
    id: "fusion",
    provider: "openrouter",
    model_slug: FUSION_MODEL_SLUG,
    lens: "default",
    reasoning_effort: "high",
  };
  const route = { mode: "single", models: [FUSION_MODEL_SLUG], lens: "default", reasoning_effort: "high", used_x_search: false, used_grounding: false, panel_n: 1, source: "override", classifier_model: null, rationale: "r" };
  const resp = await assemble({}, route, [{ seat: fusionSeat, status: "ok", text: "t" }], {}, false);
  ok(resp.raw?.[0]?.tags?.includes("fusion"), "fusion seat tagged fusion in raw output");
}

// B4: hybrid fusion + capability seat, synthesize. The solo-fusion shortcut must NOT
// fire (that regression silently dropped a co-succeeding grounded/x seat + its
// citations, oracleEngine.ts:723); both seats must reach the judge. Offline: stub
// global fetch so the OR judge call is deterministic and networkless.
console.log("\nUnit: assemble — hybrid fusion + capability synth (offline, stubbed OR judge)");
{
  const realFetch = globalThis.fetch;
  let judgeBody = null;
  globalThis.fetch = async (_url, init) => {
    judgeBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "MERGED: fusion + grounded" } }] }),
      text: async () => "",
    };
  };
  try {
    const fusionSeat = { id: "fusion", provider: "openrouter", model_slug: FUSION_MODEL_SLUG, lens: "default", reasoning_effort: "high" };
    const groundedSeat = { id: "gemini-grounded", provider: "openrouter", model_slug: "google/gemini-pro-latest", grounded: true, lens: "default", reasoning_effort: "high" };
    const route = { mode: "panel", models: [FUSION_MODEL_SLUG, "google/gemini-pro-latest"], lens: "default", reasoning_effort: "high", used_x_search: false, used_grounding: false, panel_n: 2, source: "override", classifier_model: null, rationale: "r", engine: "fusion", fusion_preset: "general-budget" };
    const results = [
      { seat: fusionSeat, status: "ok", text: "fusion answer" },
      { seat: groundedSeat, status: "ok", text: "grounded answer", citations: ["https://src.example/a"] },
    ];
    const resp = await assemble({ openrouterApiKey: "test-key" }, route, results, { synthesize: true }, false);
    ok(resp.answer === "MERGED: fusion + grounded", "hybrid → judge merges (solo-fusion shortcut skipped)");
    ok(!resp.raw, "hybrid synthesize returns answer, no raw");
    const judgeInput = (judgeBody?.messages ?? []).map((m) => m.content).join("\n");
    ok(judgeInput.includes("fusion answer") && judgeInput.includes("grounded answer"), "both seats fed to judge (capability seat not dropped)");
    ok(judgeInput.includes("https://src.example/a"), "capability citations preserved into judge input");
    ok(route.used_grounding === true, "realized used_grounding true when grounded seat ok");
  } finally {
    globalThis.fetch = realFetch;
  }
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

console.log("\nUnit: assemble — recovery_note when OR dies and Grok recovers");
{
  const cc = C({ suggested_panel_n: 3 });
  const seats = buildSlots(cc, {});
  const route = buildRoutePlan(seats, cc, "classifier", "m");
  // Force a grok-direct + openrouter gemini pair if not already present.
  const grokSeat = seats.find((s) => s.provider === "grok-direct") || {
    id: "reason-grok",
    provider: "grok-direct",
    model_slug: "grok",
    reasoning_effort: "high",
    lens: "default",
  };
  const gptSeat = {
    id: "reason-gpt",
    provider: "openrouter",
    model_slug: "openai/gpt-5.6-terra",
    reasoning_effort: "high",
    lens: "default",
  };
  const gemSeat = {
    id: "gemini-grounded",
    provider: "openrouter",
    model_slug: "~google/gemini-pro-latest",
    grounded: true,
    reasoning_effort: "high",
    lens: "default",
  };
  const resp = await assemble(
    {},
    route,
    [
      { seat: grokSeat, status: "ok", text: "grok lived", transport: "direct" },
      {
        seat: gptSeat,
        status: "timeout",
        error: "The operation was aborted due to timeout",
      },
      {
        seat: gemSeat,
        status: "timeout",
        error: "OpenRouter /chat/completions network failure: The operation was aborted due to timeout",
      },
    ],
    {},
    false,
  );
  ok(resp.degraded === true, "recovery_note case is degraded");
  ok(
    typeof resp.recovery_note === "string" && /OpenRouter stalled/i.test(resp.recovery_note),
    "recovery_note names OpenRouter stall + Grok recovery",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
