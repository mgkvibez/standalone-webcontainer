import { describe, expect, it } from "vitest";
import { Container } from "../../src/container/container.js";
import { InProcessClient } from "../../tools/harness/in-process-client.js";
import { MapFiles } from "../../tools/harness/fixture-executor.js";
import { createFakeRegistry } from "../helpers/registry.js";

/**
 * `npx`, as far as this container can honour it: run an installed binary, and refuse a fetch by name.
 *
 * Every fixture that compiles, transpiles or shells out to a toolchain reaches it through `npx` (12, 14, 03), so the difference between
 * an implemented `npx` and a refusal is the difference between three verdicts and three non-verdicts. The two behaviours worth pinning
 * are the ones that cost a real debugging round each:
 *
 * - the request names a BINARY, and a binary's name is not its package's (`tsc` lives in `typescript`), so resolving by package name
 *   refused a package that had just been installed;
 * - everything after the package name belongs to the PROGRAM, and collecting flags by pattern swallowed `tsc -p tsconfig.json`'s `-p`,
 *   leaving the compiler a bare path it read as a source file.
 */
const build = async (packages: Record<string, readonly { version: string; files?: Record<string, string> }[]>) => {
  const registry = await createFakeRegistry({ packages });
  // The project must DECLARE what it wants: `npm install` with no dependencies installs nothing, and a test that skipped this would be
  // asserting against an empty tree while believing it had installed one.
  const dependencies = Object.fromEntries(Object.keys(packages).map((name) => [name, "^1.0.0"]));
  const client = new InProcessClient();
  const container = new Container({
    runtime: client,
    files: new MapFiles({ "/package.json": JSON.stringify({ name: "probe", version: "0.0.0", dependencies }) }),
    registry,
  });
  const session = container.createSession("npx");
  return { container, session, take: () => session.scrollback.map((line) => line.text).join("") };
};

/** A package whose `bin` object maps a binary name to an entry file that prints its own argv. */
const withBin = (name: string, binary: string) => ({
  version: "1.0.0",
  files: {
    "package.json": JSON.stringify({ name, version: "1.0.0", bin: { [binary]: "./cli.js" } }),
    "cli.js": `console.log(${JSON.stringify(binary)} + " " + process.argv.slice(2).join(" "));`,
  },
});

describe("npx", () => {
  it("runs an installed package's binary, resolving the BINARY name rather than the package name", async () => {
    const { container, session, take } = await build({ toolchain: [withBin("toolchain", "tsc")] });
    await container.execute(session.id, "npm install");
    session.scrollback.length = 0;

    await container.execute(session.id, "npx tsc -p tsconfig.json");
    expect(container.lastExitCode).toBe(0);
    expect(take()).toContain("tsc -p tsconfig.json");
  });

  it("gives the program every argument after its name, flags included", async () => {
    const { container, session, take } = await build({ cowsay: [withBin("cowsay", "cowsay")] });
    await container.execute(session.id, "npm install");
    session.scrollback.length = 0;

    await container.execute(session.id, "npx --no-install cowsay --bold hello world");
    expect(container.lastExitCode).toBe(0);
    // npx's own flag is consumed; the program's flag and both words are not.
    // The transcript also echoes the typed command, so the assertion is about the line the PROGRAM printed.
    expect(take()).toContain("cowsay --bold hello world");
  });

  it("refuses a fetch by name, with the command that would work instead", async () => {
    const { container, session, take } = await build({});
    await container.execute(session.id, "npx --yes shadcn@latest add button");
    expect(container.lastExitCode).toBe(1);
    expect(take()).toContain("fetching a package in order to run it is not implemented");
    expect(take()).toContain("npm install shadcn@latest");
  });

  it("says a --no-install refusal is about the flag, not about the package", async () => {
    const { container, session, take } = await build({});
    await container.execute(session.id, "npx --no-install cowsay hello");
    expect(container.lastExitCode).toBe(1);
    expect(take()).toContain("--no-install forbids fetching one");
  });

  it("distinguishes an installed package that ships no such binary from a package that is not installed", async () => {
    const { container, session, take } = await build({
      plain: [
        {
          version: "1.0.0",
          files: { "package.json": JSON.stringify({ name: "plain", version: "2.0.0" }), "index.js": "module.exports = 1;" },
        },
      ],
    });
    await container.execute(session.id, "npm install");
    session.scrollback.length = 0;

    await container.execute(session.id, "npx plain");
    expect(container.lastExitCode).toBe(1);
    expect(take()).toContain("is installed but its package.json declares no");
  });

  it("asks for a binary when given none", async () => {
    const { container, session, take } = await build({});
    await container.execute(session.id, "npx");
    expect(container.lastExitCode).toBe(1);
    expect(take()).toContain("usage: npx <binary> [args...]");
  });
});
