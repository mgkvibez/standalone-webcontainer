/**
 * The kernel's half of the filesystem bridge.
 *
 * A process Worker cannot reach the VFS, so every filesystem call it makes arrives here as a request. Two rules govern
 * this file:
 *
 * 1. **Nothing is trusted.** The request comes from code we are deliberately treating as hostile, so the operation, the
 *    shape and the types are checked before anything touches the VFS. An unknown operation is a refusal (`EINVAL`), not
 *    a default branch.
 * 2. **Errors keep their identity.** `ENOENT` must reach the caller as `ENOENT`: user code branches on it, and a generic
 *    failure would turn "the file is missing" into "the runtime is broken".
 */

import type { FileSystemPort } from "../vfs/port.js";
import type { WatchRegistry } from "./watch-registry.js";

export type FsRequest =
  | {
      readonly op: "read";
      readonly path: string;
      readonly encoding?: "utf8";
      /** Byte range for a file too large for one response frame. Absent means the whole file. */
      readonly offset?: number;
      readonly length?: number;
    }
  | {
      readonly op: "write";
      readonly path: string;
      readonly data: string | Uint8Array;
      readonly dataEncoding: "utf8" | "binary";
      // Declared as `evictable`, which is what both ends have always sent. The union said `mode?: number`, and the object
      // spread in the client hid the mismatch from the typechecker, so the declared shape described nothing.
      readonly evictable?: boolean;
      /**
       * Append instead of replacing the file.
       *
       * A request frame is fixed-size, so a file bigger than one frame has to arrive in pieces, and the pieces after the first one have nothing to
       * replace: they continue it. Without this flag a large write has no legal encoding at all, which is what a 1.7 MB pre-bundled dependency hit.
       */
      readonly append?: boolean;
    }
  | { readonly op: "mkdir"; readonly path: string; readonly recursive?: boolean }
  | { readonly op: "readdir"; readonly path: string }
  | { readonly op: "stat"; readonly path: string }
  | { readonly op: "unlink"; readonly path: string }
  | { readonly op: "rmdir"; readonly path: string }
  | { readonly op: "rename"; readonly from: string; readonly to: string };

export type FsResponse =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "names"; readonly names: readonly string[] }
  | {
      readonly kind: "stats";
      readonly vfsKind: "file" | "dir";
      readonly size: number;
      readonly modifiedAt: number;
      readonly createdAt: number;
    }
  | { readonly kind: "watch"; readonly watchId: number }
  | {
      readonly kind: "events";
      readonly events: readonly { readonly kind: "change" | "rename"; readonly path: string; readonly previousPath?: string }[];
      readonly dropped: number;
    };

/** A filesystem failure with a POSIX-shaped code, which is what user code branches on. */
export class FileSystemSyscallError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "FileSystemSyscallError";
    this.code = code;
  }
}

const CODES_BY_MESSAGE: readonly (readonly [RegExp, string])[] = [
  [/not found|no such file|ENOENT/i, "ENOENT"],
  [/is a directory|EISDIR/i, "EISDIR"],
  [/not a directory|ENOTDIR/i, "ENOTDIR"],
  [/already exists|EEXIST/i, "EEXIST"],
  [/not empty|ENOTEMPTY/i, "ENOTEMPTY"],
  [/permission|EACCES/i, "EACCES"],
  [/invalid|must be|outside/i, "EINVAL"],
];

export function codeForError(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate?.code === "string" && candidate.code !== "") return candidate.code;
  const message = typeof candidate?.message === "string" ? candidate.message : String(error);
  for (const [pattern, code] of CODES_BY_MESSAGE) {
    if (pattern.test(message)) return code;
  }
  return "EIO";
}

function refuse(message: string, code = "EINVAL"): never {
  throw new FileSystemSyscallError(message, code);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") refuse(`filesystem request field "${field}" must be a non-empty string`);
  return value;
}

