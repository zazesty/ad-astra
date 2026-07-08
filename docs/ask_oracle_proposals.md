# ask_oracle / grok-mcp — proposed future changes

> **PERMANENT DESIGN DOC — DO NOT sweep in a workspace cleanup.** This is a living
> companion to `ask_oracle_spec.md`, not a superseded handoff/staging file. The
> `keep-workspace-clean` rule explicitly whitelists `ask_oracle_{spec,stress_tests,
> proposals}.md`. Move accepted items into the spec; retire this doc only when empty.

Scratch doc for ideas not yet built. Lives in `/root` next to `ask_oracle_spec.md`
and `ask_oracle_stress_tests.md`. **Not auto-backed-up** (only `astra-config`
auto-pushes; grok-mcp is manual — see [[grok-mcp-push-reminder-pref]]).

Status legend: 🟢 do it · 🟡 open/decide · 🔴 declined · ⏸ deferred/conditional · ✅ done.

---

## Current state — read this first

**UPDATE 2026-06-29:** timeout/hang fix **DONE** (OR_ATTEMPT_TIMEOUT_MS=15s, timeout→failover,
OR grounding-miss→direct). Memory Step 0 + harvester also shipped. Separation work,
memory tools, URL rotation all done. Item #4 (gpt-5.5 latency) closed — root cause was OR
hangs, not gpt slowness. No open build items remain here.

### Snapshot as of 2026-06-26 (still accurate below this point)

Everything below the line is **shipped, pushed, and live**. Confirmed this session:

**2026-06-26 (late) — separation landed (items 1 + 2 + 5):** `force_model` and `model_slugs`
culled from ask_oracle (interface, `buildSlots`, zod schema, args type, `runOracle` call);
both tool descriptions sharpened to explicitly contrast (oracle = auto-routes, panel =
hand-pick); stale `n=1` comment fixed. Spec updated (6 locations). Unit suite green
(55 = 58 − 3 culled assertions). Built + deployed + restarted 21:43 UTC — **engine-internal,
no URL rotation** (removing optional params doesn't break stale callers: zod strips the
unknown key silently). The description reword is **dormant for the Grok connector** until
the next per-URL cache refresh ([[grok-connector-tool-cache-per-url]]); batch with a future
rotation if you want Grok to see it sooner. **NOT pushed** — ad-astra stays manual
([[grok-mcp-push-reminder-pref]]); `git push` when ready.
- `git ls-remote origin` HEAD == local HEAD == `0248e92`. A, B, and the gpt-5.5
  promotion are **all on GitHub** (the old "NOT pushed" notes were stale).
- `/etc/grok-mcp.env` rewritten + service restarted **07:41:46 UTC 2026-06-26** →
  **MCP_PATH was rotated today.** The new path busts Grok's per-URL tool cache, so
  fix B's `exclude_family` param is now visible to Grok *on reconnect*.
- Full unit suite green (58 oracle checks + the rest), `tsc` clean, deployed build
  matches HEAD.

**The only thing the rotation does NOT do itself: reconnect the consumers.** That's a
USER action and the journaling routine **fails silently** if missed — see open item 3.

---

## ✅ DONE 2026-06-29 — ask_oracle timeout/hang fix (was ACTIVE HANDOFF 2026-06-28)

**Owner is routing this to Grok Build to conserve Claude usage. Self-contained brief.**
Evidence + diagnosis also in TO-DO item 4 below; this is the buildable spec.

**SYMPTOM.** ask_oracle times out for connector callers (live testing: q4 twice, q8 once;
plus one degraded run). journald shows `[ask_oracle] seat reason-2 timed out (40000ms) —
timeout retry 1/1` REPEATEDLY while the underlying OR calls return in <4s (gpt-5.5
0.2–1.6s, gemini 2–4s). So seats aren't slow — one is HANGING.

**ROOT CAUSE (confirmed in code).**
- `geminiCore.ts callOpenRouter`: per-attempt `signal: AbortSignal.timeout(120_000)` (L276).
  A hung OR fetch doesn't abort for 120s. On abort it's caught (L278) as network-transient
  and **retried internally** up to `OR_MAX_ATTEMPTS` (L285–288).
- `oracleEngine.ts`: seat-level `withTimeout(dispatchSeat(...), SLOT_TIMEOUT_MS=40_000)`
  (L306, L514). The seat gives up at **40s — long before** callOpenRouter's 120s abort.
