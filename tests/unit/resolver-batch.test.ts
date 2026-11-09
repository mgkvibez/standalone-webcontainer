/**
 * Resolution asks its questions in one round trip.
 *
 * Node's resolver tries a candidate, then each extension guess, then the directory. Those probes are independent: the order
 * decides which one wins, not whether they can be asked together. In a Worker every probe used to be a wake-up, and a miss is
 * the common case, so a specifier that needed an extension cost three round trips for an answer that was one question away.
 *
 * What these tests guard is that the batching changed the number of questions and not the answers. The counting port records
 * what was asked and how, so "one round trip" is measured rather than assumed, and the fixtures cover the four shapes that
 * decide differently: exact file, extension guess, directory index, and package.json `main`.
 */

import { describe, expect, it } from "vitest";
import { CommonJsLoader, ModuleNotFoundError } from "../../src/runtime/commonjs.js";
import { createRemoteFileSystem } from "../../src/process/remote-fs.js";
import { createFsShim } from "../../src/shims/fs.js";
import { FileSystem } from "../../src/vfs/index.js";
import type { FileSystemPort, VfsStatsPort } from "../../src/vfs/port.js";

interface Probe {
  readonly kind: "one" | "many";
  readonly paths: readonly string[];
}

/**
 * A port that answers exactly like the VFS and records how it was asked.
 *
 * `statManySync` is implemented as "the same answers, one at a time" rather than delegating to the VFS, so the recorded
 * sequence is the caller's sequence and nothing is hidden behind the layer under test.
 */
const countingPort = (vfs: FileSystem): { port: FileSystemPort; probes: Probe[] } => {
  const probes: Probe[] = [];
  const port: FileSystemPort = {
    readFileSync: (path, encoding) => vfs.readFileSync(path, encoding),
    writeFileSync: (path, data, options) => vfs.writeFileSync(path, data, options),
    mkdirSync: (path, options) => vfs.mkdirSync(path, options),
    readdirSync: (path) => vfs.readdirSync(path),
    statSync: (path) => {
      probes.push({ kind: "one", paths: [path] });
      return vfs.statSync(path);
    },
    statManySync: (paths) => {
      probes.push({ kind: "many", paths: [...paths] });
      return paths.map((path): VfsStatsPort | null => {
        try {
          return vfs.statSync(path);
        } catch {
          return null;
        }
      });
    },
    unlinkSync: (path) => vfs.unlinkSync(path),
    rmdirSync: (path) => vfs.rmdirSync(path),
    renameSync: (from, to) => vfs.renameSync(from, to),
    readFile: async (path, encoding) => vfs.readFileSync(path, encoding),
    writeFile: async (path, data, options) => vfs.writeFileSync(path, data, options),
    mkdir: async (path, options) => vfs.mkdirSync(path, options),
    readdir: async (path) => vfs.readdirSync(path),
    unlink: async (path) => vfs.unlinkSync(path),
  };
  return { port, probes };
};

const loaderFor = (files: Readonly<Record<string, string>>): { loader: CommonJsLoader; probes: Probe[] } => {
  const vfs = new FileSystem();
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(path, contents);
  const { port, probes } = countingPort(vfs);
  return { loader: new CommonJsLoader({ fs: createFsShim(port), builtins: {} }), probes };
};

const statProbes = (probes: readonly Probe[]): readonly Probe[] => probes.filter((probe) => probe.paths.length > 0);

