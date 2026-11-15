/**
 * Unit tests for tier1-personal-sync archive & personal_memory_sync MCP tool.
 *   node test/personalMemorySync.test.mjs   (after npm run build)
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  applySyncDecisions,
  computeSyncDiff,
  loadTier1Archive,
  mergeBootstrapExports,
  parseArchiveMarkdown,
  renderArchiveMarkdown,
} from "../build/personalMemorySync.js";
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

async function expectReject(name, fn, substr) {
  let ok = false;
  try {
    await fn();
  } catch (err) {
    ok = !substr || String(err.message || err).includes(substr);
  }
  check(name, ok);
}

console.log("Unit: personal_memory_sync & tier1-personal-sync");

const dir = await mkdtemp(join(tmpdir(), "pms-test-"));
const prevGeminiKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;

try {
  // 1. Empty archive diff
  const emptyArchive = await loadTier1Archive(dir);
  check("missing archive starts empty", emptyArchive.exists === false && emptyArchive.active.length === 0);

  const d1 = computeSyncDiff(emptyArchive, "claude", [
    "- Zavdi Aniela, 28M, East Bay CA.",
    "zavdi aniela, 28m, east bay ca", // duplicate in same client
    "Favorite ice cream flavor is coffee.",
    "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
  ]);
  check("collapses duplicate client input", d1.summary.client_duplicates_collapsed === 1);
  check("all 3 distinct items are client_only", d1.summary.client_only === 3);
  check("diff requires 1-step review", d1.status === "review_required" && d1.review_required === true);

  // 2. Enforce 1-step review gate
  await expectReject(
    "rejects apply without confirmed_by_user=true",
    () =>
      applySyncDecisions(
        {
          client: "claude",
          native_memories: [
            "Zavdi Aniela, 28M, East Bay CA.",
            "Favorite ice cream flavor is coffee.",
            "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
          ],
          review_token: d1.review_token,
          confirmed_by_user: false,
          approve_defaults: true,
        },
        dir,
      ),
    "confirmed_by_user",
  );

  await expectReject(
    "rejects apply with bad review_token",
    () =>
      applySyncDecisions(
        {
          client: "claude",
          native_memories: [
            "Zavdi Aniela, 28M, East Bay CA.",
            "Favorite ice cream flavor is coffee.",
            "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
          ],
          review_token: "deadbeef00000000",
          confirmed_by_user: true,
          approve_defaults: true,
        },
        dir,
      ),
    "stale_review_token",
  );

  await expectReject(
    "rejects apply when decisions omitted and approve_defaults not set",
    () =>
      applySyncDecisions(
        {
          client: "claude",
          native_memories: [
            "Zavdi Aniela, 28M, East Bay CA.",
            "Favorite ice cream flavor is coffee.",
            "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
          ],
          review_token: d1.review_token,
          confirmed_by_user: true,
        },
        dir,
      ),
    "missing_decisions",
  );

  // 3. Apply initial claude items
  const a1 = await applySyncDecisions(
    {
      client: "claude",
      native_memories: [
        "- Zavdi Aniela, 28M, East Bay CA.",
        "Favorite ice cream flavor is coffee.",
        "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
      ],
      review_token: d1.review_token,
      confirmed_by_user: true,
      approve_defaults: true,
    },
    dir,
  );
  check("apply adds 3 items to VPS", a1.ok && a1.active_count === 3 && a1.vps_applied.added.length === 3);

  const rawMd = await readFile(join(dir, "tier1-personal-sync.md"), "utf8");
  check("writes tier1-personal-sync.md", rawMd.includes("id: tier1-personal-sync") && rawMd.includes("ThinkPad X1 Carbon Gen 7"));
  const indexMd = await readFile(join(dir, "index.md"), "utf8");
  check("regenerates index.md with tier1-personal-sync", indexMd.includes("tier1-personal-sync"));

  // Round-trip markdown parse check
  const loaded = await loadTier1Archive(dir);
  const reparsed = parseArchiveMarkdown(renderArchiveMarkdown(loaded), {
    exists: true,
    version: loaded.version,
    updated: loaded.updated,
  });
  check("markdown round-trip preserves active items and client watermark", reparsed.active.length === 3 && reparsed.clients.claude?.item_count === 3);

  // 4. Wiped Grok client gets VPS-to-client additions gated by 1-step review
  const dGrokWiped = computeSyncDiff(loaded, "grok", []);
  check("wiped client sees 3 vps_only items", dGrokWiped.summary.vps_only === 3);
  check("vps_only requires review before push", dGrokWiped.status === "review_required" && dGrokWiped.review_required === true);

  const aGrokWiped = await applySyncDecisions(
    {
      client: "grok",
      native_memories: [],
      review_token: dGrokWiped.review_token,
      confirmed_by_user: true,
      approve_defaults: true,
    },
    dir,
  );
  check("apply emits client_actions.add for wiped client", aGrokWiped.client_actions.add.length === 3);

  // 5. Zombie resurrection prevention (intentional client delete -> retire_on_vps -> tombstone blocks stale client)
  const laptopItem = loaded.active.find((x) => x.text.includes("ThinkPad"));
  const afterClaudeDelete = computeSyncDiff(await loadTier1Archive(dir), "claude", [
    "Zavdi Aniela, 28M, East Bay CA.",
    "Favorite ice cream flavor is coffee.",
  ]);
  check("deleted client item surfaces as vps_only (not silently re-pushed)", afterClaudeDelete.summary.vps_only === 1);
  const vpsKey = afterClaudeDelete.items.find((i) => i.vps_id === laptopItem.id).key;

  const retireRes = await applySyncDecisions(
    {
      client: "claude",
      native_memories: [
        "Zavdi Aniela, 28M, East Bay CA.",
        "Favorite ice cream flavor is coffee.",
      ],
      review_token: afterClaudeDelete.review_token,
      confirmed_by_user: true,
      decisions: [{ key: vpsKey, action: "retire_on_vps" }],
    },
    dir,
  );
  check("retire_on_vps moves item to tombstone", retireRes.active_count === 2 && retireRes.tombstone_count === 1 && retireRes.vps_applied.retired.length === 1);

  // Now Gemini still holds the deleted item and syncs -> MUST be flagged as tombstoned_zombie, NOT client_only!
  const geminiDiff = computeSyncDiff(await loadTier1Archive(dir), "gemini", [
    "Zavdi Aniela, 28M, East Bay CA.",
    "Favorite ice cream flavor is coffee.",
    "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
  ]);
  check("stale client carrying retired item is caught as tombstoned_zombie", geminiDiff.summary.tombstoned_zombies === 1 && geminiDiff.summary.client_only === 0);

  const geminiApply = await applySyncDecisions(
    {
      client: "gemini",
      native_memories: [
        "Zavdi Aniela, 28M, East Bay CA.",
        "Favorite ice cream flavor is coffee.",
        "Daily driver laptop is ThinkPad X1 Carbon Gen 7.",
      ],
      review_token: geminiDiff.review_token,
      confirmed_by_user: true,
      approve_defaults: true,
    },
    dir,
  );
  check("tombstoned_zombie outputs delete instruction and does not resurrect on VPS", geminiApply.active_count === 2 && geminiApply.client_actions.delete.length === 1);

  // 6. Conflict detection & mandatory explicit conflict decision
  const conflictDiff = computeSyncDiff(await loadTier1Archive(dir), "grok", [
    "Zavdi Aniela, 28M, Concord CA (East Bay), ADHD.",
    "Favorite ice cream flavor is coffee.",
  ]);
  check("near-duplicate wording surfaces as conflict", conflictDiff.summary.conflicts === 1);

  await expectReject(
    "rejects apply when conflict lacks explicit decision even with approve_defaults=true",
    () =>
      applySyncDecisions(
        {
          client: "grok",
          native_memories: [
            "Zavdi Aniela, 28M, Concord CA (East Bay), ADHD.",
            "Favorite ice cream flavor is coffee.",
          ],
          review_token: conflictDiff.review_token,
          confirmed_by_user: true,
          approve_defaults: true,
        },
        dir,
      ),
    "conflict_decision_required",
  );

  const conflictItem = conflictDiff.items.find((i) => i.kind === "conflict");
  const mergedText = "Zavdi Aniela, 28M, Concord (East Bay CA), ADHD.";
  const conflictApplied = await applySyncDecisions(
    {
      client: "grok",
      native_memories: [
        "Zavdi Aniela, 28M, Concord CA (East Bay), ADHD.",
        "Favorite ice cream flavor is coffee.",
      ],
      review_token: conflictDiff.review_token,
      confirmed_by_user: true,
      decisions: [{ key: conflictItem.key, action: "merge", merged_text: mergedText }],
    },
    dir,
  );
  check("conflict merge updates VPS and emits client update", conflictApplied.vps_applied.updated[0]?.text === mergedText && conflictApplied.client_actions.update[0]?.with_vps_text === mergedText);

  // In-sync check after Grok adopts merged text
  const syncedDiff = computeSyncDiff(await loadTier1Archive(dir), "grok", [
    mergedText,
    "Favorite ice cream flavor is coffee.",
  ]);
  check("in_sync when client matches canonical archive", syncedDiff.status === "in_sync" && syncedDiff.review_required === false && syncedDiff.summary.matched === 2);

  // 7. Bootstrap merge & dedupe across Claude, Grok, Gemini exports
  const boot = mergeBootstrapExports({
    claude: [
      "Favorite ice cream flavor is coffee.",
      "Owns a Bambu Lab A1 3D printer.",
      "Lives in Concord, East Bay CA, 28M.",
    ],
    grok: [
      "favorite ice cream flavor is coffee",
      "Lives in Concord, CA (East Bay), 28M, ADHD.",
    ],
    gemini: [
      "Owns a Bambu Lab A1 3D printer",
      "In deep remission for Crohn's on infliximab.",
    ],
  });
  check("bootstrap dedupes exact matches across clients", boot.canonical.some((c) => c.sources.includes("claude") && c.sources.includes("grok")));
  check("bootstrap flags cross-client conflict instead of duplicating", boot.conflicts.length === 1);
  check("bootstrap keeps unique items from all clients", boot.canonical.length === 4);

  // 8. Live MCP tool call over InMemoryTransport
  const prevMemDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = dir;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const mcpClient = new Client({ name: "pms-mcp-test", version: "1.0.0" });
  await Promise.all([server.connect(st), mcpClient.connect(ct)]);
  try {
    const res = await mcpClient.callTool({
      name: "personal_memory_sync",
      arguments: {
        client: "claude",
        native_memories: [mergedText, "Favorite ice cream flavor is coffee."],
        mode: "diff",
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    check("MCP personal_memory_sync diff works end-to-end", !res.isError && parsed.status === "in_sync");

    const blockedApply = await mcpClient.callTool({
      name: "personal_memory_sync",
      arguments: {
        client: "claude",
        native_memories: [mergedText, "Favorite ice cream flavor is coffee.", "Brand new unreviewed item."],
        mode: "apply",
      },
    });
    check("MCP personal_memory_sync blocks unreviewed apply", blockedApply.isError === true);
  } finally {
    await mcpClient.close();
    await server.close();
    if (prevMemDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = prevMemDir;
  }
} finally {
  if (prevGeminiKey !== undefined) process.env.GEMINI_API_KEY = prevGeminiKey;
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
