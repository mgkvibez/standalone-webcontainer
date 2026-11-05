# P1b — the first assembled environment

Baseline `3de6b06` (P1a). P1b turns the browser smoke test into a workspace: projects, an explorer, an editor, a terminal
that executes real commands, a process table, and persistence.

Screenshots: `p1b-workspace.png` (a real run), `p1b-termination.png` (a killed process and a second session).

## 1. What exists now

```
page (DOM)                         Worker (execution)
┌────────────────────────────┐     ┌───────────────────────────────────────────┐
│ ProjectStore (localStorage)│     │ runtime.worker.ts                         │
│   projects, files, dirs    │     │   per run: new FileSystem() → seed files  │
│                            │     │           new InProcessRuntime(vfs)       │
│ Container                  │◄───►│           run(entry, {onOutput})          │
│   sessions, process table  │ msg │                                           │
│   command dispatch         │     │ InProcessRuntime                          │
│                            │     │   loaders · shims · scheduler · gateway    │
│ workspace.ts (CodeMirror)  │     └───────────────────────────────────────────┘
└────────────────────────────┘
```

* **The page owns the files.** The Worker's VFS is built per run from one project's file map and thrown away with it.
  Persistence, project isolation and host restarts all fall out of that single decision.
* **The container owns processes and dispatch** (`src/container/`), and knows neither the DOM nor the Worker: it takes a
  `RuntimeClient` and a `ProjectFiles`. That is why its 22 tests run in Node with a fake runtime.
* **The Worker owns execution** and nothing else. It is a thread boundary, not a sandbox.

### Process lifecycle

```
submit ──► queued ──► running ──┬──► exited   (program returned; exitCode recorded)
                                ├──► failed   (runtime threw, or the deadline expired)
                                └──► killed   (user stopped it; NO exit code is invented)

kill while queued ──► killed      (never dispatched)
kill while running ──► host destroyed, run resolves as killed, next run starts a fresh host
```

`terminate()` is a hard stop: the only cancellation the runtime has. A script that never yields cannot be preempted, so
the host is discarded. The record says `killed`, never a fabricated exit code.

## 2. The investigation (§9), answered

**How does the runtime represent execution?** `InProcessRuntime.run(entryPath, options)` returns
`{stdout, stderr, exitCode, timedOut, durationMs, scheduler}`. Output was buffered in two sinks and read only at the end.

**Can an execution stay alive after the initial script completes?** Only within one `run()` call. `run()` drains the
virtual timer queue to quiescence, then returns. There is no handle to a live runtime object afterwards, so "a process
that outlives its script" does not exist yet: a `setInterval` runs to the scheduler's budget and the call returns.

**Can independent processes share one VFS?** Not today, and deliberately not used: each run gets its own VFS. Sharing one
would require a supervisor inside the Worker holding a VFS across runs, which is the P1c change (below).

**How are async work and event loops managed?** By the virtual scheduler (ADR-0013): timers, `setImmediate`, `Date`,
`performance`, drained to quiescence with a 1,000 ms virtual budget, then continuations drained before output is read.

**How does Worker termination affect process state?** It destroys everything in the Worker. In-flight runs resolve as
`killed` on the page side (`WorkerRuntimeClient.reset()`), pending chunk callbacks stop, and the VFS is gone with the host.
Nothing is lost that matters, because the page holds the files.

**How can stdout/stderr be delivered incrementally?** This milestone added one additive option, `RunOptions.onOutput`,
threaded through `createSink(onChunk)`:

```ts
const stdout = createSink(onOutput === undefined ? undefined : (text) => onOutput("stdout", text));
```

Absent, behaviour is byte-identical to before (all pre-existing tests pass unchanged). Present, each write reaches the
terminal as it happens. This is the one production change in P1b and it is additive, not a semantic change.

**What would long-running dev servers need?** (a) execution that survives its own bootstrap, (b) an event loop that idles
instead of draining to quiescence, (c) a way to stop one run without killing the host, (d) service-worker registration for
`/preview/<port>`. None of that is P1b; see the P1c section.

