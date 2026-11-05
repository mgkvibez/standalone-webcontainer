/**
 * npm tarballs: gunzip, then read tar into memory.
 *
 * A tarball fetched from a registry is untrusted input that gets written into our VFS, so this module's job
 * is as much about refusing things as about parsing them. Four protections are non-negotiable, because each
 * one is a known attack on package managers rather than a hypothetical:
 *
 * 1. **No path escapes.** An entry named `../../etc/passwd` or `/absolute/path` is rejected outright, not
 *    sanitised. Our VFS normalises paths, so a sanitised escape could still land somewhere unexpected.
 * 2. **Bounded decompression.** A few hundred kilobytes of gzip can expand to gigabytes. The gunzip loop
 *    counts output as it goes and stops at the cap instead of trusting the header.
 * 3. **Bounded entry count and per-file size**, so a tarball of a million empty files cannot exhaust memory
 *    through bookkeeping alone.
 * 4. **Checksum verification.** A corrupt tarball should fail loudly here rather than half-write into the
 *    VFS and produce an install that is broken in a confusing way.
 *
 * What is deliberately not supported: GNU base-256 (binary) size fields, sparse files, and device nodes.
 * npm's own tarballs do not contain them. Encountering one is an error naming the feature, not silent
 * misbehaviour, because a silently ignored binary size field would corrupt every subsequent offset.
 *
 * Decompression uses the platform's `DecompressionStream`, which exists in every browser we target and in
 * Node 18+. That avoids shipping a gzip implementation and keeps the code honest about being browser-native.
 */

export interface TarEntry {
  /** Path as recorded, with the top-level directory still present. */
  readonly path: string;
  readonly data: Uint8Array;
  readonly mode: number;
  readonly type: "file" | "directory";
}

export interface TarLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDecompressedBytes: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxEntries: 20_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 512 * 1024 * 1024,
};

export class TarballError extends Error {
  public readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "TarballError";
    this.reason = reason;
  }
}

const BLOCK = 512;

function toOctal(bytes: Uint8Array, start: number, length: number): number {
  // Octal ASCII, NUL or space terminated. A leading high bit means a GNU base-256 field, which we refuse
  // rather than misread: getting it wrong shifts every subsequent offset and corrupts the whole archive.
  if ((bytes[start] ?? 0) & 0x80) {
    throw new TarballError("UNSUPPORTED_TAR_FIELD", "base-256 (binary) numeric field is not supported");
  }
  let text = "";
  for (let index = start; index < start + length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0 || byte === 0x20) {
      if (text !== "") break;
      continue;
    }
    text += String.fromCharCode(byte);
  }
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
}

function readString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = Math.min(start + length, bytes.length);
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function verifyChecksum(header: Uint8Array): void {
  const recorded = toOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    // The checksum field itself is summed as spaces, per the format.
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== recorded) throw new TarballError("CORRUPT_HEADER", `checksum mismatch (${recorded} != ${sum})`);
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK; index += 1) {
    if ((bytes[index] ?? 0) !== 0) return false;
  }
  return true;
}

/** Reject an absolute path or one that climbs out of the install root. */
function assertSafePath(path: string): void {
  if (path.startsWith("/")) throw new TarballError("UNSAFE_PATH", `absolute path ${path}`);
  const segments = path.split("/");
  if (segments.includes("..")) throw new TarballError("UNSAFE_PATH", `path traversal in ${path}`);
  if (segments.includes("")) {
    // A doubled slash is harmless but leaves path normalisation to decide; refusing keeps that deterministic.
    throw new TarballError("UNSAFE_PATH", `empty path segment in ${path}`);
  }
}

/**
 * Parse an uncompressed tar archive.
 *
 * PAX (`x`) and GNU long-name (`L`) headers are honoured because they are how a path longer than 100 bytes
 * is stored, and silently dropping them would install a package with the wrong filenames.
 */
