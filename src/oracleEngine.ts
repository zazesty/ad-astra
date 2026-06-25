/**
 * oracleEngine.ts — ask_oracle's route → dispatch → assemble core (spec §3-§7).
 *
 * runOracle(deps, prompt, overrides):
 *   prefilter + classify (oracleClassifier)  ── fail ──> prefilter-seeded fallback
 *        │                                                (degraded:true, fail-loud)
 *        ▼
 *   buildSlots   — capability seats FIRST, never silently dropped (§4)
 *        ▼
 *   executeSlots — concurrent, per-slot timeout, partial-tolerant (§5)
 *        ▼
 *   assemble     — { route, slots_status, degraded, raw? | answer? } (§6)
 *
 * Provider seam (§0): grok-direct owns x_search (+ explicit grok reasoning seats);
 * OpenRouter owns gemini (grounded/reasoning) + openrouter/auto. Grounding never
 * goes gemini-direct (silent misses) — the grounded seat is OR-native with the
 * same fail-loud zero-citation retry contract ask_panel uses.
 */

import { z } from "zod";
import { callGrok, type Grounding } from "./grokCore.js";
import {
  callOpenRouter,
  callGemini,
  makeGeminiClient,
  isTransientError,
  DEFAULT_OPENROUTER_GEMINI_MODEL,
} from "./geminiCore.js";
import { applyLens, buildLensMenu } from "./lenses.js";
import {
  classify,
  prefilter,
  CLASSIFIER_MODEL,
  type Classification,
  type Effort,
} from "./oracleClassifier.js";

export type { Effort };

export interface OracleDeps {
  xaiApiKey?: string;
  geminiApiKey?: string; // direct @google/genai key — the OR→direct failover substrate
  openrouterApiKey?: string;
  xaiBaseUrl?: string;
}

// Overrides (§7). `specs` (the deterministic ask_panel bypass) is handled one
// layer up at tool registration — it never reaches the engine.
export interface OracleOverrides {
  model_slugs?: string[];   // RESTRICT the reasoning pool (does not add seats)
  force_model?: string;     // ADD one guaranteed reasoning seat
  n?: number;               // force seat count (still floored by capability seats)
  lens?: string;            // force lens
  system?: string;          // system instruction applied to every seat (composes w/ lens)
  reasoning_effort?: Effort; // force effort — WINS over max_effort
  max_effort?: Effort;      // cap on the CLASSIFIER's effort; never raises, never overrides explicit reasoning_effort
  force_x?: boolean;        // force a direct-Grok x_search seat
  force_grounding?: boolean; // force a grounded-Gemini seat (Google-native via OR)
  synthesize?: boolean;     // true → merge into one answer (headless callers); default raw
}

export type SeatProvider = "grok-direct" | "openrouter";

export interface Seat {
  id: string;
  provider: SeatProvider;
  model_slug: string;
  lens: string;
  reasoning_effort: Effort;
  grok_grounding?: "auto" | "required"; // grok-direct ONLY — maps 1:1 to callGrok
  grounded?: boolean;                    // OR gemini slug ONLY — native web plugin
}

export interface RoutePlan {
  mode: "single" | "panel";
  models: string[];
  lens: string;
  reasoning_effort: Effort;
  used_x_search: boolean;
  used_grounding: boolean;
  panel_n: number;
  source: "classifier" | "override" | "prefilter";
  classifier_model: string | null;
  classifier_error?: string;
  domains?: string[];
  rationale: string;
}

export interface SlotStatus {
  id: string;
  status: "ok" | "error" | "timeout";
  error?: string;
}

export interface RawSeatOutput {
  id: string;
  tags: string[];
  text: string;
  citations?: string[];
}

export interface OracleResponse {
  route: RoutePlan;
  slots_status: SlotStatus[];
  degraded: boolean;
  raw?: RawSeatOutput[];
  answer?: string;
}

