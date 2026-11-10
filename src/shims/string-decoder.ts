/**
 * `string_decoder`, which exists to solve one problem: a multi-byte character split across two chunks.
 *
 * `TextDecoder` with `stream: true` is exactly that facility, so this is a thin adapter rather than a second implementation. The
 * subtlety worth stating: `end()` must flush any trailing partial sequence, and a partial sequence at the end is replaced rather
 * than silently dropped.
 */

export class StringDecoder {
  readonly encoding: string;
  readonly #decoder: TextDecoder;
  #pending: Uint8Array = new Uint8Array(0);

  constructor(encoding: string = "utf8") {
    const normalised = encoding.toLowerCase().replace("-", "");
    const label =
      normalised === "utf8" ? "utf-8" : normalised === "utf16le" || normalised === "ucs2" ? "utf-16le" : normalised === "latin1" || normalised === "binary" ? "latin1" : "utf-8";
    this.encoding = label;
    this.#decoder = new TextDecoder(label, { fatal: false, ignoreBOM: false });
  }

  write(buffer: Uint8Array | string): string {
    if (typeof buffer === "string") return buffer;
    if (buffer.byteLength === 0) return "";
    this.#pending = buffer;
    const text = this.#decoder.decode(buffer, { stream: true });
    return text;
  }

  /** Flushes the decoder. A partial sequence at the end becomes the replacement character, which is what Node does too. */
  end(buffer?: Uint8Array | string): string {
    const tail = typeof buffer === "string" ? "" : this.#decoder.decode(buffer, { stream: false });
    this.#pending = new Uint8Array(0);
    return tail;
  }

  get lastNeed(): number {
    return this.#pending.byteLength;
  }
}

export default { StringDecoder };
