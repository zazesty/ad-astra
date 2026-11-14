/**
 * panel.ts — the `ask_panel` tool: the single entry point for asking any
 * model(s). Named specs run CONCURRENTLY and return raw, labeled responses.
 * Omit specs and the same tool auto-fills families (the old ask_consortium).
 *
 * A 1-element spec array is the single-query path (this tool replaced the old
 * standalone ask_grok / ask_gemini). Live-X is model:grok + grounded:true
 * (auto contract). OpenAI + Claude (sonnet) are OR-only (pinned slugs).
 *
 * One spec failing must not nuke the others — we use an allSettled-style runner
 * (mapLimit) with a small concurrency cap so large batches don't trip
 * per-provider rate limits. Traffic flows through callGrok / callGemini /
 * callOpenRouter (no duplicated request logic).
 */

import { z } from "zod";
import { callGrok, type Grounding } from "./grokCore.js";
import {
  callGemini,
  callGeminiViaOpenRouter,
  callOpenRouter,
  isTransientError,
  makeGeminiClient,
  type GeminiClient,
  type GeminiResult,
  type GeminiTransport,
} from "./geminiCore.js";
import { applyLens, buildLensMenu, buildLensParamDescription } from "./lenses.js";
import { judgeLabeledAnswers, runOracle, type FusionPreset } from "./oracleEngine.js";
import {
  classifyError,
  familyFromSlug,
  hashQuestion,
  isAttemptTimeoutError,
  loggedReasoningEffort,
  recordSeatMetric,
} from "./metrics.js";
import { canStartAttempt, capAttemptMs, remainingMs, seatBudgetMs, withTimeout } from "./timeouts.js";
import {
  CLAUDE_OPUS_OPENROUTER_SLUG,
  CLAUDE_SONNET_OPENROUTER_SLUG,
  GPT_OPENROUTER_SLUG,
} from "./modelPins.js";
import { CLI_BUDGET, type BudgetProfile, type CallerFamily } from "./budgetProfile.js";

// Per-attempt OpenRouter abort for ALL panel OR seats (grounded + ungrounded).
// History: default OR_ATTEMPT_TIMEOUT_MS=15s was a hang detector sized for short
// classifier/news calls. Live metrics 2026-08: ungrounded panel claude/openai
// timed out on ~75–88% of seats at exactly 15s; the few successes finished
// ≤14.3s (right-censored). Direct ungrounded answers routinely take 25–55s.
// 60s matches the prior grounded-panel bump and still leaves headroom under
// per-model seat caps (claude/openai 80s, gemini 100s) for OR→direct failover.
// On OR hang/abort gemini fails over to direct rather than burning the full seat.
// Seat / OR attempt caps live on BudgetProfile (cli = 2026-08 numbers; chat = 50s envelope).

/** OR-only panel families with no native web/X grounding. */
function isOrOnlyWeightsModel(model: string): boolean {
  return model === "sol" || model === "opus" || model === "sonnet";
}

function defaultOrSlug(model: string, modelSlug?: string): string {
  if (modelSlug) return modelSlug;
  if (model === "sol") return GPT_OPENROUTER_SLUG;
  if (model === "opus") return CLAUDE_OPUS_OPENROUTER_SLUG;
  if (model === "sonnet") return CLAUDE_SONNET_OPENROUTER_SLUG;
  return model;
}

function familyForSpec(model: string, slug: string): string {
  if (model === "grok") return "grok";
  // Public token is sol. Seat rows stay family openai so the log does not split.
  if (model === "sol") return "openai";
  if (model === "opus" || model === "sonnet") return "claude";
  return familyFromSlug(slug);
}
type RegisterOpts = {
  xaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  openrouterApiKey: string | undefined;
  geminiTransport: GeminiTransport;
  xaiBaseUrl?: string;
  budget?: BudgetProfile;
  callerFamily?: CallerFamily;
};

/** Public enum is argon and sol. Stale gemini and openai tokens still run those seats. */
export function normalizePanelModel(model: unknown): unknown {
  if (model === "gemini") return "argon";
  if (model === "openai") return "sol";
  return model;
}

/** Opus is gone from the schema. A stale caller, or an opus model_slug, still runs sonnet. */
export function applyOpusRemap(spec: { model: string; model_slug?: string }): {
  model: string;
  model_slug?: string;
  remapped_from?: "opus";
} {
  const slugIsOpus = !!spec.model_slug && /opus/i.test(spec.model_slug);
  if (spec.model !== "opus" && !(spec.model === "sonnet" && slugIsOpus)) {
    return { model: spec.model, model_slug: spec.model_slug };
  }
  const keepSlug = spec.model_slug && !/opus/i.test(spec.model_slug) ? spec.model_slug : undefined;
  return { model: "sonnet", model_slug: keepSlug, remapped_from: "opus" };
}

