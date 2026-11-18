/**
 * P3-0: the realm references this runtime keeps working with, captured before user code can run.
 *
 * WHAT THIS IS NOT. This module is not a sandbox and creates no isolation. User code executes in this same Worker realm,
 * shares `globalThis` with the runtime, and can still reach the platform global through a constructor or `eval`. The
 * dedicated runtime origin (ADR-0019) is the security boundary; nothing here substitutes for it.
 *
 * WHAT THIS IS. Later W-19 phases will restrict ambient browser capabilities inside the process Worker. A restriction
 * that removes something the runtime itself depends on turns a hardening change into a broken container, and the break
 * would appear as an unrelated failure far from its cause. So the runtime's own dependencies are read once, here, at
 * module evaluation, and held privately by the runtime rather than looked up ambiently later.
 *
 * CAPTURE HAPPENS ON IMPORT. `process-worker.ts` imports this module at the top of its module body, which runs before the
 * `start` message can arrive, before the private control port is installed, and long before the loader compiles the first
 * user module. There is no window in which user code could run between evaluation and capture.
 *
 * PRIVATE BY CONSTRUCTION. The bindings live in a module-scope frozen object that no user-visible surface exposes: it is
 * not attached to `globalThis`, not merged into the process facade built by `realm-globals.ts`, and not sent over either
 * message channel. User code receives its shims as `new Function` parameters, so a module-scope constant is unreachable
 * from it by name.
 *
 * Captured `Function` is a continuity measure, not a boundary: user code that reaches the platform global gets a
 * `Function` of its own. Capturing it means the loader keeps compiling after a phase removes the ambient one.
 */

/**
 * The realm facilities the runtime reads through `globalThis` today.
 *
 * Each entry names its production consumer, because a capture with no consumer is speculation and would quietly become
 * dead weight the next phase has to justify:
 *
 * - `Function`    - `src/runtime/commonjs.ts:659` compiles every module with `new Function(...injected, body)`.
 * - `Object`      - `src/runtime/realm-globals.ts` builds the facade from the realm's own constructors.
 * - `Reflect`     - property operations in the loader and the shims (`Reflect.get`/`Reflect.set` on module exports).
 * - `WebAssembly` - esbuild-wasm, reached through the facade; also `src/runtime/async-work.ts`.
 * - `crypto`      - `src/shims/crypto.ts` fills random bytes. `getRandomValues` is a METHOD of `crypto`, not a global, so
 *   the object is captured and the method is bound to it; capturing a non-existent `globalThis.getRandomValues` fails.
 * - `TextEncoder` / `TextDecoder` - frame and syscall codecs (`src/process/frame.ts`, `src/process/syscall-channel.ts`)
 *   and every shim that moves text across the boundary.
 * - `URL` / `URLSearchParams` - `src/shims/url.ts` and the preview/transport URL parsing.
 * - `structuredClone` - `src/shims/v8.ts` serialisation.
 * - `Atomics` / `SharedArrayBuffer` - `src/process/syscall-channel.ts`, `src/process/remote-fs.ts`,
 *   `src/process/remote-watch.ts`: the synchronous syscall channel cannot work without both.
 * - `setTimeout` / `clearTimeout` - `src/process/remote-watch.ts:77-78` polls watches on REAL timers and cancels the
 *   pending tick when the watch closes (a virtual interval never
 *   fires, because virtual time only advances while the queue runs), so the ambient timers are load-bearing.
 *
 * DELIBERATELY ABSENT: `queueMicrotask`. A source audit finds no production call site in `src/process` or
 * `src/runtime/in-process.ts`; the facade re-exposes the realm's own for programs that legitimately use it, which is not a
 * runtime dependency. Capturing it would be speculation.
 */
