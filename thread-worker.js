// Worker entry point that executes a single WebAssembly thread for kernel.js.
// Runs in both browser Web Workers and Node worker_threads.
//
// Protocol from kernel to worker:
//   { type: "prepare", module, memory, channel, doorbell, syscalls }
//       Instantiate `module` with the process's shared memory, this thread's
//       syscall channel, and the kernel's doorbell. Doing this ahead of time
//       hides instantiation latency when a thread is later spawned.
//   { type: "start", tid, startArg }
//       Run the thread. If `startArg` is null, this is the main thread and
//       calls `_start`; otherwise it calls `wasi_thread_start(tid, startArg)`.
//       When a spawned thread exits, the kernel can reuse this worker and
//       WebAssembly instance for another thread in the same process.
//   { type: "close" }
//       Reply with `{ type: "closing" }` and exit the worker. If the worker is
//       busy executing Wasm or blocked on a futex, the kernel will terminate it
//       after `retireTimeout`.

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
  if (!parentPort) throw new Error("thread-worker.js must run in a worker thread");
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
/** Error message if WebAssembly instantiation failed during `prepare`. */
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

  /** Perform synchronous syscall `nr` over the shared channel. Throws if the
   *  process has been killed so execution unwinds back to the worker event loop.
   *  @param {number} nr @param {(number | bigint)[]} a */
  const call = (nr, a) => {
    a.forEach((x, i) => (args[i] = typeof x === "bigint" ? x : BigInt(x)));
    ctl[1] = nr;
    // If the channel state is KILLED, the process has exited. Throw to unwind
    // out of Wasm back to the event loop so the worker can process `{ type: "close" }`
    // and shut down cleanly without waiting for `retireTimeout`.
    if (Atomics.compareExchange(ctl, 0, IDLE, REQUEST) !== IDLE) throw new Error("killed");
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    // Pass the loaded value `s` to Atomics.wait; re-reading ctl[0] could observe
    // DONE after the kernel notified and sleep forever.
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
    prepareError = e instanceof Error ? e.message : String(e);
  }
}

/** @typedef {(...args: number[]) => unknown} WasmFunction */

/** JSPI's `WebAssembly.promising`, if supported by the JS engine. */
const promising = /** @type {{ promising?: (f: WasmFunction) => WasmFunction }} */ (WebAssembly).promising;

/** Invoke Wasm export `f`. When JSPI (`WebAssembly.promising`) is available, wrap `f`
 *  so it runs on a dedicated JSPI stack (~1 MB in V8) rather than the browser worker's
 *  smaller call stack (~360 KB in Chrome on macOS). Syscalls still block synchronously
 *  via `Atomics.wait` and never suspend the JSPI stack.
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
