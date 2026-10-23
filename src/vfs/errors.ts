/**
 * Typed VFS errors.
 *
 * WHY typed errors instead of plain `Error`: the `fs` shim (ADR-0002 #7)
 * must surface Node-compatible error codes, and callers must distinguish
 * quota failure (EFBIG) from a missing file (ENOENT) without string
 * matching on messages.
 */
export type VfsErrorCode =
  | "EINVAL"
  | "ENOENT"
  | "EEXIST"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EFBIG";

export class VFSError extends Error {
  readonly code: VfsErrorCode;
  readonly path: string;

  constructor(code: VfsErrorCode, path: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.path = path;
  }
}

/** EINVAL — a path (or path/encoding argument) cannot be used at all. */
export class VFSInvalidPathError extends VFSError {
  constructor(path: string, reason: string) {
    super("EINVAL", path, `Invalid path ${JSON.stringify(path)}: ${reason}`);
  }
}

/** ENOENT — nothing exists at the path. */
export class VFSNotFoundError extends VFSError {
  constructor(path: string) {
    super("ENOENT", path, `ENOENT: no such file or directory, '${path}'`);
  }
}

/** EEXIST — a file or directory already occupies the path. */
export class VFSPathExistsError extends VFSError {
  constructor(path: string) {
    super("EEXIST", path, `EEXIST: file already exists, '${path}'`);
  }
}

/** EISDIR — the operation targets a directory where a file is required. */
export class VFSIsADirectoryError extends VFSError {
  constructor(path: string) {
    super("EISDIR", path, `EISDIR: illegal operation on a directory, '${path}'`);
  }
}

/** ENOTDIR — a path component that must be a directory is a file. */
export class VFSNotADirectoryError extends VFSError {
  constructor(path: string) {
    super("ENOTDIR", path, `ENOTDIR: not a directory, '${path}'`);
  }
}

/** ENOTEMPTY — rename would overwrite a non-empty directory. */
export class VFSNotEmptyError extends VFSError {
  constructor(path: string) {
    super("ENOTEMPTY", path, `ENOTEMPTY: directory not empty, '${path}'`);
  }
}

/** EINVAL — an unsupported encoding was requested. */
export class VFSInvalidEncodingError extends VFSError {
  constructor(path: string, encoding: string) {
    super("EINVAL", path, `Invalid encoding '${encoding}' for '${path}': expected 'utf8'`);
  }
}

/**
 * EFBIG — the write exceeds the per-file size cap from ADR-0002 #4.
 * A typed error instead of an OOM: the caller can catch and recover.
 */
export class VFSQuotaExceededError extends VFSError {
  readonly attemptedBytes: number;
  readonly limit: number;

  constructor(path: string, attemptedBytes: number, limit: number) {
    super(
      "EFBIG",
      path,
      `EFBIG: file too large: ${attemptedBytes} bytes exceeds the ${limit}-byte per-file limit: '${path}'`,
    );
    this.attemptedBytes = attemptedBytes;
    this.limit = limit;
  }
}
