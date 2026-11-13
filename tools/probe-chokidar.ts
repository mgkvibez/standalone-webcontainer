/**
 * Probe: does chokidar see the project tree, and does a save reach it?
 *
 * The acceptance journey renders the app and then waits forever for the hot update: vite never prints `hmr update`, and a probe of vite's own
 * watcher says it holds the root and its config file and NOTHING ELSE. Two candidate causes, told apart here instead of in a three-minute browser
 * run: (1) `readdir` of the root hands a real package no children, or (2) chokidar's scan works and the change event never arrives.
 *
 * Run: `npx vite-node tools/probe-chokidar.ts`
 */
import { Container } from "../src/container/container.js";
import { createNetworkRegistry } from "../src/registry/network.js";
import { InProcessClient, MapFiles } from "./harness/fixture-executor.js";

const watcherScript = `
const chokidar = require("chokidar");
const fs = require("fs");

const listing = (path) => {
  try {
    return JSON.stringify(fs.readdirSync(path));
  } catch (error) {
    return "ERR " + (error && error.code ? error.code : String(error));
  }
};
const versionOf = (name) => {
  try { return JSON.parse(fs.readFileSync("/node_modules/" + name + "/package.json", "utf8")).version; }
  catch (error) { return "missing"; }
};
console.log("VERSIONS chokidar=" + versionOf("chokidar") + " readdirp=" + versionOf("readdirp") + " anymatch=" + versionOf("anymatch") + " is-glob=" + versionOf("is-glob"));
console.log("LISTING / " + listing("/"));
fs.readdir("/", { withFileTypes: true }, (error, entries) => {
  console.log("CB-READDIR " + (error ? "ERR " + String(error) : JSON.stringify((entries || []).map((entry) => ({ name: entry && entry.name, dir: entry && typeof entry.isDirectory === "function" ? entry.isDirectory() : "NO-ISDIR" })))));
});
fs.readdir("/", (error, entries) => {
  console.log("CB-READDIR-PLAIN " + (error ? "ERR " + String(error) : JSON.stringify(entries)));
});
console.log("LISTING /src " + listing("/src"));

// A listening port, because a process that keeps only a watcher is retired at exit in this product (holdOpen asks about ports), and its timers
// then never run - the probe would report "nothing happened" for a reason that has nothing to do with chokidar.
require("http").createServer((request, response) => response.end("ok")).listen(3411);
fs.promises.readdir("/", { withFileTypes: true }).then(
  (entries) => console.log("PROMISE-READDIR kind=" + typeof (entries[0] && entries[0].isDirectory) + " " + JSON.stringify(entries.map((entry) => (typeof entry === "string" ? "STR:" + entry : entry.name + ":" + entry.isDirectory())))),
  (error) => console.log("PROMISE-READDIR ERR " + String(error)),
);
const members = ["watch", "watchFile", "stat", "lstat", "readdir", "realpath", "existsSync", "readdirSync", "statSync", "realpathSync", "open", "close", "readlink", "access", "opendir"];
console.log("FS-MEMBERS " + JSON.stringify(Object.fromEntries(members.map((name) => [name, typeof fs[name]]))));
const readdirp = require("readdirp");
const stream = readdirp("/", { entryType: "all", depth: 1 });
console.log("DIRE NT-IN-FS " + ("Dirent" in fs) + " fsDirent=" + typeof fs.Dirent);
stream.on("data", (entry) => {
  const stats = entry.dirent || entry.stats;
  console.log("READDIRP " + entry.path + " kind=" + (stats ? (stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other") : "NO-STATS"));
});
stream.on("warn", (error) => console.log("READDIRP-WARN " + String(error).slice(0, 120)));
stream.on("end", () => console.log("READDIRP-END"));
stream.on("error", (error) => console.log("READDIRP-ERR " + String(error)));
const watcher = chokidar.watch("/", { ignoreInitial: true, usePolling: false });
watcher.on("ready", () => console.log("READY"));
watcher.on("add", (path) => console.log("ADD " + path));
watcher.on("change", (path) => console.log("CHANGE " + path));
watcher.on("error", (error) => console.log("WATCH-ERROR " + String(error)));
watcher.on("all", (event, path) => console.log("ALL " + event + " " + path));

const report = (label) => {
  try {
    console.log(label + " " + JSON.stringify(watcher.getWatched()));
  } catch (error) {
    console.log(label + " ERR " + String(error));
  }
};

setTimeout(() => {
  report("WATCHED@1500");
  try {
    fs.writeFileSync("/src/App.js", 'export const greeting = "hello-v2";\\\\n');
    console.log("WROTE /src/App.js");
    console.log("READBACK " + JSON.stringify(fs.readFileSync("/src/App.js", "utf8")));
  } catch (error) {
    console.log("WRITE-FAILED " + String(error));
  }
}, 1500);

setTimeout(() => report("WATCHED@4000"), 4000);
`;

const files = new MapFiles({
  "package.json": JSON.stringify(
    { name: "probe-chokidar", private: true, version: "0.0.0", dependencies: { chokidar: "^3.6.0" } },
    null,
    2,
  ),
  "src/App.js": 'export const greeting = "hello-v1";\n',
  "index.html": '<!doctype html><html><body><div id="root"></div></body></html>\n',
  "/watcher.js": watcherScript,
});

const runtime = new InProcessClient();
const container = new Container({ runtime, files, registry: createNetworkRegistry() });
const session = container.createSession("probe-chokidar");
const text = (): string => session.scrollback.map((line) => line.text).join("");

await container.execute(session.id, "npm install chokidar@^3.6.0");
console.log(`install output: ${text().split("\n").filter((line) => line.length > 0).slice(-2).join(" | ")}`);

await container.execute(session.id, "node /watcher.js");
const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(9000);

console.log("---- transcript ----");
console.log(text());
