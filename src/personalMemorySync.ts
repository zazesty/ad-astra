import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readFact, upsertFact } from "./memory.js";

export const ARCHIVE_ID = "tier1-personal-sync";
export const SYNC_CLIENTS = ["claude", "grok", "gemini", "gpt", "other"] as const;
export type SyncClient = (typeof SYNC_CLIENTS)[number];

export interface PersonalMemoryItem {
  id: string;
  text: string;
  norm: string;
  hash: string;
  category: string;
  sources: string[];
  updated: string;
}

export interface TombstoneItem {
  id: string;
  text: string;
  norm: string;
  hash: string;
  deleted_at: string;
  reason: string;
  retired_from_client?: string;
}

export interface ClientSyncState {
  last_sync: string;
  item_count: number;
}

export interface Tier1Archive {
  exists: boolean;
  version: number;
  updated: string | null;
  active: PersonalMemoryItem[];
  tombstones: TombstoneItem[];
  clients: Record<string, ClientSyncState>;
}

export type DiffKind = "client_only" | "vps_only" | "tombstoned_zombie" | "conflict";

export type DiffAction =
  | "add_to_vps"
  | "delete_from_client"
  | "push_to_client"
  | "retire_on_vps"
  | "restore_to_vps"
  | "keep_vps"
  | "keep_client"
  | "merge"
  | "skip";

export interface DiffItem {
  key: string;
  kind: DiffKind;
  client_text?: string;
  vps_id?: string;
  vps_text?: string;
  tombstone_id?: string;
  tombstone_text?: string;
  tombstone_reason?: string;
  similarity?: number;
  default_action: DiffAction | null;
  allowed_actions: DiffAction[];
}

export interface SyncDiffResult {
  status: "in_sync" | "review_required";
  review_required: boolean;
  client: SyncClient;
  archive_exists: boolean;
  archive_version: number;
  archive_updated: string | null;
  review_token: string;
  summary: {
    matched: number;
    client_only: number;
    vps_only: number;
    tombstoned_zombies: number;
    conflicts: number;
    client_duplicates_collapsed: number;
  };
  matched: Array<{ vps_id: string; text: string }>;
  items: DiffItem[];
  instructions_for_assistant: string;
}

export interface SyncDecision {
  key: string;
  action: DiffAction;
  merged_text?: string;
  category?: string;
}

export interface ApplySyncResult {
  ok: true;
  client: SyncClient;
  archive_version: number;
  archive_updated: string;
  active_count: number;
  tombstone_count: number;
  vps_applied: {
    added: Array<{ id: string; text: string }>;
    updated: Array<{ id: string; text: string }>;
    retired: Array<{ id: string; text: string; reason: string }>;
    restored: Array<{ id: string; text: string }>;
    skipped: number;
  };
  client_actions: {
    add: Array<{ vps_id: string; text: string }>;
    update: Array<{ vps_id: string; replace_client_text: string; with_vps_text: string }>;
    delete: Array<{ text: string; reason: string }>;
  };
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "he", "her", "his", "i", "in", "is", "it", "its", "my", "of", "on", "or", "she",
  "that", "the", "their", "them", "they", "this", "to", "user", "was", "were", "with",
  "you", "your", "zavdi",
]);

