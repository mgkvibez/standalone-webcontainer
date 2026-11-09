/**
 * Batching: several calls, one round trip.
 *
 * The measurement in `docs/bench/process-scaling.md` says a small call costs a round trip, and a 4 KiB read costs ~29 us at
 * twenty processes. A boot makes 96 calls whose answers do not depend on each other, so the ceiling is not the transport, it
 * is the number of times the caller has to stop. A batch is the caller saying "these questions are independent".
 *
 * These tests stage the exact bytes a client would send, run the exact kernel server and filesystem handler, and read the
 * exact response, the same way `channel-binary.test.ts` does: the blocking client cannot be driven from a single thread, so
 * the wire is exercised directly and the blocking half is proven in `tests/browser/batch-measurement.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  BATCH_KEY,
  CHANNEL_HEADER_BYTES,
  CHANNEL_STATE,
  SyscallClient,
  SyscallUsageError,
  allocateChannel,
  serveChannel,
} from "../../src/process/syscall-channel.js";
import { framedEncoding } from "../../src/process/frame.js";
import { createFsSyscallHandler } from "../../src/process/fs-syscalls.js";
import { FileSystem } from "../../src/vfs/index.js";

const SIZES = { requestBytes: 64 * 1024, responseBytes: 64 * 1024 };
const TIMEOUT = { timeoutMs: 5 };

interface Outcome {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message: string; readonly code?: string };
}

const stage = (buffer: SharedArrayBuffer, frame: Uint8Array, sequence = 1): void => {
  const header = new Int32Array(buffer, 0, 16);
  new Uint8Array(buffer, CHANNEL_HEADER_BYTES, SIZES.requestBytes).set(frame);
  Atomics.store(header, 1, frame.byteLength);
  Atomics.store(header, 3, sequence);
  Atomics.store(header, 0, CHANNEL_STATE.requestPending);
};

const readResponse = (buffer: SharedArrayBuffer): { readonly ok?: boolean; readonly value?: unknown } => {
  const header = new Int32Array(buffer, 0, 16);
  const length = Atomics.load(header, 2);
  const region = new Uint8Array(buffer, CHANNEL_HEADER_BYTES + SIZES.requestBytes, SIZES.responseBytes);
  return framedEncoding.decode(region.slice(0, length)) as { ok?: boolean; value?: unknown };
};

/** A kernel and a filesystem, wired the way the real kernel wires them. */
const harness = (): { buffer: SharedArrayBuffer; serve: () => { readonly ok?: boolean; readonly value?: unknown }; fs: FileSystem } => {
  const fs = new FileSystem();
  fs.mkdirSync("/app");
  fs.writeFileSync("/app/a.txt", "alpha");
  fs.writeFileSync("/app/b.txt", "beta");
  const handler = createFsSyscallHandler(fs, { owner: "pid-batch-test" });
  const { buffer } = allocateChannel(SIZES);
  const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
  // The request comes from the channel, not from the caller: serveOne reads it and hands it to the handler, which is the
  // path the kernel takes. Passing it in by hand here would have tested a handler call the kernel never makes.
  const run = (): { readonly ok?: boolean; readonly value?: unknown } => {
    server.serveOne((request) => handler(request), TIMEOUT);
    return readResponse(buffer);
  };
  return { buffer, serve: run, fs };
};

