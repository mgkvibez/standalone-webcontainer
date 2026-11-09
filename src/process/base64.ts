/**
 * Base64 for byte payloads that have to cross a JSON wire.
 *
 * The channel's payloads are JSON (see `syscall-channel.ts`), so a `Uint8Array` cannot travel as itself. `btoa`/`atob`
 * exist in both a Worker and in Node 20, which is what keeps this file free of an import that would break the browser
 * lane. Chunked, because `String.fromCharCode(...bytes)` blows the call stack somewhere around a hundred thousand
 * arguments and a 1 MiB source file is a normal thing to open.
 */

const CHUNK = 8192;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
