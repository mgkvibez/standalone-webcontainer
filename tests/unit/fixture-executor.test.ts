/**
 * The fixture executor, exercised the way the harness uses it: a definition in, a verdict out.
 *
 * This is deliberately not a hand-written executor. The point of these tests is that the path a real fixture takes (container
 * dispatch, runtime, VFS readback, preview gateway) produces a PASS, so a passing fixture elsewhere means something.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadRegistry, runDefinition, type Registry } from "../../tools/harness/fixture-executor.js";
import type { FixtureDefinition } from "../../src/harness/definition.js";
import { testProvenance } from "../helpers/provenance.js";

const definition = (overrides: Partial<FixtureDefinition>): FixtureDefinition =>
  ({
    formatVersion: 1,
    id: 999,
    slug: "fixture-999-local",
    lane: "boundary",
    title: "local",
    intent: "local",
    source: "local",
    status: "proposed",
    steps: [],
    assertions: [],
    expected: ["PASS"],
    ...overrides,
  }) as FixtureDefinition;

describe("runFixture through the real container", () => {
  let registry: Registry;
  let evidenceRoot: string;

  beforeAll(async () => {
    registry = await loadRegistry();
    evidenceRoot = mkdtempSync(join(tmpdir(), "fixture-evidence-"));
  });

  it("passes a program that writes a file and starts a server, with all four assertion kinds", async () => {
    const report = await runDefinition(
      definition({
        steps: [
          { kind: "install", command: "npm install", timeoutClass: "install", purpose: "no dependencies" },
          { kind: "run", command: "node server.js", timeoutClass: "run", purpose: "serve and write" },
        ] as FixtureDefinition["steps"],
        files: {
          "package.json": `{"name":"local","private":true,"version":"0.0.0"}`,
          "server.js": [
            `const { writeFileSync } = require("fs");`,
            `writeFileSync("/report.txt", "written by the program");`,
            `require("http").createServer((request, response) => { response.end("served"); }).listen(4123);`,
            `console.log("listening");`,
          ].join("\n"),
        },
        assertions: [
          { kind: "exit-code", step: 1, equals: 0 },
          { kind: "stdout-contains", step: 1, contains: "listening" },
          { kind: "file-exists", step: 1, target: "report.txt" },
          { kind: "http-status", step: 1, target: "http://localhost:4123/", equals: 200 },
          { kind: "http-body-contains", step: 1, target: "http://localhost:4123/", contains: "served" },
        ],
      }),
      registry,
      evidenceRoot,
      testProvenance(),
    );

    expect(report.assertions.map((assertion) => `${assertion.kind}#${assertion.index} ${assertion.state}`)).toEqual([
      "exit-code#0 passed",
      "stdout-contains#1 passed",
      "file-exists#2 passed",
      "http-status#3 passed",
      "http-body-contains#4 passed",
    ]);
    expect(report.classification).toBe("PASS");
  }, 20_000);

  it("fails a file-exists assertion for a file no program wrote, so readback is not answering from the snapshot", async () => {
    const report = await runDefinition(
      definition({
        steps: [{ kind: "run", command: "node index.js", timeoutClass: "run", purpose: "write nothing" }] as FixtureDefinition["steps"],
        files: { "index.js": `console.log("nothing written");` },
        assertions: [{ kind: "file-exists", step: 0, target: "never.txt" }],
      }),
      registry,
      evidenceRoot,
      testProvenance(),
    );

    expect(report.assertions[0]?.state).toBe("failed");
    expect(report.classification).not.toBe("PASS");
  }, 20_000);

  it("reports a harness fault rather than a runtime verdict when the fixture asks for a remote host", async () => {
    const report = await runDefinition(
      definition({
        steps: [{ kind: "run", command: "node index.js", timeoutClass: "run", purpose: "no server" }] as FixtureDefinition["steps"],
        files: { "index.js": `console.log("ready");` },
        assertions: [{ kind: "http-status", step: 0, target: "http://example.com/", equals: 200 }],
      }),
      registry,
      evidenceRoot,
      testProvenance(),
    );

    expect(report.classification).toBe("HARNESS_BUG");
  }, 20_000);
});
