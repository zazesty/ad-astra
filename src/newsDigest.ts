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

import { readFileSync, writeFileSync } from "node:fs";
import Parser from "rss-parser";
import {
  callGemini,
  callGeminiViaOpenRouter,
  makeGeminiClient,
  OR_NEWS_DIGEST_ATTEMPT_TIMEOUT_MS,
  type GeminiTransport,
} from "./geminiCore.js";
import { callGrok } from "./grokCore.js";
import { sendEmail } from "./email.js";

const FEEDS_PATH = new URL("../feeds.json", import.meta.url);
// Tiny state file: remembers the last run time so the window can extend back to
// the previous run (max(days-floor, since-last-run)). Operational state, not config.
// On the box the systemd unit is hardened read-only (ProtectSystem=strict +
// ReadOnlyPaths=/root/grok-mcp), so writing into the repo fails with EROFS; the
// unit therefore sets StateDirectory=grok-mcp and we write to $STATE_DIRECTORY
// (/var/lib/grok-mcp, persists across restarts). For local/dev runs (no
// STATE_DIRECTORY) we fall back to the repo root (gitignored).
const STATE_PATH: string | URL = process.env.STATE_DIRECTORY
  ? `${process.env.STATE_DIRECTORY.replace(/\/+$/, "")}/news-digest-state.json`
  : new URL("../.news-digest-state.json", import.meta.url);

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
  // enabled:false keeps a source documented in feeds.json (e.g. an IP-blocked
  // required voice) WITHOUT paying its per-call fetch timeout. Flip to re-enable.
  enabled?: boolean;
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

// --- run-state (for the `since_last_call` window) ---------------------------
export type DigestState = { last_call?: string };

/** Read the last-run timestamp; missing/garbage file => {} (treated as no prior call). */
export function loadState(): DigestState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Persist the last-run timestamp. Non-fatal on failure — a digest is still useful
 * even if we couldn't record the timestamp; we just log it (next since_last_call
 * would fall back to `days`). */
