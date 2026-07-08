# research_fanout — buildable spec (grok-mcp #4)

> **Status:** design-locked 2026-07-08. Implementation not started.  
> **Companion:** `/root/composer_handoff.md`, memory `fan-out-research-tool-{plan,design,gate}`.  
> **Whitelist:** keep alongside `ask_oracle_{spec,stress_tests,proposals}.md` until shipped + memory-synced.

Single new MCP tool: **decompose a research question into parallel grounded legs, execute them under a hard outer budget, synthesize with preserved citations.** Ships **beside** `ask_oracle` / `ask_panel` / `grok_x_search` (keep-separate). Adds a tool surface → **MCP_PATH rotation to 11 tools** (last step, after smoke).

---

## 0. Why this exists

| Tool | Job |
|------|-----|
| `ask_oracle` | Auto-route one prompt to a multi-model *opinion/reason* panel |
| `ask_panel` | Hand-pick heterogeneous seats |
| `grok_x_search` | Citations-first live X search (fail-loud empty) |
| **`research_fanout`** | **Multi-sub-question research**: split → fetch evidence in parallel → one cited answer |

Oracle/panel answer *one* question with multiple models. Fanout answers *many sub-questions* with grounded retrieval, then merges evidence.

---

## 1. Locked envelope (from plan)

1. **Flow:** `decompose → route → execute → synthesize`
2. **Hard outer budget:** **85s** wall-clock for the whole tool call
3. **Partial return:** if some legs fail/time out, still return what finished + honest `degraded` / per-leg status
4. **Fusion citation-drop gate:** cleared (commit `19d4204`). Synth must **aggregate** citations, not drop them
5. **No nested tools:** legs call **provider cores** only (`callGemini` / `callGrok` / shared OR helpers) — never `ask_oracle` / `ask_panel` / `research_fanout` (would blow 85s and double-wrap timeouts)

---

## 2. Locked design decisions (2026-07-08)

### 2.1 Leg dispatch

- Each leg is a **direct grounded provider call**.
- **Default transport:** gemini-grounded via existing OR/direct path (`callOpenRouter` / `callGemini` with grounding), same fail-loud zero-citation contract as panel (retries as appropriate under the *leg* budget, not unbounded).
- **X/social/realtime legs:** `callGrok` with `grounding: "required"` or the x_search tool path inside `callGrok` (core, not MCP tool).
- **Forbidden:** nesting `ask_oracle`, `ask_panel`, `get_news_digest`, or another fanout.

### 2.2 Leg I/O schema

Every leg must produce structured output (not raw free text alone):

```ts
type LegResult = {
  id: string;                 // e.g. "leg-0"
  query: string;              // sub-question actually sent
  mode: "gemini_grounded" | "grok_x" | "grok_grounded";
  status: "ok" | "timeout" | "error" | "skipped";
  answer?: string;
  citations: string[];        // always present (empty array if none / fail)
  latency_ms: number;
  error?: string;
  transport?: "or" | "direct";
};
```

### 2.3 Citation contract (synth)

- Synth input = labeled legs with **answers + citations[]**.
- Synth **must** emit a final `citations: string[]` that is the **union** of successful legs' citations (dedupe by URL string), optionally reordered for relevance — **never dropped** because a judge summarized.
- If `synthesize:false`, return `legs[]` raw for the caller to merge (still include per-leg citations).
- Contested multi-leg synthesis may use `engine:"fusion"`-style path later; **v1 default** = gemini-pro-latest judge (same as oracle synthesize), with citation-preservation system prompt. Fusion is optional v1.1 for genuinely contested branches only.

### 2.4 Abort / budget graph

```
T=0 ── outer AbortSignal (85s hard)
        ├── decompose phase (cap ~15s) — if fails → single-leg fallback (whole prompt)
        ├── legs phase (cap ~50s remaining budget, concurrent, mapLimit ≤ 5)
        │     each leg: withTimeout(legBudget) + AbortSignal linked to outer
        └── synth phase (cap ~20s remaining) — if synth fails after ≥1 ok leg:
              return partial (best leg or labeled raw) + degraded:true
```

