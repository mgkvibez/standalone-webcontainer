/**
 * Normalization for comparisons (charter §4.6).
 *
 * Two runs of the same fixture must produce the same text even though they ran in different temp
 * directories at different times. Everything stripped here is noise that changes run to run; nothing
 * stripped here is information about whether the fixture worked.
 */

export interface NormalizeOptions {
  /** The fixture's temp directory. Stripped with or without a trailing slash, as a prefix. */
  readonly tempDir?: string;
  /** Sort lines so directory listings compare regardless of Map/insertion order. Default true. */
  readonly sortLines?: boolean;
  /** Replace `?v=<hex>` sourcemap cache-busters. Default true. */
  readonly stripSourcemapNoise?: boolean;
  /** Replace ISO-8601 timestamps that lockfiles and logs emit. Default true. */
  readonly stripTimestamps?: boolean;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SOURCEMAP_QUERY = /\?v=[0-9a-f]{8,}\b/g;
const SOURCEMAP_COMMENT = /^\/\/# sourceMappingURL=.*$/gm;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeText(input: string, options: NormalizeOptions = {}): string {
  const stripSourcemapNoise = options.stripSourcemapNoise ?? true;
  const stripTimestamps = options.stripTimestamps ?? true;
  const sortLines = options.sortLines ?? true;

  // CRLF first: every later rule assumes one line ending, and Windows runners are a real case.
  let text = input.replace(/\r\n?/g, "\n");

  if (options.tempDir !== undefined && options.tempDir.length > 0) {
    const dir = options.tempDir.replace(/\/+$/, "");
    // Only the directory itself is replaced. An optional trailing slash would eat the separator and
    // turn `/tmp/abc/file` into `<TMP>file`, which loses the fact that it is a child path and could
    // make two genuinely different paths compare equal.
    text = text.replace(new RegExp(escapeRegExp(dir), "g"), "<TMP>");
  }

  if (stripSourcemapNoise) {
    text = text.replace(SOURCEMAP_COMMENT, "");
    text = text.replace(SOURCEMAP_QUERY, "?v=<HASH>");
  }

  if (stripTimestamps) {
    text = text.replace(ISO_TIMESTAMP, "<TIMESTAMP>");
  }

  if (!sortLines) {
    return text;
  }

  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  // Plain code-unit comparison, not localeCompare: a locale-aware sort would make the same fixture
  // compare differently on a machine with a different locale, which is the exact class of flake
  // this function exists to remove.
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return lines.join("\n");
}
