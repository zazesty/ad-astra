/**
 * Unit tests for the Gemini OpenRouter transport's pure parser. Run AFTER
 * `npm run build` (imports the compiled helper). No network, nothing billed —
 * this only exercises extractOpenRouterResult against representative
 * chat-completions payload shapes.
 *
 *   node test/geminiCore.test.mjs
 */
import { extractOpenRouterResult, extractDirectCitations, OpenRouterError, isTransientError } from "../build/geminiCore.js";

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

console.log("\nUnit: extractDirectCitations (@google/genai groundingMetadata)");

// 6. Grounded direct response: groundingChunks[].web.uri => citations in order.
{
  const c = extractDirectCitations({
    candidates: [{ groundingMetadata: { groundingChunks: [
      { web: { uri: "https://news.example/1", title: "1" } },
      { web: { uri: "https://news.example/2", title: "2" } },
    ] } }],
  });
  check("direct grounded: uris parsed in order", c.join(",") === "https://news.example/1,https://news.example/2");
}

// 7. Ungrounded direct response (no groundingMetadata) => empty => contract fires.
{
  const c = extractDirectCitations({ candidates: [{ content: { parts: [{ text: "weights-only" }] } }] });
  check("direct ungrounded: no groundingMetadata => empty", c.length === 0);
}

// 8. Malformed/empty payload => empty, no throw.
{
  check("direct malformed => empty", extractDirectCitations({}).length === 0 && extractDirectCitations(null).length === 0);
}

// 9. isTransientError — the gate every retry + OR→direct failover keys off.
//    TRANSIENT (retry/fail-over): 429, 5xx, network (status undefined).
//    NON-transient (propagate): 4xx client errors, and any non-OpenRouterError
//    (e.g. a grounding_fired:false plain Error must NOT trigger provider failover).
{
  check("transient: 429", isTransientError(new OpenRouterError("rate", 429, true)) === true);
  check("transient: 503", isTransientError(new OpenRouterError("down", 503, true)) === true);
  check("transient: network (no status)", isTransientError(new OpenRouterError("net", undefined, true)) === true);
  check("non-transient: 400", isTransientError(new OpenRouterError("bad req", 400, false)) === false);
  check("non-transient: 401", isTransientError(new OpenRouterError("auth", 401, false)) === false);
  check("non-transient: plain Error (grounding fail-loud)", isTransientError(new Error("grounding_fired:false")) === false);
  check("non-transient: non-error value", isTransientError("nope") === false && isTransientError(undefined) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
