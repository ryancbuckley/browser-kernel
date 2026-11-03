// Node.js helpers for running the kernel in tests and from the CLI.

import { Worker } from "node:worker_threads";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @import { MemFS } from "./fs.js" */
/** @import { FromThread, Program, ThreadWorker } from "./kernel.js" */

/** Create a `ThreadWorker` backed by a Node worker thread.
 *  @returns {ThreadWorker} */
export function createNodeWorker(script = new URL("./thread-worker.js", import.meta.url)) {
  const w = new Worker(script);
  /** @type {((m: FromThread) => void) | null} */
  let handler = null;
  /** @type {FromThread | null} */
  let failed = null;
  w.on("error", (e) => {
    failed = { type: "failed", message: e instanceof Error ? e.message : String(e) };
    handler?.(failed);
  });
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (f) => {
      handler = f;
      w.on("message", f);
      if (failed) f(failed);
    },
    terminate: () => w.terminate(),
  };
}

/** Recursively copy host directory `src` into the kernel filesystem at `dst`.
 *  @param {MemFS} fs @param {string} src @param {string} dst */
export function loadDir(fs, src, dst) {
  fs.mkdirp(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = `${dst}/${name}`;
    if (statSync(s).isDirectory()) loadDir(fs, s, d);
    else fs.writeFile(d, new Uint8Array(readFileSync(s)));
  }
}

/** Read and compile a WebAssembly module from `path`.
 *  @param {string} path @returns {Program} */
export function loadProgram(path) {
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, module: new WebAssembly.Module(bytes) };
}
