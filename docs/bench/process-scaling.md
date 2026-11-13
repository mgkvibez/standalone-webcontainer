# Process scaling: the measurement the audit asked for

The audit's one blocking question was whether message-per-syscall holds as processes multiply: one Worker per process means
every `fs.readFileSync` is a shared-memory round trip, with a single kernel Worker serving every
channel. Its warning was specific — "scales to tens of processes, not hundreds" — and it asked for 20 concurrent processes
with the number written down.

This is that number, and the method behind it, so it can be re-run rather than believed.

> **Status, 2026-11-13: quarantined from the gate (W-22).** The two specs in `tests/browser/bench-scaling.spec.ts` skip unless
> `SWC_BENCH=1`. The reason is a **liveness** observation, not a performance one: in a full single-worker lane one process waited
> 60 s for a syscall its own kernel never answered, while the same spec passes alone in about 13 s. **The numbers below are
> historical** (recorded 2026-11-09, the same day the serve-loop shape changed in `226ad16`, with idle accounting changed again in
> `6f6880e` on 2026-11-10). Re-take them before quoting any figure here.

## How to run it, and what a failure means

The quarantine is not a reason to stop measuring. It is a reason to measure deliberately:

```bash
# The whole benchmark. Opt-in, so nothing else runs it by accident.
SWC_BENCH=1 npx playwright test tests/browser/bench-scaling.spec.ts --reporter=line

# One spec at a time, which is what localises a liveness failure.
SWC_BENCH=1 npx playwright test tests/browser/bench-scaling.spec.ts --reporter=line -g "parking versus spinning"
```

**Run it alone, on a clean tree.** Not directly after `npm run verify` or the full browser lane. The known failure mode is a
loaded single-worker lane: the benchmark competes with itself for the machine, a caller's `Atomics.wait` outlives its deadline,
and the run reports `SyscallTimeoutError` rather than a slow number. It passes 2/2 in about 13 s when it has the machine, and it
has failed on a load spike with nothing else changed. That difference is the instrument, not the product.

**What a pass means.** The tables are usable for the machine they were taken on, and the shape (per-op cost flat as processes
are added) is the finding. A pass does **not** clear W-22: the hazard needs load to appear, so a green run is evidence that the
channel worked under that load, not that it always will.

**What a failure means.** Treat `SyscallTimeoutError` (5,000 ms per call, or the 60,000 ms the benchmark sets deliberately) as a
**liveness finding**: a parked caller whose kernel did not answer. Record which spec, which stage and the sequence number, and
add it to W-22 in `docs/audit/remaining-work.md`. Do not record it as a performance regression, and do not raise the deadline
again to make it pass: the deadline is how the defect becomes visible.

Both specs assert nothing about speed on purpose. A red row here says the channel starved; a green row says it did not on this
machine, today.

- **Command:** `SWC_BENCH=1 npx playwright test tests/browser/bench-scaling.spec.ts --reporter=line` (the specs skip
  without `SWC_BENCH=1` since the 2026-11-12 quarantine)
- **Date:** 2026-11-09
- **Environment:** Chromium (Playwright), this development sandbox, headless, everything on one machine, kernel and all
  processes competing for the same cores. Absolute numbers will differ on other hardware; the **shape** is the finding.
- **What is timed:** only the caller's steady-state loop. One untimed warm-up read precedes the clock, so module compilation
  and JIT warm-up are excluded. Three repetitions per stage, best taken — a browser microbenchmark moves 10x on a single
  scheduler hiccup, and the best sample is what the design can do when the machine is not interfering.

## Concurrency: 4 KiB utf8 read, 1000 ops per process

| processes | total ops | wall | per op | slowest process |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,000 | 96 ms | 96 us | 87 ms |
| 4 | 4,000 | 154 ms | 38 us | 139 ms |
| 8 | 8,000 | 233 ms | 29 us | 204 ms |
| 16 | 16,000 | 411 ms | 26 us | 367 ms |
| 20 | 20,000 | 577 ms | 29 us | 520 ms |

