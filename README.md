# wasi-kernel

A small [WASI preview1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md)
"kernel" with [wasi-threads](https://github.com/WebAssembly/wasi-threads), for running
`wasm32-wasip1-threads` programs in the browser and under Node. Plain ES modules, no
dependencies and no build step.

Every wasm thread runs in its own worker on its process's shared memory. System calls are
synchronous RPCs: a thread writes the call to a small `SharedArrayBuffer` channel, rings the
kernel's doorbell and blocks in `Atomics.wait`; the kernel (which never blocks) handles it and
posts the result. The kernel owns an in-memory filesystem (`MemFS`), the processes and their file
descriptors. See the comment at the top of `kernel.js` for details.

| File | |
| :--- | :--- |
| `kernel.js` | the kernel: system calls, processes, threads |
| `fs.js` | the in-memory filesystem (files may stay compressed until first opened) |
| `thread-worker.js` | runs one wasm thread; works as a browser worker and a Node worker thread |
| `node-host.js` | Node helpers: a `createWorker`, loading host directories and programs |
| `run.js` | command-line runner for Node |

Programs must import a shared `env.memory`, as `wasm32-wasip1-threads` programs do. Besides
WASI, the kernel provides `playground.spawn(argv, argc) -> i32`, which runs another program the
host registered (`new Kernel({ programs })`) to completion on the same filesystem, for programs
such as compilers that need to run a linker.

## Use

```js
import { Kernel } from "./wasi-kernel/kernel.js";

const kernel = new Kernel({
  createWorker: () => {
    const w = new Worker(new URL("./wasi-kernel/thread-worker.js", import.meta.url), { type: "module" });
    return { postMessage: (m) => w.postMessage(m), onMessage: (f) => (w.onmessage = (e) => f(e.data)), terminate: () => w.terminate() };
  },
});
kernel.fs.writeFile("/work/input.txt", "hello");
const bytes = new Uint8Array(await (await fetch("prog.wasm")).arrayBuffer());
const proc = kernel.spawn({ bytes, module: await WebAssembly.compile(bytes) }, {
  args: ["prog", "/work/input.txt"],
  stdout: (b) => console.log(new TextDecoder().decode(b)),
});
console.log("exit code", await proc.exited);
```

Pages need cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`. Module workers load
from the page's origin, so serve these files alongside the page.

From the command line:

```sh
node run.js [--dir host=guest]... [--program name=file.wasm]... [--env name=value]... \
    [--save guest=host]... prog.wasm [args...]
```

## Tests

`npm test` compiles the C programs in `test/` with [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)
(set `WASI_SDK` to its directory) and runs them under the kernel.

Originally part of `browser_rust_playground` (`web/kernel/`, as of its commit 399defd).
