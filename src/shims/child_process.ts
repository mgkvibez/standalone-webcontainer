/**
 * `child_process`: the module loads, and every way of *using* it refuses.
 *
 * Node has this builtin, so `require("child_process")` succeeds there and means nothing on its own. Two earlier versions of this boundary got
 * that wrong in different ways. The first reported `Cannot find module 'child_process'`, which reads as a defect in this loader. The second
 * refused at load time with a typed refusal, which was honest about the capability but wrong about where it applies: vite's dependency chunk
 * opens with `import require$$2$1 from 'child_process'` and reached that line before any code had asked to spawn anything, so boot stopped on an
 * import that Node would have satisfied. The capability being refused is spawning, not importing, and the refusal now lands on the call, where
 * the command is known and can be quoted in the message.
 *
 * Same refusal code as before (`NATIVE_PROCESS_EXEC_REFUSED`): the closed set did not grow, only the moment it fires moved.
 */

import { ProcessRefusal } from "../runtime/refusal.js";
import { packageOwnerOf } from "../runtime/package-owner.js";

/** The frame outside this file, so the refusal points at the caller's line rather than at the shim. */
function callerFrame(): string | null {
  const stack = new Error().stack?.split("\n").slice(1) ?? [];
  const frame = stack.find((line) => !line.includes("child_process.ts") && !line.includes("child_process.js"));
  return frame?.trim() ?? null;
}

/**
 * The file the caller lives in, taken from its frame.
 *
 * Used only to name an owning package. A frame that cannot be parsed simply means the message says less, never that the refusal fails.
 */
function callerFile(frame: string | null): string | null {
  if (frame === null) return null;
  const match = frame.match(/\(?(\/[^()]+?):\d+:\d+\)?$/);
  return match?.[1] ?? null;
}

/** The command as a person would type it, so the message names what was refused rather than naming a function. */
function commandLine(command: string, args: readonly unknown[] | undefined): string {
  const parts = [command, ...(args ?? []).filter((arg): arg is string => typeof arg === "string")];
  return parts.join(" ");
}

/**
 * Refuse one call. `operation` is the exported name, `command` the program that would have run.
 *
 * Thrown rather than returned as an `error` event: Node's async forms fail through a callback or an event, but there is no process to attach an
 * event to, and a caller that awaited an `'error'` that never comes would hang. A throw is catchable in every form, which the ADR-0014 contract
 * requires, and it is what a program sees when the spawn itself fails to start for any other reason.
 */
function refuse(operation: string, command: string, args: readonly unknown[] | undefined): never {
  const frame = callerFrame();
  const file = callerFile(frame);
  const owner = file === null ? null : packageOwnerOf(file);
  throw new ProcessRefusal({
    code: "NATIVE_PROCESS_EXEC_REFUSED",
    capability: "native process spawn",
    message:
      `Cannot ${operation}(${JSON.stringify(commandLine(command, args))}): this runtime cannot spawn a native process` +
      `${owner === null ? "" : `, which ${owner} needs`}. ` +
      "A package that needs one must ship a WASM build or be replaced through a substitution." +
      (frame === null ? "" : ` (${frame})`),
    subject: `spawn ${commandLine(command, args)} requested from ${file ?? "an unknown file"}`,
  });
}

export function spawn(command: string, args?: readonly unknown[]): never {
  return refuse("spawn", command, args);
}

export function spawnSync(command: string, args?: readonly unknown[]): never {
  return refuse("spawnSync", command, args);
}

export function exec(command: string): never {
  return refuse("exec", command, undefined);
}

export function execSync(command: string): never {
  return refuse("execSync", command, undefined);
}

export function execFile(file: string, args?: readonly unknown[]): never {
  return refuse("execFile", file, args);
}

export function execFileSync(file: string, args?: readonly unknown[]): never {
  return refuse("execFileSync", file, args);
}

export function fork(modulePath: string, args?: readonly unknown[]): never {
  return refuse("fork", modulePath, args);
}

/**
 * Node's `ChildProcess`. Constructing one directly spawns nothing, but every instance exists to be a handle on a process that does not exist here,
 * so the honest answer is the same refusal rather than an object whose properties are all undefined.
 */
export class ChildProcess {
  constructor() {
    refuse("new ChildProcess", "", undefined);
  }
}

export default {
  spawn,
  spawnSync,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
  ChildProcess,
};
