/**
 * research_fanout — multi-sub-question grounded research tool (#4).
 * Spec: /root/research_fanout_spec.md
 *
 * Flow: decompose → route → execute legs (direct cores only) → synthesize.
 * Client-adaptive outer budget (50s chat, 55s Claude, 85s Grok Build); partial return; citation union preserved.
 */
import { z } from "zod";
import { callGrok, type Grounding } from "./grokCore.js";
import {
  callOpenRouter,
  callGemini,
  makeGeminiClient,
  DEFAULT_OPENROUTER_GEMINI_MODEL,
  type GeminiClient,
  type GeminiTransport,
} from "./geminiCore.js";
import { applyLens } from "./lenses.js";
import {
  CLASSIFIER_MODEL_OR,
  CLASSIFIER_FALLBACK_MODELS,
} from "./oracleClassifier.js";
import {
  GEMINI_FLASH_OR,
  GEMINI_FLASH_DIRECT,
} from "./modelPins.js";
import {
  classifyError,
  hashQuestion,
  isAttemptTimeoutError,
  loggedReasoningEffort,
  recordFanoutRun,
  recordSeatMetric,
  type FanoutRunRecord,
  type SeatMetricRecord,
} from "./metrics.js";
import { canStartAttempt, remainingMs, seatBudgetMs, withTimeout } from "./timeouts.js";
import { type BudgetProfile } from "./budgetProfile.js";

const OUTER_BUDGET_MS = 85_000;
const DECOMPOSE_CAP_MS = 15_000;
const LEG_PHASE_CAP_MS = 50_000;
const SYNTH_CAP_MS = 40_000; // high-effort gemini merge often >15–25s
const MAX_LEGS_HARD = 5;
const CONCURRENCY = 5;
const LEG_SEAT_CAP_MS = 45_000;

export type LegMode = "gemini_grounded" | "grok_x" | "grok_grounded";

export type LegPlan = {
  query: string;
  mode: LegMode;
  rationale?: string;
};

export type LegResult = {
  id: string;
  query: string;
  mode: LegMode;
  status: "ok" | "timeout" | "error" | "skipped";
  answer?: string;
  citations: string[];
  latency_ms: number;
  error?: string;
  transport?: "or" | "direct";
  /** OpenRouter response service_tier. Absent on timeout, direct, or upstream null. */
  served_tier?: string;
};

type RegisterOpts = {
  xaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  openrouterApiKey: string | undefined;
  geminiTransport: GeminiTransport;
  xaiBaseUrl?: string;
  budget?: BudgetProfile;
};

export function coerceMode(raw: unknown): LegMode {
  const s = String(raw || "").toLowerCase();
  if (s === "grok_x" || s === "x" || s === "x_search") return "grok_x";
  if (s === "grok_grounded" || s === "grok") return "grok_grounded";
  return "gemini_grounded";
}

