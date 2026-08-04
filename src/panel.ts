/**
 * panel.ts — the `ask_panel` tool: the single entry point for asking any
 * model(s). Fires an array of query specs CONCURRENTLY and returns raw, labeled
 * responses in input order for the in-chat caller to synthesize. The win is
 * wall-clock: total latency is the slowest single spec, not the sum.
 *
 * A 1-element spec array is the single-query path (this tool replaced the old
 * standalone ask_grok / ask_gemini). Live-X is model:grok + grounded:true
 * (auto contract). OpenAI is OR-only (pinned Terra slug).
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
  type GeminiTransport,
} from "./geminiCore.js";
import { applyLens, buildLensParamDescription } from "./lenses.js";
import {
  classifyError,
  familyFromSlug,
  hashQuestion,
  isAttemptTimeoutError,
  recordSeatMetric,
} from "./metrics.js";
import { seatBudgetMs, withTimeout } from "./timeouts.js";
import { GPT_OPENROUTER_SLUG } from "./modelPins.js";

// Grounded gemini on OR can exceed the global 15s per-attempt abort (PK data hit
// exactly 15s and failed). Panel-only — ungrounded stays at OR_ATTEMPT_TIMEOUT_MS.
// On OR hang/abort we fail over to direct (same idea as ask_oracle) rather than
// burning the full 60s attempt with no recovery.
const PANEL_GROUNDED_OR_ATTEMPT_TIMEOUT_MS = 60_000;
// A1: outer wall-clock so one stuck grounded seat cannot hold the whole panel
// until client timeout discards siblings. Per-seat cap still applies via seatBudgetMs.
//
// Per-model seat caps sized to observed p99 (get_metrics, 14d): grok p99 ~78s,
// gemini grounded p99 ~96s. The old flat 60s cap pinned grounded-gemini p50 at
// exactly 60s (half the seats slamming the ceiling) AND made the OR→direct
// failover unreachable — a 60s OR attempt against a 70s outer left ~10s for the
// direct leg, so failover_fired stayed 0. Gemini's 100s cap leaves ~40s for the
// direct-failover leg after a 60s OR attempt, so recovery can actually fire.
const PANEL_GROK_SEAT_CAP_MS = 80_000;
const PANEL_GEMINI_SEAT_CAP_MS = 100_000;
// OpenAI via OR is usually faster than grounded gemini; keep headroom for OR stalls.
const PANEL_OPENAI_SEAT_CAP_MS = 80_000;
// Outer must fit the slowest per-model seat (gemini 100s) plus scheduling margin;
// seats run concurrently so this is ~max seat, not the sum.
const PANEL_OUTER_BUDGET_MS = 110_000;

type RegisterOpts = {
  xaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  openrouterApiKey: string | undefined;
  geminiTransport: GeminiTransport;
  xaiBaseUrl?: string;
};

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

  const specSchema = z.object({
    model: z
      .enum(["grok", "gemini", "openai"])
      .describe(
        "Backend for this spec. 'grok' (xAI, direct) — contrarian; grounded:true searches X " +
          "(+web if include_web). 'gemini' (Google) — strong reasoning + best live web grounding. " +
          "'openai' (OpenRouter only, pinned gpt-5.6-terra) — third-family voice; no native web/X " +
          "grounding (grounded:true errors).",
      ),
    prompt: z
      .string()
      .refine((s) => s.trim().length > 0, { message: "prompt must not be empty or whitespace-only" })
      .describe("The question/prompt for this model. For grounded specs, state the current date and ask for sources."),
    label: z
      .string()
      .optional()
      .describe("Short tag for this spec in the results array. Defaults to the model name. Give distinct labels when the same model appears more than once (e.g. 'grok-cold', 'grok-hot')."),
    grounded: z
      .boolean()
      .optional()
      .describe(
        "Back the answer with LIVE retrieval. For ANYTHING factual/current set true. " +
          "Gemini → Google Search; Grok → X (+web if include_web), auto mode (search only if needed). " +
          "openai → not supported (errors). Default false.",
      ),
    include_web: z
      .boolean()
      .optional()
      .describe("Grok + grounded only: also search the general web, not just X. Use for broad factual grounding (X alone is a social/breaking-news channel, not general retrieval)."),
    system: z
      .string()
      .optional()
      .describe("Optional system instruction for this spec — persona, tone, output format, constraints."),
    lens: z.string().optional().describe(buildLensParamDescription()),
    reasoning_effort: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("How hard the model thinks before answering (low|medium|high). Defaults to high for Gemini/Grok/OpenAI; all three levels are honored."),
    temperature: z
      .number()
      .optional()
      .describe("Sampling temperature. Omit for the model default. Vary across otherwise-identical specs to sample a spread of takes."),
    model_slug: z
      .string()
      .optional()
      .describe(
        "Advanced: override the exact model id (grok-*, gemini-*, or OpenRouter openai/* slug). " +
          "Omit unless you know the exact slug — server defaults are almost always right " +
          "(openai defaults to pinned Terra).",
      ),
  });

  server.registerTool(
    "ask_panel",
    {
      title: "Ask Panel (multi-model)",
      description:
        "HAND-PICK one or more models and get raw, labeled answers back for YOU to synthesize. " +
        "Specs run CONCURRENTLY (wall-clock ≈ slowest seat, not the sum). 1-spec = single call " +
        "(the way to ask Grok, Gemini, or OpenAI one question). Multi-spec = second opinions / " +
        "cross-family panel (e.g. grok + gemini + openai, or same model at two temps). " +
        "Each spec picks model ('grok'|'gemini'|'openai'), optional live grounding (gemini web / " +
        "grok X; openai cannot ground), lens, and temperature. Results stay in input order with " +
        "ok flags; one seat failing does NOT fail siblings. This tool GATHERS — it does not judge. " +
        "Auto-routing counterpart: ask_consortium (classifies and picks seats for you). " +
        "Live-X sentiment: model:'grok' grounded:true (citations when search fires). " +
        "Strategy/tradeoffs you want auto-routed → ask_consortium; multi-hop evidence → research_fanout.",
      inputSchema: {
        specs: z
          .array(specSchema)
          .min(1, "provide at least one spec")
          .max(8, "at most 8 specs per panel")
          .describe("The model queries to run concurrently. One spec = single query; multiple = parallel panel."),
      },
    },
    async ({ specs }: { specs: z.infer<typeof specSchema>[] }) => {
      const panelT0 = Date.now();
      const settled = await mapLimit(specs, CONCURRENCY, async (spec, idx) => {
        const t0 = Date.now();
        const label = spec.label ?? spec.model;
        const seatId = `panel-${idx}-${label}`;
        const qHash = hashQuestion(spec.prompt);
        const defaultTransport: "or" | "direct" =
          spec.model === "grok"
            ? "direct"
            : spec.model === "openai"
              ? "or"
              : geminiTransport === "openrouter"
                ? "or"
                : "direct";
        const defaultSlug =
          spec.model === "openai"
            ? spec.model_slug || GPT_OPENROUTER_SLUG
            : spec.model_slug || spec.model;
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
        }) => {
          if (recorded) return;
          recorded = true;
          void recordSeatMetric({
            ts: new Date().toISOString(),
            tool: "panel",
            route_mode: "panel",
            seat_id: seatId,
            family:
              spec.model === "grok"
                ? "grok"
                : spec.model === "openai"
                  ? "openai"
                  : familyFromSlug(extra.model_slug || defaultSlug),
            model_slug: extra.model_slug || defaultSlug,
            transport: extra.transport ?? defaultTransport,
            grounded_requested: !!spec.grounded,
            grounding_fired: ok && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            x_search_fired: ok && spec.model === "grok" && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            reasoning_effort: spec.reasoning_effort ?? "medium",
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
          });
        };

        const seatCap =
          spec.model === "grok"
            ? PANEL_GROK_SEAT_CAP_MS
            : spec.model === "openai"
              ? PANEL_OPENAI_SEAT_CAP_MS
              : PANEL_GEMINI_SEAT_CAP_MS;
        const budget = seatBudgetMs(panelT0, PANEL_OUTER_BUDGET_MS, seatCap);
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

          if (spec.model === "grok") {
            const grounding: Grounding = spec.grounded ? "auto" : "off";
            try {
              const r = await callGrok(
                opts.xaiApiKey,
                spec.prompt,
                {
                  system,
                  model: spec.model_slug,
                  reasoning_effort: spec.reasoning_effort,
                  temperature: spec.temperature,
                  grounding,
                  include_web: spec.include_web,
                },
                xaiBaseUrl,
              );
              record(true, { text: r.text, citations: r.citations, transport: "direct" });
              return { text: r.text, citations: r.citations };
            } catch (e) {
              const msg = (e as Error)?.message ?? String(e);
              record(false, {
                error: msg,
                transport: "direct",
                timed_out: isAttemptTimeoutError(msg),
              });
              throw e;
            }
          }

          if (spec.model === "openai") {
            if (spec.grounded) {
              const msg =
                "openai seat has no native web/X grounding — use model:'gemini' grounded:true " +
                "(web) or model:'grok' grounded:true (X), or drop grounded for weights-only.";
              record(false, { error: msg, transport: "or", model_slug: defaultSlug });
              throw new Error(msg);
            }
            try {
              const r = await callOpenRouter(opts.openrouterApiKey, defaultSlug, spec.prompt, {
                system,
                reasoning_effort: spec.reasoning_effort,
                temperature: spec.temperature,
              });
              record(true, {
                text: r.text,
                citations: r.citations,
                transport: "or",
                model_slug: defaultSlug,
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
            model: spec.model_slug,
            grounded: spec.grounded,
            reasoning_effort: spec.reasoning_effort,
            temperature: spec.temperature,
            ...(spec.grounded && geminiTransport === "openrouter"
              ? { attempt_timeout_ms: PANEL_GROUNDED_OR_ATTEMPT_TIMEOUT_MS }
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
            once: () => Promise<{ text: string; citations: string[] }>,
            pathLabel: string,
          ) => {
            let r = await once();
            if (spec.grounded) {
              for (let attempt = 1; attempt <= MAX_GROUNDING_RETRIES && r.citations.length === 0; attempt++) {
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
            let r: { text: string; citations: string[] };

            if (geminiTransport === "openrouter") {
              try {
                r = await runWithGroundingContract(callOrOnce, "or-native");
              } catch (e) {
                // Grounding miss is NOT transient — fail loud, do not failover-mask.
                const msg = (e as Error)?.message ?? String(e);
                if (msg.includes("grounding_fired:false") || !isTransientError(e)) throw e;
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

            record(true, { text: r.text, citations: r.citations, transport, failover_fired });
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
          record(false, { error: msg, transport: defaultTransport, timed_out: timedOut });
          throw e;
        }
      });

      const results = settled.map((r, i) => {
        const label = specs[i].label ?? specs[i].model;
        if (r.status === "fulfilled") {
          const out: Record<string, unknown> = { label, ok: true, text: r.value.text };
          if (r.value.citations?.length) out.citations = r.value.citations;
          if (r.value.failover_fired) out.failover_fired = true;
          if (r.value.transport) out.transport = r.value.transport;
          return out;
        }
        return { label, ok: false, error: String(r.reason?.message ?? r.reason) };
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

      const body = recovery_note ? { recovery_note, results } : results;
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    },
  );
}