// ── Effort canon (§3): low|medium|high; max_effort caps, never raises ──────────
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };
export function capEffort(effort: Effort, max?: Effort): Effort {
  return max && EFFORT_RANK[effort] > EFFORT_RANK[max] ? max : effort;
}

// The gemini reasoning/grounded slug is the floating pro alias the rest of the
// codebase uses (tilde required; bare "google/gemini-3.1-pro" 400s on OR — caught
// live 2026-06-24). Single source of truth = geminiCore's export, so the
// gemini-model-check monitor covers oracle's seats too.
const GEMINI_PRO_SLUG = DEFAULT_OPENROUTER_GEMINI_MODEL;
// Single-seat default: at n=1 diversity is meaningless, so the cheap/fast wildcard
// leads. `openrouter/auto` lets OR pick per-prompt.
const DEFAULT_REASONING_POOL = ["openrouter/auto", GEMINI_PRO_SLUG];

/**
 * Diversity-first fill order for a DEFAULT (non-restricted) panel — fixes the
 * all-Gemini monoculture (2026-06-24): a 3-seat panel was filling gemini +
 * auto(→resolves Gemini) + gemini, so escalating to a "panel" bought zero
 * cross-family disagreement and lost Grok's contrarian voice entirely.
 *
 * A panel exists to get independent cross-FAMILY takes, so we guarantee family
 * spread BEFORE reaching for `openrouter/auto`. `auto` is a wildcard, not a
 * diversity guarantee (it's opaque OR routing that lately lands on Gemini) — so it
 * is the OVERFLOW tail, used only once each distinct family already has a seat.
 * That is the owner's "use auto only when a particular model isn't needed" rule,
 * enforced in the router rather than as caller-read description text (the caller /
 * classifier / auto never read that text, and the monoculture was on the no-
 * override default path).
 *
 * Families already seated (a grok-x capability seat, a forced grok/gemini seat, a
 * grounded-gemini seat) are NOT re-seated first — only the MISSING families lead,
 * so a 2-seat panel comes back cross-family by construction. The tail repeats the
 * named families so large panels keep cycling real models, not stacked `auto`.
 */
function panelFillPool(existing: Seat[]): string[] {
  const haveGrok = existing.some((s) => s.provider === "grok-direct");
  const haveGemini = existing.some((s) => s.provider === "openrouter" && /gemini/i.test(s.model_slug));
  const head: string[] = [];
  if (!haveGrok) head.push("grok"); // the contrarian cross-family voice (grok-direct, grounding off)
  if (!haveGemini) head.push(GEMINI_PRO_SLUG);
  return [...head, "openrouter/auto", GEMINI_PRO_SLUG, "grok"];
}

// An EXPLICIT grok slug (force_model / model_slugs) → a grok-DIRECT reasoning seat
// (grounding off), per §0. `openrouter/auto` may itself surface Grok via OR — that
// stays an OR seat (low-stakes wildcard). So "grok"/"x-ai/grok-*" are direct here.
function isGrokSlug(slug: string): boolean {
  return slug !== "openrouter/auto" && /grok/i.test(slug);
}

function reasoningSeat(slug: string, idx: number, lens: string, effort: Effort): Seat {
  if (isGrokSlug(slug)) {
    return { id: `reason-${idx}`, provider: "grok-direct", model_slug: slug, lens, reasoning_effort: effort };
  }
  return {
    id: slug === "openrouter/auto" ? "auto" : `reason-${idx}`,
    provider: "openrouter",
    model_slug: slug,
    lens,
    reasoning_effort: effort,
  };
}

/**
 * §4 — seat count is DERIVED from capabilities + panel_n, so capability seats are
 * never silently dropped. Capability seats (forced or classifier-flagged) come
 * first; the remainder fill from the reasoning pool. seats.length >= 1 always.
 */