- **Active abort:** outer expiry **aborts** in-flight fetches (AbortSignal), not merely stop-awaiting. Abandonment leaves orphan work and is forbidden.
- Reuse `withTimeout` / existing abort patterns from oracle/panel; fix any direct-gemini path that still lacks abort (known D3) if that path is used for legs.

### 2.5 Width + budget split

| Phase | Soft budget | Notes |
|-------|-------------|--------|
| Decompose | ≤ 15s | flash-lite class (classifier model family) via OR |
| Legs | ≤ 50s | concurrent; leg timeout = min(remaining, ~45s) |
| Synth | ≤ 20s | gemini-pro judge; skip if `synthesize:false` |
| **Outer** | **85s** | hard wall; partial return on expiry |

- **Max legs:** **5** (hard cap). Decomposer may propose fewer.
- Decompose failure / empty plan → **one leg** = original prompt, mode default `gemini_grounded`.
- Decomposer must not invent > max_legs; clamp.

### 2.6 Per-leg grounding policy

Decomposer returns tags per sub-query:

```ts
type LegPlan = {
  query: string;
  mode: "gemini_grounded" | "grok_x" | "grok_grounded"; // default gemini_grounded
  rationale?: string; // telemetry only
};
```

- **gemini_grounded** — general web/current facts  
- **grok_x** — live X / social / "what is being said on X"  
- **grok_grounded** — Grok + web/x when decomposer wants non-Gemini retrieval  

Invalid mode → coerce to `gemini_grounded`.

### 2.7 Metrics

- Each leg records a `SeatMetricRecord` with `tool: "research_fanout"` (extend `MetricsTool` union).
- **Per-seat `degraded: status !== "ok"`** (B1 semantics — never stamp run-level degraded on ok legs).
- Lens/config failures must record (same B2 lesson as panel).
- Timeouts classified via tightened `isAttemptTimeoutError` (B3).

### 2.8 keep-separate (tool description must say this)

> **research_fanout** decomposes a *research* question into parallel grounded sub-queries and returns a cited synthesis. It does **not** multi-model opinion-panel (use `ask_oracle` / `ask_panel`). It does **not** replace a single live-X lookup (`grok_x_search`). Prefer fanout when the user needs multi-angle evidence gathering under one call.

---

## 3. API

### 3.1 Tool name

`research_fanout`

### 3.2 Input (zod)

| Field | Type | Default | Notes |
|-------|------|---------|--------|
| `prompt` | string (non-empty) | required | Research question |
| `synthesize` | boolean | `true` | false → return legs only |
| `max_legs` | number 1–5 | `4` | Hard ceiling still 5 |
| `lens` | string? | optional | Applied to synth (and optionally decompose system); legs stay evidence-focused |
| `system` | string? | optional | Extra caller system for synth |
| `reasoning_effort` | low\|medium\|high | `high` | Leg + synth effort where supported |
| `force_x_leg` | boolean | `false` | Ensure ≥1 `grok_x` leg when true (adds/replaces if decomposer omitted) |

No `force_model` / `model_slugs` (culled pattern — keep-separate).

### 3.3 Output

```ts
type ResearchFanoutResponse = {
  route: {
    tool: "research_fanout";
    decompose_source: "classifier" | "fallback_single";
    max_legs: number;
    planned: LegPlan[];
    budget_ms: 85_000;
    elapsed_ms: number;
    phases: { decompose_ms: number; legs_ms: number; synth_ms?: number };
  };
  legs: LegResult[];
  degraded: boolean;          // true if any leg non-ok OR synth failed OR outer partial
  answer?: string;            // when synthesize true and synth produced text
  citations: string[];        // aggregated (always array)
  slots_status?: string;      // short human summary e.g. "3/4 legs ok"
};
```

MCP wrapper: JSON text content (same as oracle/panel).

---

## 4. Implementation sketch

### 4.1 Files

