/**
 * Calibrating the instrument.
 *
 * A measurement tool that reports plausible numbers is worse than none: the syscall-metadata bench exists to decide whether
 * byte-framing is worth building, and every conclusion rests on the payload figure being the DATA and not something adjacent
 * to it. The first version of it reported 0 payload bytes for every op because it looked for a string where the handler
 * returns a typed body — a wrong number that looked like a finding.
 */

import { describe, expect, it } from "vitest";
import { payloadBytesOf } from "../../tools/bench/syscall-metadata.js";
import { createFsSyscallHandler } from "../../src/process/fs-syscalls.js";
import { jsonEncoding } from "../../src/process/syscall-channel.js";
import { FileSystem } from "../../src/vfs/index.js";

describe("payload accounting", () => {
  it("counts a text body in UTF-8 bytes, not characters", () => {
    expect(payloadBytesOf({ kind: "text", text: "hello" })).toBe(5);
    // Four characters, eight bytes: a character count would understate every non-ASCII file.
    expect(payloadBytesOf({ kind: "text", text: "héllo wörld" })).toBe(13);
  });

  it("counts a base64 body as the bytes it decodes to, not the base64 text", () => {
    // 4 bytes encode to "AQIDBA==" (8 chars). The bench must report 4: reporting 8 would hide the 33% base64 tax inside the
    // very overhead the measurement is meant to expose.
    expect(payloadBytesOf({ kind: "bytes", base64: "AQIDBA==" })).toBe(4);
    // Padding varies: one "=" drops a byte, none drops none. All three cases are real base64 lengths.
    expect(payloadBytesOf({ kind: "bytes", base64: "AQI=" })).toBe(2);
    expect(payloadBytesOf({ kind: "bytes", base64: "AQID" })).toBe(3);
  });

  it("counts a name list and reports no payload for a stats body", () => {
    expect(payloadBytesOf({ kind: "names", names: ["bin", "x.js"] })).toBe(7);
    expect(payloadBytesOf({ kind: "stats", vfsKind: "file", size: 6, modifiedAt: 1, createdAt: 1 })).toBe(0);
    expect(payloadBytesOf(null)).toBe(0);
    expect(payloadBytesOf("bare string")).toBe(0);
  });
});

describe("the two regimes the measurement separates", () => {
  const roundTrip = (content: string): { wire: number; payload: number } => {
    const fs = new FileSystem();
    fs.mkdirSync("/a");
    fs.writeFileSync("/a/x.txt", content);
    const handler = createFsSyscallHandler(fs, { owner: "test" });
    const request = { op: "read", path: "/a/x.txt", encoding: "utf8" };
    const requestBytes = jsonEncoding.encode(request).byteLength;
    const value = handler(request as never);
    const responseBytes = jsonEncoding.encode({ ok: true, value }).byteLength;
    return { wire: requestBytes + responseBytes, payload: payloadBytesOf(value) };
  };

  it("treats a large read as payload-bound, which is why framing is not a win there", () => {
    const { wire, payload } = roundTrip("x".repeat(4096));
    expect(payload).toBe(4096);
    // Under 5% overhead: the envelope is a rounding error against a 4 KiB body.
    expect((wire - payload) / wire).toBeLessThan(0.05);
  });

  it("treats a small read as envelope-bound, which is where framing pays", () => {
    const { wire, payload } = roundTrip("module.exports = 1;\n");
    expect(payload).toBe(20);
    // The envelope is larger than the data at this size, and a toolchain boot is mostly calls this size.
    expect((wire - payload) / wire).toBeGreaterThan(0.4);
  });
});