/** A validated byte range, or null when the request asked for the whole file. */
/** The bytes of a file, or empty when it does not exist yet, which is what an append to a new file means. */
function readExisting(fs: FileSystemPort, path: string): Uint8Array {
  try {
    const existing = fs.readFileSync(path);
    return typeof existing === "string" ? new TextEncoder().encode(existing) : existing;
  } catch {
    return new Uint8Array(0);
  }
}

/** Two pieces as one, in the order they arrived. */
function join(before: Uint8Array, after: string | Uint8Array): Uint8Array {
  const tail = typeof after === "string" ? new TextEncoder().encode(after) : after;
  const joined = new Uint8Array(before.byteLength + tail.byteLength);
  joined.set(before, 0);
  joined.set(tail, before.byteLength);
  return joined;
}

function readRange(offset: unknown, length: unknown): { readonly offset: number; readonly length?: number } | null {
  if (offset === undefined && length === undefined) return null;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)) {
    refuse("filesystem read offset must be a non-negative integer");
  }
  if (length !== undefined && (typeof length !== "number" || !Number.isInteger(length) || length <= 0)) {
    refuse("filesystem read length must be a positive integer");
  }
  return { offset: offset === undefined ? 0 : offset, ...(length === undefined ? {} : { length }) };
}

export interface FsHandlerOptions {
  /**
   * Watches live in the kernel, so the handler needs the registry to register and drain them.
   *
   * Absent means "this handler cannot watch": the watch ops then refuse with ENOSYS rather than pretending, which is how a
   * caller finds out instead of silently waiting for events that can never arrive.
   */
  readonly watches?: WatchRegistry;
  /**
   * Which process these requests belong to.
   *
   * Bound by the kernel, never sent by the process: a process that could name its own owner could poll or cancel watches it
   * does not hold. The kernel already knows which channel it is serving, so the identity comes from there.
   */
  readonly owner?: string;
}

