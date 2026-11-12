import type { FileSystemPort, MkdirOptionsPort, VfsStatsPort, WatchSourcePort, WriteOptionsPort } from "../vfs/port.js";
import { toWatchAsyncIterator, type WatchAsyncIterator, type WatchHandlePort } from "../vfs/watch-iterator.js";
/**
 * `fs` shim: Node's documented `fs` surface, translated onto our VFS.
 *
 * ADR-0003 #1: the VFS remains the single owner of file state; this shim only
 * translates Node-shaped calls into VFS operations (never a second store). The
 * `memfs` package is the API-shape reference; it is not imported, because its
 * fifteen transitive `@jsonjoy` packages would land in a lockfile that cannot be
 * audited this week (ADR-0004, D-1).
 *
 * Errors are re-thrown as Node-shaped errors carrying `code` ("ENOENT", ...),
 * because real packages branch on `err.code` and a shim that throws internal
 * error classes breaks them at the first `catch`.
 */
import { path as nodePath } from "./path.js";
import { fileURLToPath } from "./url.js";
import { VFSError } from "../vfs/errors.js";
import { Buffer } from "buffer";

export interface NodeFsError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path: string;
}

/** Node's errno numbers for the codes we can raise. */
const ERRNO: Readonly<Record<string, number>> = {
  ENOENT: -2,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  ENOTEMPTY: -39,
  EINVAL: -22,
  ENOSPC: -28,
  EFBIG: -27,
  EPERM: -1,
};

const CODE_MAP: Readonly<Record<string, string>> = {
  ENOENT: "ENOENT",
  EEXIST: "EEXIST",
  ENOTDIR: "ENOTDIR",
  EISDIR: "EISDIR",
  ENOTEMPTY: "ENOTEMPTY",
  EINVAL: "EINVAL",
  EQUOTA: "ENOSPC",
  EENCODING: "EINVAL",
  EFBIG: "EFBIG",
  ENOSPC: "ENOSPC",
};

/**
 * A Node-shaped error for a VFS failure.
 *
 * `path` is the `PathLike` the caller gave, because that is what Node puts on the error and a program that compares it expects the same value it
 * passed. It is formatted into the message, so a URL reads as its href rather than as `[object URL]`.
 */
const toNodeError = (error: unknown, syscall: string, path: FsPath): NodeFsError => {
  const shown = typeof path === "string" ? path : path.href;
  if (error instanceof VFSError) {
    const code = CODE_MAP[error.code] ?? "EIO";
    const wrapped = new Error(`${code}: ${syscall} '${shown}'`) as NodeFsError;
    wrapped.code = code;
    wrapped.errno = ERRNO[code] ?? -1;
    wrapped.syscall = syscall;
    wrapped.path = shown;
    return wrapped;
  }
  // Anything that is not a VFS error is a bug in this shim, not user error: do
  // not masquerade it as a filesystem condition.
  throw error;
};

/**
 * Node's `Stats`, as a class, because that is what callers check.
 *
 * The members were already right and the CLASS was absent: `fs.Stats` did not exist, so `statSync(p) instanceof fs.Stats` was false and a
 * package that stores a stat and asks later whether it is a file had no answer. `lstatSync` reports through the same class, because nothing
 * in this VFS is a symbolic link (docs/audit/api-surface-p0.md records the decision the audit says this needs before symlinks exist).
 */
export class Stats implements StatsShim {
  readonly size: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
  readonly mtime: Date;
  readonly birthtime: Date;
  readonly #kind: "file" | "dir";

  constructor(stats: VfsStatsPort) {
    this.#kind = stats.kind;
    this.size = stats.size;
    this.mtimeMs = stats.modifiedAt;
    this.mtime = new Date(stats.modifiedAt);
    this.birthtimeMs = stats.createdAt;
    this.birthtime = new Date(stats.createdAt);
  }

  isFile(): boolean {
    return this.#kind === "file";
  }

  isDirectory(): boolean {
    return this.#kind === "dir";
  }

  /** Always false. There are no links in this VFS, which is why `lstatSync` and `statSync` agree rather than diverge. */
  isSymbolicLink(): boolean {
    return false;
  }

  /** Node returns false rather than throwing for a kind this VFS cannot have, so a caller's `if` keeps working. */
  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }
}

/** One place where a port stat becomes the Node-shaped one, so `statSync` and `statManySync` cannot drift apart. */
const asStats = (stats: VfsStatsPort): StatsShim => new Stats(stats);

/**
 * The access constants, with Node's values and no O_* flags.
 *
 * Every one of these is HONOURED below: the four access modes are answered by existence (this VFS has no permission bits), and
 * COPYFILE_EXCL is checked by `copyFileSync`. `open` takes string flags here, so shipping `O_RDONLY` and friends would be five more names
 * that change nothing — and a name that lies is worse than a name that is missing.
 */
const ACCESS_CONSTANTS = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 } as const;

export const FS_CONSTANTS: Readonly<typeof ACCESS_CONSTANTS> = ACCESS_CONSTANTS;

/**
 * Node's encoding names, normalised the way Node normalises them, or a refusal.
 *
 * Found by running vite: it reads `index.html` and its own package manifests with `readFileSync(path, "utf-8")` — dash and all — and
 * this shim only understood the exact string `"utf8"`. Everything read that way came back as a Buffer, so `html.search(...)` was
 * `TypeError: html.search is not a function` inside vite's HTML plugin and `data.contents` arrived at esbuild as a Buffer, which is
 * `raw.replace is not a function` inside esbuild-wasm. One missing alias, two hundred lines apart in two different packages.
 *
 * Node lowercases the name and drops its dash (`utf-8`, `UTF-8`, `utf8` are one encoding), and refuses anything it does not know with
 * `ERR_UNKNOWN_ENCODING`. Both halves are copied: silently decoding to utf8 what a caller asked for as `hex` would be a wrong answer
 * that looks like a right one.
 */
const normalizeEncoding = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw Object.assign(new TypeError(`The "encoding" argument must be of type string. Received ${typeof value}`), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  const name = value.toLowerCase().replace(/-/g, "");
  switch (name) {
    case "utf8":
    case "utf16le":
    case "ucs2":
    case "latin1":
    case "binary":
    case "ascii":
    case "base64":
    case "base64url":
    case "hex":
      return name;
    default:
      throw Object.assign(new Error(`Unknown encoding: ${value}`), { code: "ERR_UNKNOWN_ENCODING" });
  }
};

/** The encoding from either of Node's shapes: a bare name, or an options object carrying `encoding`. */
const encodingOf = (options: unknown): string | undefined => {
  if (typeof options === "string") return normalizeEncoding(options);
  if (typeof options === "object" && options !== null) return normalizeEncoding((options as { encoding?: unknown }).encoding);
  return undefined;
};

/** Decodes bytes the way a caller's encoding asks for, over the encoder Node itself uses. */
const decodeAs = (bytes: Uint8Array, encoding: string): string =>
  encoding === "utf8" ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString(encoding as Parameters<Buffer["toString"]>[0]);

const asBuffer = (data: string | Uint8Array): Buffer =>
  typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);

/**
 * Options `readdir` accepts, as far as this shim honours them.
 *
 * `withFileTypes` is the one that matters and it is not optional in practice: fast-glob, bundled inside vite, calls
 * `fs.readdir(dir, { withFileTypes: true }, cb)` and then calls `dirent.isSymbolicLink()`. Handing it plain strings produced
 * `TypeError: entry.dirent.isSymbolicLink is not a function` from inside vite's own scanner. `encoding` is accepted and ignored for the
 * same reason Node ignores it for names: this VFS stores names as strings.
 */
export interface ReaddirOptions {
  readonly withFileTypes?: boolean;
  readonly encoding?: string;
}

/**
 * Node's `fs.Dirent`, reduced to the predicates this VFS can answer honestly.
 *
 * Node's Dirent carries a `name`, a `parentPath` (and the deprecated `path` alias it kept for years), and a set of `is*` methods that
 * describe what the entry is. Here an entry is a file or a directory and nothing else: this VFS has no symbolic links, FIFOs, sockets or
 * device nodes, so every other predicate answers `false` because the answer is genuinely no, not because it is unknown.
 */
export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  /** Node's deprecated alias for `parentPath`. Packages read it; removing it would be a break for no gain. */
  readonly path: string;
  readonly #kind: "file" | "dir";

  constructor(name: string, parentPath: string, kind: "file" | "dir") {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this.#kind = kind;
  }

  isFile(): boolean {
    return this.#kind === "file";
  }

  isDirectory(): boolean {
    return this.#kind === "dir";
  }

  isSymbolicLink(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isBlockDevice(): boolean {
    return false;
  }
}

