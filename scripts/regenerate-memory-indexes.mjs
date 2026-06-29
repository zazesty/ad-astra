#!/usr/bin/env node
/** One-shot backfill: regenerate MEMORY.md + index.md from per-fact files. */
import { regenerateIndexes } from "../build/memory.js";

const dir = process.env.MEMORY_DIR || "/root/memory";
const { factCount } = await regenerateIndexes(dir);
console.log(JSON.stringify({ ok: true, factCount, dir }));