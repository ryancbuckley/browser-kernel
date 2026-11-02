// Running the kernel in a browser page or worker.

/** @import { ThreadWorker } from "./kernel.js" */

/** A `createWorker` for the kernel that uses browser workers. A worker that fails to load, or
 *  that the browser ends (iOS ends those that use too much memory), says so only through its
 *  `error` event, which this passes on to the kernel as `{ type: "failed" }`: without it, the
 *  process would wait for the thread forever.
 *  @returns {ThreadWorker} */
export function createBrowserWorker() {
  const w = new Worker(new URL("./thread-worker.js", import.meta.url), { type: "module" });
  return {
    postMessage: (m) => w.postMessage(m),
    onMessage: (f) => {
      w.onmessage = (e) => f(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        f({ type: "failed", message: e.message || "the browser gave no reason" });
      };
      w.onmessageerror = () => f({ type: "failed", message: "a message to it could not be read" });
    },
    terminate: () => w.terminate(),
  };
}
