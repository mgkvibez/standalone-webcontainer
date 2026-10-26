/**
 * memfs conformance oracle (ADR-0003, expert ruling Oct 26).
 *
 * memfs is a DEV dependency and appears ONLY in this file: identical
 * operation sequences run against both memfs and our fs shim (backed
 * by the ADR-0002 VFS), and results — including exact POSIX error
 * codes — must match. This catches Node API drift mechanically.
 */
import { describe, expect, it } from "vitest";
import { Volume } from "memfs";
import { FileSystem } from "../../src/vfs/index.js";
import {
  createFsShim,
  SyncNotSupportedError,
} from "../../src/shims/fs.js";
import { SyscallKernel, SyscallClient } from "../../src/runtime/envelope.js";

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string };

/** Run a call and capture either its value or the error's code. */
async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? "ENOCODE" };
  }
}

/** Compare our string|Uint8Array read result with memfs's string|Buffer. */
function normalizeRead(value: unknown): string | number[] {
  if (typeof value === "string") return value;
  const bytes = value as Uint8Array | { toString(encoding: string): string };
  if (bytes instanceof Uint8Array) return Array.from(bytes);
  return Array.from(new Uint8Array((bytes as Buffer).buffer ?? []));
}

function bytes(value: unknown): number[] {
  if (value instanceof Uint8Array) return Array.from(value);
  return Array.from(new Uint8Array((value as Buffer)));
}

