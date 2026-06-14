/**
 * geminiCore.ts — the single Gemini call path shared by ask_panel's gemini
 * specs. Extracted from the former ask_gemini tool (now folded into ask_panel).
 *
 * Sends a prompt to Google's Gemini Pro via the first-party @google/genai SDK
 * (AI Studio API-key auth, NOT Vertex). Shapes verified against @google/genai
 * v2.7.0:
 *   - thinking:   config.thinkingConfig.thinkingLevel = ThinkingLevel.HIGH
 *   - grounding:  config.tools = [{ googleSearch: {} }]   (live Google search)
 *   - text:       resp.text ; resolved model: resp.modelVersion
 *
 * callGemini takes an already-resolved `system` string (lens resolution is the
 * caller's job) and THROWS on failure so ask_panel's allSettled can catch it.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const DEFAULT_GEMINI_MODEL = "gemini-pro-latest";

// Cheap sanity guard: block an absurd single payload so one pathological prompt
// can't run up input tokens.
const MAX_PROMPT_CHARS = 32_000;

export interface CallGeminiOpts {
  system?: string;
  model?: string;
  grounded?: boolean;
  reasoning_effort?: "low" | "medium" | "high";
  temperature?: number;
}

export type GeminiClient = GoogleGenAI;

export function makeGeminiClient(apiKey: string | undefined): GeminiClient | null {
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

export async function callGemini(
  ai: GeminiClient | null,
  prompt: string,
  opts: CallGeminiOpts = {},
): Promise<{ text: string }> {
  if (!ai) throw new Error("GEMINI_API_KEY is not set on the server.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}).`);
  }

  const resolvedModel = opts.model ?? DEFAULT_GEMINI_MODEL;
  // Only *-pro slugs support extended thinking; attaching thinkingConfig to a
  // non-thinking model (e.g. gemini-2.5-flash) returns a 400.
  const isThinkingModel = /-pro/i.test(resolvedModel);
  // Gemini thinking is medium/high; map an incoming "low" up to medium.
  const effort = opts.reasoning_effort === "low" ? "medium" : opts.reasoning_effort ?? "high";
  const thinkingLevel = ThinkingLevel[effort.toUpperCase() as keyof typeof ThinkingLevel];

  const resp = await ai.models.generateContent({
    model: resolvedModel,
    contents: prompt,
    config: {
      ...(opts.system ? { systemInstruction: opts.system } : {}),
      ...(isThinkingModel ? { thinkingConfig: { thinkingLevel } } : {}),
      ...(opts.grounded ? { tools: [{ googleSearch: {} }] } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
  });

  // Observability: `gemini-pro-latest` will silently flip (e.g. to 3.5 Pro) at a
  // higher price point; log the model that actually served. journald only.
  console.error(`[callGemini] model: requested=${resolvedModel} resolved=${resp.modelVersion ?? "?"}`);
  return { text: resp.text ?? "(no text returned)" };
}
