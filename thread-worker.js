// Runs one wasm thread for the kernel (kernel.js). Works as a browser worker
// and as a Node worker thread.
//
// Two messages, so that the slow part can happen before the thread is needed:
//   { type: "prepare", module, memory, channel, doorbell, syscalls }
//       Instantiate the module on the process's shared memory, with this
//       thread's system call channel and the kernel's doorbell.
//   { type: "start", tid, startArg }
//       Run: with no `startArg` this is the main thread and runs `_start`;
//       otherwise it runs `wasi_thread_start`.
// And when the kernel is done with the thread:
//   { type: "close" }
//       Answer "closing" and close: the kernel terminates the worker only
//       if it has not, still running wasm.

const IDLE = 0, REQUEST = 1, DONE = 2, KILLED = 4;
const MAX_ARGS = 12;

let post, onMessage, close;
if (typeof process !== "undefined" && process.versions?.node) {
  const { parentPort } = await import("node:worker_threads");
  post = (m) => parentPort.postMessage(m);
  onMessage = (f) => parentPort.on("message", f);
  close = () => process.exit(0);
} else {
  post = (m) => self.postMessage(m);
  onMessage = (f) => { self.onmessage = (e) => f(e.data); };
  close = () => self.close();
}

let instance = null;
let prepareError = null;

onMessage((m) => {
  if (m.type === "prepare") prepare(m);
  else if (m.type === "start") start(m);
  else if (m.type === "close") {
    post({ type: "closing" });
    close();
  }
});

function prepare({ module, memory, channel, doorbell, syscalls }) {
  const ctl = new Int32Array(channel, 0, 4);
  const args = new BigInt64Array(channel, 16, MAX_ARGS);
  const bell = new Int32Array(doorbell);

  const call = (nr, a) => {
    for (let i = 0; i < a.length; i++) args[i] = typeof a[i] === "bigint" ? a[i] : BigInt(a[i]);
    ctl[1] = nr;
    // KILLED: the process has ended. Leave the wait by throwing, out of the
    // wasm too, back to the event loop, where the kernel's "close" is
    // waiting: Safari cannot terminate a worker blocked in Atomics.wait,
    // which then keeps the process's memory reserved for as long as the
    // page's process lives.
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
    prepareError = e;
  }
}

/** Call wasm export `f`, through JSPI where the engine has it: then it runs on a stack the engine
 *  allocates (about 1 MB in V8) instead of the worker thread's, which browsers keep small (about
 *  360 KB in Chrome on macOS). Nothing suspends, since the system calls are synchronous. */
async function call(f, ...args) {
  return WebAssembly.promising ? WebAssembly.promising(f)(...args) : f(...args);
}

async function start({ tid, startArg }) {
  if (prepareError) {
    post({ type: "trap", message: `instantiation failed: ${prepareError.message}` });
    return;
  }
  try {
    if (startArg === null) {
      await call(instance.exports._start);
      post({ type: "exit" });
    } else {
      await call(instance.exports.wasi_thread_start, tid, startArg);
      post({ type: "thread-exit" });
    }
  } catch (e) {
    post({ type: "trap", message: e.message, stack: e.stack });
  }
}
