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
import { callGemini, makeGeminiClient, type GeminiClient } from "./geminiCore.js";
import { applyLens, buildLensParamDescription } from "./lenses.js";

type RegisterOpts = {
  xaiApiKey: string | undefined;
  geminiApiKey: string | undefined;
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
      .describe("How hard the model thinks before answering. Applies to Gemini (default high; 'low' is raised to medium since Gemini Pro thinking is medium/high) and to UNGROUNDED Grok (default medium). Grounded Grok ignores this and runs at the API default effort."),
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
        "search, a lens, etc. Results come back in input order, each tagged with its label and an " +
        "ok flag; one spec failing does NOT fail the others. This tool gathers — it does not judge; " +
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
      const settled = await mapLimit(specs, CONCURRENCY, async (spec) => {
        // Resolve lens → effective system per spec (default second-opinion frame
        // auto-applies when neither lens nor system is given; pass lens:"none" to opt out).
        const { system, error } = applyLens(spec.lens, spec.system);
        if (error) throw new Error(error);

        if (spec.model === "grok") {
          const grounding: Grounding = spec.grounded ? "auto" : "off";
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
          return { text: r.text, citations: r.citations };
        }
        // gemini
        const r = await callGemini(geminiClient, spec.prompt, {
          system,
          model: spec.model_slug,
          grounded: spec.grounded,
          reasoning_effort: spec.reasoning_effort,
          temperature: spec.temperature,
        });
        return { text: r.text, citations: [] as string[] };
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
