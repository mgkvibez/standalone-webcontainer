/**
 * The process's half of the filesystem bridge.
 *
 * This is a `FileSystemPort`, so the shims and the loader inside a process Worker cannot tell it from the real VFS. Every
 * call leaves the Worker as a blocking syscall and comes back with either a value or a POSIX code.
 *
 * Why not make it async: user code calls `fs.readFileSync`. Its contract is a value, not a promise, so the only honest
 * way to implement it across a Worker boundary is to stop the calling thread and wait, which is what the channel does.
 *
 * The transport is injected rather than constructed here, so the wire format can be tested without Workers or
 * `Atomics.wait` (see `tests/unit/fs-bridge.test.ts`).
 */

import type { FileSystemPort, MkdirOptionsPort, VfsStatsPort, WriteOptionsPort } from "../vfs/port.js";
import { decodeBase64, encodeBase64 } from "./base64.js";
import type { FsRequest, FsResponse } from "./fs-syscalls.js";

export interface SyscallTransport {
  call(request: unknown, options?: { readonly timeoutMs?: number }): unknown;
}

export interface RemoteFileSystemOptions {
  readonly timeoutMs?: number;
}

export function createRemoteFileSystem(
  transport: SyscallTransport,
  options: RemoteFileSystemOptions = {},
): FileSystemPort {
  const send = (request: FsRequest): FsResponse => {
    const answer = transport.call(request, options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs });
    if (typeof answer !== "object" || answer === null || typeof (answer as { kind?: unknown }).kind !== "string") {
      throw new Error("filesystem syscall returned a response the client does not understand");
    }
    return answer as FsResponse;
  };

  const expectEmpty = (answer: FsResponse, what: string): void => {
    if (answer.kind !== "empty") throw new Error(`filesystem ${what} returned "${answer.kind}" where nothing was expected`);
  };

  return {
    readFileSync(path: string, encoding?: "utf8"): Uint8Array | string {
      const answer = send(encoding === "utf8" ? { op: "read", path, encoding } : { op: "read", path });
      if (encoding === "utf8") {
        if (answer.kind !== "text") throw new Error(`filesystem read of "${path}" returned "${answer.kind}" where text was expected`);
        return answer.text;
      }
      if (answer.kind !== "bytes") throw new Error(`filesystem read of "${path}" returned "${answer.kind}" where bytes were expected`);
      return decodeBase64(answer.base64);
    },
    writeFileSync(path: string, data: string | Uint8Array, writeOptions?: WriteOptionsPort): void {
      const request: FsRequest =
        typeof data === "string"
          ? { op: "write", path, data, dataEncoding: "utf8", ...(writeOptions?.evictable === undefined ? {} : { evictable: writeOptions.evictable }) }
          : {
              op: "write",
              path,
              data: encodeBase64(data),
              dataEncoding: "base64",
              ...(writeOptions?.evictable === undefined ? {} : { evictable: writeOptions.evictable }),
            };
      expectEmpty(send(request), "write");
    },
    mkdirSync(path: string, mkdirOptions?: MkdirOptionsPort): void {
      expectEmpty(
        send(mkdirOptions?.recursive === undefined ? { op: "mkdir", path } : { op: "mkdir", path, recursive: mkdirOptions.recursive }),
        "mkdir",
      );
    },
    readdirSync(path: string): string[] {
      const answer = send({ op: "readdir", path });
      if (answer.kind !== "names") throw new Error(`filesystem readdir of "${path}" returned "${answer.kind}" where names were expected`);
      return [...answer.names];
    },
    statSync(path: string): VfsStatsPort {
      const answer = send({ op: "stat", path });
      if (answer.kind !== "stats") throw new Error(`filesystem stat of "${path}" returned "${answer.kind}" where stats were expected`);
      return { kind: answer.vfsKind, size: answer.size, modifiedAt: answer.modifiedAt, createdAt: answer.createdAt };
    },
    unlinkSync(path: string): void {
      expectEmpty(send({ op: "unlink", path }), "unlink");
    },
    rmdirSync(path: string): void {
      expectEmpty(send({ op: "rmdir", path }), "rmdir");
    },
    renameSync(from: string, to: string): void {
      expectEmpty(send({ op: "rename", from, to }), "rename");
    },
    async readFile(path: string, encoding?: "utf8"): Promise<Uint8Array | string> {
      return this.readFileSync(path, encoding);
    },
    async writeFile(path: string, data: string | Uint8Array, writeOptions?: WriteOptionsPort): Promise<void> {
      this.writeFileSync(path, data, writeOptions);
    },
    async mkdir(path: string, mkdirOptions?: MkdirOptionsPort): Promise<void> {
      this.mkdirSync(path, mkdirOptions);
    },
    async readdir(path: string): Promise<string[]> {
      return this.readdirSync(path);
    },
    async unlink(path: string): Promise<void> {
      this.unlinkSync(path);
    },
  };
}
