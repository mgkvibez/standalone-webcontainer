/**
 * CRYPTO PRESET DEFERRAL (ADR-0003 Decision 1, amended Oct 26): this module
 * initializes exactly the five approved presets — path, process, buffer,
 * events, timers. unenv's crypto preset is explicitly DEFERRED to a future
 * phase and is not initialized here, per the expert's ruling. Rationale: the
 * crypto surface needs its own security review (charter decision #8:
 * deny-by-default) before any API beyond what our Node-API plan actually
 * requires is mapped onto WebCrypto — randomUUID-style conveniences and a
 * full crypto stream surface have very different risk profiles, and that
 * scoping decision belongs to the expert, not the implementer.
 */
/**
 * unenv v1-stable preset integration (ADR-0003, Decision 1).
 *
 * Imports the five expert-approved preset implementations — path,
 * process, buffer, events, timers — from unenv's nodeless browser-safe
 * runtime targets (verified against unenv@1.10.0's alias map), and
 * exposes them as a unified shim context.
 *
 * WHY these five: ADR-0003 Decision 1 fixes the substrate for
 * path/process/crypto/buffer/events/timers; crypto is intentionally
 * not wired yet because the sha1-heavy surface needs its own review —
 * nothing here blocks it.
 *
 * WHY imports rather than a global-mutating bootstrap: the runtime owns
 * an explicit module registry it hands to the loader; applying presets
 * by side effect (globalThis patching) would break worker isolation and
 * testability. Pure modules, explicit context.
 *
 * FILE-SYSTEM ROUTING (the crucial constraint): none of these presets
 * touch the filesystem or any browser API directly. The context carries
 * the typed envelope client; every fs-adjacent syscall routes through
 * it (envelope.ts) to the VFS in the owning worker. The fs shim itself
 * is deliberately NOT here — it lands next phase, built against our
 * VFS, with memfs (devDependency) as the CI conformance oracle.
 */
import { SyscallClient } from "../runtime/envelope.js";

// unenv v1 stable runtime presets (nodeless alias targets):
import * as pathPreset from "unenv/runtime/node/path/index";
import * as processPreset from "unenv/runtime/node/process/index";
import * as bufferPreset from "unenv/runtime/node/buffer/index";
import * as eventsPreset from "unenv/runtime/node/events/index";
// node:timers in unenv's nodeless preset resolves to a CJS proxy mock
// whose ONLY semantics is delegating to the platform's global timer
// functions. That mock is a bundler-time construct: vitest/Node-ESM
// cannot load it (it hangs the transform). We therefore materialize
// its delegation contract explicitly — the identical semantics,
// worker-safe, without the un-loadable mock. setTimeout/clearTimeout/
// setInterval/clearInterval all exist in Dedicated Workers; the
// Immediate pair is Node-only and left undefined in the browser lane.
const timersPreset = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

/** The preset-approved module registry handed to the runtime loader. */
export interface ShimModules {
  path: typeof pathPreset;
  process: unknown;
  buffer: typeof bufferPreset;
  events: typeof eventsPreset;
  timers: typeof timersPreset;
}

/**
 * The runtime context shims are applied to. `syscall` is the typed
 * envelope client: ANY operation that touches worker-owned state (the
 * VFS above all) MUST go through it — never directly to browser APIs.
 */
export interface ShimContext {
  syscall: SyscallClient;
  modules: ShimModules;
}

/**
 * Apply the approved unenv presets and return the initialized shim
 * context. Pure: no globals mutated, no DOM touched, safe inside the
 * owning worker as well as in unit tests.
 */
export function initializeShims(syscall: SyscallClient): ShimContext {
  return {
    syscall,
    modules: {
      path: pathPreset,
      // unenv's process preset is a default-export singleton.
      process: processPreset.default,
      buffer: bufferPreset,
      events: eventsPreset,
      timers: timersPreset,
    },
  };
}
