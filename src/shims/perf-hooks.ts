/**
 * `perf_hooks`, which in this runtime is one virtual clock and nothing else.
 *
 * The surface is measured rather than copied. Across vite's eight real packages there are nineteen references to `node:perf_hooks`,
 * and every one of them is `performance.now()`: three modules `import { performance }`, one aliases it, and the rest reach it through
 * `require('node:perf_hooks').performance`. No marks, no measures, no observers.
 *
 * The important part is that this `performance` is the SAME object the program sees as a global, and that it is the scheduler's
 * virtual clock (ADR-0013). Handing back the platform's real `performance` would make a package's own timing disagree with the clock
 * every timer in the run is scheduled on, which is exactly the split-brain the event-loop differential would eventually find.
 */

export interface VirtualPerformance {
  readonly now: () => number;
  readonly timeOrigin: number;
}

export interface PerfHooksShim {
  readonly performance: VirtualPerformance;
}

export function createPerfHooksShim(performance: VirtualPerformance): PerfHooksShim {
  return { performance };
}
