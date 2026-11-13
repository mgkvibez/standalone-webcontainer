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
import type { FsRequest, FsResponse } from "./fs-syscalls.js";
import type { BatchOutcome } from "./syscall-channel.js";

export interface SyscallTransport {
  call(request: unknown, options?: { readonly timeoutMs?: number }): unknown;
  /**
   * Optional: a transport that can carry several independent calls in one round trip. A transport without it is still a
   * transport, and the filesystem falls back to N calls rather than refusing to work.
   */
  callMany?(requests: readonly unknown[], options?: { readonly timeoutMs?: number }): readonly BatchOutcome[];
}

export interface RemoteFileSystemOptions {
  readonly timeoutMs?: number;
}

/**
 * The largest slice a ranged read asks for.
 *
 * Deliberately far below the frame size: the payload is JSON with binary carried as a byte array, so one byte on disk costs several bytes on the
 * wire, and a slice sized to the frame would overflow it again. 64 KiB is small enough to fit any configured region and large enough that a
 * multi-megabyte file costs tens of round trips rather than thousands.
 */
const READ_RANGE_BYTES = 64 * 1024;

/**
 * The largest piece of a write that one request frame can carry.
 *
 * A quarter of the 512 KiB request region, not at its edge: the frame carries a JSON header plus the bytes themselves, and the frame size is a
 * deployment detail, so a chunk sized to today's region would overflow the moment one were configured smaller. Chosen against a quarter rather than a
 * half because the first attempt at half failed by 141 bytes - the header and path - which is exactly the margin a "fits" that was never measured
 * leaves. `tests/unit/fs-bridge.test.ts` measures every chunk with the channel's own encoder against a 256 KiB budget, deliberately smaller than the
 * 512 KiB production region so a smaller frame fails in the test and not in a browser.
 */
const WRITE_CHUNK_BYTES = 128 * 1024;

/** Whether a failed call failed because the answer did not fit one frame. */
function isTooLargeResponse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const coded = error as { readonly code?: unknown; readonly message?: unknown };
  if (coded.code === "ERESPTOOLARGE") return true;
  return typeof coded.message === "string" && coded.message.includes("ERESPTOOLARGE");
}

/**
 * Read a file that does not fit one frame, in slices, and join them.
 *
 * The text form is decoded ONCE at the end rather than per slice: a slice boundary falls inside a multi-byte character often enough to matter, and
 * decoding each piece would corrupt exactly the files this path exists to load.
 */
function readInRanges(
  send: (request: FsRequest) => FsResponse,
  path: string,
  encoding: "utf8" | undefined,
): Uint8Array | string {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const answer = send({ op: "read", path, offset, length: READ_RANGE_BYTES });
    if (answer.kind !== "bytes") {
      throw new Error(`filesystem range read of "${path}" returned "${answer.kind}" where bytes were expected`);
    }
    const piece = answer.bytes;
    if (piece.byteLength === 0) break;
    pieces.push(piece);
    offset += piece.byteLength;
    if (piece.byteLength < READ_RANGE_BYTES) break;
  }
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.byteLength;
  }
  return encoding === "utf8" ? new TextDecoder().decode(joined) : joined;
}

/**
 * Deadline for a syscall when the caller does not choose one.
 *
 * Every call must carry a deadline — an un-deadlined wait on a kernel that died is a hang, which is the failure mode this
 * whole channel exists to avoid — so an omitted option means "the default", never "no deadline". Omitting it used to pass
 * `undefined` into `SyscallClient.call`, which threw `TypeError: Cannot read properties of undefined (reading 'timeoutMs')`
 * on the first read: a port that built cleanly and failed on use.
 */
export const DEFAULT_SYSCALL_TIMEOUT_MS = 5_000;

