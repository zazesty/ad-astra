# ask_oracle — consolidated build spec

**Supersedes** `ask_oracle_handoff.md` + `ask_oracle_dispatch.md` (keep those for history;
build from this one). Reconciles every conflict between the two and pins the open seams.

Single front door over astra's model layer: classify the prompt, build a route, fan out
concurrently, return labeled raw (or synthesized) output **plus a legible `route` object**.
Ships **beside** ask_panel; the `specs` override is the byte-for-byte ask_panel path.

```
prompt ──> [1] prefilter (regex + explicit-specs check, NO model call)
              │  explicit `specs`?  ──yes──> deterministic bypass (== ask_panel today)
              ▼ no
          [2] classifier (gemini-3.1-flash-lite, structured JSON)   ──fail──┐
              ▼                                                              │
          [3] buildSlots ── capability seats first, never dropped           │
              ▼                                                    prefilter fallback
          [4] executeSlots (allSettled + per-slot timeout)         (single auto, fail-loud)
              ▼                                                              │
          [5] assemble ──> { route, slots_status, degraded, raw? | answer? }◄┘
```

---

## [0] Provider seam — what goes DIRECT vs through OpenRouter

This is the load-bearing decision; everything else follows from it.

| Capability | Path | Why |
|---|---|---|
| **Live X / x_search** | **Grok DIRECT** (`callGrok`, `/responses`, `x_search` tool) | Native to xAI. **Not exposed through OpenRouter** — OR serves Grok as plain chat, so routing X through OR silently loses the X-grounding tool. Forced-X must stay direct. |
| **Web grounding** | **OpenRouter native** (`callOpenRouter`, gemini slug + `plugins:[{id:"web",engine:"native"}]`) | Direct/AI-Studio grounding is model-discretion and **silently misses** (citations:[]); it cannot be forced. The proven path is OR native + retries. **Never `gemini-direct` for a forced grounding seat.** |
| **Pure reasoning / outside-check** | **OpenRouter** (`openrouter/auto`, or a pinned slug) | `auto` lets OR pick the model; pinned slug (e.g. `google/gemini-3.1-pro`) for a known seat. Lenses ride through; native tools do NOT. |

**Grok-via-OpenRouter for reasoning? — NO (revised 2026-06-24).** `callGrok` (direct) must exist
anyway for x_search, and it already does grounding:"off" reasoning with full, reliable effort control
and no fee. So routing grok *reasoning* through OR **consolidates nothing** (the direct core stays
regardless) while adding a 5% BYOK fee, an extra hop, and exposure to the OR xAI effort-propagation
bug. **All Grok goes direct** (`callGrok`: x_search seats AND reasoning seats). OR handles **gemini
(grounded + reasoning) + `openrouter/auto`** only. Keep the xAI BYOK key in OR solely so the `auto`
seat *can* surface Grok if OR's router picks it (low stakes there — effort precision matters least on
the wildcard seat); an explicit grok reasoning seat (the literal `grok` diversity-pool slug) is a
`grok-direct` provider seat. This also **removes the grok-effort-propagation verify item** — moot now.

**OR "prioritized models" — three distinct mechanisms, don't conflate them:**
- `models: ["A","B","C"]` — ordered **fallback** list. OR tries A; only on error/unavailable/rate-limit
  does it fall to B. This is **resilience**, NOT per-prompt intelligence.
- `openrouter/auto` — OR's **Auto Router** picks the single best model *per prompt*. This is the **intelligence**.
- `provider:{ sort:"price"|"throughput", order:[…] }` — picks the **endpoint/host** for a given model.

