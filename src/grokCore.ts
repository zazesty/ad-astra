/**
 * grokCore.ts — the single Grok call path shared by every tool that talks to
 * xAI (ask_panel grok specs + the dedicated grok_x_search wrapper).
 *
 * One function, `callGrok`, with three grounding modes:
 *   - "off"      → /chat/completions, pure parametric. No search, never billed
 *                  for retrieval. Honours reasoning_effort. (== the old ask_grok.)
 *   - "auto"     → /v1/responses with the x_search (+web_search) tool ATTACHED
 *                  but not forced. Grok decides whether to search, so a retrieval
 *                  is billed ONLY when it actually happens. Empty citations is a
 *                  legitimate outcome (model chose not to search) — no error.
 *   - "required" → same /responses request as "auto", but enforces the
 *                  live-or-nothing contract: empty citations => throw. This is
 *                  the grok_x_search behaviour. (== the old grok_x_search.)
 *
 * System prompts on the /responses path go in the top-level `instructions`
 * field (verified live 2026-06-14: accepted and honoured; the {role:"system"}
 * input-message form is not relied upon). reasoning_effort is honoured on BOTH
 * paths: flat `reasoning_effort` on /chat/completions, nested `reasoning.effort`
 * on /responses (the flat field is ignored there). callGrok takes an
 * already-resolved `system` string; lens resolution is the caller's job.
 *
 * callGrok THROWS on any failure (HTTP error, or required-mode empty citations)
 * so callers can handle it uniformly: ask_panel via Promise.allSettled, the
 * grok_x_search wrapper via try/catch → MCP isError.
 */

export type Grounding = "off" | "auto" | "required";

export interface CallGrokOpts {
  system?: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  temperature?: number;
  grounding?: Grounding;
  // grounded-only (ignored when grounding === "off"):
  allowed_handles?: string[];
  excluded_handles?: string[];
  from_date?: string;
  to_date?: string;
  include_web?: boolean;
}

export interface GrokResult {
  text: string;
  citations: string[];
}

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
/** Single source of truth for direct Grok model pin (index + oracle resolve import this). */
export const DEFAULT_MODEL = "grok-4.6";
const DEFAULT_REASONING_EFFORT = "high";

export async function callGrok(
  apiKey: string | undefined,
  prompt: string,
  opts: CallGrokOpts = {},
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<GrokResult> {
  if (!apiKey) throw new Error("XAI_API_KEY is not set on the server.");

  const grounding: Grounding = opts.grounding ?? "off";
  const model = opts.model ?? DEFAULT_MODEL;

  if (grounding === "off") {
    return callGrokParametric(apiKey, prompt, { ...opts, model }, baseUrl);
  }
  return callGrokGrounded(apiKey, prompt, { ...opts, model, grounding }, baseUrl);
}

// --- /chat/completions: pure parametric ------------------------------------

async function callGrokParametric(
  apiKey: string,
  prompt: string,
  opts: CallGrokOpts,
  baseUrl: string,
): Promise<GrokResult> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model: opts.model,
    reasoning_effort: opts.reasoning_effort ?? DEFAULT_REASONING_EFFORT,
    messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`xAI /chat/completions error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 600)}`);
  }
  const data: any = await res.json();
  // Observability: ground-truth which model actually served (xAI silently routes
  // legacy aliases). journald only, not the reply.
  console.error(`[callGrok] off model: requested=${opts.model} resolved=${data?.model ?? "?"}`);
  const text = data?.choices?.[0]?.message?.content ?? "(no content returned)";
  return { text, citations: [] };
}

// --- /v1/responses: grounded (auto | required) -----------------------------

async function callGrokGrounded(
  apiKey: string,
  prompt: string,
  opts: CallGrokOpts,
  baseUrl: string,
): Promise<GrokResult> {
  if (opts.allowed_handles?.length && opts.excluded_handles?.length) {
    throw new Error("Use allowed_handles OR excluded_handles, not both.");
  }

  const xTool: Record<string, unknown> = { type: "x_search" };
  if (opts.allowed_handles?.length) xTool.allowed_x_handles = opts.allowed_handles;
  if (opts.excluded_handles?.length) xTool.excluded_x_handles = opts.excluded_handles;
  if (opts.from_date) xTool.from_date = opts.from_date;
  if (opts.to_date) xTool.to_date = opts.to_date;
  const tools: Record<string, unknown>[] = [xTool];
  if (opts.include_web) tools.push({ type: "web_search" });

  const body: Record<string, unknown> = {
    model: opts.model,
    input: prompt,
    tools,
  };
  // System prompt → top-level `instructions` (verified accepted+honoured on /responses).
  if (opts.system) body.instructions = opts.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  // Effort on /responses goes in the NESTED `reasoning.effort` object — the flat
  // `reasoning_effort` field (what /chat/completions uses) is silently ignored
  // here (probed 2026-06-14: flat = no change vs baseline; nested ~3.6x'd the
  // reasoning tokens, no 400). xAI's grounded default is "low"; we override to
  // DEFAULT_REASONING_EFFORT (high) so live search thinks as hard as the rest.
  body.reasoning = { effort: opts.reasoning_effort ?? DEFAULT_REASONING_EFFORT };

  const resp = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    // live search + reasoning can run long; give it headroom
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    throw new Error(`xAI /responses error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 600)}`);
  }

  const data: any = await resp.json();
  return applyGroundingContract(extractAnswerAndCitations(data), opts.grounding ?? "auto");
}

/**
 * Apply the grounding contract to an already-parsed result. Pure (exported for
 * tests). In "required" mode a structured-citation-less answer is parametric —
 * which belongs in "off"/"auto", not here — so we throw rather than pass a
 * sourceless answer. If the answer carries inline X links while the structured
 * array is empty, the citation response shape likely changed; warn so the
 * parser gets fixed. "off"/"auto" pass through untouched.
 */
export function applyGroundingContract(result: GrokResult, grounding: Grounding): GrokResult {
  if (grounding === "required" && result.citations.length === 0) {
    if (result.text && /https?:\/\/(www\.)?(x|twitter)\.com\//i.test(result.text)) {
      console.warn(
        "[callGrok] required: structured citations empty but answer has inline X " +
          "links — likely a citation response-shape change; check extractAnswerAndCitations.",
      );
    }
    throw new Error("No live X posts found for this query/window.");
  }
  return result;
}

/**
 * Pure parser for an xAI /responses payload → {text, citations}. Exported for
 * unit tests. Defensive across response shapes:
 *   - text:      data.output_text, else concatenated data.output[].content[].text
 *   - citations: data.citations[] (xAI), else output[].content[].annotations[].url
 */
export function extractAnswerAndCitations(data: any): GrokResult {
  let text: string = typeof data?.output_text === "string" ? data.output_text : "";
  if (!text && Array.isArray(data?.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      for (const c of item?.content ?? []) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    text = parts.join("\n").trim();
  }

  const citations: string[] = [];
  if (Array.isArray(data?.citations)) {
    for (const c of data.citations) {
      citations.push(typeof c === "string" ? c : c?.url ?? JSON.stringify(c));
    }
  }
  if (!citations.length && Array.isArray(data?.output)) {
    for (const item of data.output) {
      for (const c of item?.content ?? []) {
        for (const a of c?.annotations ?? []) {
          const u = a?.url ?? a?.url_citation?.url;
          if (u) citations.push(u);
        }
      }
    }
  }

  return { text, citations };
}