| File | Role |
|------|------|
| `src/researchFanout.ts` | register tool, decompose, executeLegs, assemble |
| `src/index.ts` | register + wire keys |
| `src/metrics.ts` | `MetricsTool` += `"research_fanout"` |
| `test/researchFanout.test.mjs` | unit tests with DI / mocks |
| `astra-config` smoke | `EXPECTED_TOOLS=11` after rotate |

Reuse: `callGrok`, `callOpenRouter`/`callGemini`, `withTimeout` (extract shared if only in oracle today), `hashQuestion` / `recordSeatMetric`, classifier flash-lite pattern from `oracleClassifier.ts` (new small decomposer schema — do not overload oracle classify).

### 4.2 Decomposer

- Model: same flash-lite pin as oracle classifier (`google/gemini-3.1-flash-lite` + fallback).
- Structured JSON: `{ legs: LegPlan[] }` with 1..max_legs.
- System prompt: split into **independent evidence-seeking** sub-questions; avoid opinion/meta legs; tag mode; no more than max_legs.
- On parse/transport failure → `fallback_single`.

### 4.3 Execute

- `mapLimit(legs, 5, ...)`.
- Per leg timeout from remaining outer budget.
- Gemini grounded: reuse panel fail-loud miss retries **but** cap attempts so total stays under leg budget (prefer 1 retry under tight remaining time).
- Record metrics per leg on settle.

### 4.4 Synth

- If zero ok legs → degraded, no answer (or optional ungrounded salvage — **v1: no salvage**, honest empty).
- If `synthesize:false` → return legs + aggregated citations from ok legs.
- If `synthesize:true` → gemini-pro judge with citation-preservation prompt; on synth timeout return labeled partial + `degraded:true`.

---

## 5. Prerequisites (gates)

| Gate | Status |
|------|--------|
| Fusion citation fix (19d4204) | ✅ done |
| **B1** per-seat `degraded` | ✅ done 2026-07-08 |
| **B2** lens failures recorded | ✅ done 2026-07-08 |
| **B3** timeout classification tight | ✅ done 2026-07-08 |
| Optional **A1** panel outer-budget/partial | recommended pattern donor; not a hard block if fanout implements its own outer budget correctly |

---

## 6. Acceptance criteria

1. Unit: decompose clamp, fallback_single, citation union, partial return on timed-out leg, metrics per-leg degraded.
2. Build green; existing suites green.
3. Live smoke: tool listed; simple 2-leg prompt returns answer + non-empty citations when sources exist.
4. Live: outer budget — a stuck leg aborts; siblings still returned (`degraded:true`).
5. Tool count: smoke `EXPECTED_TOOLS=11` after deploy.
6. **MCP_PATH rotated** + consumers reconnected (journaling, claude.ai, Grok) — rotation **last**.
7. Description divergence: callers do not confuse with ask_oracle (spot-check one Grok + one Claude call).
8. Manual `git push` of ad-astra after functional confirm (no auto-push).

---

## 7. Non-goals (v1)

- Eval/regression harness (skipped project-wide).
- Classifier auto-route from ask_oracle into fanout.
- Nested fanout / recursive research.
- Full Fusion as default synthesizer (`fusion_show_analysis` still deferred).
- Changing ask_oracle / ask_panel semantics beyond shared metric helpers.

---

## 8. Deploy sequence

1. Implement + unit tests  
2. `npm run build` → `cp src/kalshi-series.json build/` → `npm test`  
3. `systemctl restart grok-mcp.service`  
4. Live probes (no rotation yet — new tool invisible to Grok cache until rotate, but path may already list tools depending on consumer)  
5. Bump smoke `EXPECTED_TOOLS` to 11  
6. **Rotate `MCP_PATH`**, restart, reconnect **all** consumers  
7. Owner `git push`  

---

## 9. Open follow-ups (post-v1)

- A1 panel outer budget sharing the same helper  
- Contested-branch Fusion synth  
- `force_x_leg` heuristics inside decomposer without caller flag  
- Metrics dashboard / get_metrics filter for `research_fanout` (schema already extended)
