/**
 * oracleClassifier.ts — ask_oracle's prefilter + classifier (spec §1, §2).
 *
 * Two deterministic-then-model stages that decide the SHAPE of a route (how many
 * seats, which capabilities, which lens, how much effort). Dispatch (buildSlots /
 * executeSlots / assemble) is a separate module — this one only produces the
 * Classification the route is built from, and the prefilter seeds the fail-loud
 * fallback when the classifier can't be reached/parsed.
 *
 *   prefilter(prompt)  → regex SEEDS (needs_x / needs_grounding); never decides.
 *   classify(key,p)    → gemini-3.5-flash-lite via OpenRouter, structured JSON.
 *                        THROWS ClassifierError on transport/parse failure so the
 *                        orchestrator can fall back to a prefilter-seeded route
 *                        with degraded:true (spec §2 fail-loud).
 *
 * Transport note: routed through callOpenRouter (the one OR path) — flash-lite is
 * NOT a `-pro` slug, so callOpenRouter attaches no `reasoning` block; the
 * classifier's "minimal thinking" intent is met by the model tier itself rather
 * than an explicit thinking-off token (no verified OR token for that on flash-lite
 * yet, and the effort canon dropped "minimal"). If hot-path latency proves too
 * high later, add a verified reasoning passthrough — do NOT guess a token (400).
 */

import { Type } from "@google/genai";
import { callOpenRouter, callGemini, makeGeminiClient, isTransientError } from "./geminiCore.js";

export type Difficulty = "trivial" | "simple" | "moderate" | "hard";
export type Effort = "low" | "medium" | "high";
// Curated suggestion menu — MUST stay in sync with lenses.md frame names. This is
// only what the classifier may *suggest*; an explicit `lens` override is still a
// free string (see [[grok-mcp-lenses]]), so new frames don't have to land here.
export const LENS_NAMES = [
  "default",
  "georgist",
  "austrian",
  "state-capacity",
  "steelman-then-break",
  "pre-mortem",
] as const;
export type LensName = (typeof LENS_NAMES)[number];

export interface Classification {
  difficulty: Difficulty;
  domains: string[];
  needs_x: boolean;
  needs_grounding: boolean;
  suggested_lens: LensName;
  suggested_panel_n: number;
  reasoning_effort: Effort;
  rationale: string;
}

export interface PrefilterSeeds {
  needs_x: boolean;
  needs_grounding: boolean;
}

/** Classifier is reachable but produced no usable Classification (transport error
 *  OR unparseable/invalid JSON). Carries the original message so the route object
 *  can surface `classifier_error` and set degraded:true (spec §2). */
export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierError";
  }
}

// Pinned for latency (flash-lite = fastest/cheapest tier). Cascade (2026-08):
//   primary google/gemini-3.5-flash-lite → OR fallback google/gemini-3.1-flash-lite
//   (2.5 flash-lite dropped). research_fanout reuses this pin for leg *decomposition*
//   only — evidence limbs are grounded gemini-pro / grok, not flash-lite.
// No `:free` slugs — rate-limited + latency-unstable.
export const CLASSIFIER_MODEL = "google/gemini-3.5-flash-lite";
export const CLASSIFIER_FALLBACK_MODELS = ["google/gemini-3.1-flash-lite"];
// Direct-SDK twin of CLASSIFIER_MODEL (no OpenRouter `google/` namespace) for the
// OR→direct failover: if the OpenRouter GATEWAY is down, the OR fallback list
// dies with it (both ride one OR request), so we re-classify via @google/genai
// directly — an independent path that keeps FULL routing quality through an OR
// outage instead of dropping to the regex prefilter. Measured ~1-2s, on par with
// OR (2026-06-25), so this costs nothing on the happy path (only fires on OR fail).
export const CLASSIFIER_MODEL_DIRECT = "gemini-3.5-flash-lite";

// Regex SEEDS only (spec §1) — these never decide; the classifier does, and they
// re-surface only as the fail-loud fallback route's capability seats.
const X_SEED = /\b(latest|today|right now|breaking|on x|tweet|posted|sentiment)\b/i;
const GROUNDING_SEED = /\b(current|as of|recent|cite|source|who is|price of)\b/i;

export function prefilter(prompt: string): PrefilterSeeds {
  return { needs_x: X_SEED.test(prompt), needs_grounding: GROUNDING_SEED.test(prompt) };
}

