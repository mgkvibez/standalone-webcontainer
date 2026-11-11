# The builtin shim layer, and the first real product verdict

**Date:** 2026-11-10. **Fixture-08 verdict: PASS**, 3/3 assertions, through the container, against `registry.npmjs.org`.

## The milestone, stated precisely

`fixture-08` installs express from the **real registry** (68 packages), starts a server on port 3200, and the harness asserts the
response through the real `PreviewGateway`: status 200 and a body containing `express-static-ok`. Nothing there is a test double:
the tarballs come off the network, the program runs in the runtime, and the HTTP check crosses the same gateway a developer's
preview crosses.

One correction to the previous round, measured rather than assumed: `npm install express` installs **express 5.latest**, not the
4.21.2 the probe had pinned. That matters, because express 5 is written in modern JavaScript (`const`, destructuring) and express 4
was not, and the difference is what exposed both bugs below.

## What was actually blocking it

The engine was fine. Four things stood between the install and the verdict, and each was found by running a real package rather than
by reading one:

1. **`node:zlib` did not exist.** `body-parser` requires it for content-encoding handling.
2. **The wrapper injected `Buffer` as a parameter.** Express 5's `lib/utils.js` opens with
   `const Buffer = require("node:buffer").Buffer`, and a `const` cannot share a scope with a parameter of the same name:
   `SyntaxError: Identifier 'Buffer' has already been declared`, thrown from `new Function` before a line of express ran.
3. **`require("stream")` was not a constructor.** `send` does `util.inherits(SendStream, require("stream"))` and
   `Stream.call(this)`. Node's `require("stream")` IS the legacy `Stream` class; ours was a bag of five classes, so `inherits`
   received `undefined` and failed with "Object prototype may only be an Object or null".
4. **`EventEmitter` state was in a `#private` field.** Express builds an app by mixing `EventEmitter.prototype` into a plain object,
   then calls `app.on(...)`. A private field is unreadable from an object that is not an instance of the class, so those calls threw
   "Cannot read private member #listeners from an object whose class did not declare it".

Fixes, each with the reason it is not a workaround:

- **zlib** is built on the platform's `CompressionStream`/`DecompressionStream`. Stream and callback forms do the real work and are
  verified against Node's own gzip output. The **synchronous** forms (`gunzipSync` and friends) **refuse by name**, because no web
  platform API is synchronous and a wrong answer is worse than a refusal.
- The loader now omits an injected name **for a module that declares it itself** (`declaresOwnBinding`), which is exactly Node's
  behaviour where `Buffer` is a global a module may shadow. Comments and string literals are scrubbed first so a mention is not
  mistaken for a declaration.
- `stream` exports the legacy `Stream` class with the modern classes attached, which is the shape Node actually has.
- The emitter keeps listener state in a `WeakMap` keyed by `this`, so the mixin pattern works, and `on`/`emit`/`once` behave
  identically for real instances.

## The builtin audit

`tools/npm-audit-builtins.ts <package>[@range]` installs a real graph and reports, per builtin, how many packages require it and
which ones. This replaced guessing. For `express@4.21.2` (72 packages, 666 files):

| Builtin | Packages | Implemented |
|---|---|---|
| path, fs, stream | 7, 6, 4 | already had |
| buffer, http, events, tty | 3, 2, 2, 1 | already had |
| util | 4 | added |
| net, querystring, crypto, url, zlib, async_hooks, assert, https, string_decoder | 2 each (https 1) | added |

Every one is now registered as a builtin. The refusals are named and deliberate: sockets (`net`), TLS (`https`), signing and key
generation (`crypto`), and the synchronous codecs (`zlib`).

## Honest boundaries recorded here

- **MD5 is refused.** The implementation disagrees with Node's digest for non-empty input and is not on the express path (etag uses
  SHA-1, cookie-signature uses HMAC-SHA256), so `createHash("md5")` throws rather than shipping a quietly wrong hash.
- **`AsyncLocalStorage` is approximate.** It holds its store until `run`'s own promise settles, but a *detached* promise can resume
  under a different store, because nothing instruments promise boundaries.
- **zlib buffers.** The transform collects its input and decodes once, bounded at 64 MB; Node streams incrementally.
- **`inherits` and the emitter are mixin-shaped, not instance-only**, which is a deviation in the *safe* direction: it accepts more
  programs, and the ones it accepts behave as they do on Node.
- **The `fs` callback members are DERIVED from the promise members**, one implementation per operation: `readFile`, `writeFile`, `mkdir`,
  `unlink`, `rmdir`, `rename`, `rm`, `access`. Node layers them the same way, and deriving them means the path rewrite and the error map
  are the ones already tested on the promise shape. The callback may be in either optional-options position, and a failure arrives as the
  callback's first argument rather than as a thrown exception. Positional descriptor I/O (`read`, `readSync`) is still refused by name:
  this VFS reads and writes whole files, and answering a positional read would be inventing a behaviour.
- **`file:` URL specifiers resolve.** `resolve()` converts one with `fileURLToPath` before the file probe, so `import(pathToFileURL(p).href)`
  reaches the same file a relative specifier would. Vite's config loading depends on it.

## Where the release stands

Eight fixtures now produce real verdicts: `fixture-01`, `fixture-04` (6/6 assertions, fs/http/streams/timers), `fixture-07` (3/3, a
CLI), `fixture-08` (3/3, express from a real registry serving a real response), and the four front-end ones added on 2026-11-11:
`fixture-11`, `fixture-13`, `fixture-17`, `fixture-18`, all against the frozen vite snapshot. That milestone was taken, and what it
found is in `vite-production-build.md`: a script's `&&` second half not running, a suspended program with real work pending being
declared finished, esbuild's `fs.read` channel having been cut by our own earlier fix, a `file:` URL resolved as a package name, and
the callback `fs` members above.
