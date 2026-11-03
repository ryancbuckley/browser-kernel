# browser-kernel

A small [WASI preview1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md) and
[wasi-threads](https://github.com/WebAssembly/wasi-threads) runtime for running
`wasm32-wasip1-threads` programs in browsers and Node.js. Written in plain ES modules with
JSDoc types checked by TypeScript (`npm run check`), with no runtime dependencies or build step.

## Architecture

Each WebAssembly thread runs in its own worker sharing the process's `WebAssembly.Memory`. When a
spawned thread exits, its worker and WebAssembly instance are kept in reserve to run the next thread
spawned by that process.

System calls are synchronous RPCs over shared memory:
1. The worker writes the syscall number and arguments to its per-thread `SharedArrayBuffer` channel,
   increments and notifies the kernel's doorbell, and blocks in `Atomics.wait`.
2. The kernel waits on the doorbell with `Atomics.waitAsync` (so the kernel thread never blocks),
   reads and writes syscall buffers directly in the process's shared memory, and wakes the worker
   when the call completes.

The kernel owns an in-memory filesystem (`MemFS`) and each process's file descriptors. Besides
WASI preview1 and `wasi-threads`, it provides `playground.spawn(argv, argc) -> i32`, which runs
another registered program (`new Kernel({ programs })`) to completion against the same filesystem
(useful when a compiler needs to invoke a linker).

| File | Description |
| :--- | :--- |
| `kernel.js` | Kernel implementation: processes, threads, and WASI syscalls |
| `fs.js` | In-memory filesystem (`MemFS`). Supports lazy files (`File.lazy(load, size)`) loaded on first open, and evictable files (`{ evictable: true }`) whose contents are dropped when all descriptors close |
| `thread-worker.js` | Worker entry point that runs a single Wasm thread in a Web Worker or Node `worker_threads` worker |
| `browser-host.js` | `createBrowserWorker`, which wraps Web Workers and forwards worker load or crash errors so processes fail cleanly instead of hanging |
| `node-host.js` | Node.js helpers: `createNodeWorker`, `loadDir`, and `loadProgram` |
| `run.js` | Command-line runner for Node.js |

## Usage

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

- **Standard input**: Pass a `Uint8Array` as `stdin` (defaults to empty), or pass `stdin: "pipe"`
  to stream input while the process runs using `proc.writeStdin(bytes)` and `proc.closeStdin()`.
  Reads on a piped `stdin` block until data is available or `closeStdin()` is called.
- **Progress tracking**: `kernel.syscalls` counts the total number of system calls dispatched across
  all processes.
- **Browser headers**: Pages must be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`
  and `Cross-Origin-Embedder-Policy: require-corp`) to use `SharedArrayBuffer`.
  The kernel starts its threads as module workers, which load from the page's origin, so serve
  these files from the same origin as the page.

### Command-line runner

```sh
node run.js [--dir host=guest]... [--program name=file.wasm]... [--env name=value]... \
    [--save guest=host]... prog.wasm [args...]
```

## Testing

Run `npm install` first to install TypeScript and Node type definitions.

- `npm run check`: Type-check all JS files with `tsc`.
- `npm run test:unit`: Run syscall unit tests (`test/syscalls.test.mjs`) directly against a `Process`
  and `MemFS` without requiring `wasi-sdk` or worker threads.
- `npm test`: Run type checking, unit tests, and integration tests (`test/run.mjs`). The integration
  tests compile the C programs in `test/` using [wasi-sdk](https://github.com/WebAssembly/wasi-sdk)
  (set `WASI_SDK` to its installation path) and exercise threads, piped stdin, lazy files, and
  worker cleanup across normal exits, traps, and kills.

Originally extracted from `browser_rust_playground` (`web/kernel/`, commit `399defd`).

## License

Apache-2.0. See `LICENSE`.
