import { describe, expect, it } from "vitest";
import { InProcessRuntime } from "../../src/runtime/in-process.js";
import { createRefusal, ProcessRefusal, type Refusal } from "../../src/runtime/refusal.js";
import { FileSystem } from "../../src/vfs/index.js";

function boot(files: Record<string, string>): { vfs: FileSystem; root: string } {
  const vfs = new FileSystem();
  vfs.mkdirSync("/app", { recursive: true });
  for (const [path, contents] of Object.entries(files)) vfs.writeFileSync(`/app/${path}`, contents);
  return { vfs, root: "/app" };
}

const nativeAddon = (): Refusal => ({
  code: "native-addon",
  capability: "native addon",
  message: "Cannot load native addon /app/x.node: native addons are not supported in this runtime.",
  subject: "/app/x.node",
});

describe("refusal evidence is immutable at runtime (ADR-0014 D-10)", () => {
  it("freezes the refusal it returns", () => {
    const refusal = createRefusal(nativeAddon());
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("cannot have its diagnostic rewritten by a consumer", () => {
    const refusal = createRefusal(nativeAddon());
    expect(() => {
      (refusal as { message: string }).message = "tampered";
    }).toThrow();
    expect(refusal.message).toContain("native addons are not supported");
  });

  it("cannot have its code or subject rewritten", () => {
    const refusal = createRefusal(nativeAddon());
    expect(() => {
      (refusal as { code: string }).code = "something-else";
    }).toThrow();
    expect(() => {
      (refusal as { subject: string }).subject = "/elsewhere";
    }).toThrow();
    expect(refusal.code).toBe("native-addon");
    expect(refusal.subject).toBe("/app/x.node");
  });

  it("is a copy, so later edits to the input cannot reach the captured evidence", () => {
    const input = nativeAddon();
    const refusal = createRefusal(input);
    // Cast deliberately: this test simulates a consumer that ignores the type, which is exactly what freeze defends
    // against. If the compiler allowed it, the freeze would be the only guard left.
    (input as { message: string }).message = "changed after capture";
    expect(refusal.message).toBe("Cannot load native addon /app/x.node: native addons are not supported in this runtime.");
  });

  it("freezes the refusal carried by ProcessRefusal", () => {
    const error = new ProcessRefusal(nativeAddon());
    expect(Object.isFrozen(error.refusal)).toBe(true);
    expect(error.refusal.code).toBe("native-addon");
    expect(error.message).toContain("native addon");
  });
});

describe("the runtime surfaces an unhandled refusal (ADR-0014)", () => {
  it("reports the refusal, its code and its subject when it escapes the program", async () => {
    const { vfs, root } = boot({ "main.js": 'require("./x.node");', "x.node": "\u0000binary" });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(1);
    expect(result.refusal).toBeDefined();
    expect(result.refusal?.code).toBe("native-addon");
    expect(result.refusal?.capability).toBe("native addon");
    expect(result.refusal?.subject).toBe("/app/x.node");
    expect(result.refusal?.message).toContain("native addons are not supported");
    expect(Object.isFrozen(result.refusal)).toBe(true);
  });

  it("records no refusal when the program catches it and exits cleanly", async () => {
    const { vfs, root } = boot({
      "main.js": 'try { require("./x.node"); } catch { console.log("handled"); }',
      "x.node": "\u0000binary",
    });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(0);
    expect(result.refusal).toBeUndefined();
    expect(result.stdout).toBe("handled\n");
  });

  it("records no refusal for an ordinary failure", async () => {
    const { vfs, root } = boot({ "main.js": "throw new Error('plain failure');" });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(1);
    expect(result.refusal).toBeUndefined();
  });

  it("records no refusal when the program exits before touching the addon", async () => {
    const { vfs, root } = boot({ "main.js": "process.exit(3);", "x.node": "\u0000binary" });
    const result = await new InProcessRuntime(vfs).run(`${root}/main.js`);

    expect(result.exitCode).toBe(3);
    expect(result.refusal).toBeUndefined();
  });
});
