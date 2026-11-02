# browser-kernel

A small [WASI preview1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md)
"kernel" with [wasi-threads](https://github.com/WebAssembly/wasi-threads), for running
`wasm32-wasip1-threads` programs in the browser and under Node. Plain ES modules, no
dependencies and no build step: the types are in JSDoc comments, which TypeScript checks
(`npm run check`).

Every wasm thread runs in its own worker on its process's shared memory (an exited thread's worker
and instance run the process's next thread). System calls are
synchronous RPCs: a thread writes the call to a small `SharedArrayBuffer` channel, rings the
kernel's doorbell and blocks in `Atomics.wait`; the kernel (which never blocks) handles it and
posts the result. The kernel owns an in-memory filesystem (`MemFS`), the processes and their file
descriptors. See the comment at the top of `kernel.js` for details.

| File | |
| :--- | :--- |
| `kernel.js` | the kernel: system calls, processes, threads |
| `fs.js` | the in-memory filesystem; files may be lazy (`File.lazy(load, size)`): loaded, e.g. fetched or decompressed, when a program first opens them; and evictable (`{ evictable: true }`): dropped again when no descriptor has them open, for large read-only files a program copies into its own memory |
| `thread-worker.js` | runs one wasm thread; works as a browser worker and a Node worker thread |
| `browser-host.js` | `createBrowserWorker`, the `createWorker` for browsers, which reports a worker that fails (to load, or ended by the browser) so the process ends instead of waiting for it |
| `node-host.js` | Node helpers: a `createWorker`, loading host directories and programs |
| `run.js` | command-line runner for Node |

Programs must import a shared `env.memory`, as `wasm32-wasip1-threads` programs do. Besides
WASI, the kernel provides `playground.spawn(argv, argc) -> i32`, which runs another program the
host registered (`new Kernel({ programs })`) to completion on the same filesystem, for programs
such as compilers that need to run a linker.

## Use

```js
import { Kernel } from "./browser-kernel/kernel.js";
import { createBrowserWorker } from "./browser-kernel/browser-host.js";

const kernel = new Kernel({ createWorker: createBrowserWorker });
kernel.fs.writeFile("/work/input.txt", "hello");
const bytes = new Uint8Array(await (await fetch("prog.wasm")).arrayBuffer());
const proc = kernel.spawn({ bytes, module: await WebAssembly.compile(bytes) }, {
  args: ["prog", "/work/input.txt"],
  stdout: (b) => console.log(new TextDecoder().decode(b)),
});
console.log("exit code", await proc.exited);
```

A process's stdin is the bytes given as `stdin` (empty by default), or, with `stdin: "pipe"`, the
input the host gives it while it runs with `proc.writeStdin(bytes)`, until `proc.closeStdin()`:
reading it then waits for input, so a program can serve requests.

`kernel.syscalls` counts the system calls made so far, by every process: a sign that a long-running
program is making progress.

Pages need cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`) for `SharedArrayBuffer`. Module workers load
from the page's origin, so serve these files alongside the page.

From the command line:

```sh
node run.js [--dir host=guest]... [--program name=file.wasm]... [--env name=value]... \
    [--save guest=host]... prog.wasm [args...]
```

## Tests

`npm run check` type-checks the JavaScript (`tsconfig.json`: TypeScript's `checkJs`, strict, nothing
emitted); run `npm install` first, for TypeScript. `npm run test:unit` calls the system calls directly on a process with a plain memory
(`test/syscalls.test.mjs`: files, directories, paths, descriptors, lazy files, stdin, clocks), with
nothing to build. `npm test` runs the check and those, then compiles the C programs in `test/` with
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (set `WASI_SDK` to its directory) and runs them
under the kernel: system calls from real programs, threads, and processes with threads ending in
each way they can (`test/exit.c`), checking that every worker ends after.

Originally part of `browser_rust_playground` (`web/kernel/`, as of its commit 399defd).

## License

Apache-2.0. See `LICENSE`.