export function dedupeCitations(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = (u || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

async function mapLimitSettled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const DECOMPOSE_SYSTEM = `You decompose a research question into independent evidence-seeking sub-queries.
Return ONLY JSON: {"legs":[{"query":"...","mode":"gemini_grounded|grok_x|grok_grounded","rationale":"..."}]}
Rules:
- 1 to N legs (N given by user). Prefer factual, sourceable sub-questions.
- mode gemini_grounded = general web/current facts (default).
- mode grok_x = live X / social / "what is being said on X".
- mode grok_grounded = Grok retrieval with web/x when non-Gemini retrieval helps.
- No meta/opinion-only legs. No nested research instructions.
- Keep each query self-contained.`;

async function decompose(
  openrouterApiKey: string | undefined,
  prompt: string,
  maxLegs: number,
  budgetMs: number,
): Promise<{ plans: LegPlan[]; source: "classifier" | "fallback_single" }> {
  if (!openrouterApiKey || budgetMs < 800) {
    return { plans: [{ query: prompt, mode: "gemini_grounded" }], source: "fallback_single" };
  }
  try {
    const user = `Max legs: ${maxLegs}\n\nResearch question:\n${prompt}`;
    const r = await withTimeout(
      callOpenRouter(openrouterApiKey, CLASSIFIER_MODEL_OR, user, {
        system: DECOMPOSE_SYSTEM,
        models: CLASSIFIER_FALLBACK_MODELS,
        reasoning_effort: "low",
        temperature: 0.2,
      }),
      budgetMs,
      "research_fanout decompose",
    );
    const text = (r.text || "").trim();
    const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const parsed = JSON.parse(unfenced) as { legs?: unknown[] };
    const rawLegs = Array.isArray(parsed.legs) ? parsed.legs : [];
    const plans: LegPlan[] = [];
    for (const item of rawLegs.slice(0, maxLegs)) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const q = String(o.query || "").trim();
      if (!q) continue;
      plans.push({
        query: q,
        mode: coerceMode(o.mode),
        rationale: o.rationale != null ? String(o.rationale) : undefined,
      });
    }
    if (!plans.length) {
      return { plans: [{ query: prompt, mode: "gemini_grounded" }], source: "fallback_single" };
    }
    return { plans, source: "classifier" };
  } catch (e) {
    console.error(`[research_fanout] decompose fallback: ${(e as Error)?.message ?? e}`);
    return { plans: [{ query: prompt, mode: "gemini_grounded" }], source: "fallback_single" };
  }
}

export function ensureForceX(plans: LegPlan[], force: boolean, maxLegs: number): LegPlan[] {
  if (!force) return plans;
  if (plans.some((p) => p.mode === "grok_x")) return plans;
  const next = plans.slice(0, Math.max(0, maxLegs - 1));
  next.push({
    query: plans[0]?.query || "What is being said on X about this topic right now?",
    mode: "grok_x",
    rationale: "force_x_leg",
  });
  return next.slice(0, maxLegs);
}

/**
 * Pure post-legs assembly (E2 soak contract without live providers):
 * citation union from ok legs only; degraded when any leg failed/timed out.
 */
/** Decompose and synth are model calls. Their own family keeps them out of leg percentiles. */
export function fanoutPhaseSeatRecords(input: {
  ts: string;
  question_hash: string;
  decompose_ms: number;
  decompose_source: "classifier" | "fallback_single" | "not_run";
  synth_ms?: number;
  synth_error?: string;
  gemini_transport: "or" | "direct";
}): SeatMetricRecord[] {
  const out: SeatMetricRecord[] = [];
  if (input.decompose_source !== "not_run") {
    const ok = input.decompose_source === "classifier";
    out.push({
      ts: input.ts,
      tool: "research_fanout",
      route_mode: "decompose",
      seat_id: "decompose",
      family: "classifier",
      model_slug: CLASSIFIER_MODEL_OR,
      transport: "or",
      grounded_requested: false,
      grounding_fired: false,
      x_search_fired: false,
      reasoning_effort: "low",
      latency_ms: input.decompose_ms,
      failover_fired: false,
      timed_out: false,
      ok,
      degraded: !ok,
      error_class: ok ? undefined : "other",
      question_hash: input.question_hash,
    });
  }
  if (input.synth_ms != null) {
    const ok = !input.synth_error;
    const timedOut = isAttemptTimeoutError(input.synth_error);
    out.push({
      ts: input.ts,
      tool: "research_fanout",
      route_mode: "synth",
      seat_id: "synth",
      family: "synth",
      model_slug: DEFAULT_OPENROUTER_GEMINI_MODEL,
      transport: input.gemini_transport,
      grounded_requested: false,
      grounding_fired: false,
      x_search_fired: false,
      reasoning_effort: loggedReasoningEffort(DEFAULT_OPENROUTER_GEMINI_MODEL, null),
      latency_ms: input.synth_ms,
      failover_fired: false,
      timed_out: timedOut,
      ok,
      degraded: !ok,
      error_class: classifyError(timedOut ? "timeout" : ok ? "ok" : "error", input.synth_error),
      question_hash: input.question_hash,
    });
  }
  return out;
}

function persistFanout(run: FanoutRunRecord, seats: SeatMetricRecord[]): void {
  void recordFanoutRun(run);
  for (const seat of seats) void recordSeatMetric(seat);
}

export function summarizeLegs(legs: LegResult[]): {
  citations: string[];
  okCount: number;
  degraded: boolean;
  slots_status: string;
} {
  const citations = dedupeCitations(legs.flatMap((l) => (l.status === "ok" ? l.citations : [])));
  const okCount = legs.filter((l) => l.status === "ok").length;
  const degraded = okCount < legs.length;
  return {
    citations,
    okCount,
    degraded,
    slots_status: `${okCount}/${legs.length} legs ok`,
  };
}

async function runLeg(
  opts: RegisterOpts,
  geminiClient: GeminiClient | null,
  plan: LegPlan,
  id: string,
  effort: "low" | "medium" | "high" | undefined,
  budgetMs: number,
  qHash: string,
): Promise<LegResult> {
  const t0 = Date.now();
  const base: LegResult = {
    id,
    query: plan.query,
    mode: plan.mode,
    status: "error",
    citations: [],
    latency_ms: 0,
  };
  if (budgetMs < 500) {
    return {
      ...base,
      status: "timeout",
      error: `${id} timed out after 0ms (budget exhausted)`,
      latency_ms: Date.now() - t0,
    };
  }

  const record = (leg: LegResult) => {
    const ok = leg.status === "ok";
    const legModelSlug =
      plan.mode.startsWith("grok")
        ? "grok"
        : (leg.transport === "direct" || (leg.transport == null && opts.geminiTransport === "direct"))
          ? GEMINI_FLASH_DIRECT
          : GEMINI_FLASH_OR;
    void recordSeatMetric({
      ts: new Date().toISOString(),
      tool: "research_fanout",
      route_mode: plan.mode,
      seat_id: id,
      family: plan.mode.startsWith("grok") ? "grok" : "gemini",
      model_slug: legModelSlug,
      transport: leg.transport ?? (plan.mode.startsWith("grok") ? "direct" : "or"),
      grounded_requested: true,
      grounding_fired: ok && (leg.citations?.length ?? 0) > 0,
      x_search_fired: ok && plan.mode === "grok_x" && (leg.citations?.length ?? 0) > 0,
      reasoning_effort: loggedReasoningEffort(
        legModelSlug,
        plan.mode === "gemini_grounded" ? null : effort,
      ),
      latency_ms: leg.latency_ms,
      failover_fired: false,
      timed_out: leg.status === "timeout",
      ok,
      degraded: !ok,
      error_class: classifyError(leg.status === "timeout" ? "timeout" : ok ? "ok" : "error", leg.error),
      question_hash: qHash,
      served_tier: leg.served_tier,
    });
  };

  try {
    const result = await withTimeout(
      (async (): Promise<LegResult> => {
        if (plan.mode === "gemini_grounded") {
          const geminiOpts = {
            grounded: true as const,
            reasoning_effort: null,
            attempt_timeout_ms:
              opts.geminiTransport === "openrouter"
                ? Math.max(5_000, budgetMs - 500)
                : undefined,
          };
          const callOnce = () =>
            opts.geminiTransport === "openrouter"
              ? callOpenRouter(opts.openrouterApiKey, GEMINI_FLASH_OR, plan.query, {
                  ...geminiOpts,
                  grounded: true,
                })
              : callGemini(geminiClient, plan.query, {
                  ...geminiOpts,
                  model: GEMINI_FLASH_DIRECT,
                });

          let r = await callOnce();
          // Cap retries under budget: at most 1 miss-retry for fanout (tighter than panel).
          if (r.citations.length === 0 && canStartAttempt(t0, budgetMs)) {
            console.error(`[research_fanout] ${id} gemini grounded miss — retry 1/1`);
            r = await callOnce();
          }
          if (r.citations.length === 0) {
            throw new Error(
              "grounding_fired:false — Gemini grounded leg returned zero citations after retries",
            );
          }
          return {
            ...base,
            status: "ok",
            answer: r.text,
            citations: r.citations || [],
            transport: opts.geminiTransport === "openrouter" ? "or" : "direct",
            latency_ms: Date.now() - t0,
            served_tier: r.service_tier,
          };
        }

        const grounding: Grounding = plan.mode === "grok_x" ? "required" : "auto";
        const r = await callGrok(
          opts.xaiApiKey,
          plan.query,
          {
            grounding,
            include_web: plan.mode === "grok_grounded",
            reasoning_effort: effort,
          },
          opts.xaiBaseUrl,
        );
        return {
          ...base,
          status: "ok",
          answer: r.text,
          citations: r.citations || [],
          transport: "direct",
          latency_ms: Date.now() - t0,
        };
      })(),
      budgetMs,
      id,
    );
    record(result);
    return result;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const timedOut = isAttemptTimeoutError(msg);
    const leg: LegResult = {
      ...base,
      status: timedOut ? "timeout" : "error",
      error: msg,
      citations: [],
      latency_ms: Date.now() - t0,
      transport: plan.mode.startsWith("grok") ? "direct" : opts.geminiTransport === "openrouter" ? "or" : "direct",
    };
    record(leg);
    return leg;
  }
}

async function synthesize(
  openrouterApiKey: string | undefined,
  geminiClient: GeminiClient | null,
  geminiTransport: GeminiTransport,
  prompt: string,
  legs: LegResult[],
  system: string | undefined,
  budgetMs: number,
): Promise<string> {
  const oks = legs.filter((l) => l.status === "ok" && l.answer);
  if (!oks.length) throw new Error("no successful legs to synthesize");
  if (budgetMs < 800) {
    // Best effort: concatenate
    return oks.map((l) => `## ${l.id}\n${l.answer}`).join("\n\n");
  }
  const blocks = oks
    .map(
      (l) =>
        `## ${l.id} (${l.mode})\nQuery: ${l.query}\n${l.answer}` +
        (l.citations.length ? `\n\nSources:\n${l.citations.join("\n")}` : ""),
    )
    .join("\n\n");
  const sys =
    (system ? system + "\n\n" : "") +
    "You are a research synthesizer. Merge the labeled evidence legs into ONE coherent answer to the original question. " +
    "Preserve factual claims with sources. Prefer citing URLs that appear in the leg Sources lists. " +
    "Surface disagreements explicitly. Do not invent citations. Do not drop all sources.";
  const user = `Original question:\n${prompt}\n\nEvidence legs:\n${blocks}`;

  // Synth can exceed the default 15s OR attempt abort. Effort is omitted so
  // Google's Argon default (medium) applies. High missed the chat abort on
  // the 2026-10-13 bakeoff, which is why this is not left to the Argon wire.
  const attemptMs = Math.min(Math.max(budgetMs - 200, 5_000), 55_000);
  const r = await withTimeout(
    geminiTransport === "openrouter" || !geminiClient
      ? callOpenRouter(openrouterApiKey, DEFAULT_OPENROUTER_GEMINI_MODEL, user, {
          system: sys,
          reasoning_effort: null,
          grounded: false,
          attempt_timeout_ms: attemptMs,
        })
      : callGemini(geminiClient, user, { system: sys, reasoning_effort: null, grounded: false }),
    budgetMs,
    "research_fanout synth",
  );
  return r.text;
}

export function registerResearchFanout(server: any, opts: RegisterOpts) {
  const geminiClient = makeGeminiClient(opts.geminiApiKey);
  const outerBudgetMs = opts.budget?.fanoutOuterMs ?? OUTER_BUDGET_MS;
  const legSeatCapMs = opts.budget?.fanoutLegSeatMs ?? LEG_SEAT_CAP_MS;

  server.registerTool(
    "research_fanout",
    {
      title: "Research Fanout",
      description:
        "Parallel grounded EVIDENCE for a scoped, multi-hop factual/regional/technical question, e.g. industry + " +
          "labor + technology + supply chain in a region. Fans out fixed independent sub-questions; use native deep " +
          "research when you need to steer an evolving iterative loop. This is not an opinion panel or live-news wire. " +
          "Strategy/opinion/tradeoffs → ask_panel with specs omitted. Pure breaking-X sentiment → ask_panel " +
          "model:'grok', grounded:true; fanout X legs can time out under load. Re-scope vague prompts first. Trivial " +
          "textbook constants may fail with grounding_miss, degraded:true and no answer. Flow: decompose up to max_legs " +
          "(fewer when sufficient), run independent parallel web-grounded Gemini 3.8 Flash legs plus optional " +
          "grok_x/grok_grounded legs, then merge with citation union; no nested tools. synthesize:false returns raw " +
          "legs. Independent failures yield partial results and degraded/slots_status. Inspect route.elapsed_ms, " +
          "legs[].status, citations[] and degraded. Healthy complex runs often take 30–45s; outer budgets are " +
          "client-dependent (~50s chat, ~55s Claude, ~85s Grok Build). Multiple legs mean multiple model calls/cost. " +
          "lens/system affect synthesis only, never routing.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, { message: "prompt must not be empty" })
          .describe(
            "Scoped evidence-seeking question. Examples: \"East Bay precision CNC opportunities: labor, supply chain, " +
          "AI/CAM and aerospace/medtech\"; \"Current US federal funds target range, with official sources.\" Re-scope " +
          "\"Tell me about AI\" before calling.",
          ),
        synthesize: z
          .boolean()
          .optional()
          .describe(
            "true (default): one coherent answer plus citation union. false: raw legs to inspect or merge yourself. " +
          "ask_panel defaults to false.",
          ),
        max_legs: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEGS_HARD)
          .optional()
          .describe(
            "Maximum sub-queries (default 4, hard cap 5). The classifier may use fewer for a single-answer question, or " +
          "the full cap for multi-hop work.",
          ),
        lens: z
          .string()
          .optional()
          .describe(
            "Synthesis-only frame (e.g. steelman-then-break); changes final structure/tone, never leg routing or " +
          "grounding.",
          ),
        system: z
          .string()
          .optional()
          .describe("Extra system text for synthesis only (not leg generation)."),
        force_x_leg: z
          .boolean()
          .optional()
          .describe(
            "Ensure at least one live-X grok_x leg when research needs web + X. For pure breaking-X reaction, use " +
          "ask_panel model:'grok', grounded:true instead; hot-topic X legs can increase fanout timeout risk.",
          ),
      },
    },
    async (args: {
      prompt: string;
      synthesize?: boolean;
      max_legs?: number;
      lens?: string;
      system?: string;
      force_x_leg?: boolean;
    }) => {
      const outerT0 = Date.now();
      const maxLegs = Math.min(MAX_LEGS_HARD, Math.max(1, args.max_legs ?? 4));
      const doSynth = args.synthesize !== false;
      const effort: "low" | "medium" | "high" = "medium";
      const qHash = hashQuestion(args.prompt);
      const phases = { decompose_ms: 0, legs_ms: 0, synth_ms: undefined as number | undefined };
      const geminiTransport: "or" | "direct" = opts.geminiTransport === "openrouter" ? "or" : "direct";
      let decomposeSource: "classifier" | "fallback_single" | "not_run" = "not_run";
      let synthError: string | undefined;
      let degraded = false;
      let legCount = 0;
      let okLegs = 0;

      const storeRun = (error?: string) => {
        const ts = new Date().toISOString();
        persistFanout(
          {
            ts,
            question_hash: qHash,
            elapsed_ms: Date.now() - outerT0,
            decompose_ms: phases.decompose_ms,
            decompose_source: decomposeSource,
            legs_ms: phases.legs_ms,
            ...(phases.synth_ms != null ? { synth_ms: phases.synth_ms, synth_ok: !synthError } : {}),
            degraded: degraded || !!error,
            leg_count: legCount,
            ok_legs: okLegs,
            max_legs: maxLegs,
            ...(error ? { error: error.slice(0, 300) } : {}),
          },
          fanoutPhaseSeatRecords({
            ts,
            question_hash: qHash,
            decompose_ms: phases.decompose_ms,
            decompose_source: decomposeSource,
            synth_ms: phases.synth_ms,
            synth_error: synthError,
            gemini_transport: geminiTransport,
          }),
        );
      };

      try {
        // --- decompose ---
        const decBudget = Math.min(DECOMPOSE_CAP_MS, remainingMs(outerT0, outerBudgetMs));
        const decT0 = Date.now();
        let { plans, source } = await decompose(opts.openrouterApiKey, args.prompt, maxLegs, decBudget);
        plans = ensureForceX(plans, !!args.force_x_leg, maxLegs);
        decomposeSource = source;
        phases.decompose_ms = Date.now() - decT0;

        // --- legs ---
        const legsT0 = Date.now();
        const outerRem = remainingMs(outerT0, outerBudgetMs);
        const legPhaseBudget = doSynth
          ? Math.min(LEG_PHASE_CAP_MS, outerRem, Math.max(5_000, outerRem - 8_000))
          : Math.min(LEG_PHASE_CAP_MS, outerRem);
        const settled = await mapLimitSettled(plans, CONCURRENCY, async (plan, i) => {
          const id = `leg-${i}`;
          const budget = seatBudgetMs(legsT0, legPhaseBudget, legSeatCapMs);
          // Also respect outer wall
          const outerLeft = remainingMs(outerT0, outerBudgetMs);
          const b = Math.min(budget, outerLeft);
          return runLeg(opts, geminiClient, plan, id, effort, b, qHash);
        });
        const legs: LegResult[] = settled.map((s, i) => {
          if (s.status === "fulfilled") return s.value;
          const msg = String((s.reason as Error)?.message ?? s.reason);
          return {
            id: `leg-${i}`,
            query: plans[i]?.query || args.prompt,
            mode: plans[i]?.mode || "gemini_grounded",
            status: isAttemptTimeoutError(msg) ? ("timeout" as const) : ("error" as const),
            citations: [],
            latency_ms: 0,
            error: msg,
          };
        });
        phases.legs_ms = Date.now() - legsT0;

        const summary = summarizeLegs(legs);
        degraded = summary.degraded;
        legCount = legs.length;
        okLegs = summary.okCount;
        let answer: string | undefined;

        if (doSynth && summary.okCount > 0) {
          const synthT0 = Date.now();
          const synthBudget = Math.min(SYNTH_CAP_MS, remainingMs(outerT0, outerBudgetMs));
          const lensed = applyLens(args.lens, args.system);
          const sys = lensed.error ? args.system : lensed.system;
          try {
            answer = await synthesize(
              opts.openrouterApiKey,
              geminiClient,
              opts.geminiTransport,
              args.prompt,
              legs,
              sys,
              synthBudget,
            );
          } catch (e) {
            degraded = true;
            synthError = (e as Error)?.message ?? String(e);
            console.error(`[research_fanout] synth failed: ${synthError}`);
            // Partial: best leg text
            answer = legs
              .filter((l) => l.status === "ok")
              .map((l) => `## ${l.id}\n${l.answer}`)
              .join("\n\n");
          }
          phases.synth_ms = Date.now() - synthT0;
        } else if (doSynth && summary.okCount === 0) {
          degraded = true;
        }

        const resp = {
          route: {
            tool: "research_fanout",
            decompose_source: source,
            max_legs: maxLegs,
            planned: plans,
            budget_ms: outerBudgetMs,
            elapsed_ms: Date.now() - outerT0,
            phases,
          },
          legs,
          degraded,
          ...(answer != null ? { answer } : {}),
          citations: summary.citations,
          slots_status: summary.slots_status,
        };

        storeRun();
        return { content: [{ type: "text", text: JSON.stringify(resp, null, 2) }] };
      } catch (err) {
        const message = (err as Error).message;
        storeRun(message);
        return {
          content: [{ type: "text", text: `research_fanout failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

export { OUTER_BUDGET_MS, MAX_LEGS_HARD };
