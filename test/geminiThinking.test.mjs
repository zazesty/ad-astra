/**
 * Run after npm run build: node test/geminiThinking.test.mjs
 */
import { geminiHonorsThinking, geminiRequestsPriority } from "../build/geminiCore.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name); }
}

check("flash-latest thinks", geminiHonorsThinking("~google/gemini-flash-latest"));
check("direct flash-latest thinks", geminiHonorsThinking("gemini-flash-latest"));
check("argon thinks", geminiHonorsThinking("google/gemini-4-argon"));
check("direct argon thinks", geminiHonorsThinking("gemini-4-argon"));
check("3.8 flash thinks", geminiHonorsThinking("gemini-3.8-flash"));
check("pro-latest thinks", geminiHonorsThinking("gemini-pro-latest"));
check("flash-lite does not", !geminiHonorsThinking("google/gemini-3.5-flash-lite"));
check("2.5 flash does not", !geminiHonorsThinking("gemini-2.5-flash"));
check("sonnet is not gemini thinking", !geminiHonorsThinking("~anthropic/claude-sonnet-latest"));

check("flash does not ask priority", !geminiRequestsPriority("~google/gemini-flash-latest"));
check("3.8 flash does not ask priority", !geminiRequestsPriority("gemini-3.8-flash"));
check("flash-lite does not ask priority", !geminiRequestsPriority("google/gemini-3.5-flash-lite"));
check("direct flash-lite does not ask priority", !geminiRequestsPriority("gemini-3.5-flash-lite"));
check("argon still asks priority", geminiRequestsPriority("google/gemini-4-argon"));
check("direct argon still asks priority", geminiRequestsPriority("gemini-4-argon"));
check("pro still asks priority", geminiRequestsPriority("~google/gemini-pro-latest"));
check("sol is not gemini priority", !geminiRequestsPriority("~openai/gpt-sol-latest"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
