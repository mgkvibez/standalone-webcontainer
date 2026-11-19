/**
 * W-19 P3-1: take the browser capabilities a process does not need off its own global before user code runs.
 *
 * DEFENCE IN DEPTH, NOT A SANDBOX. This is the same distinction ADR-0019 draws for the runtime origin. User code still
 * executes in this Worker realm, still shares `globalThis`, and can still reach the platform global through a constructor
 * or `eval`. Removing a property raises the cost of an accidental or lazy use of a browser API from inside a program; it
 * does not confine a program that is trying. Isolation is the separate origin, and only that.
 *
 * WHAT THIS PHASE MAY DO. Delete an OWN, CONFIGURABLE property from the process Worker's global object. That is the whole
 * mechanism, and it is deliberately the only one. Shadowing an INHERITED property was P3-2's question, and P3-2 closed
 * with no implementation (docs/audit/w19-p3-2-closeout.md): a shadow is recovered through prototype traversal, so
 * pretending it blocked something would make the phase's own tests lie.
 *
 * WHY A REPORT RATHER THAN A LIST. `delete scope[name]` fails silently in two ways that look identical from the outside -
 * the property was never own, or it was own and non-configurable - and a removal module that assumed success would let a
 * test assert "removed" about a capability that is still there. Each candidate is therefore probed, deleted, re-probed,
 * and recorded with what actually happened.
 */

/** One audited candidate: what it is, whether this phase removes it, and the source evidence for that decision. */
export interface CapabilityAudit {
  readonly name: string;
  readonly decision: "remove" | "preserve";
  /** For `remove`: the absence of a consumer. For `preserve`: the consumer that needs it. */
  readonly reason: string;
}

/**
 * The audited inventory.
 *
 * Each `remove` below was confirmed to have no production consumer inside the process Worker's module graph
 * (`src/process`, `src/runtime`, `src/shims`). The `preserve` entries are the ones the audit refused to delete, and they
 * are preserved for two different reasons that must not be conflated:
 *
 *   - WebAssembly, crypto, Atomics, SharedArrayBuffer, the encoders and the native timers ARE P3-0 captured references
 *     (`src/process/quarantine.ts`). Removing them would break the runtime, and the capture is what stops a later phase
 *     from doing it by accident.
 *   - WebSocket, postMessage and onmessage are NOT captured references. WebSocket is a capability programs legitimately
 *     use for preview sockets (ADR-0033), served through the curated facade. postMessage and onmessage are own and
 *     configurable, so this phase COULD delete them; they are preserved because the trust decision about the channel they
 *     expose has already been made by P2, not because deletion is unavailable (see each entry's reason).
 */
