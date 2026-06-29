/**
 * Unit tests for metrics layer. Run AFTER `npm run build`.
 *   node test/metrics.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordSeatMetric,
  computeMetricsStats,
  hashQuestion,
  familyFromSlug,
  classifyError,
} from "../build/metrics.js";

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
check("familyFromSlug grok", familyFromSlug("grok", "grok-direct") === "grok");
check("familyFromSlug gemini", familyFromSlug("~google/gemini-pro-latest") === "gemini");
check("classifyError timeout", classifyError("timeout", "seat timed out") === "timeout");
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
    model_slug: "openrouter/auto",
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

  const stats = computeMetricsStats([
    { latency_ms: 100, grounded_requested: true, grounding_fired: false, failover_fired: true, timed_out: false, ok: true, tool: "oracle", seat_id: "a", family: "gemini", model_slug: "g", transport: "or", x_search_fired: false, reasoning_effort: "high", question_hash: "x", ts: new Date().toISOString() },
    { latency_ms: 200, grounded_requested: false, grounding_fired: false, failover_fired: false, timed_out: false, ok: true, tool: "oracle", seat_id: "b", family: "grok", model_slug: "grok", transport: "direct", x_search_fired: false, reasoning_effort: "medium", question_hash: "x", ts: new Date().toISOString() },
  ]);
  check("computeMetricsStats overall count", stats.overall.seat_count === 2);
  check("computeMetricsStats p50", stats.overall.latency_ms.p50 === 100);

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