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

/**
 * Error thrown by callOpenRouter. Carries the HTTP `status` (undefined for a
 * network/abort-level failure) and a `transient` flag = "this looks like an
 * OpenRouter availability problem, not a client bug". TRANSIENT = 429 / 5xx /
 * network / timeout (worth a retry, and worth failing over to a direct provider);
 * NON-transient = 4xx client errors (400/401/403/404) and post-200 parse failures
 * (retrying/failing-over just re-hits the same bug or masks it). ask_oracle keys
 * both its in-call retry AND its OR→direct failover off `transient`.
 */
export class OpenRouterError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, status: number | undefined, transient: boolean) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.transient = transient;
  }
}

/** True when an error is an OpenRouter availability failure worth failing over on
 *  (429/5xx/network/timeout). A grounding_fired:false fail-loud or a 4xx client
 *  error is NOT transient — callers must rethrow those, not fail over. */
export function isTransientError(e: unknown): boolean {
  return e instanceof OpenRouterError && e.transient;
}

// In-call retry budget for transient OR failures (429/5xx/network/timeout).
// 3 total attempts; the backoffs below add ~1.1s worst-case before we give up and
// (in ask_oracle) fail over to a direct provider — bounded, since seats are
// concurrent and each carries its own outer timeout.
const OR_MAX_ATTEMPTS = 3;
const OR_BACKOFF_MS = [300, 800];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cheap sanity guard: block an absurd single payload so one pathological prompt
// can't run up input tokens.
const MAX_PROMPT_CHARS = 32_000;

export interface CallGeminiOpts {
  system?: string;
  model?: string;
  grounded?: boolean;
  reasoning_effort?: "low" | "medium" | "high";
  temperature?: number;
  // Structured-output schema for the DIRECT SDK path (a @google/genai `Schema`
  // built with the SDK `Type` enums). When present, callGemini sets
  // responseMimeType:"application/json" + responseSchema — the direct-transport
  // twin of callOpenRouter's `response_format`. Used by ask_oracle's classifier
  // OR→direct failover so a degraded classify still returns valid structured JSON.
  response_schema?: Record<string, unknown>;
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
      ...(opts.response_schema
        ? { responseMimeType: "application/json", responseSchema: opts.response_schema }
        : {}),
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
 * Extra knobs the generalized OpenRouter caller accepts on top of CallGeminiOpts.
 * `response_format` carries the classifier's json_schema structured-output spec
 * (ask_oracle §2); `models` is OpenRouter's ordered FALLBACK list (try [0], only
 * on error/unavailable/rate-limit fall to [1]…) for hardening a seat against a
 * single model being down (ask_oracle §0). Neither is gemini-specific.
 */
export interface CallOpenRouterOpts {
  system?: string;
  grounded?: boolean;
  reasoning_effort?: "low" | "medium" | "high";
  temperature?: number;
  response_format?: Record<string, unknown>;
  models?: string[];
}

/**
 * Generalized OpenRouter /chat/completions caller — the single OR transport for
 * EVERY OR seat (gemini grounded/reasoning, openrouter/auto, x-ai/grok-4.3 on the
 * auto seat, and the classifier). `apiKey` is OPENROUTER_API_KEY (BYOK: google/*
 * bills my AI Studio credits, x-ai/* bills my xAI credits via the dashboard
 * provider keys). Raw fetch, no SDK. Returns {text, citations}, THROWS on failure
 * so callers' allSettled can catch.
 *
 * Provider-aware gates (ask_oracle §8):
 *   - Grounding: the `web` plugin (engine:"native" = the model's OWN Google
 *     Search grounding, never Exa, never domain-filtered) is attached ONLY for a
 *     gemini slug. `grounded` on a non-gemini slug is a no-op + a loud warning —
 *     OR serves Grok as plain chat, so a grounded grok request would SILENTLY
 *     lose grounding; we surface it instead.
 *   - Reasoning effort (full low|medium|high, default high): attached for gemini
 *     ONLY on -pro. flash/-lite have no extended-thinking mode — OR ACCEPTS a
 *     `reasoning` block on them (HTTP 200) but silently IGNORES it (verified
 *     2026-06-24: flash + flash-lite both 200, no latency change vs none), so we
 *     skip the param rather than send a no-op. (NB: the Google-DIRECT SDK path
 *     above is stricter — `thinkingConfig` on a non-pro model 400s there; that's a
 *     different API, don't conflate them.) Attached for any non-gemini slug (grok +
 *     openrouter/auto both honor it — and x-ai/grok-4.3 DEFAULTS to low via OR, so
 *     passing it explicitly is what keeps a grok seat off its silent low floor).
 */