describe("the resolver asks its probes together", () => {
  it("finds a file that needs an extension, in one probe", () => {
    const { loader, probes } = loaderFor({ "/app/greet.js": "module.exports = 1;" });

    expect(loader.resolve("./greet", "/app")).toEqual({ kind: "file", path: "/app/greet.js" });

    // One round trip, and the candidates were asked in the documented order with the winner present.
    const asked = statProbes(probes);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe("many");
    // Four candidates plus the manifest probe that rides along for the directory branch: five entries, ONE round trip.
    expect(asked[0]?.paths).toEqual([
      "/app/greet",
      "/app/greet.js",
      "/app/greet.cjs",
      "/app/greet.json",
      // The manifest probed is the CANDIDATE's own, not the parent's: it is the directory branch's question.
      "/app/greet/package.json",
    ]);
  });

  it("prefers the exact file over its extension guesses", () => {
    const { loader } = loaderFor({ "/app/greet": "module.exports = 1;", "/app/greet.js": "module.exports = 2;" });

    // Order is the whole contract: the first hit in the probe list wins, even though both candidates exist.
    expect(loader.resolve("./greet", "/app")).toEqual({ kind: "file", path: "/app/greet" });
  });

  it("prefers .js over .json when both exist", () => {
    const { loader } = loaderFor({ "/app/data.js": "module.exports = 1;", "/app/data.json": "{}" });
    expect(loader.resolve("./data", "/app")).toEqual({ kind: "file", path: "/app/data.js" });
  });

  it("resolves a directory through index.js, in two probes", () => {
    const { loader, probes } = loaderFor({ "/app/pkg/index.js": "module.exports = 1;" });

    expect(loader.resolve("./pkg", "/app")).toEqual({ kind: "file", path: "/app/pkg/index.js" });

    // Two round trips, not five: the first answers the file candidates AND whether a manifest exists, the second answers the
    // index candidates. A resolution that needs the manifest does not pay a separate wake-up to discover it is there.
    const asked = statProbes(probes);
    expect(asked.filter((probe) => probe.kind === "many")).toHaveLength(2);
    expect(asked[0]?.paths).toEqual([
      "/app/pkg",
      "/app/pkg.js",
      "/app/pkg.cjs",
      "/app/pkg.json",
      "/app/pkg/package.json",
    ]);
    expect(asked[1]?.paths).toEqual(["/app/pkg/index.js", "/app/pkg/index.cjs", "/app/pkg/index.json"]);
  });

  it("still honours package.json main", () => {
    const { loader } = loaderFor({
      "/app/pkg/package.json": JSON.stringify({ main: "./lib/entry.js" }),
      "/app/pkg/lib/entry.js": "module.exports = 1;",
    });

    expect(loader.resolve("./pkg", "/app")).toEqual({ kind: "file", path: "/app/pkg/lib/entry.js" });
  });

  it("reports a miss as a miss, not as a batch failure", () => {
    const { loader } = loaderFor({ "/app/present.js": "module.exports = 1;" });

    // The probe list for this specifier is entirely absent: the batch answered with nulls and the resolver said so by name.
    expect(() => loader.resolve("./absent", "/app")).toThrow(ModuleNotFoundError);
  });

  it("walks node_modules for a bare specifier without asking any candidate twice", () => {
    const { loader, probes } = loaderFor({ "/app/node_modules/left/index.js": "module.exports = 1;" });

    expect(loader.resolve("left", "/app")).toEqual({ kind: "file", path: "/app/node_modules/left/index.js" });

    // The walk itself is still one probe per directory level: batching the candidates must not turn the search path into a
    // combinatorial product of every ancestor and every extension.
    const asked = statProbes(probes);
    const allPaths = asked.flatMap((probe) => [...probe.paths]);
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });
});

describe("the channel-backed port spends the batch, not the loop", () => {
  /** A transport that answers like the kernel and records which method the port chose. */
  const transportOver = (vfs: FileSystem): {
    transport: { call: (request: unknown, options?: { timeoutMs?: number }) => unknown; callMany?: (requests: readonly unknown[], options?: { timeoutMs?: number }) => readonly unknown[] };
    counts: { one: number; many: number };
  } => {
    const counts = { one: 0, many: 0 };
    const answer = (request: unknown): unknown => {
      const { op, path } = request as { op: string; path: string };
      if (op !== "stat") throw new Error(`unexpected op ${op}`);
      const stats = vfs.statSync(path);
      return { kind: "stats", vfsKind: stats.kind, size: stats.size, modifiedAt: stats.modifiedAt, createdAt: stats.createdAt };
    };
    const transport = {
      call: (request: unknown): unknown => {
        counts.one += 1;
        try {
          return answer(request);
        } catch (error) {
          throw Object.assign(new Error((error as Error).message), { code: (error as { code?: string }).code });
        }
      },
      callMany: (requests: readonly unknown[]): readonly unknown[] => {
        counts.many += 1;
        return requests.map((request) => {
          try {
            return { ok: true, value: answer(request) };
          } catch (error) {
            return { ok: false, error: { message: (error as Error).message, code: (error as { code?: string }).code } };
          }
        });
      },
    };
    return { transport, counts };
  };

  it("asks for the whole probe list in one batched call through the remote port", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/app/greet.js", "module.exports = 1;");
    const { transport, counts } = transportOver(vfs);
    const remote = createRemoteFileSystem(transport as never);
    const loader = new CommonJsLoader({ fs: createFsShim(remote), builtins: {} });

    expect(loader.resolve("./greet", "/app")).toEqual({ kind: "file", path: "/app/greet.js" });

    // This is the seam that makes batching real: the production port (process-worker.ts) is this one, over the SyscallClient.
    // If it ever stopped passing statManySync through, everything would still WORK and the round trips would quietly return.
    expect(counts.many).toBe(1);
    expect(counts.one).toBe(0);
  });

  it("falls back to one call at a time when the transport cannot batch", () => {
    const vfs = new FileSystem();
    vfs.writeFileSync("/app/greet.js", "module.exports = 1;");
    const { transport, counts } = transportOver(vfs);
    const single = { call: transport.call };
    const loader = new CommonJsLoader({ fs: createFsShim(createRemoteFileSystem(single as never)), builtins: {} });

    // No batch capability, same answers: a substrate that cannot batch is still a filesystem.
    expect(loader.resolve("./greet", "/app")).toEqual({ kind: "file", path: "/app/greet.js" });
    expect(counts.many).toBe(0);
    expect(counts.one).toBeGreaterThan(0);
  });
});
