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
import { decodeBase64, encodeBase64 } from "./base64.js";

export type FsRequest =
  | { readonly op: "read"; readonly path: string; readonly encoding?: "utf8" }
  | {
      readonly op: "write";
      readonly path: string;
      readonly data: string;
      readonly dataEncoding: "utf8" | "base64";
      readonly mode?: number;
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
  | { readonly kind: "bytes"; readonly base64: string }
  | { readonly kind: "names"; readonly names: readonly string[] }
  | {
      readonly kind: "stats";
      readonly vfsKind: "file" | "dir";
      readonly size: number;
      readonly modifiedAt: number;
      readonly createdAt: number;
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

export function createFsSyscallHandler(fs: FileSystemPort): (request: unknown) => FsResponse {
  return (request: unknown): FsResponse => {
    if (typeof request !== "object" || request === null) refuse("filesystem request must be an object");
    const { op } = request as { op?: unknown };
    if (typeof op !== "string") refuse("filesystem request must name an operation");

    try {
      switch (op) {
        case "read": {
          const { path, encoding } = request as { path?: unknown; encoding?: unknown };
          const target = requireString(path, "path");
          if (encoding === "utf8") {
            return { kind: "text", text: fs.readFileSync(target, "utf8") as string };
          }
          if (encoding !== undefined) refuse('filesystem read encoding must be "utf8" or absent');
          const bytes = fs.readFileSync(target) as Uint8Array;
          return { kind: "bytes", base64: encodeBase64(bytes) };
        }
        case "write": {
          const { path, data, dataEncoding, evictable } = request as {
            path?: unknown;
            data?: unknown;
            dataEncoding?: unknown;
            evictable?: unknown;
          };
          const target = requireString(path, "path");
          if (typeof data !== "string") refuse("filesystem write data must be a string");
          if (dataEncoding !== "utf8" && dataEncoding !== "base64") refuse("filesystem write dataEncoding must be utf8 or base64");
          if (evictable !== undefined && typeof evictable !== "boolean") refuse("filesystem write evictable must be a boolean");
          const payload: string | Uint8Array = dataEncoding === "utf8" ? data : decodeBase64(data);
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