describe("fs conformance oracle (memfs = reference, our shim = candidate)", () => {
  // Fresh isolated instances per case (charter: isolated fresh fixtures).
  async function fresh() {
    const oracle = new Volume().promises;
    const ours = createFsShim(new FileSystem());
    return { oracle, ours };
  }

  it("writeFile -> readFile(utf8) round trip matches", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.writeFile("/a.txt", "hello world");
      expect((await fs.readFile("/a.txt", "utf8")) as string).toBe(
        "hello world",
      );
    }
  });

  it("writeFile -> readFile(encoding object) round trip matches", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.writeFile("/a.txt", "obj form");
      expect(
        (await fs.readFile("/a.txt", { encoding: "utf8" })) as string,
      ).toBe("obj form");
    }
  });

  it("binary round trip: byte contents match exactly", async () => {
    const { oracle, ours } = await fresh();
    await oracle.writeFile("/b.bin", Buffer.from([1, 2, 3, 250]));
    await ours.writeFile("/b.bin", new Uint8Array([1, 2, 3, 250]));
    expect(bytes(normalizeRead(await oracle.readFile("/b.bin")))).toEqual([
      1, 2, 3, 250,
    ]);
    expect(Array.from((await ours.readFile("/b.bin")) as Uint8Array)).toEqual([
      1, 2, 3, 250,
    ]);
  });

  it("readFile of a missing file: ENOENT on both", async () => {
    const { oracle, ours } = await fresh();
    const a = await outcome(() => oracle.readFile("/missing.txt", "utf8"));
    const b = await outcome(() => ours.readFile("/missing.txt", "utf8"));
    expect(a).toEqual({ ok: false, code: "ENOENT" });
    expect(b).toEqual(a);
  });

  it("writeFile onto a directory: EISDIR on both", async () => {
    const { oracle, ours } = await fresh();
    await oracle.mkdir("/d");
    await ours.mkdir("/d");
    const a = await outcome(() => oracle.writeFile("/d", "x"));
    const b = await outcome(() => ours.writeFile("/d", "x"));
    expect(a).toEqual({ ok: false, code: "EISDIR" });
    expect(b).toEqual(a);
  });

  it("mkdir -> readdir: sorted listing matches", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.mkdir("/d");
      await fs.writeFile("/d/z.txt", "1");
      await fs.writeFile("/d/a.txt", "2");
      const names = (await fs.readdir("/d")) as string[];
      expect([...names].sort()).toEqual(["a.txt", "z.txt"]);
    }
  });

  it("mkdir over an existing directory: EEXIST on both", async () => {
    const { oracle, ours } = await fresh();
    await oracle.mkdir("/d");
    await ours.mkdir("/d");
    const a = await outcome(() => oracle.mkdir("/d"));
    const b = await outcome(() => ours.mkdir("/d"));
    expect(a).toEqual({ ok: false, code: "EEXIST" });
    expect(b).toEqual(a);
  });

  it("mkdir with a missing parent (non-recursive): ENOENT on both", async () => {
    const { oracle, ours } = await fresh();
    const a = await outcome(() => oracle.mkdir("/nope/child"));
    const b = await outcome(() => ours.mkdir("/nope/child"));
    expect(a).toEqual({ ok: false, code: "ENOENT" });
    expect(b).toEqual(a);
  });

  it("stat on a file: classification and size match", async () => {
    const { oracle, ours } = await fresh();
    await oracle.writeFile("/f.txt", "12345");
    await ours.writeFile("/f.txt", "12345");
    const a = (await oracle.stat("/f.txt")) as {
      size: number;
      isFile(): boolean;
      isDirectory(): boolean;
    };
    const b = await ours.stat("/f.txt");
    expect(b.isFile()).toBe(a.isFile());
    expect(b.isDirectory()).toBe(a.isDirectory());
    expect(b.size).toBe(a.size);
  });

  it("stat on a directory: classification matches", async () => {
    const { oracle, ours } = await fresh();
    await oracle.mkdir("/d");
    await ours.mkdir("/d");
    const a = (await oracle.stat("/d")) as {
      isFile(): boolean;
      isDirectory(): boolean;
    };
    const b = await ours.stat("/d");
    expect(b.isFile()).toBe(a.isFile());
    expect(b.isDirectory()).toBe(a.isDirectory());
  });

  it("stat of a missing path: ENOENT on both", async () => {
    const { oracle, ours } = await fresh();
    const a = await outcome(() => oracle.stat("/missing"));
    const b = await outcome(() => ours.stat("/missing"));
    expect(a).toEqual({ ok: false, code: "ENOENT" });
    expect(b).toEqual(a);
  });

  it("unlink: removes files; ENOENT when missing (both)", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.writeFile("/victim.txt", "x");
      await fs.unlink("/victim.txt");
      expect(await outcome(() => fs.readFile("/victim.txt", "utf8"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
      expect(await outcome(() => fs.unlink("/missing.txt"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
    }
  });

  it("unlink on a directory: our code matches the oracle exactly (EPERM)", async () => {
    const { oracle, ours } = await fresh();
    await oracle.mkdir("/dir");
    await ours.mkdir("/dir");
    const a = await outcome(() => oracle.unlink("/dir"));
    // The oracle captured here IS the expectation (first drift catch:
    // memfs reports EPERM, not POSIX EISDIR).
    expect(a).toEqual({ ok: false, code: "EPERM" });
    expect(await outcome(() => ours.unlink("/dir"))).toEqual(a);
  });

  it("rename: content moves; source gone; ENOENT when source missing (both)", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.writeFile("/src.txt", "payload");
      await fs.rename("/src.txt", "/dst.txt");
      expect(await outcome(() => fs.readFile("/src.txt", "utf8"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
      expect((await fs.readFile("/dst.txt", "utf8")) as string).toBe("payload");
      expect(await outcome(() => fs.rename("/ghost", "/any"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
    }
  });

  it("rmdir: empty succeeds; ENOTEMPTY when non-empty; ENOTDIR on a file; ENOENT when missing (both)", async () => {
    const { oracle, ours } = await fresh();
    for (const fs of [oracle, ours] as const) {
      await fs.mkdir("/empty");
      await fs.rmdir("/empty");
      expect(await outcome(() => fs.stat("/empty"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
      await fs.mkdir("/full");
      await fs.writeFile("/full/keep.txt", "x");
      expect(await outcome(() => fs.rmdir("/full"))).toEqual({
        ok: false,
        code: "ENOTEMPTY",
      });
      await fs.writeFile("/plain.txt", "x");
      expect(await outcome(() => fs.rmdir("/plain.txt"))).toEqual({
        ok: false,
        code: "ENOTDIR",
      });
      expect(await outcome(() => fs.rmdir("/ghost"))).toEqual({
        ok: false,
        code: "ENOENT",
      });
    }
  });

  it("readdir on a file: ENOTDIR on both", async () => {
    const { oracle, ours } = await fresh();
    await oracle.writeFile("/f.txt", "x");
    await ours.writeFile("/f.txt", "x");
    const a = await outcome(() => oracle.readdir("/f.txt"));
    const b = await outcome(() => ours.readdir("/f.txt"));
    expect(a).toEqual({ ok: false, code: "ENOTDIR" });
    expect(b).toEqual(a);
  });
});

describe("fs shim sync contract (ESYNCNOTSUPPORTED, expert phased ruling)", () => {
  it("every sync method throws SyncNotSupportedError synchronously", () => {
    const fs = createFsShim(new FileSystem());
    const ops = [
      () => fs.readFileSync("/a"),
      () => fs.writeFileSync("/a", "x"),
      () => fs.mkdirSync("/a"),
      () => fs.readdirSync("/a"),
      () => fs.statSync("/a"),
      () => fs.unlinkSync("/a"),
      () => fs.renameSync("/a", "/b"),
      () => fs.rmdirSync("/a"),
    ] as const;
    expect(ops).toHaveLength(8);
    for (const op of ops) {
      // Synchronous throw (not a rejected promise) is the contract.
      let caught: unknown;
      try {
        op();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SyncNotSupportedError);
      expect((caught as SyncNotSupportedError).code).toBe(
        "ESYNCNOTSUPPORTED",
      );
    }
  });

  it("sync calls across the envelope rehydrate with the same code", async () => {
    const fs = createFsShim(new FileSystem());
    const kernel = new SyscallKernel();
    kernel.register("fs.readFileSync", (...args: unknown[]) =>
      (fs.readFileSync(args[0] as string, undefined) as string).length,
    );
    const client = new SyscallClient((request) => {
      void kernel.handle(request).then((response) =>
        client.handleResponse(response),
      );
    });
    // The kernel serializes the SyncNotSupportedError into a POSIX-style
    // cloneable record; the client rehydrates it typed, code intact.
    await expect(client.call("fs.readFileSync", "/a.txt")).rejects.toMatchObject(
      { code: "ESYNCNOTSUPPORTED" },
    );
  });

  it("async fs ops run through the Typed Envelope and match direct VFS results", async () => {
    const fs = createFsShim(new FileSystem());
    const kernel = new SyscallKernel();
    kernel.register("fs.writeFile", (...a: unknown[]) =>
      fs.writeFile(a[0] as string, a[1] as string),
    );
    kernel.register("fs.readFile", (...a: unknown[]) =>
      fs.readFile(a[0] as string, "utf8"),
    );
    kernel.register("fs.stat", (...a: unknown[]) =>
      fs.stat(a[0] as string).then((st) => ({
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
      })),
    );
    const client = new SyscallClient((request) => {
      void kernel.handle(request).then((response) =>
        client.handleResponse(response),
      );
    });
    await client.call("fs.writeFile", "/env.txt", "via-envelope");
    expect(await client.call("fs.readFile", "/env.txt")).toBe("via-envelope");
    const st = (await client.call("fs.stat", "/env.txt")) as {
      isFile: boolean;
      size: number;
    };
    expect(st.isFile).toBe(true);
    expect(st.size).toBe(12);
  });

  it("async fs errors cross the envelope rehydrated with POSIX codes", async () => {
    const fs = createFsShim(new FileSystem());
    const kernel = new SyscallKernel();
    kernel.register("fs.readFile", (...a: unknown[]) =>
      fs.readFile(a[0] as string, "utf8"),
    );
    const client = new SyscallClient((request) => {
      void kernel.handle(request).then((response) =>
        client.handleResponse(response),
      );
    });
    await expect(client.call("fs.readFile", "/missing.txt")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
