/**
 * newsDigest.ts — the `get_news_digest` tool.
 *
 * THE BRIEF (from the handoff): replace compulsive feed-scrolling with one
 * on-demand, COMPRESSED read. The pipeline is:
 *
 *   you call tool -> fetch curated feeds (last N days) -> dedupe -> LLM COMPRESS
 *                 -> email once + return inline
 *
 * Non-negotiable design principles baked in here:
 *  1. On-demand only. No cron, no daily push. (Hermes would own scheduling if you
 *     ever flip to push — deliberately absent in v1.)
 *  2. Compress, don't discover. The LLM makes the noise QUIETER. The curated
 *     feeds.json IS the quality control — we NEVER let the model web-search, or it
 *     pulls in exactly the SEO outrage-bait you're escaping. Grounding stays OFF.
 *  3. Quiet when quiet. A slow week yields a short digest that SAYS so — it does
 *     not pad to look busy.
 *  4. Primitive, not cathedral. One tool, one pipeline, one config file.
 *  5. Reuse, don't add. Summarize via astra's existing Gemini path (callGemini),
 *     fall back to Grok (callGrok) — no new model dependency.
 *
 * Config (sections + sources) lives in ../feeds.json, LIVE-READ on every call
 * like lenses.md — edit + commit, no rebuild/restart. Failed feeds are reported,
 * never fatal: one dead source must not sink the digest (and it tells you which
 * required-voice URL to swap).
 */

import { readFileSync } from "node:fs";
import Parser from "rss-parser";
import { callGemini, callGeminiViaOpenRouter, makeGeminiClient, type GeminiTransport } from "./geminiCore.js";
import { callGrok } from "./grokCore.js";
import { sendEmail } from "./email.js";

const FEEDS_PATH = new URL("../feeds.json", import.meta.url);

// Bound the summarizer prompt so one big fetch can't run up tokens. The model
// dedupes anyway; this is just a ceiling on how much raw feed text we hand it.
const MAX_ITEMS_HARD_CAP = 60;
const SNIPPET_CHARS = 320;
// Hard per-feed deadline. rss-parser's own `timeout` does NOT reliably abort a
// socket that connects but never sends (observed: a dead feed hangs the whole
// Promise.all forever, which would hang the tool). This race guarantees every
// feed either resolves or becomes a reported failure within the budget.
const FEED_TIMEOUT_MS = 12_000;

type FeedSpec = {
  source: string;
  url: string;
  keyword_filter?: string[];
  challenger?: boolean;
  note?: string;
};
type SectionSpec = { title: string; cap: number | null; note?: string; feeds: FeedSpec[] };
type FeedsConfig = { version: number; sections: Record<string, SectionSpec> };

export type DigestItem = {
  section: string;
  source: string;
  title: string;
  link: string;
  date: string; // ISO, or "" if the feed gave none
  snippet: string;
  challenger?: boolean;
};

export type FetchOutcome = {
  items: DigestItem[];
  failed: { source: string; section: string; error: string }[];
};

/** Live-read + parse feeds.json. Throws (with a clear message) if it's missing/garbage. */
export function loadFeedsConfig(): FeedsConfig {
  let raw: string;
  try {
    raw = readFileSync(FEEDS_PATH, "utf8");
  } catch (e) {
    throw new Error(`Could not read feeds.json: ${(e as Error).message}`);
  }
  let cfg: FeedsConfig;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`feeds.json is not valid JSON: ${(e as Error).message}`);
  }
  if (!cfg?.sections || typeof cfg.sections !== "object") {
    throw new Error("feeds.json has no 'sections' object.");
  }
  return cfg;
}