export function cleanMemoryText(raw: string): string {
  return raw
    .replace(/\r?\n+/g, " ")
    .replace(/^\s*[-*•]+\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMemoryText(raw: string): string {
  return cleanMemoryText(raw)
    .toLowerCase()
    .replace(/[.;,!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashNormalized(norm: string): string {
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

export function makeItemId(norm: string, existingIds: Set<string>): string {
  const base = `pm-${createHash("sha256").update(norm).digest("hex").slice(0, 8)}`;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function contentTokens(norm: string): Set<string> {
  const tokens = norm
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function charTrigrams(norm: string): Set<string> {
  const compact = norm.replace(/\s+/g, " ").trim();
  if (compact.length < 3) return new Set(compact ? [compact] : []);
  const out = new Set<string>();
  for (let i = 0; i <= compact.length - 3; i++) {
    out.add(compact.slice(i, i + 3));
  }
  return out;
}

function setOverlap(a: Set<string>, b: Set<string>): { jaccard: number; dice: number; intersection: number } {
  if (a.size === 0 || b.size === 0) return { jaccard: 0, dice: 0, intersection: 0 };
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return {
    jaccard: union > 0 ? inter / union : 0,
    dice: (2 * inter) / (a.size + b.size),
    intersection: inter,
  };
}

export function textSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeMemoryText(aRaw);
  const b = normalizeMemoryText(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  let containmentBonus = 0;
  if (shorter.length >= 18 && longer.includes(shorter)) {
    containmentBonus = 0.85;
  }

  const tokStats = setOverlap(contentTokens(a), contentTokens(b));
  const triStats = setOverlap(charTrigrams(a), charTrigrams(b));
  const blended = 0.65 * tokStats.jaccard + 0.35 * triStats.dice;

  // Topic-prefix boost when both use `prefix: ...` on the same prefix and share content tokens
  let prefixBoost = 0;
  const pa = a.match(/^([a-z0-9 _/-]{3,28}):\s+/);
  const pb = b.match(/^([a-z0-9 _/-]{3,28}):\s+/);
  if (pa && pb && pa[1] === pb[1]) {
    prefixBoost = Math.max(0.55, blended + 0.2);
  }

  return Math.max(containmentBonus, blended, prefixBoost);
}

const CONFLICT_THRESHOLD = 0.42;
const ZOMBIE_THRESHOLD = 0.65;

export function parseArchiveMarkdown(
  body: string,
  meta: { exists: boolean; version: number; updated: string | null },
): Tier1Archive {
  const active: PersonalMemoryItem[] = [];
  const tombstones: TombstoneItem[] = [];
  const clients: Record<string, ClientSyncState> = {};

  let section: "none" | "active" | "tombstones" | "clients" = "none";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^##\s+Active Items/i.test(line)) {
      section = "active";
      continue;
    }
    if (/^##\s+Tombstones/i.test(line)) {
      section = "tombstones";
      continue;
    }
    if (/^##\s+Client Sync State/i.test(line)) {
      section = "clients";
      continue;
    }
    if (/^##\s+/.test(line)) {
      section = "none";
      continue;
    }

    if (section === "active" && line.startsWith("-")) {
      // Format: - [pm-xxxxxxxx] (category) Text... [updated=...; sources=a,b]
      const m = line.match(
        /^-\s+\[([a-z0-9_-]+)\]\s+(?:\(([^)]+)\)\s+)?(.+?)(?:\s+\[updated=([^;\]]+);\s*sources=([^\]]*)\])?$/i,
      );
      if (m) {
        const id = m[1];
        const category = (m[2] || "general").trim();
        const text = cleanMemoryText(m[3]);
        const updated = (m[4] || meta.updated || new Date().toISOString()).trim();
        const sources = (m[5] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (text) {
          const norm = normalizeMemoryText(text);
          active.push({
            id,
            text,
            norm,
            hash: hashNormalized(norm),
            category,
            sources,
            updated,
          });
        }
      } else {
        const text = cleanMemoryText(line);
        if (text && !text.startsWith("(none")) {
          const norm = normalizeMemoryText(text);
          const existingIds = new Set(active.map((a) => a.id));
          active.push({
            id: makeItemId(norm, existingIds),
            text,
            norm,
            hash: hashNormalized(norm),
            category: "general",
            sources: [],
            updated: meta.updated || new Date().toISOString(),
          });
        }
      }
    } else if (section === "tombstones" && line.startsWith("-")) {
      const m = line.match(
        /^-\s+\[([a-z0-9_-]+)\]\s+~~(.+?)~~(?:\s+\[deleted=([^;\]]+);\s*reason=([^;\]]+)(?:;\s*client=([^\]]*))?\])?$/i,
      );
      if (m) {
        const id = m[1];
        const text = cleanMemoryText(m[2]);
        const deleted_at = (m[3] || meta.updated || new Date().toISOString()).trim();
        const reason = (m[4] || "retired_on_vps").trim();
        const retired_from_client = m[5]?.trim() || undefined;
        if (text) {
          const norm = normalizeMemoryText(text);
          tombstones.push({
            id,
            text,
            norm,
            hash: hashNormalized(norm),
            deleted_at,
            reason,
            ...(retired_from_client ? { retired_from_client } : {}),
          });
        }
      }
    } else if (section === "clients" && line.startsWith("-")) {
      const m = line.match(/^-\s+`?([a-z0-9_-]+)`?:\s*last_sync=([^,\s]+),\s*items=(\d+)/i);
      if (m) {
        clients[m[1].toLowerCase()] = {
          last_sync: m[2],
          item_count: Number(m[3]) || 0,
        };
      }
    }
  }

  return {
    exists: meta.exists,
    version: meta.version,
    updated: meta.updated,
    active,
    tombstones,
    clients,
  };
}

export function renderArchiveMarkdown(archive: Tier1Archive): string {
  const lines: string[] = [
    "Tier-1 canonical personal memory archive synced across consumer chat clients (Claude, Grok, Gemini, GPT) via `personal_memory_sync`.",
    "Personal residue only — not box ops, standing-todos, or copies of Astra infra docs (see [[kb-sync-watermarks]]).",
    "",
    "## Active Items",
  ];

  if (archive.active.length === 0) {
    lines.push("_(none yet — bootstrap from Claude/Grok/Gemini exports or apply first client diff)_");
  } else {
    for (const item of archive.active) {
      const src = item.sources.join(",");
      lines.push(
        `- [${item.id}] (${item.category || "general"}) ${cleanMemoryText(item.text)} [updated=${item.updated}; sources=${src}]`,
      );
    }
  }

  lines.push("", "## Tombstones");
  if (archive.tombstones.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const t of archive.tombstones) {
      const safeText = cleanMemoryText(t.text).replace(/~~/g, "--");
      const clientPart = t.retired_from_client ? `; client=${t.retired_from_client}` : "";
      lines.push(
        `- [${t.id}] ~~${safeText}~~ [deleted=${t.deleted_at}; reason=${t.reason}${clientPart}]`,
      );
    }
  }

  lines.push("", "## Client Sync State");
  const clientNames = Object.keys(archive.clients).sort();
  if (clientNames.length === 0) {
    lines.push("_(no client syncs applied yet)_");
  } else {
    for (const c of clientNames) {
      const st = archive.clients[c];
      lines.push(`- \`${c}\`: last_sync=${st.last_sync}, items=${st.item_count}`);
    }
  }

  return lines.join("\n") + "\n";
}

