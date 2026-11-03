// Browser worker adapter for the kernel.

/** @import { FromThread, ThreadWorker } from "./kernel.js" */

/** Create a `ThreadWorker` backed by a Web Worker.
 *  If a worker fails to load or is killed by the browser (for example due to memory
 *  pressure on iOS), the failure is only reported via the `error` event. Forwarding
 *  that as `{ type: "failed" }` lets the kernel terminate the process instead of
 *  waiting forever for the thread.
 *  @returns {ThreadWorker} */
export function createBrowserWorker() {
  const w = new Worker(new URL("./thread-worker.js", import.meta.url), { type: "module" });
  /** @type {((m: FromThread) => void) | null} */
  let handler = null;
  /** @type {FromThread | null} */
  let failed = null;
  const fail = (/** @type {string} */ message) => {
    failed = { type: "failed", message };
    handler?.(failed);
  };
  w.onerror = (e) => {
    e.preventDefault();
    fail(e.message || "worker error");
  };
  w.onmessageerror = () => fail("worker message deserialization failed");
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (f) => {
      handler = f;
      w.onmessage = (e) => f(e.data);
      if (failed) f(failed);
    },
    terminate: () => w.terminate(),
  };
}
