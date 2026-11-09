/**
 * Wire conformance: what a client and a kernel promise each other.
 *
 * ADR-0021 gave the transport two message forms, and ADR-0018 gave it liveness rules. Both are covered elsewhere in
 * pieces (`frame.test.ts` checks the codec in isolation, `channel-binary.test.ts` checks the handler in isolation,
 * `binary-payload.spec.ts` checks one payload across a process boundary). None of those pins the *pairing*: a real client
 * against a real kernel over a real channel, with both ends recording what actually crossed.
 *
 * That is what this file does, because the two forms have exactly one invariant each and both are easy to break silently:
 *
 *   1. A message with no binary body crosses as plain JSON, byte for byte. The boot makes 96 small calls and pays nothing
 *      for a feature it does not use. If that ever silently starts framing, nothing fails, the boot just gets bigger.
 *   2. A message with a binary body crosses framed, and the bytes arrive intact. If that ever silently reverts to base64 or
 *      a text coercion, small files still pass and large ones corrupt.
 *
 * Both ends wrap the real codec in a recorder, so the assertions read the bytes off the wire instead of inferring them from
 * the decoded value. `Atomics.wait` is unavailable on a page's main thread, so this can only run in Workers.
 */

import { expect, test } from "@playwright/test";

interface WireRecord {
  readonly first: number;
  readonly length: number;
}

interface CallRecord {
  readonly label: string;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly code?: string; readonly message: string };
  readonly bytes?: number[];
}

interface ConformanceOutcome {
  readonly requests: readonly WireRecord[];
  readonly responses: readonly WireRecord[];
  readonly calls: readonly CallRecord[];
  /** Whether the first request's bytes equal plain JSON of the same value, computed inside the client's realm. */
  readonly plainJsonIdentical: boolean;
  readonly plainJsonExpected: number;
  readonly callsCompleted: number;
}

/** Bytes 0..255, so a text coercion loses something detectable rather than passing on ASCII. */
const FULL_RANGE = Array.from({ length: 256 }, (_unused, index) => index);

