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

/** Raw base64 sha512 of the bytes, or null when the platform gives us no `crypto.subtle` to compute one with. */
export async function sha512Base64(bytes: Uint8Array): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return null;
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await subtle.digest("SHA-512", owned);
  return base64(new Uint8Array(digest));
}

/** A `sha512-<base64>` string, or null when the platform gives us no crypto to compute one with. */
export async function computeIntegrity(bytes: Uint8Array): Promise<string | null> {
  const digest = await sha512Base64(bytes);
  return digest === null ? null : `sha512-${digest}`;
}
