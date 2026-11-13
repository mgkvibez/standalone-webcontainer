/// <reference types="vite/client" />

/**
 * The registry the workspace hands to the container.
 *
 * Two lanes, one contract (`RegistryClient`), and the choice comes from the URL. The default is the real registry, because a workspace that
 * installs synthetic packages while claiming to install npm packages is worse than one that fails.

 * The tarball bytes persist in IndexedDB when the browser offers it, which is what makes reopening a workspace cheap: the tree is rebuilt from
 * the lockfile, and rebuilding it from bytes already on disk is a second instead of a download. Verification does not move: the installer checks
 * every tarball against `dist.integrity` on every install, cache hit or not, so a corrupted entry is refused rather than trusted.
 */

import type { RegistryClient } from "../npm/install.js";
import { createIndexedDbByteCache, createMemoryByteCache } from "../registry/byte-cache.js";
import { registryLaneFrom, type RegistryLane } from "../registry/lane.js";
import { createNetworkRegistry, type RegistryStats } from "../registry/network.js";
import { loadOfflineRegistry } from "./offline-registry.js";

/** Ceiling for cached package bytes. Large enough for a Vite tree, small enough not to look like an unbounded quota grab. */
const CACHE_BYTES = 96 * 1024 * 1024;

export interface ProductRegistry extends RegistryClient {
  readonly lane: RegistryLane;
  /** Network counters, when the lane has any. The corpus lane reads committed bytes, so it has nothing to count. */
  stats?(): RegistryStats;
}

function wrap(lane: RegistryLane, client: RegistryClient, stats?: () => RegistryStats): ProductRegistry {
  const product: ProductRegistry = {
    lane,
    packument: (name) => client.packument(name),
    tarball: (url) => client.tarball(url),
    ...(stats === undefined ? {} : { stats }),
  };
  // `origin` is optional on the contract and must stay optional: the terminal line reads "from <origin>" only when the registry names itself.
  return client.origin === undefined ? product : { ...product, origin: client.origin };
}

export async function createProductRegistry(lane: RegistryLane): Promise<ProductRegistry> {
  if (lane === "corpus") return wrap("corpus", await loadOfflineRegistry());
  const cache = createIndexedDbByteCache({ maxBytes: CACHE_BYTES }) ?? createMemoryByteCache({ maxBytes: CACHE_BYTES });
  const registry = createNetworkRegistry({ cache });
  return wrap("network", registry, () => registry.stats());
}

/** The lane this page was opened with, resolved once at boot so the install line cannot claim a lane the bytes did not come from. */
export function bootRegistryLane(search: string): RegistryLane {
  return registryLaneFrom(search);
}
