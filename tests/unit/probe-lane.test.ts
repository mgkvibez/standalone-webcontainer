import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlaywrightTestConfig } from "@playwright/test";
import gateConfig from "../../playwright.config.js";
import probeConfig from "../../tools/probes/playwright.config.js";

/**
 * A probe is a question, not a gate.
 *
 * This file exists because a diagnostic cost a CI run: `probe-hmr.spec.ts` sat inside the browser lane waiting on a condition that never
 * arrived, so the job failed by TIMEOUT (10.1m) and reported nothing about the product. A probe that hangs must never be able to fail the
 * gate, and a probe must never be able to measure a different app than the gate does. Those are the two properties pinned here.
 */

const SPEC = /\.spec\.ts$/;
const PROBE = /\.probe\.ts$/;

const serverCommand = (config: PlaywrightTestConfig): string => {
  const server = config.webServer;
  if (server === undefined || Array.isArray(server) || typeof server === "string") {
    throw new Error("expected a single webServer object");
  }
  const command = server.command;
  if (typeof command !== "string") throw new Error("expected the webServer to hold one command string");
  return command;
};

describe("the probe lane", () => {
  it("keeps every gate spec in the gate and every probe out of it", () => {
    const gateFiles = readdirSync("tests/browser");
    const probeFiles = readdirSync("tools/probes");

    // The gate collects *.spec.ts under tests/browser, so a probe named .spec.ts is a gate test however it is written. The naming rule is
    // the only thing standing between a 600s hang and a red CI run, so it is asserted rather than assumed.
    expect(gateFiles.filter((name) => PROBE.test(name))).toEqual([]);
    expect(gateFiles.filter((name) => SPEC.test(name)).length).toBeGreaterThan(0);
    expect(probeFiles.filter((name) => PROBE.test(name))).toEqual(["hmr.probe.ts", "optimizer.probe.ts"]);
  });

  it("serves the same target as the gate, so a probe measures the product CI gates", () => {
    expect(probeConfig.use?.baseURL).toBe(gateConfig.use?.baseURL);
    expect(serverCommand(probeConfig)).toBe(serverCommand(gateConfig));
    // The probe lane's own testDir must not reach the gate's directory: one config change there would re-enter every probe into CI.
    expect(probeConfig.testDir).toBe(".");
    expect(gateConfig.testDir).toBe("./tests/browser");
  });

  it("matches probes only, and nothing in the gate", () => {
    const match = probeConfig.testMatch;
    const matcher = Array.isArray(match) ? match : [match];
    const matches = (name: string): boolean => matcher.some((pattern) => (pattern instanceof RegExp ? pattern.test(name) : name === pattern));
    expect(matches("hmr.probe.ts")).toBe(true);
    expect(matches("real-registry-acceptance.spec.ts")).toBe(false);
  });
});
