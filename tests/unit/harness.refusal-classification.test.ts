/**
 * A refusal is classified from the container's decision, never from what a step printed.
 *
 * Since 2026-11-10 the fixture CLI has run its steps through the product's `Container`, and the adapter that connects them
 * returned only `"ok"` or `"harness-fault"`. Two outcomes became unreachable with it: the by-design refusal ADR-0014 defines
 * (`unsupported`, carrying a runtime `Refusal`) and the policy boundary ADR-0010 amendment 2 defines (`restricted`, carrying a
 * `Restriction`). A policy refusal reached a verdict as an ordinary exit 1, which is honest but loses the distinction the gate
 * depends on: our unfinished work and a decision the product made on purpose both read as "the runtime could not run it".
 *
 * The fix is one mapping, and this file is the proof of both directions:
 *
 * - a real decline is classified as the boundary or the refusal it is, with its record intact;
 * - nothing else is. A crash, a missing dependency, an unimplemented manager, a syntax error, and a program that PRINTS a
 *   refusal's sentence are all ordinary failures. The last one is why the mapping reads the container's outcome instead of the
 *   scrollback: evidence a step can write for itself is not evidence about the runtime.
 */

import { describe, expect, it } from "vitest";

import { Container } from "../../src/container/container.js";
import { parseDefinition, type FixtureDefinition } from "../../src/harness/definition.js";
import { runDefinition, MapFiles } from "../../tools/harness/fixture-executor.js";
import { InProcessClient } from "../../tools/harness/in-process-client.js";
import { createFakeRegistry } from "../helpers/registry.js";
import { testProvenance } from "../helpers/provenance.js";

/** A container over an in-process runtime and the given project files, with an empty registry. */
const containerWith = async (files: Record<string, string>) => {
  const container = new Container({
    runtime: new InProcessClient(),
    files: new MapFiles(files),
    registry: await createFakeRegistry({ packages: {} }),
  });
  return { container, session: container.createSession("probe") };
};

const run = async (definition: FixtureDefinition) =>
  runDefinition(definition, await createFakeRegistry({ packages: {} }), null as never, testProvenance());

/** The smallest valid definition: one step, one assertion, and whatever the case declared as expected. */
const oneStep = (
  command: string,
  options: {
    files?: Record<string, string>;
    assertions?: FixtureDefinition["assertions"];
    expected?: FixtureDefinition["expected"];
    id?: number;
  } = {},
): FixtureDefinition =>
  parseDefinition({
    formatVersion: 1,
    id: options.id ?? 20,
    slug: `fixture-${String(options.id ?? 20).padStart(2, "0")}`,
    lane: "front-end-only",
    title: "one step",
    intent: "Classification of a single step.",
    source: "harness integration test",
    status: "frozen",
    ...(options.files === undefined ? {} : { files: options.files }),
    steps: [{ kind: "run", command, timeoutClass: "run", purpose: "the step under test" }],
    assertions: options.assertions ?? [{ kind: "exit-code", step: 0, equals: 0 }],
    expected: options.expected ?? ["PASS", "RUNTIME_INCOMPATIBILITY"],
  });

describe("the container's own decision", () => {
  it("names the closed command set as a boundary, with a policy, a reason and an alternative", async () => {
    const { container, session } = await containerWith({});
    const outcome = await container.execute(session.id, "cargo --version");

    expect(outcome.exitCode).toBe(1);
    expect(outcome.blocked?.kind).toBe("unsupported");
    expect(outcome.blocked?.name).toBe("cargo");
    expect(outcome.blocked?.boundary?.policy).toBe("closed-command-set");
    // A verdict quotes all four fields, so an empty one here would become a shrug three layers up.
    expect(outcome.blocked?.boundary?.reason).not.toBe("");
    expect(outcome.blocked?.boundary?.alternative).toContain("help");
  });

  it("does not call a malformed line a policy, because a stray quote is not a decision", async () => {
    const { container, session } = await containerWith({});
    const outcome = await container.execute(session.id, 'echo "unbalanced');

    expect(outcome.exitCode).toBe(1);
    expect(outcome.blocked?.kind).toBe("unsupported");
    expect(outcome.blocked?.boundary).toBeUndefined();
  });

  it("reports a manager it has not implemented as a failure, with no boundary claimed", async () => {
    const { container, session } = await containerWith({});
    const outcome = await container.execute(session.id, "pnpm install");

    expect(outcome.exitCode).toBe(1);
    expect(outcome.blocked?.kind).toBe("refused");
    expect(outcome.blocked?.boundary).toBeUndefined();
    // The sentence a user reads must describe the product, not a phase of the plan that shipped long ago.
    expect(outcome.blocked?.reason).not.toMatch(/P1b/);
  });

  it("leaves an ordinary failure unclassified: no block, no refusal", async () => {
    const { container, session } = await containerWith({});
    const outcome = await container.execute(session.id, "ls /nowhere");

    expect(outcome.exitCode).toBe(1);
    expect(outcome.blocked).toBeUndefined();
    expect(outcome.refusal).toBeUndefined();
  });

  it("reports a successful line as exit 0 with nothing attached", async () => {
    const { container, session } = await containerWith({});
    const outcome = await container.execute(session.id, "echo hi");

    expect(outcome).toEqual({ exitCode: 0 });
  });

  it("carries a runtime refusal by reference, frozen, out of the program that hit it", async () => {
    const { container, session } = await containerWith({
      "/main.js": 'require("./addon.node")',
      "/addon.node": "not javascript",
    });
    const outcome = await container.execute(session.id, "node main.js");

    expect(outcome.exitCode).toBe(1);
    expect(outcome.refusal?.code).toBe("native-addon");
    expect(outcome.refusal?.capability).toBe("native addon");
    expect(outcome.refusal?.subject).toBe("/addon.node");
    // ADR-0014 D-10: evidence that can still be mutated is not evidence.
    expect(Object.isFrozen(outcome.refusal)).toBe(true);
  });
});

