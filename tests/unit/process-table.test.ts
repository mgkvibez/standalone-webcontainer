import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  ProcessLimitError,
  ProcessTable,
  UnknownProcessError,
  isTerminal,
} from "../../src/process/process-table.js";

/**
 * The process table is pure bookkeeping, and bookkeeping bugs are the ones that produce the worst symptoms: a killed
 * process appearing alive, a pid reused while its Worker still writes, `ps` disagreeing with reality. Every rule is
 * asserted here rather than discovered in a browser.
 */

const table = (maxProcesses = 8) => new ProcessTable<string>({ maxProcesses, now: () => 1000 });

describe("process table", () => {
  it("hands out sequential pids from 1 and records argv and a handle", () => {
    const processes = table();
    const first = processes.add({ argv: ["node", "index.js"], handle: "worker-a" });
    const second = processes.add({ argv: ["node", "b.js"], handle: "worker-b" });

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(processes.get(first)).toMatchObject({ pid: 1, argv: ["node", "index.js"], state: "running", startedAt: 1000 });
  });

  it("counts only queued and running processes as live", () => {
    const processes = table();
    const pid = processes.add({ argv: ["a"], handle: "w" });
    expect(processes.live()).toHaveLength(1);

    processes.transition(pid, "exited", { exitCode: 0 });

    expect(processes.live()).toHaveLength(0);
    expect(processes.all()).toHaveLength(1);
    expect(processes.get(pid).exitCode).toBe(0);
    expect(processes.get(pid).endedAt).toBe(1000);
  });

  it("refuses to revive a terminal process, which is how a pid gets reused while its Worker is still alive", () => {
    for (const terminal of ["exited", "failed", "killed"] as const) {
      const processes = table();
      const pid = processes.add({ argv: ["a"], handle: "w" });
      processes.transition(pid, terminal, { reason: "test" });

      expect(isTerminal(terminal)).toBe(true);
      expect(() => processes.transition(pid, "running")).toThrow(InvalidTransitionError);
    }
  });

  it("refuses a transition the table does not define", () => {
    const processes = table();
    const pid = processes.add({ argv: ["a"], handle: "w", state: "queued" });
    expect(() => processes.transition(pid, "exited")).toThrow(InvalidTransitionError);
    expect(() => processes.transition(pid, "running")).not.toThrow();
  });

  it("enforces the live-process limit rather than pretending the tab can hold anything", () => {
    const processes = table(2);
    processes.add({ argv: ["a"], handle: "w1" });
    processes.add({ argv: ["b"], handle: "w2" });

    expect(() => processes.add({ argv: ["c"], handle: "w3" })).toThrow(ProcessLimitError);
    // Finishing one frees a slot: the limit is on live processes, not on history.
    processes.transition(1, "exited", { exitCode: 0 });
    expect(() => processes.add({ argv: ["c"], handle: "w3" })).not.toThrow();
  });

  it("throws a typed error for an unknown pid instead of returning undefined", () => {
    expect(() => table().get(99)).toThrow(UnknownProcessError);
  });

  it("treats a repeated kill as a no-op, because kill is idempotent in a shell", () => {
    const processes = table();
    const pid = processes.add({ argv: ["a"], handle: "w" });

    expect(processes.kill(pid, "signal")).toBe(true);
    expect(processes.kill(pid, "signal")).toBe(false);
    expect(processes.get(pid)).toMatchObject({ state: "killed", reason: "signal" });
  });

  it("notifies on every change so a UI does not have to poll", () => {
    const seen: string[] = [];
    const processes = new ProcessTable<string>({ onChange: (entry) => seen.push(`${entry.pid}:${entry.state}`) });
    const pid = processes.add({ argv: ["a"], handle: "w" });
    processes.transition(pid, "exited", { exitCode: 0 });

    expect(seen).toEqual(["1:running", "1:exited"]);
  });
});