describe("a batch is answered in one wake-up", () => {
  it("answers every entry, in order, and isolates the one that fails", () => {
    const { buffer, serve } = harness();
    const requests = [
      { op: "stat", path: "/app/a.txt" },
      { op: "stat", path: "/app/missing.txt" },
      { op: "read", path: "/app/b.txt", encoding: "utf8" },
    ];

    stage(buffer, framedEncoding.encode({ [BATCH_KEY]: requests }));
    const response = serve();

    expect(response.ok).toBe(true);
    const outcomes = (response.value as Record<string, unknown>)[BATCH_KEY] as Outcome[];
    expect(outcomes).toHaveLength(3);

    // Order is the caller's, not the kernel's: entry n of the answer belongs to entry n of the request.
    // The kernel's answers are tagged envelopes, not bare values: { kind: "stats" } and { kind: "text" } are the shapes the
    // filesystem handler has always returned, and batching does not change them.
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.value).toMatchObject({ kind: "stats", vfsKind: "file", size: 5 });

    // A missing file is one failed entry, not a failed batch. Losing the other two answers would defeat the point.
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[1]?.error?.code).toBe("ENOENT");

    expect(outcomes[2]?.ok).toBe(true);
    expect(outcomes[2]?.value).toEqual({ kind: "text", text: "beta" });
  });

  it("carries binary bodies inside a batch, in both directions", () => {
    const { buffer, serve, fs } = harness();
    const body = new Uint8Array(1024);
    for (let index = 0; index < body.length; index += 1) body[index] = (index * 17) % 256;

    stage(
      buffer,
      framedEncoding.encode({
        [BATCH_KEY]: [
          { op: "write", path: "/app/blob.bin", data: body, dataEncoding: "binary" },
          { op: "read", path: "/app/a.txt", encoding: "utf8" },
        ],
      }),
    );

    const outcomes = (serve().value as Record<string, unknown>)[BATCH_KEY] as Outcome[];
    expect(outcomes[0]?.ok).toBe(true);
    expect(fs.readFileSync("/app/blob.bin")).toEqual(body);
    expect(outcomes[1]?.value).toEqual({ kind: "text", text: "alpha" });
  });

  it("costs the same single response frame as one call, not one per entry", () => {
    // The point of the change, stated as an invariant rather than as a stopwatch reading: N answers leave the kernel in ONE
    // response region write. If this ever became a frame per entry, the round trips would be back.
    const { buffer, serve } = harness();
    const requests = Array.from({ length: 12 }, (_unused, index) => ({ op: "stat", path: `/app/${index}.txt` }));
    stage(buffer, framedEncoding.encode({ [BATCH_KEY]: requests }));

    const response = serve();
    const outcomes = (response.value as Record<string, unknown>)[BATCH_KEY] as Outcome[];

    expect(outcomes).toHaveLength(12);
    expect(outcomes.every((outcome) => outcome.ok === false)).toBe(true);
    expect(outcomes.every((outcome) => outcome.error?.code === "ENOENT")).toBe(true);
  });

  it("leaves a single call answered exactly as before", () => {
    const { buffer, serve } = harness();
    stage(buffer, framedEncoding.encode({ op: "read", path: "/app/a.txt", encoding: "utf8" }));
    // Not wrapped, not unwrapped: the single-call answer shape is untouched by batching existing.
    expect(serve()).toEqual({ ok: true, value: { kind: "text", text: "alpha" } });
  });
});

describe("the client refuses what it cannot mean", () => {
  const client = (): SyscallClient => new SyscallClient(allocateChannel(SIZES));
  const callOptions = { timeoutMs: 50 };

  it("refuses a request that uses the reserved marker", () => {
    // Refused before the call is transmitted, so this needs no kernel: the key would silently turn one call into several.
    expect(() => client().call({ [BATCH_KEY]: [{ op: "stat", path: "/x" }] }, callOptions)).toThrow(SyscallUsageError);
    expect(() => client().call({ [BATCH_KEY]: [] }, callOptions)).toThrow(/reserved key/);
  });

  it("refuses a batch inside a batch", () => {
    expect(() => client().callMany([{ [BATCH_KEY]: [] }], callOptions)).toThrow(SyscallUsageError);
  });

  it("does not transmit an empty batch", () => {
    // A transmitted empty batch would block for the deadline and then throw. Returning [] immediately is the only behaviour
    // that cannot hang, and it is proven by this test finishing rather than by asserting on a timer.
    expect(client().callMany([], callOptions)).toEqual([]);
  });
});
