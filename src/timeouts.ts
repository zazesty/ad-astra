/**
 * Shared wall-clock helpers for multi-seat tools (panel, oracle, research_fanout).
 * Prefer this over local withTimeout copies so outer-budget semantics stay consistent.
 */

/**
 * Race a promise against a wall-clock deadline.
 * Rejects with `${label} timed out after ${ms}ms`.
 * Note: do not unref the timer by default — unref + only-unreferenced work lets
 * short-lived scripts (tests, one-shots) exit before the timeout fires.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) {
    return Promise.reject(new Error(`${label} timed out after ${ms}ms`));
  }
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t!)), timeout]);
}

/** Milliseconds left on an outer budget, floored at 0. */
export function remainingMs(startedAt: number, budgetMs: number, now: number = Date.now()): number {
  return Math.max(0, budgetMs - (now - startedAt));
}

/** Cap a per-seat/leg budget by remaining outer budget (and optional hard seat cap). */
export function seatBudgetMs(
  startedAt: number,
  outerBudgetMs: number,
  seatCapMs: number,
  now: number = Date.now(),
): number {
  return Math.min(seatCapMs, remainingMs(startedAt, outerBudgetMs, now));
}

/**
 * Don't start another provider call (grounding retry / OR→direct failover)
 * unless this much seat budget remains. Direct grounded-gemini p50 is ~13s.
 */
export const MIN_NEXT_ATTEMPT_MS = 12_000;

export function canStartAttempt(
  startedAt: number,
  budgetMs: number,
  minMs: number = MIN_NEXT_ATTEMPT_MS,
  now: number = Date.now(),
): boolean {
  return remainingMs(startedAt, budgetMs, now) >= minMs;
}

/** Per-attempt abort capped by remaining seat budget (leave 500ms to serialize). */
export function capAttemptMs(
  startedAt: number,
  budgetMs: number,
  attemptCapMs: number,
  now: number = Date.now(),
): number {
  return Math.min(attemptCapMs, Math.max(1_000, remainingMs(startedAt, budgetMs, now) - 500));
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. Rejects on first uncaught throw. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** allSettled semantics with a concurrency cap, preserving input order. */
export async function mapLimitSettled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
