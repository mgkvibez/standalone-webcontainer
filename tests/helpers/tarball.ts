/**
 * Test helpers for building npm-shaped tarballs and registry packuments.
 *
 * Shared rather than duplicated: the tarball writer is fiddly enough (checksums, PAX length prefixes) that a
 * second copy would drift, and a test that passes because its own writer is wrong proves nothing.
 */

import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

export interface WriteEntry {
  path: string;
  data?: string | Uint8Array;
  type?: "file" | "directory" | "symlink" | "hardlink" | "device" | "fifo" | "pax" | "gnu-longname";
  /** Only for gnu-longname entries: the payload text. */
  payload?: string;
  /** Only for pax: the path that the payload announces. */
  announcedPath?: string;
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = encoder.encode(`${text}\0`);
  target.set(bytes.subarray(0, length), offset);
}

function header(name: string, size: number, typeflag: string, mode = 0o644): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name).subarray(0, 100), 0);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block[156] = typeflag.charCodeAt(0);
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);

  for (let index = 148; index < 156; index += 1) block[index] = 0x20;
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
}

function body(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return padded;
}

/** Build an uncompressed tar archive. */
export function makeTar(entries: readonly WriteEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    if (type === "directory") {
      blocks.push(header(entry.path, 0, "5", 0o755));
      continue;
    }
    if (type === "pax") {
      const value = `path=${entry.announcedPath ?? ""}`;
      const rest = ` ${value}\n`;
      // A PAX record's length includes its own decimal digits, which is the fiddly part of the format.
      let length = rest.length + 1;
      while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
      const payload = encoder.encode(`${length}${rest}`);
      blocks.push(header("PaxHeader", payload.length, "x"));
      blocks.push(body(payload));
      continue;
    }
    if (type === "gnu-longname") {
      const payload = encoder.encode(`${entry.payload ?? ""}\0`);
      blocks.push(header("././@LongLink", payload.length, "L"));
      blocks.push(body(payload));
      continue;
    }
    if (type === "symlink") {
      blocks.push(header(entry.path, 0, "2"));
      continue;
    }
    // The other entries a hostile archive can carry. The reader refuses all of them, so a test needs to be able to
    // produce them: without these the "hard links, devices and fifos are refused" claim is only exercised for symlinks.
    if (type === "hardlink" || type === "device" || type === "fifo") {
      const flag = type === "hardlink" ? "1" : type === "device" ? "3" : "6";
      blocks.push(header(entry.path, 0, flag));
      continue;
    }
    const data =
      typeof entry.data === "string" ? encoder.encode(entry.data) : (entry.data ?? new Uint8Array(0));
    blocks.push(header(entry.path, data.length, "0"));
    blocks.push(body(data));
  }
  blocks.push(new Uint8Array(1024));

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** A gzipped package tarball laid out the way npm publishes them: everything under `package/`. */
export function makePackageTarball(
  files: Readonly<Record<string, string | Uint8Array>>,
  packageJson: Record<string, unknown>,
): Uint8Array {
  const entries: WriteEntry[] = [
    { path: "package/", type: "directory" },
    { path: "package/package.json", data: JSON.stringify(packageJson, null, 2) },
  ];
  for (const [path, contents] of Object.entries(files)) {
    entries.push({ path: `package/${path}`, data: contents });
  }
  return new Uint8Array(gzipSync(makeTar(entries)));
}

/** The fields a package version contributes to its packument entry. */
export interface PackumentVersionInput {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  /** Published as dist.integrity, so a mismatch can be tested. */
  readonly integrity?: string;
}

/** Build the packument shape the installer reads. */
export function packument(
  name: string,
  versions: readonly PackumentVersionInput[],
  latest?: string,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const entry of versions) {
    map[entry.version] = {
      name,
      version: entry.version,
      dependencies: entry.dependencies ?? {},
      dist: {
        tarball: `https://registry.test/${name}/-/${name}-${entry.version}.tgz`,
        ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }),
      },
      // Optional and platform fields pass through, because the browser-compatibility filter reads them.
      ...(entry.optionalDependencies === undefined ? {} : { optionalDependencies: entry.optionalDependencies }),
      ...(entry.os === undefined ? {} : { os: entry.os }),
      ...(entry.cpu === undefined ? {} : { cpu: entry.cpu }),
    };
  }
  return { name, "dist-tags": { latest: latest ?? versions[versions.length - 1]?.version ?? "0.0.0" }, versions: map };
}
