/**
 * P3-0 in a real process Worker: the capture exists, it is not visible to user code, and the container still works.
 *
 * The capture itself is proven by the unit lane, which can call it directly. What only a browser can establish is the
 * ordering claim - that capture happened before any user code ran - and the privacy claim, that a program inside the
 * Worker cannot see the runtime's bindings on any surface it can reach.
 */
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

const REPORT = "P3REPORT:";

/**
 * Reports what user code can see of the capture, then does real work through the runtime.
 *
 * The work is the second half of the claim: a capture that existed but left the runtime broken would pass a
 * "not visible" assertion while failing the actual point of the phase.
 */
const PROGRAM = `
const report = { visible: {}, worked: {} };
for (const name of ["realmReferences", "quarantine", "captures", "realmCapture", "__realm", "__quarantine"]) {
  report.visible["globalThis." + name] = typeof globalThis[name];
  report.visible["self." + name] = typeof self[name];
  report.visible["process." + name] = typeof process[name];
}
// STRUCTURAL, not a name guess: the capture object is recognisable by its shape whatever it might be called. A name
// filter would miss a rename and would fire on unrelated browser globals, which is the wrong kind of wrong.
report.visible.captureShaped = Object.getOwnPropertyNames(globalThis).filter((name) => {
  // The global object IS the realm, so it answers to the same shape test. Excluded explicitly rather than by loosening
  // the predicate: the question is whether a capture OBJECT was published, and the global is the container it would hide in.
  if (name === "globalThis" || name === "self") return false;
  let value;
  try { value = globalThis[name]; } catch (error) { return false; }
  return Boolean(value) && typeof value === "object"
    && typeof value.TextEncoder === "function" && typeof value.Atomics === "object"
    && typeof value.SharedArrayBuffer === "function";
});

const fs = require("fs");
fs.writeFileSync("/p3.txt", "written after capture");
report.worked.fs = fs.readFileSync("/p3.txt", "utf8");
report.worked.function = typeof Function("return 1")();
report.worked.atomics = typeof Atomics;
report.worked.textDecoder = new TextDecoder().decode(new Uint8Array([111, 107]));
report.worked.wasm = typeof WebAssembly.instantiate === "function";

const http = require("http");
http.createServer((request, response) => response.end("p3")).listen(3310);
console.log("${REPORT}" + JSON.stringify(report));
`;

test("P3-0: the capture is invisible to user code and the container still works", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async ({ program }) => {
    const { ProcessKernel } = await import(new URL("/src/process/process-kernel.ts", location.origin).href);
    let text = "";
    const kernel = new ProcessKernel({
      files: { "/p3.js": program },
      transportTimeoutMs: 3_000,
      onOutput: (_pid: number, _channel: string, chunk: string) => {
        text += chunk;
      },
    });
    const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    try {
      const pid = kernel.start({ argv: ["node", "/p3.js"] });
      const listening = await waitFor(() =>
        (kernel.ports() as readonly { port: number }[]).some((binding) => binding.port === 3310),
      );
      const preview = await kernel.transport({
        method: "GET",
        url: "/preview/3310/p3",
        headers: {},
        body: new Uint8Array(),
      });
      return {
        listening,
        previewStatus: preview.statusCode,
        previewBody: new TextDecoder().decode(preview.body ?? new Uint8Array()),
        text,
        pid,
      };
    } finally {
      kernel.stopServers([3310]);
      kernel.dispose();
    }
  }, { program: PROGRAM });

  const line = outcome.text.split("\n").find((candidate) => candidate.startsWith(REPORT));
  expect(line, JSON.stringify(outcome)).toBeDefined();
  const report = JSON.parse((line ?? "").slice(REPORT.length)) as {
    visible: Record<string, unknown>;
    worked: Record<string, string>;
  };

  // Nothing the runtime captured is reachable from user code, on any surface a program can name.
  for (const [surface, value] of Object.entries(report.visible)) {
    if (surface === "captureShaped") continue;
    expect(value, `${surface} was visible: ${JSON.stringify(report.visible)}`).toBe("undefined");
  }
  expect(report.visible.captureShaped, JSON.stringify(report.visible)).toEqual([]);

  // And the runtime is not merely intact but doing the work: fs round trip, compilation, syscall primitives, decoding.
  expect(report.worked.fs, JSON.stringify(report.worked)).toBe("written after capture");
  expect(report.worked.function).toBe("number");
  expect(report.worked.atomics).toBe("object");
  expect(report.worked.textDecoder).toBe("ok");
  expect(report.worked.wasm).toBe(true);

  // The preview path a real project depends on, through the same boundary P2 established.
  expect(outcome.listening, JSON.stringify(outcome)).toBe(true);
  expect(outcome.previewStatus).toBe(200);
  expect(outcome.previewBody).toBe("p3");
});