// Structured-output contract (spec §2). Field ORDER is deliberate: `domains` is
// emitted early so the model commits to a topic read before deciding capabilities/
// lens/effort — a cheap autoregressive chain-of-thought at minimal thinking.
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "oracle_route",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        difficulty: { type: "string", enum: ["trivial", "simple", "moderate", "hard"] },
        domains: { type: "array", items: { type: "string" } },
        needs_x: { type: "boolean" },
        needs_grounding: { type: "boolean" },
        suggested_lens: { type: "string", enum: [...LENS_NAMES] },
        suggested_panel_n: { type: "integer", minimum: 1, maximum: 4 },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high"] },
        rationale: { type: "string" },
      },
      required: [
        "difficulty",
        "domains",
        "needs_x",
        "needs_grounding",
        "suggested_lens",
        "suggested_panel_n",
        "reasoning_effort",
        "rationale",
      ],
    },
  },
} as const;

// Direct-SDK twin of RESPONSE_FORMAT for the OR→direct failover. @google/genai's
// `responseSchema` wants a Schema built from the `Type` enums (not the OpenAI
// json_schema envelope), but the field set + ordering mirror RESPONSE_FORMAT 1:1 so
// the SAME parseClassification() validates either path's output. propertyOrdering
// keeps `domains` early (the cheap CoT scaffold), matching the OR schema's intent.
const DIRECT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    difficulty: { type: Type.STRING, enum: ["trivial", "simple", "moderate", "hard"] },
    domains: { type: Type.ARRAY, items: { type: Type.STRING } },
    needs_x: { type: Type.BOOLEAN },
    needs_grounding: { type: Type.BOOLEAN },
    suggested_lens: { type: Type.STRING, enum: [...LENS_NAMES] },
    suggested_panel_n: { type: Type.INTEGER },
    reasoning_effort: { type: Type.STRING, enum: ["low", "medium", "high"] },
    rationale: { type: Type.STRING },
  },
  required: [
    "difficulty",
    "domains",
    "needs_x",
    "needs_grounding",
    "suggested_lens",
    "suggested_panel_n",
    "reasoning_effort",
    "rationale",
  ],
  propertyOrdering: [
    "difficulty",
    "domains",
    "needs_x",
    "needs_grounding",
    "suggested_lens",
    "suggested_panel_n",
    "reasoning_effort",
    "rationale",
  ],
};

const SYSTEM_PROMPT = [
  "You are a routing classifier for a multi-model oracle. Read the user's prompt and",
  "return ONLY a JSON object matching the schema — no prose, no code fences.",
  "Rules:",
  "- suggested_panel_n: 1 for most questions; 2-3 when genuinely contested or helped by",
  "  multiple perspectives; 3-4 only for hard, high-stakes, or sharply contested questions.",
  "- needs_x: true ONLY for genuinely live X/Twitter data — real-time posts, current",
  "  sentiment, a handle's recent activity. NOT for general recency or news.",
  "- needs_grounding: true ONLY when answering REQUIRES fetching current/external facts —",
  "  live data, recent events, specific figures, who/what/when lookups. FALSE for analytical,",
  "  normative, conceptual, or opinion prompts that reason from known principles ('should we…',",
  "  'evaluate…', 'explain…', 'compare the idea of…', 'make the call'): they have nothing to",
  "  retrieve, and a grounded seat there only fails loud on zero citations. NOT X-specific.",
  "- suggested_lens: key the frame on the TASK the user wants done, NOT on the topic.",
  "  Default to 'default' (neutral second opinion — commit to a position with hard numbers,",
  "  no both-sidesing), ESPECIALLY for adjudication / 'make the call' / decide / evaluate-a-claim",
  "  tasks: a partisan frame there manufactures FALSE CONSENSUS (every seat argues one side).",
  "  Use 'steelman-then-break' when the task is to stress-test an argument, 'pre-mortem' when it",
  "  is to surface how a plan fails. Use an ideological frame (georgist / austrian /",
  "  state-capacity) ONLY when the user EXPLICITLY asks for that school's view — NEVER merely",
  "  because the topic touches land, markets, or the state.",
  "- reasoning_effort: scale with DIFFICULTY of the reasoning, not the length of the prompt.",
  "- domains: your short read of the topic(s), decided first. rationale: <= 15 words.",
].join("\n");

