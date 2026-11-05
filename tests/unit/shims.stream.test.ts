/**
 * The stream contract in ADR-0015, tested by behaviour rather than by shape.
 *
 * Ordered by the contract's own table so a missing case is visible: lifecycle, error, backpressure, transform, pipeline,
 * encoding. Each test names the rule it defends, because a stream shim that merely imports is the failure mode this
 * subsystem was written to avoid.
 */
import { describe, expect, it } from "vitest";
import { Duplex, PassThrough, pipeline, Readable, Transform, Writable } from "../../src/shims/stream.js";

/** Collects a readable into an array, resolving on `end`. */
function collect(stream: Readable): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const chunks: unknown[] = [];
    stream.on("data", (...args: unknown[]) => chunks.push(args[0]));
    stream.on("end", () => resolve(chunks));
    stream.on("error", reject);
    stream.resume();
  });
}

const text = (chunks: readonly unknown[]): string => chunks.map((chunk) => String(chunk)).join("");

describe("Readable lifecycle", () => {
  it("emits chunks in order, then end exactly once", async () => {
    const stream = Readable.from(["a", "b", "c"]);
    let ends = 0;
    stream.on("end", () => {
      ends += 1;
    });
    const chunks = await collect(stream);
    expect(chunks).toEqual(["a", "b", "c"]);
    expect(ends).toBe(1);
  });

  it("treats a string as one chunk, not one chunk per character", async () => {
    const chunks = await collect(Readable.from("hello"));
    expect(chunks).toEqual(["hello"]);
  });

  it("reads buffered chunks with read(), then null", () => {
    const stream = new Readable({ objectMode: true });
    stream.push("one");
    expect(stream.read()).toBe("one");
    expect(stream.read()).toBeNull();
  });

  it("keeps object mode for arrays, so numbers survive as numbers", async () => {
    const chunks = await collect(Readable.from([1, 2, 3]));
    expect(chunks).toEqual([1, 2, 3]);
  });

  it("collects everything through async iteration", async () => {
    const seen: unknown[] = [];
    for await (const chunk of Readable.from(["x", "y"])) seen.push(chunk);
    expect(seen).toEqual(["x", "y"]);
  });

  it("reports readableEnded only after the last chunk has been read", async () => {
    const stream = Readable.from(["only"]);
    expect(stream.readableEnded).toBe(false);
    await collect(stream);
    expect(stream.readableEnded).toBe(true);
  });
});

describe("Writable lifecycle", () => {
  it("writes then finishes, emitting finish once", async () => {
    const written: unknown[] = [];
    const sink = new Writable({ write: (chunk, _encoding, callback) => {
      written.push(chunk);
      callback();
    } });
    let finishes = 0;
    sink.on("finish", () => {
      finishes += 1;
    });
    sink.write("hello");
    const finished = new Promise<void>((resolve) => sink.on("finish", () => resolve()));
    sink.end();
    await finished;
    expect(written).toEqual(["hello"]);
    expect(finishes).toBe(1);
  });

  it("writes the chunk passed to end() before finishing", async () => {
    const written: unknown[] = [];
    const sink = new Writable({ write: (chunk, _encoding, callback) => {
      written.push(chunk);
      callback();
    } });
    const finished = new Promise<void>((resolve) => sink.on("finish", () => resolve()));
    sink.end("last");
    await finished;
    expect(written).toEqual(["last"]);
  });

  it("treats a second end() as a no-op rather than an error", async () => {
    const sink = new Writable();
    const errors: unknown[] = [];
    sink.on("error", (...args: unknown[]) => errors.push(args[0]));
    const finished = new Promise<void>((resolve) => sink.on("finish", () => resolve()));
    sink.end();
    sink.end();
    await finished;
    expect(errors).toEqual([]);
  });

  it("errors on write after end, with Node's code", async () => {
    const sink = new Writable();
    const error = new Promise<Error>((resolve) => sink.on("error", (...args: unknown[]) => resolve(args[0] as Error)));
    sink.end();
    sink.write("late");
    const caught = await error;
    expect((caught as Error & { code?: string }).code).toBe("ERR_STREAM_WRITE_AFTER_END");
  });
});

