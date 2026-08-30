/**
 * Unit tests for Grok-chat vs Grok-Build budget envelopes + opus remap.
 *   node test/budgetProfile.test.mjs
 */
import {
  budgetProfileFromUserAgent,
  shortUserAgent,
  CLI_BUDGET,
  CHAT_BUDGET,
} from "../build/budgetProfile.js";
import { canStartAttempt, capAttemptMs, MIN_NEXT_ATTEMPT_MS } from "../build/timeouts.js";
import { applyOpusRemap } from "../build/panel.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

console.log("Unit: budgetProfile + opus remap + attempt cap");

check("grok-cli → cli", budgetProfileFromUserAgent("grok-cli/1.0.13").name === "cli");
check("grok-cli case", budgetProfileFromUserAgent("Grok-CLI/1").name === "cli");
check("empty UA → chat", budgetProfileFromUserAgent(undefined).name === "chat");
check("browser UA → chat", budgetProfileFromUserAgent("Mozilla/5.0").name === "chat");
check("chat outer 50s", budgetProfileFromUserAgent("").panelOuterMs === 50_000);
check("cli outer 110s", budgetProfileFromUserAgent("grok-cli/x").panelOuterMs === CLI_BUDGET.panelOuterMs);
check("chat OR abort < outer", CHAT_BUDGET.panelOrAttemptMs < CHAT_BUDGET.panelOuterMs);
check("cli gemini seat 100s", CLI_BUDGET.panelGeminiSeatMs === 100_000);

check("shortUserAgent truncates", shortUserAgent("x".repeat(200)).length === 120);
check("shortUserAgent strips newline", !shortUserAgent("a\nb").includes("\n"));

const recent = Date.now() - 5_000;
check("canStartAttempt plenty", canStartAttempt(recent, 50_000) === true);
const spent = Date.now() - 45_000;
check("canStartAttempt tight", canStartAttempt(spent, 50_000) === false);
check("MIN_NEXT_ATTEMPT_MS is 12s", MIN_NEXT_ATTEMPT_MS === 12_000);

check("capAttemptMs respects remaining", capAttemptMs(spent, 50_000, 40_000) < 10_000);
check("capAttemptMs floor 1s", capAttemptMs(Date.now() - 49_800, 50_000, 40_000) === 1_000);

const passthrough = applyOpusRemap({ model: "sonnet" });
check("sonnet passthrough", passthrough.model === "sonnet" && !passthrough.remapped_from);
const remapped = applyOpusRemap({ model: "opus" });
check("opus → sonnet", remapped.model === "sonnet" && remapped.remapped_from === "opus");
check("opus drops opus slug", applyOpusRemap({ model: "opus", model_slug: "~anthropic/claude-opus-latest" }).model_slug === undefined);
check(
  "opus keeps non-opus slug",
  applyOpusRemap({ model: "opus", model_slug: "~anthropic/claude-sonnet-latest" }).model_slug ===
    "~anthropic/claude-sonnet-latest",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
