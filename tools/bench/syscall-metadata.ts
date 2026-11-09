/**
 * What a syscall actually costs on the wire, byte by byte.
 *
 * The benchmark answered "how fast" and "how much" for large payloads. It did not answer the question the byte-framing
 * decision turns on: for a REALISTIC MIX of small calls, how much of each message is the payload and how much is the envelope
 * around it. If metadata dominates, framing is the lever; if payload dominates, framing buys nothing and the base64 tax is
 * the thing to attack instead.
 *
 * The requests are the ones the real client sends: every call goes through `createRemoteFileSystem`, so the request objects
 * are exactly production shapes, and both directions are encoded with the production encoder. What is NOT measured is the
 * shared-memory hand-off itself (the Atomics wait), which the scaling benchmark already covers in time.
 *
 * Run with `npm run bench:syscall-metadata`. Writes `artifacts/syscall-metadata.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRemoteFileSystem } from "../../src/process/remote-fs.js";
import { createFsSyscallHandler } from "../../src/process/fs-syscalls.js";
import { jsonEncoding } from "../../src/process/syscall-channel.js";
import { FileSystem } from "../../src/vfs/index.js";

export interface OpMeasurement {
  readonly op: string;
  readonly calls: number;
  /** Bytes of the encoded request, summed. */
  readonly requestBytes: number;
  /** Bytes of the encoded response, summed. */
  readonly responseBytes: number;
  /** Bytes of the payload those responses carried (file contents, directory names), summed. */
  readonly payloadBytes: number;
}

export interface MetadataReport {
  readonly ops: readonly OpMeasurement[];
  readonly totals: {
    readonly calls: number;
    readonly requestBytes: number;
    readonly responseBytes: number;
    readonly payloadBytes: number;
    /** Share of all wire bytes that is envelope rather than payload, 0..1. */
    readonly metadataShare: number;
  };
}

interface Recorder {
  record(op: string, requestBytes: number, responseBytes: number, payloadBytes: number): void;
}

/** A client-shaped object that measures each call on its way to the real handler. */
export const createMeasuringClient = (
  handler: (request: never) => unknown,
  recorder: Recorder,
): { call: (request: unknown, options: unknown) => unknown } => ({
  call: (request) => {
    const op = String((request as { op?: unknown }).op ?? "unknown");
    const requestBytes = jsonEncoding.encode(request).byteLength;
    const value = handler(request as never);
    const responseBytes = jsonEncoding.encode({ ok: true, value }).byteLength;
    recorder.record(op, requestBytes, responseBytes, payloadBytesOf(value));
    return value;
  },
});

/**
 * How many bytes of the response were the data itself.
 *
 * The handler returns TYPED bodies — `{kind:"text"}`, `{kind:"bytes"}` with base64, `{kind:"names"}` — not bare values, which
 * is why the first version of this reported 0 payload bytes for every op: it was looking for a string that never existed.
 * Encoding the shapes here rather than subtracting keys keeps the figure honest when a response shape changes.
 */
export const payloadBytesOf = (value: unknown): number => {
  const encoder = new TextEncoder();
  if (value === null || typeof value !== "object") return 0;
  const body = value as { kind?: string; text?: string; base64?: string; names?: unknown };
  if (body.kind === "text" && typeof body.text === "string") return encoder.encode(body.text).byteLength;
  // Base64 is 4 chars per 3 bytes, so the decoded size is what the data actually was. This is the number byte-framing
  // would recover, and counting the encoded form would hide the very overhead being measured.
  if (body.kind === "bytes" && typeof body.base64 === "string") {
    // Padding is the difference between "close enough" and correct for small bodies: "AQIDBA==" is 8 characters encoding
    // FOUR bytes, and 8*3/4 without the padding correction says six. A 4-byte artifact would have been reported as 6,
    // overstating payload by 50% on exactly the small binaries a build touches most.
    const padding = body.base64.endsWith("==") ? 2 : body.base64.endsWith("=") ? 1 : 0;
    return Math.floor((body.base64.length * 3) / 4) - padding;
  }
  if (body.kind === "names" && Array.isArray(body.names)) {
    return body.names.reduce((total: number, name: unknown) => total + encoder.encode(String(name)).byteLength, 0);
  }
  return 0;
};

const seed = (fs: FileSystem): void => {
  // A small project shape: a source file, a package manifest, a binary-ish asset, and a node_modules-like tree whose
  // readdir has many entries. This is what a toolchain boot actually touches.
  fs.mkdirSync("/project/src", { recursive: true });
  fs.mkdirSync("/project/node_modules/.bin", { recursive: true });
  fs.writeFileSync("/project/package.json", JSON.stringify({ name: "demo", version: "1.0.0", scripts: { build: "node src/main.js" } }, null, 2));
  fs.writeFileSync("/project/src/main.js", "import { add } from './add.js';\nconsole.log(add(1, 2));\n".repeat(40));
  fs.writeFileSync("/project/src/add.js", "export const add = (a, b) => a + b;\n");
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(`/project/node_modules/pkg-${index}/index.js`, `module.exports = ${index};\n`);
  }
  fs.writeFileSync("/project/node_modules/.bin/tool", "#!/usr/bin/env node\nconsole.log('tool');\n");
};


