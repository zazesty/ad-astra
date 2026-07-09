import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { MemoryFact } from "./memory.js";

/** AI Studio embed model (text-embedding-004 404s on v1beta for this key). */
const EMBED_MODEL = "gemini-embedding-001";

export function embeddingsPath(memoryDir: string): string {
  return join(memoryDir, ".embeddings.json");
}

export type EmbeddingsStore = Record<string, number[]>;

export async function loadEmbeddings(memoryDir: string): Promise<EmbeddingsStore> {
  try {
    const raw = await readFile(embeddingsPath(memoryDir), "utf8");
    return JSON.parse(raw) as EmbeddingsStore;
  } catch {
    return {};
  }
}

export async function saveEmbeddings(memoryDir: string, store: EmbeddingsStore): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  // Atomic write: a crash mid-write would otherwise truncate the JSON, and loadEmbeddings
  // swallows the parse error → {} → silent total loss of every vector. tmp + rename avoids that.
  const finalPath = embeddingsPath(memoryDir);
  const tmpPath = finalPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(store, null, 0) + "\n", "utf8");
  await rename(tmpPath, finalPath);
}

export function embedTextForFact(fact: MemoryFact): string {
  return [fact.name, fact.description, fact.content].filter(Boolean).join("\n\n").slice(0, 8000);
}

export async function embedFactText(apiKey: string | undefined, text: string): Promise<number[] | null> {
  if (!apiKey || !text.trim()) return null;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const resp = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: text,
    });
    const values = resp.embeddings?.[0]?.values;
    return values?.length ? values : null;
  } catch (e) {
    console.error(`[memory] embed failed: ${(e as Error).message}`);
    return null;
  }
}

/** Drop vectors whose fact id is no longer present. Vectors are keyed by fact.id and
 *  only ever read for live facts, so orphans (left behind when a fact file is deleted)
 *  are dead weight in the sidecar. Pure in-memory GC — mutates `store`, returns the
 *  number of entries removed. */
export function pruneEmbeddings(store: EmbeddingsStore, validIds: Iterable<string>): number {
  const keep = new Set(validIds);
  let removed = 0;
  for (const id of Object.keys(store)) {
    if (!keep.has(id)) {
      delete store[id];
      removed++;
    }
  }
  return removed;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}