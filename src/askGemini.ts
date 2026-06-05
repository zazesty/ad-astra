/**
 * askGemini.ts — adds an `ask_gemini` tool to the existing astra MCP server
 * (alongside ask_grok, get_odds, grok_x_search).
 *
 * Sends a prompt to Google's Gemini 3.1 Pro with extended thinking ON and
 * returns the response — the Gemini analog of ask_grok, for a strong
 * independent second opinion on hard/contested calls. Optional Google Search
 * grounding (live retrieval) is the differentiated value vs ask_grok.
 *
 * Uses Google's first-party @google/genai SDK with the AI Studio API-key auth
 * path (NOT Vertex AI). Shapes verified against installed @google/genai v2.7.0:
 *   - thinking: config.thinkingConfig.thinkingLevel = ThinkingLevel.HIGH
 *   - grounding: config.tools = [{ googleSearch: {} }]
 *   - text accessor: resp.text ; usage: resp.usageMetadata.thoughtsTokenCount
 *
 * Integration — in index.ts, after `server` is created:
 *     import { registerAskGemini } from "./askGemini.js";
 *     registerAskGemini(server, { apiKey: process.env.GEMINI_API_KEY });
 *
 * Requires Node 18+. ESM/TS to match the server.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";

type RegisterOpts = {
  apiKey: string | undefined;
  model?: string;
};

// Cheap sanity guard: block an absurd single payload so one pathological
// prompt can't run up input tokens.
const MAX_PROMPT_CHARS = 32_000;

export function registerAskGemini(
  server: any,
  { apiKey, model = "gemini-pro-latest" }: RegisterOpts
) {
  // Client is cheap (just holds the key); fine to construct per buildServer().
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  server.registerTool(
    "ask_gemini",
    {
      title: "Ask Gemini 3.1 Pro",
      description:
        "Send a prompt to Google's Gemini 3.1 Pro for top-tier reasoning and " +
        "extended-thinking tasks. Set grounded=true to enable LIVE Google web " +
        "search — use this for any question about current events, real-time data, " +
        "or facts past the model's training cutoff. Returns Gemini's text response " +
        "(with inline source citations when grounded).",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, {
            message: "prompt must not be empty or whitespace-only",
          })
          .describe("The full prompt/question. For grounded queries, state the current date/time and ask explicitly for sources and timestamps."),
        grounded: z
          .boolean()
          .optional()
          .describe("true = answer backed by live web search (current events, real-time data). false = model-knowledge only, faster. Default false."),
        model: z
          .string()
          .optional()
          .describe(`Optional model slug. Default ${model}.`),
      },
    },
    async ({ prompt, grounded, model: modelOverride }: any) => {
      if (!ai) {
        return {
          content: [{ type: "text", text: "Error: GEMINI_API_KEY not set." }],
          isError: true,
        };
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        return {
          content: [
            {
              type: "text",
              text: `Error: prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}).`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Only *-pro slugs support extended thinking; attaching thinkingConfig to
        // a non-thinking model (e.g. gemini-2.5-flash) returns a 400. Resolve the
        // actual model being sent (override OR default) and gate the config on it.
        const resolvedModel = modelOverride ?? model;
        const isThinkingModel = /-pro/i.test(resolvedModel);
        const resp = await ai.models.generateContent({
          model: resolvedModel,
          contents: prompt,
          config: {
            ...(isThinkingModel ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } } : {}),
            ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
          },
        });

        const text = resp.text ?? "(no text returned)";
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Gemini request failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
