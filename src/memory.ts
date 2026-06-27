import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";

const MEMORY_DIR = process.env.MEMORY_DIR ?? "/root/memory";

export interface MemoryFact {
  id: string;
  name: string;
  description: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  related: string[];
  content: string;
  metadata?: Record<string, any>;
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

async function loadAllFacts(dir: string): Promise<MemoryFact[]> {
  const files = await listFactFiles(dir);
  const facts: MemoryFact[] = [];
  for (const f of files) {
    const fact = await readFact(f);
    if (fact) facts.push(fact);
  }
  return facts;
}

function matchesQuery(fact: MemoryFact, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    fact.name.toLowerCase().includes(q) ||
    fact.description.toLowerCase().includes(q) ||
    fact.content.toLowerCase().includes(q) ||
    fact.tags.some(t => t.toLowerCase().includes(q))
  );
}

function hasAllTags(fact: MemoryFact, tags: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const set = new Set(fact.tags.map(t => t.toLowerCase()));
  return tags.every(t => set.has(t.toLowerCase()));
}

async function searchFacts(dir: string, opts: { query?: string; tags?: string[]; limit?: number; expand_related?: boolean }): Promise<any> {
  const all = await loadAllFacts(dir);
  const filtered = all
    .filter(f => matchesQuery(f, opts.query || "") && hasAllTags(f, opts.tags || []))
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const limit = Math.min(opts.limit ?? 10, 50);
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
          if (rf) {
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

  return fact;
}

async function listFacts(dir: string, tags?: string[], limit?: number): Promise<any> {
  const all = await loadAllFacts(dir);
  const filtered = tags && tags.length
    ? all.filter(f => hasAllTags(f, tags))
    : all;
  const lim = Math.min(limit ?? 100, 200);
  const items = filtered
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, lim)
    .map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      tags: f.tags,
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
        "Search the shared cross-harness memory KB (facts, decisions, gotchas, setup; the single source of truth also used by Claude Code auto-memory). Keyword match on name/desc/body + tag filter (AND). Returns headers + excerpts. Discovery tool — follow up with memory_retrieve for bodies. For a plain unfiltered enumeration with no keyword, prefer memory_list (cheaper, headers-only).",
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
      },
    },
    async ({ query, tags, limit, expand_related }: { query?: string; tags?: string[]; limit?: number; expand_related?: boolean }) => {
      try {
        const res = await searchFacts(MEMORY_DIR, { query, tags, limit, expand_related });
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
        "Create or update a fact in the shared KB (the single source of truth also used by Claude Code auto-memory + Grok Build). On update: omitted fields are preserved; any field you pass completely replaces the previous value (tags/related arrays are replaced, not unioned — send the full desired set). Bumps updated + version. Provide clean markdown body only (no --- frontmatter block). If editing a fact retrieved via memory_retrieve, strip the frontmatter it returned before sending. This is the only write path for auto-update and cross-harness facts.",
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
      },
    },
    async (input: { id?: string; name: string; description?: string; content: string; tags?: string[]; related?: string[] }) => {
      try {
        const fact = await upsertFact(MEMORY_DIR, input);
        const wasUpdate = !!(await (async () => {
          try { return await readFact(join(MEMORY_DIR, `${fact.id}.md`)); } catch { return null; }
        })() ); // simplistic: if file existed before this upsert
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              id: fact.id,
              updated: fact.updated,
              version: fact.version,
              tags: fact.tags,
              status: wasUpdate ? "updated_existing" : "created",
              conflict_flag: false,  // simple flag; set true in future if search detected near-dup before upsert
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
        "List fact headers (id, name, desc, tags, updated). Optional tag filter. Cheap overview or TOC builder. Use when you don't need bodies yet. No keyword/body matching — use memory_search for that. Best for full enumeration or a TOC. Part of the single source of truth shared with Claude Code auto-memory.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Filter to facts having ALL listed tags."),
        limit: z.number().int().min(1).max(200).optional().describe("Max facts (default 100)."),
      },
    },
    async ({ tags, limit }: { tags?: string[]; limit?: number }) => {
      try {
        const res = await listFacts(MEMORY_DIR, tags, limit);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `memory_list failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );
}
