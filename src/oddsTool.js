/**
 * oddsTool.js — prediction-market odds for your (Node) MCP server.
 *
 * Defaults: Polymarket + Kalshi. Both LIVE, read-only, no API keys.
 * Optional (pass them in `sources`; not queried by default):
 *   - Manifold — public /v0/search-markets. Play-money (mana), not USD.
 *   - Metaculus — public questions page (the API requires an account token
 *     we do not keep). Play-money community forecasts. Volume is the
 *     forecaster count. Open binary and multiple-choice only; numeric and
 *     date questions are omitted because their aggregate is not a probability.
 *
 * Every row is labeled money:"real"|"play" and volume_unit so mana and
 * forecaster counts are never read as dollars.
 *
 * ESM module. Needs Node 18+ (global fetch). Tested on Node 22.
 *
 * Standalone:  node oddsTool.js "fed rate cut" [salience] [polymarket,kalshi]
 */

const GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const MANIFOLD_API = "https://api.manifold.markets/v0";
const METACULUS_WEB = "https://www.metaculus.com";

export const ODDS_SOURCES = ["polymarket", "kalshi", "manifold", "metaculus"];
export const DEFAULT_ODDS_SOURCES = ["polymarket", "kalshi"];

import { readFileSync } from "node:fs";

// Normalized shape every provider returns. Both venues map into this.
//   probability: 0.0–1.0 implied prob of the primary (YES) outcome
//   volume:      ~USD traded, comparable across venues. Polymarket reports USD
//                directly; Kalshi reports a contract count (volume_fp) which we
//                normalize to ~USD via volume_fp * probability ($1 notional), so
//                the cross-venue sort is now apples-to-apples (approximate).

// --- 60s cache ---
const _cache = new Map();
const CACHE_TTL = 60_000;

async function cachedFetch(url, as, baseForError) {
  const now = Date.now();
  const hit = _cache.get(url);
  if (hit && now - hit.ts < CACHE_TTL) return hit.data;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "odds-tool/1.0",
      Accept: as === "text" ? "text/html" : "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${baseForError || url.split("?")[0]}`);
  const data = as === "text" ? await resp.text() : await resp.json();
  _cache.set(url, { ts: now, data });
  return data;
}

async function cachedGet(baseUrl, params) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null)),
  ).toString();
  const url = qs ? `${baseUrl}?${qs}` : baseUrl;
  return cachedFetch(url, "json", baseUrl);
}

function parseList(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
  return [];
}

// --- relevance gating (Bug 2 fix) -------------------------------------------
// Search backends (esp. Polymarket's) fuzzy-match and let a single noisy token
// — a year, a month, or a near-miss like "ceramics"->"Ceramica" — qualify an
// unrelated market. We strip temporal/stopword noise from the query, then
// require the market title to actually contain the query's CONTENT tokens. If
// nothing meaningful overlaps, the market is dropped (fail closed).
const TEMPORAL_RE = /^(?:(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|h[12]|fall|spring|summer|winter|autumn|year|month|week|day|today|tomorrow|now|soon|early|late|mid)$/i;
const STOPWORDS = new Set([
  "the","a","an","of","in","on","at","to","for","and","or","by","with","is","are",
  "be","will","would","does","do","what","whats","when","who","how","price","odds",
  "chance","probability","market","markets","bet","value","level",
]);

function contentTokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !TEMPORAL_RE.test(t));
}

// A title is relevant if it shares a content token with the query. Exact hits
// always pass. A fuzzy hit requires one token to be a PREFIX of the other (a
// stem relationship): "rate" is a prefix of "rates" -> match; "ceramica" is
// NOT a prefix of "ceramics" (they diverge at the final char) -> no match.
// Min length 4 on the shorter token keeps short coincidences out.
function titleMatchesQuery(title, qTokens) {
  if (!qTokens.length) return false;           // query was all noise -> fail closed
  const tTokens = new Set(contentTokens(title));
  if (!tTokens.size) return false;
  for (const q of qTokens) {
    if (tTokens.has(q)) return true;            // exact content-token hit
    for (const t of tTokens) {                  // stem hit: shorter is prefix of longer
      const [short, long] = q.length <= t.length ? [q, t] : [t, q];
      if (short.length >= 4 && long.startsWith(short)) return true;
    }
  }
  return false;
}
// ---------------------------------------------------------------------------

