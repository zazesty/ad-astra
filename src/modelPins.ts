/**
 * Shared model pins (oracle, panel, classifier).
 * Bump deliberately when the OpenRouter / provider catalog moves.
 * Prefer versioned pins over floating aliases unless latency-irrelevant.
 * Exception: GPT_OPENROUTER_SLUG is the floating Sol alias (2026-10-03).
 */

/**
 * OpenAI diversity seat. `~openai/gpt-sol-latest` always tracks the current Sol.
 * Blank effort stays at Sol's medium default. Consortium caps a classifier
 * "high" at medium. The MCP schema does not accept a caller effort override.
 */
export const GPT_OPENROUTER_SLUG = "~openai/gpt-sol-latest";

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
 * `~…-latest` aliases track the current gen (2026-10: Sonnet 5.5).
 * Omitted effort is sent as medium. Anthropic's own Sonnet 5.5 default is high.
 * Sonnet 5.5 at medium is faster, more capable, and cheaper per task than
 * Sonnet 5 at high, so the seat does not stay on Anthropic's high default.
 * The MCP schema does not accept a caller effort override. Versioned pin if the alias 404s:
 * anthropic/claude-sonnet-5.5.
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