**Reading it.** The kernel does not fall behind as processes are added: at 20 processes it sustains ~34,700 syscalls/second,
and the per-op cost is flat from 8 processes upward. Nothing in the design degrades at tens of processes, which is the regime
the runtime is built for (a project's `npm run dev` plus a build plus a test run).

An earlier version of this table showed a persistent 302 us outlier at 4 processes and a 24,000/s ceiling, and carried a
paragraph excusing the outlier. Both are gone after the serve-loop fix described under **Payload cost**: the same fix that
made the sweep stop sleeping on a timer clamp also removed the per-stage stall. The honest reading is that the outlier was
the instrument, and there is no need to explain it because it no longer happens. This paragraph stays so nobody re-derives a
mechanism for a number that was never the channel's.

**Why one process costs more per op than eight.** With one caller the kernel must park between calls, and each call pays a
wake-up (notification to resumption). With eight there is usually already a request waiting, so the kernel never parks and
the wake-up is amortised. Measured directly, parking costs about 7 us over spinning on a 4 KiB ping-pong (80 us parked vs
73 us spinning), which is small in isolation and is most of the gap between the 1-process and 8-process rows.

## Payload cost

### The run that produced the original numbers, and the defect behind them

The first version of this table read: 4,096 B at 176 us, 65,536 B at 1,806 us, 262,144 B at 7,089 us, "~35 MB/s". Those
numbers were produced by a kernel loop that **swept every channel in one loop and slept on a timer clamp when nothing was
pending**. That loop shape changes the answer: on the same machine, the same 64 KiB read measured 1,806 us through the sweep
and 296 us through a per-channel loop. The sweep was measuring its own scheduling.

It was caught the expensive way. When binary payloads moved to raw-byte framing (ADR-0021), this bench reported the framed
codec as **7x slower** than base64 at 64 KiB, which is not physically plausible for a change that moves fewer bytes and does
less work. A purpose-built probe that timed the caller, the kernel's answer, and the kernel's idle time separately showed the
channel doing 64 KiB in 220-395 us while this bench reported 10,000 us. The loop was the difference.

The loop is now one independent serve loop per channel, which is what the kernel actually does. Every number below was
re-measured after that fix, and the pre-fix figures are left in this section only as a warning about instruments.

### Framed wire (current, 2026-11-09)

| bytes | ops | wall | per op | throughput |
| ---: | ---: | ---: | ---: | ---: |
| 4,096 | 200 | 29 ms | 147 us | 27 MB/s |
| 65,536 | 200 | 52 ms | 260 us | 240 MB/s |
| 262,144 | 200 | 111 ms | 555 us | 450 MB/s |

### Same probe, both codecs, one commit apart

A separate A/B probe (100 reads, one process, production-shaped loop, batch-timed) run against `main` and against the framed
wire, with nothing else changed:

| payload | base64-in-JSON | raw-byte framing | gain |
| --- | ---: | ---: | ---: |
| 4 KiB | 289 us (13.5 MB/s) | 152 us (25.7 MB/s) | 1.9x |
| 64 KiB | 1,496 us (41.8 MB/s) | 296 us (211 MB/s) | 5.1x |
| 256 KiB | 6,345 us (39.4 MB/s) | 628 us (398 MB/s) | 10.1x |

The gain grows with payload because the removed work does: base64 inflated every binary by 33% and its decode cost 497 us at
256 KiB against 1 us for a framed view. Small *non-binary* calls are unaffected — those messages are not framed at all, and
the metadata bench shows the boot mix at 169.2 bytes/call either way.

**Reading these numbers honestly:** the two tables disagree by ~10% on the same wire (296 us vs 260 us at 64 KiB, 628 us vs
555 us at 256 KiB). Both are best-of-three on a shared, headless machine; neither is a laboratory measurement. The A/B table
is the one to trust for "did framing help", because both columns come from one probe in one session.

## Spawn cost

20 bare Workers (module type, answer once, nothing else) in **59 ms** total, ~3.0 ms each. Runtime boot is separate and much
larger — that is the module compilation path, not the process machinery.

## What this decides

1. **The architecture holds at the scale it targets.** Tens of processes is fine; the linear-scaling fear is unfounded at
   this size. Hundreds of processes was never the goal and is not evidenced either way by this run.
2. **Small sequential reads are the real cost driver, not bulk data.** 120 us per 4 KiB read in a single process means a
   workload doing 10,000 small reads pays ~1.2 s in channel latency alone. That is the profile of a toolchain boot, so it
   is worth attacking before bulk throughput — and it points at batching (`stat`/`readdir` in one round trip) rather than at
   the payload encoding.
3. **Nothing here argues for replacing the channel.** A single kernel sustaining 24k ops/s with a flat curve to 20
   processes is not the bottleneck a redesign would target first.

**Follow-up (ADR-0022).** Batching landed, and it is measured on a real channel rather than argued:
`tests/browser/batch-roundtrips.spec.ts` sends sixteen trivial stats both ways. Sequentially that is 16 request frames and
0.84 ms; batched it is 1 frame and 0.19 ms, 4.4x, with the frame count asserted as a count so a fast machine cannot make a
pessimisation look good. The resolver now resolves a specifier in one probe instead of up to four (two instead of five for a
directory), which at ~50 us per avoided wake-up is ~100-150 us of boot per specifier that needs an extension.

What batching does NOT do, so this doc does not overstate it: it does not make a *dependent* chain of calls cheaper
(`read` after `stat` is still two round trips), it does not split an oversized batch, and the end-to-end boot time was not
re-measured against a like-for-like baseline. Memory per channel, listed as unmeasured above, is still unmeasured.

Not measured here, and worth doing before any claim about hundreds of processes: memory per channel (each channel allocates
its request and response regions, so 20 processes at 1 MiB response regions is 20 MiB of `SharedArrayBuffer` before any user
data), and the effect of a real project's mixed workload rather than one hot loop.
