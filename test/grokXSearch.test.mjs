/**
 * Regression tests for grok_x_search. Run AFTER `npm run build` (imports the
 * compiled helper) with the MCP service running.
 *
 *   node test/grokXSearch.test.mjs        # uses http://127.0.0.1:3000/mcp
 *   MCP_URL=... node test/grokXSearch.test.mjs
 *
 * No test triggers a billed x_search: the empty-result case is a pure unit test
 * on buildXSearchResult, and the empty-query / malformed-date cases are rejected
 * by zod before any call to xAI.
 */
import { buildXSearchResult } from "../build/grokXSearch.js";

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

// --- Unit: buildXSearchResult (deterministic, no network) ---
console.log("Unit: buildXSearchResult");

// 1. Empty-result window: answer present, structured citations empty => hard error
{
  const r = buildXSearchResult({
    output_text: "Some confident parametric answer with no sources.",
    citations: [],
  });
  check("empty citations -> isError", r.isError === true);
  check("empty citations -> 'No live X posts' message", /No live X posts/.test(r.content?.[0]?.text ?? ""));
}

// 2. Happy path: answer + citations => success passthrough
{
  const r = buildXSearchResult({
    output_text: "Real synthesized answer.",
    citations: ["https://x.com/user/status/123"],
  });
  check("happy path -> not error", !r.isError);
  const parsed = JSON.parse(r.content[0].text);
  check("happy path -> answer passed through", parsed.answer === "Real synthesized answer.");
  check("happy path -> citation passed through", parsed.citations.includes("https://x.com/user/status/123"));
}

// --- Integration: live MCP zod validation (free; rejected pre-fetch) ---
console.log("Integration: live MCP zod validation");

async function callTool(args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "grok_x_search", arguments: args },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line.slice(5).trim());
}
const isError = (r) => r.error != null || r.result?.isError === true;

// 3. Empty query -> validation error (no billed call)
{
  const r = await callTool({ query: "" });
  check("empty query -> error", isError(r));
}

// 4. Malformed date -> validation error (no billed call)
{
  const r = await callTool({ query: "fed rate decision", from_date: "06-01-2026" });
  check("malformed from_date -> error", isError(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