// --- title normalization for near-duplicate clustering ----------------------
// "OpenAI launches GPT-6!" and "OpenAI Launches GPT-6" collapse to one key.
function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/['"“”’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function itemDate(item: any): string {
  const d = item?.isoDate || item?.pubDate || "";
  if (!d) return "";
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function snippetOf(item: any): string {
  const s = (item?.contentSnippet || item?.content || item?.summary || "").toString();
  return s.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

/** Reject after `ms` so a feed that connects-but-stalls can't hang the digest. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // unref so a stray timer never keeps the process alive past the work.
    (timer as any).unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

// Word-boundary keyword match. Substring matching is a trap for short tokens:
// "ai" is inside remAIns/avAIlable/mAIntained, "llm"/"gpt" inside random ids —
// which silently floods a keyword-filtered section (e.g. HN) with non-topic noise,
// the exact firehose the digest exists to avoid. So match whole words/tokens only.
// Hyphens/dots count as boundaries so "GPT-6", "o3-mini", "model.json" still hit.
export function matchesKeywords(item: any, keywords?: string[]): boolean {
  if (!keywords?.length) return true;
  const hay = ` ${item?.title ?? ""} ${item?.contentSnippet ?? ""} `.toLowerCase();
  return keywords.some((k) => {
    const kw = k.toLowerCase().trim();
    if (!kw) return false;
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(hay);
  });
}

/**
 * Fetch all feeds for the requested sections, keep items within `days`, apply
 * per-feed keyword filters and per-section caps, and dedupe by URL + near-dup
 * title. Dead/timing-out feeds are collected into `failed`, never thrown.
 * `nowMs` is injected (not Date.now()) so this is deterministic/testable.
 */
export async function fetchDigestItems(
  cfg: FeedsConfig,
  sections: string[],
  days: number,
  maxItems: number,
  nowMs: number,
): Promise<FetchOutcome> {
  const parser = new Parser({ timeout: 15_000, headers: { "User-Agent": "astra-news-digest/1.0 (+rss)" } });
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  const failed: FetchOutcome["failed"] = [];
  const bySectionItems: Record<string, DigestItem[]> = {};

  // Flatten the (section, feed) work list so all feeds fetch concurrently.
  const jobs: { sectionKey: string; section: SectionSpec; feed: FeedSpec }[] = [];
  for (const key of sections) {
    const section = cfg.sections[key];
    if (!section) {
      failed.push({ source: `(section)`, section: key, error: `no such section in feeds.json` });
      continue;
    }
    bySectionItems[key] = [];
    for (const feed of section.feeds) jobs.push({ sectionKey: key, section, feed });
  }

  await Promise.all(
    jobs.map(async ({ sectionKey, feed }) => {
      try {
        const parsed = await withTimeout(parser.parseURL(feed.url), FEED_TIMEOUT_MS, feed.source);
        for (const item of parsed.items ?? []) {
          const iso = itemDate(item);
          // Keep items with no date (some feeds omit it) OR within the window.
          if (iso) {
            const t = new Date(iso).getTime();
            if (t < cutoff) continue;
          }
          if (!matchesKeywords(item, feed.keyword_filter)) continue;
          const link = (item?.link || item?.guid || "").toString().trim();
          const title = (item?.title || "").toString().trim();
          if (!title) continue;
          bySectionItems[sectionKey].push({
            section: sectionKey,
            source: feed.source,
            title,
            link,
            date: iso,
            snippet: snippetOf(item),
            ...(feed.challenger ? { challenger: true } : {}),
          });
        }
      } catch (e) {
        failed.push({ source: feed.source, section: sectionKey, error: (e as Error).message });
      }
    }),
  );

  // Per-section: sort newest-first, dedupe, apply the section cap.
  for (const key of Object.keys(bySectionItems)) {
    const section = cfg.sections[key];
    let items = dedupe(bySectionItems[key]);
    items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (typeof section.cap === "number") items = items.slice(0, section.cap);
    bySectionItems[key] = items;
  }

  // Global budget: capped sections (e.g. industry=3) are kept whole; the rest
  // share the remaining budget by global recency, so a busy AI week doesn't
  // crowd out the macro challengers entirely but freshness still wins.
  const effectiveMax = Math.min(maxItems, MAX_ITEMS_HARD_CAP);
  const capped: DigestItem[] = [];
  const uncapped: DigestItem[] = [];
  for (const key of sections) {
    const section = cfg.sections[key];
    if (!section) continue;
    if (typeof section.cap === "number") capped.push(...bySectionItems[key]);
    else uncapped.push(...bySectionItems[key]);
  }
  uncapped.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const budgetForUncapped = Math.max(0, effectiveMax - capped.length);
  const keptUncapped = new Set(uncapped.slice(0, budgetForUncapped));

  // Reassemble in requested section order, dropping uncapped items over budget.
  const items: DigestItem[] = [];
  for (const key of sections) {
    const section = cfg.sections[key];
    if (!section) continue;
    for (const it of bySectionItems[key]) {
      if (typeof section.cap === "number" || keptUncapped.has(it)) items.push(it);
    }
  }
  return { items, failed };
}

/** Dedupe by URL first, then by normalized title. Keeps the first (newest after sort upstream is applied later — so dedupe before sort is fine because we keep first-seen and clusters are identical stories). */
export function dedupe(items: DigestItem[]): DigestItem[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const out: DigestItem[] = [];
  for (const it of items) {
    const u = it.link.toLowerCase().replace(/[#?].*$/, "").replace(/\/$/, "");
    if (u && seenUrl.has(u)) continue;
    const nt = normTitle(it.title);
    if (nt && seenTitle.has(nt)) continue;
    if (u) seenUrl.add(u);
    if (nt) seenTitle.add(nt);
    out.push(it);
  }
  return out;
}

// --- summarization ----------------------------------------------------------

const COMPRESSION_SYSTEM = `You are a COMPRESSION LAYER, not a hype engine. You are handed raw items from a CURATED set of feeds and must produce a SHORT, high-signal digest the reader scans in two minutes instead of doom-scrolling.

Rules:
- Group by the section headers given. Use "## " markdown headers exactly matching the section titles provided.
- Dedupe RUTHLESSLY: if one release/event is covered by several items, that's ONE line with the single best link. Merge near-duplicates across sources.
- 1–2 lines per item, plain and factual. NO breathless framing, NO "this changes everything", NO editorializing. Lead with what actually shipped or changed.
- Keep each item's source link as a markdown link on the headline.
- QUIET WHEN QUIET: if a section has little real news, say so in one short line (e.g. "Slow week — 2 items.") rather than padding. Do NOT invent or inflate.
- Preserve the prior-challenging voices (items flagged [challenger]) even if they cut against a Bitcoin/Austrian/heterodox prior — a digest that only confirms priors is failing its job. Never drop a challenger item to make room.
- Do NOT add anything not present in the items. You have NO web access; these feeds are the whole world for this digest.
- Output clean markdown. Start with a one-line summary like "N items across M sections, {window}." then the sections.`;

function buildSummarizerUserPrompt(
  items: DigestItem[],
  cfg: FeedsConfig,
  sections: string[],
  days: number,
): string {
  const lines: string[] = [];
  lines.push(`Recency window: last ${days} day(s). Total items after dedupe: ${items.length}.`);
  lines.push("");
  for (const key of sections) {
    const section = cfg.sections[key];
    if (!section) continue;
    const secItems = items.filter((i) => i.section === key);
    lines.push(`### SECTION: ${section.title}`);
    if (!secItems.length) {
      lines.push("(no items in window)");
      lines.push("");
      continue;
    }
    for (const it of secItems) {
      const flag = it.challenger ? " [challenger]" : "";
      const when = it.date ? ` (${it.date.slice(0, 10)})` : "";
      lines.push(`- ${it.source}${flag}${when}: ${it.title}`);
      if (it.link) lines.push(`  link: ${it.link}`);
      if (it.snippet) lines.push(`  snippet: ${it.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export type SummarizeDeps = {
  geminiApiKey?: string;
  openrouterApiKey?: string;
  geminiTransport: GeminiTransport;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
};

/** Summarize via Gemini (ungrounded — feeds are the only source), fall back to Grok. */
export async function summarize(userPrompt: string, deps: SummarizeDeps): Promise<{ markdown: string; engine: string }> {
  const geminiOpts = { system: COMPRESSION_SYSTEM, grounded: false, reasoning_effort: "high" as const };
  // Try Gemini first (matches ask_panel's transport selection).
  try {
    const r =
      deps.geminiTransport === "openrouter"
        ? await callGeminiViaOpenRouter(deps.openrouterApiKey, userPrompt, geminiOpts)
        : await callGemini(makeGeminiClient(deps.geminiApiKey), userPrompt, geminiOpts);
    return { markdown: r.text, engine: `gemini:${deps.geminiTransport}` };
  } catch (gemErr) {
    // Reuse, don't add: fall back to Grok parametric (grounding off) before giving up.
    try {
      const r = await callGrok(
        deps.xaiApiKey,
        userPrompt,
        { system: COMPRESSION_SYSTEM, grounding: "off", reasoning_effort: "high" },
        deps.xaiBaseUrl,
      );
      return { markdown: r.text, engine: "grok:fallback" };
    } catch (grokErr) {
      throw new Error(
        `Summarization failed on both backends. gemini: ${(gemErr as Error).message}; grok: ${(grokErr as Error).message}`,
      );
    }
  }
}

// Minimal markdown -> HTML so the emailed digest has clickable links. Not a full
// renderer — just headers, links, and list bullets, enough for a clean email.
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  const linkify = (s: string) =>
    esc(s).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      if (inList) { out.push("</ul>"); inList = false; }
      const lvl = h[1].length + 1;
      out.push(`<h${lvl}>${linkify(h[2])}</h${lvl}>`);
    } else if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${linkify(li[1])}</li>`);
    } else if (line === "") {
      if (inList) { out.push("</ul>"); inList = false; }
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${linkify(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;line-height:1.5">${out.join("\n")}</div>`;
}

// --- MCP tool registration --------------------------------------------------

export function registerNewsDigest(server: any, deps: SummarizeDeps & { z: typeof import("zod").z }) {
  const z = deps.z;
  server.registerTool(
    "get_news_digest",
    {
      title: "Get News Digest",
      description:
        "On-demand, COMPRESSED read of a curated set of RSS feeds (AI/frontier, macro/finance heterodox, light industry) — built to replace compulsive feed-scrolling with one quiet scan. Fetches the last N days, dedupes, has an LLM compress (NOT amplify) into a short digest, emails it to you ONCE, and returns the same digest inline. It NEVER web-searches: the curated feed list is the whole world for the digest, by design. Quiet when quiet — a slow week says so rather than padding. On-demand only; there is no schedule.",
      inputSchema: {
        days: z.number().int().min(1).max(30).optional().describe("Recency window in days (default 4). Items older than this are dropped."),
        sections: z
          .array(z.enum(["ai", "macro", "industry"]))
          .optional()
          .describe("Which sections to include (default all: ai, macro, industry). 'industry' is intentionally light (capped)."),
        email: z.boolean().optional().describe("Send the digest as an email (default true). false = return inline only, no mail."),
        max_items: z.number().int().min(1).max(60).optional().describe("Global cap on items handed to the summarizer (default 18). Capped sections like 'industry' are kept whole; the rest share the remaining budget by recency."),
      },
    },
    async ({ days, sections, email, max_items }: { days?: number; sections?: string[]; email?: boolean; max_items?: number }) => {
      try {
        const win = days ?? 4;
        const secs = sections?.length ? sections : ["ai", "macro", "industry"];
        const sendMail = email ?? true;
        const maxItems = max_items ?? 18;

        const cfg = loadFeedsConfig();
        const { items, failed } = await fetchDigestItems(cfg, secs, win, maxItems, Date.now());

        // Even with zero items we still produce a digest (quiet-when-quiet says so).
        const userPrompt = buildSummarizerUserPrompt(items, cfg, secs, win);
        const { markdown, engine } = await summarize(userPrompt, deps);

        const today = new Date().toISOString().slice(0, 10);
        const subject = `Digest — ${today} (${items.length} item${items.length === 1 ? "" : "s"})`;

        // Footer: surface failed feeds so a dead required-voice URL gets noticed
        // (the whole point of reporting rather than silently swallowing).
        let footer = "";
        if (failed.length) {
          footer =
            "\n\n---\n_Feeds that failed this run (swap the URL in feeds.json if persistent):_\n" +
            failed.map((f) => `- ${f.source} [${f.section}]: ${f.error}`).join("\n");
        }
        const fullMd = markdown + footer;

        let emailStatus: string;
        if (sendMail) {
          try {
            const r = await sendEmail({ subject, text: fullMd, html: markdownToHtml(fullMd) });
            emailStatus = `emailed ${items.length} item(s) to ${r.to}`;
          } catch (mailErr) {
            emailStatus = `email FAILED (${(mailErr as Error).message}) — digest returned inline only`;
          }
        } else {
          emailStatus = `email skipped (email:false) — ${items.length} item(s) inline only`;
        }

        const header = `${emailStatus}. window=${win}d sections=${secs.join(",")} engine=${engine}${failed.length ? ` failed_feeds=${failed.length}` : ""}\n\n`;
        return { content: [{ type: "text", text: header + fullMd }] };
      } catch (err) {
        return { content: [{ type: "text", text: `get_news_digest failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