// =========================== Polymarket ===========================
function marketFromGamma(m, eventSlug, eventTitle = "") {
  if (m.closed || m.active === false) return null;
  const prices = parseList(m.outcomePrices);
  const outcomes = parseList(m.outcomes);
  if (!prices.length) return null;
  const slug = eventSlug || m.slug;
  return {
    source: "polymarket",
    money: "real",
    volume_unit: "usd",
    title: (m.question || eventTitle || "").trim(),
    probability: parseFloat(prices[0]),
    outcome: outcomes.length ? String(outcomes[0]) : "Yes",
    volume: parseFloat(m.volume || 0),
    liquidity: parseFloat(m.liquidity || 0),
    close_date: m.endDate ?? null,
    url: slug ? `https://polymarket.com/event/${slug}` : null,
  };
}

async function searchPolymarket(query, scan = 20) {
  const data = await cachedGet(`${GAMMA_API}/public-search`, { q: query, limit_per_type: scan });
  const qTokens = contentTokens(query);
  const out = [];
  for (const ev of (data && Array.isArray(data.events) ? data.events : [])) {
    if (ev.closed) continue;
    // Relevance gate (Bug 2): the search backend fuzzy-matches, so confirm the
    // event/market title actually shares a content token with the query.
    const evTitle = ev.title || "";
    for (const m of ev.markets || []) {
      const mk = marketFromGamma(m, ev.slug, evTitle);
      if (!mk) continue;
      if (!titleMatchesQuery(`${evTitle} ${mk.title}`, qTokens)) continue;
      out.push(mk);
    }
  }
  return out;
}

async function scanPolymarketByVolume(query, scan = 500) {
  const raw = await cachedGet(`${GAMMA_API}/markets`, {
    limit: scan, active: "true", closed: "false", order: "volume", ascending: "false",
  });
  const q = query.toLowerCase().trim();
  const out = [];
  for (const m of raw) {
    if (q && !(m.question || "").toLowerCase().includes(q)) continue;
    const mk = marketFromGamma(m, null);
    if (mk) out.push(mk);
  }
  return out;
}

async function fetchPolymarket(query, limit = 5) {
  let markets = await searchPolymarket(query);
  if (!markets.length) markets = await scanPolymarketByVolume(query);
  return selectCandidates(markets, limit);
}

// Candidate selection (fix for the salience-vs-volume divergence). The old code
// pre-sliced the pool by VOLUME, so in events with many sub-markets (e.g. a 124-
// candidate nomination market) the kept set was all high-volume novelty bets
// (Oprah, LeBron at <1%) and the genuine frontrunners (Vance 31%, Newsom 25% at
// lower volume) were cut BEFORE salience could surface them. Fix: apply a volume
// FLOOR to remove dead/untraded markets, then rank the survivors by SALIENCE at
// selection time — so frontrunners enter the pool the aggregator sorts.
function selectCandidates(markets, limit, absoluteFloor = 1000) {
  if (!markets.length) return [];
  const maxVol = Math.max(...markets.map((m) => m.volume || 0));
  // Relative floor (1% of the pool's top volume) adapts to tiny vs huge events.
  // absoluteFloor is $1000 for USD venues, lower for mana and forecaster counts.
  // If every row is under the floor, the unfiltered pool is kept.
  const floor = Math.max(maxVol * 0.01, absoluteFloor);
  const live = markets.filter((m) => (m.volume || 0) >= floor);
  const pool = live.length ? live : markets; // never return empty if all are thin
  // Rank the SURVIVORS by salience, keep a generous slice for the aggregator.
  pool.sort((a, b) => Math.abs(0.5 - a.probability) - Math.abs(0.5 - b.probability));
  return pool.slice(0, Math.max(limit * 4, 20));
}

// ============================= Kalshi =============================
// LIVE, read-only. Market reads are PUBLIC — no keys, no RSA signing (that's
// only for /portfolio trading endpoints). Base verified: api.elections.kalshi.com.
function marketFromKalshi(m, ev) {
  if (m.status && !["active", "open"].includes(m.status)) return null;
  if (parseFloat(m.volume_fp ?? 0) <= 0) return null; // skip untraded/empty markets
  const yesBid = parseFloat(m.yes_bid_dollars ?? 0);
  const yesAsk = parseFloat(m.yes_ask_dollars ?? 0);
  let prob;
  if (yesBid > 0 && yesAsk > 0) prob = (yesBid + yesAsk) / 2;            // mid
  else if (m.last_price_dollars != null) prob = parseFloat(m.last_price_dollars);
  else prob = yesBid;
  if (prob == null || Number.isNaN(prob)) return null;
  const sub = m.yes_sub_title || m.title || "";
  const evTitle = ev.title || "";
  const title = sub && evTitle ? `${evTitle} \u2014 ${sub}` : (evTitle || m.title || "");
  const series = (ev.series_ticker || "").toLowerCase();
  return {
    source: "kalshi",
    money: "real",
    volume_unit: "usd",
    title: title.trim(),
    probability: prob,
    outcome: "Yes",
    volume: parseFloat(m.volume_fp ?? 0) * prob,   // ~USD traded (contracts $1 notional); see NOTE
    // Kalshi liquidity_dollars comes back 0 from the markets endpoint even on
    // active markets; open_interest_fp (contracts held open) is the real signal.
    liquidity: parseFloat(m.open_interest_fp ?? 0),
    close_date: m.close_time ?? null,
    url: series ? `https://kalshi.com/markets/${series}` : null, // best-effort slug
  };
}

