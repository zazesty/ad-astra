/**
 * gemini-grounding-repro.mjs — DIAGNOSTIC (live, bills OpenRouter credits).
 *
 * Fires one fixed recent-events grounded prompt N times through the SAME
 * OpenRouter request shape ask_panel uses (plugins:[{id:web,engine:native}]),
 * recording per run: end-to-end latency, HTTP status, finish_reason, citation
 * count, and whether any grounding signal is present in the raw payload.
 *
 * Goal: distinguish "grounding silently didn't fire" (clean text, 0 citations,
 * latency well under timeout) from "request timed out" (abort/throw).
 *
 *   set -a; . /etc/grok-mcp.env; set +a; node test/gemini-grounding-repro.mjs [N]
 */
const N = Number(process.argv[2] ?? 10);
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }

const MODEL = "~google/gemini-pro-latest";
const TODAY = "2026-06-19";
const PROMPT =
  `Today is ${TODAY}. Using live web search, what are the 3 most significant ` +
  `world-news events from the past 7 days? For each give a one-line summary ` +
  `and a source URL. If you cannot search the web, say so explicitly.`;

const body = {
  model: MODEL,
  messages: [{ role: "user", content: PROMPT }],
  reasoning: { effort: "high" },
  plugins: [{ id: "web", engine: "native" }],
};

function summarize(data) {
  const msg = data?.choices?.[0]?.message ?? {};
  const finish = data?.choices?.[0]?.finish_reason ?? "?";
  const text = typeof msg?.content === "string" ? msg.content : "";
  const ann = Array.isArray(msg?.annotations) ? msg.annotations : [];
  const cites = ann.filter((a) => a?.url_citation?.url ?? a?.url).length;
  // Any other grounding fingerprint OpenRouter/Gemini may attach.
  const hasNativeUsage = JSON.stringify(data?.usage ?? {}).match(/search|grounding|web/i) ? true : false;
  return { finish, served: data?.model ?? "?", textLen: text.length, cites, hasNativeUsage,
           refusesWeb: /cannot (search|access).*(web|internet)|don'?t have (access|the ability)/i.test(text) };
}

const rows = [];
for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  let row;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}`,
                 "X-Title": "grok-mcp-repro" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      row = { run: i, ms, status: res.status, err: (await res.text().catch(()=>"")).slice(0,200) };
    } else {
      const data = await res.json();
      row = { run: i, ms, status: 200, ...summarize(data) };
    }
  } catch (e) {
    row = { run: i, ms: Date.now() - t0, status: "ABORT/THROW", err: String(e?.name ?? e) };
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

const ok = rows.filter((r) => r.status === 200);
const grounded = ok.filter((r) => r.cites > 0);
const lat = ok.map((r) => r.ms).sort((a,b)=>a-b);
const p = (q) => lat.length ? lat[Math.min(lat.length-1, Math.floor(q*lat.length))] : 0;
console.log("\n=== SUMMARY ===");
console.log(`runs=${N} http200=${ok.length} grounded(cites>0)=${grounded.length} ungrounded=${ok.length-grounded.length}`);
console.log(`latency ms: min=${lat[0]} p50=${p(0.5)} p90=${p(0.9)} max=${lat[lat.length-1]}`);
console.log(`any near 120s timeout: ${lat.some((m)=>m>110000)}`);