export async function callOpenRouter(
  apiKey: string | undefined,
  slug: string,
  prompt: string,
  opts: CallOpenRouterOpts = {},
): Promise<GeminiResult> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set on the server.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}).`);
  }

  // A bare gemini slug (e.g. "gemini-2.5-flash") needs the OpenRouter "google/"
  // namespace; an already-namespaced slug ("x-ai/grok-4.3", "openrouter/auto",
  // "~google/…") is passed through untouched.
  const model = slug.includes("/") ? slug : `google/${slug}`;
  const isGemini = /gemini/i.test(model);
  // Reasoning gate: gemini only on -pro; everything else (grok, auto) accepts it.
  const supportsEffort = isGemini ? /-pro/i.test(model) : true;
  const effort = opts.reasoning_effort ?? "high";

  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = { model, messages };
  if (supportsEffort) body.reasoning = { effort };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.response_format) body.response_format = opts.response_format;
  if (opts.models?.length) body.models = opts.models;
  // engine:"native" = the model's built-in Google Search grounding through the
  // gateway (same index/sources as the direct path). Never Exa. Gemini only.
  if (opts.grounded && isGemini) {
    body.plugins = [{ id: "web", engine: "native" }];
  } else if (opts.grounded) {
    // Fail-loud, not fail-silent: a grounded request on a non-gemini slug would
    // quietly run ungrounded otherwise (OR has no native web plugin for Grok).
    console.error(
      `[callOpenRouter] WARNING grounded requested on non-gemini slug ${model} — ` +
        `web plugin NOT attached (OR serves it as plain chat). Use a grok-direct ` +
        `x_search seat or a gemini grounded seat instead.`,
    );
  }

  // Transient-retry loop: 429/5xx/network/timeout are retried (up to OR_MAX_ATTEMPTS
  // with backoff); 4xx client errors and post-200 parse failures throw immediately.
  // The thrown OpenRouterError carries `transient` so ask_oracle can decide whether
  // to fail over to a direct provider. Grounded search + high reasoning can run long,
  // so each attempt gets a 120s ceiling (~20x the observed p90); a timeout aborts
  // that attempt and is treated as transient.
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          // Optional OpenRouter attribution headers (used for their rankings only).
          "HTTP-Referer": "https://github.com/zazesty/grok-mcp",
          "X-Title": "grok-mcp",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      // Network/abort-level failure (no HTTP status) — transient by nature.
      const err = new OpenRouterError(
        `OpenRouter /chat/completions network failure: ${(e as Error)?.message ?? e}`,
        undefined,
        true,
      );
      if (attempt >= OR_MAX_ATTEMPTS) throw err;
      console.error(`[callOpenRouter] transient (network) attempt ${attempt}/${OR_MAX_ATTEMPTS} on ${model} — retrying: ${err.message}`);
      await sleep(OR_BACKOFF_MS[attempt - 1] ?? 800);
      continue;
    }
    const ms = Date.now() - t0;
    if (!res.ok) {
      const status = res.status;
      const transient = status === 429 || status >= 500;
      const err = new OpenRouterError(
        `OpenRouter /chat/completions error ${status}: ${(await res.text().catch(() => "")).slice(0, 600)}`,
        status,
        transient,
      );
      if (!transient || attempt >= OR_MAX_ATTEMPTS) throw err;
      console.error(`[callOpenRouter] transient (HTTP ${status}) attempt ${attempt}/${OR_MAX_ATTEMPTS} on ${model} — retrying`);
      await sleep(OR_BACKOFF_MS[attempt - 1] ?? 800);
      continue;
    }

    const data: any = await res.json();
    const result = extractOpenRouterResult(data);
    // Observability: model OpenRouter actually served (the floating alias can flip;
    // keeps the gemini-model-check guard meaningful here too), plus the grounding
    // signal the fail-loud contract keys off. journald only.
    console.error(
      `[callOpenRouter] requested=${model} resolved=${data?.model ?? "?"} ` +
        `grounded=${!!(opts.grounded && isGemini)} effort=${supportsEffort ? effort : "n/a"} ms=${ms} ` +
        `attempt=${attempt} finish=${data?.choices?.[0]?.finish_reason ?? "?"} citations=${result.citations.length}`,
    );
    return result;
  }
}

/**
 * Thin back-compat alias over callOpenRouter — preserves the exact signature
 * ask_panel and newsDigest already call. Resolves the slug from opts.model the
 * way the old function did (bare slug → google/ namespace; default = the
 * floating gemini-pro alias), then delegates. Do NOT remove: it keeps panel.ts /
 * newsDigest.ts untouched through the ask_oracle migration.
 */
export async function callGeminiViaOpenRouter(
  apiKey: string | undefined,
  prompt: string,
  opts: CallGeminiOpts = {},
): Promise<GeminiResult> {
  const slug = opts.model ?? DEFAULT_OPENROUTER_GEMINI_MODEL;
  const { model, ...rest } = opts;
  return callOpenRouter(apiKey, slug, prompt, rest);
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
