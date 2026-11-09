# Process scaling: the measurement the audit asked for

The audit's one blocking question was whether message-per-syscall holds as processes multiply: one Worker per process means
every `fs.readFileSync` is a shared-memory round trip, with base64-in-JSON payloads and a single kernel Worker serving every
channel. Its warning was specific — "scales to tens of processes, not hundreds" — and it asked for 20 concurrent processes
with the number written down.

This is that number, and the method behind it, so it can be re-run rather than believed.

- **Command:** `npx playwright test tests/browser/bench-scaling.spec.ts`
- **Date:** 2026-11-09
- **Environment:** Chromium (Playwright), this development sandbox, headless, everything on one machine, kernel and all
  processes competing for the same cores. Absolute numbers will differ on other hardware; the **shape** is the finding.
- **What is timed:** only the caller's steady-state loop. One untimed warm-up read precedes the clock, so module compilation
  and JIT warm-up are excluded. Three repetitions per stage, best taken — a browser microbenchmark moves 10x on a single
  scheduler hiccup, and the best sample is what the design can do when the machine is not interfering.

## Concurrency: 4 KiB utf8 read, 1000 ops per process

| processes | total ops | wall | per op | slowest process |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,000 | 120 ms | 120 us | 106 ms |
| 4 | 4,000 | 1,206 ms | 302 us | 1,182 ms |
| 8 | 8,000 | 303 ms | 38 us | 261 ms |
| 16 | 16,000 | 642 ms | 40 us | 537 ms |
| 20 | 20,000 | 822 ms | 41 us | 700 ms |

**Reading it.** The kernel does not fall behind as processes are added: at 20 processes it sustains ~24,000 syscalls/second,
the same per-op cost as at 8. Nothing in the design degrades at tens of processes, which is the regime the runtime is built
for (a project's `npm run dev` plus a build plus a test run).

The 4-process row is an outlier that I could not reproduce as a stable effect and am not going to explain away. It appeared
in three runs, always at 4, while 8/16/20 stayed flat. A plausible mechanism (kernel wake-up thrash at exactly that number
of callers) is a guess, not a measurement, and the numbers above are what happened.

**Why one process costs more per op than eight.** With one caller the kernel must park between calls, and each call pays a
wake-up (notification to resumption). With eight there is usually already a request waiting, so the kernel never parks and
the wake-up is amortised. Measured directly, parking costs about 7 us over spinning on a 4 KiB ping-pong (80 us parked vs
73 us spinning), which is small in isolation and is not the whole story at low concurrency.

## Payload cost: what base64-in-JSON actually costs

| bytes | ops | wall | per op | throughput |
| ---: | ---: | ---: | ---: | ---: |
| 4,096 | 200 | 35 ms | 176 us | 22 MB/s |
| 65,536 | 200 | 361 ms | 1,806 us | 35 MB/s |
| 262,144 | 200 | 1,418 ms | 7,089 us | 35 MB/s |

Large payloads settle at ~35 MB/s through the channel. Base64 is +33% on the wire and JSON escaping adds more, so the
raw-memory equivalent would be ~47 MB/s; for a build artifact or a `node_modules` tarball this is the number that matters,
and it is the cost of the trust boundary being a marshalled boundary rather than shared memory.

## Spawn cost

20 bare Workers (module type, answer once, nothing else) in **57 ms** total, ~2.9 ms each. Runtime boot is separate and much
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

Not measured here, and worth doing before any claim about hundreds of processes: memory per channel (each channel allocates
its request and response regions, so 20 processes at 1 MiB response regions is 20 MiB of `SharedArrayBuffer` before any user
data), and the effect of a real project's mixed workload rather than one hot loop.