export function createRemoteFileSystem(
  transport: SyscallTransport,
  options: RemoteFileSystemOptions = {},
): FileSystemPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYSCALL_TIMEOUT_MS;
  const send = (request: FsRequest): FsResponse => {
    const answer = transport.call(request, { timeoutMs });
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
      const whole = (): Uint8Array | string => {
        const answer = send(encoding === "utf8" ? { op: "read", path, encoding } : { op: "read", path });
        if (encoding === "utf8") {
          if (answer.kind !== "text") throw new Error(`filesystem read of "${path}" returned "${answer.kind}" where text was expected`);
          return answer.text;
        }
        if (answer.kind !== "bytes") throw new Error(`filesystem read of "${path}" returned "${answer.kind}" where bytes were expected`);
        return answer.bytes;
      };
      try {
        return whole();
      } catch (error) {
        // A response travels in one fixed-size shared region, so a file larger than that region cannot come back in one frame. Measured need:
        // `vite` ships a 2.1 MB node chunk, and the dev server died on `ERESPTOOLARGE` while the loader read it. Falling back to ranged reads
        // keeps the fast path (one call for every ordinary file) and makes the large one work instead of being a hard ceiling nobody can see.
        if (!isTooLargeResponse(error)) throw error;
        return readInRanges(send, path, encoding);
      }
    },
    /**
     * Write a file, in pieces when it does not fit one request frame.
     *
     * A request region is fixed, and a frame larger than it has no legal encoding: it throws `SyscallCapacityError` rather than truncating. Anything
     * bigger therefore had no way to be written at all - which is how the browser product lost vite's dependency
     * optimizer: it writes a 1.7 MB pre-bundled `react-dom_client.js`, the write threw, the optimizer aborted with `error while updating
     * dependencies`, and every page load then asked for a dependency file that had never been created and got `504 Outdated Optimize Dep`.
     *
     * The first piece replaces the file and the rest append, so a half-written file is never visible as a whole one, and the small path stays a single
     * call with the caller's own encoding. A string too large for one frame is encoded to UTF-8 bytes and travels as binary: the bytes are what the
     * file would have held either way, and a chunk boundary inside a multi-byte character is then not a thing that can happen.
     */
    writeFileSync(path: string, data: string | Uint8Array, writeOptions?: WriteOptionsPort): void {
      const evictable = writeOptions?.evictable === undefined ? {} : { evictable: writeOptions.evictable };
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (bytes.byteLength <= WRITE_CHUNK_BYTES) {
        const request: FsRequest =
          typeof data === "string"
            ? { op: "write", path, data, dataEncoding: "utf8", ...evictable }
            : { op: "write", path, data, dataEncoding: "binary", ...evictable };
        expectEmpty(send(request), "write");
        return;
      }
      for (let at = 0; at < bytes.byteLength; at += WRITE_CHUNK_BYTES) {
        const piece = bytes.slice(at, Math.min(at + WRITE_CHUNK_BYTES, bytes.byteLength));
        expectEmpty(
          send({ op: "write", path, data: piece, dataEncoding: "binary", ...(at === 0 ? {} : { append: true }), ...evictable }),
          "write",
        );
      }
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
    /**
     * Stat several paths in ONE round trip. This is where batching earns its keep: module resolution probes a candidate and
     * every extension guess for it, and those probes are independent even though their order decides which one wins.
     *
     * A failure maps to `null` rather than propagating, because every caller uses this to answer "does this exist" and a
     * missing file is the common case, not an exception. A failed entry costs only itself: the other answers in the batch
     * are still returned.
     */
    statManySync(paths: readonly string[]): readonly (VfsStatsPort | null)[] {
      if (paths.length === 0) return [];
      // One round trip where the transport offers batching; otherwise the same answers, one call at a time.
      const outcomes: readonly BatchOutcome[] = transport.callMany
        ? transport.callMany(paths.map((path) => ({ op: "stat", path })), { timeoutMs })
        : paths.map((path): BatchOutcome => {
            try {
              return { ok: true, value: send({ op: "stat", path }) };
            } catch (error) {
              return { ok: false, error: { message: (error as Error).message } };
            }
          });
      return outcomes.map((outcome) => {
        if (!outcome.ok) return null;
        const answer = outcome.value as { kind?: string; vfsKind?: "file" | "dir"; size?: number; modifiedAt?: number; createdAt?: number };
        if (answer?.kind !== "stats") return null;
        return {
          kind: answer.vfsKind as "file" | "dir",
          size: answer.size as number,
          modifiedAt: answer.modifiedAt as number,
          createdAt: answer.createdAt as number,
        };
      });
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