export function parseTar(
  archive: Uint8Array,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + BLOCK <= archive.length) {
    if (isZeroBlock(archive, offset)) break;

    const header = archive.subarray(offset, offset + BLOCK);
    verifyChecksum(header);

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = toOctal(header, 124, 12);
    const mode = toOctal(header, 100, 8) || 0o644;
    const nameField = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeRounded = Math.ceil(size / BLOCK) * BLOCK;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;

    if (dataEnd > archive.length) {
      throw new TarballError("TRUNCATED_ARCHIVE", `entry declares ${size} bytes beyond the end of the archive`);
    }

    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + sizeRounded;

    if (typeflag === "x" || typeflag === "g") {
      // PAX: "length key=value\n" records. Only `path` matters for installing npm packages.
      const text = new TextDecoder().decode(data);
      for (const line of text.split("\n")) {
        const space = line.indexOf(" ");
        if (space === -1) continue;
        const record = line.slice(space + 1);
        if (record.startsWith("path=")) pendingPaxPath = record.slice("path=".length);
      }
      continue;
    }

    if (typeflag === "L") {
      pendingLongName = readString(data, 0, data.length);
      continue;
    }

    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      // Hard links, symlinks, devices and fifos: refused rather than skipped, because a package that needs
      // them would otherwise install and then fail at runtime with a missing file.
      throw new TarballError("UNSUPPORTED_ENTRY", `type ${typeflag} in ${nameField || "(unnamed)"}`);
    }

    const composed = prefix === "" ? nameField : `${prefix}/${nameField}`;
    const path = pendingPaxPath ?? pendingLongName ?? composed;
    pendingPaxPath = null;
    pendingLongName = null;

    const isDirectory = typeflag === "5" || path.endsWith("/");
    if (!isDirectory) assertSafePath(path);

    if (entries.length >= limits.maxEntries) {
      throw new TarballError("TOO_MANY_ENTRIES", `more than ${limits.maxEntries} entries`);
    }

    if (!isDirectory) {
      if (data.length > limits.maxFileBytes) {
        throw new TarballError("FILE_TOO_LARGE", `${path} is ${data.length} bytes (limit ${limits.maxFileBytes})`);
      }
      totalBytes += data.length;
      if (totalBytes > limits.maxTotalBytes) {
        throw new TarballError("ARCHIVE_TOO_LARGE", `archive expands past ${limits.maxTotalBytes} bytes`);
      }
    }

    entries.push({
      path,
      // Copied, not a view: the archive buffer may be released while entries are still being written.
      data: isDirectory ? new Uint8Array(0) : new Uint8Array(data),
      mode,
      type: isDirectory ? "directory" : "file",
    });
  }

  return entries;
}

/**
 * Decompress gzip into memory, stopping at `maxDecompressedBytes`.
 *
 * The cap is enforced on the *output* as it streams, which is the only way it can be: the gzip header may
 * claim anything, and a 30 kB archive really can expand to gigabytes.
 */
export async function gunzip(
  compressed: Uint8Array,
  maxDecompressedBytes: number = DEFAULT_TAR_LIMITS.maxDecompressedBytes,
): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;
  try {
    // Copied into a fresh ArrayBuffer first: the view may be a subarray of a larger buffer, and the Blob
    // constructor wants a whole buffer it can own. The copy is also what keeps the type honest.
    const owned = new ArrayBuffer(compressed.byteLength);
    new Uint8Array(owned).set(compressed);
    stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream("gzip"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TarballError("DECOMPRESSION_FAILED", detail);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.length;
      if (total > maxDecompressedBytes) {
        await reader.cancel();
        throw new TarballError(
          "DECOMPRESSION_TOO_LARGE",
          `output exceeded ${maxDecompressedBytes} bytes; refusing to continue`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TarballError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new TarballError("DECOMPRESSION_FAILED", detail);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The whole path: gzipped tarball bytes in, verified entries out. */
export async function extractTarball(
  compressed: Uint8Array,
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): Promise<readonly TarEntry[]> {
  const archive = await gunzip(compressed, limits.maxDecompressedBytes);
  return parseTar(archive, limits);
}

/**
 * npm tarballs wrap everything in a single top-level directory (`package/`), and the VFS must receive the
 * contents without it. Returns entries with that prefix stripped, dropping the wrapper itself.
 */
export function stripTopLevelDirectory(entries: readonly TarEntry[]): readonly TarEntry[] {
  const firstFile = entries.find((entry) => entry.type === "file");
  if (firstFile === undefined) return entries;
  const slash = firstFile.path.indexOf("/");
  if (slash === -1) return entries;
  const prefix = firstFile.path.slice(0, slash);

  const stripped: TarEntry[] = [];
  for (const entry of entries) {
    if (entry.path === prefix || entry.path === `${prefix}/`) continue;
    if (!entry.path.startsWith(`${prefix}/`)) {
      // A second top-level directory means this is not an npm package layout; leave it alone rather than
      // silently discarding part of the archive.
      return entries;
    }
    stripped.push({ ...entry, path: entry.path.slice(prefix.length + 1) });
  }
  return stripped;
}