export function buildSlots(c: Classification, ov: OracleOverrides = {}): Seat[] {
  const lens = ov.lens ?? c.suggested_lens;
  // Explicit reasoning_effort is the caller's own intent — it WINS over max_effort.
  // max_effort caps ONLY the classifier's suggestion (spec §3/§7), never an
  // explicit force. (Was: capEffort(ov.reasoning_effort ?? c…, max) — that wrongly
  // capped an explicit force too.)
  const effort = ov.reasoning_effort ?? capEffort(c.reasoning_effort, ov.max_effort);
  const seats: Seat[] = [];

  // capability seats — native tools, never routed through `auto`
  if (c.needs_x || ov.force_x) {
    seats.push({ id: "grok-x", provider: "grok-direct", model_slug: "grok", lens, reasoning_effort: effort, grok_grounding: "required" });
  }
  if (c.needs_grounding || ov.force_grounding) {
    seats.push({ id: "gemini-grounded", provider: "openrouter", model_slug: GEMINI_PRO_SLUG, lens, reasoning_effort: effort, grounded: true });
  }
  // explicit single-model force (e.g. "use Grok specifically")
  if (ov.force_model) {
    seats.push(reasoningSeat(ov.force_model, seats.length, lens, effort));
  }

  // seat count = max(requested, #capability seats, 1) — capabilities win
  const want = ov.n ?? c.suggested_panel_n ?? 1;
  const target = Math.max(want, seats.length, 1);
  // Reasoning-pool fill. If the caller RESTRICTS the pool (model_slugs) we honor it
  // verbatim — explicit intent overrides diversity. Otherwise a panel (target>=2)
  // gets the diversity-first order (guarantee family spread, auto as overflow);
  // a single seat keeps the plain wildcard default.
  const pool = ov.model_slugs ?? (target >= 2 ? panelFillPool(seats) : DEFAULT_REASONING_POOL);
  let i = 0;
  while (seats.length < target) {
    seats.push(reasoningSeat(pool[i++ % pool.length], seats.length, lens, effort));
  }
  return seats;
}