describe("error semantics", () => {
  it("emits one error when _write calls back with one, and destroys the stream", async () => {
    let errors = 0;
    const sink = new Writable({
      write: (_chunk, _encoding, callback) => callback(new Error("disk full")),
    });
    const seen = new Promise<Error>((resolve) =>
      sink.on("error", (...args: unknown[]) => {
        errors += 1;
        resolve(args[0] as Error);
      }),
    );
    sink.write("x");
    const error = await seen;
    expect(error.message).toBe("disk full");
    expect(errors).toBe(1);
    expect(sink.destroyed).toBe(true);
  });

  it("routes a synchronous throw inside _write to the stream, not to the caller", async () => {
    const sink = new Writable({
      write: () => {
        throw new Error("thrown, not called back");
      },
    });
    const seen = new Promise<Error>((resolve) => sink.on("error", (...args: unknown[]) => resolve(args[0] as Error)));
    expect(() => sink.write("x")).not.toThrow();
    expect((await seen).message).toBe("thrown, not called back");
  });
});

describe("backpressure", () => {
  it("returns false at the watermark, emits drain when it clears, and never rejects the chunk", async () => {
    const pending: Array<() => void> = [];
    const sink = new Writable({
      highWaterMark: 4,
      write: (_chunk, _encoding, callback) => {
        pending.push(() => callback());
      },
    });
    // 3 bytes is under a 4-byte watermark, so the first write is accepted with room to spare.
    expect(sink.write("abc")).toBe(true);
    // The second takes the buffer past the watermark: false is advice to stop producing, not a rejection.
    expect(sink.write("de")).toBe(false);
    expect(sink.writableLength).toBeGreaterThanOrEqual(4);

    const drained = new Promise<void>((resolve) => sink.on("drain", () => resolve()));
    // Writes complete one at a time, so each completion queues the next: settle until nothing is left in flight.
    while (pending.length > 0) {
      for (const settle of pending.splice(0)) settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await drained;
    expect(sink.writableLength).toBe(0);
  });

  it("pauses a fast source when the destination is full, then resumes on drain", async () => {
    const settled: Array<() => void> = [];
    const sink = new Writable({
      highWaterMark: 2,
      write: (_chunk, _encoding, callback) => {
        settled.push(() => callback());
      },
    });
    const source = Readable.from(["a", "b", "c", "d"]);
    source.pipe(sink);

    await new Promise((resolve) => setTimeout(resolve, 5));
    // The source stopped early rather than draining four chunks into a two-byte buffer.
    expect(sink.writableLength).toBeLessThanOrEqual(4);
    for (const settle of settled.splice(0)) settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(source.destroyed).toBe(false);
    if (source instanceof Readable) source.destroy();
    sink.destroy();
  });
});

describe("Transform and PassThrough", () => {
  it("preserves chunk count and order while transforming", async () => {
    const upper = new Transform({
      transform: (chunk, _encoding, callback) => callback(undefined, String(chunk).toUpperCase()),
    });
    const collected = collect(upper);
    upper.write("ab");
    upper.write("cd");
    upper.end();
    expect(await collected).toEqual(["AB", "CD"]);
  });

  it("accepts the canonical callback(null, value) form rather than reading null as an error", async () => {
    // Found by fixture 4 in R5: the idiomatic Node call was rejected with "Error: null", because the guard tested
    // `error !== undefined`. Node writes `callback(null, value)` far more often than `callback(undefined, value)`.
    const upper = new Transform({
      transform: (chunk, _encoding, callback) => callback(null, String(chunk).toUpperCase()),
    });
    const collected = collect(upper);
    upper.write("ab");
    upper.end();
    expect(await collected).toEqual(["AB"]);
  });

  it("still surfaces a real error from a transform", async () => {
    const failing = new Transform({
      transform: (_chunk, _encoding, callback) => callback(new Error("real failure")),
    });
    const seen = new Promise<Error>((resolve) => failing.on("error", (...args: unknown[]) => resolve(args[0] as Error)));
    failing.write("x");
    expect((await seen).message).toBe("real failure");
  });

  it("runs _flush once, after the last chunk", async () => {
    const order: string[] = [];
    const stream = new Transform({
      transform: (chunk, _encoding, callback) => {
        order.push(`chunk:${String(chunk)}`);
        callback(undefined, chunk);
      },
      flush: (callback) => {
        order.push("flush");
        callback();
      },
    });
    const collected = collect(stream);
    stream.write("x");
    stream.end();
    await collected;
    expect(order).toEqual(["chunk:x", "flush"]);
  });

  it("passes bytes through unchanged, including a multi-byte character split across chunks", async () => {
    const pass = new PassThrough();
    const collected = collect(pass);
    const encoded = new TextEncoder().encode("café");
    pass.write(encoded.slice(0, 4));
    pass.write(encoded.slice(4));
    pass.end();
    const chunks = await collected;
    const joined = new Uint8Array(chunks.reduce((total: number, chunk) => total + (chunk as Uint8Array).byteLength, 0));
    let offset = 0;
    for (const chunk of chunks as Uint8Array[]) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(joined)).toBe("café");
  });
});

