/**
 * Guard: MCP_TOOLS and TOOL_ANNOTATIONS in toolSurface.ts must match every
 * registerTool("name") in src/ and the live McpServer tools/list output.
 *   node test/toolSurface.test.mjs   (after npm run build)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOLS, MCP_TOOL_COUNT, TOOL_ANNOTATIONS } from "../build/toolSurface.js";
import { buildServer } from "../build/index.js";

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

async function collectTsFiles(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await collectTsFiles(p)));
    else if (ent.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Match registerTool(\n    "name"  or registerTool("name" */
function extractRegisteredNames(src) {
  const names = [];
  const re = /registerTool\(\s*["']([a-z0-9_]+)["']/g;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

console.log("Unit: tool surface drift guard");

const srcRoot = join(process.cwd(), "src");
const files = await collectTsFiles(srcRoot);
const found = [];
for (const f of files) {
  const text = await readFile(f, "utf8");
  found.push(...extractRegisteredNames(text));
}
found.sort();
const expected = [...MCP_TOOLS].sort();

check("MCP_TOOL_COUNT matches list length", MCP_TOOL_COUNT === MCP_TOOLS.length);
check("registerTool count matches MCP_TOOLS", found.length === expected.length);

const missing = expected.filter((n) => !found.includes(n));
const extra = found.filter((n) => !expected.includes(n));
check(
  `no missing tools (missing=${missing.join(",") || "none"})`,
  missing.length === 0,
);
check(
  `no extra tools (extra=${extra.join(",") || "none"})`,
  extra.length === 0,
);
check("count is at least 11 (current ship)", MCP_TOOL_COUNT >= 11);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = buildServer();
const client = new Client({ name: "tool-surface-test", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const { tools } = await client.listTools();
  const listedNames = tools.map((t) => t.name).sort();
  check("tools/list count matches MCP_TOOL_COUNT", tools.length === MCP_TOOL_COUNT);
  check("tools/list names match MCP_TOOLS", JSON.stringify(listedNames) === JSON.stringify(expected));

  const expectedReadOnly = [
    "ask_panel",
    "get_metrics",
    "get_odds",
    "memory_list",
    "memory_retrieve",
    "memory_search",
    "research_fanout",
  ].sort();

  const actualReadOnly = [];
  for (const tool of tools) {
    const ann = tool.annotations;
    const spec = TOOL_ANNOTATIONS[tool.name];
    check(`${tool.name}: has TOOL_ANNOTATIONS entry`, Boolean(spec));
    check(
      `${tool.name}: explicit boolean readOnlyHint & destructiveHint`,
      typeof ann?.readOnlyHint === "boolean" && typeof ann?.destructiveHint === "boolean",
    );
    if (spec && ann) {
      check(
        `${tool.name}: readOnlyHint=${spec.readOnlyHint}, destructiveHint=${spec.destructiveHint}`,
        ann.readOnlyHint === spec.readOnlyHint && ann.destructiveHint === spec.destructiveHint,
      );
    }
    if (ann?.readOnlyHint === true) actualReadOnly.push(tool.name);
  }
  actualReadOnly.sort();
  check(
    "read-only set matches expected tools",
    JSON.stringify(actualReadOnly) === JSON.stringify(expectedReadOnly),
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check(
    "get_news_digest stays non-read-only & non-destructive (default email=true)",
    byName.get_news_digest?.annotations?.readOnlyHint === false &&
      byName.get_news_digest?.annotations?.destructiveHint === false,
  );
  check(
    "standing_todo_add stays non-read-only & non-destructive",
    byName.standing_todo_add?.annotations?.readOnlyHint === false &&
      byName.standing_todo_add?.annotations?.destructiveHint === false,
  );
  check(
    "memory_upsert stays non-read-only & destructiveHint=true",
    byName.memory_upsert?.annotations?.readOnlyHint === false &&
      byName.memory_upsert?.annotations?.destructiveHint === true,
  );
  check(
    "personal_memory_sync stays non-read-only & destructiveHint=true",
    byName.personal_memory_sync?.annotations?.readOnlyHint === false &&
      byName.personal_memory_sync?.annotations?.destructiveHint === true,
  );
} finally {
  await client.close();
  await server.close();
}

console.log(`\n  surface: ${MCP_TOOL_COUNT} tools — ${MCP_TOOLS.join(", ")}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
