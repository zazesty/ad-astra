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

// Cheap sanity guard for an REDACTED endpoint: block an absurd single payload.
// The real backstop against a REDACTED is the provider-side spend cap; this
// just stops one pathological prompt from running up input tokens.
const MAX_PROMPT_CHARS = 32_000;

export function registerAskGemini(
  server: any,
  { apiKey, model = "gemini-3.1-pro-preview" }: RegisterOpts
) {
  // Client is cheap (just holds the key); fine to construct per buildServer().
  const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

  server.registerTool(
    "ask_gemini",
    {
      title: "Ask Gemini 3.1 Pro",
      description:
        "Send a prompt to Google's Gemini 3.1 Pro (top-tier reasoning, extended " +
        "thinking on) and return its response. Use for a strong second-model " +
        "opinion on hard/contested calls, or (with grounding) for answers backed " +
        "by live Google Search. Not for high-volume use.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, {
            message: "prompt must not be empty or whitespace-only",
          })
          .describe("The prompt to send to Gemini."),
        grounded: z
          .boolean()
          .optional()
          .describe("If true, enable Google Search grounding for live retrieval."),
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
