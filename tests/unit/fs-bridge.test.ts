/**
 * The filesystem bridge, both halves, without Workers.
 *
 * The transport here mirrors the channel's envelope exactly (`{ ok, value }` / rejection carrying a code), so what is
 * under test is the bridge: argument encoding, byte fidelity, and the fact that the kernel refuses malformed requests
 * *before* they reach the VFS. The channel itself is tested separately, with real Workers.
 */

import { describe, expect, it } from "vitest";
import { FileSystem } from "../../src/vfs/index.js";
import { createFsSyscallHandler, FileSystemSyscallError, type FsResponse } from "../../src/process/fs-syscalls.js";
import { createRemoteFileSystem, DEFAULT_SYSCALL_TIMEOUT_MS, type SyscallTransport } from "../../src/process/remote-fs.js";

/** Stands in for the channel: same envelope, same code-preserving rejection, no Atomics. */
const transportOver = (fs: FileSystem): SyscallTransport => {
  const handler = createFsSyscallHandler(fs);
  return {
    call(request: unknown): FsResponse {
      try {
        return handler(request);
      } catch (error) {
        const rejection = error as FileSystemSyscallError;
        throw Object.assign(new Error(rejection.message), { code: rejection.code, name: "SyscallRejectedError" });
      }
    },
  };
};

/** The VFS has no `existsSync`; the shim synthesises it from a stat, so the test does the same. */
const existsIn = (fs: FileSystem, path: string): boolean => {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
};

const bridge = (): { fs: FileSystem; remote: ReturnType<typeof createRemoteFileSystem> } => {
  const fs = new FileSystem();
  return { fs, remote: createRemoteFileSystem(transportOver(fs)) };
};