export function saveState(state: DigestState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[get_news_digest] could not persist state: ${(e as Error).message}`);
  }
}

/**
 * Resolve the recency window. Policy (per user pref): the window is at LEAST
 * `dayFloor` days, but extends to the last run if that was longer ago — i.e.
 * lookback = max(dayFloor, timeSinceLastRun). So a frequent caller still gets a
 * useful ~4-day digest (never a near-empty "since an hour ago"), while someone
 * returning after two weeks catches up on the whole gap. Pure + exported for tests.
 */
export function resolveWindow(
  nowMs: number,
  dayFloor: number,
  lastIso: string | undefined,
): { cutoffMs: number; windowLabel: string } {
  const floorCutoff = nowMs - dayFloor * 24 * 60 * 60 * 1000;
  const lastMs = lastIso ? new Date(lastIso).getTime() : NaN;
  if (lastIso && !isNaN(lastMs) && lastMs < floorCutoff) {
    // Away longer than the floor → catch up to the last run.
    const when = lastIso.slice(0, 16).replace("T", " ");
    return { cutoffMs: lastMs, windowLabel: `since last run (${when} UTC, >${dayFloor}d ago)` };
  }
  // Within the floor, or no/unreadable last-run timestamp → use the floor.
  const why = !lastIso ? "no prior run" : isNaN(lastMs) ? "unreadable last run" : `last run <${dayFloor}d ago`;
  return { cutoffMs: floorCutoff, windowLabel: `last ${dayFloor} day(s) (floor; ${why})` };
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
 * Fetch all feeds for the requested sections, keep items newer than `cutoffMs`,
 * apply per-feed keyword filters and per-section caps, and dedupe by URL + near-dup
 * title. Dead/timing-out feeds are collected into `failed`, never thrown.
 * `cutoffMs` is injected (the caller derives it from `days` or the last-call
 * timestamp) so this stays a pure window-by-epoch fetcher.
 */
export async function fetchDigestItems(
  cfg: FeedsConfig,
  sections: string[],
  cutoffMs: number,
  maxItems: number,
): Promise<FetchOutcome> {
  const parser = new Parser({ timeout: 15_000, headers: { "User-Agent": "astra-news-digest/1.0 (+rss)" } });
  const cutoff = cutoffMs;
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
    // Skip enabled:false feeds entirely — they stay documented in feeds.json but
    // cost no fetch/timeout (e.g. an IP-blocked source kept as a reminder).
    for (const feed of section.feeds) {
      if (feed.enabled === false) continue;
      jobs.push({ sectionKey: key, section, feed });
    }
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

  // Budget: capped sections (e.g. industry=3) are kept whole; the rest share the
  // remaining budget by FAIR ROUND-ROBIN across sections (one newest item from
  // each uncapped section per round, until budget is spent or all are drained).
  // This is the key fix vs plain global-recency: a high-frequency section (AI,
  // with many feeds) can no longer crowd out a lower-frequency one (macro) — each
  // gets a fair turn, and a section that runs dry hands its slots to the others.
  const effectiveMax = Math.min(maxItems, MAX_ITEMS_HARD_CAP);
  let cappedCount = 0;
  const uncappedKeys: string[] = [];
  for (const key of sections) {
    const section = cfg.sections[key];
    if (!section) continue;
    if (typeof section.cap === "number") cappedCount += bySectionItems[key].length;
    else uncappedKeys.push(key);
  }
  let budgetForUncapped = Math.max(0, effectiveMax - cappedCount);
  const keptUncapped = new Set<DigestItem>();
  const ptr: Record<string, number> = {};
  uncappedKeys.forEach((k) => (ptr[k] = 0));
  let progress = true;
  while (budgetForUncapped > 0 && progress) {
    progress = false;
    for (const k of uncappedKeys) {
      const arr = bySectionItems[k]; // already sorted newest-first
      if (ptr[k] < arr.length) {
        keptUncapped.add(arr[ptr[k]++]);
        budgetForUncapped--;
        progress = true;
        if (budgetForUncapped === 0) break;
      }
    }
  }

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
- SELECTIVITY IS PER-SECTION — different sections get different bars (below). The only universal cut is pure filler: contentless link-dumps and exact repeats.
- AI/frontier — capture what the reader actually cares about: KEEP model releases, NEW FEATURES / capabilities, UPCOMING or announced/teased releases and roadmaps, pricing/access/limit changes, and significant research or benchmarks. ALSO KEEP substantive roundups/analysis from the curated newsletters in this feed set (AINews, TLDR AI, Zvi, Interconnects, Import AI, ChinAI, Exponential View, Simon Willison) — these are hand-picked high-signal sources, so treat their posts as signal and surface the key developments each reports (1-2 lines naming the standout items inside, not just "a roundup was posted"). CULL only genuine minutiae: minor tooling/library/plugin version bumps, how-to tutorials, and pure self-promo. Merge the same story across newsletters + primary sources into ONE line. Rule of thumb: lean toward INCLUSION here — the feeds are already curated; your job is to compress and dedupe them, not to gatekeep them.
- Macro/finance/heterodox AND Industry — INCLUSIVE. Keep substantive analysis, essays, and data pieces even when they aren't "breaking news" — a thoughtful deep-dive (e.g. a Construction Physics piece on industrial/energy mechanics) is exactly the signal here, so keep it. Only drop true filler (contentless link roundups, duplicates). Do NOT apply the AI section's tighter bar to these.
- 1–2 lines per item, plain and factual. NO breathless framing, NO "this changes everything", NO editorializing. Lead with what actually shipped or changed.
- Keep each item's source link as a markdown link on the headline.
- QUIET WHEN QUIET: if a section has little that clears the bar, say so in one short line (e.g. "Slow week — 2 items.") rather than padding. Do NOT invent or inflate. An empty-ish section is a valid, honest outcome.
- Preserve the prior-challenging voices (items flagged [challenger]) even if they cut against a Bitcoin/Austrian/heterodox prior — a digest that only confirms priors is failing its job. Never drop a challenger item to make room.
- Do NOT add anything not present in the items. You have NO web access; these feeds are the whole world for this digest.
- Output clean markdown. Start with a one-line summary like "N items across M sections, {window}." then the sections.`;

function buildSummarizerUserPrompt(
  items: DigestItem[],
  cfg: FeedsConfig,
  sections: string[],
  windowLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`Recency window: ${windowLabel}. Total items after dedupe: ${items.length}.`);
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
  const geminiOpts = {
    system: COMPRESSION_SYSTEM,
    grounded: false,
    reasoning_effort: "high" as const,
    attempt_timeout_ms: OR_NEWS_DIGEST_ATTEMPT_TIMEOUT_MS,
  };
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

/**
 * Count items per section in the FINAL digest markdown (bullets under each
 * section's "## <title>" heading), so the email:true confirmation reports what
 * actually landed in the inbox — not the pre-compression input count. Returns a
 * {sectionKey: count} map in the requested order. Robust: if no headings match
 * (LLM deviated from the format) it returns nulls so the caller can fall back.
 * Pure + exported for tests.
 */
export function countDigestSections(
  markdown: string,
  cfg: FeedsConfig,
  sectionKeys: string[],
): Record<string, number | null> {
  const titleToKey: { title: string; key: string }[] = [];
  for (const k of sectionKeys) {
    const s = cfg.sections[k];
    if (s) titleToKey.push({ title: s.title.toLowerCase(), key: k });
  }
  const counts: Record<string, number | null> = {};
  for (const k of sectionKeys) counts[k] = null;
  let cur: string | null = null;
  let matchedAny = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const t = h[1].toLowerCase();
      cur = null;
      for (const { title, key } of titleToKey) {
        if (t.includes(title)) { cur = key; matchedAny = true; break; }
      }
      if (cur !== null && counts[cur] === null) counts[cur] = 0;
      continue;
    }
    if (cur !== null && /^[-*]\s+/.test(line)) counts[cur] = (counts[cur] ?? 0) + 1;
  }
  if (!matchedAny) for (const k of sectionKeys) counts[k] = null; // no parse → all unknown
  return counts;
}

