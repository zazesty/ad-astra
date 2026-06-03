/**
 * oddsTool.js — prediction-market odds for your (Node) MCP server.
 *
 * Polymarket + Kalshi, both LIVE, both read-only, NO API keys required.
 * Lookup: Polymarket via full-text /public-search; Kalshi via /events
 * (paginated, substring-matched on event title — Kalshi has no search API).
 *
 * ESM module. If your server is CommonJS, swap `export` -> module.exports.
 * Needs Node 18+ (global fetch). Tested on Node 22.
 *
 * Standalone test:  node oddsTool.js "fed rate cut"
 */

const GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

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

async function cachedGet(baseUrl, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}?${qs}`;
  const now = Date.now();
  const hit = _cache.get(url);
  if (hit && now - hit.ts < CACHE_TTL) return hit.data;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "odds-tool/1.0" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${baseUrl}`);
  const data = await resp.json();
  _cache.set(url, { ts: now, data });
  return data;
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
function selectCandidates(markets, limit) {
  if (!markets.length) return [];
  const maxVol = Math.max(...markets.map((m) => m.volume || 0));
  // Relative floor (1% of the pool's top volume) adapts to tiny vs huge events;
  // absolute floor ($1k) catches the case where everything is thinly traded.
  const floor = Math.max(maxVol * 0.01, 1000);
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

// =========================== Aggregator ===========================
const PROVIDERS = { polymarket: fetchPolymarket, kalshi: fetchKalshi };

// Sort comparators (Bug 3). "salience" surfaces the informative markets — those
// near a decision boundary — instead of <1% longshot tails that dominate by
// volume. "volume" keeps the old behavior; "probability" is a plain descending.
const SORTERS = {
  salience: (a, b) => Math.abs(0.5 - a.probability) - Math.abs(0.5 - b.probability),
  probability: (a, b) => b.probability - a.probability,
  volume: (a, b) => b.volume - a.volume,
};

export async function getOdds(query, limit = 5, sources = ["polymarket", "kalshi"], sort = "salience") {
  const cmp = SORTERS[sort] || SORTERS.salience;
  const perVenue = {};
  const errors = {};

  for (const name of sources) {
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
  getOdds(q, 6, ["polymarket", "kalshi"], sort).then((out) => {
    console.log(`\nQuery: ${out.query}  (${out.count} markets, sort=${out.sort})\n`);
    for (const m of out.markets) {
      const pct = (m.probability * 100).toFixed(1) + "%";
      const vol = "$" + Math.round(m.volume).toLocaleString("en-US");
      console.log(`  [${m.source}] ${m.title}`);
      console.log(`      ${m.outcome}: ${pct}   ${vol}   closes ${m.close_date}`);
    }
    if (out.errors) console.log("errors:", out.errors);
  });
}
