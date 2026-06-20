/**
 * gemini-transport-ab.mjs — A/B (live, bills BOTH OpenRouter BYOK + AI Studio).
 * Sibling to gemini-grounding-repro.mjs; answers "does the direct (AI Studio)
 * transport miss grounding less often than OpenRouter engine:native?".
 *
 * IMPORTANT FINDING baked in: on gemini-3.1-pro, AI Studio rejects every
 * grounding-ENFORCEMENT knob — google_search_retrieval(threshold:0) => HTTP 400
 * "use google_search instead"; the always-execute `retrieval` tool is Vertex-only
 * ("not supported in Gemini API"); functionCallingConfig.mode:ANY forces function
 * declarations, not the built-in search tool. So BOTH arms are unavoidably AUTO
 * (model-discretion). We log grounding_mode per call to make that explicit.
 *
 * Held constant: model=gemini-pro-latest, grounded, reasoning_effort=low, prompts.
 * Varied: transport only. Interleaved A/B/A/B to cancel API drift. NO retry —
 * we measure the RAW first-attempt miss rate.
 *
 *   set -a; . /etc/grok-mcp.env; set +a; node test/gemini-transport-ab.mjs [nPerArm]
 */
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const N = Number(process.argv[2] ?? 50);
const OR_KEY = process.env.OPENROUTER_API_KEY;
const AI_KEY = process.env.GEMINI_API_KEY;
if (!OR_KEY || !AI_KEY) { console.error("need OPENROUTER_API_KEY + GEMINI_API_KEY"); process.exit(1); }
const ai = new GoogleGenAI({ apiKey: AI_KEY });

const TODAY = "2026-06-19";
const PROMPTS = [
  `Today is ${TODAY}. What is one significant world-news event from the past 3 days? One line + a source URL.`,
  `Today is ${TODAY}. What notably happened in financial markets this week? Give a source URL.`,
  `Today is ${TODAY}. Name one sports result from the last 5 days, with a source URL.`,
  `Today is ${TODAY}. What is one technology announcement from this week? Give a source URL.`,
  `Today is ${TODAY}. Summarize one political development from the past 3 days, with a source URL.`,
];

// --- Arm A: OpenRouter, engine:"native" (model-discretion / AUTO) ---
async function armA(prompt) {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OR_KEY}`, "X-Title": "grok-mcp-ab" },
    body: JSON.stringify({
      model: "~google/gemini-pro-latest",
      messages: [{ role: "user", content: prompt }],
      reasoning: { effort: "low" },
      plugins: [{ id: "web", engine: "native" }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  const data = await res.json();
  const msg = data?.choices?.[0]?.message ?? {};
  const cites = (msg.annotations ?? []).filter((a) => a?.url_citation?.url ?? a?.url).length;
  return { transport: "openrouter", grounding_mode: "auto", ms, status: res.status, cites,
           finish: data?.choices?.[0]?.finish_reason ?? "?", ok: res.status === 200 };
}

// --- Arm B: AI Studio direct, googleSearch (the ONLY available tool => AUTO) ---
async function armB(prompt) {
  const t0 = Date.now();
  const r = await ai.models.generateContent({
    model: "gemini-pro-latest",
    contents: prompt,
    config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, tools: [{ googleSearch: {} }] },
  });
  const ms = Date.now() - t0;
  const gm = r?.candidates?.[0]?.groundingMetadata ?? {};
  const cites = gm.groundingChunks?.length ?? 0;
  return { transport: "direct-aistudio", grounding_mode: "auto", ms, status: 200, cites,
           queries: gm.webSearchQueries?.length ?? 0,
           finish: r?.candidates?.[0]?.finishReason ?? "?", ok: true };
}

const rowsA = [], rowsB = [];
async function run(fn, prompt, arm, i) {
  let row;
  try { row = { arm, i, prompt: i % PROMPTS.length, ...(await fn(prompt)) }; }
  catch (e) { row = { arm, i, prompt: i % PROMPTS.length, transport: arm, ok: false, cites: 0,
                      status: "THROW", err: String(e?.message ?? e).slice(0, 120) }; }
  console.log(JSON.stringify(row));
  return row;
}

for (let i = 0; i < N; i++) {
  const p = PROMPTS[i % PROMPTS.length];
  rowsA.push(await run(armA, p, "A", i)); // interleaved A then B, same prompt
  rowsB.push(await run(armB, p, "B", i));
}

function summary(name, rows) {
  const ok = rows.filter((r) => r.ok);
  const miss = ok.filter((r) => r.cites === 0);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
  const errs = rows.length - ok.length;
  console.log(`${name}: ok=${ok.length}/${rows.length} errors=${errs} ` +
    `MISS(0 cites)=${miss.length}/${ok.length} (${(100 * miss.length / (ok.length || 1)).toFixed(1)}%) ` +
    `lat p50=${p(0.5)} p90=${p(0.9)} max=${lat[lat.length - 1] ?? 0}`);
}
console.log("\n=== A/B SUMMARY (first-attempt, no retry; both arms AUTO — enforcement unavailable on AI Studio) ===");
summary("A openrouter(native)", rowsA);
summary("B direct(AI Studio)  ", rowsB);