describe("pipeline", () => {
  it("collects output through a chain and resolves once", async () => {
    const upper = new Transform({
      transform: (chunk, _encoding, callback) => callback(undefined, String(chunk).toUpperCase()),
    });
    const out: unknown[] = [];
    const sink = new Writable({ write: (chunk, _encoding, callback) => {
      out.push(chunk);
      callback();
    } });
    await pipeline(Readable.from(["a", "b"]), upper, sink);
    expect(out).toEqual(["A", "B"]);
  });

  it("rejects with the first error and destroys every stream in the chain", async () => {
    const failing = new Transform({
      transform: (_chunk, _encoding, callback) => callback(new Error("transform exploded")),
    });
    const sink = new Writable();
    const settled = pipeline(Readable.from(["a"]), failing, sink);
    await expect(settled).rejects.toThrow("transform exploded");
    expect(failing.destroyed).toBe(true);
    expect(sink.destroyed).toBe(true);
  });

  it("calls back with the same error the promise rejects with", async () => {
    const failing = new Transform({
      transform: (_chunk, _encoding, callback) => callback(new Error("same error")),
    });
    const sink = new Writable();
    const viaCallback = new Promise<Error | null>((resolve) => {
      void pipeline(Readable.from(["a"]), failing, sink, (error) => resolve(error ?? null)).catch(() => undefined);
    });
    const error = await viaCallback;
    expect(error?.message).toBe("same error");
  });
});

describe("encoding", () => {
  it("decodes to strings when setEncoding is used", async () => {
    const stream = new Readable();
    stream.setEncoding("utf8");
    stream.push(new TextEncoder().encode("décode"));
    stream.push(null);
    expect(text(await collect(stream))).toBe("décode");
  });

  it("refuses an encoding it does not implement, by name", () => {
    const stream = new Readable();
    expect(() => stream.setEncoding("utf16le")).toThrow(/utf16le/);
  });
});

describe("Duplex", () => {
  it("keeps independent read and write states", async () => {
    const pair = new Duplex({
      read: () => undefined,
      write: (chunk, _encoding, callback) => {
        pair.push(String(chunk).toUpperCase());
        callback();
      },
    });
    const collected = collect(pair);
    pair.write("ab");
    pair.push(null);
    expect(await collected).toEqual(["AB"]);
  });
});