export function defaultMemoryDir(): string {
  return process.env.MEMORY_DIR ?? "/root/memory";
}

export async function loadTier1Archive(memoryDir: string = defaultMemoryDir()): Promise<Tier1Archive> {
  const filePath = join(memoryDir, `${ARCHIVE_ID}.md`);
  try {
    await readFile(filePath, "utf8");
  } catch {
    return {
      exists: false,
      version: 0,
      updated: null,
      active: [],
      tombstones: [],
      clients: {},
    };
  }
  const fact = await readFact(filePath);
  if (!fact) {
    return {
      exists: false,
      version: 0,
      updated: null,
      active: [],
      tombstones: [],
      clients: {},
    };
  }
  return parseArchiveMarkdown(fact.content, {
    exists: true,
    version: fact.version,
    updated: fact.updated,
  });
}

export async function saveTier1Archive(
  memoryDir: string,
  archive: Tier1Archive,
): Promise<{ version: number; updated: string }> {
  const body = renderArchiveMarkdown(archive);
  const fact = await upsertFact(memoryDir, {
    id: ARCHIVE_ID,
    name: ARCHIVE_ID,
    description: `Tier-1 canonical personal memory sync archive (${archive.active.length} active, ${archive.tombstones.length} tombstones)`,
    tags: ["personal", "sync", "tier1", "archive"],
    related: ["kb-sync-watermarks", "user-personal-profile"],
    status: "active",
    content: body,
  });
  return { version: fact.version, updated: fact.updated };
}

export type NativeMemoryInput = string | { id?: string; text: string };

export function normalizeNativeInputList(rawList: NativeMemoryInput[]): {
  items: Array<{ text: string; norm: string; hash: string }>;
  duplicatesCollapsed: number;
} {
  const seen = new Set<string>();
  const items: Array<{ text: string; norm: string; hash: string }> = [];
  let duplicatesCollapsed = 0;

  for (const entry of rawList) {
    const rawText = typeof entry === "string" ? entry : entry.text;
    const cleaned = cleanMemoryText(rawText);
    const norm = normalizeMemoryText(cleaned);
    if (!norm) continue;
    if (seen.has(norm)) {
      duplicatesCollapsed++;
      continue;
    }
    seen.add(norm);
    items.push({ text: cleaned, norm, hash: hashNormalized(norm) });
  }
  return { items, duplicatesCollapsed };
}

