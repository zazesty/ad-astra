/**
 * research_fanout — multi-sub-question grounded research tool (#4).
 * Spec: /root/research_fanout_spec.md
 *
 * Flow: decompose → route → execute legs (direct cores only) → synthesize.
 * Hard outer budget 85s; partial return; citation union preserved.
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
  CLASSIFIER_MODEL,
  CLASSIFIER_FALLBACK_MODELS,
} from "./oracleClassifier.js";
import {
  classifyError,
  familyFromSlug,
  hashQuestion,
  isAttemptTimeoutError,
  recordSeatMetric,
} from "./metrics.js";
import { remainingMs, seatBudgetMs, withTimeout } from "./timeouts.js";

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
};

type RegisterOpts = {
  xaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  openrouterApiKey: string | undefined;
  geminiTransport: GeminiTransport;
  xaiBaseUrl?: string;
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
      callOpenRouter(openrouterApiKey, CLASSIFIER_MODEL, user, {
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

async function runLeg(
  opts: RegisterOpts,
  geminiClient: GeminiClient | null,
  plan: LegPlan,
  id: string,
  effort: "low" | "medium" | "high",
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
    void recordSeatMetric({
      ts: new Date().toISOString(),
      tool: "research_fanout",
      route_mode: plan.mode,
      seat_id: id,
      family: plan.mode.startsWith("grok") ? "grok" : "gemini",
      model_slug: plan.mode.startsWith("grok") ? "grok" : DEFAULT_OPENROUTER_GEMINI_MODEL,
      transport: leg.transport ?? (plan.mode.startsWith("grok") ? "direct" : "or"),
      grounded_requested: true,
      grounding_fired: ok && (leg.citations?.length ?? 0) > 0,
      x_search_fired: ok && plan.mode === "grok_x" && (leg.citations?.length ?? 0) > 0,
      reasoning_effort: effort,
      latency_ms: leg.latency_ms,
      failover_fired: false,
      timed_out: leg.status === "timeout",
      ok,
      degraded: !ok,
      error_class: classifyError(leg.status === "timeout" ? "timeout" : ok ? "ok" : "error", leg.error),
      question_hash: qHash,
    });
  };

  try {
    const result = await withTimeout(
      (async (): Promise<LegResult> => {
        if (plan.mode === "gemini_grounded") {
          const geminiOpts = {
            grounded: true as const,
            reasoning_effort: effort,
            attempt_timeout_ms:
              opts.geminiTransport === "openrouter"
                ? Math.min(45_000, Math.max(5_000, budgetMs - 500))
                : undefined,
          };
          const callOnce = () =>
            opts.geminiTransport === "openrouter"
              ? callOpenRouter(opts.openrouterApiKey, DEFAULT_OPENROUTER_GEMINI_MODEL, plan.query, {
                  ...geminiOpts,
                  grounded: true,
                })
              : callGemini(geminiClient, plan.query, geminiOpts);

          let r = await callOnce();
          // Cap retries under budget: at most 1 miss-retry for fanout (tighter than panel).
          if (r.citations.length === 0 && remainingMs(t0, budgetMs) > 8_000) {
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

  // Synth can exceed the default 15s OR attempt abort (high-effort merge).
  const attemptMs = Math.min(Math.max(budgetMs - 200, 5_000), 55_000);
  const r = await withTimeout(
    geminiTransport === "openrouter" || !geminiClient
      ? callOpenRouter(openrouterApiKey, DEFAULT_OPENROUTER_GEMINI_MODEL, user, {
          system: sys,
          reasoning_effort: "high",
          grounded: false,
          attempt_timeout_ms: attemptMs,
        })
      : callGemini(geminiClient, user, { system: sys, reasoning_effort: "high", grounded: false }),
    budgetMs,
    "research_fanout synth",
  );
  return r.text;
}

export function registerResearchFanout(server: any, opts: RegisterOpts) {
  const geminiClient = makeGeminiClient(opts.geminiApiKey);

  server.registerTool(
    "research_fanout",
    {
      title: "Research Fanout",
      description:
        "USAGE: multi-angle EVIDENCE fanout on a SCOPED research question — not a general " +
        "deep-thinker, not a live-news wire, not an opinion panel. " +
        "BEST: multi-hop factual/regional/technical research that benefits from parallel " +
        "grounded sub-queries (e.g. industry+labor+tech+supply-chain in a region; " +
        "\"current FOMC rate range with official sources\"). Classifier often plans " +
        "leaner than max_legs when one answer suffices. " +
        "AVOID / ROUTE ELSEWHERE: " +
        "(1) pure or hot breaking-X sentiment → grok_x_search (faster, more reliable than " +
        "force_x_leg through fanout — X legs under load can timeout the whole call); " +
        "(2) strategy/opinion/tradeoff adjudication (\"Should we adopt trunk-based dev?\") → " +
        "ask_oracle or ask_panel; " +
        "(3) extreme vagueness (\"Tell me about AI\") → re-scope first or expect " +
        "timeout/shallow routing; " +
        "(4) trivial textbook constants (\"boiling point of water\") → may " +
        "grounding_miss fail-loud with degraded:true and no answer (by design, not a bug). " +
        "FLOW: decompose ≤max_legs → parallel provider-core legs (default gemini web-grounded; " +
        "optional grok_x / grok_grounded; no nested tools) → synth merges + citation union " +
        "OR synthesize:false returns raw legs. Legs fail independently; partial return + " +
        "degraded/slots_status. Hard ~85s outer budget; healthy complex runs often ~30–45s; " +
        "multi-leg = multi-call cost. lens/system = SYNTHESIS tone only (not routing). " +
        "Check route.elapsed_ms, legs[].status, citations[], degraded.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, { message: "prompt must not be empty" })
          .describe(
            "Scoped evidence-seeking research question. " +
              "Good: \"Challenges/opportunities for precision CNC in the East Bay " +
              "(labor, supply chain, AI/CAM, aerospace/medtech).\" " +
              "Good: \"Current US federal funds rate target range; cite official sources.\" " +
              "Bad/vague: \"Tell me about AI.\" " +
              "Use ask_oracle instead: \"Should we adopt trunk-based development?\" " +
              "Use grok_x_search instead: pure last-24h X reaction to a breaking event.",
          ),
        synthesize: z
          .boolean()
          .optional()
          .describe(
            "true (default) = one coherent answer + citation union; " +
              "false = raw legs only (inspect/decompose further yourself). " +
              "false is excellent for multi-hop dumps you will merge offline.",
          ),
        max_legs: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEGS_HARD)
          .optional()
          .describe(
            "Max sub-queries (default 4, hard cap 5). Factual single-answer prompts often " +
              "get fewer legs; multi-hop research may use the full cap.",
          ),
        lens: z
          .string()
          .optional()
          .describe(
            "Synthesis-only frame (e.g. steelman-then-break). Does NOT change leg routing " +
              "or grounding modes — only final answer structure/tone.",
          ),
        system: z
          .string()
          .optional()
          .describe("Extra system text for synthesis only (not leg generation)."),
        reasoning_effort: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Effort for grounded legs (default high)."),
        force_x_leg: z
          .boolean()
          .optional()
          .describe(
            "Ensure ≥1 live-X (grok_x) leg. Prefer false for pure breaking-news X " +
              "(use grok_x_search instead) — force_x_leg on hot topics can raise timeout risk " +
              "under load. Use true when research needs web + X in one fanout.",
          ),
      },
    },
    async (args: {
      prompt: string;
      synthesize?: boolean;
      max_legs?: number;
      lens?: string;
      system?: string;
      reasoning_effort?: "low" | "medium" | "high";
      force_x_leg?: boolean;
    }) => {
      const outerT0 = Date.now();
      const maxLegs = Math.min(MAX_LEGS_HARD, Math.max(1, args.max_legs ?? 4));
      const doSynth = args.synthesize !== false;
      const effort = args.reasoning_effort ?? "high";
      const qHash = hashQuestion(args.prompt);
      const phases = { decompose_ms: 0, legs_ms: 0, synth_ms: undefined as number | undefined };

      try {
        // --- decompose ---
        const decBudget = Math.min(DECOMPOSE_CAP_MS, remainingMs(outerT0, OUTER_BUDGET_MS));
        const decT0 = Date.now();
        let { plans, source } = await decompose(opts.openrouterApiKey, args.prompt, maxLegs, decBudget);
        plans = ensureForceX(plans, !!args.force_x_leg, maxLegs);
        phases.decompose_ms = Date.now() - decT0;

        // --- legs ---
        const legsT0 = Date.now();
        const legPhaseBudget = Math.min(LEG_PHASE_CAP_MS, remainingMs(outerT0, OUTER_BUDGET_MS));
        const settled = await mapLimitSettled(plans, CONCURRENCY, async (plan, i) => {
          const id = `leg-${i}`;
          const budget = seatBudgetMs(legsT0, legPhaseBudget, LEG_SEAT_CAP_MS);
          // Also respect outer wall
          const outerLeft = remainingMs(outerT0, OUTER_BUDGET_MS);
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

        const citations = dedupeCitations(legs.flatMap((l) => (l.status === "ok" ? l.citations : [])));
        const okCount = legs.filter((l) => l.status === "ok").length;
        let degraded = okCount < legs.length;
        let answer: string | undefined;

        if (doSynth && okCount > 0) {
          const synthT0 = Date.now();
          const synthBudget = Math.min(SYNTH_CAP_MS, remainingMs(outerT0, OUTER_BUDGET_MS));
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
            console.error(`[research_fanout] synth failed: ${(e as Error)?.message ?? e}`);
            // Partial: best leg text
            answer = legs
              .filter((l) => l.status === "ok")
              .map((l) => `## ${l.id}\n${l.answer}`)
              .join("\n\n");
          }
          phases.synth_ms = Date.now() - synthT0;
        } else if (doSynth && okCount === 0) {
          degraded = true;
        }

        const resp = {
          route: {
            tool: "research_fanout",
            decompose_source: source,
            max_legs: maxLegs,
            planned: plans,
            budget_ms: OUTER_BUDGET_MS,
            elapsed_ms: Date.now() - outerT0,
            phases,
          },
          legs,
          degraded,
          ...(answer != null ? { answer } : {}),
          citations,
          slots_status: `${okCount}/${legs.length} legs ok`,
        };

        return { content: [{ type: "text", text: JSON.stringify(resp, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `research_fanout failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

export { OUTER_BUDGET_MS, MAX_LEGS_HARD };