/**
 * The link model this VFS does NOT have, refused by name — see docs/decisions/ADR-0026.md.
 *
 * `fs.symlinkSync("target", "link")` failing as `fs.symlinkSync is not a function` reads as a broken runtime and sends a dependency author
 * looking for a bug that is not there. It is a boundary: this filesystem is a tree with one name per node, and a link layer is a design change
 * (resolution through every lookup, a hop limit, `lstat` versus `stat`, dangling links, directory links) rather than another method.
 *
 * `ERR_NOT_SUPPORTED`, the reason, and the alternatives a caller can act on today: copy the bytes, or point the program at the real path.
 */
const refuseLink = (member: string): never => {
  const error = new Error(
    `ERR_NOT_SUPPORTED: fs.${member} is not available in this runtime: this filesystem is a tree with no link layer, so a name cannot point at ` +
      "another name. Use fs.copyFileSync to duplicate a file's contents, or write the real path where the link would have been. " +
      "See docs/decisions/ADR-0026.md.",
  ) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  throw error;
};

/**
 * Node's time argument for `utimes`: seconds as a number, a numeric string, or a Date.
 *
 * Seconds is the part that catches people out, so it is converted in one place and named: `fs.utimesSync(p, 1700000000, 1700000000)` is a
 * timestamp in 2023, not 1970, and treating it as milliseconds would put every file in 1970 without ever throwing.
 */
const secondsToMilliseconds = (value: number | string | Date, member: string): number => {
  const seconds = value instanceof Date ? value.getTime() / 1000 : typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(seconds)) {
    throw Object.assign(new TypeError(`The "${member}" argument must be a number, a numeric string or a Date. Received ${String(value)}`), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  }
  return Math.round(seconds * 1000);
};

/** `readdir` with Dirents: each child's kind comes from the VFS, so a name can never be described more confidently than it is. */
const direntsOf = (vfs: FileSystemPort, directory: string, names: readonly string[]): Dirent[] =>
  names.map((name) => {
    const child = directory === "/" ? `/${name}` : `${directory}/${name}`;
    const kind = vfs.statSync(child).kind === "dir" ? "dir" : "file";
    return new Dirent(name, directory, kind);
  });

