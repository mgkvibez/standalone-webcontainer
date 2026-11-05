/**
 * The tar writer, tool-side.
 *
 * Deliberately the same format as `tests/helpers/tarball.ts`: ustar, zero mtime, zero uid/gid, 0644 files and 0755
 * directories, entries in the order given, 1024 zero bytes of terminator. That is what makes the committed corpus
 * reproducible rather than merely regenerable.
 *
 * The two writers are kept in step by a test that builds the same package with each and compares bytes, rather than by
 * a comment asking the next person to remember. They are separate files because a committed artifact generator must not
 * depend on the test suite, and the test suite must not depend on the build tooling.
 *
 * This writer accepts any path, including hostile ones. That is intentional: `@corpus-broken/tar-hostile` exists to
 * prove the READER refuses an escape, and a writer that sanitised paths could not produce the archive that tests it.
 */

import { gzipSync } from "node:zlib";

const encoder = new TextEncoder();

export interface WriteEntry {
  path: string;
  data?: string | Uint8Array;
  type?: "file" | "directory";
  mode?: number;
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
    if (entry.type === "directory") {
      blocks.push(header(entry.path, 0, "5", entry.mode ?? 0o755));
      continue;
    }
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : (entry.data ?? new Uint8Array(0));
    blocks.push(header(entry.path, data.length, "0", entry.mode ?? 0o644));
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
  files: Readonly<Record<string, string>>,
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
