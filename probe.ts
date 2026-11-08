import { FileSystem } from "./src/vfs/index.js";
import { InProcessRuntime } from "./src/runtime/in-process.js";

const vfs = new FileSystem();
vfs.writeFileSync("/case.js", "console.log('hello'); setTimeout(() => console.log('later'), 5);");
const runtime = new InProcessRuntime(vfs);
const result = await runtime.run("/case.js", { timeoutMs: 5000 });
console.log(JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exit: result.exitCode }, null, 2));
