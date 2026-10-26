# Browsix — Syscall-over-Worker Boundary (Clean Room Abstract)

**Source:** plasma-umass/browsix (TypeScript, research kernel). **License:** NOASSERTION at repo level — fully restricted; concepts only.
**Studied:** browser-node syscall client, syscall API, kernel dispatch structure, README process model.
**Informs:** our `Runtime` interface and the main-thread-never-blocks guarantee (ADR-0002 #2, #6, #7). No decisions made here.

## The boundary, in concept

**A process is a dedicated Web Worker. The kernel is a message-driven
scheduler living on another thread. They share nothing; every kernel
operation is a message round trip.**

1. **One port per process.** At spawn, the kernel creates a worker and
   a MessagePort pair; the process gets its half and talks *only*
   through it. The kernel holds the other half plus the process's
   descriptor tables, pipes, sockets, and environment. State is
   kernel-owned and single-sourced — processes see descriptors, not
   objects.

2. **A syscall is a correlatable message.** The process-side wrapper:
   - assigns each call a monotonically increasing id,
   - registers a callback for that id in an outstanding-calls map,
   - posts {id, operation-name, args} to the kernel,
   - on reply (matched by id), fires and clears the callback.
   The kernel side keeps a table of operation names → implementations
   and replies with {id, results}. Kernel→process messages also exist
   (signals, spawn arguments), same channel, opposite direction.

3. **The kernel is purely continuation-based.** Every kernel operation
   takes a "context" whose job is to deliver the result — it completes
   asynchronously whenever the work is actually done. The kernel loop
   handles messages one at a time and never blocks: there is no
   synchronous syscall anywhere on the kernel's thread. This is the
   mechanism behind "sync APIs block only the worker" (our ADR-0002 #2).

4. **Blocking semantics live inside the worker, not the kernel.** Two
   flavors of syscall client:
   - *Callback/async flavor* — for JS programs: calls return results
     via callbacks, exactly as above.
   - *Blocking flavor* — for compiled programs (C/C++/Go via
     emscripten/GopherJS) that genuinely execute synchronous code: the
     worker parks on a SharedArrayBuffer cell (Atomics wait) while the
     kernel computes the reply, then resumes. The *worker* thread
     blocks; the kernel and the main thread never do.

5. **Spawn is a bootstrap handshake.** Kernel spawns worker → posts an
   init message (argv, environment) → the process wires up its syscall
   table and signals ready → only then does user code run.

6. **Errors cross as plain data, rehydrated as typed errors.** Kernel
   errors are structured-cloneable records (POSIX-style code + message);
   the process side reconstructs them into real error objects with
   correct `code` fields before user code sees them. This is the
   contract that makes `fs` shims able to surface Node-faithful errors
   across a thread boundary.

## Applying it to our `Runtime` interface

- **Message schema first, RPC later.** Define our worker↔controller
  protocol as a typed request/reply envelope (id, op, args, reply) from
  day one; every future shim (fs, path, process, child_process) becomes
  a set of operation names over that one envelope, not bespoke
  channels. Browsix's whole syscall surface is one table of names.
- **Kernel-owned, single-sourced state** is the same shape as our
  ADR-0002 #6 single-owner VFS: the worker owns the VFS exactly as the
  browsix kernel owns descriptors — one owner, no two-way sync to get
  wrong (our audited hazard #4 disappears by construction).
- **The SharedArrayBuffer escape hatch** is how `readFileSync`-style
  semantics can exist in our worker lane without COOP/COEP becoming a
  correctness requirement for async-only programs: async-first surface
  (our current VFS), SAB+Atomics parking only where a real blocking
  contract is demanded. COOP/COEP headers stay mandatory for the SAB
  path, exactly as ADR-0002 #4 anticipates.
- **The spawn handshake** (init: argv/env → ready → run) is the natural
  shape for our future `child_process` stub (ADR-0002 #7): a spawned
  "process" is a fresh worker + port + init message, nothing more.
- **Error-rehydration contract** goes into the shim spec from the
  start: typed errors with POSIX `code`s serialized as plain records
  and rebuilt on the receiving side — our VFS's typed error classes are
  already the right raw material.

## Boundary discipline note

Browsix demonstrates the ceiling of this model: a full multi-process
Unix (pipes, signals, fork semantics) *is expressible* over one
message channel per process with zero main-thread blocking. We need a
fraction of that surface for Week 2; the concept scales down cleanly
because it is one channel, one table, one continuation discipline.