export function createFsSyscallHandler(
  fs: FileSystemPort,
  options: FsHandlerOptions = {},
): (request: unknown) => FsResponse {
  const requireWatches = (): WatchRegistry => {
    const registry = options.watches;
    if (registry === undefined) refuse("this runtime does not serve filesystem watches", "ENOSYS");
    return registry;
  };
  const requireOwner = (): string => {
    const owner = options.owner;
    if (owner === undefined) refuse("this runtime does not know which process is asking", "ENOSYS");
    return owner;
  };
  return (request: unknown): FsResponse => {
    if (typeof request !== "object" || request === null) refuse("filesystem request must be an object");
    const { op } = request as { op?: unknown };
    if (typeof op !== "string") refuse("filesystem request must name an operation");

    try {
      switch (op) {
        case "read": {
          const { path, encoding, offset, length } = request as {
            path?: unknown;
            encoding?: unknown;
            offset?: unknown;
            length?: unknown;
          };
          const target = requireString(path, "path");
          // A range read exists because one response frame is a fixed-size shared region: vite's node chunk is 2.1 MB and the frame refused
          // it with ERESPTOOLARGE, which no amount of retrying fixes. The slice is resolved HERE, where the bytes are, so the client never
          // has to know the frame size and a small file still costs one round trip.
          const range = readRange(offset, length);
          if (range !== null) {
            if (encoding !== undefined) refuse('filesystem range read does not take an encoding; decode the joined bytes at the caller');
            const whole = fs.readFileSync(target) as Uint8Array;
            const start = Math.min(range.offset, whole.byteLength);
            const end = range.length === undefined ? whole.byteLength : Math.min(start + range.length, whole.byteLength);
            return { kind: "bytes", bytes: whole.subarray(start, end) };
          }
          if (encoding === "utf8") {
            return { kind: "text", text: fs.readFileSync(target, "utf8") as string };
          }
          if (encoding !== undefined) refuse('filesystem read encoding must be "utf8" or absent');
          const bytes = fs.readFileSync(target) as Uint8Array;
          return { kind: "bytes", bytes };
        }
        case "write": {
          const { path, data, dataEncoding, evictable, append } = request as {
            path?: unknown;
            data?: unknown;
            dataEncoding?: unknown;
            evictable?: unknown;
            append?: unknown;
          };
          const target = requireString(path, "path");
          if (evictable !== undefined && typeof evictable !== "boolean") refuse("filesystem write evictable must be a boolean");
          // Binary arrives as bytes, not as base64: the wire frame carries the array directly. A "base64" request is refused
          // by name rather than silently accepted, because a half-migrated peer would otherwise be undetectable.
          const payload: string | Uint8Array =
            dataEncoding === "utf8"
              ? typeof data === "string"
                ? data
                : refuse("filesystem write data must be a string when dataEncoding is utf8")
              : dataEncoding === "binary"
                ? data instanceof Uint8Array
                  ? data
                  : refuse("filesystem write data must be a Uint8Array when dataEncoding is binary")
                : refuse('filesystem write dataEncoding must be "utf8" or "binary"');
          if (append !== undefined && typeof append !== "boolean") refuse("filesystem write append must be a boolean");
          if (append === true) {
            // Read-modify-write, because the port's only write replaces a whole file. A missing target is the normal case for the
            // first piece of a chunked write (append creates), so it starts from empty rather than failing.
            const existing = readExisting(fs, target);
            fs.writeFileSync(target, join(existing, payload), evictable === undefined ? {} : { evictable });
            return { kind: "empty" };
          }
          fs.writeFileSync(target, payload, evictable === undefined ? {} : { evictable });
          return { kind: "empty" };
        }
        case "mkdir": {
          const { path, recursive } = request as { path?: unknown; recursive?: unknown };
          const target = requireString(path, "path");
          if (recursive !== undefined && typeof recursive !== "boolean") refuse("filesystem mkdir recursive must be a boolean");
          fs.mkdirSync(target, recursive === undefined ? {} : { recursive });
          return { kind: "empty" };
        }
        case "readdir": {
          const target = requireString((request as { path?: unknown }).path, "path");
          return { kind: "names", names: fs.readdirSync(target) };
        }
        case "stat": {
          const target = requireString((request as { path?: unknown }).path, "path");
          const stats = fs.statSync(target);
          return { kind: "stats", vfsKind: stats.kind, size: stats.size, modifiedAt: stats.modifiedAt, createdAt: stats.createdAt };
        }
        case "unlink": {
          fs.unlinkSync(requireString((request as { path?: unknown }).path, "path"));
          return { kind: "empty" };
        }
        case "rmdir": {
          fs.rmdirSync(requireString((request as { path?: unknown }).path, "path"));
          return { kind: "empty" };
        }
        case "rename": {
          const { from, to } = request as { from?: unknown; to?: unknown };
          fs.renameSync(requireString(from, "from"), requireString(to, "to"));
          return { kind: "empty" };
        }
        case "watch": {
          const { path, recursive } = request as { path?: unknown; recursive?: unknown };
          const target = requireString(path, "path");
          if (recursive !== undefined && typeof recursive !== "boolean") {
            refuse('filesystem watch "recursive" must be a boolean when present');
          }
          const registry = requireWatches();
          const owner = requireOwner();
          return { kind: "watch", watchId: registry.watch({ owner, path: target, ...(recursive === true ? { recursive: true } : {}) }) };
        }
        case "unwatch": {
          const { watchId } = request as { watchId?: unknown };
          if (typeof watchId !== "number" || !Number.isInteger(watchId)) {
            refuse('filesystem request field "watchId" must be an integer');
          }
          requireWatches().unwatch(requireOwner(), watchId);
          return { kind: "empty" };
        }
        case "poll": {
          const { watchId } = request as { watchId?: unknown };
          if (typeof watchId !== "number" || !Number.isInteger(watchId)) {
            refuse('filesystem request field "watchId" must be an integer');
          }
          const result = requireWatches().poll(requireOwner(), watchId);
          return { kind: "events", events: result.events, dropped: result.dropped };
        }
        default:
          return refuse(`unknown filesystem operation "${op}"`, "EINVAL");
      }
    } catch (error) {
      if (error instanceof FileSystemSyscallError) throw error;
      throw new FileSystemSyscallError(
        error instanceof Error ? error.message : String(error),
        codeForError(error),
      );
    }
  };
}
