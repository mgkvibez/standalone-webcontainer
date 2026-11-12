/**
 * The virtual machine's declared environment.
 *
 * Node answers `os.homedir()` by reading `$HOME`, and `os.tmpdir()` by reading `$TMPDIR`, then `$TMP`, then `$TEMP`, then `/tmp`
 * (measured on node v20.20.2; the os shim tests pin each step). So these are not observations of a host machine that have to be
 * refused: they are facts this virtual machine owns, in the same class as `process.platform` being "linux" (ADR-0004 D-3 as amended by P0-5) and pid 1. Declaring
 * them in one place is what stops `process.env.HOME` and `os.homedir()` from becoming two answers to one question.
 *
 * Why `/home/user`: this VM has one unprivileged user and no password database, so there is no real name to report. A package that
 * caches under `path.join(os.homedir(), ".cache")` gets a path that can exist in this VFS, which is the useful property. The name is
 * a convention, not a claim about a person.
 *
 * These are defaults, not overrides: a caller that passes its own environment wins, and a caller that passes `HOME` itself gets its
 * own value back from both `process.env` and `os.homedir()`.
 */
export const VIRTUAL_ENVIRONMENT: Readonly<Record<string, string>> = {
  HOME: "/home/user",
  TMPDIR: "/tmp",
};
