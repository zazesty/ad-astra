/**
 * Run after npm run build: node test/geminiThinking.test.mjs
 */
import { geminiHonorsThinking } from "../build/geminiCore.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
}

check("flash-latest thinks", geminiHonorsThinking("~google/gemini-flash-latest"));
check("direct flash-latest thinks", geminiHonorsThinking("gemini-flash-latest"));
check("3.8 flash thinks", geminiHonorsThinking("gemini-3.8-flash"));
check("pro-latest thinks", geminiHonorsThinking("gemini-pro-latest"));
check("flash-lite does not", !geminiHonorsThinking("google/gemini-3.5-flash-lite"));
check("2.5 flash does not", !geminiHonorsThinking("gemini-2.5-flash"));
check("sonnet is not gemini thinking", !geminiHonorsThinking("~anthropic/claude-sonnet-latest"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
