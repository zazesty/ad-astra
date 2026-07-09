import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import {
  cosineSimilarity,
  embedFactText,
  embedTextForFact,
  loadEmbeddings,
  saveEmbeddings,
} from "./memoryEmbeddings.js";
import { withTimeout } from "./timeouts.js";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "/root/memory";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export type FactStatus = "active" | "superseded" | "archived";

/** Verbatim preamble for index.md — survives regeneration. */
const INDEX_PREAMBLE = `# Memory KB — Index & TOC

Shared, MCP-queryable KB for zaz-astra/grok-mcp/Grok Build.
Location: /root/memory/ (Claude auto-memory via autoMemoryDirectory setting).
Tools: memory_search, memory_retrieve, memory_upsert, memory_list.
Resource: memory://index (no tool call).

**Auto-Update Protocol (for Grok Build + Claude alike):**
Whoever's turn it is (the active agent) does the extraction at end of substantive turns.
1. Only after substantive work (new decisions, gotchas, patterns, configs, architecture — not no-ops).
2. Extract *only the delta* (concise, few-K tokens). Never re-read whole store.
3. High-confidence only (model judgment: novel + useful + not obvious).
4. \`memory_search\` first (query + tags) to dedup/check conflicts.
5. If warranted: \`memory_upsert\` (full tags/related, clean body, no frontmatter).
6. On conflict: flag in content or via simple status in response; never silent overwrite.
7. Mirror journaling: usage/substance gated. Cheap. MCP tools are the authority.
8. Auto-harvest: during upsert, [[slugs]] in body are auto-added to related[].

Use this protocol symmetrically. Both agents have identical access via the MCP.

**NOTE:** \`MEMORY.md\` and \`index.md\` are auto-regenerated on every \`memory_upsert\`
from each fact's frontmatter ([[memory-system-structure]]). The reliable cron harvester
trigger is separate — see [[grok-build-auto-update-gates]].

`;

export interface MemoryFact {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: FactStatus;
  superseded_by?: string;
  created: string;
  updated: string;
  version: number;
  related: string[];
  content: string;
  metadata?: Record<string, any>;
}

function parseStatus(v: unknown): FactStatus {
  if (v === "superseded" || v === "archived") return v;
  return "active";
}

export function isActiveFact(f: MemoryFact): boolean {
  return f.status === "active";
}

function ensureArray(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    return v.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function parseFrontmatter(raw: string): { data: Record<string, any>; body: string; originalFront: string } {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) {
    return { data: {}, body: raw.trim(), originalFront: "" };
  }
  const front = m[1];
  const body = m[2].trim();
  const data: Record<string, any> = {};
  const lines = front.split(/\r?\n/);
  let inMetadata = false;
  let listKey: string | null = null;
  const lists: Record<string, string[]> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "metadata:") {
      inMetadata = true;
      data.metadata = {};
      listKey = null;
      continue;
    }
    if (inMetadata && trimmed.startsWith("-")) {
      // skip, we don't deeply parse yet
      continue;
    }

    const kv = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) {
      let key = kv[1];
      let val = kv[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      if (inMetadata) {
        (data.metadata as any)[key] = val;
      } else {
        if (key === "tags" || key === "related") {
          listKey = key;
          lists[key] = [];
          // inline array support
          if (val.startsWith("[") && val.endsWith("]")) {
            lists[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
            listKey = null;
          }
        } else {
          data[key] = val;
          listKey = null;
        }
      }
      continue;
    }

    // list continuation
    if (listKey && trimmed.startsWith("-")) {
      const item = trimmed.replace(/^-+\s*/, "").trim().replace(/^"|"$/g, "");
      if (!lists[listKey]) lists[listKey] = [];
      lists[listKey].push(item);
    }
  }

  if (lists.tags) data.tags = lists.tags;
  if (lists.related) data.related = lists.related;

  return { data, body, originalFront: `---\n${front}\n---\n` };
}

