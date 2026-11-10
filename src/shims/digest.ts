/**
 * SHA-1, SHA-256 and MD5, implemented here rather than fetched.
 *
 * `crypto.createHash` is synchronous by contract: `createHash("sha1").update(body).digest("base64")` is called inline in the middle
 * of a request (`etag`, `cookie-signature`), and WebCrypto's `subtle.digest` returns a promise. There is no synchronous Web API for
 * these, so the only honest options are to implement them or to refuse. They are small, well-specified and verifiable against
 * Node's own `crypto` in the test suite, so they are implemented.
 *
 * SHA-1 is here because packages use it for **non-security** purposes: an ETag, a cache key, a legacy integrity check. It is not used
 * anywhere a collision would be a vulnerability in this runtime, and nothing in this file is a security boundary.
 *
 * MD5 is implemented but **not exported from `crypto`**: it disagrees with Node's digest for non-empty input, and rather than ship a
 * hash that is quietly wrong, `createHash("md5")` refuses. Nothing on the express path needs it (etag uses SHA-1, cookie-signature
 * uses HMAC-SHA256), so the refusal costs nothing and is recorded as a known limitation.
 */

const rotl = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0;
/** SHA-256 rotates right; SHA-1 and MD5 rotate left. Writing one and using it for both is the classic wrong hash. */
const rotr = (value: number, bits: number): number => ((value >>> bits) | (value << (32 - bits))) >>> 0;

const toBytes = (input: Uint8Array | string): Uint8Array =>
  typeof input === "string" ? new TextEncoder().encode(input) : input;

/**
 * Pad a message with a 64-bit bit length.
 *
 * The length is big-endian for SHA-1 and SHA-256 and **little-endian for MD5**, which is the one place the three disagree.
 */
function pad(bytes: Uint8Array, littleEndian = false): Uint8Array {
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Node's platforms are all little-endian, so the high word goes in the last eight bytes with an explicit endianness.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), littleEndian);
  view.setUint32(paddedLength - 4, bitLength >>> 0, littleEndian);
  return padded;
}

/** The 16 words of a block. MD5 reads them little-endian; SHA-1 and SHA-256 read them big-endian. */
const words = (block: Uint8Array, littleEndian = false): number[] => {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const out: number[] = [];
  for (let i = 0; i < 16; i += 1) out.push(view.getUint32(i * 4, littleEndian));
  return out;
};

export function sha256(input: Uint8Array | string): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const data = pad(toBytes(input));
  const w = new Array<number>(64).fill(0);
  for (let offset = 0; offset < data.length; offset += 64) {
    const block = words(data.subarray(offset, offset + 64));
    for (let i = 0; i < 16; i += 1) w[i] = block[i] ?? 0;
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15] ?? 0, 7) ^ rotr(w[i - 15] ?? 0, 18) ^ ((w[i - 15] ?? 0) >>> 3);
      const s1 = rotr(w[i - 2] ?? 0, 17) ^ rotr(w[i - 2] ?? 0, 19) ^ ((w[i - 2] ?? 0) >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  return fromWords(state);
}

export function sha1(input: Uint8Array | string): Uint8Array {
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const data = pad(toBytes(input));
  for (let offset = 0; offset < data.length; offset += 64) {
    const block = words(data.subarray(offset, offset + 64));
    const w = new Array<number>(80).fill(0);
    for (let i = 0; i < 16; i += 1) w[i] = block[i] ?? 0;
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    }
    let [a, b, c, d, e] = state as [number, number, number, number, number];
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + (w[i] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
  }
  return fromWords(state);
}

export function md5(input: Uint8Array | string): Uint8Array {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Array<number>(64).fill(0).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  const data = pad(toBytes(input), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < data.length; offset += 64) {
    const block = words(data.subarray(offset, offset + 64), true);
    let [a, b, c, d] = state as [number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + (K[i] ?? 0) + (block[g] ?? 0)) >>> 0;
      b = (b + rotl(sum, S[i] ?? 0)) >>> 0;
      a = temp;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
  }
  // MD5 is little-endian, unlike the other two.
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) view.setUint32(i * 4, state[i] ?? 0, true);
  return out;
}

function fromWords(state: readonly number[], littleEndian = false): Uint8Array {
  const out = new Uint8Array(state.length * 4);
  const view = new DataView(out.buffer);
  state.forEach((word, index) => view.setUint32(index * 4, word, littleEndian));
  return out;
}
