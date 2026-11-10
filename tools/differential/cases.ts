/**
 * Event-loop ordering cases, each small enough to read in one screen.
 *
 * The audit's third correction is the reason this file exists: a green suite proves the scheduler produces *an* order, not
 * Node's order. Every case here is written once and run twice — in real Node and in this runtime — so a difference is a
 * measurement rather than an argument.
 *
 * Each case must be deterministic and must not touch the filesystem, so the only variable left is scheduling.
 */

export interface DifferentialCase {
  readonly id: string;
  /** What ordering question this case decides, in words. */
  readonly question: string;
  readonly source: string;
}

export const CASES: readonly DifferentialCase[] = [
  {
    id: "nexttick-before-promise",
    question: "does process.nextTick run before a resolved promise's .then?",
    source: [
      "const out = [];",
      "Promise.resolve().then(() => out.push('promise'));",
      "process.nextTick(() => out.push('nextTick'));",
      "setTimeout(() => console.log(out.join(',')), 5);",
    ].join("\n"),
  },
  {
    id: "nexttick-nested",
    question: "is a nextTick queued inside a nextTick drained before microtasks?",
    source: [
      "const out = [];",
      "Promise.resolve().then(() => out.push('promise1'));",
      "process.nextTick(() => {",
      "  out.push('tick1');",
      "  process.nextTick(() => out.push('tick-nested'));",
      "});",
      "Promise.resolve().then(() => out.push('promise2'));",
      "setTimeout(() => console.log(out.join(',')), 5);",
    ].join("\n"),
  },
  {
    id: "immediate-vs-timeout0",
    question: "does setImmediate run after I/O but before a 0 ms timer inside a timer callback?",
    source: [
      "const out = [];",
      "setTimeout(() => {",
      "  out.push('outer-timer');",
      "  setImmediate(() => out.push('immediate'));",
      "  setTimeout(() => out.push('inner-timer0'), 0);",
      "  process.nextTick(() => out.push('tick'));",
      "}, 0);",
      "setTimeout(() => console.log(out.join(',')), 10);",
    ].join("\n"),
  },
  {
    id: "timer-order-by-delay",
    question: "do timers fire in delay order regardless of registration order?",
    source: [
      "const out = [];",
      "setTimeout(() => out.push('t30'), 30);",
      "setTimeout(() => out.push('t10'), 10);",
      "setTimeout(() => out.push('t20'), 20);",
      "setTimeout(() => console.log(out.join(',')), 40);",
    ].join("\n"),
  },
  {
    id: "microtask-starvation",
    question: "does a promise chain complete before a timer registered before it?",
    source: [
      "const out = [];",
      "setTimeout(() => out.push('timer'), 0);",
      "Promise.resolve().then(() => { out.push('m1'); return Promise.resolve(); }).then(() => out.push('m2'));",
      "setTimeout(() => console.log(out.join(',')), 10);",
    ].join("\n"),
  },
  {
    id: "interval-ticks",
    question: "how many interval ticks elapse in 30 ms at a 10 ms interval?",
    source: [
      "let ticks = 0;",
      "const handle = setInterval(() => { ticks += 1; }, 10);",
      "setTimeout(() => { clearInterval(handle); console.log('ticks=' + ticks); }, 30);",
    ].join("\n"),
  },
  {
    id: "async-await-order",
    question: "does await resume in microtask order relative to nextTick?",
    source: [
      "const out = [];",
      "async function main() {",
      "  out.push('sync-start');",
      "  await null;",
      "  out.push('after-await');",
      "}",
      "main();",
      "process.nextTick(() => out.push('tick'));",
      "Promise.resolve().then(() => out.push('then'));",
      "setTimeout(() => console.log(out.join(',')), 5);",
    ].join("\n"),
  },
  // ref/unref (ADR-0013 amendment 3). Every case here asks the same question in a different shape: does an unref'd timer
  // keep the loop alive? Node's answer is no, and until now this runtime's stubs made it yes.
  {
    id: "unref-alone-never-fires",
    question: "does an unref'd timer fire when nothing else keeps the loop alive?",
    source: ["const timer = setTimeout(() => console.log('late'), 50);", "timer.unref();", "console.log('sync');"].join("\n"),
  },
  {
    id: "unref-before-ref",
    question: "does an unref'd timer still fire when a ref'd timer keeps the loop alive past its due time?",
    source: [
      "const order = [];",
      "const early = setTimeout(() => order.push('unref'), 10);",
      "early.unref();",
      "setTimeout(() => console.log(order.join(',')), 20);",
    ].join("\n"),
  },
  {
    id: "hasref-toggles",
    question: "does hasRef() follow ref() and unref()?",
    source: [
      "const timer = setTimeout(() => {}, 10);",
      "const before = timer.hasRef();",
      "timer.unref();",
      "const after = timer.hasRef();",
      "timer.ref();",
      "const again = timer.hasRef();",
      "clearTimeout(timer);",
      "console.log(before, after, again);",
    ].join("\n"),
  },
  {
    id: "unref-interval-never-ticks",
    question: "does an unref'd interval tick when nothing else is pending?",
    source: ["const interval = setInterval(() => console.log('tick'), 5);", "interval.unref();", "console.log('sync');"].join("\n"),
  },
  {
    id: "clear-unref-is-quiet",
    question: "is clearing an unref'd timer a silent no-op?",
    source: [
      "const timer = setTimeout(() => console.log('should not print'), 10);",
      "timer.unref();",
      "clearTimeout(timer);",
      "console.log('cleared');",
    ].join("\n"),
  },
  {
    id: "unref-immediate",
    question: "does an unref'd setImmediate run when nothing else is pending?",
    source: ["const immediate = setImmediate(() => console.log('immediate'));", "immediate.unref();", "console.log('sync');"].join("\n"),
  },
  {
    id: "promise-resolved-in-timer",
    question: "is a promise settled inside a timer callback observed, including a further timer it schedules?",
    source: [
      "const out = [];",
      "const work = new Promise((resolve) => {",
      "  setTimeout(() => resolve('value'), 0);",
      "});",
      "work.then((value) => {",
      "  out.push(value);",
      "  setTimeout(() => out.push('after'), 0);",
      "});",
      "setTimeout(() => console.log(out.join(',')), 20);",
    ].join("\n"),
  },
  {
    id: "chained-then-from-timer",
    question: "does a .then that returns another .then keep running when it starts inside a timer?",
    source: [
      "const out = [];",
      "setTimeout(() => {",
      "  Promise.resolve()",
      "    .then(() => { out.push('one'); return Promise.resolve(); })",
      "    .then(() => { out.push('two'); return Promise.resolve(); })",
      "    .then(() => out.push('three'));",
      "}, 0);",
      "setTimeout(() => console.log(out.join(',')), 20);",
    ].join("\n"),
  },
  {
    id: "async-function-resolving-after-timer",
    question: "does an async function that awaits a timer keep its caller's continuation alive?",
    source: [
      "const out = [];",
      "const delay = () => new Promise((resolve) => setTimeout(resolve, 1));",
      "async function run() {",
      "  out.push('start');",
      "  await delay();",
      "  out.push('resumed');",
      "  await delay();",
      "  out.push('resumed-again');",
      "  return 'done';",
      "}",
      "run().then((value) => out.push(value));",
      "setTimeout(() => console.log(out.join(',')), 20);",
    ].join("\n"),
  },
];
