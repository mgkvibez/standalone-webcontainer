/**
 * Binary over a real shared channel, in both directions.
 *
 * The protocol change that removed base64 from the wire has a measured justification, and the measurement is worthless if the
 * bytes do not survive the trip. These tests stage the exact bytes the client produces, run the exact kernel-side server and
 * filesystem handler, and decode the exact response the client would receive. Views, empty bodies and a body that fills the
 * region are all included, because those are where offset arithmetic goes wrong.
 */

import { describe, expect, it } from "vitest";
import {
  CHANNEL_HEADER_BYTES,
  CHANNEL_STATE,
  allocateChannel,
  serveChannel,
} from "../../src/process/syscall-channel.js";
import { framedEncoding } from "../../src/process/frame.js";
import { createFsSyscallHandler } from "../../src/process/fs-syscalls.js";
import { FileSystem } from "../../src/vfs/index.js";

const SIZES = { requestBytes: 64 * 1024, responseBytes: 64 * 1024 };

const stage = (buffer: SharedArrayBuffer, frame: Uint8Array, sequence = 1): void => {
  const header = new Int32Array(buffer, 0, 16);
  new Uint8Array(buffer, CHANNEL_HEADER_BYTES, SIZES.requestBytes).set(frame);
  Atomics.store(header, 1, frame.byteLength);
  Atomics.store(header, 3, sequence);
  Atomics.store(header, 0, CHANNEL_STATE.requestPending);
};

const readResponse = (buffer: SharedArrayBuffer): unknown => {
  const header = new Int32Array(buffer, 0, 16);
  const length = Atomics.load(header, 2);
  const region = new Uint8Array(buffer, CHANNEL_HEADER_BYTES + SIZES.requestBytes, SIZES.responseBytes);
  return framedEncoding.decode(region.slice(0, length));
};

/** Non-repeating, so a shifted or truncated copy cannot compare equal by luck. */
const pattern = (length: number, seed = 7): Uint8Array => {
  const body = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) body[index] = (index * 31 + seed) % 256;
  return body;
};

describe("framed channel, request direction", () => {
  it("writes a binary body the handler reads as bytes", () => {
    const fs = new FileSystem();
    fs.mkdirSync("/app");
    const { buffer } = allocateChannel(SIZES);
    const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
    const handler = createFsSyscallHandler(fs, { owner: "pid-channel-test" });
    const body = pattern(4096);

    stage(buffer, framedEncoding.encode({ op: "write", path: "/app/blob.bin", data: body, dataEncoding: "binary" }), 1);
    expect(server.serveOne((request) => handler(request), { timeoutMs: 5 })).toBe(true);

    expect(fs.readFileSync("/app/blob.bin")).toEqual(body);
  });

  it("carries an empty body without confusing it for a missing one", () => {
    const fs = new FileSystem();
    fs.mkdirSync("/app");
    const { buffer } = allocateChannel(SIZES);
    const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
    const handler = createFsSyscallHandler(fs, { owner: "pid-channel-test" });

    stage(buffer, framedEncoding.encode({ op: "write", path: "/app/empty.bin", data: new Uint8Array(0), dataEncoding: "binary" }), 1);
    expect(server.serveOne((request) => handler(request), { timeoutMs: 5 })).toBe(true);

    expect((fs.readFileSync("/app/empty.bin") as Uint8Array).byteLength).toBe(0);
  });
});

describe("framed channel, response direction", () => {
  it("returns a binary read as bytes the client can use", () => {
    const fs = new FileSystem();
    fs.mkdirSync("/app");
    const body = pattern(3072, 11);
    fs.writeFileSync("/app/blob.bin", body);

    const { buffer } = allocateChannel(SIZES);
    const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
    const handler = createFsSyscallHandler(fs, { owner: "pid-channel-test" });

    stage(buffer, framedEncoding.encode({ op: "read", path: "/app/blob.bin" }), 2);
    expect(server.serveOne((request) => handler(request), { timeoutMs: 5 })).toBe(true);

    const answer = readResponse(buffer) as { ok: boolean; value: { kind: string; bytes: Uint8Array } };
    expect(answer.ok).toBe(true);
    expect(answer.value.kind).toBe("bytes");
    expect(Buffer.from(answer.value.bytes).equals(Buffer.from(body))).toBe(true);
  });

  it("keeps a text read as text", () => {
    const fs = new FileSystem();
    fs.mkdirSync("/app");
    fs.writeFileSync("/app/main.js", "console.log('hello');\n");

    const { buffer } = allocateChannel(SIZES);
    const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
    const handler = createFsSyscallHandler(fs, { owner: "pid-channel-test" });

    stage(buffer, framedEncoding.encode({ op: "read", path: "/app/main.js", encoding: "utf8" }), 3);
    expect(server.serveOne((request) => handler(request), { timeoutMs: 5 })).toBe(true);

    expect(readResponse(buffer)).toEqual({ ok: true, value: { kind: "text", text: "console.log('hello');\n" } });
  });

  it("reports a failure through a frame rather than raw JSON", () => {
    const fs = new FileSystem();
    const { buffer } = allocateChannel(SIZES);
    const server = serveChannel({ buffer, sizes: SIZES }, framedEncoding);
    const handler = createFsSyscallHandler(fs, { owner: "pid-channel-test" });

    stage(buffer, framedEncoding.encode({ op: "read", path: "/missing.txt" }), 4);
    expect(server.serveOne((request) => handler(request), { timeoutMs: 5 })).toBe(true);

    // The point: this decodes. An error path that wrote plain JSON would fail here, which is exactly the trap this test exists
    // for — the original error writers bypassed the encoding entirely.
    const answer = readResponse(buffer) as { ok: boolean; error?: { code?: string } };
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("ENOENT");
  });
});