// --- MCP tool registration --------------------------------------------------

export function registerNewsDigest(server: any, deps: SummarizeDeps & { z: typeof import("zod").z }) {
  const z = deps.z;
  server.registerTool(
    "get_news_digest",
    {
      title: "Get News Digest",
      description:
        "On-demand, COMPRESSED digest of a curated set of RSS feeds (AI/frontier, macro/finance heterodox, light industry), to replace compulsive feed-scrolling with one quiet scan in the inbox. Fetches a recency window (default: at least the last 4 days, auto-extending back to the previous run if that was longer ago), dedupes, and has an LLM compress (NOT amplify) the items into a short, high-signal digest. It NEVER web-searches — the curated feed list is the entire source set, by design; selective by design (it culls marginal items and stays quiet when quiet rather than padding). " +
        "TWO DELIVERY MODES, set by `email`: " +
        "(1) email:true (default) — the full digest is emailed to the configured recipient (the server's NOTIFY_EMAIL_TO address) and this tool returns ONLY a short confirmation (per-section counts, window, recipient). This is the token-saving path: the digest lands in the inbox, NOT in the model context. If the send fails, the full digest is returned inline instead so nothing is lost. " +
        "(2) email:false — the full digest is returned inline and no email is sent. " +
        "Sends exactly ONE email per call ('once' = one message per invocation); there is NO de-duplication across calls, so repeated calls with overlapping windows may resend the same items. On-demand only; there is no schedule. (Throughout, 'you'/'the previous run' refer to the configured user / that user's prior call.)",
      inputSchema: {
        days: z.number().int().min(1).max(30).optional().describe("Minimum recency window in days (default 4). This is a FLOOR: the digest always covers at least this many days, but automatically extends further back to the previous run if that was longer ago (so returning after two weeks catches up the whole gap; running twice in an hour still shows ~4 days, not an empty digest). Set higher (e.g. 7) to widen the floor."),
        sections: z
          .array(z.enum(["ai", "macro", "industry"]))
          .optional()
          .describe("Which sections to include (default all: ai, macro, industry). 'industry' is intentionally light (capped)."),
        email: z.boolean().optional().describe("Delivery mode (default true). true = email the full digest to the configured recipient and return ONLY a short confirmation (token-saving: digest stays out of model context; on send failure it falls back to returning the digest inline). false = return the full digest inline and send no email. In-chat/interactive callers who want to READ the digest in the reply must pass false — the default keeps the content out of the model context."),
        max_items: z.number().int().min(1).max(60).optional().describe("Global cap on items handed to the summarizer (default 24). Capped sections like 'industry' are kept whole; the rest (ai, macro) share the remaining budget by FAIR round-robin (so a high-volume section can't starve a quieter one). Raise for a fuller digest, lower for a tighter one."),
      },
    },
    async ({ days, sections, email, max_items }: { days?: number; sections?: string[]; email?: boolean; max_items?: number }) => {
      try {
        const secs = sections?.length ? sections : ["ai", "macro", "industry"];
        const sendMail = email ?? true;
        const maxItems = max_items ?? 24;
        const now = Date.now();
        const dayWindow = days ?? 4;

        // Window = max(days-floor, time-since-last-run). windowLabel feeds both the
        // summarizer prompt and the report header.
        const { cutoffMs, windowLabel } = resolveWindow(now, dayWindow, loadState().last_call);

        const cfg = loadFeedsConfig();
        const { items, failed } = await fetchDigestItems(cfg, secs, cutoffMs, maxItems);

        // Even with zero items we still produce a digest (quiet-when-quiet says so).
        const userPrompt = buildSummarizerUserPrompt(items, cfg, secs, windowLabel);
        const { markdown, engine } = await summarize(userPrompt, deps);

        // Record this run as the new "last call" so future since_last_call windows
        // start here. Done after a successful summarize so a hard failure mid-run
        // doesn't advance the marker past unseen items.
        saveState({ last_call: new Date(now).toISOString() });

        const today = new Date().toISOString().slice(0, 10);

        // Per-section counts of what actually landed in the digest (post-compress),
        // for the email:true confirmation; fall back to input counts if the
        // markdown didn't parse into the expected section headings.
        const secCounts = countDigestSections(markdown, cfg, secs);
        const finalCount: Record<string, number> = {};
        let totalFinal = 0;
        for (const k of secs) {
          const c = secCounts[k] ?? items.filter((i) => i.section === k).length;
          finalCount[k] = c;
          totalFinal += c;
        }
        const windowRange = `${new Date(cutoffMs).toISOString().slice(0, 10)}..${today}`;
        const countsStr = secs.map((k) => `${k}: ${finalCount[k]}`).join(" / ");
        const subject = `Digest — ${today} (${totalFinal} item${totalFinal === 1 ? "" : "s"})`;

        // Failed-feed note (appended to the full digest, AND surfaced in the email
        // confirmation so a dead feed is never silently hidden by email mode).
        const failedNote = failed.length
          ? "\n\n---\n_Feeds that failed this run (swap the URL in feeds.json if persistent):_\n" +
            failed.map((f) => `- ${f.source} [${f.section}]: ${f.error}`).join("\n")
          : "";
        const fullMd = markdown + failedNote;
        const failedTag = failed.length ? ` · ${failed.length} feed(s) failed` : "";

        // Delivery contract:
        //   email:true  -> full digest goes to the inbox; return ONLY a short
        //     confirmation (the token-saving path — the digest does NOT enter the
        //     model context). If the send FAILS, fall back to returning the full
        //     digest inline so the content is never lost.
        //   email:false -> full digest returned inline, no mail.
        if (sendMail) {
          try {
            const r = await sendEmail({ subject, text: fullMd, html: markdownToHtml(fullMd) });
            const confirmation =
              `${countsStr} — emailed to ${r.to}, window ${windowRange}${failedTag}. ` +
              "(Full digest delivered to inbox; not returned inline, to save context.)";
            return { content: [{ type: "text", text: confirmation }] };
          } catch (mailErr) {
            const header =
              `email FAILED (${(mailErr as Error).message}) — returning the full digest inline so it isn't lost. ` +
              `window=${windowLabel} sections=${secs.join(",")} engine=${engine}${failedTag}\n\n`;
            return { content: [{ type: "text", text: header + fullMd }] };
          }
        }
        const header =
          `email skipped (email:false) — full digest inline. ${countsStr}. ` +
          `window=${windowLabel} sections=${secs.join(",")} engine=${engine}${failedTag}\n\n`;
        return { content: [{ type: "text", text: header + fullMd }] };
      } catch (err) {
        return { content: [{ type: "text", text: `get_news_digest failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