describe("a policy boundary reaches the verdict", () => {
  it("classifies a command outside the closed set as UNSUPPORTED_BY_DESIGN, and says which policy", async () => {
    const report = await run(oneStep("cargo install ripgrep", { expected: ["UNSUPPORTED_BY_DESIGN"] }));

    expect(report.steps[0]?.termination).toBe("restricted");
    expect(report.steps[0]?.restriction?.policy).toBe("closed-command-set");
    expect(report.steps[0]?.restriction?.operation).toBe("cargo");
    // The refusing step keeps its evidence, so a reader can see the status the line left behind.
    expect(report.steps[0]?.record?.exitCode).toBe(1);
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.reason).toContain("closed-command-set");
  });
});

describe("nothing else reaches that verdict", () => {
  it("a program that PRINTS a refusal's sentence is still an ordinary failure", async () => {
    // The text is deliberately verbatim what a policy refusal says. If the mapping read stderr, this would score by design.
    const report = await run(
      oneStep("node spoof.js", {
        files: {
          "spoof.js":
            'console.error("no shell to spawn: this terminal interprets a fixed command set itself."); process.exit(1);',
        },
        assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
        expected: ["UNSUPPORTED_BY_DESIGN", "RUNTIME_INCOMPATIBILITY"],
      }),
    );

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.restriction).toBeUndefined();
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
  });

  it("an unimplemented package manager is a failure, not a decision the product never made", async () => {
    const report = await run(oneStep("pnpm install", { expected: ["PASS", "RUNTIME_INCOMPATIBILITY"] }));

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.restriction).toBeUndefined();
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
  });

  it("a malformed line is a user mistake, not a boundary", async () => {
    const report = await run(oneStep('echo "unbalanced', { expected: ["PASS", "RUNTIME_INCOMPATIBILITY"] }));

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.restriction).toBeUndefined();
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
  });

  it("a missing package is an install failure, not a boundary", async () => {
    const report = await run(
      parseDefinition({
        formatVersion: 1,
        id: 19,
        slug: "fixture-19",
        lane: "front-end-only",
        title: "a dependency the registry does not have",
        intent: "A missing package is a failure of the step, not a policy.",
        source: "harness integration test",
        status: "frozen",
        files: { "package.json": JSON.stringify({ name: "app", version: "0.0.0", dependencies: { ghost: "^1.0.0" } }) },
        steps: [
          { kind: "install", command: "npm install", timeoutClass: "install", purpose: "install a package that does not exist" },
        ],
        assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
        expected: ["PASS", "RUNTIME_INCOMPATIBILITY"],
      }),
    );

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.restriction).toBeUndefined();
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
  });

  it("a crash is a failure of the program, not a refusal and not a harness bug", async () => {
    const report = await run(
      oneStep("node boom.js", {
        files: { "boom.js": 'throw new Error("boom");' },
        assertions: [{ kind: "exit-code", step: 0, equals: 0 }],
        expected: ["PASS", "RUNTIME_INCOMPATIBILITY"],
      }),
    );

    expect(report.steps[0]?.termination).toBe("ok");
    expect(report.steps[0]?.refusal).toBeUndefined();
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
  });
});

describe("a runtime refusal reaches the verdict", () => {
  const addon = (expected: FixtureDefinition["expected"]) =>
    parseDefinition({
      formatVersion: 1,
      id: 16,
      slug: "fixture-16",
      lane: "boundary",
      title: "a native addon is refused on purpose",
      intent: "The runtime declines a capability it does not provide, with evidence a fixture can assert on.",
      source: "harness integration test",
      status: "frozen",
      files: { "require-native.js": 'require("./addon.node")', "addon.node": "not javascript" },
      steps: [{ kind: "run", command: "node require-native.js", timeoutClass: "run", purpose: "require a native addon" }],
      assertions: [
        { kind: "exit-code", step: 0, equals: 1 },
        { kind: "stderr-contains", step: 0, contains: "native addon" },
      ],
      expected,
    });

  it("is UNSUPPORTED_BY_DESIGN when the fixture declared it and the step's evidence agrees", async () => {
    const report = await run(addon(["UNSUPPORTED_BY_DESIGN"]));

    expect(report.steps[0]?.termination).toBe("unsupported");
    expect(report.steps[0]?.refusal?.code).toBe("native-addon");
    expect(report.steps[0]?.record?.exitCode).toBe(1);
    expect(report.classification).toBe("UNSUPPORTED_BY_DESIGN");
    expect(report.reason).toContain("native addon (native-addon)");
  });

  it("is a runtime failure when the fixture did NOT declare it, because the bucket has to be earned", async () => {
    const report = await run(addon(["PASS", "RUNTIME_INCOMPATIBILITY"]));

    expect(report.steps[0]?.termination).toBe("unsupported");
    expect(report.classification).toBe("RUNTIME_INCOMPATIBILITY");
    expect(report.reason).toContain("undeclared");
  });
});
