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

const IDLE = 0, REQUEST = 1, DONE = 2;
const MAX_ARGS = 12;

let post, onMessage;
if (typeof process !== "undefined" && process.versions?.node) {
  const { parentPort } = await import("node:worker_threads");
  post = (m) => parentPort.postMessage(m);
  onMessage = (f) => parentPort.on("message", f);
} else {
  post = (m) => self.postMessage(m);
  onMessage = (f) => { self.onmessage = (e) => f(e.data); };
}

let instance = null;
let prepareError = null;

onMessage((m) => {
  if (m.type === "prepare") prepare(m);
  else if (m.type === "start") start(m);
});

function prepare({ module, memory, channel, doorbell, syscalls }) {
  const ctl = new Int32Array(channel, 0, 4);
  const args = new BigInt64Array(channel, 16, MAX_ARGS);
  const bell = new Int32Array(doorbell);

  const call = (nr, a) => {
    for (let i = 0; i < a.length; i++) args[i] = typeof a[i] === "bigint" ? a[i] : BigInt(a[i]);
    ctl[1] = nr;
    Atomics.store(ctl, 0, REQUEST);
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    // Wait with the state just seen: reading it again for Atomics.wait could
    // see DONE, and then wait for DONE to change, forever.
    for (let s; (s = Atomics.load(ctl, 0)) !== DONE;) Atomics.wait(ctl, 0, s);
    const r = ctl[2];
    Atomics.store(ctl, 0, IDLE);
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

function start({ tid, startArg }) {
  if (prepareError) {
    post({ type: "trap", message: `instantiation failed: ${prepareError.message}` });
    return;
  }
  try {
    if (startArg === null) {
      instance.exports._start();
      post({ type: "exit" });
    } else {
      instance.exports.wasi_thread_start(tid, startArg);
      post({ type: "thread-exit" });
    }
  } catch (e) {
    post({ type: "trap", message: e.message, stack: e.stack });
  }
}
