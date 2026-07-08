/**
 * panel.ts — the `ask_panel` tool: the single entry point for asking any
 * model(s). Fires an array of query specs CONCURRENTLY and returns raw, labeled
 * responses in input order for the in-chat caller to synthesize. The win is
 * wall-clock: total latency is the slowest single spec, not the sum.
 *
 * A 1-element spec array is the single-query path (this tool replaced the old
 * standalone ask_grok / ask_gemini). grok_x_search stays its own dedicated tool
 * (distinct citations contract + billing profile).
 *
 * One spec failing must not nuke the others — we use an allSettled-style runner
 * (mapLimit) with a small concurrency cap so large batches don't trip
 * per-provider rate limits. All Grok/Gemini traffic flows through the shared
 * callGrok / callGemini cores (no duplicated request logic).
 */

import { z } from "zod";
import { callGrok, type Grounding } from "./grokCore.js";
import {
  callGemini,
  callGeminiViaOpenRouter,
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

// Grounded gemini on OR can exceed the global 15s per-attempt abort (PK data hit
// exactly 15s and failed). Panel-only — ungrounded stays at OR_ATTEMPT_TIMEOUT_MS.
const PANEL_GROUNDED_OR_ATTEMPT_TIMEOUT_MS = 60_000;

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
      .enum(["grok", "gemini"])
      .describe("Which model backend answers this spec. 'grok' (xAI) leans contrarian/independent; 'gemini' (Google) is strong at reasoning and has the best live web grounding."),
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
      .describe("Back the answer with LIVE web search. For ANYTHING factual/current (news, prices, stats, people, 'latest' events, or facts past training cutoff) set true. Gemini → Google Search; Grok → searches X (+web if include_web). Grok grounds in 'auto' mode (it decides whether to search; a search is billed only if it actually runs). Default false."),
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
      .describe("How hard the model thinks before answering (low|medium|high). Defaults to high for both Gemini and Grok (Grok grounded or ungrounded); all three levels are honored."),
    temperature: z
      .number()
      .optional()
      .describe("Sampling temperature. Omit for the model default. Vary across otherwise-identical specs to sample a spread of takes."),
    model_slug: z
      .string()
      .optional()
      .describe("Advanced: override the exact model id with a specific grok-*/gemini-* slug (e.g. a flash/mini variant for cheap fast calls). Omit unless you know the exact slug — the server default for the chosen backend is the right choice almost always."),
  });

  server.registerTool(
    "ask_panel",
    {
      title: "Ask Panel (multi-model)",
      description:
        "Ask one or more models and get their raw, labeled answers back for YOU to synthesize. " +
        "Pass an array of specs; they run CONCURRENTLY, so asking 3 models costs the wall-clock of " +
        "the slowest one, not the sum. Use a 1-spec array for a single model (this is the way to ask " +
        "Grok or Gemini one question). Use multiple specs for a second opinion / contrarian check / " +
        "cross-model panel — e.g. one Grok + one Gemini, or the same model at two temperatures. " +
        "Each spec independently picks the backend ('grok'|'gemini'), whether to ground on live web " +
        "search, a lens, and a temperature. Results come back in input order, each tagged with its label and an " +
        "ok flag; one spec failing does NOT fail the others. This is the HAND-PICK tool — you name the exact " +
        "members (model + prompt + grounding + lens + temperature each); ask_oracle is the auto-routing " +
        "counterpart that picks the panel for you. This tool gathers — it does not judge; " +
        "synthesis is your job. (For a citations-first live X search with a no-results-is-an-error " +
        "contract, use grok_x_search instead.)",
      inputSchema: {
        specs: z
          .array(specSchema)
          .min(1, "provide at least one spec")
          .max(8, "at most 8 specs per panel")
          .describe("The model queries to run concurrently. One spec = single query; multiple = parallel panel."),
      },
    },
    async ({ specs }: { specs: z.infer<typeof specSchema>[] }) => {
      const settled = await mapLimit(specs, CONCURRENCY, async (spec, idx) => {
        const t0 = Date.now();
        const label = spec.label ?? spec.model;
        const seatId = `panel-${idx}-${label}`;
        const qHash = hashQuestion(spec.prompt);
        const defaultTransport: "or" | "direct" =
          spec.model === "grok" ? "direct" : geminiTransport === "openrouter" ? "or" : "direct";
        // Single record path for the whole seat (incl. applyLens failures — B2).
        // degraded is per-seat (ok===false), not run-level (B1).
        let recorded = false;
        const record = (ok: boolean, extra: {
          text?: string;
          citations?: string[];
          error?: string;
          transport?: "or" | "direct";
          timed_out?: boolean;
        }) => {
          if (recorded) return;
          recorded = true;
          void recordSeatMetric({
            ts: new Date().toISOString(),
            tool: "panel",
            route_mode: "panel",
            seat_id: seatId,
            family: spec.model === "grok" ? "grok" : familyFromSlug(spec.model_slug || "gemini"),
            model_slug: spec.model_slug || spec.model,
            transport: extra.transport ?? defaultTransport,
            grounded_requested: !!spec.grounded,
            grounding_fired: ok && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            x_search_fired: ok && spec.model === "grok" && !!spec.grounded && (extra.citations?.length ?? 0) > 0,
            reasoning_effort: spec.reasoning_effort ?? "medium",
            latency_ms: Date.now() - t0,
            failover_fired: false,
            timed_out: !!extra.timed_out,
            ok,
            degraded: !ok,
            error_class: classifyError(ok ? "ok" : extra.timed_out ? "timeout" : "error", extra.error),
            question_hash: qHash,
            prompt_preview: process.env.METRICS_LOG_PROMPTS === "1" ? spec.prompt : undefined,
          });
        };

        // Outer try wraps applyLens + provider call so lens-config failures are
        // visible to metrics (B2). Provider paths record success/failure; outer
        // catch is a safety net (lens errors, unexpected throws).
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
          // gemini — transport chosen by GEMINI_TRANSPORT (env). The OpenRouter
          // path (BYOK) handles both ungrounded and grounded specs; grounded forces
          // engine:"native" inside callGeminiViaOpenRouter (real Google grounding).
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
          const callGeminiOnce = () =>
            geminiTransport === "openrouter"
              ? callGeminiViaOpenRouter(opts.openrouterApiKey, spec.prompt, geminiOpts)
              : callGemini(geminiClient, spec.prompt, geminiOpts);

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
          const transport: "or" | "direct" = geminiTransport === "openrouter" ? "or" : "direct";
          try {
            let r = await callGeminiOnce();
            if (spec.grounded) {
              for (let attempt = 1; attempt <= MAX_GROUNDING_RETRIES && r.citations.length === 0; attempt++) {
                console.error(`[ask_panel] gemini grounded miss (0 citations) — retry ${attempt}/${MAX_GROUNDING_RETRIES}. label=${label}`);
                r = await callGeminiOnce();
              }
              if (r.citations.length === 0) {
                throw new Error(
                  `grounding_fired:false — Gemini grounded request returned zero citations after ` +
                    `${MAX_GROUNDING_RETRIES} retries. Refusing to pass back a weights-only answer as if ` +
                    `it were grounded; the answer may be stale/hallucinated. Retry, rephrase to demand ` +
                    `sources, or use a grok spec.`,
                );
              }
            }
            record(true, { text: r.text, citations: r.citations, transport });
            return { text: r.text, citations: r.citations };
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            const timedOut = isAttemptTimeoutError(msg);
            record(false, { error: msg, transport, timed_out: timedOut });
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
      });

      const results = settled.map((r, i) => {
        const label = specs[i].label ?? specs[i].model;
        if (r.status === "fulfilled") {
          const out: Record<string, unknown> = { label, ok: true, text: r.value.text };
          if (r.value.citations?.length) out.citations = r.value.citations;
          return out;
        }
        return { label, ok: false, error: String(r.reason?.message ?? r.reason) };
      });

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );
}
