/**
 * Guard: MCP_TOOLS in toolSurface.ts must match every registerTool("name") in src/.
 *   node test/toolSurface.test.mjs   (after npm run build)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_TOOLS, MCP_TOOL_COUNT } from "../build/toolSurface.js";

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
check("count is at least 10 (current ship)", MCP_TOOL_COUNT >= 10);

console.log(`\n  surface: ${MCP_TOOL_COUNT} tools — ${MCP_TOOLS.join(", ")}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