- So a hang is caught by the SEAT timeout → `MAX_TIMEOUT_RETRIES=1` re-runs the seat **on
  OR again** (L519–524, ~80s total) instead of callOpenRouter throwing a transient error
  that would trigger the **OR→direct failover** (`orReasoningWithFailover` catch fires only
  on a THROWN `isTransientError`, L434; `groundedWithFailover` L410 same).
- ~80s > the MCP connector's client timeout → user-visible "ask_oracle timed out."

**FIX — budget hierarchy: per-attempt OR abort < seat timeout, and a timeout FAILS OVER
TO DIRECT (not retry OR).**
1. `callOpenRouter`: replace `AbortSignal.timeout(120_000)` with a named const
   `OR_ATTEMPT_TIMEOUT_MS ≈ 15_000` (p90 ~3s, slowest legit ~10.5s → 15s safe). Allow a
   per-call override param so newsDigest can pass more if its compression prompts
   legitimately run longer.
2. On a TIMEOUT/abort specifically, **throw the transient `OpenRouterError` immediately —
   do NOT loop** `OR_MAX_ATTEMPTS` (3×15=45s would still blow the 40s seat AND never reach
   failover). Keep internal retry ONLY for 429/5xx (they fail fast). Distinguish via
   `AbortError`/`TimeoutError` name vs HTTP status in the catch.
   → Hang path becomes: 15s abort → throw transient → `orReasoningWithFailover` →
   direct-gemini (~3–12s) → seat done in ~18–27s, well under 40s. ✓
