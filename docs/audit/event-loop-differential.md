# Event-loop differential: what this runtime actually does versus Node

> **Correction, 2026-11-12.** The 3 of 7 below was the state BEFORE the nextTick and settle-order fixes. The live result is **7 of 7**
> (`npm run diff:event-loop`), as ADR-0013 records. This file is kept as written because it documents how the deviations were found;
> the number in it is history, not status. See `docs/audit/remaining-work.md` (W-9).

**Date:** 2026-11-08
**Instrument:** `tools/differential/event-loop.ts` (`npm run diff:event-loop`)
**Verdict:** 3 of 7 cases match real Node. The audit's third correction is confirmed with measurements, not opinion.

## Why this exists

A green suite proves the scheduler produces *an* order. It does not prove Node's order, and the whole compatibility claim
rests on order matching, because tools schedule work. So each case below is one small program, run twice: once by real
Node as the oracle, and once by `InProcessRuntime`. The output is compared verbatim.

## Results

| Case | Question | Node | This runtime | Result |
| --- | --- | --- | --- | --- |
| `nexttick-before-promise` | does `process.nextTick` run before a resolved promise's `.then`? | `nextTick,promise` | `promise,nextTick` | **DEVIATES** |
| `nexttick-nested` | is a `nextTick` queued inside a `nextTick` drained before microtasks? | `tick1,tick-nested,promise1,promise2` | `promise1,tick1,promise2,tick-nested` | **DEVIATES** |
| `immediate-vs-timeout0` | does `setImmediate` run after I/O but before a 0 ms timer inside a timer callback? | `outer-timer,tick,immediate,inner-timer0` | same | match |
| `timer-order-by-delay` | do timers fire in delay order regardless of registration order? | `t10,t20,t30` | same | match |
| `microtask-starvation` | does a promise chain finish before a 0 ms timer registered before it? | `m1,m2,timer` | `m1,timer,m2` | **DEVIATES** |
| `interval-ticks` | how many interval ticks elapse in 30 ms at a 10 ms interval? | `ticks=2` | `ticks=2` | match |
| `async-await-order` | does `await` resume in microtask order relative to `nextTick`? | `sync-start,tick,after-await,then` | `sync-start,after-await,tick,then` | **DEVIATES** |

## What the four deviations mean

They are two defects, not four.

1. **`process.nextTick` is a microtask, not a separate queue.** Three cases (`nexttick-before-promise`,
   `nexttick-nested`, `async-await-order`) fail for the same reason: `nextTick` is implemented as `queueMicrotask`, so it
   interleaves with promise jobs instead of draining ahead of them. Node drains the whole nextTick queue before it touches
   the promise queue, and re-drains it whenever a nextTick schedules another.
2. **Promise chains do not settle before timers.** `microtask-starvation` shows the second `.then` in a chain running
   *after* a 0 ms timer. A microtask that queues another microtask must both run before the scheduler advances the clock;
   here the drain pass finishes too early and the timer gets its turn in between.

Both are exactly what the P0 plan predicted in Phase 1 step 2, and both are fixed by the same prescribed change: a real
nextTick queue drained before promise jobs, and a drain loop that is quiescent rather than single-pass.

## What is deliberately not being done now

The fix is Phase 1 work, and Phase 1 depends on ADR-0018 being accepted (P0-1 in `P0-rulings.md`). Changing scheduler
semantics before that ruling would be taking the architectural decision the charter reserves for the expert, and it would
touch ordering that current fixtures rely on. The measurement is the deliverable here; the fix has a named home.

## Reproducing

```
npm run diff:event-loop            # table, exit 0 (a measurement)
npm run diff:event-loop -- --strict  # exit 1 when any case deviates, for when we expect parity
```

A note on my own first attempt: it reported 0 of 8 matching, because it seeded the VFS with `mkdir` + `writeFile` instead of
`writeFileSync` and every program produced empty output. An empty stdout looked exactly like a catastrophic scheduler
failure. The harness now seeds the way the fixture harness does, and the difference between "0/8" and "3/7" was my bug, not
a runtime finding.
