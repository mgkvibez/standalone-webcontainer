/**
 * `querystring`, the legacy module that `body-parser` and `qs`-free code still call.
 *
 * Two deliberate limits, both matching the defaults a caller gets: no nested objects (`a[b]=1` stays a flat key, which is what
 * `querystring` itself does; nesting is a `qs` feature and `qs` does not need this module) and `maxKeys` is honoured because a
 * parser that ignores it is a memory hole.
 */

const decodeSafely = (value: string, decoder: (text: string) => string): string => {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decoder(spaced);
  } catch {
    return spaced;
  }
};

export interface ParseOptions {
  readonly maxKeys?: number;
  readonly decodeURIComponent?: (text: string) => string;
}

export function parse(
  text: string,
  separator = "&",
  equals = "=",
  options: ParseOptions = {},
): Record<string, string | string[]> {
  // Node returns a null-prototype object here, and code that checks `key in result` relies on it not inheriting Object's keys.
  const result: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  if (typeof text !== "string" || text.length === 0) return result;
  const decoder = options.decodeURIComponent ?? decodeURIComponent;
  const maxKeys = options.maxKeys ?? 1000;
  let count = 0;
  for (const part of text.split(separator)) {
    if (part === "") continue;
    if (count >= maxKeys) break;
    count += 1;
    const index = part.indexOf(equals);
    const key = decodeSafely(index === -1 ? part : part.slice(0, index), decoder);
    const value = decodeSafely(index === -1 ? "" : part.slice(index + equals.length), decoder);
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}

export function stringify(value: Record<string, unknown>, separator = "&", equals = "="): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value ?? {})) {
    const encodedKey = escape(key);
    if (Array.isArray(raw)) {
      for (const item of raw) parts.push(`${encodedKey}${equals}${escape(String(item))}`);
    } else {
      parts.push(`${encodedKey}${equals}${escape(String(raw))}`);
    }
  }
  return parts.join(separator);
}

export const escape = (text: string): string => encodeURIComponent(String(text));

/** `unescape` is `decodeURIComponent` with a try/catch, as Node's is: a malformed sequence is returned as-is, not thrown. */
export const unescape = (text: string): string => {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, " "));
  } catch {
    return String(text);
  }
};

export const encode = escape;
export const decode = unescape;

export default { parse, stringify, escape, unescape, encode, decode };
