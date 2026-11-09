# Syscall metadata: how much of the wire is the message rather than the data

The transport decision was left open with two candidate levers: replace base64-in-JSON with a byte framing, or batch syscalls.
Picking between them needed a number nobody had: for a realistic mix of **small** calls, how much of each message is payload
and how much is the envelope around it? The scaling benchmark measured time and large-payload throughput; it could not say
this, because its payload rows were deliberately fat.

- **Command:** `npm run bench:syscall-metadata`
- **Date:** 2026-11-09
- **Method:** every call goes through the real `createRemoteFileSystem`, the real `createFsSyscallHandler`, and the real
  `jsonEncoding`, so the request objects and both encodings are production shapes rather than a bench's imitation. Not measured:
  the shared-memory hand-off itself, which the scaling benchmark already covers in time.
- **Workload:** a toolchain boot in miniature. One manifest read, seven stats across a project tree, a source read, three
  directory walks, forty package stats and reads, then a write, a rename and an unlink.

## What each call carries

| op | calls | request B/call | response B/call | payload B/call | metadata share |
| --- | ---: | ---: | ---: | ---: | ---: |
| read | 42 | 77.0 | 123.7 | 75.3 | 62.5% |
| stat | 47 | 49.5 | 93.7 | 0.0 | 100.0% |
| readdir | 3 | 39.7 | 183.3 | 91.3 | 59.0% |
| write | 1 | 94.0 | 36.0 | 0.0 | 100.0% |
| rename | 1 | 76.0 | 36.0 | 0.0 | 100.0% |
| mkdir | 1 | 54.0 | 36.0 | 0.0 | 100.0% |
| unlink | 1 | 47.0 | 36.0 | 0.0 | 100.0% |
| **all** | **96** | **62.0** | **107.2** | **35.8** | **78.8%** |

16,245 bytes over 96 calls, of which 3,438 were payload and **12,807 were envelope**.

**`stat` is the shape of the problem.** 143 bytes round trip to answer "does this file exist", carrying 36 bytes of actual
information. A toolchain boot is mostly stats: resolve a module, check the extension, look for a package manifest, probe a
`node_modules` path. The most common call in the system is also the one with the least to say.

## The finding that changes the decision

Metadata is 78.8% of the bytes, which sounds like framing is the obvious lever. It is not, because **bytes are not what a
small call costs**.

| scenario | transfer, extrapolated | round trips at ~40 us |
| --- | --- | --- |
| 10,000 calls | 1.61 MB total, 1.30 MB of it metadata | 400 ms |
| same, at 22 MB/s | 73 ms of transfer | — |

The round trips are five times the transfer cost, and trimming keys does not remove a round trip. At 40 us per call this
architecture is dominated by the *number* of calls, not their width.

The two payload rows are where bytes genuinely are the cost. A 262,144-byte read becomes 349,525 base64 characters plus
escaping, and the measured large-payload ceiling is ~35 MB/s, against ~47 MB/s raw. That is a **33% tax on every binary
byte**, and it grows with the payload while the envelope stays at ~100 bytes.

## What this decides

1. **A full envelope rewrite is not justified.** It would attack 78.8% of the bytes to recover a fraction of 15% of the time.
   The spike would cost days and buy milliseconds.
2. **The base64 tax is worth attacking, narrowly.** Byte-framing the *body* only — raw bytes for `bytes` bodies, a length
   prefix instead of a base64 string — recovers ~33% on binary transfers without touching request or response shapes. That is
   a contained change with a measured payoff at the sizes a build actually moves.
3. **Batching stays the lever for small-call latency**, which is what the 400 ms figure is made of. The decision to defer it
   stands, but it is the one with the larger ceiling and should be sequenced before any envelope work.

The honest summary: metadata share measures bandwidth, and bandwidth is not the bottleneck for the calls that dominate the
count. Anyone reading the 78.8% as "framing wins" would optimize the wrong quantity.

## Craft notes

The first version of this bench reported **0 payload bytes for every op**, because it expected a string and the handler
returns typed bodies (`{kind:"text"}`, `{kind:"bytes"}`, `{kind:"names"}`). A wrong number that looks like a finding.

Calibrating it caught a second, real defect: `length * 3 / 4` overstates padded base64, so a 4-byte artifact was counted as
6 bytes, a 50% overstatement on exactly the small binaries a build touches most. Both are pinned in
`tests/unit/syscall-metadata.test.ts`, which also asserts the two regimes above — a 4 KiB read under 5% overhead, a 20-byte
read over 40% — so the instrument cannot quietly drift back. Re-running the command writes the raw run to `artifacts/syscall-metadata.json`, which is git-ignored like the other generated artifacts: the table above is the record, and the numbers are reproducible from the command.
