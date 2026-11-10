/**
 * Parsing the package spec a user types after `npm install`.
 *
 * npm accepts seven kinds of spec: a name with an optional range, a folder, a tarball file, a tarball URL, a git URL, a
 * `<name>@npm:<other>@<range>` alias, and a workspace name. Only the first is implemented, and the rest are refused **by kind**
 * rather than by a generic parse failure, because "we do not install from git yet" and "that is not a package name" are different
 * facts and a user acting on the second one would be misled.
 *
 * The name/range split is the subtle part: `@scope/pkg` has an `@` that is not a version separator, `@scope/pkg@1.2.3` has two,
 * and `pkg@` (a trailing separator with nothing after it) is a range of `latest` in npm rather than an error.
 */

export interface InstallSpec {
  /** The package name exactly as the registry knows it, scope included. */
  readonly name: string;
  /** A semver range, a dist-tag such as `latest`, or a full version. Never empty: a bare name means `latest`. */
  readonly range: string;
}

export type SpecErrorCode =
  | "EMPTY_SPEC"
  | "UNSUPPORTED_SPEC_KIND"
  | "INVALID_PACKAGE_NAME";

export class SpecError extends Error {
  readonly code: SpecErrorCode;

  constructor(code: SpecErrorCode, message: string) {
    super(message);
    this.name = "SpecError";
    this.code = code;
  }
}

/** A name npm would accept: optional scope, no spaces, no path separators, no protocol. */
const NAME_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Split `<name>[@<range>]`.
 *
 * The last `@` is the separator, unless it is the first character (which makes the token a scoped name) or there is no `@` at all.
 */
export function splitSpec(token: string): { readonly name: string; readonly range: string } | null {
  const trimmed = token.trim();
  if (trimmed === "") return null;
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) return { name: trimmed, range: "latest" };
  const name = trimmed.slice(0, separator);
  const range = trimmed.slice(separator + 1);
  return { name, range: range === "" ? "latest" : range };
}

export function parseInstallSpec(token: string): InstallSpec {
  const trimmed = token.trim();
  if (trimmed === "") throw new SpecError("EMPTY_SPEC", "npm install: a package name is required");

  // Refused by kind, before any name validation: these are all legitimate npm specs we do not implement, and a name-shaped error
  // message would send the user looking for a typo that is not there.
  if (/^(https?|git|git\+ssh|git\+https?|ssh):\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
    throw new SpecError(
      "UNSUPPORTED_SPEC_KIND",
      `${trimmed}: installing from a URL or a git remote is not supported; name a published package instead`,
    );
  }
  if (trimmed.startsWith("file:") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/")) {
    throw new SpecError(
      "UNSUPPORTED_SPEC_KIND",
      `${trimmed}: installing from a folder or a local tarball is not supported; the project's own files are already in place`,
    );
  }
  if (trimmed.startsWith("workspace:")) {
    throw new SpecError("UNSUPPORTED_SPEC_KIND", `${trimmed}: workspaces are not supported`);
  }

  // An alias (`express@npm:express@4`) carries an `@` inside the range, so it has to be recognised before the split: reading the
  // last `@` as the separator makes the name `express@npm:express`, and the user then gets told their package name is invalid.
  if (trimmed.includes("@npm:")) {
    throw new SpecError("UNSUPPORTED_SPEC_KIND", `${trimmed}: an alias spec (npm:<other>) is not supported`);
  }

  const parts = splitSpec(trimmed);
  if (parts === null) throw new SpecError("EMPTY_SPEC", "npm install: a package name is required");
  if (!NAME_PATTERN.test(parts.name)) {
    throw new SpecError(
      "INVALID_PACKAGE_NAME",
      `${parts.name}: not a package name (names are lowercase, may be scoped as @scope/name, and contain no spaces or paths)`,
    );
  }
  return { name: parts.name, range: parts.range };
}
