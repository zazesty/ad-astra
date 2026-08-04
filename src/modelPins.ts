/**
 * Shared model pins (oracle, panel, classifier).
 * Bump deliberately when the OpenRouter / provider catalog moves.
 * Prefer versioned pins over floating aliases unless latency-irrelevant.
 */

/** OpenAI diversity seat — GPT-5.6 Terra (~5.5-competitive, lower cost than sol). */
export const GPT_OPENROUTER_SLUG = "openai/gpt-5.6-terra";

/**
 * Gemini flash-lite generation (classifier + research_fanout *decompose* only —
 * evidence limbs are pro/grounded, not flash-lite).
 *
 * **No** `gemini-flash-lite-latest` / `~google/gemini-flash-lite-latest` exists on
 * OpenRouter or AI Studio (re-checked 2026-08). Only versioned pins work.
 *
 * **Upgrade recipe:** change `GEMINI_FLASH_LITE_VER` only (e.g. `"3.6-flash-lite"`).
 * OR + direct slugs derive from it. Failover is transport-level (OR → AI Studio
 * direct, same generation) — not an older flash-lite gen.
 */
export const GEMINI_FLASH_LITE_VER = "3.5-flash-lite";
export const GEMINI_FLASH_LITE_OR = `google/gemini-${GEMINI_FLASH_LITE_VER}` as const;
export const GEMINI_FLASH_LITE_DIRECT = `gemini-${GEMINI_FLASH_LITE_VER}` as const;
