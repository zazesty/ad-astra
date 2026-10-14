/**
 * get_odds venue mapping. Network is stubbed.
 *   node test/oddsTool.test.mjs
 */
import { getOdds, DEFAULT_ODDS_SOURCES, ODDS_SOURCES } from "../src/oddsTool.js";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const realFetch = globalThis.fetch;
const calls = [];

function installFetch(handler) {
  calls.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const body = handler(u);
    if (body && body.__html) {
      return new Response(body.__html, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function flightHtml(posts) {
  const inner = JSON.stringify(posts);
  return `<script>self.__next_f.push([1,${JSON.stringify(inner)}])</script>`;
}

function metaPost(over) {
  return {
    id: 38508,
    title: "Will a top insurer exclude AI-written code before 2028?",
    slug: "insurer-ai-code",
    status: "open",
    resolved: false,
    nr_forecasters: 420,
    forecasts_count: 900,
    scheduled_close_time: "2028-01-01T00:00:00Z",
    question: {
      type: "binary",
      resolution: null,
      aggregations: {
        recency_weighted: { latest: { centers: [0.37], forecaster_count: 400 } },
      },
    },
    ...over,
  };
}

console.log("Unit: get_odds sources");

check("defaults stay polymarket+kalshi", DEFAULT_ODDS_SOURCES.join() === "polymarket,kalshi");
check("optional venues are listed after the defaults", ODDS_SOURCES.join() === "polymarket,kalshi,manifold,metaculus");

installFetch((u) => {
  if (u.includes("gamma-api.polymarket.com/public-search")) {
    return {
      events: [{
        closed: false,
        title: "Fed rate decision",
        slug: "fed-rate",
        markets: [{
          question: "Will the Fed cut rates in December?",
          outcomePrices: '["0.62","0.38"]',
          outcomes: '["Yes","No"]',
          volume: "80000",
          liquidity: "12000",
          endDate: "2026-12-16T00:00:00Z",
          active: true,
          closed: false,
        }],
      }],
    };
  }
  if (u.includes("series_ticker")) {
    return {
      markets: [{
        status: "active",
        volume_fp: "1000",
        yes_bid_dollars: "0.40",
        yes_ask_dollars: "0.44",
        title: "Fed funds rate cut",
        close_time: "2026-12-16T00:00:00Z",
        open_interest_fp: "50",
      }],
    };
  }
  if (u.includes("kalshi.com")) {
    return { events: [], cursor: null, markets: [] };
  }
  throw new Error("unexpected " + u);
});

const defaults = await getOdds("fed rate cut unique-default", 3);
check("default call returns polymarket and kalshi", defaults.markets.some((m) => m.source === "polymarket") && defaults.markets.some((m) => m.source === "kalshi"));
check("real-money rows are labeled usd", defaults.markets.every((m) => m.money === "real" && m.volume_unit === "usd"));
const poly = defaults.markets.find((m) => m.source === "polymarket");
check("probability parsed", poly && Math.abs(poly.probability - 0.62) < 1e-9);
check("default does not call manifold or metaculus", calls.every((u) => !u.includes("manifold") && !u.includes("metaculus")));

installFetch((u) => {
  if (u.includes("/search-markets")) {
    return [
      {
        id: "bin1",
        question: "Will the Fed raise interest rates in October?",
        url: "https://manifold.markets/x/fed-raise",
        probability: 0.2,
        volume: 1322,
        totalLiquidity: 100,
        outcomeType: "BINARY",
        closeTime: 1793120400000,
        isResolved: false,
        token: "MANA",
      },
      {
        id: "mc1",
        question: "Who will be elected president in 2028?",
        url: "https://manifold.markets/x/pres-2028",
        probability: null,
        volume: 50000,
        totalLiquidity: 1000,
        outcomeType: "MULTIPLE_CHOICE",
        closeTime: 1857168000000,
        isResolved: false,
        token: "MANA",
      },
      {
        id: "noise",
        question: "Will ceramics prices spike?",
        probability: 0.4,
        volume: 9000,
        outcomeType: "BINARY",
        isResolved: false,
        token: "MANA",
      },
    ];
  }
  if (u.includes("/market/mc1")) {
    return {
      id: "mc1",
      question: "Who will be elected president in 2028?",
      url: "https://manifold.markets/x/pres-2028",
      outcomeType: "MULTIPLE_CHOICE",
      isResolved: false,
      token: "MANA",
      closeTime: 1857168000000,
      volume: 50000,
      totalLiquidity: 1000,
      answers: [
        { text: "J.D. Vance", probability: 0.21, volume: 8000, totalLiquidity: 400 },
        { text: "Other", probability: 0.05, volume: 50, totalLiquidity: 10 },
      ],
    };
  }
  throw new Error("unexpected " + u);
});

const manifold = await getOdds("fed president unique-manifold", 5, ["manifold"]);
const kinds = manifold.markets.map((m) => m.outcome).sort();
check("manifold binary kept and labeled play/mana", manifold.markets.some((m) => m.outcome === "Yes" && m.money === "play" && m.volume_unit === "mana" && m.title.includes("Fed")));
check("manifold multiple-choice expands to answer rows", manifold.markets.some((m) => m.outcome === "J.D. Vance" && m.title.includes("president")));
check("unrelated manifold title dropped", manifold.markets.every((m) => !m.title.toLowerCase().includes("ceramics")));
check("thin answer under the mana floor dropped when a fatter sibling exists", !kinds.includes("Other"));
check("no manifold errors", !manifold.errors);

const html = flightHtml([
  metaPost({}),
  metaPost({
    id: 31246,
    title: "Who will win the bet between Gary Marcus and Miles Brundage about AI?",
    slug: "marcus-brundage",
    nr_forecasters: 800,
    question: {
      type: "multiple_choice",
      resolution: null,
      options: ["Gary Marcus", "Miles Brundage"],
      aggregations: { recency_weighted: { latest: { centers: [0.3, 0.7], forecaster_count: 700 } } },
    },
  }),
  metaPost({
    id: 99,
    title: "When will weakly general AI be announced?",
    question: { type: "date", resolution: null, aggregations: { recency_weighted: { latest: { centers: [0.54] } } } },
  }),
  metaPost({ id: 100, title: "Will a resolved AI market count?", resolved: true, status: "resolved" }),
]);

installFetch(() => ({ __html: html }));
const meta = await getOdds("insurer marcus unique-metaculus", 6, ["metaculus"]);
check("metaculus binary is play-money forecasters", meta.markets.some((m) =>
  m.source === "metaculus" && m.money === "play" && m.volume_unit === "forecasters"
  && m.outcome === "Yes" && Math.abs(m.probability - 0.37) < 1e-9 && m.volume === 420));
check("metaculus multiple-choice uses option probabilities", meta.markets.some((m) => m.outcome === "Miles Brundage" && Math.abs(m.probability - 0.7) < 1e-9));
check("metaculus date question omitted", meta.markets.every((m) => !m.title.toLowerCase().includes("when will")));
check("metaculus resolved omitted", meta.markets.every((m) => !m.title.toLowerCase().includes("resolved")));
check("metaculus url is the public question", meta.markets.some((m) => m.url === "https://www.metaculus.com/questions/38508/insurer-ai-code"));

installFetch(() => ({ __html: "<html>no flight</html>" }));
const bad = await getOdds("AI broken unique-meta-page", 3, ["metaculus"]);
check("unexpected metaculus page is an error, not an empty success", Boolean(bad.errors?.metaculus) && bad.markets.length === 0);

installFetch((u) => {
  if (u.includes("gamma-api")) {
    return u.includes("/markets?") || u.endsWith("/markets") ? [] : { events: [] };
  }
  throw new Error("manifold down");
});
const mixed = await getOdds("fed rate unique-mixed", 3, ["manifold", "polymarket", "manifold"]);
check("duplicate sources are queried once", calls.filter((u) => u.includes("manifold")).length === 1);
check("one venue failing leaves the other", mixed.markets.length === 0 && mixed.errors?.manifold && !mixed.errors.polymarket);

const unknown = await getOdds("fed rate unique-unknown", 2, ["polymarket", "predictit"]);
check("unknown venue is reported", unknown.errors?.predictit === "unknown provider");

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
