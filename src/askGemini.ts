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
      title: "Ask Gemini",
      description:
        "Send a prompt to Google's latest Gemini Pro model for top-tier reasoning and " +
        "extended-thinking tasks. For ANY factual or current question, default " +
        "grounded=true to enable LIVE Google web search (current events, real-time " +
        "data, or facts past the model's training cutoff); use grounded=false only " +
        "for pure reasoning/creative/code. Returns Gemini's text response " +
        "(with inline source citations when grounded).",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, {
            message: "prompt must not be empty or whitespace-only",
          })
          .describe("The full prompt/question. For grounded queries, state the current date/time and ask explicitly for sources and timestamps."),
        system: z
          .string()
          .optional()
          .describe("Optional system instruction — persona, tone, output format, or constraints applied before the prompt."),
        grounded: z
          .boolean()
          .optional()
          .describe("Back the answer with LIVE Google web search. DEFAULT TO TRUE for ANYTHING factual or current — news, prices, stats, scores, people, dates, 'latest'/recent events, or any fact that could be past the model's training cutoff. Use false ONLY for pure reasoning, creative writing, brainstorming, or code that needs no external facts."),
        model: z
          .string()
          .optional()
          .describe(`Optional model slug. Default ${model}.`),
        reasoning_effort: z
          .enum(["medium", "high"])
          .optional()
          .describe("How hard Gemini Pro thinks before answering. Default high; medium for lighter tasks. (For genuinely cheap/fast, pass a flash `model` slug instead. Only applies to -pro thinking models.)"),
      },
    },
    async ({ prompt, system, grounded, model: modelOverride, reasoning_effort }: any) => {
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
        const thinkingLevel =
          ThinkingLevel[(reasoning_effort ?? "high").toUpperCase() as keyof typeof ThinkingLevel];
        const resp = await ai.models.generateContent({
          model: resolvedModel,
          contents: prompt,
          config: {
            ...(system ? { systemInstruction: system } : {}),
            ...(isThinkingModel ? { thinkingConfig: { thinkingLevel } } : {}),
            ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
          },
        });

        // Observability: log the model that actually served this. Acute reason —
        // `gemini-pro-latest` will silently flip (e.g. to 3.5 Pro) at a higher
        // price point; this is the ground truth to catch it. Goes to journald.
        console.error(`[ask_gemini] model: requested=${resolvedModel} resolved=${resp.modelVersion ?? "?"}`);
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