export interface RealmReferences {
  readonly Function: FunctionConstructor;
  readonly Object: ObjectConstructor;
  readonly Reflect: typeof Reflect;
  readonly WebAssembly: typeof WebAssembly;
  readonly crypto: Crypto;
  /** Derived from `crypto`, bound to its receiver at capture time so a detached call cannot throw Illegal invocation. */
  readonly getRandomValues: (array: Uint8Array) => Uint8Array;
  readonly TextEncoder: typeof TextEncoder;
  readonly TextDecoder: typeof TextDecoder;
  readonly URL: typeof URL;
  readonly URLSearchParams: typeof URLSearchParams;
  readonly structuredClone: typeof structuredClone;
  readonly Atomics: typeof Atomics;
  readonly SharedArrayBuffer: SharedArrayBufferConstructor;
  readonly setTimeout: (handler: () => void, timeout?: number) => unknown;
  /**
   * The cancellation half of the pair. `remote-watch.ts:78` returns a closer that calls it, and `process-transport.ts:419`
   * clears a socket-open deadline, so a scheduler that could arm a timer but not disarm one would leave ticks running after
   * a watch or a request was finished with.
   */
  readonly clearTimeout: (handle: unknown) => void;
}

/** The shape capture reads from. Structural so a test can hand it a recorder instead of a realm. */
export type RealmSource = { readonly [K in keyof RealmReferences]: RealmReferences[K] | undefined };

/**
 * Raised when a required reference is missing at capture time.
 *
 * Named, and carrying the reference, because the alternative is a `TypeError` from deep inside a syscall six seconds into
 * a program with nothing pointing at the cause.
 */
export class RealmCaptureError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(
      `P3-0 realm capture failed: the runtime requires ${reference} and the process Worker realm does not provide it. ` +
        "The runtime cannot start without it, and starting anyway would fail later, somewhere unrelated.",
    );
    this.name = "RealmCaptureError";
    this.reference = reference;
  }
}

/** The names capture reads, in the order it reads them: the interface above, kept in one place for the recorder test. */
export const CAPTURED_REFERENCES: ReadonlyArray<keyof RealmReferences> = [
  "Function",
  "Object",
  "Reflect",
  "WebAssembly",
  "crypto",
  "TextEncoder",
  "TextDecoder",
  "URL",
  "URLSearchParams",
  "structuredClone",
  "Atomics",
  "SharedArrayBuffer",
  "setTimeout",
  "clearTimeout",
];

/**
 * Read the realm's facilities once and freeze them.
 *
 * `source` is a parameter so the capture can be exercised against a recorder, and so a future phase can capture from an
 * explicitly-passed realm rather than the ambient one. Production calls it with no argument.
 */
export function captureRealmReferences(source: RealmSource = globalThis as unknown as RealmSource): RealmReferences {
  const missing = CAPTURED_REFERENCES.filter((name) => typeof source[name] === "undefined");
  if (missing.length > 0) throw new RealmCaptureError(missing[0] ?? "a required reference");

  // `getRandomValues` throws "Illegal invocation" when called detached from its Crypto receiver, so the object is captured
  // and the method bound to it here rather than at every call site.
  const cryptoSource = source.crypto as Crypto;

  return Object.freeze({
    Function: source.Function as FunctionConstructor,
    Object: source.Object as ObjectConstructor,
    Reflect: source.Reflect as typeof Reflect,
    WebAssembly: source.WebAssembly as typeof WebAssembly,
    crypto: cryptoSource,
    getRandomValues: cryptoSource.getRandomValues.bind(cryptoSource) as (array: Uint8Array) => Uint8Array,
    TextEncoder: source.TextEncoder as typeof TextEncoder,
    TextDecoder: source.TextDecoder as typeof TextDecoder,
    URL: source.URL as typeof URL,
    URLSearchParams: source.URLSearchParams as typeof URLSearchParams,
    structuredClone: source.structuredClone as typeof structuredClone,
    Atomics: source.Atomics as typeof Atomics,
    SharedArrayBuffer: source.SharedArrayBuffer as SharedArrayBufferConstructor,
    // Bound to the SOURCE they were read from, not to `globalThis`: a timer called with the wrong receiver throws an
    // Illegal invocation in the browser, and a capture that only works for the default source cannot be tested with any
    // other - which is the difference between a test that proves the binding and one that assumes it.
    setTimeout: (source.setTimeout as RealmReferences["setTimeout"]).bind(source),
    clearTimeout: (source.clearTimeout as RealmReferences["clearTimeout"]).bind(source),
  });
}

/**
 * The capture itself, taken when this module is first evaluated.
 *
 * `process-worker.ts` imports this module for its side effect, which is the point: importing it is what captures. Nothing
 * else in the tree imports it, so the Node/in-process fixture lane never touches it and keeps resolving its globals
 * ambiently, exactly as before.
 */
export const realmReferences: RealmReferences = captureRealmReferences();
