/**
 * Typed Syscall Envelope tests (ADR-0003, Decision 2).
 *
 * Covers the Phase 2 acceptance contract: concurrent calls with distinct
 * msgIds resolve to their own results regardless of reply order, and a
 * worker-side error rehydrates on the caller side with its POSIX code.
 * Also covers every other exposed behavior — stale replies, unknown
 * ops, dispose, the outstanding map's cleanup, and an end-to-end run
 * through a REAL MessageChannel (the transport this will use in the
 * worker), which Node provides without a browser.
 */
import { describe, expect, it } from "vitest";
import {
  OutstandingCallsMap,
  SyscallClient,
  SyscallError,
  SyscallKernel,
  UNKNOWN_ERROR_CODE,
  UNIMPLEMENTED_ERROR_CODE,
  rehydrateError,
  serializeError,
  type SyscallRequest,
} from "../../src/runtime/envelope.js";

function fakeVfsError(): Error {
  // The exact shape our VFS throws: Error with a POSIX code property.
  const error = new Error("ENOENT: no such file or directory, '/gone.txt'");
  (error as { code?: string }).code = "ENOENT";
  return error;
}

describe("OutstandingCallsMap", () => {
  it("registers, settles, and removes exactly one entry per msgId", () => {
    const map = new OutstandingCallsMap();
    let resolved = "";
    map.register(1, (v) => {
      resolved = String(v);
    }, () => {});
    expect(map.size).toBe(1);
    const call = map.take(1);
    expect(call).toBeDefined();
    call?.resolve("payload");
    expect(resolved).toBe("payload");
    expect(map.size).toBe(0);
    expect(map.take(1)).toBeUndefined(); // cleanup happened
  });

  it("rejectAll rejects every pending call and empties the map", () => {
    const map = new OutstandingCallsMap();
    const rejections: unknown[] = [];
    map.register(1, () => {}, (r) => {
      rejections.push(r);
    });
    map.register(2, () => {}, (r) => {
      rejections.push(r);
    });
    map.rejectAll(new SyscallError("EUNKNOWN", "dispose"));
    expect(rejections.length).toBe(2);
    expect(map.size).toBe(0);
  });
});

describe("SyscallClient: reply correlation", () => {
  it("resolves concurrent calls to their own results even when replies arrive in reverse order", async () => {
    const requests: SyscallRequest[] = [];
    const client = new SyscallClient((request) => {
      requests.push(request);
    });
    const pending = [client.call("op", "A"), client.call("op", "B"), client.call("op", "C")];
    expect(client.pending).toBe(3);
    expect(new Set(requests.map((r) => r.msgId)).size).toBe(3); // monotonic, unique

    // Replies arrive in the opposite order of issue.
    for (const request of [...requests].reverse()) {
      client.handleResponse({ msgId: request.msgId, success: true, result: `reply-${request.args[0]}` });
    }
    expect(await Promise.all(pending)).toEqual(["reply-A", "reply-B", "reply-C"]);
    expect(client.pending).toBe(0); // every entry cleaned up
  });

  it("ignores replies for unknown msgIds instead of throwing", () => {
    const client = new SyscallClient(() => {});
    expect(() => client.handleResponse({ msgId: 999, success: true, result: "late" })).not.toThrow();
  });

  it("dispose rejects in-flight calls", async () => {
    const client = new SyscallClient(() => {});
    const pending = client.call("slow-op", 42);
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(SyscallError);
    await expect(pending).rejects.toMatchObject({ code: UNKNOWN_ERROR_CODE });
  });
});

describe("error rehydration contract", () => {
  it("rehydrates a worker-side POSIX-coded error with its code and message", async () => {
    const kernel = new SyscallKernel();
    kernel.register("vfs.read", (() => {
      throw fakeVfsError();
    }) as unknown as (...args: never[]) => unknown);
    const responses: { posted: unknown }[] = [];
    const listener = kernel.attach((response) => {
      responses.push({ posted: response });
    });
    listener({ msgId: 1, op: "vfs.read", args: ["/gone.txt"] });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    const client = new SyscallClient(() => {}); // reply side only
    const pending = client.call("vfs.read", "/gone.txt");
    client.handleResponse(responses[0]?.posted as never);
    await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
    try {
      await pending;
    } catch (error) {
      expect(error).toBeInstanceOf(SyscallError);
      expect((error as SyscallError).message).toContain("/gone.txt");
    }
  });

  it("falls back to EUNKNOWN for errors without a code", () => {
    expect(serializeError(new TypeError("bad argument"))).toEqual({ code: UNKNOWN_ERROR_CODE, message: "bad argument" });
    expect(serializeError("a string rejection")).toEqual({ code: UNKNOWN_ERROR_CODE, message: "a string rejection" });
  });

  it("rehydrateError keeps code and message", () => {
    const error = rehydrateError({ code: "EISDIR", message: "illegal operation on a directory" });
    expect(error).toBeInstanceOf(SyscallError);
    expect(error.code).toBe("EISDIR");
    expect(error.message).toBe("illegal operation on a directory");
  });
});

describe("SyscallKernel", () => {
  it("returns ENOSYS for an unregistered op", async () => {
    const kernel = new SyscallKernel();
    const response = await kernel.handle({ msgId: 7, op: "nope", args: [] });
    expect(response).toEqual({
      msgId: 7,
      success: false,
      error: { code: UNIMPLEMENTED_ERROR_CODE, message: "syscall not implemented: nope" },
    });
  });

  it("awaits async handlers and posts only after they settle", async () => {
    const kernel = new SyscallKernel();
    kernel.register("delayed", (async (tag: never) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      return `done-${String(tag)}`;
    }) as unknown as (...args: never[]) => unknown);
    const response = await kernel.handle({ msgId: 3, op: "delayed", args: ["x"] });
    expect(response).toEqual({ msgId: 3, success: true, result: "done-x" });
  });
});

describe("end-to-end over a real MessageChannel", () => {
  it("round-trips concurrent calls and POSIX-coded errors through a real port pair", async () => {
    const { port1, port2 } = new MessageChannel();

    // Worker side.
    const kernel = new SyscallKernel();
    kernel.register("vfs.stat", (async () => {
      throw fakeVfsError();
    }) as unknown as (...args: never[]) => unknown);
    kernel.register("echo", (async (tag: never) => `echo:${String(tag)}`) as unknown as (...args: never[]) => unknown);
    port2.onmessage = (event: MessageEvent) => {
      kernel.attach((response) => {
        port2.postMessage(response);
      })(event.data as SyscallRequest);
    };

    // Caller side.
    const client = new SyscallClient((request) => {
      port1.postMessage(request);
    });
    port1.onmessage = (event: MessageEvent) => {
      client.handleResponse(event.data as never);
    };

    const [a, b, err] = await Promise.allSettled([
      client.call("echo", "first"),
      client.call("echo", "second"),
      client.call("vfs.stat", "/gone.txt"),
    ]);
    expect(a).toEqual({ status: "fulfilled", value: "echo:first" });
    expect(b).toEqual({ status: "fulfilled", value: "echo:second" });
    expect(err.status).toBe("rejected");
    expect((err as PromiseRejectedResult).reason).toMatchObject({ code: "ENOENT" });
    port1.close();
    port2.close();
  });
});
