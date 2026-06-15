/**
 * Unit tests for the Gemini OpenRouter transport's pure parser. Run AFTER
 * `npm run build` (imports the compiled helper). No network, nothing billed —
 * this only exercises extractOpenRouterResult against representative
 * chat-completions payload shapes.
 *
 *   node test/geminiCore.test.mjs
 */
import { extractOpenRouterResult } from "../build/geminiCore.js";

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

console.log("Unit: extractOpenRouterResult");

// 1. Ungrounded: content only, no annotations => empty citations.
{
  const r = extractOpenRouterResult({
    model: "google/gemini-3.1-pro-preview",
    choices: [{ message: { role: "assistant", content: "Plain answer." } }],
  });
  check("ungrounded: content parsed", r.text === "Plain answer.");
  check("ungrounded: no citations => empty array", r.citations.length === 0);
}

// 2. Grounded: url_citation annotations => citations extracted in order.
{
  const r = extractOpenRouterResult({
    choices: [
      {
        message: {
          role: "assistant",
          content: "Grounded answer.",
          annotations: [
            { type: "url_citation", url_citation: { url: "https://example.com/a", title: "A" } },
            { type: "url_citation", url_citation: { url: "https://example.com/b", title: "B" } },
          ],
        },
      },
    ],
  });
  check("grounded: content parsed", r.text === "Grounded answer.");
  check("grounded: both citations parsed in order", r.citations.join(",") === "https://example.com/a,https://example.com/b");
}

// 3. Tolerates a flat annotation.url (defensive fallback) alongside the nested shape.
{
  const r = extractOpenRouterResult({
    choices: [{ message: { content: "x", annotations: [{ url: "https://flat.example/1" }] } }],
  });
  check("flat annotation.url fallback parsed", r.citations.includes("https://flat.example/1"));
}

// 4. Missing/empty content => placeholder, never throws.
{
  const r = extractOpenRouterResult({ choices: [{ message: { role: "assistant" } }] });
  check("missing content => placeholder", r.text === "(no content returned)");
  check("missing content => empty citations", r.citations.length === 0);
}

// 5. Malformed payload (no choices) => placeholder + empty, no throw.
{
  const r = extractOpenRouterResult({});
  check("no choices => placeholder", r.text === "(no content returned)" && r.citations.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
