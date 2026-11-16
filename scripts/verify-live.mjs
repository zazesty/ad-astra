#!/usr/bin/env node
/**
 * Functional verification + stamp for grok-mcp before git push.
 * Runs build, 100% unit tests, service freshness check, loopback tools/list,
 * optional Funnel smoke-test (when /etc/grok-mcp.env is readable), and live
 * tools/call probes for changed areas, then stamps .git/verified-head.
 *
 * Usage:
 *   node scripts/verify-live.mjs [--all] [--no-restart-check]
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const RUN_ALL = args.has("--all");
const SKIP_RESTART_CHECK = args.has("--no-restart-check");

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function fail(msg) {
  console.error(`verify-live: FAIL — ${msg}`);
  process.exit(1);
}

// 1. Clean tree check so stamped HEAD matches disk/build exactly.
const dirty = run("git status --porcelain").trim();
if (dirty) {
  fail(`working tree is dirty; commit or stash first:\n${dirty}`);
}
const headSha = run("git rev-parse HEAD").trim();

// 2. Build + unit tests.
console.log("verify-live: running build + unit tests...");
try {
  execSync("npm run build && cp src/kalshi-series.json build/ && npm test", {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  fail("build or unit tests failed");
}

// 3. Service active + started after latest build/*.js if HEAD touched src/ or package.json.
const active = run("systemctl is-active grok-mcp.service").trim();
if (active !== "active") {
  fail(`grok-mcp.service is ${active}, expected active`);
}

let diffRange = "HEAD~1..HEAD";
try {
  const ahead = run("git rev-list --count @{u}..HEAD").trim();
  if (Number(ahead) > 0) diffRange = "@{u}..HEAD";
} catch {
  // No upstream configured; fall back to HEAD~1..HEAD.
}
let changedFiles = [];
try {
  changedFiles = run(`git diff --name-only ${diffRange}`)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  changedFiles = [];
}

const codeTouched = changedFiles.some((f) => f.startsWith("src/") || f === "package.json");
if (codeTouched && !SKIP_RESTART_CHECK) {
  const pid = Number(run("systemctl show -p MainPID --value grok-mcp.service").trim());
  if (!pid) fail("grok-mcp.service has no MainPID");
  const procStartMs = statSync(`/proc/${pid}`).ctimeMs;
  const buildDir = join(ROOT, "build");
  const newestBuildMs = Math.max(
    ...readdirSync(buildDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => statSync(join(buildDir, f)).mtimeMs),
  );
  // Allow 2s clock/fs slack only if service started after or within build window? No:
  // service must have started AFTER the source/build was updated, otherwise restart first.
  const latestSrcCommitSec = Number(run("git log -1 --format=%ct -- src/ package.json").trim() || "0");
  if (procStartMs < latestSrcCommitSec * 1000) {
    fail(
      `grok-mcp.service (pid ${pid}) started before latest src/ commit — run: sudo systemctl restart grok-mcp.service`,
    );
  }
  void newestBuildMs;
}

// 4. Resolve loopback URL (never print the path).
function resolveLoopbackUrl() {
  if (process.env.MCP_URL) return process.env.MCP_URL.trim();
  try {
    const raw = readFileSync("/etc/grok-mcp.env", "utf8");
    const mcpPath = (raw.match(/^MCP_PATH=(.+)/m)?.[1] || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    const port = (raw.match(/^PORT=(.+)/m)?.[1] || "3000").trim();
    if (mcpPath) return `http://127.0.0.1:${port}${mcpPath.startsWith("/") ? mcpPath : "/" + mcpPath}`;
  } catch {
    // /etc/grok-mcp.env is root-only; fall back to loopback config.toml
  }
  try {
    const toml = readFileSync("/root/.grok/config.toml", "utf8");
    const sec = toml.match(/\[mcp_servers\.astra\][\s\S]*?(?=\n\[|$)/)?.[0] || "";
    const url = sec.match(/^url\s*=\s*"([^"]+)"/m)?.[1];
    if (url) return url.trim();
  } catch {
    // ignore
  }
  return "";
}

const mcpUrl = resolveLoopbackUrl();
if (!mcpUrl) {
  fail("could not determine loopback MCP URL (set MCP_URL or run with readable /root/.grok/config.toml)");
}

async function mcpPost(payload, timeoutMs = 60_000) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  if (dataLine) return JSON.parse(dataLine.slice(5).trim());
  return JSON.parse(text);
}

// 5. Loopback tools/list check against build/toolSurface.js.
const { MCP_TOOL_COUNT } = await import(join(ROOT, "build/toolSurface.js"));
const listResp = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 10_000);
const listedTools = listResp?.result?.tools || [];
if (listedTools.length !== MCP_TOOL_COUNT) {
  fail(`tools/list returned ${listedTools.length} tools, expected ${MCP_TOOL_COUNT}`);
}
console.log(`verify-live: loopback tools/list OK (${listedTools.length} tools)`);

// Optional public Funnel smoke check when running with /etc/grok-mcp.env readable.
let smokeStatus = "loopback-only";
try {
  readFileSync("/etc/grok-mcp.env", "utf8");
  const smokeScript = "/root/astra-config/scripts/smoke-test.sh";
  if (existsSync(smokeScript)) {
    const out = execFileSync("bash", [smokeScript], { encoding: "utf8" });
    const redacted = out.replace(/\/mcp\/[^\s)]+/g, "/mcp/REDACTED").trim();
    console.log(redacted);
    smokeStatus = "funnel+loopback";
  }
} catch (err) {
  if (err?.code !== "EACCES" && err?.code !== "ENOENT") {
    fail(`smoke-test.sh failed: ${err?.message || err}`);
  }
}

// 6. Live functional tools/call probes.
async function callToolRaw(name, argsObj, timeoutMs = 60_000) {
  const resp = await mcpPost(
    {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name, arguments: argsObj },
    },
    timeoutMs,
  );
  if (resp?.error) throw new Error(`${name} RPC error: ${JSON.stringify(resp.error)}`);
  if (resp?.result?.isError) throw new Error(`${name} returned isError: ${resp.result?.content?.[0]?.text}`);
  return resp?.result?.content?.[0]?.text || "";
}

async function callTool(name, argsObj, timeoutMs = 60_000) {
  return JSON.parse(await callToolRaw(name, argsObj, timeoutMs));
}

const touched = (names) => RUN_ALL || changedFiles.some((f) => names.some((n) => f.endsWith(n)));
const probes = [];

// Always run a $0 read-only functional probe.
{
  const res = await callTool("memory_list", { limit: 1 }, 15_000);
  if (!Array.isArray(res?.items) && typeof res?.count !== "number") {
    fail(`memory_list returned unexpected payload`);
  }
  probes.push("memory_list");
}

if (touched(["researchFanout.ts", "modelPins.ts", "geminiCore.ts", "budgetProfile.ts", "timeouts.ts"])) {
  console.log("verify-live: probing research_fanout...");
  const res = await callTool(
    "research_fanout",
    {
      prompt: "What is the current US federal funds target range according to federalreserve.gov?",
      max_legs: 1,
      synthesize: false,
    },
    60_000,
  );
  if (res?.degraded !== false || res?.legs?.[0]?.status !== "ok" || !(res?.citations?.length > 0)) {
    fail(`research_fanout probe failed: ${JSON.stringify({ degraded: res?.degraded, slots: res?.slots_status, leg0: res?.legs?.[0]?.status, cites: res?.citations?.length })}`);
  }
  probes.push("research_fanout");
}

if (touched(["panel.ts", "oracleClassifier.ts", "oracleEngine.ts", "grokCore.ts", "lenses.ts", "geminiCore.ts"])) {
  console.log("verify-live: probing ask_panel...");
  const res = await callTool(
    "ask_panel",
    {
      prompt: "Reply with OK.",
      specs: [{ model: "grok" }],
      synthesize: false,
    },
    45_000,
  );
  const rows = Array.isArray(res) ? res : res?.results;
  if (!Array.isArray(rows) || !rows[0]?.ok || rows[0]?.transport !== "or") {
    fail(`ask_panel probe failed: ${JSON.stringify(res)}`);
  }
  probes.push("ask_panel");
}

if (touched(["oddsTool.js"])) {
  console.log("verify-live: probing get_odds...");
  const res = await callTool("get_odds", { query: "fed", limit: 1 }, 30_000);
  if (!res || typeof res !== "object") fail("get_odds probe returned invalid JSON");
  probes.push("get_odds");
}

if (touched(["memory.ts", "memoryEmbeddings.ts"])) {
  console.log("verify-live: probing memory_search...");
  const res = await callTool("memory_search", { query: "astra", limit: 1 }, 15_000);
  if (!res || typeof res !== "object") fail("memory_search probe returned invalid JSON");
  probes.push("memory_search");
}

if (touched(["metrics.ts"])) {
  console.log("verify-live: probing get_metrics...");
  const res = await callTool("get_metrics", { window_days: 1 }, 15_000);
  if (!res || typeof res !== "object") fail("get_metrics probe returned invalid JSON");
  probes.push("get_metrics");
}

if (touched(["newsDigest.ts"])) {
  console.log("verify-live: probing get_news_digest (email=false)...");
  const txt = await callToolRaw("get_news_digest", { days: 1, max_items: 4, email: false }, 60_000);
  if (!txt || txt.trim().length < 20) fail("get_news_digest probe returned empty text");
  probes.push("get_news_digest");
}

// 7. Write verification stamp for pre-push hook.
const stampPath = join(ROOT, ".git", "verified-head");
const stamp = {
  sha: headSha,
  ts: new Date().toISOString(),
  smoke: smokeStatus,
  probes,
};
writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + "\n", { mode: 0o644 });
console.log(`verify-live: PASS sha=${headSha.slice(0, 7)} probes=${probes.join(",")} smoke=${smokeStatus}`);
