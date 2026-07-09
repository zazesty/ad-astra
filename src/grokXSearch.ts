/**
 * grokXSearch.ts — the dedicated `grok_x_search` tool: a LIVE search of X
 * (Twitter) via Grok, returning a synthesized answer PLUS citations to the
 * source posts. Kept as its own tool (rather than folded into ask_panel)
 * because it has a distinct contract — live-or-nothing: no source posts => a
 * hard error, never a sourceless/parametric answer — and a distinct billing
 * profile (always bills a search).
 *
 * This is now a thin wrapper over the shared callGrok core (grounding:
 * "required"). The /responses + x_search request, response parsing, and the
 * live-or-nothing contract all live in grokCore.ts, shared with ask_panel's
 * grounded Grok specs. (The old Live Search `search_parameters` API was RETIRED
 * 2026-01-12 / 410 Gone; the core uses the current Responses + x_search path.)
 */

import { z } from "zod";
import { callGrok } from "./grokCore.js";

type RegisterOpts = {
  apiKey: string | undefined;
  baseUrl?: string;
  model?: string;
};

export function registerGrokXSearch(
  server: any,
  { apiKey, baseUrl, model }: RegisterOpts,
) {
  server.registerTool(
    "grok_x_search",
    {
      title: "Grok X Search",
      description:
        "Answer a question using a LIVE search of X (Twitter) via Grok. Best for " +
        "public sentiment, breaking discussion, and what people are saying right " +
        "now on a topic. Returns Grok's synthesized answer over matching posts PLUS " +
        "citations to the source posts. Live-or-nothing: if no matching posts are " +
        "found it returns an error rather than a sourceless answer. Its edge is those " +
        "citations + the live-or-nothing contract: a caller that ALREADY has native live-X " +
        "access may get lower latency from its own tools — reach for grok_x_search when you " +
        "lack native X, or when you need the cited, fail-loud result. (For ungrounded " +
        "reasoning, a cross-model panel, or general web grounding, use ask_panel.)",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1, "query must not be empty")
          .describe("Natural-language question about X discussion/sentiment, e.g. 'what are people saying about X vs Y'."),
        allowed_handles: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Only consider posts from these X handles (omit the @). Max 20."),
        excluded_handles: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Exclude posts from these handles. Cannot combine with allowed_handles."),
        from_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "from_date must be ISO YYYY-MM-DD")
          .optional()
          .describe("Earliest post date to include, format YYYY-MM-DD. Omit for no lower bound. For an upper bound, set to_date."),
        to_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "to_date must be ISO YYYY-MM-DD")
          .optional()
          .describe("Latest post date, ISO YYYY-MM-DD."),
        include_web: z
          .boolean()
          .optional()
          .describe("Also search the web for broader context, not just X."),
      },
    },
    async ({
      query,
      allowed_handles,
      excluded_handles,
      from_date,
      to_date,
      include_web,
    }: any) => {
      try {
        const { text: answer, citations } = await callGrok(
          apiKey,
          query,
          {
            model,
            grounding: "required",
            allowed_handles,
            excluded_handles,
            from_date,
            to_date,
            include_web,
          },
          baseUrl,
        );
        if (!answer) {
          // Citations present but no parseable text — surface for a parser fix.
          return {
            content: [
              {
                type: "text",
                text:
                  "Parsed no answer text — response shape differs from the default. " +
                  "Check extractAnswerAndCitations in grokCore.ts. Citations: " +
                  JSON.stringify(citations),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify({ answer, citations }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
      }
    },
  );
}