3. `oracleEngine.ts`: keep `MAX_TIMEOUT_RETRIES=1` as a genuine last-resort on the DIRECT
   path, but the OR hang no longer reaches it. Optionally lower `SLOT_TIMEOUT_MS` now that
   hangs fail over fast (owner's call — leave 40s unless you have reason).

**SECONDARY (the degraded run's other half — gemini grounding miss).** `groundedWithFailover`
(L395) fails over to direct only on TRANSIENT (L410); a 0-citation MISS is non-transient
(fail-loud by design) so after `MAX_GROUNDING_RETRIES` (1 for oracle) the seat fails. But
direct-gemini grounding has **0% miss vs OR-native ~8%** (the A/B test). ADD: on an OR
grounding miss (0 citations after the OR retry), try **direct-gemini grounding once** before
failing loud; preserve the contract — if DIRECT is also 0 citations, THEN fail loud
(`grounding_fired:false`). Converts the common ~8% OR miss into a recovered answer.

**BLAST RADIUS.** `callOpenRouter` is shared by `panel.ts` + `newsDigest.ts`. Shorter abort
+ timeout-throws-fast affects them too — verify their unit tests; give newsDigest a longer
override if its prompts need it.

**TESTS (add + keep green).**
- geminiCore.test: a timeout/abort throws `OpenRouterError{transient:true}` with NO internal
  retry; a 429 still retries.
- oracleEngine chaos test: mock fetch to HANG for openrouter.ai → the reasoning seat fails
  over to direct and resolves in `< SLOT_TIMEOUT_MS`; route honest; degraded reflects reality.
- grounding-miss test: OR grounded → 0 citations → direct grounding attempted → recovered if
  direct returns citations, fail-loud if direct is also 0.
- Existing engine/classifier/geminiCore/panel suites pass.

**DEPLOY.** `npm run build` → `cp src/kalshi-series.json build/` (allowJs gotcha) →
`sudo systemctl restart grok-mcp.service` → `sudo bash /root/astra-config/scripts/smoke-test.sh`
(9 tools) → live ask_oracle call + journald: NO "seat … timed out … timeout retry" while
underlying calls are fast; a forced OR outage shows failover lines. **Engine-internal → NO
URL rotation.** MANUAL push after verified ([[grok-mcp-push-reminder-pref]]); never write
the MCP_PATH/funnel URL anywhere ([[astra-mcp-path-is-a-secret]]).

**ACCEPTANCE.** Fire 5–10 oracle calls back-to-back (panel_size 2–3, synthesize on/off): no
client-side timeouts; degraded only on a genuine multi-seat failure.

**DECISIONS for Grok/owner:** exact `OR_ATTEMPT_TIMEOUT_MS` (15 vs 20s); keep 1 internal
retry for 429/5xx (recommended) vs 0; whether to lower `SLOT_TIMEOUT_MS`.

**SEPARATE, mostly DROPPED (2026-06-28):** the q2/q5 re-run showed Grok picks ask_panel
correctly in both natural + forced conditions, so the ask_panel/oracle-vs-panel description
tweaks are NOT needed (the earlier miss was variance). Only an UNTESTED, optional "if you
are Grok, set `exclude_family:'grok'`" line remains — batch with the next URL rotation
[[grok-connector-tool-cache-per-url]] if you want it; not blocking.

---

## Design axis (SETTLED, owner call 2026-06-26): KEEP SEPARATE + CULL OVERLAP

Confirmed direction: **a larger number of sharper, single-purpose tools** beats one
fat front door with mode flags. ask_oracle (auto-decide), ask_panel (hand-pick),
grok_x_search (X-search-with-contract) stay three distinct tools, patched
independently.

**Why this is the right call (not just fewer LoC):**
- They are three distinct INTERACTION MODES with distinct output contracts. Tool
  *count* is not a usability cost for the LLM caller; tool *overlap/ambiguity* is.
  Sharp single-purpose tools are easier to pick correctly than one mega-tool whose
  flags interact (`force_x` + `model_slugs` + `synthesize`?).
- Per-member heterogeneity already lives in ask_panel, so folding it into oracle (old
  item C) buys nothing — you'd just patch ask_panel directly.
- grok_x_search has a distinct citations-first / no-results-is-error contract → no
  real overlap to fold anyway.

**The standing rule this axis creates — two parts, both still OPEN work:**
1. **Descriptions must be sharply divergent** so the caller never guesses (oracle =
   "auto-routes the panel for you"; panel = "you hand-pick the exact specs"). → item 2.
2. **Cull the feature overlap, don't relabel it.** ask_oracle should be *purely auto*
   and SHED the manual hand-pick knobs that duplicate ask_panel's whole reason for
   existing. → item 1. Re-cull whenever a feature lands in both; overlapping
   capability is the thing to prune periodically, not let accrete.

---

## TO-DO (forward work, ordered)

### 1. ✅ DONE 2026-06-26 — Cull ask_oracle's hand-pick overrides (the overlap with ask_panel)

**Cull these two — pure model hand-pick = exactly ask_panel's job:**
- `force_model` (ADD a named seat, "use Grok specifically")
- `model_slugs` (RESTRICT the reasoning pool to an exact list)

A caller who wants to name the exact models should reach for **ask_panel**. Leaving
these on ask_oracle is the half-overlap middle the keep-separate rule exists to kill.

**Keep these — they serve AUTO-routing, they are NOT model hand-pick:**
- `max_effort` (caps the classifier's effort), `reasoning_effort`, `lens`, `system`,
  `synthesize` — universal/output knobs.
- `force_x` / `force_grounding` — these force a *capability* (live-X / grounding),
  i.e. they CORRECT the classifier ("I know this needs grounding"), keeping the
  classify→synthesize→resiliency envelope. That's auto-routing assistance, not picking
  a model. Distinct from ask_panel's per-spec grounding mode.
- `exclude_family` — caller identity (fix B); diversity-relative-to-caller is an
  auto-routing concern.
- `panel_size` (`n`) — tunes *how many* auto-selected voices, not *which*. Genuinely
  distinct from ask_panel (where count = number of specs you write). **Owner flagged
  this as "arguably" cullable — recommend KEEP, but it's a one-line decision.**

**Implementation notes for whoever picks this up:**
- `oracleEngine.ts buildSlots`: drop the `force_model` seat (~L243–245) and the
  `ov.model_slugs ??` branch of the pool selector (~L256). `reasoningSeat`/`isGrokSlug`
  STAY — the pools still contain the literal `"grok"` slug + `GPT_SLUG`.
- Drop the two params from the zod schema at tool registration + the tool description;
  add a one-liner pointing hand-pick callers to ask_panel.
- Simplifies fix B: the "explicit force_model/model_slugs OVERRIDE exclude_family"
  carve-out disappears with the params.
- Remove/adjust the two unit tests ("model_slugs pins the reasoning pool",
  "force_model grok → grok-direct reasoning seat").
- Engine-internal → live on rebuild+restart, **no URL rotation needed** (removing
  params doesn't change the tool's required surface for existing callers).

### 2. ✅ DONE 2026-06-26 — Sharpen the two tool descriptions (the other half of the rule)

After item 1, make ask_oracle's and ask_panel's descriptions explicitly contrast:
oracle = "describe the question, it auto-routes models/panel-size/grounding/lens for
you"; panel = "you specify the exact members (model + prompt + grounding + lens +
temperature each)." Today they half-overlap. Cheap, do it in the same pass as item 1.

**TEST DESCRIPTIONS ACROSS CALLERS, not just Claude.** The descriptions are read by
*whichever model is calling*, and the keep-separate bet ("sharp tools are easy to pick
correctly") only holds if they're legible to **Grok and Gemini** too. Likely gap: the
live descriptions appear to have been spot-tested with Claude-as-caller ONLY — and
ask_oracle's `exclude_family` exists specifically for the Grok-as-caller case, so a
Claude-only check never exercised it. Owner action when this lands:
- Have **Grok** and **Gemini** each pick the right tool (oracle vs panel vs
  grok_x_search) from a handful of ambiguous prompts, and try invoking with realistic
  args — confirm they don't mis-route, mis-fill params, or trip on the auto-vs-handpick
  boundary. Re-run on **every** tool surface, not just these two (the same
  Claude-only-testing risk applies to get_odds / get_news_digest / grok_x_search
  descriptions too — more work possible there).
- This is rebuild+restart territory only IF a description change touches the tool
  schema seen by a cached connector — a pure description reword that adds/removes no
  params still needs the per-URL cache to refresh for Grok ([[grok-connector-tool-cache-per-url]]),
  so batch any description churn with a rotation or accept it's dormant for Grok until
  the next one.

### 3. ✅ DONE 2026-06-28 — post-rotation consumer reconnect (operational, not code)

Done. The URL was rotated (most recently for the 9-tool memory_* surface) and **all
consumers reconnected** per the user — journaling routine, Grok connector, claude.ai
astra connector, and the `settings.local.json` curl(s). Fix B's `exclude_family` is
fully active for Grok callers, and Grok now sees the memory_* tools. Checklist lives in
`astra-config/README.md` + [[astra-url-rotation-consumers]] for the next rotation.

### 4. 🟡 Watch: gpt-5.5 reasoning-seat latency vs the fix-A pattern

gpt-5.5 is now the #3 reasoning voice (default + grok-caller pools). It runs as an
**OpenRouter reasoning seat → 40s `SLOT_TIMEOUT_MS` + 1 timeout-retry.** Fix A existed
because high-effort grok-4.3 reasoning is *deterministically* >40s, so its retry just
re-ran the slow call (~80s burned). **Nobody has measured gpt-5.5 high-effort
latency.** If journald shows gpt seats timing out + retrying-into-a-second-timeout,
the fix-A carve-out generalizes cleanly: change the `grokReasoning` branch in
`executeSlots` to "any deterministically-slow reasoning family" (60s + 0 retry).
**EVIDENCE LANDED 2026-06-28 — and it's NOT gpt latency, it's OR HANGS (now the headline reliability bug).** Live cross-caller testing produced repeated `seat reason-2 timed out (40000ms) — timeout retry 1/1` while the underlying OR calls returned in <4s (gpt-5.5: 0.2–1.6s; gemini: 2–4s). Root cause: `callOpenRouter`'s per-attempt `AbortSignal.timeout(120_000)` (geminiCore.ts ~L276) is **3× longer than the 40s seat `SLOT_TIMEOUT_MS`**, so a *hung* OR fetch is caught by the seat `withTimeout` (→ OR timeout-RETRY on the same path, ~80s burned) instead of throwing a transient error that would trip the OR→direct failover (`orReasoningWithFailover` catch only fires on a THROWN `isTransientError`, L434). The ~80s blows the MCP connector's client timeout → user-visible "ask_oracle timed out" (hit q4 twice, q8 once; also contributed to a degraded run alongside a gemini-grounding miss). **This REVERSES the earlier "drop OR retry" decline** — that decline assumed hangs were rare (1/19 over 14d); back-to-back interactive load shows otherwise. **FIX:** lower `callOpenRouter`'s per-attempt abort to ~15–20s AND make an OR *timeout* fail over to direct (not retry OR), so a hang routes through `groundedWithFailover`/`orReasoningWithFailover` → direct provider well before the 40s seat cap. Secondary: on an OR grounding MISS (0 citations after the 1 retry), consider failing over to direct-gemini grounding (0% miss per the A/B test) before failing the seat loud.

### 5. ✅ DONE 2026-06-26 — corrected the stale code comment (folded into item 1)

`GPT_SLUG` comment + the `panelFillPool` comment + the gpt-5.5 commit message all say
"a panel of **1**/2/3/4 seats seats gemini → grok → gpt → auto." That's wrong at n=1:
a single-seat (non-Grok-caller) request uses `DEFAULT_REASONING_POOL = [auto, gemini]`
and leads with **`openrouter/auto`**, not gemini (`panelFillPool` only runs at
target≥2). Behavior is correct; the comment overstates. Fix the wording when item 1
rewrites those lines anyway — not worth a standalone commit.

---

## Done / closed (kept for the audit trail)

- **A — Grok-reasoning timeout fix.** ✅ DONE + pushed + live 2026-06-26 (commit
  `35423aa`). grok-direct reasoning seats get 60s + 0 timeout-retries (deterministic
  slowness → fail fast to salvage). Spec §5.
- **B — Caller-aware heterogeneity (`exclude_family`).** ✅ DONE + pushed + live
  2026-06-26. grok-caller pool = gemini → gpt-5.5 → auto (no grok). URL rotated same
  day → active for Grok callers on reconnect (item 3). Spec §4.
- **gpt-5.5 promoted to default pool #3.** ✅ DONE + pushed + live 2026-06-26 (commit
  `0248e92`). Claude-caller panel of 2/3/4 seats = gemini → grok → gpt → auto(overflow);
  resolves the old "panel_size:4 duplicates gemini" follow-up. Spec §4.
- **C — specs passthrough / fold ask_panel.** 🔴 DEPRECATED — closed by the
  keep-separate axis. Patch ask_panel directly; per-spec grounding/temperature/lens
  already live there. (Parity analysis preserved in git history if the axis ever flips.)
- **D — merge grok_x_search.** 🔴 DEPRECATED — already expressible via `force_x`;
  merging deletes a tool, adds no power, and dilutes the citations-first contract.
- **Follow-up: gemini-grounded deterministic slowness.** ✅ MOOT — gemini-grounded is
  a *capability* seat, which already gets 60s + 0 timeout-retry (it never had the
  retry-doubling problem). Confirmed in `executeSlots` (`isCapabilitySeat → maxAttempts
  0`). A lone 60s timeout is absorbed by salvage; not worth raising the ceiling absent
  evidence.
- **Follow-up: drop `openrouter/auto`'s timeout-retry.** 🔴 DECLINED on evidence
  2026-06-26 (owner re-confirmed: ad-hoc test ~5% error, journald ~1 timeout in 19
  runs over 14d). The one observed auto timeout was a *transient OR-side hang*
  (`callOpenRouter` never returned), NOT deterministic slowness — so the 1 retry is the
  *correct* tool, and a lost auto seat is non-fatal (absorbed by the panel, no salvage
  observed). Leave auto at 1 retry. Do not re-litigate without fresh systematic
  retry-waste evidence.
- **Streaming (`stream=true`).** 🔴 DECLINED for latency. MCP returns one terminal
  blob; seats run concurrently; raw/synth need complete text. Cuts time-to-first-token,
  not time-to-last (the latency that matters). Revisit only for a progressive-rendering
  client.
- **Structured output (`response_format`).** 🟢 DONE where it helps — live in the
  classifier (fixed-shape route object + direct-failover twin). Reasoning/synth seats
  emit prose, no schema to force.
- **OpenRouter Fusion (`openrouter/fusion`).** ⏸ DEFERRED (spec §6a). A panel+judge
  primitive that runs its OWN panel → not a drop-in synthesizer (double-spends over
  seats already run). Intended future home: an opt-in `engine:"fusion"` reasoning
  engine for hard/contested routes. Higher cost+latency; deliberate opt-in only.

---

## Reference — ask_oracle vs ask_panel equivalence (no longer a build gate)

Under keep-separate, ask_panel is NOT being retired, so these are just the known
boundaries (Grok's R-series probes, 2026-06-26), not a parity to-do:
- R1 normal analytic Q → oracle auto-routed a single seat; hand-built panel used
  grok+gemini; all converged. Equivalent, fewer seats.
- R2 forced 2-model panel → oracle `{panel_size:2}` reproduces grok+gemini via
  diversity-fill. Common case covered.
- R3 heterogeneous specs (per-member prompt/model/temp) and R4 per-spec grounding mode
  + per-spec lens → **ask_panel's job, by design.** oracle applies one lens/system to
  all seats; that's the intended division of labor, not a gap to close.
