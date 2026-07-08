/**
 * Shared wall-clock helpers for multi-seat tools (panel, oracle, research_fanout).
 * Prefer this over local withTimeout copies so outer-budget semantics stay consistent.
 */

/** Race a promise against a wall-clock deadline. Rejects with `${label} timed out after ${ms}ms`. */
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