// Keyword -> Kalshi series prefix(es). Series fetch is exact and complete for a
// topic; the events-substring scan below misses anything past its page window.
// Edit kalshi-series.json (sits next to this file) to add topics with NO code
// change. Built-in defaults below are the fallback if that file is absent.
// Find prefixes by browsing kalshi.com or GET /trade-api/v2/series.
let KALSHI_SERIES_HINTS = {
  fed: ["KXFED"], rate: ["KXFED"], interest: ["KXFED"],
  bitcoin: ["KXBTC"], btc: ["KXBTC"],
};
try {
  KALSHI_SERIES_HINTS = JSON.parse(
    readFileSync(new URL("./kalshi-series.json", import.meta.url), "utf8")
  );
} catch { /* file absent or unreadable — keep built-in defaults */ }

async function fetchKalshiSeries(seriesTickers) {
  const out = [];
  for (const st of seriesTickers) {
    const data = await cachedGet(`${KALSHI_API}/markets`, {
      series_ticker: st, status: "open", limit: 100,
    });
    for (const m of data?.markets || []) {
      const mk = marketFromKalshi(m, { series_ticker: st, title: "" });
      if (mk) out.push(mk);
    }
  }
  return out;
}

async function fetchKalshiEvents(query, limit, maxPages = 5) {
  const q = query.toLowerCase().trim();
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const params = { status: "open", with_nested_markets: "true", limit: 200 };
    if (cursor) params.cursor = cursor;
    const data = await cachedGet(`${KALSHI_API}/events`, params);
    for (const ev of (Array.isArray(data?.events) ? data.events : [])) {
      if (q && !(ev.title || "").toLowerCase().includes(q)) continue;
      for (const m of ev.markets || []) {
        const mk = marketFromKalshi(m, ev);
        if (mk) out.push(mk);
      }
    }
    cursor = data?.cursor || null;
    if (!cursor || out.length >= limit * 6) break;
  }
  return out;
}

