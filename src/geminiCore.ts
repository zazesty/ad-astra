/**
 * geminiCore.ts — the Gemini call path(s) shared by ask_panel's gemini specs.
 * Extracted from the former ask_gemini tool (now folded into ask_panel).
 *
 * TWO transports, selected by the caller (GEMINI_TRANSPORT env):
 *
 *   "direct"     → callGemini: first-party @google/genai SDK (AI Studio API-key
 *                  auth, NOT Vertex). Shapes verified against @google/genai
 *                  v2.7.0:
 *                    - thinking:  config.thinkingConfig.thinkingLevel = ThinkingLevel.*
 *                    - grounding: config.tools = [{ googleSearch: {} }]  (native Google search)
 *                    - text:      resp.text ; resolved model: resp.modelVersion
 *
 *   "openrouter" → callGeminiViaOpenRouter: OpenRouter's OpenAI-compatible
 *                  /chat/completions endpoint, BYOK (my Google AI Studio key is a
 *                  provider key in the OpenRouter dashboard, so google/* calls bill
 *                  my AI Studio credits). Raw fetch — mirrors callGrokParametric,
 *                  no SDK dependency. Reasoning maps to the unified `reasoning.effort`
 *                  field; grounding uses the `web` plugin pinned to engine:"native"
 *                  (= Gemini's OWN Google Search grounding passed through, NOT Exa;
 *                  Exa is a different index and is deliberately never used here).
 *
 * Both take an already-resolved `system` string (lens resolution is the caller's
 * job), return {text, citations}, and THROW on failure so ask_panel's allSettled
 * can catch them. The direct path returns citations:[] (it does not surface
 * Google's groundingMetadata today); the OpenRouter path returns url_citation
 * annotations when grounding ran.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const DEFAULT_GEMINI_MODEL = "gemini-pro-latest";
// OpenRouter floating alias — "always redirects to the latest Gemini Pro".
// Matches the direct path's `gemini-pro-latest` semantics. The leading "~" is
// part of the real API slug for OpenRouter's floating aliases (verified live:
// the un-prefixed "google/gemini-pro-latest" returns a 400 invalid-model-ID).
export const DEFAULT_OPENROUTER_GEMINI_MODEL = "~google/gemini-pro-latest";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type GeminiTransport = "direct" | "openrouter";

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

export interface GeminiResult {
  text: string;
  citations: string[];
}

export type GeminiClient = GoogleGenAI;

export function makeGeminiClient(apiKey: string | undefined): GeminiClient | null {
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

export async function callGemini(
  ai: GeminiClient | null,
  prompt: string,
  opts: CallGeminiOpts = {},
): Promise<GeminiResult> {
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

  const t0 = Date.now();
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
  const ms = Date.now() - t0;

  // Surface Google's grounding metadata as citations. Previously this path
  // returned citations:[] unconditionally, which made EVERY grounded direct call
  // look ungrounded (a silent grounding miss indistinguishable from a real
  // weights-only answer). Shape (@google/genai v2.7.0): candidates[0]
  // .groundingMetadata.groundingChunks[].web.uri.
  const citations = extractDirectCitations(resp);

  // Observability: model that actually served (`gemini-pro-latest` silently flips
  // at a higher price point), plus the grounding signal we now key the fail-loud
  // contract off of. journald only, not the reply.
  console.error(
    `[callGemini] direct requested=${resolvedModel} resolved=${resp.modelVersion ?? "?"} ` +
      `grounded=${!!opts.grounded} effort=${effort} ms=${ms} citations=${citations.length}`,
  );
  return { text: resp.text ?? "(no text returned)", citations };
}

/**
 * Pure parser for an @google/genai response → citation URLs from Google's
 * groundingMetadata. Exported for unit tests. Empty array = grounding did not
 * fire (or the model chose not to search); the caller's grounding contract
 * decides what to do with that.
 */
export function extractDirectCitations(resp: any): string[] {
  const citations: string[] = [];
  const chunks = resp?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const c of chunks) {
    const u = c?.web?.uri ?? c?.retrievedContext?.uri;
    if (u) citations.push(u);
  }
  return citations;
}

/**
 * OpenRouter transport. `apiKey` is the OPENROUTER_API_KEY (not the Google key —
 * the Google key lives in the OpenRouter dashboard as a BYOK provider key).
 *
 * Reasoning: full low|medium|high (no low→medium bump here — the menu just hides
 * `low` upstream), default high, and only attached for -pro models to match the
 * direct path's thinking-model gate. Grounding: `web` plugin forced to
 * engine:"native" so we get Gemini's real Google Search grounding, never Exa,
 * and never with domain filters (which silently force the Exa fallback).
 */
export async function callGeminiViaOpenRouter(
  apiKey: string | undefined,
  prompt: string,
  opts: CallGeminiOpts = {},
): Promise<GeminiResult> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set on the server.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}).`);
  }

  // A bare gemini slug (e.g. "gemini-2.5-flash") needs the OpenRouter "google/"
  // namespace; an already-namespaced slug is passed through untouched.
  const model = opts.model
    ? opts.model.includes("/")
      ? opts.model
      : `google/${opts.model}`
    : DEFAULT_OPENROUTER_GEMINI_MODEL;
  const isThinkingModel = /-pro/i.test(model);
  const effort = opts.reasoning_effort ?? "high";

  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = { model, messages };
  if (isThinkingModel) body.reasoning = { effort };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  // engine:"native" = Gemini's built-in Google Search grounding through the
  // gateway (same index/sources as the direct path). Never Exa.
  if (opts.grounded) body.plugins = [{ id: "web", engine: "native" }];

  const t0 = Date.now();
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // Optional OpenRouter attribution headers (used for their rankings only).
      "HTTP-Referer": "https://github.com/zazesty/grok-mcp",
      "X-Title": "grok-mcp",
    },
    body: JSON.stringify(body),
    // Grounded search + high reasoning can run long; give it headroom. Measured
    // p90 for a grounded high-effort call is ~3-6s, so 120s is already ~20x the
    // observed worst case — the timeout is NOT the bottleneck here. A timeout
    // here aborts the whole round-trip (throws below), never a clean answer.
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    throw new Error(
      `OpenRouter /chat/completions error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 600)}`,
    );
  }

  const data: any = await res.json();
  const result = extractOpenRouterResult(data);
  // Observability: model OpenRouter actually served (the floating alias can flip;
  // keeps the gemini-model-check guard meaningful here too), plus the grounding
  // signal the fail-loud contract keys off. journald only.
  console.error(
    `[callGemini] openrouter requested=${model} resolved=${data?.model ?? "?"} ` +
      `grounded=${!!opts.grounded} effort=${effort} ms=${ms} ` +
      `finish=${data?.choices?.[0]?.finish_reason ?? "?"} citations=${result.citations.length}`,
  );
  return result;
}

/**
 * Pure parser for an OpenRouter chat-completions payload → {text, citations}.
 * Exported for unit tests. Citations come from the assistant message's
 * `annotations[]` of type "url_citation" (the shape OpenRouter normalizes both
 * native and Exa web results into).
 */
export function extractOpenRouterResult(data: any): GeminiResult {
  const msg = data?.choices?.[0]?.message ?? {};
  const text: string = typeof msg?.content === "string" && msg.content ? msg.content : "(no content returned)";

  const citations: string[] = [];
  for (const a of msg?.annotations ?? []) {
    const u = a?.url_citation?.url ?? a?.url;
    if (u) citations.push(u);
  }
  return { text, citations };
}
