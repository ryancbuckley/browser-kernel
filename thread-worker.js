// Runs one wasm thread for the kernel (kernel.js). Works as a browser worker
// and as a Node worker thread.
//
// Two messages, so that the slow part can happen before the thread is needed:
//   { type: "prepare", module, memory, channel, doorbell, syscalls }
//       Instantiate the module on the process's shared memory, with this
//       thread's system call channel and the kernel's doorbell.
//   { type: "start", tid, startArg }
//       Run: with no `startArg` this is the main thread and runs `_start`;
//       otherwise it runs `wasi_thread_start`. After a thread exits, the
//       kernel may start another of the process's threads on the instance.
// And when the kernel is done with the thread:
//   { type: "close" }
//       Answer "closing" and close: the kernel terminates the worker only
//       if it has not, still running wasm or waiting on a futex.

/** @import { FromThread, ToThread } from "./kernel.js" */

const IDLE = 0, REQUEST = 1, DONE = 2, KILLED = 4;
const MAX_ARGS = 12;

/** @type {(m: FromThread) => void} */
let post;
/** @type {(f: (m: ToThread) => void) => void} */
let onMessage;
/** @type {() => void} */
let close;
if (typeof process !== "undefined" && process.versions?.node) {
  const { parentPort } = await import("node:worker_threads");
  if (!parentPort) throw new Error("thread-worker.js runs in a worker thread");
  post = (m) => parentPort.postMessage(m);
  onMessage = (f) => parentPort.on("message", f);
  close = () => process.exit(0);
} else {
  post = (m) => self.postMessage(m);
  onMessage = (f) => { self.onmessage = (e) => f(e.data); };
  close = () => self.close();
}

/** @type {WebAssembly.Instance | null} */
let instance = null;
/** Why instantiating failed, if it did. */
let prepareError = "";

onMessage((m) => {
  if (m.type === "prepare") prepare(m);
  else if (m.type === "start") start(m);
  else if (m.type === "close") {
    post({ type: "closing" });
    close();
  }
});

/** @param {Extract<ToThread, { type: "prepare" }>} m */
function prepare({ module, memory, channel, doorbell, syscalls }) {
  const ctl = new Int32Array(channel, 0, 4);
  const args = new BigInt64Array(channel, 16, MAX_ARGS);
  const bell = new Int32Array(doorbell);

  /** Make system call `nr`: its result, or a throw if the process has ended.
   *  @param {number} nr @param {(number | bigint)[]} a */
  const call = (nr, a) => {
    a.forEach((x, i) => (args[i] = typeof x === "bigint" ? x : BigInt(x)));
    ctl[1] = nr;
    // KILLED: the process has ended. Leave the wait by throwing, out of the
    // wasm too, back to the event loop, where the kernel's "close" is
    // waiting: the worker closes at once, instead of being terminated after
    // `retireTimeout` (or, without one, never).
    if (Atomics.compareExchange(ctl, 0, IDLE, REQUEST) !== IDLE) throw new Error("killed");
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    // Wait with the state just seen: reading it again for Atomics.wait could
    // see DONE, and then wait for DONE to change, forever.
    for (let s; (s = Atomics.load(ctl, 0)) !== DONE;) {
      if (s === KILLED) throw new Error("killed");
      Atomics.wait(ctl, 0, s);
    }
    const r = ctl[2];
    if (Atomics.compareExchange(ctl, 0, DONE, IDLE) !== DONE) throw new Error("killed");
    return r;
  };

  /** @type {Record<string, (...a: (number | bigint)[]) => number>} */
  const wasi = {};
  syscalls.forEach((name, nr) => {
    wasi[name] = (...a) => call(nr, a);
  });
  const imports = {
    env: { memory },
    wasi_snapshot_preview1: wasi,
    wasi: { "thread-spawn": wasi.thread_spawn },
    playground: { spawn: wasi.playground_spawn },
  };

  try {
    instance = new WebAssembly.Instance(module, imports);
  } catch (e) {
    // Reported when the thread is started.
    prepareError = e instanceof Error ? e.message : String(e);
  }
}

/** @typedef {(...args: number[]) => unknown} WasmFunction */

/** JSPI's `WebAssembly.promising`, where the engine has it (TypeScript's types do not, yet). */
const promising = /** @type {{ promising?: (f: WasmFunction) => WasmFunction }} */ (WebAssembly).promising;

/** Call wasm export `f`, through JSPI where the engine has it: then it runs on a stack the engine
 *  allocates (about 1 MB in V8) instead of the worker thread's, which browsers keep small (about
 *  360 KB in Chrome on macOS). Nothing suspends, since the system calls are synchronous.
 *  @param {WasmFunction} f @param {number[]} args */
async function call(f, ...args) {
  return promising ? promising(f)(...args) : f(...args);
}

/** @param {Extract<ToThread, { type: "start" }>} m */
async function start({ tid, startArg }) {
  if (!instance) {
    post({ type: "trap", message: `instantiation failed: ${prepareError}` });
    return;
  }
  const exports = /** @type {Record<string, WasmFunction>} */ (instance.exports);
  try {
    if (startArg === null) {
      await call(exports._start);
      post({ type: "exit" });
    } else {
      await call(exports.wasi_thread_start, tid, startArg);
      post({ type: "thread-exit" });
    }
  } catch (e) {
    post(e instanceof Error ? { type: "trap", message: e.message, stack: e.stack } : { type: "trap", message: String(e) });
  }
}
