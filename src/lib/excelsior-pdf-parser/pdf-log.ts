/**
 * Debug switches and stage timers for excelsior-pdf-parser.
 *
 * Every switch is a compile-time constant on purpose: with `false`, bundlers
 * (esbuild, rollup + terser) drop `DEBUG_LOG && console.error(...)` together
 * with the argument expressions, so none of the diagnostic objects
 * (JSON clones, maps, stringified dumps) are even built in production.
 */

/** Wrap-target for every console.* diagnostic. Set to true while debugging one PDF. */
export const DEBUG_LOG: boolean = false;

/** Collect per-stage timings (see startStage / flushStageReport). */
export const PERF_LOG: boolean = false;

/**
 * Temporary safety net for index-based lookups: when true, every indexed query
 * is compared with the old full scan and `[INDEX MISMATCH]` is printed if the
 * results differ. Run your whole PDF set once with it, then switch it off.
 */
export const VERIFY_INDEXES: boolean = true;

const stageTotals = new Map<string, { ms: number; calls: number }>();
const noop = (): void => undefined;

/**
 * Starts a timer and returns the function that stops it. Works across `await`.
 *
 *   const endStage = startStage('op loop');
 *   ...
 *   endStage();
 */
export function startStage(name: string): () => void {
  if (!PERF_LOG) {
    return noop;
  }
  const startedAt = performance.now();
  return () => {
    const entry = stageTotals.get(name) ?? { ms: 0, calls: 0 };
    entry.ms += performance.now() - startedAt;
    entry.calls += 1;
    stageTotals.set(name, entry);
  };
}

/** Prints the collected timings (slowest first) and resets the counters. */
export function flushStageReport(label: string): void {
  if (!PERF_LOG || !stageTotals.size) {
    return;
  }
  const rows = [...stageTotals.entries()]
    .map(([stage, { ms, calls }]) => ({ stage, calls, ms: Math.round(ms), 'ms/call': +(ms / calls).toFixed(2) }))
    .sort((first, second) => second.ms - first.ms);
  console.error(`[PERF] ${label}`);
  console.table(rows);
  stageTotals.clear();
}

/**
 * Compares an index-based result with the old full scan. Does nothing (and the
 * brute-force closure is never called) unless VERIFY_INDEXES is true.
 */
export function verifySameResult(
  label: string,
  indexed: ReadonlyArray<unknown>,
  bruteForce: () => ReadonlyArray<unknown>
): void {
  if (!VERIFY_INDEXES) {
    return;
  }
  const expected = bruteForce();
  const same = expected.length === indexed.length && expected.every((value, position) => value === indexed[position]);
  if (!same) {
    console.error('[INDEX MISMATCH]', label, { expected: expected.length, indexed: indexed.length });
  }
}
