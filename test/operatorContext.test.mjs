/**
 * Unit tests for operatorContext.ts (get_operator_context tool + MCP resources).
 *   node test/operatorContext.test.mjs   (after npm run build)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getOperatorContext } from "../build/operatorContext.js";
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

console.log("Unit: operatorContext tool + resources");

const dir = mkdtempSync(join(tmpdir(), "op-ctx-"));
const opPath = join(dir, "OPERATOR.md");
const agentsPath = join(dir, "AGENTS.md");
const claudePath = join(dir, "CLAUDE.md");
const todosPath = join(dir, "standing-todos.json");

const savedEnv = {
  OPERATOR_MD_PATH: process.env.OPERATOR_MD_PATH,
  AGENTS_MD_PATH: process.env.AGENTS_MD_PATH,
  CLAUDE_MD_PATH: process.env.CLAUDE_MD_PATH,
  TODOS_PATH: process.env.TODOS_PATH,
};

try {
  writeFileSync(opPath, "# OPERATOR\nRule 1\n");
  writeFileSync(agentsPath, "# AGENTS\nStack note\n");
  writeFileSync(claudePath, "# CLAUDE\nHarness note\n");
  writeFileSync(
    todosPath,
    JSON.stringify({
      schema: "standing-todos/v1",
      updated: "2026-11-23T12:00:00Z",
      items: [
        {
          id: "done-item",
          title: "Already finished",
          status: "done",
          owner: "agent",
          author: "Test",
          priority: 1,
        },
        {
          id: "low-pri",
          title: "Low priority open",
          status: "open",
          owner: "either",
          author: "Gemini",
          priority: 4,
          next_action: "Do later",
        },
        {
          id: "high-pri",
          title: "High priority open",
          status: "open",
          owner: "agent",
          author: "Antigravity",
          priority: 2,
          plain: "Plain text",
          next_action: "Do first",
          notes: [{ ts: "2026-11-23T12:00:00Z", text: "Note one" }],
        },
      ],
    }),
  );

  process.env.OPERATOR_MD_PATH = opPath;
  process.env.AGENTS_MD_PATH = agentsPath;
  process.env.CLAUDE_MD_PATH = claudePath;
  process.env.TODOS_PATH = todosPath;

  const manifest = getOperatorContext("manifest");
  check("manifest section tag", manifest.section === "manifest");
  check("manifest operator available + bytes", manifest.files.operator.available && manifest.files.operator.bytes > 0);
  check("manifest has no full file content", !("content" in manifest.files.operator));
  check("manifest todos open_count excludes done items", manifest.todos.open_count === 2);

  const todosOnly = getOperatorContext("todos");
  check("todos section filters to open only", todosOnly.open_count === 2 && todosOnly.items.length === 2);
  check(
    "todos sorted by priority ascending",
    todosOnly.items[0].id === "high-pri" && todosOnly.items[1].id === "low-pri",
  );
  check("todos omit done item", !todosOnly.items.some((i) => i.id === "done-item"));

  const opOnly = getOperatorContext("operator");
  check("operator section returns content", opOnly.available && opOnly.content.includes("Rule 1"));

  const agentsOnly = getOperatorContext("agents");
  check("agents section returns content", agentsOnly.available && agentsOnly.content.includes("Stack note"));

  const claudeOnly = getOperatorContext("claude");
  check("claude section returns content", claudeOnly.available && claudeOnly.content.includes("Harness note"));

  const all = getOperatorContext("all");
  check(
    "all section returns all 4 parts",
    all.operator.available && all.agents.available && all.claude.available && all.todos.open_count === 2,
  );

  // Missing file handling
  process.env.CLAUDE_MD_PATH = join(dir, "MISSING.md");
  const missing = getOperatorContext("claude");
  check("missing file returns available=false without throwing", missing.available === false && missing.content === null);
  process.env.CLAUDE_MD_PATH = claudePath;

  // MCP round-trip (tool + resources)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "op-ctx-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const callRes = await client.callTool({ name: "get_operator_context", arguments: { section: "todos" } });
    const parsed = JSON.parse(callRes.content[0].text);
    check("MCP tool call get_operator_context returns open todos", parsed.open_count === 2 && parsed.items[0].id === "high-pri");

    const { resources } = await client.listResources();
    const uris = new Set(resources.map((r) => r.uri));
    for (const uri of ["operator://rules", "operator://agents", "operator://claude", "todos://open"]) {
      check(`resources/list includes ${uri}`, uris.has(uri));
    }

    const rulesRead = await client.readResource({ uri: "operator://rules" });
    check("resources/read operator://rules returns markdown", rulesRead.contents[0].text.includes("Rule 1"));

    const todosRead = await client.readResource({ uri: "todos://open" });
    const todosText = todosRead.contents[0].text;
    check(
      "resources/read todos://open formats open items and omits done",
      todosText.includes("High priority open") && !todosText.includes("Already finished"),
    );
  } finally {
    await client.close();
    await server.close();
  }
} finally {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
