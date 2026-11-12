/**
 * Putting one script tag into HTML that is already streaming.
 *
 * The previewed page cannot open a websocket on its own, so the shell injects a client into the document it serves (ADR-0033). The obvious
 * implementation — read the whole response, splice a string, send it — would undo the streaming that ADR-0030 exists for, and a dev server's
 * HTML is not always short.
 *
 * So this inserts at the first `</head>` as the bytes pass through, which means everything before it is emitted immediately and only a bounded
 * tail is ever held. Two details make that safe rather than lucky:
 *
 * - `</head>` can be split across chunks, so the last few bytes of every chunk are held back until the next one proves they are not the start of
 *   it. The hold is bounded by the tag length, not by the document.
 * - A document may have no `</head>` at all (a fragment, or a page the server wrote by hand), so the tag is appended at the end instead. A page
 *   without `</head>` is still served, just with the client loaded later than it would be.
 *
 * It also refuses to inject twice, because a response that already carries the client would otherwise load it again under a second name and two
 * clients would both answer for the same page.
 */

/** The marker that makes injection idempotent: a page that already has it gets nothing added. */
export const INJECTED_CLIENT_MARKER = "data-swc-preview-client";

export interface HtmlInjector {
  /** Bytes as they arrived. Returns what may be emitted now. */
  push(chunk: Uint8Array): Uint8Array[];
  /** The stream ended: returns whatever was held, with the tag appended when the document never had a `</head>`. */
  end(): Uint8Array[];
  /** True once the tag has gone in. */
  readonly injected: boolean;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * @param scriptTag The complete tag to insert, attributes and all.
 * @param options Case fold for the search: HTML tag names are case-insensitive, so `</HEAD>` counts too.
 */
export function createHtmlInjector(scriptTag: string, options: { readonly holdBytes?: number } = {}): HtmlInjector {
  const tag = scriptTag.includes(INJECTED_CLIENT_MARKER) ? scriptTag : scriptTag.replace("<script", `<script ${INJECTED_CLIENT_MARKER}`);
  const tagBytes = ENCODER.encode(tag);
  const needle = ENCODER.encode("</head>");
  // Enough to prove the next chunk does not continue a `</head>` that was cut in half. The default is generous on purpose: holding a few extra
  // bytes costs nothing, and a hold that is too small turns a boundary split into a silent miss.
  const holdBytes = options.holdBytes ?? needle.length - 1;

  let pending: Uint8Array = new Uint8Array(0);
  let injected = false;
  let seenHead = false;

  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    return joined;
  };

  /** Index of `</head>` in `buffer`, searched case-insensitively over the ASCII range that matters. */
  const findHead = (buffer: Uint8Array): number => {
    for (let index = 0; index + needle.length <= buffer.length; index += 1) {
      let matches = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        const byte = buffer[index + offset] ?? 0;
        const folded = byte >= 65 && byte <= 90 ? byte + 32 : byte;
        if (folded !== needle[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return index;
    }
    return -1;
  };

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      if (injected) return chunk.length === 0 ? [] : [chunk];
      pending = pending.length === 0 ? chunk.slice() : concat(pending, chunk);
      if (!seenHead) {
        seenHead = DECODER.decode(pending.subarray(0, Math.min(pending.length, 64))).toLowerCase().includes("<head");
      }
      const at = findHead(pending);
      if (at >= 0) {
        injected = true;
        const before: Uint8Array = pending.subarray(0, at);
        const after: Uint8Array = pending.subarray(at);
        pending = new Uint8Array(0);
        const out = new Uint8Array(before.length + tagBytes.length + after.length);
        out.set(before, 0);
        out.set(tagBytes, before.length);
        out.set(after, before.length + tagBytes.length);
        return [out];
      }
      if (pending.length > holdBytes) {
        const emit = pending.subarray(0, pending.length - holdBytes).slice();
        pending = pending.subarray(pending.length - holdBytes).slice();
        return [emit];
      }
      return [];
    },

    end(): Uint8Array[] {
      if (injected) {
        const tail = pending;
        pending = new Uint8Array(0);
        return tail.length === 0 ? [] : [tail];
      }
      injected = true;
      const rest = pending;
      pending = new Uint8Array(0);
      // No `</head>` anywhere: the tag goes at the end, which still runs it before `load` but after the document has been parsed.
      const out = new Uint8Array(rest.length + tagBytes.length);
      out.set(rest, 0);
      out.set(tagBytes, rest.length);
      return [out];
    },

    get injected(): boolean {
      return injected;
    },
  };
}

/** True when a response's `content-type` is a document the client should be injected into. */
export function isHtmlDocument(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/html" || type === "application/xhtml+xml";
}