// Concurrency cap: at N=2-3 it's a no-op; it only bites if a spec list grows
// large enough to threaten per-provider rate/concurrency limits.
const CONCURRENCY = 5;

/** allSettled semantics WITH a concurrency cap, preserving input order. */
async function mapLimit<T, R>(
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
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export function registerAskPanel(server: any, opts: RegisterOpts) {
  const geminiClient: GeminiClient | null = makeGeminiClient(opts.geminiApiKey);
  const xaiBaseUrl = opts.xaiBaseUrl;
  const geminiTransport = opts.geminiTransport;
  const budgetProfile = opts.budget ?? CLI_BUDGET;

  const specSchema = z.object({
    model: z.preprocess(
      normalizePanelModel,
      z
        .enum(["grok", "argon", "sol", "sonnet"])
        .describe(
          "Backend: 'grok' (xAI direct, grok-4.7; contrarian, live X when grounded); 'argon' (Gemini 4 Argon; " +
          "reasoning/live web); 'sol' (OpenRouter, GPT Sol latest); 'sonnet' (Sonnet latest, medium). Grok can add web " +
          "with include_web. sol/sonnet have no native web/X grounding: grounded:true errors.",
        ),
    ),
    prompt: z
      .string()
      .refine((s) => s.trim().length > 0, { message: "prompt must not be empty or whitespace-only" })
      .optional()
      .describe("Override the shared question for this seat. If grounded, state the current date and ask for sources. Omit to " +
          "use prompt."),
    label: z
      .string()
      .optional()
      .describe("Result label; defaults to model name. Use distinct labels for repeated models, e.g. 'grok-cold' and " +
          "'grok-hot'."),
    grounded: z
      .boolean()
      .optional()
      .describe(
        "Set true for factual/current questions to use live retrieval. Argon uses Google Search; Grok uses X (+web " +
          "with include_web), in auto mode (search if needed). sol/sonnet error if true. Default false.",
      ),
    include_web: z
      .boolean()
      .optional()
      .describe("Grok + grounded only: also search the general web. Use for broad factual retrieval; X alone covers " +
          "social/breaking news."),
    system: z
      .string()
      .optional()
      .describe("Per-seat system instruction: persona, tone, format or constraints. Overrides top-level system for this seat."),
    lens: z.string().optional().describe("Per-seat frame; choices are in top-level lens. Omit to inherit top-level lens; if neither is set, use " +
          "'default' unless a custom system is supplied. 'none' disables framing. Lens body precedes system text."),
    model_slug: z
      .string()
      .optional()
      .describe(
        "Advanced exact model-id override (grok-*, gemini-*, OpenRouter openai/* or anthropic/*). Omit unless known: " +
          "defaults are GPT Sol latest, Sonnet latest and Gemini 4 Argon for sol/sonnet/argon.",
      ),
  });

  server.registerTool(
    "ask_panel",
    {
      title: "Ask Panel (multi-model)",
      description:
        "Ask one question across models for independent answers, opinions or tradeoffs; use research_fanout for " +
          "multi-hop evidence. Omit specs to let the classifier select 1–4 frontier seats, with caller-family avoidance " +
          "in the reasoning pool: Grok, Sonnet, Argon and Sol, with openrouter/auto-beta as overflow. min_perspectives " +
          "requests up to 8; above four repeats the same four families. Or supply nonempty specs to name models; each " +
          "answers the shared prompt unless overridden by its spec. Named specs cannot be combined with " +
          "min_perspectives, force_grounding, engine or fusion_preset. Default: raw labeled answers for you to " +
          "synthesize; synthesize:true merges them. Live X: model:'grok', grounded:true. Auto-path web grounding: " +
          "force_grounding or classifier selection for live facts. engine:'fusion' is a slower contested-question " +
          "escalation, available only when specs is omitted. Effort and temperature are not caller knobs. See " +
          "system/lens fields for instruction precedence. Required retrieval seats and the auto-beta wildcard may still " +
          "match the caller family.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, { message: "prompt must not be empty or whitespace-only" })
          .describe("Shared question; required. A spec prompt overrides it for that seat."),
        specs: z
          .array(specSchema)
          .max(8, "at most 8 specs per panel")
          .optional()
          .describe("Named model seats (1–8), or omit for auto-fill. Each answers prompt unless its spec overrides it. An empty " +
          "array fails."),
        synthesize: z
          .boolean()
          .optional()
          .describe("true: one merged answer, judged by gemini-4-argon. Default false: raw labeled answers. research_fanout " +
          "defaults to true."),
        system: z
          .string()
          .optional()
          .describe("Extra system instruction on every seat; a spec system overrides it for that seat. Composes after the lens " +
          "body."),
        min_perspectives: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Auto path only: at least this many perspectives (1–8). Omit for classifier choice, at most 4. Above 4 " +
          "repeats families; classifier may exceed the requested floor."),
        lens: z
          .string()
          .optional()
          .describe(
            "Analytical frame. Auto path: classifier chooses unless set (or 'none'). Named panel: fills specs without " +
          "their own lens. Lens body precedes system text. Choose one: " +
          buildLensMenu() +
          ".",
          ),
        force_grounding: z
          .boolean()
          .optional()
          .describe("Auto path only: add a web-grounded Gemini/Google Search seat that errors when no citations return."),
        engine: z
          .enum(["fusion"])
          .optional()
          .describe(
            "Auto path only: 'fusion' escalates a contested question by replacing the reasoning pool with one OpenRouter " +
          "Fusion seat.",
          ),
        fusion_preset: z
          .enum(["general-budget", "general-high", "general-fast"])
          .optional()
          .describe("Fusion tier; default general-budget. Ignored unless engine is fusion. general-fast is a latency preset, not " +
          "Sol service tier."),
      },
    },
    async (args: {
      prompt: string;
      specs?: z.infer<typeof specSchema>[];
      synthesize?: boolean;
      system?: string;
      min_perspectives?: number;
      lens?: string;
      force_grounding?: boolean;
      engine?: "fusion";
      fusion_preset?: FusionPreset;
    }) => {
      const named = !!args.specs && args.specs.length > 0;
      if (args.specs && args.specs.length === 0) {
        return {
          content: [{ type: "text", text: "ask_panel: omit specs to auto-fill, or name at least one model." }],
          isError: true,
        };
      }
      if (named && (args.min_perspectives != null || args.force_grounding != null || args.engine != null || args.fusion_preset != null)) {
        return {
          content: [{
            type: "text",
            text: "ask_panel: name the models in specs, or leave specs empty to auto-fill. Do not combine specs with min_perspectives, force_grounding, engine, or fusion_preset.",
          }],
          isError: true,
        };
      }
      if (!named) {
        try {
          const result = await runOracle(
            {
              xaiApiKey: opts.xaiApiKey,
              geminiApiKey: opts.geminiApiKey,
              openrouterApiKey: opts.openrouterApiKey,
              xaiBaseUrl: opts.xaiBaseUrl,
              budget: budgetProfile,
            },
            args.prompt,
            {
              synthesize: args.synthesize,
              system: args.system,
              min_perspectives: args.min_perspectives,
              lens: args.lens,
              force_grounding: args.force_grounding,
              engine: args.engine,
              fusion_preset: args.fusion_preset,
              caller_family: opts.callerFamily,
            },
          );
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `ask_panel failed: ${(err as Error).message}` }], isError: true };
        }
      }
      const specs = args.specs!.map((spec) => ({
        ...spec,
        prompt: spec.prompt?.trim() ? spec.prompt : args.prompt,
        system: spec.system ?? args.system,
        lens: spec.lens ?? args.lens,
      }));
      const panelT0 = Date.now();
      const outerMs = budgetProfile.panelOuterMs;
      const settled = await mapLimit(specs, CONCURRENCY, async (spec, idx) => {
        const t0 = Date.now();
        const label = spec.label ?? spec.model;
        const seatId = `panel-${idx}-${label}`;
        const qHash = hashQuestion(spec.prompt);
        const remapped = applyOpusRemap(spec);
        const model = remapped.model;
        const modelSlug = remapped.model_slug;
        if (remapped.remapped_from) {
          console.error(`[ask_panel] remapped opus → sonnet label=${label}`);
        }
        const defaultTransport: "or" | "direct" =
          model === "grok"
            ? "direct"
            : isOrOnlyWeightsModel(model)
              ? "or"
              : geminiTransport === "openrouter"
                ? "or"
                : "direct";
        const defaultSlug = defaultOrSlug(model, modelSlug);
        // Single record path for the whole seat (incl. applyLens failures — B2).
        // degraded is per-seat (ok===false), not run-level (B1).
        let recorded = false;
        const record = (ok: boolean, extra: {
          text?: string;
          citations?: string[];
          error?: string;
          transport?: "or" | "direct";
          timed_out?: boolean;
          failover_fired?: boolean;
          model_slug?: string;
          served_tier?: string;
          reasoning_effort?: string | null;
        }) => {
          if (recorded) return;
          recorded = true;
          void recordSeatMetric({
            ts: new Date().toISOString(),
            tool: "panel",
            route_mode: "panel",
            seat_id: seatId,
            family: familyForSpec(model, extra.model_slug || defaultSlug),
            model_slug: extra.model_slug || defaultSlug,
            transport: extra.transport ?? defaultTransport,
            grounded_requested: !!spec.grounded,
            grounding_fired: ok && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            x_search_fired: ok && model === "grok" && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            reasoning_effort: loggedReasoningEffort(extra.model_slug || defaultSlug, extra.reasoning_effort),
            latency_ms: Date.now() - t0,
            failover_fired: !!extra.failover_fired,
            timed_out: !!extra.timed_out || isAttemptTimeoutError(extra.error),
            ok,
            degraded: !ok,
            error_class: classifyError(
              ok ? "ok" : extra.timed_out || isAttemptTimeoutError(extra.error) ? "timeout" : "error",
              extra.error,
            ),
            question_hash: qHash,
            prompt_preview: process.env.METRICS_LOG_PROMPTS === "1" ? spec.prompt : undefined,
            served_tier: extra.served_tier,
          });
        };

        const seatCap =
          model === "grok"
            ? budgetProfile.panelGrokSeatMs
            : isOrOnlyWeightsModel(model)
              ? (model === "sol" ? budgetProfile.panelOpenaiSeatMs : budgetProfile.panelClaudeSeatMs)
              : budgetProfile.panelGeminiSeatMs;
        const budget = seatBudgetMs(panelT0, outerMs, seatCap);
        if (budget < 500) {
          const msg = `${seatId} timed out after 0ms (panel outer budget exhausted)`;
          record(false, { error: msg, transport: defaultTransport, timed_out: true });
          throw new Error(msg);
        }

        // Outer try wraps applyLens + provider call so lens-config failures are
        // visible to metrics (B2). Provider paths record success/failure; outer
        // catch is a safety net (lens errors, unexpected throws).
        // A1: whole seat raced against remaining outer budget so siblings can return.
        const runSeat = async () => {
        try {
          // Resolve lens → effective system per spec (default second-opinion frame
          // auto-applies when neither lens nor system is given; pass lens:"none" to opt out).
          const { system, error } = applyLens(spec.lens, spec.system);
          if (error) throw new Error(error);

          if (model === "grok") {
            const grounding: Grounding = spec.grounded ? "auto" : "off";
            try {
              const r = await callGrok(
                opts.xaiApiKey,
                spec.prompt,
                {
                  system,
                  model: modelSlug,
                  grounding,
                  include_web: spec.include_web,
                  reasoning_effort: "medium",
                },
                xaiBaseUrl,
              );
              record(true, { text: r.text, citations: r.citations, transport: "direct", reasoning_effort: "medium" });
              return { text: r.text, citations: r.citations };
            } catch (e) {
              const msg = (e as Error)?.message ?? String(e);
              record(false, {
                error: msg,
                transport: "direct",
                timed_out: isAttemptTimeoutError(msg),
                reasoning_effort: "medium",
              });
              throw e;
            }
          }

          // sol / opus / sonnet — OpenRouter weights-only (no native web/X plugin).
          if (isOrOnlyWeightsModel(model)) {
            if (spec.grounded) {
              const msg =
                `${model} seat has no native web/X grounding — use model:'argon' grounded:true ` +
                "(web) or model:'grok' grounded:true (X), or drop grounded for weights-only.";
              record(false, { error: msg, transport: "or", model_slug: defaultSlug });
              throw new Error(msg);
            }
            try {
              const r = await callOpenRouter(opts.openrouterApiKey, defaultSlug, spec.prompt, {
                system,
                attempt_timeout_ms: capAttemptMs(t0, budget, budgetProfile.panelOrAttemptMs),
              });
              record(true, {
                text: r.text,
                citations: r.citations,
                transport: "or",
                model_slug: defaultSlug,
                served_tier: r.service_tier,
              });
              return { text: r.text, citations: r.citations, transport: "or" as const };
            } catch (e) {
              const msg = (e as Error)?.message ?? String(e);
              record(false, {
                error: msg,
                transport: "or",
                timed_out: isAttemptTimeoutError(msg),
                model_slug: defaultSlug,
              });
              throw e;
            }
          }

          // gemini — transport chosen by GEMINI_TRANSPORT (env). The OpenRouter
          // path (BYOK) handles both ungrounded and grounded specs; grounded forces
          // engine:"native" inside callGeminiViaOpenRouter (real Google grounding).
          // On OR hang/transient: fail over to direct SDK (kaizen #3, mirrors oracle).
          const geminiOpts = {
            system,
            model: modelSlug,
            grounded: spec.grounded,
            // Always pass the panel OR attempt budget when OR is the transport
            // (ungrounded used to inherit global 15s and mass-timeout).
            ...(geminiTransport === "openrouter"
              ? { attempt_timeout_ms: capAttemptMs(t0, budget, budgetProfile.panelOrAttemptMs) }
              : {}),
          };
          const callOrOnce = () =>
            callGeminiViaOpenRouter(opts.openrouterApiKey, spec.prompt, geminiOpts);
          const callDirectOnce = () => callGemini(geminiClient, spec.prompt, geminiOpts);

          // FAIL LOUD, not soft. Gemini grounding (googleSearch / engine:"native")
          // is model-discretion: the model decides whether to search, so a grounded
          // spec can come back weights-only with ZERO citations — a clean answer
          // indistinguishable from a real grounded one. That's the dangerous case
          // (e.g. the journaling routine then "answers" recent events from stale
          // weights). So when grounding was REQUESTED but no citations came back,
          // retry; if still ungrounded after the budget, throw rather than return
          // the sourceless answer. ask_panel's allSettled turns this into ok:false
          // with the message below, so the caller sees grounding_fired:false.
          // (Mirrors grokCore's applyGroundingContract for the "required" contract.)
          //
          // Budget = 2 retries (3 attempts). A/B test 2026-06-19 (n=50/arm): the
          // openrouter(native) per-call miss rate is ~8% and independent, so 2
          // retries drive the effective miss to ~0.08^3 ≈ 0.05% while keeping the
          // ~2.5s happy path (only the ~8% that miss pay ~+2.5s each). The direct
          // (AI Studio) transport misses 0% but is ~5x slower (p50 12.8s, p90 22s)
          // AND had a 4% hard-500 rate — so retry-on-openrouter beats switching the
          // default. Enforced grounding is NOT an option: AI Studio rejects
          // google_search_retrieval on gemini-3.1-pro (the always-execute retrieval
          // tool is Vertex-only), so both transports are inherently AUTO.
          const MAX_GROUNDING_RETRIES = 2;

          /** Run one transport with the zero-citation fail-loud retry contract. */
          const runWithGroundingContract = async (
            once: () => Promise<GeminiResult>,
            pathLabel: string,
          ) => {
            let r = await once();
            if (spec.grounded) {
              for (let attempt = 1; attempt <= MAX_GROUNDING_RETRIES && r.citations.length === 0; attempt++) {
                if (!canStartAttempt(t0, budget)) {
                  console.error(
                    `[ask_panel] skip grounding retry, ${remainingMs(t0, budget)}ms left. label=${label} path=${pathLabel}`,
                  );
                  break;
                }
                console.error(
                  `[ask_panel] gemini grounded miss (0 citations) — retry ${attempt}/${MAX_GROUNDING_RETRIES}. label=${label} path=${pathLabel}`,
                );
                r = await once();
              }
              if (r.citations.length === 0) {
                throw new Error(
                  `grounding_fired:false — Gemini grounded request returned zero citations after ` +
                    `${MAX_GROUNDING_RETRIES} retries (${pathLabel}). Refusing to pass back a weights-only answer as if ` +
                    `it were grounded; the answer may be stale/hallucinated. Retry, rephrase to demand ` +
                    `sources, or use a grok spec.`,
                );
              }
            }
            return r;
          };

          try {
            let transport: "or" | "direct" = geminiTransport === "openrouter" ? "or" : "direct";
            let failover_fired = false;
            let r: GeminiResult;

            if (geminiTransport === "openrouter") {
              try {
                r = await runWithGroundingContract(callOrOnce, "or-native");
              } catch (e) {
                // Grounding miss is NOT transient — fail loud, do not failover-mask.
                const msg = (e as Error)?.message ?? String(e);
                if (msg.includes("grounding_fired:false") || !isTransientError(e)) throw e;
                if (!canStartAttempt(t0, budget)) {
                  console.error(
                    `[ask_panel] skip OR→direct failover, ${remainingMs(t0, budget)}ms left. label=${label}`,
                  );
                  throw e;
                }
                console.error(
                  `[ask_panel] OR transient fail on ${label} — failover → direct-gemini: ${msg}`,
                );
                r = await runWithGroundingContract(callDirectOnce, "direct-failover");
                transport = "direct";
                failover_fired = true;
              }
            } else {
              r = await runWithGroundingContract(callDirectOnce, "direct");
            }

            record(true, { text: r.text, citations: r.citations, transport, failover_fired, served_tier: r.service_tier });
            return { text: r.text, citations: r.citations, failover_fired, transport };
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            const timedOut = isAttemptTimeoutError(msg);
            record(false, {
              error: msg,
              transport: geminiTransport === "openrouter" ? "or" : "direct",
              timed_out: timedOut,
            });
            throw e;
          }
        } catch (e) {
          // Safety net: applyLens / unexpected throws before provider record().
          const msg = (e as Error)?.message ?? String(e);
          record(false, {
            error: msg,
            transport: defaultTransport,
            timed_out: isAttemptTimeoutError(msg),
          });
          throw e;
        }
        };

        try {
          return await withTimeout(runSeat(), budget, seatId);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          const timedOut = isAttemptTimeoutError(msg);
          record(false, { error: msg, transport: defaultTransport, timed_out: timedOut, reasoning_effort: model === "grok" ? "medium" : undefined });
          throw e;
        }
      });

      const results = settled.map((r, i) => {
        const label = specs[i].label ?? specs[i].model;
        const remapped_from = applyOpusRemap(specs[i]).remapped_from;
        if (r.status === "fulfilled") {
          const out: Record<string, unknown> = { label, ok: true, text: r.value.text };
          if (r.value.citations?.length) out.citations = r.value.citations;
          if (r.value.failover_fired) out.failover_fired = true;
          if (r.value.transport) out.transport = r.value.transport;
          if (remapped_from) out.remapped_from = remapped_from;
          return out;
        }
        const fail: Record<string, unknown> = { label, ok: false, error: String(r.reason?.message ?? r.reason) };
        if (remapped_from) fail.remapped_from = remapped_from;
        return fail;
      });

      // Kaizen #4 (panel): surface OR hang recovery when siblings still answered.
      // Happy path stays a bare array (backward compatible). Only wrap when a note
      // is worth calling out so parsers that expect `[{label,ok,text}]` still work
      // on clean runs.
      const anyOk = results.some((r) => r.ok);
      const anyFail = results.some((r) => !r.ok);
      const failLooksLikeOrHang = results.some(
        (r) =>
          !r.ok &&
          typeof r.error === "string" &&
          (isAttemptTimeoutError(r.error) || /openrouter|aborted|timeout/i.test(r.error)),
      );
      const anyFailover = results.some((r) => r.ok && r.failover_fired);
      let recovery_note: string | undefined;
      if (anyOk && anyFail && failLooksLikeOrHang) {
        recovery_note =
          "Some seats stalled (often OpenRouter abort/timeout); others recovered. Partial panel — synthesize from ok seats.";
      } else if (anyFailover) {
        recovery_note =
          "OpenRouter stalled on at least one Gemini seat; direct-gemini failover recovered.";
      }

      if (args.synthesize) {
        const oks = results.filter((r) => r.ok === true && typeof r.text === "string");
        if (oks.length > 0) {
          try {
            const answer = await judgeLabeledAnswers(
              {
                xaiApiKey: opts.xaiApiKey,
                geminiApiKey: opts.geminiApiKey,
                openrouterApiKey: opts.openrouterApiKey,
                xaiBaseUrl: opts.xaiBaseUrl,
                budget: budgetProfile,
              },
              oks.map((r) => ({
                id: String(r.label),
                text: r.text as string,
                citations: Array.isArray(r.citations) ? r.citations.filter((c): c is string => typeof c === "string") : undefined,
              })),
              { startedAt: panelT0, outerMs: budgetProfile.panelOuterMs },
            );
            const body = recovery_note ? { recovery_note, answer } : { answer };
            return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
          } catch (err) {
            const body = {
              judge_error: (err as Error).message,
              ...(recovery_note ? { recovery_note } : {}),
              results,
            };
            return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
          }
        }
      }

      const body = recovery_note ? { recovery_note, results } : results;
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    },
  );
}
