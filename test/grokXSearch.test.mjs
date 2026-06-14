/**
 * Regression tests for the shared Grok core (used by grok_x_search and by
 * ask_panel's grounded Grok specs). Run AFTER `npm run build` (imports the
 * compiled helpers) with the MCP service running.
 *
 *   node test/grokXSearch.test.mjs        # uses http://127.0.0.1:3000/mcp
 *   MCP_URL=... node test/grokXSearch.test.mjs
 *
 * No test triggers a billed search: the parse + live-or-nothing contract are
 * pure unit tests on grokCore helpers, and the empty-query / malformed-date
 * cases are rejected by zod before any call to xAI.
 */
import { extractAnswerAndCitations, applyGroundingContract } from "../build/grokCore.js";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
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

// --- Unit: extractAnswerAndCitations (deterministic, no network) ---
console.log("Unit: extractAnswerAndCitations");

// 1. Flat shape: output_text + citations[]
{
  const r = extractAnswerAndCitations({
    output_text: "Real synthesized answer.",
    citations: ["https://x.com/user/status/123"],
  });
  check("flat: answer parsed", r.text === "Real synthesized answer.");
  check("flat: citation parsed", r.citations.includes("https://x.com/user/status/123"));
}

// 2. Nested Responses shape: output[].content[].text + annotations[].url
{
  const r = extractAnswerAndCitations({
    output: [
      { type: "reasoning" },
      {
        type: "message",
        content: [
          { text: "Nested answer.", annotations: [{ url: "https://x.com/a/status/9" }] },
        ],
      },
    ],
  });
  check("nested: answer parsed", r.text === "Nested answer.");
  check("nested: annotation citation parsed", r.citations.includes("https://x.com/a/status/9"));
}

// 3. No citations => empty array (the signal the contract acts on)
{
  const r = extractAnswerAndCitations({ output_text: "Sourceless parametric answer.", citations: [] });
  check("no citations => empty array", r.citations.length === 0);
}

// --- Unit: applyGroundingContract (live-or-nothing) ---
console.log("Unit: applyGroundingContract");

// 4. required + empty citations => throws "No live X posts"
{
  let threw = false;
  try {
    applyGroundingContract({ text: "Confident parametric answer.", citations: [] }, "required");
  } catch (e) {
    threw = /No live X posts/.test(e.message);
  }
  check("required + empty => throws 'No live X posts'", threw);
}

// 5. required + citations => passes through
{
  const result = { text: "Grounded answer.", citations: ["https://x.com/u/status/1"] };
  const r = applyGroundingContract(result, "required");
  check("required + citations => passthrough", r.text === "Grounded answer." && r.citations.length === 1);
}

// 6. auto + empty citations => passes through (parametric is legitimate here)
{
  const r = applyGroundingContract({ text: "Model chose not to search.", citations: [] }, "auto");
  check("auto + empty => passthrough (no throw)", r.text === "Model chose not to search.");
}

// --- Integration: live MCP zod validation (free; rejected pre-fetch) ---
console.log("Integration: live MCP zod validation");

async function callTool(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line.slice(5).trim());
}
const isError = (r) => r.error != null || r.result?.isError === true;

// 7. grok_x_search empty query -> validation error (no billed call)
{
  const r = await callTool("grok_x_search", { query: "" });
  check("grok_x_search empty query -> error", isError(r));
}

// 8. grok_x_search malformed date -> validation error (no billed call)
{
  const r = await callTool("grok_x_search", { query: "fed rate decision", from_date: "06-01-2026" });
  check("grok_x_search malformed from_date -> error", isError(r));
}

// 9. ask_panel empty specs -> validation error (no billed call)
{
  const r = await callTool("ask_panel", { specs: [] });
  check("ask_panel empty specs -> error", isError(r));
}

// 10. ask_panel spec with empty prompt -> validation error (no billed call)
{
  const r = await callTool("ask_panel", { specs: [{ model: "grok", prompt: "" }] });
  check("ask_panel empty prompt -> error", isError(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
