/**
 * Which registry a workspace installs from, decided by the URL and nothing else.
 *
 * The product's default is the public npm registry: that is the milestone's whole point, and a default that quietly fell back to the committed
 * corpus when the network was unavailable would be the substitution the directive forbids - a user would see "installed react" and get ten
 * synthetic packages.
 *
 * The corpus lane stays reachable because it is genuinely useful: it is hermetic, it is what the unit tests and the older browser specs use, and
 * a demo with no network should be able to run the installer. Reaching it is an explicit choice in the URL (`?registry=corpus`), so an install log
 * that says "from the offline corpus" is a statement about a deliberate lane rather than about a failed fetch.
 */

export type RegistryLane = "network" | "corpus";

export class UnknownRegistryLaneError extends Error {
  readonly lane: string;

  constructor(lane: string) {
    super(`unknown registry lane "${lane}": use "network" (the default) or "corpus"`);
    this.name = "UnknownRegistryLaneError";
    this.lane = lane;
  }
}

/**
 * Read the lane from a query string.
 *
 * An unknown value is refused rather than defaulted, because the two lanes make different claims about the bytes and a typo that silently meant
 * "network" (or "corpus") would be a mislabelled install.
 */
export function registryLaneFrom(search: string): RegistryLane {
  const value = new URLSearchParams(search).get("registry");
  if (value === null || value === "" || value === "network") return "network";
  if (value === "corpus" || value === "offline") return "corpus";
  throw new UnknownRegistryLaneError(value);
}
