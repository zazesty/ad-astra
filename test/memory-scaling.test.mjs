/**
 * Unit tests for memory KB scaling (status filter + hybrid keyword fallback).
 * Run AFTER `npm run build`.
 *   node test/memory-scaling.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { regenerateIndexes, loadAllFacts, isActiveFact } from "../build/memory.js";
import { cosineSimilarity } from "../build/memoryEmbeddings.js";

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