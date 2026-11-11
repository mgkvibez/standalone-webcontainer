/**
 * `os` shim: the two members that are declared rather than observed, and the boundary where refusal is still the honest answer.
 *
 * Node defines `homedir()` and `tmpdir()` in terms of environment variables, so a runtime with its own environment can answer them
 * truthfully. Every rule pinned here was measured against node v20.20.2 first (see the table in the comments), because a shim that
 * "seems about right" is how a package ends up caching in the wrong place three weeks later.
 */

import { describe, expect, it } from "vitest";

import { VIRTUAL_ENVIRONMENT } from "../../src/runtime/environment.js";
import { createOsShim } from "../../src/shims/os.js";

const shimWith = (env: Readonly<Record<string, string>> = {}) => createOsShim({ platform: "browser", env });

describe("os.homedir", () => {
  it("is the environment's HOME, the only input Node's POSIX rule reads", () => {
    expect(shimWith({ HOME: "/root" }).homedir()).toBe("/root");
  });

  it("is the VM's declared home for a program that declares nothing, because the runtime supplies it", () => {
    // The shim itself defaults nothing: the runtime's process shim merges the VM environment under the caller's, and hands the SAME object
    // here. So the value a program sees is this one, and the test that proves it lives at the runtime level (see runtime.in-process).
    expect(VIRTUAL_ENVIRONMENT.HOME).toBe("/home/user");
    expect(shimWith(VIRTUAL_ENVIRONMENT).homedir()).toBe("/home/user");
  });

  it("refuses when HOME is unset, naming the fallback it cannot use", () => {
    // Node falls back to the password database here; this VM has none, so saying which fallback is missing is the whole answer.
    let caught: unknown;
    try {
      shimWith({ HOME: "" }).homedir();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "ERR_NOT_SUPPORTED" });
    expect((caught as Error).message).toContain("os.homedir() is not available");
    expect((caught as Error).message).toContain("HOME is not set in this environment");
    expect((caught as Error).message).toContain("password database");
  });
});

describe("os.tmpdir", () => {
  it("follows TMPDIR, then TMP, then TEMP, then /tmp, as Node does", () => {
    // Measured on v20.20.2: TMPDIR=/td TMP=/t TEMP=/te -> /td; TMP=/t TEMP=/te -> /t; TEMP=/te -> /te; none -> /tmp.
    expect(shimWith({ TMPDIR: "/td", TMP: "/t", TEMP: "/te" }).tmpdir()).toBe("/td");
    expect(shimWith({ TMP: "/t", TEMP: "/te" }).tmpdir()).toBe("/t");
    expect(shimWith({ TEMP: "/te" }).tmpdir()).toBe("/te");
    expect(shimWith({}).tmpdir()).toBe("/tmp");
    expect(shimWith(VIRTUAL_ENVIRONMENT).tmpdir()).toBe("/tmp");
  });

  it("treats an empty variable as unset, which is also measured", () => {
    // Node with TMPDIR="" TMP unset TEMP=/te answered /te.
    expect(shimWith({ TMPDIR: "", TEMP: "/te" }).tmpdir()).toBe("/te");
    expect(shimWith({ TMPDIR: "", TMP: "" }).tmpdir()).toBe("/tmp");
  });

  it("validates nothing, because Node does not", () => {
    // Measured: TMPDIR=/etc/hostname (a file) answered /etc/hostname, and TMPDIR=/nope/nope (absent) answered it too.
    expect(shimWith({ TMPDIR: "/etc/hostname" }).tmpdir()).toBe("/etc/hostname");
    expect(shimWith({ TMPDIR: "/nope/nope" }).tmpdir()).toBe("/nope/nope");
  });
});

describe("the members this runtime still cannot answer", () => {
  it("keeps refusing the ones that describe a host machine", () => {
    const shim = shimWith() as unknown as Record<string, (() => unknown) | undefined>;
    for (const member of ["totalmem", "freemem", "uptime", "loadavg", "hostname", "userInfo", "networkInterfaces"] as const) {
      let caught: unknown;
      try {
        shim[member]?.();
      } catch (error) {
        caught = error;
      }
      expect(caught, member).toMatchObject({ code: "ERR_NOT_SUPPORTED" });
      expect((caught as Error).message).toContain(`os.${member}() is not available`);
    }
  });
});
