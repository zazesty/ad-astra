/**
 * gemini-latency-matrix.mjs — controlled latency decomposition (live, bills both).
 * Addresses confounds in the earlier A/B:
 *   - UNIQUE nonce per call (defeats prompt/prefix caching).
 *   - 2x2 matrix: provider {openrouter native, direct AI Studio} x {grounded, ungrounded}
 *     so we can separate PROVIDER latency from the GROUNDING-loop latency.
 *   - logs reasoning/thinking tokens per call (the suspected real driver) and the
 *     first citation HOST (confirms both arms use Gemini-native Google Search =
 *     vertexaisearch.* redirects, NOT OpenRouter's Exa web plugin).
 * Held constant: model=gemini-pro-latest, effort=low. Interleaved to cancel drift.
 *
 *   set -a; . /etc/grok-mcp.env; set +a; node test/gemini-latency-matrix.mjs [reps]
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
const REPS = Number(process.argv[2] ?? 8);
const OR = process.env.OPENROUTER_API_KEY, AI = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: AI });

const TOPICS = ["world news", "financial markets", "a sports result", "a technology announcement",
  "a political development", "a scientific finding", "an entertainment story", "a weather/climate event"];
// Unique nonce FIRST so no two calls share a cacheable prefix.
const mkPrompt = (nonce, topic) =>
  `[ref ${nonce}] Today is 2026-06-20. Name one specific ${topic} item from the past 3 days, with a source URL.`;
const host = (u) => { try { return new URL(u).host; } catch { return "?"; } };

async function direct(prompt, grounded) {
  const t0 = Date.now();
  const r = await ai.models.generateContent({ model: "gemini-pro-latest", contents: prompt,
    config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, ...(grounded ? { tools: [{ googleSearch: {} }] } : {}) } });
  const gm = r?.candidates?.[0]?.groundingMetadata ?? {};
  const u = r?.usageMetadata ?? {};
  return { ms: Date.now() - t0, think: u.thoughtsTokenCount ?? 0, cites: gm.groundingChunks?.length ?? 0,
    host: host(gm.groundingChunks?.[0]?.web?.uri ?? "") };
}
async function orouter(prompt, grounded) {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OR}` },
    body: JSON.stringify({ model: "~google/gemini-pro-latest", messages: [{ role: "user", content: prompt }],
      reasoning: { effort: "low" }, ...(grounded ? { plugins: [{ id: "web", engine: "native" }] } : {}) }) });
  const d = await res.json(); const u = d?.usage ?? {}; const m = d?.choices?.[0]?.message ?? {};
  const ann = (m.annotations ?? []).map((a) => a?.url_citation?.url ?? a?.url).filter(Boolean);
  return { ms: Date.now() - t0, think: u.completion_tokens_details?.reasoning_tokens ?? 0, cites: ann.length, host: host(ann[0] ?? "") };
}

const CELLS = [
  ["OR  grounded", (p) => orouter(p, true)],
  ["OR  ungrnd  ", (p) => orouter(p, false)],
  ["AIS grounded", (p) => direct(p, true)],
  ["AIS ungrnd  ", (p) => direct(p, false)],
];
const data = Object.fromEntries(CELLS.map(([n]) => [n, []]));
let nonce = 1000;
for (let rep = 0; rep < REPS; rep++) {
  for (const [name, fn] of CELLS) {
    const topic = TOPICS[nonce % TOPICS.length];
    const p = mkPrompt(nonce++, topic);
    let row;
    try { row = await fn(p); } catch (e) { row = { err: String(e?.message ?? e).slice(0, 70) }; }
    data[name].push(row);
    console.log(`${name} | ${JSON.stringify(row)}`);
  }
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / (a.length || 1));
console.log("\n=== MATRIX SUMMARY (unique prompts, effort=low) ===");
for (const [name] of CELLS) {
  const ok = data[name].filter((r) => !r.err);
  const ms = ok.map((r) => r.ms), th = ok.map((r) => r.think);
  const hosts = [...new Set(ok.map((r) => r.host).filter((h) => h && h !== "?"))];
  console.log(`${name}: n=${ok.length} errs=${data[name].length - ok.length} ` +
    `lat med=${med(ms)} avg=${avg(ms)} | think med=${med(th)} avg=${avg(th)} | ` +
    `cites avg=${(ok.reduce((a, r) => a + r.cites, 0) / (ok.length || 1)).toFixed(1)} | hosts=${hosts.join(",") || "-"}`);
}