const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { buffer, role, sizes, moduleUrls } = event.data;
  const { SyscallClient, serveChannelAsync } = await import(moduleUrls.channel);
  const { framedEncoding } = await import(moduleUrls.frame);

  // A pass-through codec that records what crosses. Both ends wrap the real one, so nothing here can pass a call the
  // production path would fail: the bytes are encoded once by the real codec and only observed on the way past.
  // Direction matters, not role: the client ENCODES requests and the kernel ENCODES responses, and the recorder is told
  // which sink to write to for each direction rather than being told who it is.
  const requests = [];
  const responses = [];
  const recording = (sinks) => ({
    encode: (value) => {
      const bytes = framedEncoding.encode(value);
      sinks.encode.push({ first: bytes[0], length: bytes.byteLength });
      return bytes;
    },
    decode: (bytes) => {
      sinks.decode.push({ first: bytes[0], length: bytes.byteLength });
      return framedEncoding.decode(bytes);
    },
  });

  const allocation = { buffer, sizes };

  if (role === "kernel") {
    let stored = new Uint8Array(0);
    const handler = (request) => {
      if (request.op === "stat") return { ok: "stat", path: request.path };
      if (request.op === "read") {
        const bytes = new Uint8Array(256);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return { kind: "bytes", bytes };
      }
      if (request.op === "write") {
        stored = request.data;
        return { written: request.data.byteLength };
      }
      if (request.op === "echo") return { kind: "bytes", bytes: stored };
      if (request.op === "text") return { text: "h\\u00e9llo \\u2603", encoding: "utf8" };
      if (request.op === "huge") return { kind: "bytes", bytes: new Uint8Array(8192) };
      throw new Error("kernel said no");
    };

    // The kernel records what it decodes (requests) and what it encodes (responses). Responses are encoded by the channel
    // internally, so this has to be the encoding the server writes through.
    const end = await serveChannelAsync(allocation, recording({ decode: requests, encode: responses }));
    let stopping = false;
    const loop = (async () => {
      while (!stopping) await end.serveOne(handler, { timeoutMs: 100 });
      self.postMessage({ kind: "wire", requests, responses });
    })();

    self.onmessage = (message) => { if (message.data && message.data.stop) stopping = true; };
    self.postMessage({ kind: "ready" });
    return;
  }

  const client = new SyscallClient(allocation, recording({ decode: [], encode: requests }));
  const calls = [];

  // Binary results are turned into ordinary arrays here, in the realm that produced them: the record crosses two
  // structured clones before the assertion sees it, and a typed array is not worth trusting across that.
  const plain = (value) => {
    if (value && value.kind === "bytes") return { kind: "bytes", length: value.bytes.byteLength, bytes: Array.from(value.bytes) };
    return value;
  };

  const record = (label, run) => {
    try {
      calls.push({ label, value: plain(run()) });
    } catch (error) {
      calls.push({ label, error: { name: error.name, code: error.code, message: error.message } });
    }
  };

  const firstRequest = { op: "stat", path: "/a.txt" };
  record("stat", () => client.call(firstRequest, { timeoutMs: 10000 }));
  record("read", () => client.call({ op: "read", path: "/blob.bin" }, { timeoutMs: 10000 }));
  record("write", () =>
    client.call({ op: "write", path: "/out.bin", data: new Uint8Array(${JSON.stringify(FULL_RANGE)}), dataEncoding: "binary" }, { timeoutMs: 10000 }),
  );
  record("echo", () => client.call({ op: "echo" }, { timeoutMs: 10000 }));
  record("text", () => client.call({ op: "text", path: "/hello.txt", encoding: "utf8" }, { timeoutMs: 10000 }));
  record("boom", () => client.call({ op: "boom" }, { timeoutMs: 10000 }));
  record("huge", () => client.call({ op: "huge" }, { timeoutMs: 10000 }));

  // Computed in this realm, where TextEncoder exists, rather than comparing a length across realms.
  const expected = new TextEncoder().encode(JSON.stringify(firstRequest)).byteLength;

  self.postMessage({ kind: "results", calls, requests, responses, plainJsonExpected: expected });
};
`;

test("both message forms cross a real channel, in order, without cross-talk", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");

  const outcome = await page.evaluate(async (source) => {
    const moduleUrls = {
      channel: new URL("/src/process/syscall-channel.ts", location.origin).href,
      frame: new URL("/src/process/frame.ts", location.origin).href,
    };
    // A response region big enough for the 256-byte reads, and small enough that the 8 KiB answer must be refused.
    const sizes = { requestBytes: 64 * 1024, responseBytes: 4096 };
    const mod = await import(moduleUrls.channel);
    const allocation = mod.allocateChannel(sizes);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    // The listener is attached before the worker is told to start, and messages are buffered by kind. A worker that answers
    // faster than the page can attach a listener would otherwise lose its result, which is how the first version of this
    // harness hung: it waited for a ready signal the client role never sent.
    const start = (role: string) => {
      const worker = new Worker(url, { type: "module" });
      const received = new Map<string, Record<string, unknown>>();
      const waiting = new Map<string, (value: Record<string, unknown>) => void>();
      worker.addEventListener("message", (event) => {
        const kind = String(event.data?.kind);
        const data = event.data as Record<string, unknown>;
        received.set(kind, data);
        waiting.get(kind)?.(data);
        waiting.delete(kind);
      });
      const waitFor = (kind: string, timeoutMs: number): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const already = received.get(kind);
          if (already) return resolve(already);
          waiting.set(kind, resolve);
          setTimeout(() => reject(new Error(`worker did not send ${kind}`)), timeoutMs);
        });
      worker.postMessage({ buffer: allocation.buffer, role, sizes, moduleUrls });
      return { worker, waitFor };
    };

    const kernel = start("kernel");
    const client = start("client");
    await kernel.waitFor("ready", 10000);

    const clientResult = await client.waitFor("results", 20000);
    kernel.worker.postMessage({ stop: true });
    const kernelWire = await kernel.waitFor("wire", 10000);

    client.worker.terminate();
    kernel.worker.terminate();

    const requests = clientResult.requests as WireRecord[];
    return {
      requests,
      responses: kernelWire.responses as WireRecord[],
      calls: clientResult.calls as CallRecord[],
      plainJsonExpected: clientResult.plainJsonExpected as number,
      plainJsonIdentical: requests[0]?.length === (clientResult.plainJsonExpected as number),
      callsCompleted: (clientResult.calls as CallRecord[]).length,
    } satisfies ConformanceOutcome;
  }, WORKER_SOURCE);

  const { calls, requests, responses } = outcome;
  const byLabel = new Map(calls.map((call) => [call.label, call]));

  // Every call completed and in the order it was issued: a channel that reordered would show it here.
  expect(calls.map((call) => call.label)).toEqual(["stat", "read", "write", "echo", "text", "boom", "huge"]);

  // ---- Form 1: a message with no body is plain JSON, byte for byte ----
  expect(requests[0]?.first).toBe(0x7b); // '{'
  expect(outcome.plainJsonIdentical).toBe(true);

  // ---- Form 2: a message carrying a body is framed ----
  expect(requests[2]?.first).toBe(0x46); // 'F'
  // And it is not base64: 256 bytes framed stays close to the body, while base64 would add a third again.
  expect(requests[2]?.length).toBeGreaterThanOrEqual(256);
  expect(requests[2]?.length).toBeLessThan(400);

  // The responses follow the same rule, which is the half that is easiest to get wrong: the kernel encodes them.
  expect(responses[0]?.first).toBe(0x7b); // stat: no body
  expect(responses[1]?.first).toBe(0x46); // read: 256-byte body
  expect(responses[4]?.first).toBe(0x7b); // text: no body, despite being a string

  // Eight encodes for seven calls, and the extra one is the oversize path being honest about itself: the kernel encodes the
  // 8 KiB answer, discovers it cannot fit the 4 KiB region, then encodes the refusal. Pinned as a count so that a future
  // change to that path has to say out loud that it moved, and pinned as forms so the refusal is known to be plain JSON.
  expect(responses.length).toBe(8);
  expect(responses[6]?.first).toBe(0x46); // the answer that did not fit, framed
  expect(responses[6]?.length).toBeGreaterThan(8192);
  expect(responses[7]?.first).toBe(0x7b); // the refusal, JSON, and small
  expect(responses[7]?.length).toBeLessThan(512);

  // ---- Byte fidelity across the boundary ----
  const read = byLabel.get("read") as CallRecord & { value: { kind: string; length: number; bytes: number[] } };
  expect(read.error).toBeUndefined();
  expect(read.value.kind).toBe("bytes");
  expect(read.value.length).toBe(256);
  expect(read.value.bytes).toEqual(FULL_RANGE);

  // Written from the client, returned from the kernel: the same 256 values, not a re-encoding of them.
  expect(byLabel.get("write")?.value).toEqual({ written: 256 });
  const echo = byLabel.get("echo") as CallRecord & { value: { bytes: number[] } };
  expect(echo.value.bytes).toEqual(FULL_RANGE);

  // ---- A text answer is still text, not bytes ----
  expect(byLabel.get("text")?.value).toEqual({ text: "héllo ☃", encoding: "utf8" });

  // ---- Failures cross as failures, by name ----
  const boom = byLabel.get("boom");
  expect(boom?.value).toBeUndefined();
  expect(boom?.error?.name).toBe("SyscallRejectedError");
  expect(boom?.error?.message).toContain("kernel said no");

  // ---- An answer that cannot fit is refused by name, not truncated and not hung ----
  const huge = byLabel.get("huge");
  expect(huge?.value).toBeUndefined();
  expect(huge?.error?.name).toBe("SyscallRejectedError");
  expect(huge?.error?.code).toBe("ERESPTOOLARGE");
});