/**
 * Classify a prompt into a route shape. Returns a validated Classification, or
 * THROWS ClassifierError (transport failure, empty/garbled output, or schema
 * mismatch) for the orchestrator's fail-loud fallback. `response_format` forces
 * structured JSON; the defensive parse is belt-and-suspenders for the fallback
 * model, which may honor `strict` less rigorously.
 */
export async function classify(
  openrouterApiKey: string | undefined,
  prompt: string,
  geminiApiKey?: string,
): Promise<Classification> {
  let text: string;
  try {
    const res = await callOpenRouter(openrouterApiKey, CLASSIFIER_MODEL, prompt, {
      system: SYSTEM_PROMPT,
      models: CLASSIFIER_FALLBACK_MODELS,
      response_format: RESPONSE_FORMAT as unknown as Record<string, unknown>,
    });
    text = res.text;
  } catch (e) {
    // OR→direct failover (spec: OR → direct-gemini → prefilter). Only fail over on a
    // TRANSIENT OR failure (gateway down/5xx/429/network) and only when a Gemini key
    // is configured — a 4xx client bug would just re-fail directly, so it propagates.
    // If direct also fails we throw ClassifierError carrying BOTH causes, and the
    // orchestrator drops to the regex prefilter route (degraded:true).
    if (geminiApiKey && isTransientError(e)) {
      try {
        text = await classifyDirect(geminiApiKey, prompt);
        console.error("[ask_oracle] classifier OR transient fail — direct-gemini failover succeeded");
      } catch (e2) {
        throw new ClassifierError(
          `classifier transport failed (OR + direct): OR=${(e as Error).message}; direct=${(e2 as Error).message}`,
        );
      }
    } else {
      throw new ClassifierError(`classifier transport failed: ${(e as Error).message}`);
    }
  }
  return parseClassification(text);
}

/** Direct-SDK classify (OR→direct failover leg). Uses @google/genai structured
 *  output (responseSchema) so the result still parses via parseClassification.
 *  Returns the raw JSON text; THROWS on transport failure for classify() to bundle. */
async function classifyDirect(geminiApiKey: string, prompt: string): Promise<string> {
  const res = await callGemini(makeGeminiClient(geminiApiKey), prompt, {
    system: SYSTEM_PROMPT,
    model: CLASSIFIER_MODEL_DIRECT,
    reasoning_effort: "low", // flash-lite is non-pro: thinkingConfig is skipped anyway
    response_schema: DIRECT_RESPONSE_SCHEMA,
  });
  return res.text;
}

/**
 * Parse + validate a classifier payload. Exported for unit tests (no network).
 * Strips ``` fences (a fallback model may add them despite response_format),
 * JSON.parses, then validates/coerces every field; THROWS ClassifierError on any
 * unrecoverable shape problem. Coercions are conservative: clamp panel_n to 1-4,
 * unknown lens → "default"; enums for difficulty/effort must be valid or we throw.
 */
export function parseClassification(raw: string): Classification {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let obj: any;
  try {
    obj = JSON.parse(stripped);
  } catch {
    throw new ClassifierError(`classifier output not JSON: ${raw.slice(0, 200)}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new ClassifierError("classifier output was not a JSON object");
  }

  const difficulty = obj.difficulty;
  if (!["trivial", "simple", "moderate", "hard"].includes(difficulty)) {
    throw new ClassifierError(`bad difficulty: ${JSON.stringify(obj.difficulty)}`);
  }
  const reasoning_effort = obj.reasoning_effort;
  if (!["low", "medium", "high"].includes(reasoning_effort)) {
    throw new ClassifierError(`bad reasoning_effort: ${JSON.stringify(obj.reasoning_effort)}`);
  }

  const domains = Array.isArray(obj.domains)
    ? obj.domains.filter((d: unknown) => typeof d === "string")
    : [];

  // Unknown lens is NOT fatal — degrade to default rather than reject a whole
  // route over a frame name (the override path can still force any lens).
  const suggested_lens: LensName = (LENS_NAMES as readonly string[]).includes(obj.suggested_lens)
    ? obj.suggested_lens
    : "default";

  const nRaw = Number(obj.suggested_panel_n);
  const suggested_panel_n = Number.isFinite(nRaw) ? Math.min(4, Math.max(1, Math.round(nRaw))) : 1;

  return {
    difficulty,
    domains,
    needs_x: !!obj.needs_x,
    needs_grounding: !!obj.needs_grounding,
    suggested_lens,
    suggested_panel_n,
    reasoning_effort,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}
