#!/usr/bin/env node
/**
 * Bootstrap helper for tier1-personal-sync.
 * Merges and deduplicates exported memories from Claude, Grok, and Gemini.
 *
 * Usage:
 *   node scripts/bootstrap-tier1-personal-sync.mjs [--claude file] [--grok file] [--gemini file] [--apply]
 *
 * Without --apply, prints a dry-run merge + conflict summary (JSON/text).
 * Accepts JSON arrays of strings/{text} or newline/bullet-delimited text files.
 */
import { readFile } from "node:fs/promises";
import {
  defaultMemoryDir,
  loadTier1Archive,
  mergeBootstrapExports,
  saveTier1Archive,
} from "../build/personalMemorySync.js";

function parseExportText(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.memories)) return parsed.memories;
      if (Array.isArray(parsed.items)) return parsed.items;
    } catch {}
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const args = process.argv.slice(2);
const files = {};
let apply = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") {
    apply = true;
  } else if (["--claude", "--grok", "--gemini", "--gpt"].includes(args[i]) && args[i + 1]) {
    files[args[i].slice(2)] = args[++i];
  }
}

if (Object.keys(files).length === 0) {
  console.error("Usage: node scripts/bootstrap-tier1-personal-sync.mjs [--claude file] [--grok file] [--gemini file] [--apply]");
  process.exit(2);
}

const exportsByClient = {};
for (const [client, path] of Object.entries(files)) {
  const raw = await readFile(path, "utf8");
  exportsByClient[client] = parseExportText(raw);
}

const merged = mergeBootstrapExports(exportsByClient);
console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  stats: merged.stats,
  canonical_count: merged.canonical.length,
  conflict_count: merged.conflicts.length,
  conflicts: merged.conflicts,
  canonical: merged.canonical.map((c) => ({ id: c.id, sources: c.sources, text: c.text })),
}, null, 2));

if (apply) {
  if (merged.conflicts.length > 0) {
    console.error(`Refusing --apply: resolve ${merged.conflicts.length} conflict(s) before writing tier1-personal-sync.`);
    process.exit(1);
  }
  const memoryDir = defaultMemoryDir();
  const existing = await loadTier1Archive(memoryDir);
  const now = new Date().toISOString();
  const saved = await saveTier1Archive(memoryDir, {
    exists: true,
    version: existing.version + 1,
    updated: now,
    active: merged.canonical,
    tombstones: existing.tombstones,
    clients: existing.clients,
  });
  console.error(`Saved tier1-personal-sync v${saved.version} (${merged.canonical.length} active items) to ${memoryDir}`);
}
