/**
 * Tarball reading: the parsing, and the refusals.
 *
 * The archives here are built by a small writer in this file rather than checked in as fixtures, so each test
 * can state exactly the shape it is testing (a PAX path, a traversal attempt, a symlink) without a binary
 * blob nobody can read in review.
 */

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { makeTar } from "../helpers/tarball.js";
import {
  DEFAULT_TAR_LIMITS,
  extractTarball,
  gunzip,
  parseTar,
  stripTopLevelDirectory,
  TarballError,
  type TarLimits,
} from "../../src/npm/tarball.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function limits(overrides: Partial<TarLimits>): TarLimits {
  return { ...DEFAULT_TAR_LIMITS, ...overrides };
}

describe("parseTar", () => {
  it("reads a file with its contents", () => {
    const entries = parseTar(makeTar([{ path: "package/package.json", data: '{"name":"demo"}' }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("package/package.json");
    expect(decoder.decode(entries[0]?.data)).toBe('{"name":"demo"}');
  });

  it("keeps directory entries and file contents apart", () => {
    const entries = parseTar(
      makeTar([
        { path: "package/", type: "directory" },
        { path: "package/lib/", type: "directory" },
        { path: "package/lib/index.js", data: "module.exports = 1;" },
      ]),
    );
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["package/", "directory"],
      ["package/lib/", "directory"],
      ["package/lib/index.js", "file"],
    ]);
  });

  it("preserves binary content byte for byte", () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 0, 1]);
    const entries = parseTar(makeTar([{ path: "package/logo.bin", data: bytes }]));
    expect([...(entries[0]?.data ?? new Uint8Array())]).toEqual([0, 255, 128, 10, 0, 1]);
  });

  it("honours a PAX path, which is how long paths are stored", () => {
    const long = `package/${"a".repeat(120)}/file.js`;
    const entries = parseTar(makeTar([{ path: "package/ignored", type: "pax", announcedPath: long }, { path: "package/short.js", data: "x" }]));
    expect(entries[0]?.path).toBe(long);
  });

  it("honours a GNU long-name header", () => {
    const long = `package/${"b".repeat(140)}.js`;
    const entries = parseTar(makeTar([{ path: "././@LongLink", type: "gnu-longname", payload: long }, { path: "package/short.js", data: "x" }]));
    expect(entries[0]?.path).toBe(long);
  });

  it("reads a UTF-8 filename", () => {
    const entries = parseTar(makeTar([{ path: "package/café/ñ.js", data: "x" }]));
    expect(entries[0]?.path).toBe("package/café/ñ.js");
  });

  it("returns nothing for an archive of only zero blocks", () => {
    expect(parseTar(new Uint8Array(1024))).toEqual([]);
  });

  it("refuses a path that climbs out of the install root", () => {
    expect(() => parseTar(makeTar([{ path: "package/../../etc/passwd", data: "x" }]))).toThrow(/path traversal/);
  });

  it("refuses an absolute path", () => {
    expect(() => parseTar(makeTar([{ path: "/etc/passwd", data: "x" }]))).toThrow(/absolute path/);
  });

  it("refuses a symlink rather than installing something we cannot represent", () => {
    expect(() => parseTar(makeTar([{ path: "package/link", type: "symlink" }]))).toThrow(/UNSUPPORTED_ENTRY/);
  });

  it("refuses more entries than the limit allows", () => {
    const tar = makeTar([
      { path: "package/a", data: "1" },
      { path: "package/b", data: "2" },
    ]);
    expect(() => parseTar(tar, limits({ maxEntries: 1 }))).toThrow(/more than 1 entries/);
  });

  it("refuses a single file larger than the limit", () => {
    const tar = makeTar([{ path: "package/big", data: new Uint8Array(2048) }]);
    expect(() => parseTar(tar, limits({ maxFileBytes: 1024 }))).toThrow(/FILE_TOO_LARGE/);
  });

  it("refuses an archive whose total content passes the limit", () => {
    const tar = makeTar([
      { path: "package/a", data: new Uint8Array(2048) },
      { path: "package/b", data: new Uint8Array(2048) },
    ]);
    expect(() => parseTar(tar, limits({ maxTotalBytes: 3000 }))).toThrow(/ARCHIVE_TOO_LARGE/);
  });

  it("detects a truncated archive instead of reading past the end", () => {
    const tar = makeTar([{ path: "package/a", data: "hello" }]);
    // 512 header + 5 bytes of data: cutting at 514 leaves the entry's data incomplete.
    expect(() => parseTar(tar.subarray(0, 514))).toThrow(/TRUNCATED_ARCHIVE/);
  });

  it("detects a corrupted header via its checksum", () => {
    const tar = makeTar([{ path: "package/a", data: "hello" }]);
    tar[10] = 0x41; // flip a byte in the name, invalidating the checksum
    expect(() => parseTar(tar)).toThrow(/checksum mismatch/);
  });
});

describe("gunzip and extractTarball", () => {
  it("decompresses and parses in one step", async () => {
    const entries = await extractTarball(gzipSync(makeTar([{ path: "package/index.js", data: "x" }])));
    expect(entries).toHaveLength(1);
    expect(decoder.decode(entries[0]?.data)).toBe("x");
  });

  it("stops a decompression bomb before it fills memory", async () => {
    // 8 MB of zeros compresses to a few kB: exactly the shape of the attack.
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    await expect(gunzip(bomb, 1024 * 1024)).rejects.toThrow(/DECOMPRESSION_TOO_LARGE/);
  });

  it("reports invalid gzip data as a decompression failure", async () => {
    await expect(gunzip(encoder.encode("this is not gzip"))).rejects.toBeInstanceOf(TarballError);
  });
});

describe("stripTopLevelDirectory", () => {
  it("removes the package/ wrapper npm always adds", () => {
    const stripped = stripTopLevelDirectory(
      parseTar(
        makeTar([
          { path: "package/", type: "directory" },
          { path: "package/package.json", data: "{}" },
          { path: "package/lib/index.js", data: "x" },
        ]),
      ),
    );
    expect(stripped.map((entry) => entry.path)).toEqual(["package.json", "lib/index.js"]);
  });

  it("leaves a non-package layout untouched rather than discarding part of it", () => {
    const entries = parseTar(
      makeTar([
        { path: "first/a.js", data: "1" },
        { path: "second/b.js", data: "2" },
      ]),
    );
    expect(stripTopLevelDirectory(entries).map((entry) => entry.path)).toEqual(["first/a.js", "second/b.js"]);
  });

  it("returns entries unchanged when files sit at the root", () => {
    const entries = parseTar(makeTar([{ path: "index.js", data: "x" }]));
    expect(stripTopLevelDirectory(entries).map((entry) => entry.path)).toEqual(["index.js"]);
  });
});
