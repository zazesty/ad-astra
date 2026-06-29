import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export type MetricsTool = "oracle" | "panel";

export interface SeatMetricRecord {
  ts: string;
  tool: MetricsTool;
  route_mode?: string;
  seat_id: string;
  family: string;
  model_slug: string;
  transport: "or" | "direct";
  grounded_requested: boolean;
  grounding_fired: boolean;
  x_search_fired: boolean;
  reasoning_effort: string;
  latency_ms: number;
  failover_fired: boolean;
  timed_out: boolean;
  ok: boolean;
  degraded?: boolean;
  error_class?: string;
  question_hash: string;
  prompt_preview?: string;
}

function stateDir(): string {
  return process.env.STATE_DIRECTORY?.replace(/\/+$/, "") || "/tmp/grok-mcp-state";
}

function metricsPathForDate(d: Date): string {
  const day = d.toISOString().slice(0, 10);
  return join(stateDir(), `metrics-${day}.jsonl`);
}

export function hashQuestion(prompt: string): string {
  return createHash("sha256").update(prompt.trim()).digest("hex").slice(0, 16);
}

export function familyFromSlug(modelSlug: string, provider?: string): string {
  const s = modelSlug.toLowerCase();
  if (s.includes("fusion")) return "fusion";
  if (s === "grok" || provider === "grok-direct" || s.includes("grok")) return "grok";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("gpt") || s.includes("openai")) return "openai";
  if (s.includes("auto")) return "auto";
  return "other";
}

export function classifyError(status: string, error?: string): string | undefined {
  if (status === "timeout") return "timeout";
  const msg = (error || "").toLowerCase();
  if (!msg) return status === "ok" ? undefined : "other";
  if (msg.includes("grounding_fired:false")) return "grounding_miss";
  if (msg.includes("openrouter") && (msg.includes("429") || msg.includes("5") || msg.includes("transient") || msg.includes("abort") || msg.includes("timeout"))) {
    return "transient_or";
  }
  if (/\b4\d{2}\b/.test(msg) || msg.includes("400") || msg.includes("401") || msg.includes("403") || msg.includes("404")) {
    return "client_4xx";
  }
  return "other";
}

/** Append one seat metric line. Never throws — failures are logged only. */
export async function recordSeatMetric(rec: SeatMetricRecord): Promise<void> {
  try {
    const dir = stateDir();
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ...rec,
      ...(process.env.METRICS_LOG_PROMPTS === "1" && rec.prompt_preview
        ? { prompt_preview: rec.prompt_preview.slice(0, 200) }
        : {}),
    });
    await appendFile(metricsPathForDate(new Date(rec.ts)), line + "\n", "utf8");
  } catch (e) {
    console.error(`[metrics] write failed: ${(e as Error).message}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function loadMetricsInWindow(opts: {
  window_days?: number;
  since?: string;
  tool?: MetricsTool;
}): Promise<SeatMetricRecord[]> {
  const dir = stateDir();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("metrics-") && f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const sinceMs = opts.since
    ? new Date(opts.since).getTime()
    : Date.now() - (opts.window_days ?? 7) * 86_400_000;

  const rows: SeatMetricRecord[] = [];
  for (const f of files.sort()) {
    const day = f.slice("metrics-".length, -".jsonl".length);
    const dayMs = new Date(`${day}T00:00:00Z`).getTime();
    if (dayMs + 86_400_000 < sinceMs) continue;
    try {
      const raw = await readFile(join(dir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as SeatMetricRecord;
          if (new Date(rec.ts).getTime() < sinceMs) continue;
          if (opts.tool && rec.tool !== opts.tool) continue;
          rows.push(rec);
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  return rows;
}

type GroupKey = "family" | "transport" | "route_mode" | "model_slug";

function groupValue(rec: SeatMetricRecord, by: GroupKey): string {
  switch (by) {
    case "family": return rec.family;
    case "transport": return rec.transport;
    case "route_mode": return rec.route_mode || "unknown";
    case "model_slug": return rec.model_slug;
  }
}

export function computeMetricsStats(
  rows: SeatMetricRecord[],
  groupBy: GroupKey = "family",
): Record<string, unknown> {
  const groups = new Map<string, SeatMetricRecord[]>();
  for (const r of rows) {
    const k = groupValue(r, groupBy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  function summarize(bucket: SeatMetricRecord[]) {
    const latencies = bucket.map((r) => r.latency_ms).filter((n) => n >= 0).sort((a, b) => a - b);
    const n = bucket.length;
    const groundedReq = bucket.filter((r) => r.grounded_requested);
    const groundingMiss = groundedReq.filter((r) => !r.grounding_fired).length;
    const failovers = bucket.filter((r) => r.failover_fired).length;
    const timeouts = bucket.filter((r) => r.timed_out).length;
    const errors: Record<string, number> = {};
    for (const r of bucket) {
      if (r.error_class) errors[r.error_class] = (errors[r.error_class] || 0) + 1;
    }
    return {
      seat_count: n,
      latency_ms: {
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p99: percentile(latencies, 99),
      },
      grounding_miss_rate: groundedReq.length ? groundingMiss / groundedReq.length : 0,
      failover_rate: n ? failovers / n : 0,
      timeout_rate: n ? timeouts / n : 0,
      error_class: errors,
    };
  }

  const by_group: Record<string, ReturnType<typeof summarize>> = {};
  for (const [k, v] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    by_group[k] = summarize(v);
  }

  return {
    window: {
      seat_count: rows.length,
      since: rows.length ? rows.map((r) => r.ts).sort()[0] : null,
      until: rows.length ? rows.map((r) => r.ts).sort().at(-1) : null,
    },
    group_by: groupBy,
    overall: summarize(rows),
    by_group,
  };
}

export async function queryMetrics(opts: {
  window_days?: number;
  since?: string;
  group_by?: GroupKey;
  tool?: MetricsTool;
}): Promise<Record<string, unknown>> {
  const rows = await loadMetricsInWindow(opts);
  return computeMetricsStats(rows, opts.group_by ?? "family");
}

export function registerGetMetrics(server: any) {
  server.registerTool(
    "get_metrics",
    {
      title: "Get Metrics",
      description:
        "On-demand seat execution metrics from the grok-mcp observability layer. Returns computed " +
        "p50/p90/p99 latency, grounding-miss rate, failover rate, timeout rate, and error-class " +
        "breakdown grouped by family/transport/route_mode/model_slug. Pull-only — no email digest. " +
        "Covers ask_oracle and ask_panel seat executions logged to $STATE_DIRECTORY.",
      inputSchema: {
        window_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Look-back window in days (default 7). Ignored if since is set."),
        since: z
          .string()
          .optional()
          .describe("ISO date/time lower bound (overrides window_days)."),
        group_by: z
          .enum(["family", "transport", "route_mode", "model_slug"])
          .optional()
          .describe("Grouping dimension (default family)."),
        tool: z
          .enum(["oracle", "panel"])
          .optional()
          .describe("Filter to ask_oracle or ask_panel seats only."),
      },
    },
    async (args: {
      window_days?: number;
      since?: string;
      group_by?: GroupKey;
      tool?: MetricsTool;
    }) => {
      try {
        const stats = await queryMetrics(args);
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `get_metrics failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}