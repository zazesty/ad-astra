// Pure unit tests for newsDigest — no network, no billed calls.
// Run: node test/newsDigest.test.mjs   (also wired into `npm test`)
import assert from "node:assert";
import { dedupe, markdownToHtml, loadFeedsConfig, matchesKeywords } from "../build/newsDigest.js";

let pass = 0;
const ok = (name) => { console.log(`ok - ${name}`); pass++; };

// --- dedupe: by URL ---------------------------------------------------------
{
  const items = [
    { section: "ai", source: "A", title: "GPT-6 ships", link: "https://x.com/a?utm=1", date: "2026-06-20", snippet: "" },
    { section: "ai", source: "B", title: "Totally different headline", link: "https://x.com/a", date: "2026-06-20", snippet: "" },
  ];
  const out = dedupe(items);
  assert.equal(out.length, 1, "same URL (ignoring query/trailing slash) dedupes to 1");
  ok("dedupe collapses same-URL items");
}

// --- dedupe: by near-duplicate title ---------------------------------------
{
  const items = [
    { section: "ai", source: "A", title: "OpenAI launches GPT-6!", link: "https://a.com/1", date: "2026-06-20", snippet: "" },
    { section: "ai", source: "B", title: "OpenAI Launches GPT-6", link: "https://b.com/2", date: "2026-06-20", snippet: "" },
    { section: "ai", source: "C", title: "Something genuinely else", link: "https://c.com/3", date: "2026-06-20", snippet: "" },
  ];
  const out = dedupe(items);
  assert.equal(out.length, 2, "two normalized-identical titles dedupe; distinct one stays");
  ok("dedupe collapses near-duplicate titles across sources");
}

// --- dedupe: empty link/title don't false-collide ---------------------------
{
  const items = [
    { section: "ai", source: "A", title: "One", link: "", date: "", snippet: "" },
    { section: "ai", source: "B", title: "Two", link: "", date: "", snippet: "" },
  ];
  const out = dedupe(items);
  assert.equal(out.length, 2, "empty links must not collide");
  ok("dedupe does not false-collide on empty link");
}

// --- markdownToHtml: headers, links, lists, escaping ------------------------
{
  const html = markdownToHtml("## AI\n- [OpenAI](https://openai.com) shipped <stuff> & more\n\ntext");
  assert.ok(html.includes("<h3>AI</h3>"), "## -> h3");
  assert.ok(html.includes('<a href="https://openai.com">OpenAI</a>'), "markdown link -> anchor");
  assert.ok(html.includes("<li>"), "bullet -> li");
  assert.ok(html.includes("&lt;stuff&gt;") && html.includes("&amp;"), "html-escapes raw angle brackets/ampersands");
  ok("markdownToHtml renders headers/links/lists and escapes");
}

// --- loadFeedsConfig: real file parses and has the three sections -----------
{
  const cfg = loadFeedsConfig();
  assert.ok(cfg.sections.ai && cfg.sections.macro && cfg.sections.industry, "all three sections present");
  assert.equal(cfg.sections.industry.cap, 3, "industry section is hard-capped at 3");
  // challenger voices must be present and flagged
  const challengers = cfg.sections.macro.feeds.filter((f) => f.challenger).map((f) => f.source);
  for (const name of ["Joseph Wang / FedGuy", "Michael Pettis", "Adam Tooze / Chartbook"]) {
    assert.ok(challengers.includes(name), `${name} flagged challenger`);
  }
  ok("feeds.json parses; sections + capped industry + flagged challengers present");
}

// --- matchesKeywords: word boundaries, not substrings ----------------------
{
  const kw = ["ai", "llm", "gpt", "model", "agent"];
  // Must NOT match: "ai" buried inside other words (the firehose bug).
  assert.equal(matchesKeywords({ title: "Regrowing body parts in mammals" }, kw), false, "no substring 'ai' in mammals/remains");
  assert.equal(matchesKeywords({ title: "Systemd 261 released" }, kw), false, "unrelated systems news excluded");
  // Must match: real AI tokens as whole words, incl. hyphenated.
  assert.ok(matchesKeywords({ title: "OpenAI ships GPT-6" }, kw), "GPT-6 hits via hyphen boundary");
  assert.ok(matchesKeywords({ title: "A new agentic workflow", contentSnippet: "the agent decides" }, kw), "agent as whole word hits");
  assert.ok(matchesKeywords({ title: "Best local LLM of 2026" }, kw), "llm whole word hits");
  assert.equal(matchesKeywords({ title: "anything" }, undefined), true, "no filter = always match");
  ok("matchesKeywords uses word boundaries (no 'ai'-in-remains false positives)");
}

console.log(`\n${pass} passed`);
