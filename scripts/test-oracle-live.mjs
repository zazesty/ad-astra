#!/usr/bin/env node
/** Quick live ask_oracle probe — reads MCP_PATH from env file like memory-upsert.mjs */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const raw = readFileSync("/etc/grok-mcp.env", "utf8");
const mcpPath = (raw.match(/^MCP_PATH=(.+)/m)?.[1] || "/mcp").split(",")[0].trim();
const url = `http://127.0.0.1:3000${mcpPath}`;

const n = Number(process.argv[2] || 3);
const results = [];

for (let i = 1; i <= n; i++) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: i,
    method: "tools/call",
    params: {
      name: "ask_oracle",
      arguments: {
        prompt: `Live probe ${i}: what is ${i}+${i}? Reply with just the number.`,
        panel_size: 2,
        synthesize: false,
      },
    },
  });
  const t0 = Date.now();
  let out = "";
  let err = "";
  try {
    out = execSync(
      `curl -s --max-time 90 -X POST "${url}" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (e) {
    err = e.message;
  }
  const ms = Date.now() - t0;
  const line = out.split(/\r?\n/).find(l => l.startsWith("data:"));
  let degraded = null;
  let slotTimeouts = 0;
  if (line) {
    try {
      const j = JSON.parse(line.slice(5).trim());
      const text = j.result?.content?.[0]?.text || "";
      const parsed = JSON.parse(text);
      degraded = parsed.degraded;
      slotTimeouts = (parsed.slots_status || []).filter(s => s.status === "timeout").length;
    } catch {}
  }
  results.push({ i, ms, err: err || null, degraded, slotTimeouts, ok: !err && slotTimeouts === 0 });
  console.log(JSON.stringify({ i, ms, err: err || null, degraded, slotTimeouts }));
}

const allOk = results.every(r => r.ok);
console.log(JSON.stringify({ allOk, count: results.length }));
process.exit(allOk ? 0 : 1);