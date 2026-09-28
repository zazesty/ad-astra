/**
 * Shared model pins (oracle, panel, classifier).
 * Bump deliberately when the OpenRouter / provider catalog moves.
 * Prefer versioned pins over floating aliases unless latency-irrelevant.
 */

/** OpenAI diversity seat — GPT-6 Sol. Blank effort stays at Sol's medium default. */
export const GPT_OPENROUTER_SLUG = "openai/gpt-6-sol";

/**
 * OpenRouter Auto Router seat (overflow / n=1 default).
 * `openrouter/auto` (NotDiamond) is **deprecated** — use Auto Beta
 * (`openrouter/auto-beta`): task-type rankings from live community spend.
 * Docs: https://openrouter.ai/docs/guides/routing/routers/auto-router
 */
export const OPENROUTER_AUTO_SLUG = "openrouter/auto-beta";

/**
 * ask_panel Claude seat via OpenRouter (Anthropic): sonnet only.
 * `model:"opus"` and an opus model_slug still remap to sonnet (callers that
 * cached the old enum). The public schema no longer lists opus. Floating
 * `~…-latest` aliases track the current gen (verified 2026-08: sonnet-5).
 * Versioned pin if the alias 404s: anthropic/claude-sonnet-5.
 */
export const CLAUDE_OPUS_OPENROUTER_SLUG = "~anthropic/claude-opus-latest";
export const CLAUDE_SONNET_OPENROUTER_SLUG = "~anthropic/claude-sonnet-latest";

/**
 * Gemini flash-lite generation (classifier + research_fanout *decompose* only —
 * evidence limbs are pro/grounded, not flash-lite).
 *
 * OpenRouter has no `gemini-flash-lite-latest` alias (the classifier calls OR first).
 * AI Studio does have `gemini-flash-lite-latest`. The pin stays versioned.
 *
 * **Upgrade recipe:** change `GEMINI_FLASH_LITE_VER` only (e.g. `"3.6-flash-lite"`).
 * OR + direct slugs derive from it. Failover is transport-level (OR → AI Studio
 * direct, same generation) — not an older flash-lite gen.
 */
export const GEMINI_FLASH_LITE_VER = "3.5-flash-lite";
export const GEMINI_FLASH_LITE_OR = `google/gemini-${GEMINI_FLASH_LITE_VER}` as const;
export const GEMINI_FLASH_LITE_DIRECT = `gemini-${GEMINI_FLASH_LITE_VER}` as const;
