/**
 * Unit tests for metrics layer. Run AFTER `npm run build`.
 *   node test/metrics.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordSeatMetric,
  recordFanoutRun,
  summarizeFanoutRuns,
  computeMetricsStats,
  queryMetrics,
  hashQuestion,
  familyFromSlug,
  classifyError,
  isAttemptTimeoutError,
  loggedReasoningEffort,
} from "../build/metrics.js";
import { applyLens, normalizeLensName } from "../build/lenses.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAskPanel } from "../build/panel.js";
import { CLI_BUDGET } from "../build/budgetProfile.js";

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

console.log("Unit: metrics");

check("hashQuestion stable", hashQuestion("hello").length === 16);
check("omitted flash logs unspecified", loggedReasoningEffort("~google/gemini-flash-latest", undefined) === "unspecified");
check("null effort logs unspecified", loggedReasoningEffort("google/gemini-4-argon", null) === "unspecified");
check("omitted argon logs medium", loggedReasoningEffort("google/gemini-4-argon", undefined) === "medium");
check("omitted neon logs medium", loggedReasoningEffort("google/gemini-4-neon", undefined) === "medium");
check("null neon effort logs unspecified", loggedReasoningEffort("google/gemini-4-neon", null) === "unspecified");
check("omitted neon token logs medium", loggedReasoningEffort("neon", undefined) === "medium");
check("omitted bare gemini logs medium", loggedReasoningEffort("gemini", undefined) === "medium");
check("omitted argon token logs medium", loggedReasoningEffort("argon", undefined) === "medium");
check("omitted sonnet logs medium", loggedReasoningEffort("~anthropic/claude-sonnet-latest", undefined) === "medium");
check("explicit sonnet high stays high", loggedReasoningEffort("~anthropic/claude-sonnet-latest", "high") === "high");
check("omitted sol logs medium", loggedReasoningEffort("~openai/gpt-sol-latest", undefined) === "medium");
check("omitted grok logs medium", loggedReasoningEffort("grok", undefined) === "medium");
check("lite stays unspecified", loggedReasoningEffort("google/gemini-3.5-flash-lite", undefined) === "unspecified");
check("explicit medium stays medium", loggedReasoningEffort("grok", "medium") === "medium");
check("explicit low stays low", loggedReasoningEffort("~openai/gpt-sol-latest", "low") === "low");
check("familyFromSlug grok", familyFromSlug("grok", "grok-direct") === "grok");
check("familyFromSlug gemini", familyFromSlug("~google/gemini-pro-latest") === "gemini");
check("familyFromSlug argon token", familyFromSlug("argon") === "gemini");
check("familyFromSlug argon slug", familyFromSlug("google/gemini-4-argon") === "gemini");
check("familyFromSlug neon token", familyFromSlug("neon") === "gemini");
check("familyFromSlug neon slug", familyFromSlug("google/gemini-4-neon") === "gemini");
check("familyFromSlug fusion", familyFromSlug("openrouter/fusion") === "fusion");
check("familyFromSlug claude opus", familyFromSlug("anthropic/claude-opus-5") === "claude");
check("familyFromSlug claude sonnet", familyFromSlug("anthropic/claude-sonnet-5") === "claude");
check("classifyError timeout", classifyError("timeout", "seat timed out") === "timeout");
// B3: bare OR "aborted" WITHOUT timeout language is transient, NOT seat-timeout.
check(
  "classifyError OR bare abort → transient_or",
  classifyError("error", "OpenRouter /chat/completions network failure: The operation was aborted") === "transient_or",
);
check(
  "isAttemptTimeoutError bare abort → false",
  isAttemptTimeoutError("OpenRouter /chat/completions network failure: aborted") === false,
);
check(
  "isAttemptTimeoutError OR abort+timeout → true",
  isAttemptTimeoutError("OpenRouter /chat/completions aborted: signal timed out") === true,
);
check(
  "isAttemptTimeoutError timed out → true",
  isAttemptTimeoutError("seat timed out (40000ms)") === true,
);
// Kaizen #1: undici AbortSignal.timeout wording (Claude OR-hang forensics 2026-07-09).
check(
  "isAttemptTimeoutError aborted due to timeout → true",
  isAttemptTimeoutError("The operation was aborted due to timeout") === true,
);
check(
  "classifyError aborted due to timeout → timeout",
  classifyError("error", "The operation was aborted due to timeout") === "timeout",
);
check(
  "classifyError OR wrap aborted due to timeout → timeout",
  classifyError(
    "error",
    "OpenRouter /chat/completions network failure: The operation was aborted due to timeout",
  ) === "timeout",
);
check("classifyError grounding", classifyError("error", "grounding_fired:false") === "grounding_miss");

const stateDir = await mkdtemp(join(tmpdir(), "metrics-test-"));
const prevState = process.env.STATE_DIRECTORY;
process.env.STATE_DIRECTORY = stateDir;
try {
  await recordSeatMetric({
    ts: new Date().toISOString(),
    tool: "oracle",
    route_mode: "single",
    seat_id: "auto",
    family: "auto",
    model_slug: "openrouter/auto-beta",
    transport: "or",
    grounded_requested: false,
    grounding_fired: false,
    x_search_fired: false,
    reasoning_effort: "high",
    latency_ms: 1200,
    failover_fired: false,
    timed_out: false,
    ok: true,
    question_hash: "abc",
  });

  const day = new Date().toISOString().slice(0, 10);
  const raw = await readFile(join(stateDir, `metrics-${day}.jsonl`), "utf8");
  check("recordSeatMetric writes JSONL", raw.includes('"tool":"oracle"'));

  await recordFanoutRun({
    ts: new Date().toISOString(),
    question_hash: "abc",
    elapsed_ms: 30000,
    decompose_ms: 800,
    decompose_source: "classifier",
    legs_ms: 12000,
    synth_ms: 9000,
    synth_ok: true,
    degraded: false,
    leg_count: 3,
    ok_legs: 3,
    max_legs: 4,
  });
  const fanoutRaw = await readFile(join(stateDir, `fanout-${day}.jsonl`), "utf8");
  check("recordFanoutRun writes JSONL", fanoutRaw.includes('"elapsed_ms":30000'));
  const fanoutStats = summarizeFanoutRuns([
    { ts: "t", question_hash: "a", elapsed_ms: 1000, decompose_ms: 100, decompose_source: "classifier", legs_ms: 400, synth_ms: 500, synth_ok: true, degraded: false, leg_count: 1, ok_legs: 1, max_legs: 4 },
    { ts: "t", question_hash: "b", elapsed_ms: 3000, decompose_ms: 300, decompose_source: "fallback_single", legs_ms: 800, degraded: true, leg_count: 1, ok_legs: 0, max_legs: 4 },
  ]);
  check("summarizeFanoutRuns count", fanoutStats.run_count === 2);
  check("summarizeFanoutRuns elapsed p50", fanoutStats.elapsed_ms.p50 === 1000);
  check("summarizeFanoutRuns synth n excludes skips", fanoutStats.synth_ms.n === 1);

  const stats = computeMetricsStats([
    { latency_ms: 100, grounded_requested: true, grounding_fired: false, failover_fired: true, timed_out: false, ok: true, degraded: false, tool: "oracle", seat_id: "a", family: "gemini", model_slug: "g", transport: "or", x_search_fired: false, reasoning_effort: "high", question_hash: "x", ts: new Date().toISOString(), lens: "default" },
    { latency_ms: 200, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: false, degraded: true, tool: "oracle", seat_id: "b", family: "grok", model_slug: "grok", transport: "direct", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString(), lens: "pre-mortem" },
    { latency_ms: 300, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: true, degraded: false, tool: "panel", seat_id: "c", family: "claude", model_slug: "sonnet", transport: "or", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString() },
  ]);
  check("computeMetricsStats overall count", stats.overall.seat_count === 3);
  check("computeMetricsStats p50", stats.overall.latency_ms.p50 === 200);
  // B1: degraded_rate is per-seat (1/3), not run-level all-true.
  check("computeMetricsStats degraded_rate", Math.abs(stats.overall.degraded_rate - 1 / 3) < 1e-9);

  const byLens = computeMetricsStats([
    { latency_ms: 100, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: true, degraded: false, tool: "panel", seat_id: "a", family: "gemini", model_slug: "g", transport: "or", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString(), lens: "default" },
    { latency_ms: 250, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: true, degraded: false, tool: "panel", seat_id: "b", family: "grok", model_slug: "grok", transport: "or", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString(), lens: "pre-mortem" },
    { latency_ms: 400, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: true, degraded: false, tool: "panel", seat_id: "c", family: "claude", model_slug: "sonnet", transport: "or", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString() },
  ], "lens");
  check("computeMetricsStats group_by lens keys", Object.keys(byLens.by_group).join(",") === "default,pre-mortem,unknown");
  check("computeMetricsStats group_by lens p50", byLens.by_group["pre-mortem"].latency_ms.p50 === 250);
  check("normalizeLensName default", normalizeLensName(undefined, undefined) === "default");
  check("normalizeLensName custom system suppresses default", normalizeLensName(undefined, "be terse") === "none");
  check("normalizeLensName off -> none", normalizeLensName("off", undefined) === "none");
  check("normalizeLensName invalid -> invalid", normalizeLensName("definitely-not-a-lens-secret-prompt", undefined) === "invalid");
  check("applyLens returns canonical lens name", applyLens("PRE-MORTEM", "extra").lens === "pre-mortem");

  // End-to-end mocked panel -> lens seat metric -> queryMetrics(group_by:"lens") + Neon wire check.
  {
    const realFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Neon answer." }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = new McpServer({ name: "metrics-lens-test", version: "1.0.0" });
    registerAskPanel(srv, {
      xaiApiKey: undefined,
      geminiApiKey: undefined,
      openrouterApiKey: "test-or-key",
      geminiTransport: "openrouter",
      budget: CLI_BUDGET,
    });
    const cli = new Client({ name: "metrics-lens-client", version: "1.0.0" });
    await Promise.all([srv.connect(st), cli.connect(ct)]);
    try {
      await cli.callTool({
        name: "ask_panel",
        arguments: {
          prompt: "Check lens logging",
          specs: [
            { model: "neon", lens: "pre-mortem", label: "n1" },
            { model: "argon", lens: "none", label: "n2" },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 80));
      const lensStats = await queryMetrics({ window_days: 1, group_by: "lens", tool: "panel" });
      check("panel logs pre-mortem lens", lensStats.by_group["pre-mortem"]?.seat_count === 1);
      check("panel logs none lens for stale argon", lensStats.by_group["none"]?.seat_count === 1);
      check("neon & stale argon both send google/gemini-4-neon", bodies.length === 2 && bodies.every((b) => b.model === "google/gemini-4-neon"));
      check("neon & stale argon both send medium effort without priority", bodies.every((b) => b.reasoning?.effort === "medium" && b.service_tier === undefined));
    } finally {
      await cli.close();
      await srv.close();
      globalThis.fetch = realFetch;
    }
  }

  // Forced write failure must not throw — point STATE_DIRECTORY at a file (mkdir fails).
  const blocker = join(stateDir, "not-a-dir");
  await writeFile(blocker, "x", "utf8");
  const prevDir = process.env.STATE_DIRECTORY;
  process.env.STATE_DIRECTORY = blocker;
  let threw = false;
  try {
    await recordSeatMetric({
      ts: new Date().toISOString(),
      tool: "panel",
      seat_id: "x",
      family: "gemini",
      model_slug: "g",
      transport: "or",
      grounded_requested: false,
      grounding_fired: false,
      x_search_fired: false,
      reasoning_effort: "low",
      latency_ms: 1,
      failover_fired: false,
      timed_out: false,
      ok: true,
      question_hash: "y",
    });
  } catch {
    threw = true;
  }
  process.env.STATE_DIRECTORY = prevDir;
  check("recordSeatMetric swallows write errors", !threw);
} finally {
  process.env.STATE_DIRECTORY = prevState;
  await rm(stateDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);