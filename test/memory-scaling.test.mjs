/**
 * Unit tests for memory KB scaling (status filter + hybrid keyword fallback).
 * Run AFTER `npm run build`.
 *   node test/memory-scaling.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  regenerateIndexes,
  loadAllFacts,
  isActiveFact,
  SEMANTIC_FLOOR,
  passesSemanticFloor,
  embedQueryWithBudget,
} from "../build/memory.js";
import { cosineSimilarity, pruneEmbeddings } from "../build/memoryEmbeddings.js";

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

async function writeFact(dir, id, { description, tags, content, status }) {
  const statusLine = status && status !== "active" ? `status: ${status}\n` : "";
  const front = `---
id: ${id}
name: ${id}
description: "${description}"
${statusLine}tags:
${tags.map(t => `  - ${t}`).join("\n")}
created: 2026-06-01T00:00:00Z
updated: 2026-06-01T00:00:00Z
version: 1
related:
  []
---
${content}
`;
  await writeFile(join(dir, `${id}.md`), front, "utf8");
}

console.log("Unit: memory scaling");

check("cosineSimilarity identical", cosineSimilarity([1, 0], [1, 0]) === 1);
check("cosineSimilarity orthogonal", cosineSimilarity([1, 0], [0, 1]) === 0);

// pruneEmbeddings: orphaned vectors (deleted facts) are GC'd; valid ones survive.
{
  const store = { a: [1, 0], b: [0, 1], orphan1: [1, 1], orphan2: [2, 2] };
  const removed = pruneEmbeddings(store, ["a", "b"]);
  check("pruneEmbeddings removes orphan count", removed === 2);
  check("pruneEmbeddings keeps valid ids", "a" in store && "b" in store);
  check("pruneEmbeddings drops orphan ids", !("orphan1" in store) && !("orphan2" in store));
  check("pruneEmbeddings no-op when all valid", pruneEmbeddings(store, ["a", "b"]) === 0);
}

// A2: semantic floor — weak cosine alone must not pass; keyword or strong sem does.
{
  check("SEMANTIC_FLOOR is 0.55", SEMANTIC_FLOOR === 0.55);
  check("A2 floor: weak sem, no kw → drop", !passesSemanticFloor(0, 0.3));
  check("A2 floor: at-floor sem is exclusive (>)", !passesSemanticFloor(0, SEMANTIC_FLOOR));
  check("A2 floor: strong sem, no kw → keep", passesSemanticFloor(0, 0.56));
  check("A2 floor: keyword hit, weak sem → keep", passesSemanticFloor(1, 0.1));
  check("A2 floor: both zero → drop", !passesSemanticFloor(0, 0));
}

// A3: embed timeout/throw → null (keyword-only path), not a hung rejection.
// Use a *slow* promise (eventually settles) not a forever-pending one — forever
// hang triggers Node "unsettled top-level await" and can stall the test runner.
{
  const slow = () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve([9, 9]), 500);
      t.unref?.();
    });
  const t0 = Date.now();
  const timed = await embedQueryWithBudget(slow, 40);
  const elapsed = Date.now() - t0;
  check("A3 embed timeout returns null", timed === null);
  check("A3 embed timeout fires quickly", elapsed < 500);

  const boom = () => Promise.reject(new Error("embed 503"));
  const failed = await embedQueryWithBudget(boom, 8_000);
  check("A3 embed throw returns null", failed === null);

  const ok = await embedQueryWithBudget(async () => [0.1, 0.2], 8_000);
  check("A3 embed success returns vector", Array.isArray(ok) && ok.length === 2);
}

const dir = await mkdtemp(join(tmpdir(), "memory-scale-"));
try {
  await writeFact(dir, "active-fact", {
    description: "Active routing policy for ask_oracle.",
    tags: ["grok-mcp"],
    content: "Active body about oracle routing.\n",
    status: "active",
  });
  await writeFact(dir, "retired-fact", {
    description: "Old Hetzner box decommissioned.",
    tags: ["historical"],
    content: "Decommissioned infrastructure.\n",
    status: "superseded",
  });

  const facts = await loadAllFacts(dir);
  check("loadAllFacts includes superseded", facts.length === 2);
  check("isActiveFact filters", facts.filter(isActiveFact).length === 1);

  await regenerateIndexes(dir);
  const memory = await readFile(join(dir, "MEMORY.md"), "utf8");
  const index = await readFile(join(dir, "index.md"), "utf8");
  check("MEMORY.md excludes superseded", memory.includes("active-fact") && !memory.includes("retired-fact"));
  check("index.md archive section", index.includes("## Archive") && index.includes("retired-fact"));
  check("index.md active count", index.includes("1 active facts (2 total)"));
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);