export interface StatsShim {
  isFile(): boolean;
  isDirectory(): boolean;
  /**
   * Always false. There are no links in this VFS, which is why `lstatSync` and `statSync` agree; declared here because a caller reads it and a
   * missing member would be `undefined is not a function` at the call site.
   */
  isSymbolicLink(): boolean;
  /** Node answers false rather than throwing for a kind this VFS cannot have. */
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/**
 * What Node accepts wherever it accepts a path: a string, or a `file:` URL.
 *
 * Measured, not speculative. Vite's `dist/node/constants.js` opens its own manifest with
 * `readFileSync(new URL("../../package.json", import.meta.url))`, which is ordinary Node and failed here with
 * `TypeError: path.startsWith is not a function` from a line that had nothing to do with the mistake. Buffer paths are deliberately not
 * supported: nothing in this runtime hands one over, and accepting a type no caller uses is a claim without a test.
 */
export type FsPath = string | URL;

/** A `file:` URL becomes the path it names; a string is already what every layer below wants. */
const pathOf = (value: FsPath): string => (typeof value === "string" ? value : fileURLToPath(value));

/**
 * The same VFS, accepting a URL wherever a path goes.
 *
 * One view rather than a conversion in twenty method bodies: the absolute shim below is written against a `FileSystemPort`, so wrapping the port
 * is the only place a path can be widened without every method repeating the rule. Wider parameters make this assignable to `FileSystemPort`, so
 * nothing above needs a cast.
 */
const pathAccepting = (vfs: FileSystemPort) => ({
  readFileSync: (path: FsPath, encoding?: "utf8") => vfs.readFileSync(pathOf(path), encoding),
  writeFileSync: (path: FsPath, data: string | Uint8Array, options?: WriteOptionsPort) =>
    vfs.writeFileSync(pathOf(path), data, options),
  mkdirSync: (path: FsPath, options?: MkdirOptionsPort) => vfs.mkdirSync(pathOf(path), options),
  readdirSync: (path: FsPath) => vfs.readdirSync(pathOf(path)),
  statSync: (path: FsPath) => vfs.statSync(pathOf(path)),
  ...(vfs.utimesSync === undefined ? {} : { utimesSync: (path: FsPath, modifiedAt: number) => vfs.utimesSync!(pathOf(path), modifiedAt) }),
  ...(vfs.statManySync === undefined
    ? {}
    : { statManySync: (paths: readonly FsPath[]) => vfs.statManySync!(paths.map(pathOf)) }),
  unlinkSync: (path: FsPath) => vfs.unlinkSync(pathOf(path)),
  rmdirSync: (path: FsPath) => vfs.rmdirSync(pathOf(path)),
  renameSync: (from: FsPath, to: FsPath) => vfs.renameSync(pathOf(from), pathOf(to)),
  readFile: (path: FsPath, encoding?: "utf8") => vfs.readFile(pathOf(path), encoding),
  writeFile: (path: FsPath, data: string | Uint8Array, options?: WriteOptionsPort) =>
    vfs.writeFile(pathOf(path), data, options),
  mkdir: (path: FsPath, options?: MkdirOptionsPort) => vfs.mkdir(pathOf(path), options),
  readdir: (path: FsPath) => vfs.readdir(pathOf(path)),
  unlink: (path: FsPath) => vfs.unlink(pathOf(path)),
});

export interface FsShim {
  readFileSync(path: FsPath, encoding?: string | { encoding?: string }): Buffer | string;
  writeFileSync(path: FsPath, data: string | Uint8Array): void;
  existsSync(path: FsPath): boolean;
  mkdirSync(path: FsPath, options?: { recursive?: boolean }): void;
  readdirSync(path: FsPath, options?: ReaddirOptions | string): string[] | Dirent[];
  statSync(path: FsPath): StatsShim;
  /**
   * Stat several paths at once: one entry per path, `null` where it does not exist.
   *
   * Always present on the shim so callers have one shape to call, even when the substrate underneath cannot batch: the
   * fallback is the same loop over `statSync`, which is what the caller would have written anyway.
   */
  statManySync(paths: readonly FsPath[]): readonly (StatsShim | null)[];
  unlinkSync(path: FsPath): void;
  rmdirSync(path: FsPath): void;
  renameSync(from: FsPath, to: FsPath): void;
  /**
   * The synchronous twins of the members this shim already had as promises.
   *
   * These are not new capability — every one composes over VFS calls that already exist — they are names that real tools call and that were
   * absent from this file entirely. `fs.rmSync` in particular is how every modern tool deletes a tree (vite, rimraf replacements, build
   * scripts), and its absence failed with no output at all, because the throw happens before the program prints anything.
   * tools/differential/api-cases.ts holds the cases; docs/audit/api-surface-p0.md records the measurement.
   */
  rmSync(path: FsPath, options?: { recursive?: boolean; force?: boolean }): void;
  appendFileSync(path: FsPath, data: string | Uint8Array, encoding?: string): void;
  copyFileSync(from: FsPath, to: FsPath, mode?: number): void;
  /** Existence only: the mode is accepted and ignored, because there are no permission bits here. */
  accessSync(path: FsPath, mode?: number): void;
  /** Returns the directory it created, in the CALLER's shape: a relative prefix yields a relative path, as in Node. */
  mkdtempSync(prefix: string): string;
  truncateSync(path: FsPath, length?: number): void;
  /** No symlinks exist in this VFS, so `lstatSync` is `statSync` with `lstat` as its syscall. Documented rather than silently absent. */
  lstatSync(path: FsPath): StatsShim;
  /** `(path, atime, mtime)`, both in SECONDS as in Node. Sets modification time; birth time is immutable, as POSIX makes it. */
  utimesSync(path: FsPath, atime: number | string | Date, mtime: number | string | Date): void;
  /** `l` for "the link itself", which is `utimes` here because no path is a link. Same alias rule as `lstatSync`. */
  lutimesSync(path: FsPath, atime: number | string | Date, mtime: number | string | Date): void;
  /** Refused by name: there is no link layer to create a link in. See `refuseLink` and ADR-0026. */
  symlinkSync(target: FsPath, path: FsPath, type?: string): never;
  /** Refused by name, same reason. A hard link would need a link COUNT per node, which this VFS does not store. */
  linkSync(existingPath: FsPath, newPath: FsPath): never;
  /** Refused by name, same reason: there is no stored target to read. */
  readlinkSync(path: FsPath): never;
  /** The `Stats` class itself, because callers do `instanceof` against it. */
  Stats: typeof Stats;
  /** F_OK/R_OK/W_OK/X_OK and COPYFILE_EXCL. See ACCESS_CONSTANTS for what is deliberately omitted. */
  constants: Readonly<typeof ACCESS_CONSTANTS>;
  /**
   * Node's callback forms, one beside each promise form.
   *
   * A program can see the difference: vite loads a bundled config by writing a temp `.mjs`, importing it, then calling `fs.unlink(tmp, () => {})` in
   * a `finally`, so a shim holding `unlinkSync` and `promises.unlink` but not `unlink` fails a build that had already bundled its config correctly.
   * All of these are derived from the promise members and never reimplemented, so both calling conventions share one path rewrite and one error map.
   */
  readFile(path: FsPath, optionsOrCallback?: string | { encoding?: string } | CallbackOnly, maybeCallback?: CallbackOnly): void;
  writeFile(path: FsPath, data: string | Uint8Array, callback: CallbackOnly): void;
  mkdir(path: FsPath, optionsOrCallback?: { recursive?: boolean } | CallbackOnly, maybeCallback?: CallbackOnly): void;
  unlink(path: FsPath, callback: CallbackOnly): void;
  rmdir(path: FsPath, optionsOrCallback?: { recursive?: boolean } | CallbackOnly, maybeCallback?: CallbackOnly): void;
  rename(from: FsPath, to: FsPath, callback: CallbackOnly): void;
  rm(path: FsPath, optionsOrCallback?: { recursive?: boolean; force?: boolean } | CallbackOnly, maybeCallback?: CallbackOnly): void;
  access(path: FsPath, callback: CallbackOnly): void;
  /** `(path, data[, encoding], callback)`, Node's shape for the append that creates its target. */
  appendFile(
    path: FsPath,
    data: string | Uint8Array,
    optionsOrCallback?: string | CallbackOnly,
    maybeCallback?: CallbackOnly,
  ): void;
  /** `(from, to[, mode], callback)`, where mode carries COPYFILE_EXCL. */
  copyFile(from: FsPath, to: FsPath, modeOrCallback?: number | CallbackOnly, maybeCallback?: CallbackOnly): void;
  /** A prefix, not a path to create: the callback receives the directory that was made. */
  mkdtemp(prefix: string, callback: (error: unknown, made?: string) => void): void;
  truncate(path: FsPath, lengthOrCallback?: number | CallbackOnly, maybeCallback?: CallbackOnly): void;
  /**
   * `fs.watch`. The listener may be passed second, as in Node, and the returned handle is the FSWatcher-shaped object.
   *
   * `encoding` is refused rather than ignored: Node uses it to decide whether filenames arrive as strings or Buffers, and
   * quietly returning strings to a program that asked for Buffers is the kind of wrongness that takes a day to find.
   */
  watch(
    path: string,
    listenerOrOptions?: WatchListener | WatchOptions,
    maybeListener?: WatchListener,
  ): WatchHandlePort;
  /**
   * Callback `readdir`, `stat` and `lstat`.
   *
   * These exist because a real dependency asks for them BY NAME and promisifies them: vite's bundled chokidar does
   * `const readdir = promisify(fs.readdir)` at module scope, so an absent member is not a gap a program can route around, it is a boot failure.
   * Node's signatures are (path[, options], callback) for readdir and (path, callback) for the two stats.
   */
  readdir(path: FsPath, optionsOrCallback?: object | string | ReaddirCallback, maybeCallback?: ReaddirCallback): void;
  /**
   * `open` and `close`, callback and sync forms.
   *
   * Implemented over the VFS with a real per-shim table, so the descriptor is a number a caller can hold and close, exactly as Node's is.
   * `read`/`write` through a descriptor are NOT implemented: they refuse with a named error naming the fd and its path, because this VFS has
   * whole-file reads and writes and inventing positional semantics on top would be a guess dressed as an answer.
   */
  open(path: FsPath, flags: string | number, callback: (error: unknown, fd?: FileDescriptor) => void): void;
  openSync(path: FsPath, flags: string | number): FileDescriptor;
  close(fd: FileDescriptor, callback: (error: unknown) => void): void;
  closeSync(fd: FileDescriptor): void;
  /** Present, and refusing by name: this VFS reads and writes whole files, so positional descriptor I/O has no faithful answer here. */
  readSync(fd: FileDescriptor): never;
  /** Present for the same reason as `readSync`. */
  writeSync(fd: FileDescriptor): never;
  stat(path: FsPath, callback: StatCallback): void;
  /** No symlinks exist in this VFS, so `lstat` is `stat`. Documented rather than silently aliased. */
  lstat(path: FsPath, callback: StatCallback): void;
  /** `(path, atime, mtime, callback)`, seconds as in Node. */
  utimes(path: FsPath, atime: number | string | Date, mtime: number | string | Date, callback: CallbackOnly): void;
  /** `l` for "the link itself", which is `utimes` here because no path is a link. */
  lutimes(path: FsPath, atime: number | string | Date, mtime: number | string | Date, callback: CallbackOnly): void;
  /** Refused by name through the callback, so a promisified caller sees the refusal with a code rather than a missing function. */
  symlink(target: FsPath, path: FsPath, typeOrCallback?: string | CallbackOnly, maybeCallback?: CallbackOnly): void;
  /** Refused by name. See `refuseLink`. */
  link(existingPath: FsPath, newPath: FsPath, callback: CallbackOnly): void;
  /** Refused by name. See `refuseLink`. */
  readlink(path: FsPath, callback: CallbackOnly): void;
  /**
   * `realpathSync`, with Node's `.native` property hanging off it.
   *
   * Nothing in this VFS is a symbolic link, so there is no chain for a "native" variant to follow differently: `.native` is the same
   * implementation. It has to EXIST, though, because vite reads `require('fs').realpathSync.native` and dies on the property being undefined.
   */
  realpathSync: RealpathSync;
  /** Node's callback form, `(path[, options], callback)`. */
  realpath: RealpathCallback;
  promises: {
    readFile(path: string, encoding?: string | { encoding?: string }): Promise<Buffer | string>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    readdir(path: string, options?: ReaddirOptions | string): Promise<string[] | Dirent[]>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<StatsShim>;
    /** No symlinks exist in this VFS, so `lstat` is `stat`. Documented rather than silently aliased. */
    lstat(path: string): Promise<StatsShim>;
    /** Normalises and confirms existence. There is nothing to resolve, because no path is a link. */
    realpath(path: string): Promise<string>;
    /** Existence only: Node's mode argument is accepted and ignored, because there are no permission bits here. */
    access(path: string): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    rmdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    appendFile(path: string, data: string | Uint8Array, encoding?: string): Promise<void>;
    copyFile(from: string, to: string, mode?: number): Promise<void>;
    mkdtemp(prefix: string): Promise<string>;
    /** `(path, atime, mtime)`, seconds as in Node. */
    utimes(path: string, atime: number | string | Date, mtime: number | string | Date): Promise<void>;
    /** Refused by name: there is no link layer. See `refuseLink` and ADR-0026. */
    symlink(target: string, path: string, type?: string): Promise<never>;
    /** Refused by name, same reason. */
    link(existingPath: string, newPath: string): Promise<never>;
    /** Refused by name, same reason. */
    readlink(path: string, type?: string): Promise<never>;
    truncate(path: string, length?: number): Promise<void>;
    watch(path: string, options?: WatchOptions): WatchAsyncIterator;
  };
}

/**
 * An open file descriptor.
 *
 * Real: `open` and `close` are implemented over the VFS with a small table, because a caller that opens a file to prove it can (which is what
 * vite's bundled watcher does, in Node's own Windows EPERM workaround) needs a descriptor that round-trips through `close`. Reading and writing
 * THROUGH a descriptor is not implemented, and refuses by name rather than pretending: see the fd table below.
 */
export type FileDescriptor = number;

/** A Node-style callback as a parameter this file only forwards: the shape a caller supplies, not one this shim constructs. */
export type CallbackOnly = (...heard: never[]) => void;

/** Callback shapes for the three promisified members: `(error) | (error, value)`. */
export type ReaddirCallback = (error: unknown, entries?: string[] | Dirent[]) => void;
export type StatCallback = (error: unknown, stats?: StatsShim) => void;

/** The synchronous realpath, plus the `.native` property Node hangs off it (and that vite reads as `realpathSync.native`). */
export type RealpathSync = ((path: FsPath) => string) & { native: (path: FsPath) => string };

/** Node's callback form: (path[, options], callback). */
export type RealpathCallback = (
  path: FsPath,
  optionsOrCallback?: object | ((error: unknown, resolved?: string) => void),
  maybeCallback?: (error: unknown, resolved?: string) => void,
) => void;

export interface WatchOptions {
  readonly recursive?: boolean;
}

export type WatchListener = (eventType: "change" | "rename", filename: string) => void;

/** Absolute-path-only core. Everything outside this module goes through the cwd-aware wrapper below. */
/**
 * `fs.watch` for an absolute path.
 *
 * A named helper rather than an object-literal method because BOTH `fs.watch` and `fs.promises.watch` need it, and `this`
 * inside the `promises` literal is the promises object, not the shim. The type checker caught that immediately; had it been a
 * loosely typed property it would have been a runtime TypeError on the first call.
 */
const absoluteWatch = (
  watches: WatchSourcePort | undefined,
  path: string,
  listenerOrOptions?: WatchListener | WatchOptions,
  maybeListener?: WatchListener,
): WatchHandlePort => {
    if (watches === undefined) {
      // A typed refusal, not a silent no-op: a program that watches and never hears anything cannot tell that apart from a
      // file that never changed.
      throw Object.assign(new Error("fs.watch is not available in this runtime"), { code: "ENOSYS" });
    }
    const options: WatchOptions = typeof listenerOrOptions === "function" ? {} : (listenerOrOptions ?? {});
    const listener = typeof listenerOrOptions === "function" ? listenerOrOptions : maybeListener;
    if ((options as { encoding?: unknown }).encoding !== undefined) {
      throw Object.assign(new Error("fs.watch does not support the encoding option in this runtime"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    const handle = watches.watch(pathOf(path), options.recursive === true ? { recursive: true } : {});
    if (listener !== undefined) {
      handle.on("change", listener as (...args: never[]) => void);
      handle.on("rename", listener as (...args: never[]) => void);
    }
    return handle;
};

/** The members this layer DERIVES from its promise forms rather than writing out, so the literal below is typed without them. */
type DerivedFromPromises =
  | "readFile"
  | "writeFile"
  | "mkdir"
  | "unlink"
  | "rmdir"
  | "rename"
  | "rm"
  | "access"
  | "appendFile"
  | "copyFile"
  | "mkdtemp"
  | "truncate"
  | "utimes"
  | "lutimes"
  | "symlink"
  | "link"
  | "readlink";

/** The absolute layer as written: everything except the derived callback forms and the `.native` carriage the outer wrapper adds. */
type WrittenAbsoluteFsShim = Omit<FsShim, DerivedFromPromises | "promises" | "realpathSync"> & { realpathSync: (path: FsPath) => string };

/** The absolute layer as it is RETURNED: the written members, the promise members, and the callback forms derived from them. */
type AbsoluteFsShim = Omit<FsShim, "realpathSync"> & { realpathSync: (path: FsPath) => string };

/**
 * Node's callback form of a promise-returning member.
 *
 * ONE IMPLEMENTATION PER OPERATION. Node is layered this way itself: `fs.unlink` and `fs.promises.unlink` are the same work under two calling
 * conventions. Deriving one from the other means the path rewrite and error mapping already tested on the promise shape cannot drift from the
 * callback shape, and the callback stays the last argument, which is Node's contract for every member here.
 */
const asCallback = <R>(operation: (...args: never[]) => Promise<R>) => {
  return (...args: unknown[]): void => {
    const callback = args[args.length - 1] as (error: unknown, result?: R) => void;
    // Deferred through `Promise.resolve().then`, so a SYNCHRONOUS throw inside the operation lands in the rejection handler below instead of
    // escaping as an exception from a function whose whole contract is to call back. The refusal members (`symlink`, `link`, `readlink`) throw
    // synchronously by design, and Node's callback forms report them through the callback.
    Promise.resolve()
      .then(() => (operation as (...inner: unknown[]) => Promise<R>)(...args.slice(0, -1)))
      .then(
        (result) => {
          callback(null, result);
        },
        (error: unknown) => {
          callback(error);
        },
      );
  };
};

const createAbsoluteFsShim = (
  port: FileSystemPort,
  watches?: WatchSourcePort,
): // The absolute layer is not the object a program receives, so it does not carry Node's `.native` property: the wrapper below adds that,
// because `.native` is a property of the function the public `fs` exports and nowhere else.
AbsoluteFsShim => {

  /**
   * The open-descriptor table.
   *
   * A descriptor is an integer, as in Node, because that is what callers put on the wire and in logs. The number counts up from 3 (Node's 0/1/2
   * are the standard streams) and a closed descriptor is REUSED never, so a program holding a stale fd gets EBADF with the number it asked
   * about rather than a different file.
   */
  const openFiles = new Map<FileDescriptor, { path: string; flags: string }>();
  let nextDescriptor = 3;

  /** Node's string flags, reduced to the facts this VFS can act on: does it read, does it write, does it create, does it truncate. */
  const parseOpenFlags = (flags: string | number): string => {
    if (typeof flags === "number") {
      throw Object.assign(
        new Error(`fs.open numeric flags are not implemented in this runtime: pass a string flag such as "r" or "w"`),
        { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
      );
    }
    const known = ["r", "r+", "w", "w+", "a", "a+", "wx", "wx+", "ax", "ax+", "rs", "rs+"];
    if (!known.includes(flags)) {
      throw Object.assign(new Error(`Unknown file open flag: ${flags}`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    return flags;
  };

  /** Opens a descriptor against the VFS, applying the create/truncate side effects immediately, as Node does. */
  const openDescriptor = (path: string, flagsInput: string | number): FileDescriptor => {
    const flags = parseOpenFlags(flagsInput);
    const writes = flags.includes("w") || flags.includes("a") || flags.includes("+");
    const exclusive = flags.includes("x");
    const mustExist = !flags.includes("w") && !flags.includes("a");
    let exists = true;
    try {
      vfs.statSync(path);
    } catch {
      exists = false;
    }
    if (mustExist && !exists) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
        errno: -2,
        syscall: "open",
        path,
      });
    }
    if (exclusive && exists) {
      throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
        code: "EEXIST",
        errno: -17,
        syscall: "open",
        path,
      });
    }
    if (writes && !exists) vfs.writeFileSync(path, new Uint8Array(0));
    // Truncation is a real side effect of "w" and "w+", and applying it at open is what makes the descriptor mean the same thing it does in Node.
    if (flags.includes("w")) vfs.writeFileSync(path, new Uint8Array(0));
    const fd = nextDescriptor;
    nextDescriptor += 1;
    openFiles.set(fd, { path, flags });
    return fd;
  };

  /** Reads through a descriptor. Refused, and the refusal is the point: there is no positional read here to be faithful with. */
  const refuseDescriptorIo = (operation: string, fd: FileDescriptor): never => {
    const entry = openFiles.get(fd);
    throw Object.assign(
      new Error(
        `fs.${operation} on a file descriptor is not implemented in this runtime (fd ${fd}${entry === undefined ? "" : ` for '${entry.path}'`}): read and write whole files with readFile/writeFile`,
      ),
      { code: "ERR_NOT_IMPLEMENTED_IN_THIS_RUNTIME" },
    );
  };
  const vfs = pathAccepting(port);

  /**
   * The operations the sync twins and their promise forms share, written once.
   *
   * Every one of them is built out of VFS calls that already existed: this VFS has whole-file reads and writes, so append is read + concat +
   * write rather than a new port method that a Worker-backed substrate would then have to implement twice. The names were missing, not the
   * capability, and that distinction is the whole finding (docs/audit/api-surface-p0.md).
   */

  /** Whether a path exists, without throwing: the same probe `existsSync` is built on. */
  const exists = (path: string): boolean => {
    try {
      vfs.statSync(path);
      return true;
    } catch {
      return false;
    }
  };

  /** Bytes for a write-shaped argument: a string is encoded the way Node encodes it, bytes pass through untouched. */
  const bytesOf = (data: string | Uint8Array, encoding: unknown): Uint8Array =>
    typeof data === "string"
      ? new Uint8Array(Buffer.from(data, (encodingOf(encoding) ?? "utf8") as Parameters<Buffer["toString"]>[0]))
      : data;

  const concatBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first, 0);
    joined.set(second, first.length);
    return joined;
  };

  /**
   * Appends, creating the file when it is absent.
   *
   * A missing file is not an error here, and that is the whole point of the call: a reporter that appends its first line must not have to
   * check first, which is why `appendFileSync` is everywhere in build tooling.
   */
  const appendBytes = (path: string, data: string | Uint8Array, encoding: unknown): void => {
    const next = bytesOf(data, encoding);
    const existing = exists(path) ? (vfs.readFileSync(path) as Uint8Array) : new Uint8Array(0);
    vfs.writeFileSync(path, concatBytes(existing, next));
  };

  /** Copies bytes. `mode` carries COPYFILE_EXCL and nothing else, because that is the only bit Node documents for copyFile. */
  const copyBytes = (from: string, to: string, mode?: number): void => {
    if (mode !== undefined && (mode & ACCESS_CONSTANTS.COPYFILE_EXCL) !== 0 && exists(to)) {
      throw Object.assign(new Error(`EEXIST: file already exists, copyfile '${from}' -> '${to}'`), {
        code: "EEXIST",
        errno: -17,
        syscall: "copyfile",
        path: to,
      });
    }
    // The source is read before the destination is opened, so copying a file onto itself cannot truncate it first.
    vfs.writeFileSync(to, vfs.readFileSync(from) as Uint8Array);
  };

  /** Truncates or extends to `length` zero bytes. Both directions are truncation in Node's sense. */
  const truncateBytes = (path: string, length = 0): void => {
    if (!Number.isInteger(length) || length < 0) {
      throw Object.assign(new TypeError(`The "len" argument must be a non-negative integer. Received ${String(length)}`), {
        code: "ERR_OUT_OF_RANGE",
      });
    }
    const current = vfs.readFileSync(path) as Uint8Array;
    if (current.length === length) return;
    const next = new Uint8Array(length);
    next.set(current.subarray(0, length), 0);
    vfs.writeFileSync(path, next);
  };

  /**
   * A fresh directory under `prefix`, retried on collision.
   *
   * Node's suffix is six random characters. The alphabet here is base36, a smaller space than Node's, which is why the retry is not
   * decoration: EEXIST means "draw another name", and any other failure (a missing parent, a full VFS) must surface instead of spinning.
   */
  const makeTempDir = (prefix: string): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
      const candidate = `${prefix}${suffix}`;
      if (exists(candidate)) continue;
      vfs.mkdirSync(candidate, {});
      return candidate;
    }
    throw Object.assign(new Error(`EEXIST: file already exists, mkdtemp '${prefix}'`), {
      code: "EEXIST",
      errno: -17,
      syscall: "mkdtemp",
      path: prefix,
    });
  };

  /**
   * Recursive removal: the sync twin of `promises.rm`, children before parents.
   *
   * The promise form already walked a tree and `rmSync` did not exist at all, which meant the same operation had two behaviours depending on
   * which layer you called, and the sync one was a missing name rather than a different policy.
   */
  const removeTree = (path: string, recursive: boolean, force: boolean): void => {
    if (!exists(path)) {
      // `force` is Node's "missing is fine"; without it a missing path is ENOENT, not a silent success.
      if (force) return;
      throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${path}'`), {
        code: "ENOENT",
        errno: -2,
        syscall: "rm",
        path,
      });
    }
    if (vfs.statSync(path).kind === "dir") {
      if (!recursive) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, rm '${path}'`), {
          code: "EISDIR",
          errno: -21,
          syscall: "rm",
          path,
        });
      }
      for (const entry of vfs.readdirSync(path)) {
        removeTree(`${path === "/" ? "" : path}/${entry}`, true, true);
      }
      vfs.rmdirSync(path);
      return;
    }
    vfs.unlinkSync(path);
  };

  const shim: WrittenAbsoluteFsShim = {
  watch: (path, listenerOrOptions, maybeListener) =>
    absoluteWatch(watches, path, listenerOrOptions, maybeListener),

  readFileSync(path, encoding) {
    let wanted: string | undefined;
    try {
      wanted = encodingOf(encoding);
    } catch (error) {
      throw error;
    }
    try {
      const out = wanted === "utf8" ? vfs.readFileSync(path, "utf8") : vfs.readFileSync(path);
      if (wanted === undefined) return typeof out === "string" ? asBuffer(out) : asBuffer(out);
      return typeof out === "string" && wanted === "utf8" ? out : decodeAs(typeof out === "string" ? Buffer.from(out) : out, wanted);
    } catch (error) {
      // An encoding refusal names the encoding, not a file, so it must not be dressed up as an fs error with a path and syscall.
      if ((error as { code?: string }).code === "ERR_UNKNOWN_ENCODING") throw error;
      throw toNodeError(error, "open", path);
    }
  },

  writeFileSync(path, data) {
    try {
      vfs.writeFileSync(path, data);
    } catch (error) {
      throw toNodeError(error, "open", path);
    }
  },

  existsSync(path) {
    // Node's existsSync is the one API that returns false instead of throwing.
    try {
      vfs.statSync(path);
      return true;
    } catch {
      return false;
    }
  },

  mkdirSync(path, options) {
    try {
      vfs.mkdirSync(path, options ?? {});
    } catch (error) {
      throw toNodeError(error, "mkdir", path);
    }
  },

  readdirSync(path, options) {
    const resolvedPath = pathOf(path);
    try {
      const names = vfs.readdirSync(resolvedPath);
      return typeof options === "object" && options?.withFileTypes === true ? direntsOf(vfs, resolvedPath, names) : names;
    } catch (error) {
      throw toNodeError(error, "scandir", path);
    }
  },

  open(path: FsPath, flags: string | number, callback: (error: unknown, fd?: FileDescriptor) => void) {
    try {
      callback(null, openDescriptor(pathOf(path), flags));
    } catch (error) {
      callback(error);
    }
  },

  openSync(path: FsPath, flags: string | number) {
    return openDescriptor(pathOf(path), flags);
  },

  close(fd: FileDescriptor, callback: (error: unknown) => void) {
    try {
      this.closeSync(fd);
      callback(null);
    } catch (error) {
      callback(error);
    }
  },

  closeSync(fd: FileDescriptor) {
    if (!openFiles.has(fd)) {
      throw Object.assign(new Error(`EBADF: bad file descriptor, close`), {
        code: "EBADF",
        errno: -9,
        syscall: "close",
      });
    }
    openFiles.delete(fd);
  },

  /** Present so a program that reads through a descriptor learns the truth by name instead of reading a wrong answer. */
  readSync(fd: FileDescriptor): never {
    return refuseDescriptorIo("readSync", fd);
  },

  /** Present for the same reason as `readSync`. */
  writeSync(fd: FileDescriptor): never {
    return refuseDescriptorIo("writeSync", fd);
  },

  /** Callback `readdir`. The error, when there is one, is the same mapped error the sync form throws: one source of truth for the code. */
  readdir(path: FsPath, optionsOrCallback?: object | string | ReaddirCallback, maybeCallback?: ReaddirCallback) {
    // Node's overloads: `readdir(path, callback)` and `readdir(path, options, callback)`, where options may be just an encoding.
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const resolvedPath = pathOf(path);
    let entries: string[] | Dirent[];
    try {
      const names = vfs.readdirSync(resolvedPath);
      entries = typeof options === "object" && (options as ReaddirOptions).withFileTypes === true
        ? direntsOf(vfs, resolvedPath, names)
        : names;
    } catch (error) {
      callback?.(toNodeError(error, "scandir", resolvedPath));
      return;
    }
    callback?.(null, entries);
  },

  stat(path: FsPath, callback: StatCallback) {
    const resolvedPath = pathOf(path);
    try {
      callback(null, asStats(vfs.statSync(resolvedPath)));
    } catch (error) {
      callback(toNodeError(error, "stat", resolvedPath));
    }
  },

  /** `lstat` is `stat`, as above, because nothing in this VFS is a symbolic link. */
  lstat(path: FsPath, callback: StatCallback) {
    const resolvedPath = pathOf(path);
    try {
      callback(null, asStats(vfs.statSync(resolvedPath)));
    } catch (error) {
      callback(toNodeError(error, "lstat", resolvedPath));
    }
  },

  statSync(path) {
    try {
      return asStats(vfs.statSync(path));
    } catch (error) {
      throw toNodeError(error, "stat", path);
    }
  },

  /**
   * `realpathSync`: existence and a normalised path, and nothing more, because nothing in this VFS is a symbolic link.
   *
   * A missing path still throws ENOENT with `syscall: "realpath"`, which is what callers branch on. The `.native` property is assigned in the
   * path-rewriting layer below, where the shape is built, because Node exposes `realpathSync.native` as a property OF this function.
   */
  realpathSync(path: FsPath) {
    const resolvedPath = pathOf(path);
    try {
      vfs.statSync(resolvedPath);
    } catch (error) {
      throw toNodeError(error, "realpath", resolvedPath);
    }
    return nodePath.normalize(resolvedPath);
  },

  /** The callback form, which takes the same options object Node accepts and then calls back. */
  realpath(
    path: FsPath,
    optionsOrCallback?: object | ((error: unknown, resolved?: string) => void),
    maybeCallback?: (error: unknown, resolved?: string) => void,
  ) {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const resolvedPath = pathOf(path);
    try {
      vfs.statSync(resolvedPath);
      callback?.(null, nodePath.normalize(resolvedPath));
    } catch (error) {
      // The same mapped error the sync form throws, so both shapes of this call report the same code and syscall.
      callback?.(toNodeError(error, "realpath", resolvedPath));
    }
  },

  statManySync(paths) {
    const many = vfs.statManySync;
    if (many !== undefined) return many.call(vfs, paths).map((stats) => (stats === null ? null : asStats(stats)));
    return paths.map((path) => {
      try {
        return asStats(vfs.statSync(path));
      } catch {
        return null;
      }
    });
  },

  unlinkSync(path) {
    try {
      vfs.unlinkSync(path);
    } catch (error) {
      throw toNodeError(error, "unlink", path);
    }
  },

  rmdirSync(path) {
    try {
      vfs.rmdirSync(path);
    } catch (error) {
      throw toNodeError(error, "rmdir", path);
    }
  },

  renameSync(from, to) {
    try {
      vfs.renameSync(from, to);
    } catch (error) {
      throw toNodeError(error, "rename", from);
    }
  },

  rmSync(path, options) {
    try {
      removeTree(pathOf(path), options?.recursive === true, options?.force === true);
    } catch (error) {
      throw toNodeError(error, "rm", path);
    }
  },

  appendFileSync(path, data, encoding) {
    try {
      appendBytes(pathOf(path), data, encoding);
    } catch (error) {
      throw toNodeError(error, "open", path);
    }
  },

  copyFileSync(from, to, mode) {
    try {
      copyBytes(pathOf(from), pathOf(to), mode);
    } catch (error) {
      throw toNodeError(error, "copyfile", from);
    }
  },

  accessSync(path) {
    try {
      vfs.statSync(path);
    } catch (error) {
      throw toNodeError(error, "access", path);
    }
  },

  mkdtempSync(prefix) {
    try {
      return makeTempDir(prefix);
    } catch (error) {
      throw toNodeError(error, "mkdtemp", prefix);
    }
  },

  truncateSync(path, length) {
    try {
      truncateBytes(pathOf(path), length);
    } catch (error) {
      throw toNodeError(error, "open", path);
    }
  },

  /** `statSync` with `lstat` as its syscall, because nothing here is a link: the same answer, reported under the name that was asked for. */
  lstatSync(path) {
    try {
      return asStats(vfs.statSync(path));
    } catch (error) {
      throw toNodeError(error, "lstat", path);
    }
  },

  /**
   * `utimesSync`: Node takes SECONDS, the VFS stores milliseconds, and this is the one place the two meet.
   *
   * The substrate is asked whether it can set times at all, rather than assumed to: a port without `utimesSync` gets a named refusal instead of
   * a call that silently does nothing.
   */
  utimesSync(path, _atime, mtime) {
    // `atime` is accepted and NOT stored: this VFS has no access-time accounting, and inventing one would make every read a write to the node.
    // It is VALIDATED anyway, because Node refuses a value there it cannot read as a time and a caller who passes garbage deserves the same
    // answer here rather than a silent success.
    secondsToMilliseconds(_atime, "atime");
    const resolvedPath = pathOf(path);
    if (resolvedPath === "/") {
      throw Object.assign(
        new Error(
          "ERR_NOT_SUPPORTED: fs.utimes cannot set a time on the root directory: it is derived rather than stored, so it has no timestamp " +
            "field to write. See docs/decisions/ADR-0026.md.",
        ),
        { code: "ERR_NOT_SUPPORTED", syscall: "utime", path: resolvedPath },
      );
    }
    const setTimes = vfs.utimesSync?.bind(vfs);
    if (setTimes === undefined) {
      throw Object.assign(new Error("ERR_NOT_SUPPORTED: this filesystem does not store timestamps, so fs.utimesSync cannot set one"), {
        code: "ERR_NOT_SUPPORTED",
      });
    }
    try {
      setTimes(resolvedPath, secondsToMilliseconds(mtime, "mtime"));
    } catch (error) {
      throw toNodeError(error, "utime", path);
    }
  },

  /** `l` for "the link itself", and no path here is a link, so this is `utimesSync` under the name the caller used. */
  lutimesSync(path, atime, mtime) {
    shim.utimesSync(path, atime, mtime);
  },

  symlinkSync(target) {
    return refuseLink(`symlinkSync (${String(target)})`);
  },

  linkSync() {
    return refuseLink("linkSync");
  },

  readlinkSync() {
    return refuseLink("readlinkSync");
  },

  Stats,

  constants: ACCESS_CONSTANTS,

  };

  /**
   * The promise-returning members, named once so Node's callback forms can be DERIVED from them below rather than reimplemented: both calling
   * conventions then share one path rewrite and one error map, which is exactly how Node layers them.
   */
  const promises: FsShim["promises"] = {
    async utimes(path, atime, mtime) {
      shim.utimesSync(path, atime, mtime);
    },
    /**
     * The link refusals in promise shape, as REJECTIONS.
     *
     * A synchronous throw from a promise-returning member is not the shape its callers use: `fn(...).catch(...)` and `expect(p).rejects` both
     * throw at the call site before a promise exists, so the refusal would escape as an unexpected exception rather than arriving where the
     * caller is waiting for it. Rejecting is also exactly what Node does (`fs.promises.symlink` rejects with a coded error), and the cost is
     * the one Node already accepts: a caller who ignores the promise gets an unhandled rejection, which is a bug in their code, not a surprise.
     */
    async symlink(target, path) {
      return refuseLink(`promises.symlink (${String(target)} -> ${String(path)})`);
    },
    async link(existingPath, newPath) {
      return refuseLink(`promises.link (${String(existingPath)} -> ${String(newPath)})`);
    },
    async readlink(path) {
      return refuseLink(`promises.readlink (${String(path)})`);
    },
    watch(path, watchOptions) {
      return toWatchAsyncIterator(absoluteWatch(watches, path, watchOptions));
    },
    async readFile(path, encoding) {
      const wanted = encodingOf(encoding);
      try {
        const out = wanted === "utf8" ? await vfs.readFile(path, "utf8") : await vfs.readFile(path);
        if (wanted === undefined) return asBuffer(out);
        return typeof out === "string" && wanted === "utf8" ? out : decodeAs(typeof out === "string" ? Buffer.from(out) : out, wanted);
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_UNKNOWN_ENCODING") throw error;
        throw toNodeError(error, "open", path);
      }
    },
    async writeFile(path, data) {
      try {
        await vfs.writeFile(path, data);
      } catch (error) {
        throw toNodeError(error, "open", path);
      }
    },
    async mkdir(path, options) {
      try {
        await vfs.mkdir(path, options ?? {});
      } catch (error) {
        throw toNodeError(error, "mkdir", path);
      }
    },
    async readdir(path, options) {
      try {
        const names = await vfs.readdir(path);
        return typeof options === "object" && options?.withFileTypes === true ? direntsOf(vfs, path, names) : names;
      } catch (error) {
        throw toNodeError(error, "scandir", path);
      }
    },
    async unlink(path) {
      try {
        await vfs.unlink(path);
      } catch (error) {
        throw toNodeError(error, "unlink", path);
      }
    },
    async stat(path) {
      // The port's promise forms resolve from the sync call, and its doc says so: in a Worker the sync call already blocks, so
      // there is nothing to gain from a second implementation that could drift from this one.
      try {
        return asStats(vfs.statSync(path));
      } catch (error) {
        throw toNodeError(error, "stat", path);
      }
    },
    async lstat(path) {
      return this.stat(path);
    },
    async realpath(path) {
      // Existence and a normalised path are all this VFS can honestly offer: nothing here is a symbolic link, so there is no chain to
      // follow. A missing path still fails the way Node fails, because callers branch on that.
      await this.stat(path);
      return path;
    },
    async access(path) {
      await this.stat(path);
    },
    async rm(path, rmOptions) {
      const recursive = rmOptions?.recursive === true;
      const force = rmOptions?.force === true;
      try {
        // `kind` is the port's word for it; `isDirectory()` is Node's, and it exists only on the shim's Stats.
        const stats = vfs.statSync(path);
        if (stats.kind === "dir") {
          if (!recursive) throw toNodeError(new Error("EISDIR"), "rm", path);
          for (const entry of vfs.readdirSync(path)) {
            await this.rm(`${path === "/" ? "" : path}/${entry}`, { recursive: true, force: true });
          }
          vfs.rmdirSync(path);
          return;
        }
        vfs.unlinkSync(path);
      } catch (error) {
        // `force: true` is Node's "missing is fine", and vite passes it for cache directories that may never have existed.
        if (force && (error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
    },
    async rmdir(path, rmdirOptions) {
      try {
        // `recursive` is Node's deprecated-but-supported "remove the contents too". The VFS rmdir refuses a non-empty directory by design, so the
        // recursion lives here: children first, then the directory itself. Without this flag a non-empty directory still fails with ENOTEMPTY.
        if (rmdirOptions?.recursive === true) {
          for (const entry of vfs.readdirSync(path)) {
            const child = `${path === "/" ? "" : path}/${entry}`;
            const stats = vfs.statSync(child);
            if (stats.kind === "dir") await promises.rmdir(child, { recursive: true });
            else vfs.unlinkSync(child);
          }
        }
        vfs.rmdirSync(path);
      } catch (error) {
        throw toNodeError(error, "rmdir", path);
      }
    },
    async rename(from, to) {
      try {
        vfs.renameSync(from, to);
      } catch (error) {
        throw toNodeError(error, "rename", from);
      }
    },
    // The promise surface trails the callback surface in Node, and here it trailed in BOTH directions: these are the same helpers the sync
    // members call, so the two conventions cannot disagree about what appending or truncating means.
    async appendFile(path, data, encoding) {
      try {
        appendBytes(pathOf(path), data, encoding);
      } catch (error) {
        throw toNodeError(error, "open", path);
      }
    },
    async copyFile(from, to, mode) {
      try {
        copyBytes(pathOf(from), pathOf(to), mode);
      } catch (error) {
        throw toNodeError(error, "copyfile", from);
      }
    },
    async mkdtemp(prefix) {
      try {
        return makeTempDir(prefix);
      } catch (error) {
        throw toNodeError(error, "mkdtemp", prefix);
      }
    },
    async truncate(path, length) {
      try {
        truncateBytes(pathOf(path), length);
      } catch (error) {
        throw toNodeError(error, "open", path);
      }
    },
  };

  // The callback forms Node exposes beside each promise form, derived rather than reimplemented. Bound through arrow wrappers because several promise
  // members call their siblings through `this` (`lstat` is `stat`, `realpath` and `access` confirm through `stat`, `rm` recurses), and a bare method
  // reference would lose that binding.
  return {
    ...shim,
    promises,
    readFile: asCallback((path: FsPath, optionsOrEncoding?: string | { encoding?: string }) => promises.readFile(pathOf(path), optionsOrEncoding)),
    writeFile: asCallback((path: FsPath, data: string | Uint8Array) => promises.writeFile(pathOf(path), data)),
    mkdir: asCallback((path: FsPath, mkdirOptions?: { recursive?: boolean }) => promises.mkdir(pathOf(path), mkdirOptions)),
    unlink: asCallback((path: FsPath) => promises.unlink(pathOf(path))),
    rmdir: asCallback((path: FsPath, rmdirOptions?: { recursive?: boolean }) => promises.rmdir(pathOf(path), rmdirOptions)),
    rename: asCallback((from: FsPath, to: FsPath) => promises.rename(pathOf(from), pathOf(to))),
    rm: asCallback((path: FsPath, rmOptions?: { recursive?: boolean; force?: boolean }) => promises.rm(pathOf(path), rmOptions)),
    access: asCallback((path: FsPath) => promises.access(pathOf(path))),
    appendFile: asCallback((path: FsPath, data: string | Uint8Array, encoding?: string) =>
      promises.appendFile(pathOf(path), data, encoding),
    ),
    copyFile: asCallback((from: FsPath, to: FsPath, mode?: number) => promises.copyFile(pathOf(from), pathOf(to), mode)),
    mkdtemp: asCallback((prefix: string) => promises.mkdtemp(prefix)),
    truncate: asCallback((path: FsPath, length?: number) => promises.truncate(pathOf(path), length)),
    utimes: asCallback((path: FsPath, atime: number | string | Date, mtime: number | string | Date) =>
      promises.utimes(pathOf(path), atime, mtime),
    ),
    // `l` for "the link itself", and no path here is a link, so this is the same operation under the name the caller used.
    lutimes: asCallback((path: FsPath, atime: number | string | Date, mtime: number | string | Date) =>
      promises.utimes(pathOf(path), atime, mtime),
    ),
    symlink: asCallback((target: FsPath, path: FsPath, linkType?: string) =>
      promises.symlink(pathOf(target), pathOf(path), linkType),
    ),
    link: asCallback((existingPath: FsPath, newPath: FsPath) => promises.link(pathOf(existingPath), pathOf(newPath))),
    readlink: asCallback((path: FsPath, linkType?: string) => promises.readlink(pathOf(path), linkType)),
  };
};

/**
 * The shim user code sees: Node resolves a relative path against the process working directory, and the VFS only knows
 * absolute ones. Without this, `fs.readFileSync("sample.txt")` from a script started in /app looks for /sample.txt, and
 * every ordinary CLI fails with ENOENT while the file sits exactly where the author put it.
 *
 * Error mapping lives in the absolute shim, so this layer only rewrites paths and cannot change how failures surface.
 */
export const createFsShim = (
  vfs: FileSystemPort,
  options: { readonly cwd?: string; readonly watches?: WatchSourcePort } = {},
): FsShim => {
  const cwd = options.cwd ?? "/";
  const at = (value: FsPath): string => {
    // A URL is absolute by construction, so it is converted before the leading-slash test rather than resolved against cwd.
    const path = pathOf(value);
    return path.startsWith("/") ? path : nodePath.resolve(cwd, path);
  };
  /**
   * The path `mkdtemp` created, written the way the caller wrote its prefix.
   *
   * `at()` resolves and may normalise the prefix; Node reports the path it made, so the random suffix is appended to the caller's own string
   * instead of an absolutised one. The suffix is whatever follows the resolved prefix, which is why the two lengths are compared rather than
   * assumed.
   */
  const asGiven = (prefix: string, resolvedPrefix: string, created: string): string => {
    const base = resolvedPrefix.endsWith("/") && resolvedPrefix !== "/" ? resolvedPrefix.slice(0, -1) : resolvedPrefix;
    return `${prefix.replace(/\/+$/, "")}${created.slice(base.length)}`;
  };

  const inner = createAbsoluteFsShim(vfs, options.watches);

  /**
   * Node's `(path[, options], callback)` argument shape, resolved before forwarding.
   *
   * The callback may be in EITHER position: a caller can write `fs.readFile(p, cb)` or `promisify(fs.readFile)(p, opts)`-style
   * `fs.readFile(p, { encoding }, cb)`. Passing the raw tail through would leave a derived callback form holding `undefined` as its callback when
   * the short shape is used, so the two positions are resolved here, once, for every member that takes optional options.
   */
  const callbackOf = (
    optionsOrCallback: unknown,
    maybeCallback: ((...heard: never[]) => void) | undefined,
  ): [unknown, (...heard: never[]) => void] => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (...heard: never[]) => void;
    return [typeof optionsOrCallback === "function" ? undefined : optionsOrCallback, callback];
  };

  const realpathSync = Object.assign((path: FsPath) => inner.realpathSync(at(path)), {
    native: (path: FsPath) => inner.realpathSync(at(path)),
  });

  return {
    realpathSync,
    // Forwarded uncast, in both shapes Node accepts: `promisify(fs.realpath)` — which is how vite's bundled watcher calls it — passes the
    // callback as the SECOND argument, so both positions have to survive this wrapper. The cast that used to be here was only a type-level
    // lie (the value still arrived at runtime and the call DID work), but it described the wrapper as taking one shape while it accepted two,
    // which is how a real regression would have been introduced without a test noticing.
    realpath: (path, optionsOrCallback, maybeCallback) => inner.realpath(at(path), optionsOrCallback, maybeCallback),
    readFileSync: (path, encoding) => inner.readFileSync(at(path), encoding),
    writeFileSync: (path, data) => inner.writeFileSync(at(path), data),
    existsSync: (path) => inner.existsSync(at(path)),
    mkdirSync: (path, mkdirOptions) => inner.mkdirSync(at(path), mkdirOptions),
    readdirSync: (path, options) => inner.readdirSync(at(path), options),
    // Every path is rewritten before the batch is sent, so the caller batches relative paths and the port sees absolute ones.
    statManySync: (paths) => inner.statManySync(paths.map(at)),
    statSync: (path) => inner.statSync(at(path)),
    readdir: (path, optionsOrCallback, maybeCallback) =>
      inner.readdir(at(path), optionsOrCallback, maybeCallback),
    open: (path, flags, callback) => inner.open(at(path), flags, callback),
    openSync: (path, flags) => inner.openSync(at(path), flags),
    close: (fd, callback) => inner.close(fd, callback),
    closeSync: (fd) => inner.closeSync(fd),
    readSync: (fd) => inner.readSync(fd),
    writeSync: (fd) => inner.writeSync(fd),
    stat: (path, callback) => inner.stat(at(path), callback),
    lstat: (path, callback) => inner.lstat(at(path), callback),
    utimes: (path, atime, mtime, callback) => inner.utimes(at(path), atime, mtime, callback),
    lutimes: (path, atime, mtime, callback) => inner.lutimes(at(path), atime, mtime, callback),
    // The refusals still rewrite their paths first, so the message names the path the program actually passed. `symlink` takes an OPTIONAL
    // type before the callback, so the two positions are resolved here the way every other optional-options member resolves them: forwarding
    // the raw tail put `undefined` where the callback belonged, and the callback then never fired at all.
    symlink: (target, path, typeOrCallback, maybeCallback) => {
      const [linkType, callback] = callbackOf(typeOrCallback, maybeCallback);
      inner.symlink(at(target), at(path), linkType as string | undefined, callback);
    },
    link: (existingPath, newPath, callback) => inner.link(at(existingPath), at(newPath), callback),
    readlink: (path, callback) => inner.readlink(at(path), callback),
    utimesSync: (path, atime, mtime) => inner.utimesSync(at(path), atime, mtime),
    lutimesSync: (path, atime, mtime) => inner.lutimesSync(at(path), atime, mtime),
    symlinkSync: (target, path, type) => inner.symlinkSync(at(target), at(path), type),
    linkSync: (existingPath, newPath) => inner.linkSync(at(existingPath), at(newPath)),
    readlinkSync: (path) => inner.readlinkSync(at(path)),
    // The callback forms, one per promise member. Only the PATH is this layer's business: rewriting before the call is what makes a relative path
    // mean the program's cwd, exactly as the sync members above do.
    readFile: (path, optionsOrCallback, maybeCallback) => {
      const [options, callback] = callbackOf(optionsOrCallback, maybeCallback);
      inner.readFile(at(path), options as string | { encoding?: string } | undefined, callback);
    },
    writeFile: (path, data, callback) => inner.writeFile(at(path), data, callback),
    mkdir: (path, optionsOrCallback, maybeCallback) => {
      const [mkdirOptions, callback] = callbackOf(optionsOrCallback, maybeCallback);
      inner.mkdir(at(path), mkdirOptions as { recursive?: boolean } | undefined, callback);
    },
    unlink: (path, callback) => inner.unlink(at(path), callback),
    rmdir: (path, optionsOrCallback, maybeCallback) => {
      const [rmdirOptions, callback] = callbackOf(optionsOrCallback, maybeCallback);
      inner.rmdir(at(path), rmdirOptions as { recursive?: boolean } | undefined, callback);
    },
    rename: (from, to, callback) => inner.rename(at(from), at(to), callback),
    rm: (path, optionsOrCallback, maybeCallback) => {
      const [rmOptions, callback] = callbackOf(optionsOrCallback, maybeCallback);
      inner.rm(at(path), rmOptions as { recursive?: boolean; force?: boolean } | undefined, callback);
    },
    access: (path, callback) => inner.access(at(path), callback),
    appendFile: (path, data, optionsOrCallback, maybeCallback) => {
      const [encoding, callback] = callbackOf(optionsOrCallback, maybeCallback);
      inner.appendFile(at(path), data, encoding as string | undefined, callback);
    },
    copyFile: (from, to, modeOrCallback, maybeCallback) => {
      const [mode, callback] = callbackOf(modeOrCallback, maybeCallback);
      inner.copyFile(at(from), at(to), mode as number | undefined, callback);
    },
    truncate: (path, lengthOrCallback, maybeCallback) => {
      const [length, callback] = callbackOf(lengthOrCallback, maybeCallback);
      inner.truncate(at(path), length as number | undefined, callback);
    },
    // `mkdtemp`'s prefix is a PATH like any other, and its answer has to come back in the caller's own shape: Node returns the path it
    // created, not an absolutised one, so `mkdtempSync("./run-")` yields "./run-abc123" here too.
    mkdtemp: (prefix, callback) => {
      const base = at(prefix);
      inner.mkdtemp(base, (error: unknown, made?: string) =>
        (callback as (error: unknown, made?: string) => void)(error, made === undefined ? undefined : asGiven(prefix, base, made)),
      );
    },
    unlinkSync: (path) => inner.unlinkSync(at(path)),
    rmdirSync: (path) => inner.rmdirSync(at(path)),
    renameSync: (from, to) => inner.renameSync(at(from), at(to)),
    rmSync: (path, rmOptions) => inner.rmSync(at(path), rmOptions),
    appendFileSync: (path, data, encoding) => inner.appendFileSync(at(path), data, encoding),
    copyFileSync: (from, to, mode) => inner.copyFileSync(at(from), at(to), mode),
    accessSync: (path) => inner.accessSync(at(path)),
    truncateSync: (path, length) => inner.truncateSync(at(path), length),
    lstatSync: (path) => inner.lstatSync(at(path)),
    mkdtempSync: (prefix) => {
      const base = at(prefix);
      return asGiven(prefix, base, inner.mkdtempSync(base));
    },
    // Passed through rather than reconstructed: one class, so `instanceof` agrees with the object a stat actually returns.
    Stats,
    constants: ACCESS_CONSTANTS,
    watch: (path, listenerOrOptions, maybeListener) =>
      inner.watch(at(path), listenerOrOptions, maybeListener),
    promises: {
      utimes: (path, atime, mtime) => inner.promises.utimes(at(path), atime, mtime),
      symlink: (target, path, linkType) => inner.promises.symlink(at(target), at(path), linkType),
      link: (existingPath, newPath) => inner.promises.link(at(existingPath), at(newPath)),
      readlink: (path, linkType) => inner.promises.readlink(at(path), linkType),
      watch: (path, watchOptions) => inner.promises.watch(at(path), watchOptions),
      readFile: (path, encoding) => inner.promises.readFile(at(path), encoding),
      writeFile: (path, data) => inner.promises.writeFile(at(path), data),
      mkdir: (path, mkdirOptions) => inner.promises.mkdir(at(path), mkdirOptions),
      readdir: (path, options) => inner.promises.readdir(at(path), options),
      unlink: (path) => inner.promises.unlink(at(path)),
      stat: (path) => inner.promises.stat(at(path)),
      lstat: (path) => inner.promises.lstat(at(path)),
      realpath: (path) => inner.promises.realpath(at(path)),
      access: (path) => inner.promises.access(at(path)),
      appendFile: (path, data, encoding) => inner.promises.appendFile(at(path), data, encoding),
      copyFile: (from, to, mode) => inner.promises.copyFile(at(from), at(to), mode),
      truncate: (path, length) => inner.promises.truncate(at(path), length),
      mkdtemp: (prefix) => {
        const base = at(prefix);
        return inner.promises.mkdtemp(base).then((made) => asGiven(prefix, base, made));
      },
      rm: (path, rmOptions) => inner.promises.rm(at(path), rmOptions),
      rmdir: (path, rmdirOptions) => inner.promises.rmdir(at(path), rmdirOptions),
      rename: (from, to) => inner.promises.rename(at(from), at(to)),
    },
  };
};