export const CAPABILITY_AUDIT: ReadonlyArray<CapabilityAudit> = [
  {
    name: "XMLHttpRequest",
    decision: "remove",
    reason:
      "No occurrence in src/process, src/runtime or src/shims: nothing in this realm uses the browser's request object, " +
      "and a program's HTTP goes through the virtual fetch/XHR shims the runtime provides. Removing it does NOT " +
      "establish network isolation. Native fetch is inherited from WorkerGlobalScope.prototype, so it stays reachable " +
      "and usable here (measured in Chromium, W-19 P3-2); deleting this own property neither removes it nor routes it " +
      "through the syscall channel. See docs/audit/w19-p3-2-closeout.md.",
  },
  {
    name: "BroadcastChannel",
    decision: "remove",
    reason:
      "No occurrence anywhere in the process Worker's module graph. Cross-process messaging is the kernel's port registry, " +
      "and a process has no business opening a page-wide channel.",
  },
  {
    name: "Worker",
    decision: "remove",
    reason:
      "The only `new Worker` in src/ is process-host.ts, which runs in the kernel/page lane, not in this realm. A process " +
      "spawning a nested Worker would be a second execution context the kernel cannot account for.",
  },
  {
    name: "WebSocket",
    decision: "preserve",
    reason:
      "Measured in a real Worker: with the own global property deleted, `self.WebSocket` still answered, because the " +
      "curated facade (src/runtime/realm-globals.ts) serves its own WebSocket and programs need one for preview sockets " +
      "(ADR-0033). The capability therefore stayed reachable one `self.` away, and a change that alters what programs see " +
      "without removing the capability is not a removal. Preserved; P3-2 owns any decision about the facade.",
  },
  {
    name: "MessageChannel",
    decision: "remove",
    reason:
      "One consumer: src/runtime/scheduler.ts drainContinuations(), which already falls back to a 0 ms timer when the " +
      "constructor is absent. Proven in the real Worker by the P3-1 browser spec, which runs chained continuations with " +
      "the constructor removed.",
  },
  {
    name: "postMessage",
    decision: "preserve",
    reason:
      "Own, configurable DATA property on the global (measured in Chromium, W-19 P3-2), so this phase could delete it. It " +
      "is preserved because the channel it writes to is already untrusted by construction: the host ignores everything " +
      "except the first `start`, so a program posting here reaches a listener that discards it. Deleting it would remove a " +
      "channel that already carries nothing the kernel believes. P3-1 removes capabilities with no consumer; this one has a " +
      "consumer whose trust was decided by P2.",
  },
  {
    name: "onmessage",
    decision: "preserve",
    reason:
      "Own, configurable ACCESSOR with a setter on the global (measured in Chromium, W-19 P3-2). The bootstrap needs it to " +
      "receive `start`; inside that handler P2 assigns an own `null` through the setter, which happens BEFORE the control " +
      "port is installed and before user code runs. By the time this phase could delete it, the setter has already been " +
      "invoked and the handler is inert, so deletion would change nothing a program can do: it can reassign `onmessage` " +
      "and the host sends nothing further on that channel. Preserved because the bootstrap requires it and removing it " +
      "afterwards is a no-op, not because deletion is unavailable.",
  },
];

/** Names this phase removes. */
export const REMOVED_CAPABILITIES: ReadonlyArray<string> = CAPABILITY_AUDIT.filter(
  (entry) => entry.decision === "remove",
).map((entry) => entry.name);

/** What actually happened, per candidate. */
export interface RemovalReport {
  /** Own, configurable, deleted, and confirmed gone from the object AND its prototype chain. */
  readonly removed: ReadonlyArray<string>;
  /** Never present on this realm at all. */
  readonly absent: ReadonlyArray<string>;
  /** Reachable only through the prototype: deletion cannot touch it, and P3-2 owns that decision. */
  readonly inherited: ReadonlyArray<string>;
  /** Own but non-configurable: deleting is refused by the language, so it is reported rather than claimed. */
  readonly refused: ReadonlyArray<string>;
}

/** The slice of a global object this module needs. Structural, so a test can hand it a plain object. */
export interface AmbientScope {
  readonly [name: string]: unknown;
}

/**
 * Delete the approved own properties and report the truth about each.
 *
 * Verification is part of the operation, not the caller's job: after each `delete`, both the own descriptor and the
 * prototype chain are re-read, because `delete` returning `true` is not proof that the capability is gone.
 */
export function removeAmbientCapabilities(
  scope: AmbientScope = globalThis as unknown as AmbientScope,
  names: ReadonlyArray<string> = REMOVED_CAPABILITIES,
): RemovalReport {
  const removed: string[] = [];
  const absent: string[] = [];
  const inherited: string[] = [];
  const refused: string[] = [];

  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(scope, name);
    if (descriptor === undefined) {
      // No own property. Either the realm never had it, or it lives on the prototype - and those are different answers
      // to "is this capability gone?", so they are recorded separately.
      if (name in scope) inherited.push(name);
      else absent.push(name);
      continue;
    }
    if (descriptor.configurable !== true) {
      refused.push(name);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- deleting an audited own property is this module's job
    delete (scope as Record<string, unknown>)[name];
    const after = Object.getOwnPropertyDescriptor(scope, name);
    if (after === undefined && !(name in scope)) removed.push(name);
    else if (after === undefined) inherited.push(name);
    else refused.push(name);
  }

  return Object.freeze({
    removed: Object.freeze(removed),
    absent: Object.freeze(absent),
    inherited: Object.freeze(inherited),
    refused: Object.freeze(refused),
  });
}