export const measure = async (): Promise<MetadataReport> => {
  const fs = new FileSystem();
  seed(fs);
  const measured = new Map<string, { calls: number; requestBytes: number; responseBytes: number; payloadBytes: number }>();
  const recorder: Recorder = {
    record: (op, requestBytes, responseBytes, payloadBytes) => {
      const entry = measured.get(op) ?? { calls: 0, requestBytes: 0, responseBytes: 0, payloadBytes: 0 };
      entry.calls += 1;
      entry.requestBytes += requestBytes;
      entry.responseBytes += responseBytes;
      entry.payloadBytes += payloadBytes;
      measured.set(op, entry);
    },
  };
  const handler = createFsSyscallHandler(fs, { owner: "bench" });
  const client = createMeasuringClient(handler as (request: never) => unknown, recorder);
  const port = createRemoteFileSystem(client as never, { timeoutMs: 1000 });

  await port.readFile("/project/package.json", "utf8");
  for (const path of ["/project",
    "/project/src",
    "/project/src/main.js",
    "/project/src/add.js",
    "/project/node_modules",
    "/project/node_modules/.bin",
    "/project/node_modules/.bin/tool"]) {
    port.statSync(path);
  }
  await port.readFile("/project/src/main.js", "utf8");
  await port.readdir("/project");
  await port.readdir("/project/src");
  await port.readdir("/project/node_modules");
  for (let index = 0; index < 40; index += 1) {
    port.statSync(`/project/node_modules/pkg-${index}`);
    await port.readFile(`/project/node_modules/pkg-${index}/index.js`, "utf8");
  }
  await port.mkdir("/project/dist", { recursive: true });
  await port.writeFile("/project/dist/main.js", "console.log(3);\n");
  port.renameSync("/project/dist/main.js", "/project/dist/main.mjs");
  await port.unlink("/project/dist/main.mjs");

  const ops: OpMeasurement[] = [...measured.entries()]
    .map(([op, entry]) => ({ op, ...entry }))
    .sort(
      (left, right) =>
        right.requestBytes + right.responseBytes - (left.requestBytes + left.responseBytes),
    );

  const calls = ops.reduce((total, op) => total + op.calls, 0);
  const requestBytes = ops.reduce((total, op) => total + op.requestBytes, 0);
  const responseBytes = ops.reduce((total, op) => total + op.responseBytes, 0);
  const payloadBytes = ops.reduce((total, op) => total + op.payloadBytes, 0);
  const wire = requestBytes + responseBytes;
  return {
    ops,
    totals: {
      calls,
      requestBytes,
      responseBytes,
      payloadBytes,
      metadataShare: wire === 0 ? 0 : (wire - payloadBytes) / wire,
    },
  };
};

const main = async (): Promise<void> => {
  const report = await measure();
  const percent = (part: number, whole: number): string =>
    whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;

  console.log("Syscall wire cost, measured through the real client against the real handler\n");
  console.log("| op | calls | request B/call | response B/call | payload B/call | metadata share |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const op of report.ops) {
    const bytes = op.requestBytes + op.responseBytes;
    console.log(
      `| ${op.op} | ${op.calls} | ${(op.requestBytes / op.calls).toFixed(1)} | ${(op.responseBytes / op.calls).toFixed(1)} | ${(op.payloadBytes / op.calls).toFixed(1)} | ${percent(bytes - op.payloadBytes, bytes)} |`,
    );
  }
  const wire = report.totals.requestBytes + report.totals.responseBytes;
  console.log(
    `| **all** | ${report.totals.calls} | ${(report.totals.requestBytes / report.totals.calls).toFixed(1)} | ${(report.totals.responseBytes / report.totals.calls).toFixed(1)} | ${(report.totals.payloadBytes / report.totals.calls).toFixed(1)} | **${percent(wire - report.totals.payloadBytes, wire)}** |`,
  );
  console.log(
    `\n${wire} bytes over ${report.totals.calls} calls; ${report.totals.payloadBytes} of those bytes were payload.`,
  );

  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/syscall-metadata.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log("written artifacts/syscall-metadata.json");
};

// vite-node replaces argv[1] with its own binary, so "was this file invoked directly?" cannot be answered from argv at all:
// the first two attempts at this guard both exited 0 having measured nothing. Vitest is the only case where importing this
// module must not run the bench, and it says so in the environment.
if (process.env.VITEST === undefined) {
  await main();
}
