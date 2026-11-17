/**
 * Topology helpers for the cross-site harness.
 *
 * These exist because the harness's first version accidentally tested the wrong
 * thing: `a.preview.test` and `b.preview.test` are different ORIGINS and the same
 * SITE, so a "cross-site" case silently measured same-site cookie attachment.
 * Every result is therefore stamped with the topology it was actually run under,
 * and a case whose topology is not what it claims fails instead of being recorded.
 */

/** Reserved test suffixes the harness owns. Everything here is one label above `.test`. */
const TEST_TLDS = new Set(["test"]);

/** eTLD+1 for the harness's own hostnames. Deliberately narrow: this is not a PSL library. */
export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) throw new Error(`host ${host} has no registrable domain`);
  const tld = labels[labels.length - 1];
  if (tld === undefined || !TEST_TLDS.has(tld)) {
    throw new Error(`host ${host} is outside the reserved .test space`);
  }
  return labels.slice(-2).join(".");
}

export interface TopologyRecord {
  readonly topLevelHost: string;
  readonly engineHost: string;
  readonly topLevelOrigin: string;
  readonly engineOrigin: string;
  readonly topLevelSite: string;
  readonly engineSite: string;
  /** True when the two origins are the same site (design A's shape). */
  readonly sameSite: boolean;
  /** True when the two origins differ (so origin separation genuinely exists). */
  readonly crossOrigin: boolean;
  readonly frameRelationship: "first-party" | "third-party-iframe";
}

export interface TopologyExpectation {
  readonly sameSite: boolean;
  readonly crossOrigin: boolean;
  readonly frameRelationship: "first-party" | "third-party-iframe";
}

export class TopologyMismatchError extends Error {}

export function describeTopology(
  topLevel: string,
  engine: string,
  frameRelationship: "first-party" | "third-party-iframe",
): TopologyRecord {
  const topLevelHost = new URL(topLevel).hostname;
  const engineHost = new URL(engine).hostname;
  const topLevelSite = registrableDomain(topLevelHost);
  const engineSite = registrableDomain(engineHost);
  return {
    topLevelHost,
    engineHost,
    topLevelOrigin: new URL(topLevel).origin,
    engineOrigin: new URL(engine).origin,
    topLevelSite,
    engineSite,
    sameSite: topLevelSite === engineSite,
    crossOrigin: new URL(topLevel).origin !== new URL(engine).origin,
    frameRelationship,
  };
}

/** Assert the run measured what the case claims it measures. Throws on mismatch. */
export function assertTopology(record: TopologyRecord, expected: TopologyExpectation): TopologyRecord {
  const problems: string[] = [];
  if (record.sameSite !== expected.sameSite) {
    problems.push(`expected sameSite=${expected.sameSite}, measured ${record.sameSite}`);
  }
  if (record.crossOrigin !== expected.crossOrigin) {
    problems.push(`expected crossOrigin=${expected.crossOrigin}, measured ${record.crossOrigin}`);
  }
  if (record.frameRelationship !== expected.frameRelationship) {
    problems.push(`expected frame=${expected.frameRelationship}, measured ${record.frameRelationship}`);
  }
  if (problems.length > 0) {
    throw new TopologyMismatchError(`topology assertion failed: ${problems.join("; ")}`);
  }
  if (!expected.sameSite && record.topLevelSite === record.engineSite) {
    throw new TopologyMismatchError("cross-site case resolved to one registrable domain");
  }
  return record;
}