describe("filesystem bridge", () => {
  it("reads text back through the wire", () => {
    const { fs, remote } = bridge();
    fs.writeFileSync("/hello.txt", "hello wire");
    expect(remote.readFileSync("/hello.txt", "utf8")).toBe("hello wire");
  });

  it("round-trips every byte value, so binary is not quietly mangled by base64", () => {
    const { fs, remote } = bridge();
    const original = Uint8Array.from({ length: 256 }, (_unused, index) => index);
    remote.writeFileSync("/blob.bin", original);
    expect([...fs.readFileSync("/blob.bin")]).toEqual([...original]);
    expect([...remote.readFileSync("/blob.bin")]).toEqual([...original]);
  });

  it("survives a payload larger than one base64 chunk", () => {
    const { remote } = bridge();
    const big = new Uint8Array(20_000).fill(7);
    remote.writeFileSync("/big.bin", big);
    const read = remote.readFileSync("/big.bin") as Uint8Array;
    expect(read.length).toBe(20_000);
    expect(read[19_999]).toBe(7);
  });

  it("reports stats in the VFS's own shape, so the shim adapter stays unchanged", () => {
    const { fs, remote } = bridge();
    fs.writeFileSync("/f.txt", "abc");
    fs.mkdirSync("/d");
    const file = remote.statSync("/f.txt");
    expect(file.kind).toBe("file");
    expect(file.size).toBe(3);
    expect(typeof file.modifiedAt).toBe("number");
    expect(remote.statSync("/d").kind).toBe("dir");
  });

  it("keeps ENOENT as ENOENT, because user code branches on it", () => {
    const { remote } = bridge();
    const failure = ((): unknown => {
      try {
        remote.readFileSync("/missing.txt", "utf8");
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect((failure as { code?: string })?.code).toBe("ENOENT");
  });

  it("carries mkdir, readdir, rename, unlink and rmdir", () => {
    const { fs, remote } = bridge();
    remote.mkdirSync("/nested", { recursive: true });
    remote.writeFileSync("/nested/a.txt", "one");
    remote.renameSync("/nested/a.txt", "/nested/b.txt");
    expect(remote.readdirSync("/nested")).toEqual(["b.txt"]);
    expect(existsIn(fs, "/nested/b.txt")).toBe(true);
    remote.unlinkSync("/nested/b.txt");
    expect(existsIn(fs, "/nested/b.txt")).toBe(false);
    remote.rmdirSync("/nested");
    expect(remote.readdirSync("/")).not.toContain("nested");
  });

  it("refuses malformed requests before they reach the filesystem", () => {
    const handler = createFsSyscallHandler(new FileSystem());
    const codeOf = (request: unknown): string => {
      try {
        handler(request);
        return "no-throw";
      } catch (error) {
        return (error as FileSystemSyscallError).code;
      }
    };

    expect(codeOf(null)).toBe("EINVAL");
    expect(codeOf("read")).toBe("EINVAL");
    expect(codeOf({})).toBe("EINVAL");
    expect(codeOf({ op: "chmod", path: "/x" })).toBe("EINVAL");
    expect(codeOf({ op: "read", path: 42 })).toBe("EINVAL");
    expect(codeOf({ op: "read", path: "" })).toBe("EINVAL");
    expect(codeOf({ op: "write", path: "/x", data: "x", dataEncoding: "morse" })).toBe("EINVAL");
    expect(codeOf({ op: "mkdir", path: "/x", recursive: "yes" })).toBe("EINVAL");
    expect(codeOf({ op: "rename", from: "/x" })).toBe("EINVAL");
  });

  it("serves the promise forms from the same wire, not a second implementation", async () => {
    const { fs, remote } = bridge();
    fs.writeFileSync("/p.txt", "promised");
    await expect(remote.readFile("/p.txt", "utf8")).resolves.toBe("promised");
    await remote.writeFile("/p2.txt", "written");
    await expect(remote.readFile("/p2.txt", "utf8")).resolves.toBe("written");
    await remote.mkdir("/pd");
    await expect(remote.readdir("/")).resolves.toContain("pd");
    await remote.unlink("/p2.txt");
    await expect(remote.readdir("/")).resolves.not.toContain("p2.txt");
  });
});

/**
 * The deadline contract.
 *
 * These exist because the fake transport above takes `(request)` — a structurally valid `SyscallTransport` — so it silently
 * dropped the second argument. The real client reads `options.timeoutMs` and threw `TypeError` on `undefined`, which meant a
 * port built without options worked in every unit test and failed on the first read in a browser. A double that accepts fewer
 * parameters than the interface hides exactly this class of bug.
 */
describe("every syscall carries a deadline", () => {
  const recording = (fs: FileSystem, seen: Array<number | undefined>): SyscallTransport => {
    const handler = createFsSyscallHandler(fs);
    return {
      call(request, options): FsResponse {
        seen.push(options?.timeoutMs);
        return handler(request);
      },
    };
  };

  it("defaults to a positive deadline when the caller chooses none", () => {
    const fs = new FileSystem();
    const seen: Array<number | undefined> = [];
    fs.writeFileSync("/a.txt", "a");
    const remote = createRemoteFileSystem(recording(fs, seen), {});
    expect(remote.readFileSync("/a.txt", "utf8")).toBe("a");
    expect(seen).toEqual([DEFAULT_SYSCALL_TIMEOUT_MS]);
    expect(DEFAULT_SYSCALL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("honours an explicit deadline", () => {
    const fs = new FileSystem();
    const seen: Array<number | undefined> = [];
    fs.writeFileSync("/a.txt", "a");
    const remote = createRemoteFileSystem(recording(fs, seen), { timeoutMs: 1234 });
    remote.readFileSync("/a.txt", "utf8");
    expect(seen).toEqual([1234]);
  });

  it("never hands the transport an undefined options object", () => {
    const fs = new FileSystem();
    fs.writeFileSync("/a.txt", "a");
    const strictHandler = createFsSyscallHandler(fs);
    // The real client's shape: it dereferences options.timeoutMs before doing anything, so undefined is a crash.
    const strict: SyscallTransport = {
      call(request, options): FsResponse {
        if (options === undefined) throw new TypeError("Cannot read properties of undefined (reading 'timeoutMs')");
        const deadline = options?.timeoutMs ?? 0;
        if (!(deadline > 0)) throw new RangeError("A syscall needs a positive deadline.");
        return strictHandler(request);
      },
    };
    const remote = createRemoteFileSystem(strict);
    expect(remote.readFileSync("/a.txt", "utf8")).toBe("a");
  });
});
