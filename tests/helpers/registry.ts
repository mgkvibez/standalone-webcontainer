/**
 * A registry double, shared by every test that installs.
 *
 * Three test files were about to grow three copies of this, which is how a fake drifts away from the real
 * interface it stands in for. The only thing stubbed anywhere in these tests is the network.
 */

import type { Packument, RegistryClient } from "../../src/npm/install.js";

import { makePackageTarball, packument } from "./tarball.js";

export interface FakeVersion {
  readonly version: string;
  /** Written into the tarball besides package.json. */
  readonly files?: Record<string, string>;
  /** `main` field for the generated package.json. */
  readonly main?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  /** npm's platform fields, used to test the browser-compatibility filter. */
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  /** Served verbatim instead of a generated tarball. */
  readonly rawTarball?: Uint8Array;
  /** Published as dist.integrity, so a mismatch can be tested. */
  readonly integrity?: string;
}

export interface FakeRegistryOptions {
  readonly packages: Readonly<Record<string, readonly FakeVersion[]>>;
  /** Latest dist-tag per package, when it should not be the highest published version. */
  readonly latest?: Readonly<Record<string, string>>;
  /** Set false to publish no integrity at all, as very old packages do. */
  readonly withIntegrity?: boolean;
}

export interface FakeRegistry extends RegistryClient {
  /** Packument names requested, in order. Empty means the install never consulted the registry. */
  readonly fetched: string[];
  /** Tarball URLs requested, in order. */
  readonly tarballs: string[];
}

export async function sha512Integrity(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-512", owned);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha512-${btoa(binary)}`;
}

export async function createFakeRegistry(options: FakeRegistryOptions): Promise<FakeRegistry> {
  const fetched: string[] = [];
  const tarballsRequested: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const packuments = new Map<string, Packument>();

  for (const [name, versions] of Object.entries(options.packages)) {
    const published: Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      os?: readonly string[];
      cpu?: readonly string[];
      integrity?: string;
    }> = [];

    for (const entry of versions) {
      const bytes =
        entry.rawTarball ??
        makePackageTarball(entry.files ?? { "index.js": `module.exports = ${JSON.stringify(`${name}@${entry.version}`)};` }, {
          name,
          version: entry.version,
          ...(entry.main === undefined ? {} : { main: entry.main }),
          dependencies: entry.dependencies ?? {},
          ...(entry.optionalDependencies === undefined ? {} : { optionalDependencies: entry.optionalDependencies }),
          ...(entry.os === undefined ? {} : { os: entry.os }),
          ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
        });
      const url = `https://registry.test/${name}/-/${name}-${entry.version}.tgz`;
      tarballs.set(url, bytes);

      const integrity =
        options.withIntegrity === false ? undefined : (entry.integrity ?? (await sha512Integrity(bytes)));
      published.push({
        name,
        version: entry.version,
        ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
        ...(entry.optionalDependencies === undefined ? {} : { optionalDependencies: entry.optionalDependencies }),
        ...(entry.os === undefined ? {} : { os: entry.os }),
        ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
        ...(integrity === undefined ? {} : { integrity }),
      });
    }

    packuments.set(name, packument(name, published, options.latest?.[name]) as unknown as Packument);
  }

  return {
    fetched,
    tarballs: tarballsRequested,
    async packument(name: string): Promise<Packument> {
      fetched.push(name);
      const found = packuments.get(name);
      if (found === undefined) throw new Error(`registry 404 for ${name}`);
      return found;
    },
    async tarball(url: string): Promise<Uint8Array> {
      tarballsRequested.push(url);
      const found = tarballs.get(url);
      if (found === undefined) throw new Error(`registry 404 for ${url}`);
      return found;
    },
  };
}
