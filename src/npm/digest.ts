/**
 * Integrity digests, in the one format npm uses.
 *
 * Extracted from the installer when the corpus validator needed the same function: two copies of a digest that
 * disagree is the sort of bug that looks like a corrupted tarball and wastes a day. `sha512Base64` returns null
 * rather than throwing when the platform offers no crypto, because the caller's decision (warn and continue, as
 * npm does for a package published before integrity existed) is not this module's to make.
 */

/** Base64 of raw bytes, without a Buffer dependency so the browser lane and Node share one path. */
export function base64(bytes: Uint8Array): string {
  // btoa exists in browsers and in Node 16+; going through a binary string keeps one code path.
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The algorithms an SRI string may name, restricted to what `crypto.subtle` can compute everywhere we run.
 *
 * sha512 is what npm publishes today; the others exist because a package published years ago may carry only sha1 (via `dist.shasum`) or a
 * sha256 digest, and refusing those by algorithm would refuse a package whose bytes we can verify perfectly well.
 */
export type DigestAlgorithm = "SHA-512" | "SHA-384" | "SHA-256" | "SHA-1";

/** Raw base64 digest of the bytes, or null when the platform gives us no `crypto.subtle` to compute one with. */
export async function digestBase64(algorithm: DigestAlgorithm, bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return null;
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await subtle.digest(algorithm, owned);
  return base64(new Uint8Array(digest));
}

/**
 * Raw hex digest of the bytes, or null without `crypto.subtle`.
 *
 * Both encodings exist because npm publishes both: `dist.integrity` is SRI (**base64**), and `dist.shasum` is a plain hex sha1. Comparing one
 * against the other always reports a mismatch on correct bytes, which was a real half-hour lost during the registry spike.
 */
export async function digestHex(algorithm: DigestAlgorithm, bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return null;
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await subtle.digest(algorithm, owned);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Raw base64 sha512 of the bytes, or null when the platform gives us no `crypto.subtle` to compute one with. */
export async function sha512Base64(bytes: Uint8Array): Promise<string | null> {
  return digestBase64("SHA-512", bytes);
}

/** A `sha512-<base64>` string, or null when the platform gives us no crypto to compute one with. */
export async function computeIntegrity(bytes: Uint8Array): Promise<string | null> {
  const digest = await sha512Base64(bytes);
  return digest === null ? null : `sha512-${digest}`;
}