async function fetchKalshi(query, limit = 5) {
  const q = query.toLowerCase().trim();
  const hintSeries = [];
  for (const [kw, series] of Object.entries(KALSHI_SERIES_HINTS)) {
    if (q.includes(kw)) hintSeries.push(...series);
  }
  const [seriesHits, eventHits] = await Promise.all([
    hintSeries.length ? fetchKalshiSeries([...new Set(hintSeries)]) : Promise.resolve([]),
    fetchKalshiEvents(query, limit),
  ]);
  const seen = new Set();
  const merged = [];
  for (const m of [...seriesHits, ...eventHits]) {
    const key = `${m.title}|${m.probability}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
  }
  return selectCandidates(merged, limit);
}

// ============================ Manifold ============================
// Public, no key. Volume is mana (play-money), not USD.
function manifoldMoney(token) {
  const unit = String(token || "MANA").toLowerCase();
  return { money: "play", volume_unit: unit === "mana" ? "mana" : unit };
}

function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function rowFromManifoldBinary(m) {
  if (m.isResolved || m.outcomeType !== "BINARY") return null;
  const prob = Number(m.probability);
  if (!Number.isFinite(prob)) return null;
  return {
    source: "manifold",
    ...manifoldMoney(m.token),
    title: String(m.question || "").trim(),
    probability: prob,
    outcome: "Yes",
    volume: Number(m.volume) || 0,
    liquidity: Number(m.totalLiquidity) || 0,
    close_date: isoFromMs(m.closeTime),
    url: m.url || null,
  };
}

function rowsFromManifoldAnswers(full) {
  const question = String(full.question || "").trim();
  const money = manifoldMoney(full.token);
  const close_date = isoFromMs(full.closeTime);
  const rows = [];
  for (const a of full.answers || []) {
    const prob = Number(a.probability);
    const outcome = String(a.text || "").trim();
    if (!outcome || !Number.isFinite(prob)) continue;
    rows.push({
      source: "manifold",
      ...money,
      title: `${question} — ${outcome}`,
      probability: prob,
      outcome,
      volume: Number(a.volume ?? full.volume) || 0,
      liquidity: Number(a.totalLiquidity ?? full.totalLiquidity) || 0,
      close_date,
      url: full.url || null,
    });
  }
  return rows;
}

async function fetchManifold(query, limit = 5) {
  const scan = Math.min(50, Math.max(limit * 4, 15));
  const data = await cachedGet(`${MANIFOLD_API}/search-markets`, {
    term: query,
    filter: "open",
    sort: "most-popular",
    limit: scan,
  });
  const list = Array.isArray(data) ? data : [];
  const qTokens = contentTokens(query);
  const rows = [];
  const multi = [];
  for (const m of list) {
    if (m.isResolved) continue;
    if (!titleMatchesQuery(m.question || "", qTokens)) continue;
    if (m.outcomeType === "BINARY") {
      const row = rowFromManifoldBinary(m);
      if (row) rows.push(row);
    } else if (m.outcomeType === "MULTIPLE_CHOICE" && m.id) {
      multi.push(m);
    }
  }
  multi.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
  const fulls = await Promise.all(multi.slice(0, 4).map(async (m) => {
    try {
      return await cachedGet(`${MANIFOLD_API}/market/${encodeURIComponent(m.id)}`, {});
    } catch {
      return null;
    }
  }));
  for (const full of fulls) {
    if (!full || full.isResolved) continue;
    rows.push(...rowsFromManifoldAnswers(full));
  }
  // 100 mana, not $1000: long-tail local markets are the reason this venue exists.
  return selectCandidates(rows, limit, 100);
}

// ============================ Metaculus ===========================
// The JSON API is authenticated-only. The public questions page embeds the
// same post objects in a Next.js flight payload, including the community
// aggregate. We read that page. No token.
function nextFlightPayloads(html) {
  const marker = 'self.__next_f.push([1,"';
  const out = [];
  let start = 0;
  while (start < html.length) {
    const i = html.indexOf(marker, start);
    if (i < 0) break;
    let j = i + marker.length;
    let body = "";
    while (j < html.length) {
      const c = html[j];
      if (c === "\\") {
        body += c + (html[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (c === '"') break;
      body += c;
      j += 1;
    }
    try {
      const decoded = JSON.parse(`"${body}"`);
      if (typeof decoded === "string") out.push(decoded);
    } catch { /* one bad chunk should not drop the page */ }
    start = j + 1;
  }
  return out;
}

function matchJsonObject(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, k + 1);
    }
  }
  return null;
}

function postsFromFlight(raw) {
  const posts = [];
  const seen = new Set();
  let from = 0;
  while (from < raw.length) {
    const i = raw.indexOf('"nr_forecasters"', from);
    if (i < 0) break;
    from = i + 16;
    const start = raw.lastIndexOf('{"id":', i);
    if (start < 0) continue;
    const text = matchJsonObject(raw, start);
    if (!text) continue;
    let post;
    try { post = JSON.parse(text); } catch { continue; }
    if (!post || post.id == null || seen.has(post.id)) continue;
    if (post.nr_forecasters == null || !post.question || !post.title) continue;
    seen.add(post.id);
    posts.push(post);
  }
  return posts;
}

function probRowsFromMetaculusPost(post) {
  if (post.resolved || post.status !== "open") return [];
  const q = post.question;
  if (!q || q.resolution != null) return [];
  const latest = q.aggregations?.recency_weighted?.latest
    || q.aggregations?.metaculus_prediction?.latest;
  const centers = latest?.centers;
  if (!Array.isArray(centers) || !centers.length) return [];
  const slug = post.slug || "";
  const base = {
    source: "metaculus",
    money: "play",
    volume_unit: "forecasters",
    volume: Number(post.nr_forecasters) || 0,
    liquidity: Number(latest.forecaster_count ?? post.forecasts_count) || 0,
    close_date: post.scheduled_close_time ?? null,
    url: `${METACULUS_WEB}/questions/${post.id}/${slug}`,
  };
  if (q.type === "binary" && centers.length === 1) {
    const p = Number(centers[0]);
    if (!Number.isFinite(p) || p < 0 || p > 1) return [];
    return [{ ...base, title: String(post.title).trim(), probability: p, outcome: "Yes" }];
  }
  if (q.type === "multiple_choice" && Array.isArray(q.options) && q.options.length === centers.length) {
    const title = String(post.title).trim();
    const rows = [];
    for (let n = 0; n < q.options.length; n++) {
      const p = Number(centers[n]);
      const outcome = String(q.options[n] || "").trim();
      if (!outcome || !Number.isFinite(p) || p < 0 || p > 1) continue;
      rows.push({ ...base, title: `${title} — ${outcome}`, probability: p, outcome });
    }
    return rows;
  }
  return [];
}

function marketsFromMetaculusHtml(html, query) {
  if (typeof html !== "string" || !html.includes("__next_f.push")) {
    throw new Error("metaculus: unexpected page");
  }
  const qTokens = contentTokens(query);
  const seen = new Set();
  const rows = [];
  for (const raw of nextFlightPayloads(html)) {
    for (const post of postsFromFlight(raw)) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      if (!titleMatchesQuery(post.title || "", qTokens)) continue;
      rows.push(...probRowsFromMetaculusPost(post));
    }
  }
  return rows;
}

async function fetchMetaculus(query, limit = 5) {
  const url = `${METACULUS_WEB}/questions/?${new URLSearchParams({ search: query, status: "open" })}`;
  const html = await cachedFetch(url, "text", `${METACULUS_WEB}/questions/`);
  const rows = marketsFromMetaculusHtml(html, query);
  // Forecaster counts are small. 5 keeps a lone thin question; the relative
  // floor still drops noise when a heavily forecasted question is in the pool.
  return selectCandidates(rows, limit, 5);
}

// =========================== Aggregator ===========================
const PROVIDERS = {
  polymarket: fetchPolymarket,
  kalshi: fetchKalshi,
  manifold: fetchManifold,
  metaculus: fetchMetaculus,
};

// Sort comparators (Bug 3). "salience" surfaces the informative markets — those
// near a decision boundary — instead of <1% longshot tails that dominate by
// volume. "volume" keeps the old behavior; "probability" is a plain descending.
const SORTERS = {
  salience: (a, b) => Math.abs(0.5 - a.probability) - Math.abs(0.5 - b.probability),
  probability: (a, b) => b.probability - a.probability,
  volume: (a, b) => b.volume - a.volume,
};

export async function getOdds(query, limit = 5, sources = DEFAULT_ODDS_SOURCES, sort = "salience") {
  const cmp = SORTERS[sort] || SORTERS.salience;
  const perVenue = {};
  const errors = {};
  const wanted = [];
  const seenSrc = new Set();
  for (const name of sources || []) {
    if (seenSrc.has(name)) continue;
    seenSrc.add(name);
    wanted.push(name);
  }

  for (const name of wanted) {
    const fn = PROVIDERS[name];
    if (!fn) { errors[name] = "unknown provider"; continue; }
    try {
      const got = await fn(query, limit);   // each venue already returns up to `limit`
      got.sort(cmp);
      perVenue[name] = got;
    } catch (e) {
      errors[name] = `${e.name}: ${e.message}`;
    }
  }

  // Bug 1 fix: round-robin interleave across venues so a high-volume venue
  // (Polymarket) can't structurally crowd out another (Kalshi) that also covers
  // the topic. Each venue's own list is already sorted by `cmp`, so we take its
  // best first, second, etc. in turn until we hit `limit`.
  const venueNames = Object.keys(perVenue);
  const markets = [];
  for (let i = 0; markets.length < limit && venueNames.some((n) => perVenue[n][i]); i++) {
    for (const n of venueNames) {
      if (perVenue[n][i]) markets.push(perVenue[n][i]);
      if (markets.length >= limit) break;
    }
  }
  // Final ordering within the chosen set follows the requested sort.
  markets.sort(cmp);

  const payload = { query, count: markets.length, sort, markets };
  if (Object.keys(errors).length) payload.errors = errors;
  return payload;
}

// --- standalone test harness ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const q = process.argv[2] || "election";
  const sort = process.argv[3] || "salience";
  const sources = (process.argv[4] || "polymarket,kalshi").split(",").map((s) => s.trim()).filter(Boolean);
  getOdds(q, 6, sources, sort).then((out) => {
    console.log(`\nQuery: ${out.query}  (${out.count} markets, sort=${out.sort})\n`);
    for (const m of out.markets) {
      const pct = (m.probability * 100).toFixed(1) + "%";
      const vol = Math.round(m.volume).toLocaleString("en-US");
      console.log(`  [${m.source}] ${m.title}`);
      console.log(`      ${m.outcome}: ${pct}   ${vol} ${m.volume_unit} (${m.money})   closes ${m.close_date}`);
    }
    if (out.errors) console.log("errors:", out.errors);
  });
}
