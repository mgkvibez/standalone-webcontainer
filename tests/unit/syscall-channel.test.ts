import { describe, expect, it } from "vitest";
import {
  CHANNEL_ERROR,
  CHANNEL_HEADER_BYTES,
  CHANNEL_STATE,
  SyscallCapacityError,
  SyscallChannelClosedError,
  SyscallClient,
  allocateChannel,
  serveChannel,
} from "../../src/process/syscall-channel.js";

/**
 * The syscall channel's non-blocking half.
 *
 * `Atomics.wait` is illegal on a page's main thread and on Node's, so anything that actually blocks is proven in the
 * browser lane (`tests/browser/syscall-channel.spec.ts`), where real Workers exist. What is testable here is everything
 * else: the byte layout, the guards that must fire *before* any wait, and the kernel's request handling driven from an
 * already-staged request.
 */

const SIZES = { requestBytes: 256, responseBytes: 256 };

const stageRequest = (buffer: SharedArrayBuffer, value: unknown, sequence = 1): void => {
  const header = new Int32Array(buffer, 0, 16);
  const region = new Uint8Array(buffer, CHANNEL_HEADER_BYTES, SIZES.requestBytes);
  const payload = new TextEncoder().encode(JSON.stringify(value));
  region.set(payload);
  Atomics.store(header, 1, payload.byteLength);
  Atomics.store(header, 3, sequence);
  Atomics.store(header, 0, CHANNEL_STATE.requestPending);
};

const readResponse = (buffer: SharedArrayBuffer): { state: number; decoded: unknown; length: number } => {
  const header = new Int32Array(buffer, 0, 16);
  const region = new Uint8Array(buffer, CHANNEL_HEADER_BYTES + SIZES.requestBytes, SIZES.responseBytes);
  const length = Atomics.load(header, 2);
  return {
    state: Atomics.load(header, 0),
    length,
    decoded: JSON.parse(new TextDecoder().decode(region.slice(0, length))),
  };
};

describe("channel layout", () => {
  it("allocates header plus both regions, 4-byte aligned", () => {
    const allocation = allocateChannel({ requestBytes: 10, responseBytes: 6 });
    expect(CHANNEL_HEADER_BYTES).toBe(64);
    expect(allocation.sizes).toEqual({ requestBytes: 12, responseBytes: 8 });
    expect(allocation.buffer.byteLength).toBe(64 + 12 + 8);
  });

  it("refuses a zero-sized region instead of allocating something unusable", () => {
    expect(() => allocateChannel({ requestBytes: 0, responseBytes: 64 })).toThrow(RangeError);
  });
});

describe("guards that must fire before any wait", () => {
  it("refuses a request larger than its region rather than truncating it", () => {
    const allocation = allocateChannel(SIZES);
    const client = new SyscallClient(allocation);
    const oversized = "x".repeat(SIZES.requestBytes + 8);
    expect(() => client.call({ oversized }, { timeoutMs: 50 })).toThrow(SyscallCapacityError);
    const header = new Int32Array(allocation.buffer, 0, 16);
    expect(Atomics.load(header, 4)).toBe(CHANNEL_ERROR.tooLarge);
  });

  it("refuses a call with no deadline", () => {
    const client = new SyscallClient(allocateChannel(SIZES));
    expect(() => client.call({ any: "value" }, { timeoutMs: 0 })).toThrow(RangeError);
  });

  it("refuses a call on a closed channel", () => {
    const allocation = allocateChannel(SIZES);
    const client = new SyscallClient(allocation);
    client.close();
    expect(() => client.call({ any: "value" }, { timeoutMs: 50 })).toThrow(SyscallChannelClosedError);
  });

  it("has a kernel that reports a closed channel instead of waiting on it", () => {
    const allocation = allocateChannel(SIZES);
    const server = serveChannel(allocation);
    server.close();
    expect(server.closed()).toBe(true);
    expect(server.serveOne(() => null, { timeoutMs: 5 })).toBe(false);
  });
});

describe("the kernel side handles a staged request", () => {
  it("answers with the handler's value", () => {
    const allocation = allocateChannel(SIZES);
    stageRequest(allocation.buffer, { op: "read", path: "/sample.txt" });
    const server = serveChannel(allocation);

    const served = server.serveOne((request) => ({ echoed: request }), { timeoutMs: 5 });

    expect(served).toBe(true);
    const response = readResponse(allocation.buffer);
    expect(response.state).toBe(CHANNEL_STATE.responsePending);
    expect(response.decoded).toEqual({
      ok: true,
      value: { echoed: { op: "read", path: "/sample.txt" } },
    });
  });

  it("turns a thrown error into a rejected syscall that keeps its code", () => {
    const allocation = allocateChannel(SIZES);
    stageRequest(allocation.buffer, { op: "read", path: "/missing.txt" });
    const server = serveChannel(allocation);

    server.serveOne(() => {
      const error = new Error("ENOENT: no such file or directory, open '/missing.txt'") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }, { timeoutMs: 5 });

    const response = readResponse(allocation.buffer) as {
      state: number;
      decoded: { ok: boolean; error: { message: string; code: string } };
    };
    expect(response.decoded.ok).toBe(false);
    expect(response.decoded.error.code).toBe("ENOENT");
    expect(response.decoded.error.message).toContain("/missing.txt");
  });

  it("reports an oversized response as an error instead of a truncated value", () => {
    const allocation = allocateChannel(SIZES);
    stageRequest(allocation.buffer, { op: "read" });
    const server = serveChannel(allocation);

    server.serveOne(() => ({ body: "y".repeat(SIZES.responseBytes * 2) }), { timeoutMs: 5 });

    const response = readResponse(allocation.buffer) as { decoded: { ok: boolean; error: { code: string } } };
    expect(response.decoded.ok).toBe(false);
    expect(response.decoded.error.code).toBe("ERESPTOOLARGE");
  });

  it("keeps the sequence number, so a late answer cannot be mistaken for the current one", () => {
    const allocation = allocateChannel(SIZES);
    stageRequest(allocation.buffer, { op: "stat" }, 7);
    const server = serveChannel(allocation);

    server.serveOne(() => "ok", { timeoutMs: 5 });

    const header = new Int32Array(allocation.buffer, 0, 16);
    expect(Atomics.load(header, 3)).toBe(7);
  });
});