**What the runtime cannot support today:** no `crypto`, `child_process`, `net`, sockets or `worker_threads`; no
preemption; no signals; no concurrency inside one host; no `fs.watch`. Output for a hung sync script is whatever was
already flushed before it hung.

## 3. Supported commands

`node <file> [args...]`, `cd`, `pwd`, `ls`, `cat`, `mkdir`, `touch`, `rm`, `echo`, `clear`, `help`, `ps`, `kill`.

Refused **by name**, with a reason: `npm`, `npx`, `pnpm`, `yarn`, `sh`, `bash`, `zsh`. Unknown commands say they are not
supported and point at `help`. No pipes, globbing, redirection, `VAR=value` prefixes, job control, or `node -e`.

`ls`, `cat`, `mkdir`, `touch`, `rm` operate on the same project files the explorer shows, through one `ProjectFiles`
view. There is no second filesystem.

## 4. CSP investigation (measured, not assumed)

Worker script responses, captured with Playwright:

| | dev server | production build |
|---|---|---|
| worker URL | `/src/browser/runtime.worker.ts?worker_file&type=module` | `/assets/runtime.worker-*.js` |
| `content-type` | `text/javascript` | `text/javascript` |
| `content-security-policy` | *(none)* | *(none)* |
| `x-content-type-options` | *(none)* | *(none)* |
| `cross-origin-embedder-policy` | *(none)* | *(none)* |

So: **the origins we serve send no CSP at all today**, and no COOP/COEP either (which is why there is no
`SharedArrayBuffer`, by design). The runtime needs eval because both loaders compile with `new Function`
(`src/runtime/commonjs.ts`); the policy that works is `script-src 'self' 'unsafe-eval'; worker-src 'self'`, asserted by a
test. Two earlier findings still stand: a document CSP of `script-src 'self'` blocks `blob:` workers (so `worker-src` must
allow ours), and it did not stop `new Function` inside our same-origin module Worker. **Do not treat CSP, or the Worker, as
containment for hostile code.**

## 5. Known limitations, stated plainly

1. **No concurrency.** Executions are serialised behind one queue; a second `node` waits. Real concurrency needs a Worker
   per process, which changes the host model.
2. **Termination is all-or-nothing.** Stopping a hung script kills the host, which would take any other in-flight run with
   it (there is at most one).
3. **A `while (true)` costs a Worker spawn.** The page stays responsive; the host does not survive.
4. **No streaming for a sync loop.** Output flushed before the hang is all the terminal can show.
5. **`localStorage` only.** Quota-limited (a few MB), synchronous, per-origin, and gone in private-mode storage. Corruption
   is handled (a fresh project plus a visible notice) but not repair.
6. **No `npm install` UI.** The installer and corpus are complete and tested; wiring `npm` into the terminal is a
   command-contract decision, deliberately not taken here.
7. **`prompt()` for new file/dir/project names.** Honest but plain; replaced by inline inputs in P1c.
8. **Project switching discards nothing but reseeds per run**, so a very large project would pay the seed cost per run.
9. **No syntax mode beyond JavaScript** (`.json` files open in the JS mode).
10. **No preview, no port forwarding, no service worker registration.** All P1c+.

## 6. Recommended P1c architecture

1. **Supervisor in the Worker**: keep one VFS and one runtime per *project* inside the host, so a re-run does not reseed and
   a dev server can survive its bootstrap. Message protocol becomes `load(project) → run(entry) → kill(pid)`.
2. **Worker pool with a scheduler** if concurrency is wanted: one Worker per running process, page-side arbitration, an
   explicit cap (memory is the real limit, not CPU).
3. **Node-shaped stdio**: give `run()` a write-back channel so `process.stdout.write` and a PTY-shaped terminal share one
   pipe; this is the prerequisite for xterm.js replacing the current line log.
4. **Service-worker registration + preview iframe**, which is the first milestone that needs COOP/COEP decisions and a real
   CSP policy for the app origin.
5. **IndexedDB** behind the same `ProjectStore` interface when projects outgrow `localStorage`.
