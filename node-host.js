// Running the kernel under Node, for tests and command-line use.

import { Worker } from "node:worker_threads";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** @import { MemFS } from "./fs.js" */
/** @import { Program, ThreadWorker } from "./kernel.js" */

/** A `createWorker` for the kernel that uses Node worker threads (running `script`, for tests).
 *  @returns {ThreadWorker} */
export function createNodeWorker(script = new URL("./thread-worker.js", import.meta.url)) {
  const w = new Worker(script);
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (f) => {
      w.on("message", f);
      w.on("error", (e) => f({ type: "failed", message: e instanceof Error ? e.message : String(e) }));
    },
    terminate: () => w.terminate(),
  };
}

/** Copy host directory `src` into the kernel filesystem at `dst`.
 *  @param {MemFS} fs @param {string} src @param {string} dst */
export function loadDir(fs, src, dst) {
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = `${dst}/${name}`;
    if (statSync(s).isDirectory()) loadDir(fs, s, d);
    else fs.writeFile(d, new Uint8Array(readFileSync(s)));
  }
}

/** @param {string} path @returns {Program} */
export function loadProgram(path) {
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, module: new WebAssembly.Module(bytes) };
}