// grok-x's placeholder "grok" → the server default model id; strip OR's x-ai/ ns.
function resolvedModelId(s: Seat): string {
  if (s.provider === "grok-direct") return s.model_slug === "grok" ? "grok-4.3" : s.model_slug.replace(/^x-ai\//, "");
  return s.model_slug;
}

function tagsFor(s: Seat): string[] {
  const head = s.provider === "grok-direct" ? "grok" : /gemini/i.test(s.model_slug) ? "gemini" : s.model_slug;
  const tags = [head];
  if (s.grok_grounding) tags.push("x_search");
  if (s.grounded) tags.push("grounded");
  return tags;
}

/** §3 — the legible transparency record. lens/effort read off the seats (single
 *  source of truth: every seat shares them) to avoid recompute drift. */
export function buildRoutePlan(
  seats: Seat[],
  c: Classification,
  source: RoutePlan["source"],
  classifierModel: string | null,
  classifierError?: string,
): RoutePlan {
  return {
    mode: seats.length === 1 ? "single" : "panel",
    models: seats.map(resolvedModelId),
    lens: seats[0]?.lens ?? "default",
    reasoning_effort: seats[0]?.reasoning_effort ?? "high",
    used_x_search: seats.some((s) => !!s.grok_grounding),
    used_grounding: seats.some((s) => !!s.grounded),
    panel_n: seats.length,
    source,
    classifier_model: classifierModel,
    ...(classifierError ? { classifier_error: classifierError } : {}),
    domains: c.domains,
    rationale: c.rationale,
  };
}

// ── §5 executeSlots — concurrent, partial-tolerant ────────────────────────────
const CONCURRENCY = 5;
// Plain reasoning seats. Bumped 25s→40s: a high-effort grok/auto reasoning call
// can legitimately run ~22s (see reasoning-effort notes), so 25s clipped them —
// and `auto` (the overflow seat) was the most frequent single dropper at the old
// ceiling. Concurrent seats mean this only raises worst-case wall-clock, not sum.
const SLOT_TIMEOUT_MS = 40_000; // plain reasoning seats
// Capability seats (live-X / grounded) do live search + up to MAX_GROUNDING_RETRIES
// sequential re-calls, so a 25s ceiling cut them off (gemini-grounded timed out
// 2026-06-24 while reasoning seats finished) — and a dropped capability seat is the
// one we LEAST want to lose. Give them a wider budget that fits the retry chain.
const CAPABILITY_SLOT_TIMEOUT_MS = 60_000;
const MAX_GROUNDING_RETRIES = 2; // mirrors ask_panel's gemini fail-loud budget
// All seats retry ONCE on a timeout (owner pick: max resilience over bounded tail).
// Worst case a seat's wall-clock doubles (~80s reasoning / ~120s capability), but
// seats are concurrent so this raises tail latency, not summed latency. Only
// TIMEOUTS retry here — transient HTTP/network already retried inside callOpenRouter,
// and the OR→direct failover already fired, so a non-timeout error is terminal.
const MAX_TIMEOUT_RETRIES = 1;

const isCapabilitySeat = (s: Seat): boolean => !!s.grok_grounding || !!s.grounded;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

/** Concurrency-capped map that never rejects — each item resolves to its own
 *  result (errors are caught into the SlotResult), order preserved. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface SlotResult {
  seat: Seat;
  status: "ok" | "error" | "timeout";
  text?: string;
  citations?: string[];
  error?: string;
}

/** Zero-citation fail-loud retry, generic over the call path (OR-native or direct
 *  failover) so both reuse the SAME contract: retry up to MAX_GROUNDING_RETRIES on a
 *  grounding miss, then THROW grounding_fired:false rather than pass a weights-only
 *  answer back as grounded. The thrown error is a plain Error (NOT transient) so the
 *  failover wrapper rethrows it instead of looping providers. */
async function groundedWithRetry(
  once: () => Promise<{ text: string; citations: string[] }>,
  seatId: string,
  pathLabel: string,
): Promise<{ text: string; citations: string[] }> {
  let r = await once();
  for (let attempt = 1; attempt <= MAX_GROUNDING_RETRIES && r.citations.length === 0; attempt++) {
    console.error(`[ask_oracle] gemini grounded miss (0 citations) — retry ${attempt}/${MAX_GROUNDING_RETRIES}. seat=${seatId} path=${pathLabel}`);
    r = await once();
  }
  if (r.citations.length === 0) {
    throw new Error(
      `grounding_fired:false — gemini grounded seat ${seatId} (${pathLabel}) returned zero citations after ` +
        `${MAX_GROUNDING_RETRIES} retries; refusing to pass back a weights-only answer as grounded.`,
    );
  }
  return r;
}

/** Grounded gemini seat with OR→direct failover. OR-native grounding first (fast,
 *  ~8% miss → the retry contract above). On a TRANSIENT OR failure (gateway down)
 *  fail over to DIRECT-gemini grounding — the 0%-miss path (~5x slower, fits the 60s
 *  capability budget). A grounding_fired:false or 4xx is NOT transient, so it
 *  propagates and the seat fails loud as designed (we fail over outages, not misses). */
async function groundedWithFailover(
  deps: OracleDeps,
  prompt: string,
  s: Seat,
  system: string | undefined,
): Promise<{ text: string; citations: string[] }> {
  const orOnce = () =>
    callOpenRouter(deps.openrouterApiKey, s.model_slug, prompt, {
      system,
      reasoning_effort: s.reasoning_effort,
      grounded: true,
    });
  try {
    return await groundedWithRetry(orOnce, s.id, "or-native");
  } catch (e) {
    if (!isTransientError(e)) throw e;
    console.error(`[ask_oracle] OR transient fail on grounded seat ${s.id} — failover → direct-gemini grounding: ${(e as Error).message}`);
    const client = makeGeminiClient(deps.geminiApiKey);
    const directOnce = () => callGemini(client, prompt, { system, reasoning_effort: s.reasoning_effort, grounded: true });
    return groundedWithRetry(directOnce, s.id, "direct-failover");
  }
}

/** An ungrounded OR reasoning call with provider-aware OR→direct failover (spec §0
 *  resiliency). OR first; on a TRANSIENT OR failure: a gemini slug fails over to
 *  DIRECT-gemini (same family), while `openrouter/auto` and any other non-gemini OR
 *  slug fail over to GROK-DIRECT — that gives `auto` a real off-OR home AND keeps a
 *  non-Google voice alive in an OR outage so the panel doesn't collapse onto Google.
 *  Non-transient (4xx) errors propagate. Used by reasoning seats, the salvage net,
 *  and the synthesize judge — every OR-only path the engine had. */
async function orReasoningWithFailover(
  deps: OracleDeps,
  slug: string,
  prompt: string,
  opts: { system?: string; reasoning_effort: Effort },
): Promise<{ text: string; citations: string[] }> {
  try {
    return await callOpenRouter(deps.openrouterApiKey, slug, prompt, opts);
  } catch (e) {
    if (!isTransientError(e)) throw e;
    if (/gemini/i.test(slug)) {
      console.error(`[ask_oracle] OR transient fail on ${slug} — failover → direct-gemini: ${(e as Error).message}`);
      return callGemini(makeGeminiClient(deps.geminiApiKey), prompt, {
        system: opts.system,
        reasoning_effort: opts.reasoning_effort,
      });
    }
    console.error(`[ask_oracle] OR transient fail on ${slug} — failover → grok-direct: ${(e as Error).message}`);
    const r = await callGrok(
      deps.xaiApiKey,
      prompt,
      { system: opts.system, reasoning_effort: opts.reasoning_effort, grounding: "off" },
      deps.xaiBaseUrl,
    );
    return { text: r.text, citations: r.citations };
  }
}

async function dispatchSeat(
  deps: OracleDeps,
  prompt: string,
  s: Seat,
  callerSystem?: string,
): Promise<{ text: string; citations: string[] }> {
  // lens body first, caller's system text after (applyLens composes them).
  const { system, error } = applyLens(s.lens, callerSystem);
  if (error) throw new Error(error);

  if (s.provider === "grok-direct") {
    const r = await callGrok(
      deps.xaiApiKey,
      prompt,
      {
        system,
        model: s.model_slug === "grok" ? undefined : s.model_slug.replace(/^x-ai\//, ""),
        reasoning_effort: s.reasoning_effort,
        grounding: (s.grok_grounding ?? "off") as Grounding,
      },
      deps.xaiBaseUrl,
    );
    return { text: r.text, citations: r.citations };
  }
  if (s.grounded) return groundedWithFailover(deps, prompt, s, system);
  return orReasoningWithFailover(deps, s.model_slug, prompt, {
    system,
    reasoning_effort: s.reasoning_effort,
  });
}

async function executeSlots(
  deps: OracleDeps,
  prompt: string,
  seats: Seat[],
  callerSystem?: string,
): Promise<SlotResult[]> {
  return mapLimit(seats, CONCURRENCY, async (s) => {
    const timeoutMs = isCapabilitySeat(s) ? CAPABILITY_SLOT_TIMEOUT_MS : SLOT_TIMEOUT_MS;
    let lastMsg = "";
    for (let attempt = 0; attempt <= MAX_TIMEOUT_RETRIES; attempt++) {
      try {
        const r = await withTimeout(dispatchSeat(deps, prompt, s, callerSystem), timeoutMs, s.id);
        return { seat: s, status: "ok" as const, text: r.text, citations: r.citations };
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        lastMsg = msg;
        const timedOut = /timed out/i.test(msg);
        // Retry ONLY timeouts (all seats). A non-timeout error is terminal: the
        // in-call transient retry + OR→direct failover already had their shot, and a
        // grounding_fired:false is a designed fail-loud, not something to re-run.
        if (timedOut && attempt < MAX_TIMEOUT_RETRIES) {
          console.error(`[ask_oracle] seat ${s.id} timed out (${timeoutMs}ms) — timeout retry ${attempt + 1}/${MAX_TIMEOUT_RETRIES}`);
          continue;
        }
        return { seat: s, status: timedOut ? ("timeout" as const) : ("error" as const), error: msg };
      }
    }
    return { seat: s, status: "timeout" as const, error: lastMsg }; // unreachable; satisfies TS
  });
}

// ── §6 assemble ───────────────────────────────────────────────────────────────
async function synthesize(deps: OracleDeps, route: RoutePlan, oks: SlotResult[]): Promise<string> {
  const blocks = oks
    .map((r) => `## ${r.seat.id}\n${r.text}${r.citations?.length ? `\n\nSources:\n${r.citations.join("\n")}` : ""}`)
    .join("\n\n");
  const system =
    "You are a synthesizer. Merge the labeled model answers below into ONE coherent answer. " +
    "State points of agreement plainly; surface genuine disagreements explicitly rather than averaging them away; " +
    "preserve citations. Do not mention that you are merging multiple sources.";
  // Judge is PINNED to gemini-pro-latest, not openrouter/auto: synthesis is a
  // fixed, well-defined task that wants a strong, predictable reasoner — auto
  // optimizes per-prompt and could route a "merge these" call somewhere weak/
  // unexpected. (NB: deliberately NOT openrouter/fusion — Fusion runs its OWN
  // panel, which would re-answer + double-spend over seats we already ran; Fusion
  // is reserved as a separate optional hard-route ENGINE, see spec §6a.)
  // Judge runs through the same OR→direct failover as reasoning seats — synthesize
  // is the headless path (synthesize:true), so it must survive an OR outage rather
  // than hard-error. GEMINI_PRO_SLUG is gemini → fails over to direct-gemini.
  const r = await orReasoningWithFailover(deps, GEMINI_PRO_SLUG, blocks, {
    system,
    reasoning_effort: route.reasoning_effort,
  });
  return r.text;
}

export async function assemble(
  deps: OracleDeps,
  route: RoutePlan,
  results: SlotResult[],
  ov: OracleOverrides,
  classifierFellBack: boolean,
): Promise<OracleResponse> {
  const slots_status: SlotStatus[] = results.map((r) => ({
    id: r.seat.id,
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
  }));
  const oks = results.filter((r) => r.status === "ok");
  const degraded = classifierFellBack || results.some((r) => r.status !== "ok");

  // REALIZED capability flags (spec §3 trust): buildRoutePlan seeds used_x_search /
  // used_grounding from PLANNED seats (pre-exec, all it has). Finalize them here to
  // what actually FIRED — a capability seat that timed out or errored must not leave
  // route.used_grounding:true (that lied 2026-06-24: grounded seat timed out yet the
  // route still claimed grounding). An ok grok-x/grounded seat is genuine: both are
  // required-grounding, so status:ok ⇒ citations were returned.
  route.used_x_search = oks.some((r) => !!r.seat.grok_grounding);
  route.used_grounding = oks.some((r) => !!r.seat.grounded);

  const resp: OracleResponse = { route, slots_status, degraded };
  if (ov.synthesize) {
    resp.answer = oks.length ? await synthesize(deps, route, oks) : "(no seat returned a usable answer)";
  } else {
    resp.raw = oks.map((r) => ({
      id: r.seat.id,
      tags: tagsFor(r.seat),
      text: r.text!,
      ...(r.citations?.length ? { citations: r.citations } : {}),
    }));
  }
  return resp;
}

// Prefilter-seeded fallback Classification when the classifier can't be reached
// or parsed (§2). A single auto reasoning seat plus any seeded capability seat.
function fallbackClassification(prompt: string): Classification {
  const seeds = prefilter(prompt);
  return {
    difficulty: "moderate",
    domains: [],
    needs_x: seeds.needs_x,
    needs_grounding: seeds.needs_grounding,
    suggested_lens: "default",
    suggested_panel_n: 1,
    reasoning_effort: "high",
    rationale: "classifier unavailable — prefilter-seeded fallback route",
  };
}

/** The front door. Always classifies (no skip gate) except the caller's `specs`
 *  bypass, which is handled above the engine. Fail-loud: a dead classifier
 *  degrades to a prefilter-seeded route, it never blocks an answer. */
export async function runOracle(
  deps: OracleDeps,
  prompt: string,
  ov: OracleOverrides = {},
): Promise<OracleResponse> {
  let classification: Classification;
  let source: RoutePlan["source"] = "classifier";
  let classifierModel: string | null = CLASSIFIER_MODEL;
  let classifierError: string | undefined;

  try {
    classification = await classify(deps.openrouterApiKey, prompt, deps.geminiApiKey);
  } catch (e) {
    source = "prefilter";
    classifierModel = null;
    classifierError = (e as Error)?.message ?? String(e);
    console.error(`[ask_oracle] classifier fallback (degraded:true): ${classifierError}`);
    classification = fallbackClassification(prompt);
  }

  const seats = buildSlots(classification, ov);
  const route = buildRoutePlan(seats, classification, source, classifierModel, classifierError);
  let results = await executeSlots(deps, prompt, seats, ov.system);

  // Salvage net: if EVERY seat failed — the lone grounded-only route failing loud
  // on zero citations is the motivating case, but also all-timeout nights — make
  // ONE last-ditch UNGROUNDED reasoning call so we never hand back an empty answer
  // (critical for headless synthesize:true). Best-effort: if it also fails we fall
  // through to assemble's empty-degraded path. Costs nothing on the happy path
  // (only fires when oks is already empty). The salvage seat is ungrounded, so
  // assemble's realized-flag recompute correctly reports used_grounding:false.
  if (!results.some((r) => r.status === "ok")) {
    const salvageSeat: Seat = {
      id: "salvage-ungrounded",
      provider: "openrouter",
      model_slug: GEMINI_PRO_SLUG,
      lens: seats[0]?.lens ?? "default",
      reasoning_effort: seats[0]?.reasoning_effort ?? "high",
    };
    try {
      const r = await withTimeout(dispatchSeat(deps, prompt, salvageSeat, ov.system), SLOT_TIMEOUT_MS, salvageSeat.id);
      results = [...results, { seat: salvageSeat, status: "ok", text: r.text, citations: r.citations }];
      console.error("[ask_oracle] all seats failed — ungrounded salvage recovered a non-empty answer (degraded).");
    } catch (e) {
      console.error(`[ask_oracle] salvage seat also failed: ${(e as Error)?.message ?? e}`);
    }
  }
  return assemble(deps, route, results, ov, !!classifierError);
}

// ── MCP tool registration (step 4) ────────────────────────────────────────────
export type OracleRegisterOpts = {
  xaiApiKey?: string;
  geminiApiKey?: string;
  openrouterApiKey?: string;
  xaiBaseUrl?: string;
};

/**
 * Registers `ask_oracle` — the auto-routing front door. The caller passes just a
 * prompt; the classifier decides panel size / capabilities / lens / effort, the
 * seats fan out concurrently, and the response carries a legible `route` object
 * plus raw labeled answers (default) or a synthesized answer. Forceful overrides
 * supersede the classifier when the caller has intent.
 *
 * Ships BESIDE ask_panel on the existing URL (callers invoke by name, so a longer
 * tool list doesn't disturb them). The `specs` deterministic-bypass and the
 * eventual ask_panel fold-in are deferred — ask_panel remains available directly.
 */
export function registerAskOracle(server: any, opts: OracleRegisterOpts) {
  const deps: OracleDeps = {
    xaiApiKey: opts.xaiApiKey,
    geminiApiKey: opts.geminiApiKey,
    openrouterApiKey: opts.openrouterApiKey,
    xaiBaseUrl: opts.xaiBaseUrl,
  };

  server.registerTool(
    "ask_oracle",
    {
      title: "Ask Oracle (auto-routed)",
      description:
        "Auto-routing front door over the model layer. Give it a prompt; it classifies the question and " +
        "routes a panel for you. SEATS come in two kinds: CAPABILITY seats — live-X (Grok x_search) and " +
        "web grounding (Gemini Google Search) — and REASONING seats — a model pool that, on a multi-seat " +
        "panel, is filled DIVERSITY-FIRST (cross-family by construction, e.g. Grok + Gemini) with " +
        "`openrouter/auto` used only as overflow once each family is seated. The classifier decides how " +
        "many seats, which capabilities, which lens, and " +
        "how hard to think. Returns a legible `route` object (which models ran, lens/effort, capabilities " +
        "fired, who decided + why), `slots_status`, a `degraded` flag, and either `raw` labeled answers " +
        "(DEFAULT — YOU synthesize) or a single `answer` when synthesize=true (for headless callers). " +
        "Use ask_panel when you want to hand-pick the exact models/specs; use ask_oracle when you want it " +
        "decided for you. All overrides are optional and supersede the classifier.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, { message: "prompt must not be empty or whitespace-only" })
          .describe("The question to route and answer."),
        synthesize: z
          .boolean()
          .optional()
          .describe("true → merge the seats into ONE answer (judge = gemini-pro-latest), for headless/automated callers. Default false → return raw labeled answers for you to synthesize."),
        system: z
          .string()
          .optional()
          .describe("System instruction applied to EVERY seat — persona, tone, output format, constraints. Composes with the lens: lens body first, then your text."),
        panel_size: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Force the total number of seats. Still floored by required capability seats: live-X / grounding are never dropped to honor a smaller size."),
        lens: z
          .string()
          .optional()
          .describe(
            "Analytical frame applied to every seat via the system prompt. By DEFAULT the classifier picks " +
              "a frame for the question (usually 'default', a neutral second-opinion frame); set this to OVERRIDE " +
              "its pick, 'none' to disable framing, or choose one: " +
              buildLensMenu() +
              ". Composes with `system`: lens body first, then your `system` text.",
          ),
        reasoning_effort: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Force reasoning effort (low|medium|high) on every seat. Takes PRECEDENCE over max_effort. Omit to let the classifier scale effort with difficulty."),
        max_effort: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Ceiling on the CLASSIFIER's effort pick — it may choose lower, never higher. Does NOT cap an explicit reasoning_effort (that wins)."),
        model_slugs: z
          .array(z.string())
          .optional()
          .describe("RESTRICT the reasoning-seat pool the classifier draws from to these slugs (does NOT add seats; capability seats are unaffected). Slugs are OpenRouter model IDs — e.g. 'openrouter/auto', '~google/gemini-pro-latest'; a grok slug ('x-ai/grok-4.3') is routed DIRECT to xAI."),
        force_model: z
          .string()
          .optional()
          .describe("ADD one guaranteed reasoning seat for this exact model (use when you want a specific model in the panel). Same slug space as model_slugs: an OpenRouter model ID, or a grok slug ('x-ai/grok-4.3') which routes direct to xAI."),
        force_x: z
          .boolean()
          .optional()
          .describe("Add a live-X seat (Grok x_search) with required-grounding: it ERRORS rather than return a sourceless answer if X yields nothing."),
        force_grounding: z
          .boolean()
          .optional()
          .describe("Add a web-grounded Gemini seat — live Google Search (Gemini-native, routed via OpenRouter) — with required-grounding: it ERRORS rather than return a sourceless answer if no citations come back."),
      },
    },
    async (args: {
      prompt: string;
      synthesize?: boolean;
      system?: string;
      panel_size?: number;
      lens?: string;
      reasoning_effort?: Effort;
      max_effort?: Effort;
      model_slugs?: string[];
      force_model?: string;
      force_x?: boolean;
      force_grounding?: boolean;
    }) => {
      try {
        const result = await runOracle(deps, args.prompt, {
          synthesize: args.synthesize,
          system: args.system,
          n: args.panel_size,
          lens: args.lens,
          reasoning_effort: args.reasoning_effort,
          max_effort: args.max_effort,
          model_slugs: args.model_slugs,
          force_model: args.force_model,
          force_x: args.force_x,
          force_grounding: args.force_grounding,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ask_oracle failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