async function readFact(filePath: string): Promise<MemoryFact | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const id = data.id || basename(filePath, ".md");
    const name = data.name || id;
    const description = data.description || "";
    const tags = ensureArray(data.tags);
    const related = ensureArray(data.related);
    const created = data.created || new Date().toISOString();
    const updated = data.updated || created;
    const version = Number(data.version) || 1;

    const fact: MemoryFact = {
      id,
      name,
      description,
      tags,
      status: parseStatus(data.status),
      superseded_by: data.superseded_by || undefined,
      created,
      updated,
      version,
      related,
      content: body,
    };
    if (data.metadata) fact.metadata = data.metadata;
    return fact;
  } catch {
    return null;
  }
}

async function listFactFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md" && e.name !== "index.md")
    .map(e => join(dir, e.name));
}

export async function loadAllFacts(dir: string): Promise<MemoryFact[]> {
  const files = await listFactFiles(dir);
  const facts: MemoryFact[] = [];
  for (const f of files) {
    const fact = await readFact(f);
    if (fact) facts.push(fact);
  }
  return facts;
}

function humanizeTitle(fact: MemoryFact): string {
  const raw = fact.name && fact.name !== fact.id ? fact.name : fact.id;
  return raw
    .split("-")
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Near-duplicate check for upsert conflict_flag (name or description collision). */
function detectNearDuplicate(
  candidate: { id: string; name: string; description: string },
  facts: MemoryFact[],
): string | null {
  const cName = normalizeForCompare(candidate.name);
  const cDesc = normalizeForCompare(candidate.description || "");
  for (const f of facts) {
    if (f.id === candidate.id) continue;
    if (cName && normalizeForCompare(f.name) === cName) return f.id;
    if (cDesc.length >= 24 && normalizeForCompare(f.description) === cDesc) return f.id;
  }
  return null;
}

function buildMemoryMd(facts: MemoryFact[]): string {
  const active = facts.filter(isActiveFact);
  const lines = active
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(f => `- [${humanizeTitle(f)}](${f.id}.md) — ${f.description}`);
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function buildIndexMd(facts: MemoryFact[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const active = facts.filter(isActiveFact);
  const archived = facts.filter((f) => !isActiveFact(f));
  const sorted = active.slice().sort((a, b) => a.id.localeCompare(b.id));

  const byTag = new Map<string, MemoryFact[]>();
  for (const f of sorted) {
    const tag = f.tags[0] || "misc";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(f);
  }

  const grouped: string[] = ["## Grouped by primary tag", ""];
  for (const tag of [...byTag.keys()].sort()) {
    grouped.push(`### ${tag}`);
    for (const f of byTag.get(tag)!) {
      const desc = f.description.length > 100 ? f.description.slice(0, 97) + "..." : f.description;
      const tagStr = f.tags.join(" ");
      grouped.push(`- [${f.id}](${f.id}.md) — ${desc}  \`${tagStr}\``);
    }
    grouped.push("");
  }

  const alpha: string[] = ["## Alphabetical", ""];
  for (const f of sorted) {
    alpha.push(`- [${f.id}](${f.id}.md) \`${f.tags.join(" ")}\``);
  }

  const archiveSection: string[] = [];
  if (archived.length) {
    archiveSection.push("## Archive", "");
    for (const f of archived.sort((a, b) => a.id.localeCompare(b.id))) {
      archiveSection.push(`- [${f.id}](${f.id}.md) \`${f.status}\` \`${f.tags.join(" ")}\``);
    }
    archiveSection.push("");
  }

  return (
    INDEX_PREAMBLE +
    `${active.length} active facts (${facts.length} total). Updated ${date}\n\n` +
    grouped.join("\n") +
    "\n" +
    alpha.join("\n") +
    "\n" +
    archiveSection.join("\n")
  );
}

/** Regenerate MEMORY.md + index.md from all per-fact files. */
export async function regenerateIndexes(dir: string): Promise<{ factCount: number }> {
  await mkdir(dir, { recursive: true });
  const facts = await loadAllFacts(dir);
  await writeFile(join(dir, "MEMORY.md"), buildMemoryMd(facts), "utf8");
  await writeFile(join(dir, "index.md"), buildIndexMd(facts), "utf8");
  return { factCount: facts.length };
}

function keywordScore(fact: MemoryFact, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  let score = 0;
  if (fact.name.toLowerCase().includes(q)) score += 4;
  if (fact.description.toLowerCase().includes(q)) score += 3;
  if (fact.tags.some(t => t.toLowerCase().includes(q))) score += 2;
  if (fact.content.toLowerCase().includes(q)) score += 1;
  return score;
}

function matchesQuery(fact: MemoryFact, query: string): boolean {
  return keywordScore(fact, query) > 0;
}

function hasAllTags(fact: MemoryFact, tags: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const set = new Set(fact.tags.map(t => t.toLowerCase()));
  return tags.every(t => set.has(t.toLowerCase()));
}

async function searchFacts(
  dir: string,
  opts: { query?: string; tags?: string[]; limit?: number; expand_related?: boolean; include_archived?: boolean },
): Promise<any> {
  const all = await loadAllFacts(dir);
  const pool = opts.include_archived ? all : all.filter(isActiveFact);
  const tagFiltered = pool.filter((f) => hasAllTags(f, opts.tags || []));
  const query = (opts.query || "").trim();
  const limit = Math.min(opts.limit ?? 10, 50);

  let ranked: { fact: MemoryFact; score: number; kw?: number; sem?: number }[];

  if (query) {
    const embeddings = await loadEmbeddings(dir);
    let queryVec: number[] | null = null;
    // A3: embed has a hard timeout → fall back to keyword-only (no hang).
    if (GEMINI_API_KEY) {
      try {
        queryVec = await withTimeout(embedFactText(GEMINI_API_KEY, query), 8_000, "memory_search embed");
      } catch (e) {
        console.error(`[memory_search] embed timed out/failed — keyword-only: ${(e as Error)?.message ?? e}`);
        queryVec = null;
      }
    }

    // A2: semantic floor — cosine is almost always >0 once vectors exist, so
    // score>0 alone returned "limit" irrelevant facts. Require real keyword hit
    // OR semantic similarity above threshold.
    const SEM_FLOOR = 0.55;
    ranked = tagFiltered.map((fact) => {
      const kw = keywordScore(fact, query);
      let sem = 0;
      const vec = embeddings[fact.id];
      if (queryVec && vec?.length) {
        sem = cosineSimilarity(queryVec, vec);
      }
      const score = sem * 10 + kw;
      return { fact, score, kw, sem };
    });
    ranked = ranked
      .filter((r) => (r.kw ?? 0) > 0 || (r.sem ?? 0) > SEM_FLOOR)
      .sort((a, b) => b.score - a.score || (b.fact.updated || "").localeCompare(a.fact.updated || ""));
  } else {
    ranked = tagFiltered
      .map((fact) => ({ fact, score: 0 }))
      .sort((a, b) => (b.fact.updated || "").localeCompare(a.fact.updated || ""));
  }

  const filtered = ranked.map((r) => r.fact);
  let results = filtered.slice(0, limit).map(f => ({
    id: f.id,
    name: f.name,
    description: f.description,
    tags: f.tags,
    updated: f.updated,
    excerpt: f.content.slice(0, 220).replace(/\s+/g, " ").trim() + (f.content.length > 220 ? "..." : ""),
    related: f.related || [],
  }));
  if (opts.expand_related) {
    const seen = new Set(results.map(r => r.id));
    const extra: any[] = [];
    for (const f of results) {
      for (const rid of f.related || []) {
        if (!seen.has(rid)) {
          const rf = all.find(ff => ff.id === rid);
          // D1: honor include_archived on expand_related
          if (rf && (opts.include_archived || isActiveFact(rf))) {
            extra.push({
              id: rf.id,
              name: rf.name,
              description: rf.description,
              tags: rf.tags,
              updated: rf.updated,
              excerpt: rf.content.slice(0, 150).replace(/\s+/g, " ").trim() + "...",
              related: rf.related || [],
              _via: f.id,
            });
            seen.add(rid);
          }
        }
      }
    }
    results = [...results, ...extra];
  }
  return {
    count: results.length,
    total: filtered.length,
    facts: results,
    expanded: !!opts.expand_related,
  };
}

async function retrieveFact(dir: string, id: string): Promise<any> {
  const files = await listFactFiles(dir);
  for (const f of files) {
    if (basename(f, ".md") === id) {
      const fact = await readFact(f);
      if (fact) {
        return {
          id: fact.id,
          name: fact.name,
          description: fact.description,
          tags: fact.tags,
          created: fact.created,
          updated: fact.updated,
          version: fact.version,
          related: fact.related,
          content: fact.content,
          metadata: fact.metadata || undefined,
        };
      }
    }
  }
  throw new Error(`Fact not found: ${id}`);
}

function buildFrontmatter(fact: MemoryFact): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${fact.id}`);
  lines.push(`name: ${fact.name}`);
  if (fact.status && fact.status !== "active") {
    lines.push(`status: ${fact.status}`);
  }
  if (fact.superseded_by) {
    lines.push(`superseded_by: ${fact.superseded_by}`);
  }
  if (fact.description) {
    const desc = fact.description.replace(/"/g, '\\"');
    lines.push(`description: "${desc}"`);
  }
  lines.push("tags:");
  if (fact.tags.length) {
    for (const t of fact.tags) lines.push(`  - ${t}`);
  } else {
    lines.push("  []");
  }
  lines.push(`created: ${fact.created}`);
  lines.push(`updated: ${fact.updated}`);
  lines.push(`version: ${fact.version}`);
  lines.push("related:");
  if (fact.related.length) {
    for (const r of fact.related) lines.push(`  - ${r}`);
  } else {
    lines.push("  []");
  }
  if (fact.metadata && Object.keys(fact.metadata).length) {
    lines.push("metadata:");
    for (const [k, v] of Object.entries(fact.metadata)) {
      const val = typeof v === "string" ? `"${v.replace(/"/g, '\\"')}"` : v;
      lines.push(`  ${k}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

async function upsertFact(dir: string, input: {
  id?: string;
  name: string;
  description?: string;
  content: string;
  tags?: string[];
  related?: string[];
  status?: FactStatus;
  superseded_by?: string;
}): Promise<MemoryFact> {
  const id = (input.id || input.name).replace(/\.md$/, "");
  const filePath = join(dir, `${id}.md`);

  let existing: MemoryFact | null = null;
  try {
    const raw = await readFile(filePath, "utf8");
    existing = await readFact(filePath);
  } catch {}

  // Auto-harvest [[slug]] from content into related (clarified: scans body for [[id]] patterns
  // and unions them into related[] so the fact graph builds itself with zero extra work).
  const harvested: string[] = [];
  const re = /\[\[([a-z0-9_-]+)\]\]/g;
  let m;
  const contentForHarvest = input.content || "";
  while ((m = re.exec(contentForHarvest))) {
    let slug = m[1];
    if (slug.endsWith(".md")) slug = slug.slice(0, -3);
    if (slug !== id && !harvested.includes(slug)) harvested.push(slug);
  }
  const baseRelated = input.related || existing?.related || [];
  const mergedRelated = [...new Set([...baseRelated, ...harvested])].filter(Boolean);

  const now = new Date().toISOString();
  const fact: MemoryFact = {
    id,
    name: input.name,
    description: input.description || (existing?.description || ""),
    tags: (input.tags || existing?.tags || []).filter(Boolean),
    status: input.status ?? existing?.status ?? "active",
    superseded_by: input.superseded_by ?? existing?.superseded_by,
    created: existing?.created || now,
    updated: now,
    version: (existing?.version || 0) + 1,
    related: mergedRelated,
    content: input.content.trim(),
    metadata: existing?.metadata,
  };

  const front = buildFrontmatter(fact);
  const full = front + fact.content + (fact.content.endsWith("\n") ? "" : "\n");
  await writeFile(filePath, full, "utf8");

  if (GEMINI_API_KEY) {
    const vec = await embedFactText(GEMINI_API_KEY, embedTextForFact(fact));
    if (vec) {
      const store = await loadEmbeddings(dir);
      store[fact.id] = vec;
      await saveEmbeddings(dir, store);
    }
  }

  await regenerateIndexes(dir);

  return fact;
}

async function listFacts(dir: string, tags?: string[], limit?: number, includeArchived?: boolean): Promise<any> {
  const all = await loadAllFacts(dir);
  const base = includeArchived ? all : all.filter(isActiveFact);
  const filtered = tags && tags.length
    ? base.filter(f => hasAllTags(f, tags))
    : base;
  const lim = Math.min(limit ?? 100, 200);
  const items = filtered
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, lim)
    .map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      tags: f.tags,
      status: f.status,
      updated: f.updated,
      version: f.version,
    }));
  return { count: items.length, total: filtered.length, facts: items };
}

export function loadMemoryIndexRaw(): string {
  try {
    return readFileSync(join(MEMORY_DIR, "index.md"), "utf8");
  } catch {
    return "(no memory index.md yet)";
  }
}

export function registerMemoryTools(server: any) {
  // Ensure dir exists (defensive)
  mkdir(MEMORY_DIR, { recursive: true }).catch(() => {});

  server.registerTool(
    "memory_search",
    {
      title: "Memory Search",
      description:
        "Search the shared cross-harness memory KB (facts, decisions, gotchas, setup; the single source of truth also used by Claude Code auto-memory). Hybrid search: tag filter (hard AND pre-filter) → semantic cosine rank → keyword boost/fallback. Defaults to active facts only. Returns headers + excerpts. Discovery tool — follow up with memory_retrieve for bodies. For a plain unfiltered enumeration with no keyword, prefer memory_list (cheaper, headers-only). Tags without a query → tag-filtered facts newest-first (like a filtered list, but with this tool's field weighting).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Free-text search across name, description and body. Omit for tag-only listing."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Only return facts containing ALL of these tags (AND filter)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum results to return (default 10)."),
        expand_related: z
          .boolean()
          .optional()
          .describe("If true, also include 1-hop related facts (via related[] links) for better discovery. Default false."),
        include_archived: z
          .boolean()
          .optional()
          .describe("If true, include superseded/archived facts (default false — active only)."),
      },
    },
    async ({ query, tags, limit, expand_related, include_archived }: { query?: string; tags?: string[]; limit?: number; expand_related?: boolean; include_archived?: boolean }) => {
      try {
        const res = await searchFacts(MEMORY_DIR, { query, tags, limit, expand_related, include_archived });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `memory_search failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_retrieve",
    {
      title: "Memory Retrieve",
      description:
        "Return one complete fact by id (the stable slug used as filename and key). [[slug]] refers to this id. Includes normalized frontmatter fields + full markdown body. Call after search or when you have a [[id]]. Part of the single source of truth shared with Claude Code auto-memory.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Fact id (e.g. 'grok-mcp-setup' or 'astra-mcp-path-is-a-secret')."),
      },
    },
    async ({ id }: { id: string }) => {
      try {
        const fact = await retrieveFact(MEMORY_DIR, id);
        return { content: [{ type: "text", text: JSON.stringify(fact, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `memory_retrieve failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_upsert",
    {
      title: "Memory Upsert",
      description:
        "Create or update a fact in the shared KB (the single source of truth also used by Claude Code auto-memory + Grok Build). On update: omitted fields are preserved; any field you pass completely replaces the previous value (tags/related arrays are replaced, not unioned — send the full desired set). Bumps updated + version. Provide clean markdown body only (no --- frontmatter block). If editing a fact retrieved via memory_retrieve, strip the frontmatter it returned before sending. This is the only write path for auto-update and cross-harness facts. COLLISION: keyed by EXACT id (input.id, else input.name; kebab-case by convention — NOT auto-slugified). An existing id updates/merges in place; a near-duplicate id creates a SEPARATE fact — there is no fuzzy dedup, so memory_search first to avoid clobbering or duplicating a fact.",
      inputSchema: {
        id: z.string().optional().describe("Optional explicit id/slug. Defaults to sanitized `name`."),
        name: z
          .string()
          .min(1)
          .describe("Stable kebab-case slug; also serves as the id unless id is explicitly set (e.g. 'my-new-fact'). Used for filename and lookup."),
        description: z.string().optional().describe("One-line summary for the index."),
        content: z
          .string()
          .min(1)
          .describe("Full markdown body (without the leading --- frontmatter block)."),
        tags: z.array(z.string()).optional().describe("Tags for filtering and organization."),
        related: z.array(z.string()).optional().describe("Related fact ids (for graph navigation)."),
        status: z
          .enum(["active", "superseded", "archived"])
          .optional()
          .describe("Lifecycle status (default active). Use superseded/archived to retire facts."),
        superseded_by: z
          .string()
          .optional()
          .describe("When superseding, id of the replacement fact."),
      },
    },
    async (input: { id?: string; name: string; description?: string; content: string; tags?: string[]; related?: string[]; status?: FactStatus; superseded_by?: string }) => {
      try {
        const id = (input.id || input.name).replace(/\.md$/, "");
        let hadExisting = false;
        try {
          await readFile(join(MEMORY_DIR, `${id}.md`), "utf8");
          hadExisting = true;
        } catch {}

        const allFacts = await loadAllFacts(MEMORY_DIR);
        const conflictWith = detectNearDuplicate(
          { id, name: input.name, description: input.description || "" },
          allFacts.filter(f => !hadExisting || f.id !== id),
        );

        const fact = await upsertFact(MEMORY_DIR, input);
        const supersedeHint = conflictWith
          ? `Near-duplicate of '${conflictWith}' — consider superseding the old fact (status:superseded, superseded_by:${fact.id}) instead of creating a twin.`
          : undefined;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              id: fact.id,
              updated: fact.updated,
              version: fact.version,
              tags: fact.tags,
              fact_status: fact.status,
              upsert_action: hadExisting ? "updated_existing" : "created",
              conflict_flag: !!conflictWith,
              conflict_with: conflictWith || undefined,
              supersede_hint: supersedeHint,
            }, null, 2)
          }]
        };
      } catch (err) {
        return { content: [{ type: "text", text: `memory_upsert failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "memory_list",
    {
      title: "Memory List",
      description:
        "List fact headers (id, name, desc, tags, status, updated). Optional tag filter. Defaults to active facts only. Cheap overview or TOC builder. Use when you don't need bodies yet. No keyword/body matching — use memory_search for that. Best for full enumeration or a TOC. Part of the single source of truth shared with Claude Code auto-memory.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Filter to facts having ALL listed tags. (tags only — for topic/keyword scoping use memory_search.)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max facts (default 100)."),
        include_archived: z
          .boolean()
          .optional()
          .describe("If true, include superseded/archived facts (default false)."),
      },
    },
    async ({ tags, limit, include_archived }: { tags?: string[]; limit?: number; include_archived?: boolean }) => {
      try {
        const res = await listFacts(MEMORY_DIR, tags, limit, include_archived);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `memory_list failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );
}
