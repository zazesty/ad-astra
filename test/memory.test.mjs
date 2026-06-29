/**
 * Unit tests for memory index regeneration. Run AFTER `npm run build`.
 *   node test/memory.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { regenerateIndexes, loadAllFacts } from "../build/memory.js";

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

async function writeFact(dir, id, { description, tags, content, related = [] }) {
  const front = `---
id: ${id}
name: ${id}
description: "${description}"
tags:
${tags.map(t => `  - ${t}`).join("\n")}
created: 2026-06-01T00:00:00Z
updated: 2026-06-01T00:00:00Z
version: 1
related:
${related.map(r => `  - ${r}`).join("\n")}
---
${content}
`;
  await writeFile(join(dir, `${id}.md`), front, "utf8");
}

console.log("Unit: regenerateIndexes");

const dir = await mkdtemp(join(tmpdir(), "memory-test-"));
try {
  await writeFact(dir, "alpha-fact", {
    description: "First alpha fact for testing.",
    tags: ["grok-mcp", "tool"],
    content: "Alpha body.\n",
  });
  await writeFact(dir, "beta-fact", {
    description: "Beta fact under infra.",
    tags: ["infra", "ops"],
    content: "Beta body.\n",
  });

  const { factCount } = await regenerateIndexes(dir);
  check("regenerates both facts", factCount === 2);

  const memory = await readFile(join(dir, "MEMORY.md"), "utf8");
  check("MEMORY.md lists alpha", memory.includes("[Alpha Fact](alpha-fact.md)"));
  check("MEMORY.md lists beta", memory.includes("[Beta Fact](beta-fact.md)"));

  const index = await readFile(join(dir, "index.md"), "utf8");
  check("index.md has preamble", index.includes("Auto-Update Protocol"));
  check("index.md grouped by grok-mcp", index.includes("### grok-mcp"));
  check("index.md grouped by infra", index.includes("### infra"));
  check("index.md alphabetical section", index.includes("## Alphabetical"));
  check("index.md fact count", index.includes("2 facts. Updated"));

  const facts = await loadAllFacts(dir);
  check("loadAllFacts skips indexes", facts.length === 2);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);