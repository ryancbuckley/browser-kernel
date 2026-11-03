// Running the kernel in a browser page or worker.

/** @import { FromThread, ThreadWorker } from "./kernel.js" */

/** A `createWorker` for the kernel that uses browser workers. A worker that fails to load, or
 *  that the browser ends (iOS ends those that use too much memory), says so only through its
 *  `error` event, which this passes on to the kernel as `{ type: "failed" }`: without it, the
 *  process would wait for the thread forever.
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