They compose with — and don't replace — the classifier:
- The **classifier** decides *shape* (#seats, capabilities, lens, effort).
- **`openrouter/auto`** decides the *specific reasoning model* within the auto seat.
- **`models:[…]`** hardens each OR seat (classifier model + grounded seat + reasoning seats) against a
  single model being down. e.g. a grok reasoning seat = `{models:["x-ai/grok-4.3","google/gemini-3.1-pro"]}`.

You do **not** need a separate OR-priority router; classifier + `auto` + `models:[]` fallback covers intent.

---

## [1] Prefilter (deterministic, before any model call)

- **Explicit `specs` present** → skip everything; run those specs verbatim through the existing
  ask_panel runner. **Invariant: byte-for-byte identical to current ask_panel.** Classifier never runs.
- **Pre-seed** (regex only *seeds*, classifier decides — kept as-is per owner):
  - Live-X: `/\b(latest|today|right now|breaking|on x|tweet|posted|sentiment)\b/i` → `needs_x=true`
  - Grounding: `/\b(current|as of|recent|cite|source|who is|price of)\b/i` → `needs_grounding=true`
- **No trivial skip-classifier gate.** (Removed — see §2 note. Latency isn't a concern, and the
  old gate left "which cheap model / why skip" undefined.) Everything that isn't an explicit-`specs`
  bypass goes through the classifier.

---

## [2] Classifier

- **Transport: through OpenRouter** (`callOpenRouter`), the same gemini-via-OR path the panel uses — one path, not two. Thinking = minimal.
- **Model (owner decision — latency over antifragility):** pin **`google/gemini-3.1-flash-lite`** via
  OR — flash-lite is the fastest/cheapest tier, and a classifier on the hot path wants minimum latency.
  (There is **no `gemini-flash-lite-latest`** anywhere — verified on OR and AI Studio — so the only
  `-latest` option would be full `~google/gemini-flash-latest`, which is slower; rejected for latency.)
  - Fallback `models:["google/gemini-2.5-flash-lite"]` for availability.
  - Add a lightweight availability/rename alert on the pinned slug (no cost guard — flash-lite is cheap).
  - **Avoid OR `:free` slugs** on this hot path — rate-limited and latency-unstable.
- **Output: structured JSON via OR `response_format`.** Pass `response_format:{type:"json_schema",
  json_schema:{…}}` (Gemini supports structured outputs through OR) — prompt-only "emit JSON, no
  backticks" is unreliable at flash-lite/minimal (fences, trailing prose). Keep a defensive `JSON.parse`
  (strip ```fences) as belt-and-suspenders. Requires `response_format` passthrough in `callOpenRouter` (§8).

Schema — **field order is deliberate**: `domains` is emitted *early* so the model commits to a domain
before deciding capabilities/lens, conditioning those fields on it (a cheap autoregressive chain-of-thought
at thinking=minimal). It is both a reasoning scaffold AND telemetry; dispatch doesn't consume it directly.
```json
{
  "difficulty":        "trivial | simple | moderate | hard",
  "domains":           "string[] — e.g. ['current_events','econ','code']; scaffolds the fields below + logged in route",
  "needs_x":           "boolean — LIVE X/Twitter posts, real-time sentiment, handle lookup",
  "needs_grounding":   "boolean — current web facts/citations NOT specific to X",
  "suggested_lens":    "default | georgist | austrian | state-capacity | steelman-then-break | pre-mortem",
  "suggested_panel_n": "integer — 1 simple, 2-3 moderate, 3-4 hard/contested",
  "reasoning_effort":  "low | medium | high",
  "rationale":         "string <= 15 words"
}
```

System-prompt rules (unchanged from handoff): one model unless contested/multi-perspective/high-stakes;
`needs_x` only for genuinely live X data; non-default lens only when the domain calls for it; effort
scales with difficulty, not length.

**Failure → fail-loud fallback** (owner-confirmed): on classifier error *or* parse failure, route from
prefilter seeds — a single `openrouter/auto` seat, plus any prefilter-seeded capability seat. Set
`source:"prefilter"`, `classifier_model:null`, `classifier_error:"<msg>"`, **`degraded:true`**, and
`console.error` to journald. The route object carries the error so the caller always knows it happened.

---

## [3] RoutePlan — the "legible route object"

"Legible" = a transparency record returned with **every** answer so the routing is auditable, not a
black box: which models actually ran, the lens/effort used, which capabilities fired, **who decided**,
and why. It's also what you diff against hand-written specs during merge staging (§9).

```ts
type Effort = "low" | "medium" | "high";   // canonical; default "high"

type RoutePlan = {
  mode: "single" | "panel";        // = (seat count === 1 ? single : panel); a label, not a gate
  models: string[];                // resolved slugs actually called
  lens: string;
  reasoning_effort: Effort;
  used_x_search: boolean;
  used_grounding: boolean;
  panel_n: number;                 // actual seat count
  source: "classifier" | "override" | "prefilter";  // who decided
  classifier_model: string | null; // null when prefilter/override decided
  classifier_error?: string;       // present iff classifier fell back (fail-loud)
  domains?: string[];              // telemetry only
  rationale: string;
};
```

### Effort canon + per-provider mapping
The cores accept **only `low|medium|high`** (`grokCore.ts:33`, `geminiCore.ts:50`), default `high`.
**Drop `"minimal"`** from the dispatch doc — neither core takes it. (Owner notes Grok has a "zero"
tier and Gemini-3.1-pro floors at low; if you want a 4th cheap tier later, first verify the exact
xAI token for "zero" and extend `grokCore`, then add it here. Not in scope now.)

| canonical | grok-direct (`reasoning.effort`) | gemini-pro direct (`thinkingLevel`) | gemini-pro / auto via OR (`reasoning.effort`) |
|---|---|---|---|
| low | low | low→**medium** (core bumps, `geminiCore.ts:80`) | low |
| medium | medium | medium | medium |
| high *(default)* | high | high | high |

`max_effort` override caps the classifier (it may go lower, never higher).

Note: `x-ai/grok-4.3` via OR accepts `none/low/medium/high`, **default low** — pass the canonical
effort explicitly so the seat doesn't silently run at low. (And verify effort propagates through OR
for grok-4.3 — §0 caveat.)

---

## [4] buildSlots — capability seats first, never silently dropped

Fixes the dispatch-doc bug where `mode:"single"` returned `seats[0]` only, discarding a second
capability seat (violating its own "forced seats can't be dropped" rule). Here seat count is derived
*from* the capabilities + panel_n, so nothing is dropped.

```ts
type Seat = {
  id: string;
  provider: "grok-direct" | "openrouter";
  model_slug: string;                       // "grok" | "google/gemini-3.1-pro" | "openrouter/auto" | ...
  lens: string;
  reasoning_effort: Effort;
  grok_grounding?: "auto" | "required";     // grok-direct ONLY — maps 1:1 to callGrok's Grounding mode
  grounded?: boolean;                       // openrouter + gemini slug ONLY — native web plugin
};

function buildSlots(plan, ov): Seat[] {
  const lens   = ov.lens ?? plan.lens;
  const effort = capEffort(plan.reasoning_effort, ov.max_effort);
  const seats: Seat[] = [];

  // capability seats (classifier-flagged OR forced) — native tools, never via `auto`
  if (plan.needs_x || ov.force_x)
    seats.push({ id:"grok-x", provider:"grok-direct", model_slug:"grok",
                 lens, reasoning_effort:effort, grok_grounding:"required" });   // forced ⇒ fail-loud
  if (plan.needs_grounding || ov.force_grounding)
    seats.push({ id:"gemini-grounded", provider:"openrouter", model_slug:GEMINI_PRO_SLUG,
                 lens, reasoning_effort:effort, grounded:true });               // OR native, NOT direct

  // seat count = max(requested panel size, #capability seats, 1) — capabilities win, never dropped
  const want   = ov.n ?? plan.suggested_panel_n ?? 1;
  const target = Math.max(want, seats.length, 1);

  // fill remaining with reasoning seats; `auto` = outside-check seat
  // GEMINI_PRO_SLUG = geminiCore's DEFAULT_OPENROUTER_GEMINI_MODEL = "~google/gemini-pro-latest"
  // (tilde required). Do NOT use bare "google/gemini-3.1-pro" — it 400s on OR (see corrections note).
  const pool = ["openrouter/auto", GEMINI_PRO_SLUG];  // n=1 default — hand-pick removed (use ask_panel)
  let i = 0;
  while (seats.length < target) {
    const slug = pool[i++ % pool.length];
    seats.push({ id: slug === "openrouter/auto" ? "auto" : `reason-${seats.length}`,
                 provider:"openrouter", model_slug:slug, lens, reasoning_effort:effort });
  }
  return seats;   // mode = seats.length===1 ? "single" : "panel"
}
```

Seam guarantees: `grok_grounding` only on `grok-direct`; `grounded` only on an OR gemini slug; the
`openrouter/auto` seat carries lens but never a native tool.

**`grok_grounding` — why a mode, not a boolean:** `callGrok` takes `grounding: "off"|"auto"|"required"`
(`grokCore.ts:28`). A boolean can't distinguish *"required"* (fail-loud if zero X citations — what a
forced/flagged X seat wants) from *"auto"* (soft). Seats carry the mode so it maps 1:1 with no guessing.

---

## [5] executeSlots — concurrent, partial-tolerant

`Promise.allSettled` + per-slot timeout (one dead slot can't sink the panel). Two dispatch targets only:

```ts
function dispatch(s: Seat) {
  return s.provider === "grok-direct"
    ? callGrok({ prompt, model:s.model_slug, grounding:s.grok_grounding ?? "off",
                 reasoning_effort:s.reasoning_effort, system: applyLens(s.lens) })
    : callOpenRouter(s.model_slug, { prompt, grounded:s.grounded,
                 reasoning_effort:s.reasoning_effort, system: applyLens(s.lens) });
}
// withTimeout(dispatch(s), 25_000, s.id) → {slot, status:"ok"|"error"|"timeout", text?, citations?, error?}
```

---

## [6] assemble + response shape (canonical — resolves the doc conflict)

The handoff said `{answer, route}`; the dispatch default returned `{raw, route, slots_status, degraded}`.
**Canonical: one type, two modes.** Default = **caller synthesizes** (the in-chat caller is Claude,
a better synthesizer than a cheap pass). `synthesize:true` for headless callers (cron/other tools).

```ts
type OracleResponse = {
  route: RoutePlan;                               // always
  slots_status: { id:string; status:string; error?:string }[];  // always
  degraded: boolean;                              // always — any non-ok seat OR classifier fallback
  raw?: { id:string; tags:string[]; text:string; citations?:string[] }[]; // when synthesize=false (DEFAULT)
  answer?: string;                                // when synthesize=true
};
```

`degraded:true` whenever any seat is non-ok **or** the classifier fell back. A **forced** capability
seat that errors is surfaced in `slots_status` with `degraded:true` — **never** swapped for a generic
seat (if you asked for live X and X is down, you should know). A generic reasoning seat that errors
just drops; survivors return.

**Synthesizer (`synthesize:true`) — judge is PINNED, not `auto` (decided 2026-06-24).** The merge
runs on `~google/gemini-pro-latest` (a strong, predictable reasoner), NOT `openrouter/auto`. Synthesis
is a fixed, well-defined task; `auto` optimizes per-prompt and could route a "merge these answers" call
to a weak/unexpected model. The judge reads the already-collected labeled seat outputs and writes one
coherent answer (agreements stated, genuine disagreements surfaced, citations preserved). Default stays
`synthesize:false` — the in-chat caller (Claude) is the better synthesizer.

---

## [6a] Fusion — OPTIONAL separate path (NOT the synthesizer)

OpenRouter **Fusion** (`model:"openrouter/fusion"`) is a panel-of-models + judge primitive: it dispatches
its OWN panel in parallel (each with web search/fetch), a judge produces structured analysis
(consensus / contradictions / gaps / blind spots), then the answer is written from that. OR reports
~75% of its lift comes from the *synthesis*, ~25% from model diversity — direct external validation of
ask_oracle's "synthesis matters more than panel size" bet.

**It is deliberately NOT wired into the `synthesize:true` judge.** By synth time our seats have already
answered; Fusion would re-dispatch a fresh generic panel — **double-spend** (our seats + Fusion's panel)
plus a *re-answer* instead of a merge, and its generic panel lacks our native capability seats (live-X
via grok x_search, forced grounding w/ fail-loud contract, lenses). Fusion is a *panel*, not a pure judge.

**Where Fusion belongs (future, opt-in):** as an alternative **reasoning ENGINE for hard, contested,
no-special-capability routes** — a single `openrouter/fusion` seat *replaces* "N auto seats + our own
synth" (no double-spend, because we don't also run our own reasoning seats for that route). It does NOT
replace the classifier (which still decides *whether* to take the Fusion path) or the capability seats.
Sketch: an override `engine:"fusion"` (or a classifier signal for `difficulty:"hard" && no capabilities`)
that emits one Fusion seat in place of the reasoning-pool fill in `buildSlots`. Cost/latency are higher
(a full internal panel per call) — gate it behind difficulty + explicit opt-in. Post-MVP; not in the
current build.

---

## [7] Overrides + precedence

Mostly automatic (classifier drives); forceful overrides supersede it when the caller has intent.

| field | effect |
|---|---|
| `specs` | full ask_panel specs array → **total deterministic bypass** (ask_panel path) |
| `n` / `panel_size` | force seat count (still floored by capability seats) |
| `lens` | force lens |
| `system` | system instruction applied to **every** seat; composes with lens (lens body first, then system) |
| `reasoning_effort` | force effort — **WINS over `max_effort`** (it's the caller's explicit intent) |
| `max_effort` | cap on the **classifier's** pick only — may go lower, never higher; does **not** cap an explicit `reasoning_effort` |
| `force_x` | force a direct-Grok x_search seat (`grok_grounding:"required"`) |
| `force_grounding` | force a grounded-Gemini seat — Google-native grounding **routed via OpenRouter** (engine:"native", never Exa) |

**No model hand-pick** (2026-06-26 cull): `force_model`/`model_slugs` were removed — naming the exact
model per seat is `ask_panel`'s job, by the keep-separate rule. ask_oracle's reasoning pool is now
purely auto-routed (diversity-first fill, `grokCallerPool` for a grok caller, single-seat wildcard
default). `force_grounding` takes no slug (the grounded seat is fixed to `GEMINI_PRO_SLUG`).

**Precedence:** `specs` > explicit force/cap fields > classifier > prefilter seeds. Within effort:
explicit `reasoning_effort` > `max_effort` cap > classifier's effort (the cap binds only the classifier).
Note: capability seats are orthogonal to the reasoning pool — auto-routing fills reasoning seats but
does **not** remove a forced/flagged grok-x or gemini-grounded seat (capabilities aren't "reasoning
pool" members).

---

## [8] callOpenRouter — generalize, don't rebuild

`callGeminiViaOpenRouter` is already a generic OR chat-completions call; the only gemini-specific bits
are the `google/` namespace default, the `-pro` thinking gate, and the grounding plugin. **Generalize
it to `callOpenRouter(slug, opts)`**: accept any slug incl. `openrouter/auto` and `x-ai/grok-4.3`; apply
the native web plugin only when `grounded && slug` is a gemini model; keep the `-pro`-gated
`reasoning.effort` but allow effort on grok slugs too. Add two passthroughs the new callers need:
- `response_format` — for the classifier's `json_schema` structured output (§2).
- `models?: string[]` — OR's ordered fallback list, set on the request body for resilient seats (§0).

- Keep `callGeminiViaOpenRouter` as a thin wrapper/alias during migration (don't break panel.ts).
- **Keep `callGemini` (direct) — do NOT delete yet.** It's the documented transport fallback (flag
  `GEMINI_TRANSPORT=direct`) if OpenRouter has an outage, and your A/B escape hatch. Mark it
  "deprecated for grounding" (it can't force grounding) but retain for non-grounded fallback.
- Keep `callGrok` (direct) for x_search seats.

Net new code is small: a slug param + conditional grounding plugin on top of an existing function —
**this is the only real plumbing this feature adds.** ("Budget for it" earlier just meant: it's not
free as the dispatch doc implied; with this refactor it's cheap.)

---

## [9] Tool surface, merge staging, URL rotation

ask_oracle is the **5th** tool (ask_panel, get_odds, grok_x_search, get_news_digest, **ask_oracle**).

**Does the 5th tool break the journaling routine?** Only the *URL rotation* does, not the tool itself:
- **Adding ask_oracle on the EXISTING URL:** after server restart, Claude Code callers (journaling
  routine, settings.local.json curls) call tools **by name** on the existing endpoint — a longer tool
  *list* doesn't affect them. **Journaling does NOT break.** Just bump smoke-test `EXPECTED_TOOLS` 4→5.
- **Grok's connector caches the tool list per URL** — Grok won't *see* ask_oracle until given a **new
  URL path**. Rotating the path to surface it to Grok means **every** consumer pinned to the old path
  must be updated by hand (journaling **fails silently** if missed; also settings curls + Grok connector).

**Recommended sequence:**
1. Ship ask_oracle on the **existing** URL; bump `EXPECTED_TOOLS` 4→5; validate via Claude Code (journaling untouched).
2. Diff `route.models`/`route.lens` vs hand-written specs on real prompts until the route stops surprising you.
3. Rotate to a **fresh Grok URL** only when you want Grok to use ask_oracle — running the full
   url-rotation consumer checklist (astra-config README) at that point.
4. Eventually fold ask_panel in: its `specs` path becomes ask_oracle's `specs` override (already
   byte-for-byte identical), ask_panel leaves the manifest.

---

## Resolved (owner-confirmed)

- Effort canon `low|medium|high`, default high — **drop `minimal`**.
- **Drop the trivial skip-classifier gate** — always classify except the `specs` bypass.
- **`domains` kept** — emitted early as a reasoning scaffold + telemetry.
- **Default `synthesize=false`** (caller synthesizes).
- **Ship on existing URL first**, rotate the Grok URL later.
- Classifier transport = **OpenRouter** (gemini-via-OR format, `response_format` json_schema).
- Grok generic reasoning = **via OR + BYOK**; x_search stays direct; `callGemini` direct deprecated-but-kept.

## Resolved facts (verified 2026-06-24)

- No `gemini-flash-lite-latest` exists (OR or AI Studio) → classifier pins `google/gemini-3.1-flash-lite`
  via OR for latency, fallback `gemini-2.5-flash-lite`. (§2)
- **All Grok stays direct** (x_search + reasoning) → the grok-effort-via-OR question is **moot**, dropped. (§0)
- xAI BYOK key already added to OR — kept only so `openrouter/auto` can surface Grok. (§0)
- OR is **not SLA-grade** (~3 acknowledged outages/8mo, 35-50min each, no uptime guarantee) → keeping
  `callGemini` direct + `callGrok` direct as dormant fallbacks is well justified, not just tidy. (§0, §8)

## Build-time corrections (applied during implementation, 2026-06-24)

These SUPERSEDE earlier references throughout the spec — wherever the prose/tables still say
`google/gemini-3.1-pro`, read the corrected slug below.

- **`google/gemini-3.1-pro` is NOT a valid OpenRouter model ID — it 400s** ("not a valid model ID",
  caught live). Everywhere a gemini-pro OR slug is needed (grounded capability seat, default reasoning
  pool, grok-seat `models[]` fallback example in §0, the §3 effort-mapping column), use
  **`GEMINI_PRO_SLUG` = geminiCore's `DEFAULT_OPENROUTER_GEMINI_MODEL` = `~google/gemini-pro-latest`**
  (tilde required; verified live to resolve to `google/gemini-3.1-pro-preview-20260219`). Single source
  of truth = the geminiCore export, so the gemini-model-check monitor covers oracle's seats too.
- **Synthesizer judge pinned to `~google/gemini-pro-latest`, NOT `openrouter/auto`** (§6). Rationale +
  the Fusion decision are in §6 / §6a.
- **Fusion is an optional post-MVP path, not the judge** — see §6a.

## Implementation status (2026-06-24)

Steps 1-5 DONE + live-verified, and **DEPLOYED**: callOpenRouter generalized; oracleClassifier;
oracleEngine route/dispatch/assemble; `ask_oracle` registered in index.ts on the existing URL; smoke-test
`EXPECTED_TOOLS` bumped 4 → 5. Service restarted; local tools/list + public-funnel smoke-test both show
**5 tools live incl. ask_oracle**. `npm test` split: default = unit-only (green); integration arm gated
behind `RUN_INTEGRATION=1` (`npm run test:integration`, needs a live server).

**Open routing/classifier fixes from first behavioral test (2026-06-24) — do BEFORE the Grok rotation;
all three cause FALSE CONSENSUS, the worst failure for panels. Coarse routing (escalate/effort/mode) is
well-calibrated; the FINE policy below is not:**
- **F1 — lens keyed off topic, not task.** A contested "make the call" on LVT got the `georgist` lens
  (topic match) → both reasoning seats argued the same partisan side, no real disagreement. The
  classifier system prompt must pick lens by TASK TYPE: adjudication/contested → `default` or
  `steelman-then-break`, never a pre-committed-ideology frame. (oracleClassifier.ts SYSTEM_PROMPT)
- **F2 — panel model monoculture.** panel_n=3 filled to all-Gemini (pool `[openrouter/auto,
  ~google/gemini-pro-latest]`, and `auto` resolved Gemini too) → no Grok, no independent voice.
  buildSlots should force model-family diversity on panels (guarantee ≥1 grok-direct reasoning seat).
- **F3 — `route.used_grounding` reports planned, not realized.** A grounded seat that TIMED OUT (25s)
  still set `used_grounding:true`. Recompute realized capability flags in `assemble` from slot results
  (or carry planned-vs-realized separately). Also bump SLOT_TIMEOUT_MS / add a retry for CAPABILITY
  seats specifically — 25s is tight for a high-effort grounded seat.

**Remaining (operator-gated, intentionally NOT auto-done):**
1. Spit-test ask_oracle descriptions/invocation with Claude (in-chat) → rework wording if needed
   (rebuild + restart only, no URL rotation). [First pass done — see F1-F3 above.]
2. THEN rotate to a fresh Grok URL to surface ask_oracle to the Grok connector + run the full
   url-rotation consumer checklist (journaling routine, settings curls). Until then Grok/journaling are
   untouched and safe.
3. Push grok-mcp (manual backup — not auto-pushed).
4. (Deferred follow-up) OR-availability monitor for `google/gemini-3.1-flash-lite` — nice-to-have; the
   classifier is already fail-loud at runtime, so this is proactive-only, a SEPARATE monitor from the
   AI-Studio cost-jump `gemini-model-check`.

## Verify during build (don't block design)

1. Confirm OR BYOK billing routes to xAI, not OR credits (only matters for the `auto` seat picking Grok). (§0)
2. Bump smoke-test `EXPECTED_TOOLS` 4 → 5; add the classifier slug to availability monitoring. (§2, §9)
3. Classifier-tuning (post-MVP): it over-flags `needs_grounding` on evergreen/opinion prompts (e.g.
   "is nuclear power good?") — the grounded seat then fails loud (model declines to search). Tighten the
   needs_grounding rule toward genuinely time-sensitive/factual queries. (§2)

---

## Implementation status — fixes A & B (2026-06-26; deployed, PUSHED + URL-ROTATED 2026-06-26)

**Fix A — grok-direct reasoning seat timeouts (§5).** High-effort grok-4.3 reasoning
now routinely exceeds the 40s `SLOT_TIMEOUT_MS`, and the timeout-retry re-ran the
identical slow call → ~80s burned before salvage (live journald 2026-06-26). Fix:
new `GROK_REASONING_TIMEOUT_MS=60_000` for grok-direct *reasoning* seats
(`s.provider==="grok-direct" && !isCapabilitySeat`), and `maxAttempts=0` for them
(slowness is DETERMINISTIC — retry is guaranteed to fail and only doubles latency;
fail fast to salvage). OR reasoning seats (auto/gemini) keep 40s + 1 retry (their
timeouts more plausibly transient). Capability seats unchanged. tsc clean, 51 unit
green. LIVE-verified on panel_size:3/high-effort call: invariants held (slots
complete, route flags honest, degraded:true w/ concrete reason, real answer).
Couldn't force grok slow on demand, so the 60s/no-retry branch is verified by
typecheck+unit, not a live grok timeout.

**Fix B — caller-aware heterogeneity `exclude_family` (§4).** No caller identity
reaches the engine (MCP callback gets parsed args only), so EVERY panel seated a
grok-direct contrarian voice — including when Grok called (2nd Grok voice consulting
itself, and the slow seat from A). Fix: caller-declared `exclude_family?: string`
on OracleOverrides + zod schema. When `==="grok"`, new `grokCallerPool(existing)`
replaces `panelFillPool` for that call (any size): order **gemini → gpt-5.5 → auto**
(cycled, NO grok), already-seated families deduped from head. New `GPT_SLUG="openai/gpt-5.5"`
(pinned, OR-catalog-verified 2026-06-26). Capability seats EXEMPT (grok-x = data
retrieval, not opinion; gemini-grounded stays). Seat map (no caps): 1→gemini · 2→gemini,gpt · 3→gemini,gpt,auto.
+5 unit tests (grok-caller pool + capability exemption). LIVE-verified
(exclude_family:grok, panel_size:3): route.models=[gemini-pro-latest, openai/gpt-5.5,
openrouter/auto], no grok-direct reasoning seat; needs_grounding dedup correctly
skipped redundant gemini reasoning → gpt,auto fill. **Dormant until Grok connector
per-URL cache refreshes** (adding an optional param doesn't force rotation; old cache
works, just doesn't send the field). **RESOLVED 2026-06-26: URL was rotated (env
rewritten + service restart 07:41:46 UTC), so B is active for Grok callers on
connector reconnect** — see [[astra-url-rotation-consumers]] for the consumer checklist.

**Open follow-ups — all closed (2026-06-26):** (1) gemini-grounded capability seat
deterministic slowness — MOOT: capability seats already run 0 timeout-retries inside
the 60s budget (`isCapabilitySeat → maxAttempts 0`), so they never had the
retry-doubling problem; a lone 60s timeout is absorbed by salvage. (2) `openrouter/auto`
reasoning-seat retry-on-deterministic-timeout — DECLINED on evidence (owner test ~5%
error; journald ~1 timeout/19 runs and it was a transient OR hang, not deterministic
slowness → 1 retry is the correct tool; lost auto seat is non-fatal). (3) Non-Grok
panel_size:4 duplicating gemini — FIXED by the gpt-5.5 promotion (commit 0248e92):
gpt-5.5 is now the #3 voice in BOTH pools, so a 4-seat panel is gemini→grok→gpt→auto.
Forward work tracked in `ask_oracle_proposals.md` (cull hand-pick overrides, sharpen
descriptions, consumer-reconnect, gpt-5.5 latency watch).
