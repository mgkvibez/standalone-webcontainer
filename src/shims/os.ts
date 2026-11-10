/**
 * `os`, answered from what this runtime actually is rather than from a guess about the host machine.
 *
 * The surface here is measured, not copied. Vite's eight real packages call exactly six members, found by grepping the frozen
 * tarballs rather than by guessing from Node's documentation:
 *
 *   os.cpus()        once, as `Math.max(os.cpus().length, 1)` for the default thread-pool size
 *   os.type()        twice, both times `=== 'OS400'`
 *   os.release()     twice, once for WSL detection via `.includes('microsoft')`
 *   os.platform()    twice
 *   os.arch()        twice, both inside esbuild's `${process.platform} ${os.arch()} ${os.endianness()}` platform key
 *   os.endianness()  twice, same key
 *
 * Those are implemented. Everything else in Node's `os` is refused by name, because the alternative is returning a zero or an empty
 * string for a question whose true answer is "this runtime cannot know". A package that reads `os.totalmem()` and gets 0 will
 * misbehave somewhere far away from the cause; a package that calls it and is told the truth fails where the mistake is.
 *
 * `cpus()` returns an empty array rather than a synthetic core, for the same reason: the number of host cores is not something a
 * browser sandbox can honestly report, and the one caller that matters already clamps it (`Math.max(length, 1)`).
 */

export interface OsShimOptions {
  /**
   * Must be the value `process.platform` reports.
   *
   * Two answers to one question is a real defect, not a style point: esbuild builds its native-package key from `process.platform`
   * and `os.arch()` together, so a mismatch sends it looking for a package that cannot exist.
   */
  readonly platform: string;
}

/** The six members the measured graph needs, plus the end-of-line constant that costs nothing to be right about. */
export interface OsShim {
  platform(): string;
  arch(): string;
  endianness(): string;
  type(): string;
  release(): string;
  cpus(): readonly unknown[];
  readonly EOL: string;
  [member: string]: unknown;
}

const unsupported = (member: string): Error => {
  const error = new Error(
    `ERR_NOT_SUPPORTED: os.${member}() is not available in this runtime: a browser sandbox cannot observe the host machine, and ` +
      "answering with a zero or an empty string would be a quieter lie than this refusal",
  ) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  return error;
};

export function createOsShim(options: OsShimOptions): OsShim {
  const shim: OsShim = {
    platform: () => options.platform,
    // WASM32 is a little-endian target, so this one is a fact rather than a guess.
    arch: () => "wasm32",
    endianness: () => "LE",
    // Not "Linux": the runtime is not running on one, and every comparison in the measured graph is against a string that is
    // neither of these ('OS400', 'microsoft'), so a truthful value costs nothing.
    type: () => "Browser",
    release: () => "",
    cpus: () => [],
    EOL: "\n",
    // Named refusals rather than absent members: `os.totalmem is not a function` reads as a bug in this runtime, while the message
    // above says what is true and what to do about it.
    totalmem: () => {
      throw unsupported("totalmem");
    },
    freemem: () => {
      throw unsupported("freemem");
    },
    uptime: () => {
      throw unsupported("uptime");
    },
    loadavg: () => {
      throw unsupported("loadavg");
    },
    hostname: () => {
      throw unsupported("hostname");
    },
    homedir: () => {
      throw unsupported("homedir");
    },
    tmpdir: () => {
      throw unsupported("tmpdir");
    },
    userInfo: () => {
      throw unsupported("userInfo");
    },
    networkInterfaces: () => {
      throw unsupported("networkInterfaces");
    },
  };
  return shim;
}
