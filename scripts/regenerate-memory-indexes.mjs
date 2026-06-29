#!/usr/bin/env node
/** One-shot backfill: regenerate MEMORY.md + index.md and optionally embed all facts. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { regenerateIndexes, loadAllFacts } from "../build/memory.js";
import {
  embedFactText,
  embedTextForFact,
  loadEmbeddings,
  saveEmbeddings,
} from "../build/memoryEmbeddings.js";

const dir = process.env.MEMORY_DIR || "/root/memory";
const apiKey = process.env.GEMINI_API_KEY;

const { factCount } = await regenerateIndexes(dir);
let embedded = 0;

if (apiKey) {
  const facts = await loadAllFacts(dir);
  const store = await loadEmbeddings(dir);
  for (const fact of facts) {
    const vec = await embedFactText(apiKey, embedTextForFact(fact));
    if (vec) {
      store[fact.id] = vec;
      embedded++;
    }
  }
  await saveEmbeddings(dir, store);
}

console.log(JSON.stringify({ ok: true, factCount, embedded, dir }));