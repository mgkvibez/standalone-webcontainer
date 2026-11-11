/**
 * `worker_threads`: honest answers about this thread, and a refusal for making another.
 *
 * Vite imports `Worker` at module scope and only constructs one for plugins that ask for a worker. The import must therefore succeed. What must not
 * succeed is the construction: a nested Worker inside the sandbox's worker is not available, and returning a thread-shaped object that never runs
 * code would turn a missing capability into silence.
 *
 * `isMainThread` is true because this IS the thread the program runs on: there is no parent port and no thread id to hand back.
 */

const unavailable = (member: string, why: string): never => {
  throw Object.assign(new Error(`worker_threads.${member} is not available in this runtime: ${why}`), {
    code: "ERR_WORKER_UNAVAILABLE",
    syscall: member,
  });
};

export const isMainThread = true;
export const parentPort = null;
export const threadId = 0;
export const workerData = null;

export class Worker {
  constructor() {
    unavailable("Worker", "this runtime runs the program on its only thread and cannot start another");
  }
}

export class MessageChannel {
  constructor() {
    unavailable("MessageChannel", "there is no second thread to exchange messages with");
  }
}

export class MessagePort {
  constructor() {
    unavailable("MessagePort", "there is no second thread to exchange messages with");
  }
}

export default { isMainThread, parentPort, threadId, workerData, Worker, MessageChannel, MessagePort };