function computeReviewToken(
  client: SyncClient,
  archive: Tier1Archive,
  items: DiffItem[],
): string {
  const payload = {
    client,
    archive_version: archive.version,
    active_hashes: archive.active.map((a) => `${a.id}:${a.hash}`).sort(),
    tombstone_hashes: archive.tombstones.map((t) => `${t.id}:${t.hash}`).sort(),
    items: items.map((i) => ({
      key: i.key,
      kind: i.kind,
      client_text: i.client_text ?? null,
      vps_id: i.vps_id ?? null,
      vps_text: i.vps_text ?? null,
      tombstone_id: i.tombstone_id ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function computeSyncDiff(
  archive: Tier1Archive,
  client: SyncClient,
  rawNativeMemories: NativeMemoryInput[],
): SyncDiffResult {
  const { items: clientItems, duplicatesCollapsed } = normalizeNativeInputList(rawNativeMemories);

  const activeByNorm = new Map<string, PersonalMemoryItem>();
  for (const a of archive.active) {
    activeByNorm.set(a.norm, a);
  }

  const matched: Array<{ vps_id: string; text: string }> = [];
  const matchedActiveIds = new Set<string>();
  const unmatchedClient: Array<{ text: string; norm: string; hash: string }> = [];

  // 1. Exact normalized matches against active VPS items
  for (const ci of clientItems) {
    const hit = activeByNorm.get(ci.norm);
    if (hit && !matchedActiveIds.has(hit.id)) {
      matchedActiveIds.add(hit.id);
      matched.push({ vps_id: hit.id, text: hit.text });
    } else {
      unmatchedClient.push(ci);
    }
  }

  // 2. Zombie check against tombstones
  const tombstonedZombies: DiffItem[] = [];
  const remainingClientAfterZombie: Array<{ text: string; norm: string; hash: string }> = [];

  for (const ci of unmatchedClient) {
    let bestTomb: TombstoneItem | null = null;
    let bestScore = 0;
    for (const tomb of archive.tombstones) {
      if (tomb.norm === ci.norm) {
        bestTomb = tomb;
        bestScore = 1;
        break;
      }
      const s = textSimilarity(ci.text, tomb.text);
      if (s >= ZOMBIE_THRESHOLD && s > bestScore) {
        bestScore = s;
        bestTomb = tomb;
      }
    }
    if (bestTomb) {
      tombstonedZombies.push({
        key: `zombie-${ci.hash.slice(0, 8)}`,
        kind: "tombstoned_zombie",
        client_text: ci.text,
        tombstone_id: bestTomb.id,
        tombstone_text: bestTomb.text,
        tombstone_reason: bestTomb.reason,
        similarity: Number(bestScore.toFixed(3)),
        default_action: "delete_from_client",
        allowed_actions: ["delete_from_client", "restore_to_vps", "skip"],
      });
    } else {
      remainingClientAfterZombie.push(ci);
    }
  }

  // 3. Conflict / near-duplicate greedy pairing between remaining client items & remaining VPS active items
  const remainingVps = archive.active.filter((a) => !matchedActiveIds.has(a.id));
  const candidatePairs: Array<{ cIdx: number; vIdx: number; score: number }> = [];
  for (let cIdx = 0; cIdx < remainingClientAfterZombie.length; cIdx++) {
    for (let vIdx = 0; vIdx < remainingVps.length; vIdx++) {
      const score = textSimilarity(remainingClientAfterZombie[cIdx].text, remainingVps[vIdx].text);
      if (score >= CONFLICT_THRESHOLD) {
        candidatePairs.push({ cIdx, vIdx, score });
      }
    }
  }
  candidatePairs.sort((a, b) => b.score - a.score);

  const pairedClientIdx = new Set<number>();
  const pairedVpsIdx = new Set<number>();
  const conflicts: DiffItem[] = [];

  for (const pair of candidatePairs) {
    if (pairedClientIdx.has(pair.cIdx) || pairedVpsIdx.has(pair.vIdx)) continue;
    pairedClientIdx.add(pair.cIdx);
    pairedVpsIdx.add(pair.vIdx);
    const ci = remainingClientAfterZombie[pair.cIdx];
    const vi = remainingVps[pair.vIdx];
    conflicts.push({
      key: `conflict-${vi.id}-${ci.hash.slice(0, 6)}`,
      kind: "conflict",
      client_text: ci.text,
      vps_id: vi.id,
      vps_text: vi.text,
      similarity: Number(pair.score.toFixed(3)),
      default_action: null,
      allowed_actions: ["keep_vps", "keep_client", "merge", "skip"],
    });
  }

  // 4. Client-only additions
  const clientOnly: DiffItem[] = [];
  for (let cIdx = 0; cIdx < remainingClientAfterZombie.length; cIdx++) {
    if (pairedClientIdx.has(cIdx)) continue;
    const ci = remainingClientAfterZombie[cIdx];
    clientOnly.push({
      key: `client-${ci.hash.slice(0, 8)}`,
      kind: "client_only",
      client_text: ci.text,
      default_action: "add_to_vps",
      allowed_actions: ["add_to_vps", "delete_from_client", "skip"],
    });
  }

  // 5. VPS-only items (VPS-to-client additions — MUST be reviewed to avoid resurrecting intentionally deleted client memories!)
  const vpsOnly: DiffItem[] = [];
  for (let vIdx = 0; vIdx < remainingVps.length; vIdx++) {
    if (pairedVpsIdx.has(vIdx)) continue;
    const vi = remainingVps[vIdx];
    vpsOnly.push({
      key: `vps-${vi.id}`,
      kind: "vps_only",
      vps_id: vi.id,
      vps_text: vi.text,
      default_action: "push_to_client",
      allowed_actions: ["push_to_client", "retire_on_vps", "skip"],
    });
  }

  const items: DiffItem[] = [...conflicts, ...tombstonedZombies, ...clientOnly, ...vpsOnly];
  const reviewRequired = items.length > 0;
  const reviewToken = computeReviewToken(client, archive, items);

  const instructions = reviewRequired
    ? "STOP and present every diff item above (including vps_only VPS-to-client additions, tombstoned_zombies, client_only items, and conflicts) to the user for 1-step review. Do NOT call mode='apply' until the user confirms. Any vps_only item the user intentionally deleted on this client should use action='retire_on_vps' instead of 'push_to_client' to prevent zombie resurrections across clients. Every conflict requires an explicit decision."
    : "Client native memory is already in sync with tier1-personal-sync. No writes needed.";

  return {
    status: reviewRequired ? "review_required" : "in_sync",
    review_required: reviewRequired,
    client,
    archive_exists: archive.exists,
    archive_version: archive.version,
    archive_updated: archive.updated,
    review_token: reviewToken,
    summary: {
      matched: matched.length,
      client_only: clientOnly.length,
      vps_only: vpsOnly.length,
      tombstoned_zombies: tombstonedZombies.length,
      conflicts: conflicts.length,
      client_duplicates_collapsed: duplicatesCollapsed,
    },
    matched,
    items,
    instructions_for_assistant: instructions,
  };
}

export async function applySyncDecisions(
  input: {
    client: SyncClient;
    native_memories: NativeMemoryInput[];
    review_token: string;
    confirmed_by_user: boolean;
    approve_defaults?: boolean;
    decisions?: SyncDecision[];
  },
  memoryDir: string = defaultMemoryDir(),
): Promise<ApplySyncResult> {
  if (input.confirmed_by_user !== true) {
    throw new Error(
      "review_required: confirmed_by_user must be true. Run mode='diff' first, present the diff/conflicts to the user, and obtain explicit confirmation.",
    );
  }
  if (!input.review_token || !input.review_token.trim()) {
    throw new Error("stale_or_missing_review_token: Run mode='diff' first and pass its review_token.");
  }

  const archive = await loadTier1Archive(memoryDir);
  const currentDiff = computeSyncDiff(archive, input.client, input.native_memories);

  if (input.review_token.trim() !== currentDiff.review_token) {
    throw new Error(
      `stale_review_token: Expected '${currentDiff.review_token}' for current archive/client state, got '${input.review_token}'. Re-run mode='diff' and review the updated diff.`,
    );
  }

  const decisionMap = new Map<string, SyncDecision>();
  const itemByKey = new Map(currentDiff.items.map((i) => [i.key, i]));

  for (const dec of input.decisions ?? []) {
    const target = itemByKey.get(dec.key);
    if (!target) {
      throw new Error(`invalid_decision_key: '${dec.key}' is not in the reviewed diff.`);
    }
    if (!target.allowed_actions.includes(dec.action)) {
      throw new Error(
        `invalid_action: '${dec.action}' is not allowed for ${target.kind} (${dec.key}). Allowed: ${target.allowed_actions.join(", ")}.`,
      );
    }
    if (dec.action === "merge" && (!dec.merged_text || !cleanMemoryText(dec.merged_text))) {
      throw new Error(`merged_text_required: decision for '${dec.key}' chose 'merge' without non-empty merged_text.`);
    }
    decisionMap.set(dec.key, dec);
  }

  const missingConflicts = currentDiff.items.filter(
    (i) => i.kind === "conflict" && !decisionMap.has(i.key),
  );
  if (missingConflicts.length > 0) {
    throw new Error(
      `conflict_decision_required: Every conflict must have an explicit decision in decisions[]. Missing: ${missingConflicts.map((c) => c.key).join(", ")}.`,
    );
  }

  const unlistedNonConflicts = currentDiff.items.filter(
    (i) => i.kind !== "conflict" && !decisionMap.has(i.key),
  );
  if (unlistedNonConflicts.length > 0 && input.approve_defaults !== true) {
    throw new Error(
      `missing_decisions: Supply decisions for all items or set approve_defaults=true after user confirms defaults. Unlisted: ${unlistedNonConflicts.map((i) => i.key).join(", ")}.`,
    );
  }

  const now = new Date().toISOString();
  const nextActive: PersonalMemoryItem[] = archive.active.map((a) => ({
    ...a,
    sources: [...a.sources],
  }));
  const nextTombstones: TombstoneItem[] = archive.tombstones.map((t) => ({ ...t }));
  const existingIds = new Set<string>([
    ...nextActive.map((a) => a.id),
    ...nextTombstones.map((t) => t.id),
  ]);

  // Mark matched items as seen on this client
  for (const m of currentDiff.matched) {
    const item = nextActive.find((a) => a.id === m.vps_id);
    if (item && !item.sources.includes(input.client)) {
      item.sources.push(input.client);
    }
  }

  const vpsApplied: ApplySyncResult["vps_applied"] = {
    added: [],
    updated: [],
    retired: [],
    restored: [],
    skipped: 0,
  };
  const clientActions: ApplySyncResult["client_actions"] = {
    add: [],
    update: [],
    delete: [],
  };

  for (const item of currentDiff.items) {
    const dec = decisionMap.get(item.key);
    const action = dec ? dec.action : item.default_action!;

    if (action === "skip") {
      vpsApplied.skipped++;
      continue;
    }

    if (item.kind === "client_only") {
      const text = cleanMemoryText(item.client_text!);
      if (action === "add_to_vps") {
        const norm = normalizeMemoryText(text);
        const existing = nextActive.find((a) => a.norm === norm);
        if (!existing) {
          const id = makeItemId(norm, existingIds);
          existingIds.add(id);
          nextActive.push({
            id,
            text,
            norm,
            hash: hashNormalized(norm),
            category: dec?.category?.trim() || "general",
            sources: [input.client],
            updated: now,
          });
          vpsApplied.added.push({ id, text });
        }
      } else if (action === "delete_from_client") {
        clientActions.delete.push({ text, reason: "rejected_client_only" });
      }
    } else if (item.kind === "tombstoned_zombie") {
      const text = cleanMemoryText(item.client_text!);
      if (action === "delete_from_client") {
        clientActions.delete.push({
          text,
          reason: `tombstoned_on_vps:${item.tombstone_reason ?? "retired"}`,
        });
      } else if (action === "restore_to_vps") {
        const tIdx = nextTombstones.findIndex((t) => t.id === item.tombstone_id);
        if (tIdx >= 0) nextTombstones.splice(tIdx, 1);
        const norm = normalizeMemoryText(text);
        if (!nextActive.some((a) => a.norm === norm)) {
          const id = item.tombstone_id || makeItemId(norm, existingIds);
          existingIds.add(id);
          nextActive.push({
            id,
            text,
            norm,
            hash: hashNormalized(norm),
            category: dec?.category?.trim() || "general",
            sources: [input.client],
            updated: now,
          });
          vpsApplied.restored.push({ id, text });
        }
      }
    } else if (item.kind === "vps_only") {
      const idx = nextActive.findIndex((a) => a.id === item.vps_id);
      if (idx < 0) continue;
      const vpsEntry = nextActive[idx];
      if (action === "push_to_client") {
        if (!vpsEntry.sources.includes(input.client)) {
          vpsEntry.sources.push(input.client);
        }
        clientActions.add.push({ vps_id: vpsEntry.id, text: vpsEntry.text });
      } else if (action === "retire_on_vps") {
        nextActive.splice(idx, 1);
        if (!nextTombstones.some((t) => t.norm === vpsEntry.norm)) {
          nextTombstones.push({
            id: vpsEntry.id,
            text: vpsEntry.text,
            norm: vpsEntry.norm,
            hash: vpsEntry.hash,
            deleted_at: now,
            reason: `retired_from_${input.client}_diff`,
            retired_from_client: input.client,
          });
        }
        vpsApplied.retired.push({
          id: vpsEntry.id,
          text: vpsEntry.text,
          reason: `retired_from_${input.client}_diff`,
        });
      }
    } else if (item.kind === "conflict") {
      const idx = nextActive.findIndex((a) => a.id === item.vps_id);
      if (idx < 0) continue;
      const vpsEntry = nextActive[idx];
      const clientText = cleanMemoryText(item.client_text!);

      if (action === "keep_vps") {
        if (!vpsEntry.sources.includes(input.client)) {
          vpsEntry.sources.push(input.client);
        }
        clientActions.update.push({
          vps_id: vpsEntry.id,
          replace_client_text: clientText,
          with_vps_text: vpsEntry.text,
        });
      } else if (action === "keep_client" || action === "merge") {
        const oldText = vpsEntry.text;
        const oldNorm = vpsEntry.norm;
        const oldHash = vpsEntry.hash;
        const newText =
          action === "keep_client" ? clientText : cleanMemoryText(dec!.merged_text!);
        const newNorm = normalizeMemoryText(newText);
        vpsEntry.text = newText;
        vpsEntry.norm = newNorm;
        vpsEntry.hash = hashNormalized(newNorm);
        vpsEntry.updated = now;
        if (!vpsEntry.sources.includes(input.client)) {
          vpsEntry.sources.push(input.client);
        }
        if (dec?.category?.trim()) {
          vpsEntry.category = dec.category.trim();
        }
        // If wording shifted substantially, tombstone the old phrasing so other clients don't re-add it as client_only
        if (textSimilarity(oldText, newText) < CONFLICT_THRESHOLD) {
          const tombId = makeItemId(oldNorm, existingIds);
          existingIds.add(tombId);
          nextTombstones.push({
            id: tombId,
            text: oldText,
            norm: oldNorm,
            hash: oldHash,
            deleted_at: now,
            reason: `superseded_by_${vpsEntry.id}`,
            retired_from_client: input.client,
          });
        }
        vpsApplied.updated.push({ id: vpsEntry.id, text: newText });
        if (action === "merge" && normalizeMemoryText(clientText) !== newNorm) {
          clientActions.update.push({
            vps_id: vpsEntry.id,
            replace_client_text: clientText,
            with_vps_text: newText,
          });
        }
      }
    }
  }

  const nextArchive: Tier1Archive = {
    exists: true,
    version: archive.version + 1,
    updated: now,
    active: nextActive,
    tombstones: nextTombstones,
    clients: {
      ...archive.clients,
      [input.client]: {
        last_sync: now,
        item_count: nextActive.length,
      },
    },
  };

  const saved = await saveTier1Archive(memoryDir, nextArchive);

  return {
    ok: true,
    client: input.client,
    archive_version: saved.version,
    archive_updated: saved.updated,
    active_count: nextActive.length,
    tombstone_count: nextTombstones.length,
    vps_applied: vpsApplied,
    client_actions: clientActions,
  };
}

export interface BootstrapConflict {
  key: string;
  candidates: Array<{ client: string; text: string }>;
  similarity: number;
}

export interface BootstrapMergeResult {
  canonical: PersonalMemoryItem[];
  conflicts: BootstrapConflict[];
  stats: Record<string, { raw: number; deduped: number }>;
}

/**
 * Merge and deduplicate raw exports from multiple clients (claude, grok, gemini)
 * into a clean Tier-1 baseline plus any cross-client near-duplicate conflicts.
 */
export function mergeBootstrapExports(
  exportsByClient: Partial<Record<SyncClient, NativeMemoryInput[]>>,
): BootstrapMergeResult {
  const now = new Date().toISOString();
  const canonical: PersonalMemoryItem[] = [];
  const conflicts: BootstrapConflict[] = [];
  const stats: Record<string, { raw: number; deduped: number }> = {};
  const existingIds = new Set<string>();

  for (const client of SYNC_CLIENTS) {
    const rawList = exportsByClient[client];
    if (!rawList) continue;
    const { items } = normalizeNativeInputList(rawList);
    stats[client] = { raw: rawList.length, deduped: items.length };

    for (const item of items) {
      const exact = canonical.find((c) => c.norm === item.norm);
      if (exact) {
        if (!exact.sources.includes(client)) exact.sources.push(client);
        if (item.text.length > exact.text.length) exact.text = item.text;
        continue;
      }

      let bestMatch: PersonalMemoryItem | null = null;
      let bestScore = 0;
      for (const c of canonical) {
        const s = textSimilarity(item.text, c.text);
        if (s >= CONFLICT_THRESHOLD && s > bestScore) {
          bestScore = s;
          bestMatch = c;
        }
      }

      if (bestMatch) {
        let conflict = conflicts.find((cf) => cf.key === `boot-${bestMatch!.id}`);
        if (!conflict) {
          conflict = {
            key: `boot-${bestMatch.id}`,
            candidates: [
              { client: bestMatch.sources.join(","), text: bestMatch.text },
            ],
            similarity: Number(bestScore.toFixed(3)),
          };
          conflicts.push(conflict);
        }
        conflict.candidates.push({ client, text: item.text });
        conflict.similarity = Math.max(conflict.similarity, Number(bestScore.toFixed(3)));
        continue;
      }

      const id = makeItemId(item.norm, existingIds);
      existingIds.add(id);
      canonical.push({
        id,
        text: item.text,
        norm: item.norm,
        hash: item.hash,
        category: "general",
        sources: [client],
        updated: now,
      });
    }
  }

  return { canonical, conflicts, stats };
}

const nativeEntrySchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().optional(),
    text: z.string().min(1),
  }),
]);

const decisionSchema = z.object({
  key: z.string().min(1).describe("Item key returned in the diff (e.g. 'conflict-pm-1234abcd-ef5678', 'vps-pm-1234abcd')."),
  action: z
    .enum([
      "add_to_vps",
      "delete_from_client",
      "push_to_client",
      "retire_on_vps",
      "restore_to_vps",
      "keep_vps",
      "keep_client",
      "merge",
      "skip",
    ])
    .describe("Resolution action for this diff item."),
  merged_text: z.string().optional().describe("Required when action='merge': final reconciled memory text."),
  category: z.string().optional().describe("Optional category label when adding/updating a VPS item."),
});

export function registerPersonalMemorySync(server: any) {
  server.registerTool(
    "personal_memory_sync",
    {
      title: "Personal Memory Sync",
      description:
        "Sync a chat client's native personal memories (Claude, Grok, Gemini, GPT) against Astra's canonical " +
        "tier1-personal-sync archive. Always run mode='diff' first to inspect matched items, client_only additions, " +
        "tombstoned_zombies, conflicts, and vps_only (VPS-to-client additions). Mandatory 1-step review: present the " +
        "diff to the user (so intentional client deletions are retired on VPS via action='retire_on_vps' instead of " +
        "resurrecting as zombies) before calling mode='apply' with the returned review_token, confirmed_by_user=true, " +
        "and conflict decisions. For box/ops/project facts, use memory_search/memory_upsert instead.",
      inputSchema: {
        client: z
          .enum(SYNC_CLIENTS)
          .describe("Calling chat client whose native memories are being synced."),
        native_memories: z
          .array(nativeEntrySchema)
          .describe("Full snapshot of native personal memory statements currently held by this client (pass [] if freshly wiped)."),
        mode: z
          .enum(["diff", "apply"])
          .default("diff")
          .describe("'diff' (default, read-only) returns diff + review_token. 'apply' writes approved changes after 1-step user review."),
        review_token: z
          .string()
          .optional()
          .describe("Required for mode='apply': exact review_token returned by mode='diff'."),
        confirmed_by_user: z
          .boolean()
          .optional()
          .describe("Required true for mode='apply' after presenting the diff/conflicts to the user."),
        approve_defaults: z
          .boolean()
          .optional()
          .describe("In mode='apply', apply default_action for non-conflict items not overridden in decisions[]."),
        decisions: z
          .array(decisionSchema)
          .optional()
          .describe("Per-item resolutions for mode='apply'. Required for every conflict; optional overrides for other items."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async (args: {
      client: SyncClient;
      native_memories: NativeMemoryInput[];
      mode?: "diff" | "apply";
      review_token?: string;
      confirmed_by_user?: boolean;
      approve_defaults?: boolean;
      decisions?: SyncDecision[];
    }) => {
      try {
        const mode = args.mode ?? "diff";
        const memoryDir = defaultMemoryDir();
        if (mode === "diff") {
          const archive = await loadTier1Archive(memoryDir);
          const result = computeSyncDiff(archive, args.client, args.native_memories);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        const applied = await applySyncDecisions(
          {
            client: args.client,
            native_memories: args.native_memories,
            review_token: args.review_token ?? "",
            confirmed_by_user: args.confirmed_by_user ?? false,
            approve_defaults: args.approve_defaults,
            decisions: args.decisions,
          },
          memoryDir,
        );
        return { content: [{ type: "text", text: JSON.stringify(applied, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `personal_memory_sync failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
