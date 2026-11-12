/**
 * The project mirror.
 *
 * This replaced the `RuntimeSupervisor` readback test. The behaviour it protects is the one that decides whether a program's output
 * survives: the page owns the durable snapshot, the kernel owns the live filesystem, and every command boundary diffs the two. Get it
 * wrong in one direction and a build's output vanishes at the next keystroke; get it wrong in the other and a file the user deleted
 * keeps being imported.
 */

import { describe, expect, it } from "vitest";

import { createProjectMirror, type MirrorTarget } from "../../src/process/project-mirror.js";
import { FileSystem } from "../../src/vfs/index.js";

const text = (decoder: TextDecoder, value: string | Uint8Array): string =>
  typeof value === "string" ? value : decoder.decode(value);

/** A target that records what was done to it, so "nothing was written" can be asserted rather than inferred. */
function spyTarget(files: FileSystem) {
  const writes: string[] = [];
  const removals: string[] = [];
  const target: MirrorTarget = {
    readFile: (path) => {
      try {
        const value = files.readFileSync(path);
        return typeof value === "string" ? value : new TextDecoder().decode(value);
      } catch {
        return null;
      }
    },
    writeFile: (path, contents) => {
      writes.push(path);
      const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (parent !== "") files.mkdirSync(parent, { recursive: true });
      files.writeFileSync(path, contents);
    },
    unlink: (path) => {
      removals.push(path);
      files.unlinkSync(path);
    },
  };
  return { target, writes, removals };
}

describe("createProjectMirror", () => {
  it("writes the snapshot into an empty target", () => {
    const files = new FileSystem();
    const { target, writes } = spyTarget(files);
    createProjectMirror().sync(target, { "/index.js": "console.log(1)", "/src/a.js": "export default 1" });

    expect(writes.sort()).toEqual(["/index.js", "/src/a.js"]);
    expect(text(new TextDecoder(), files.readFileSync("/src/a.js"))).toBe("export default 1");
  });

  it("skips a text file whose contents already match, so a rebuild does not rewrite the whole project", () => {
    const files = new FileSystem();
    const { target, writes } = spyTarget(files);
    const mirror = createProjectMirror();
    const snapshot = { "/index.js": "console.log(1)" };

    mirror.sync(target, snapshot);
    writes.length = 0;
    mirror.sync(target, snapshot);

    expect(writes).toEqual([]);
  });

  it("writes a changed file", () => {
    const files = new FileSystem();
    const { target, writes } = spyTarget(files);
    const mirror = createProjectMirror();

    mirror.sync(target, { "/index.js": "one" });
    writes.length = 0;
    mirror.sync(target, { "/index.js": "two" });

    expect(writes).toEqual(["/index.js"]);
    expect(text(new TextDecoder(), files.readFileSync("/index.js"))).toBe("two");
  });

  it("removes a file the page deleted, because the code on disk must be the code in the editor", () => {
    const files = new FileSystem();
    const { target, removals } = spyTarget(files);
    const mirror = createProjectMirror();

    mirror.sync(target, { "/keep.js": "k", "/drop.js": "d" });
    mirror.sync(target, { "/keep.js": "k" });

    expect(removals).toEqual(["/drop.js"]);
    expect(() => files.readFileSync("/drop.js")).toThrow();
  });

  it("always writes a byte file, because a decode is not an equality test", () => {
    const files = new FileSystem();
    const { target, writes } = spyTarget(files);
    const mirror = createProjectMirror();
    // Two different byte sequences that decode to the same replacement characters: comparing decoded text would call them equal.
    const first = new Uint8Array([0xff, 0xfe]);
    const second = new Uint8Array([0xff, 0xfd]);

    mirror.sync(target, { "/logo.png": first });
    writes.length = 0;
    mirror.sync(target, { "/logo.png": second });

    expect(writes).toEqual(["/logo.png"]);
  });

  it("keeps a file the program wrote and the page never knew about", () => {
    const files = new FileSystem();
    const { target, removals } = spyTarget(files);
    const mirror = createProjectMirror();

    mirror.sync(target, { "/index.js": "x" });
    files.writeFileSync("/out.txt", "written by the program");
    mirror.sync(target, { "/index.js": "x" });

    expect(removals).toEqual([]);
    expect(text(new TextDecoder(), files.readFileSync("/out.txt"))).toBe("written by the program");
  });

  it("forgets what it mirrored on reset, and that means forgetting what to delete", () => {
    const files = new FileSystem();
    const { target, removals } = spyTarget(files);
    const mirror = createProjectMirror();

    mirror.sync(target, { "/index.js": "x" });
    expect(mirror.paths()).toEqual(["/index.js"]);
    mirror.reset();
    expect(mirror.paths()).toEqual([]);

    // The next sync does not know `/index.js` was ever mirrored, so it does not delete it. That is the correct behaviour for a REPLACED
    // target: the old target is gone with its files, and issuing deletes for paths a new target never had would be guessing.
    mirror.sync(target, { "/other.js": "y" });
    expect(removals).toEqual([]);
    expect(text(new TextDecoder(), files.readFileSync("/index.js"))).toBe("x");
  });
});
