// Compile the test programs with wasi-sdk and run them under the kernel (through run.js),
// checking their output and exit codes.
//
//   WASI_SDK=/path/to/wasi-sdk node test/run.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const here = new URL(".", import.meta.url).pathname;
const sdk = process.env.WASI_SDK;
if (!sdk) {
  console.error("set WASI_SDK to a wasi-sdk directory");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "browser-kernel-test-"));

const tests = [
  { name: "basic", args: ["one", "two words"], code: 7 },
  { name: "pipe" },
  { name: "churn" },
  { name: "exit" },
];

let failures = 0;
for (const t of tests) {
  const wasm = join(work, `${t.name}.wasm`);
  execFileSync(join(sdk, "bin", "clang"), [
    "--target=wasm32-wasip1-threads", `--sysroot=${join(sdk, "share", "wasi-sysroot")}`, "-pthread", "-O2",
    join(here, `${t.name}.c`), "-o", wasm,
    "-Wl,--import-memory,--export-memory,--max-memory=67108864",
  ]);
  if (t.code === undefined) continue; // run below, not through run.js
  const data = join(work, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "input.txt"), "from the host\n");
  const r = spawnSync("node", [join(here, "..", "run.js"), "--dir", `${data}=/data`,
    "--env", "GREETING=hi", wasm, ...t.args], { encoding: "utf8" });
  const want = readFileSync(join(here, `${t.name}.expected`), "utf8");
  const ok = r.stdout === want && r.status === t.code;
  if (!ok) {
    failures++;
    console.log(`FAIL ${t.name} (exit ${r.status}, want ${t.code})\n--- stdout:\n${r.stdout}--- stderr:\n${r.stderr}`);
  } else {
    console.log(`ok   ${t.name}`);
  }
}
// Lazy files: loaded when a program first opens them, and only then.
{
  const { Kernel } = await import("../kernel.js");
  const { File } = await import("../fs.js");
  const { createNodeWorker, loadProgram } = await import("../node-host.js");
  const kernel = new Kernel({ createWorker: createNodeWorker });
  const loads = { input: 0, unused: 0 };
  const input = new TextEncoder().encode("from the host\n");
  kernel.fs.mkdirp("/data").entries.set("input.txt", File.lazy(async () => {
    loads.input++;
    return input;
  }, input.length));
  kernel.fs.mkdirp("/data").entries.set("unused.txt", File.lazy(async () => {
    loads.unused++;
    return new Uint8Array(10);
  }, 10));
  let out = "";
  const proc = kernel.spawn(loadProgram(join(work, "basic.wasm")), {
    args: ["basic", "one", "two words"],
    env: { GREETING: "hi" },
    stdout: (b) => (out += new TextDecoder().decode(b)),
  });
  const code = await proc.exited;
  const want = readFileSync(join(here, "basic.expected"), "utf8");
  if (code !== 7 || out !== want || loads.input !== 1 || loads.unused !== 0) {
    failures++;
    console.log(`FAIL lazy files (exit ${code}, loads ${JSON.stringify(loads)})\n${out}`);
  } else {
    console.log("ok   lazy files");
  }
}
// Evictable lazy files: dropped when closed, loaded again when next opened.
{
  const { Kernel } = await import("../kernel.js");
  const { File } = await import("../fs.js");
  const { createNodeWorker, loadProgram } = await import("../node-host.js");
  const kernel = new Kernel({ createWorker: createNodeWorker });
  let loads = 0;
  const input = new TextEncoder().encode("from the host\n");
  const file = File.lazy(async () => {
    loads++;
    return input;
  }, input.length, { evictable: true });
  kernel.fs.mkdirp("/data").entries.set("input.txt", file);
  const want = readFileSync(join(here, "basic.expected"), "utf8");
  const results = [];
  for (let i = 0; i < 2; i++) {
    kernel.fs.remove("/tmp"); // the program's own files, from the run before
    let out = "";
    const proc = kernel.spawn(loadProgram(join(work, "basic.wasm")), {
      args: ["basic", "one", "two words"],
      env: { GREETING: "hi" },
      stdout: (b) => (out += new TextDecoder().decode(b)),
    });
    results.push([await proc.exited, out === want, file.pending, loads]);
  }
  if (JSON.stringify(results) !== JSON.stringify([[7, true, true, 1], [7, true, true, 2]])) {
    failures++;
    console.log(`FAIL evictable files: ${JSON.stringify(results)}`);
  } else {
    console.log("ok   evictable files");
  }
}
// Short-lived threads, one after another: an exited thread's instance runs the process's next
// thread, rather than each needing a new worker and instantiation.
{
  const { Kernel } = await import("../kernel.js");
  const { createNodeWorker, loadProgram } = await import("../node-host.js");
  let workers = 0;
  const kernel = new Kernel({ createWorker: () => (workers++, createNodeWorker()) });
  let out = "";
  const proc = kernel.spawn(loadProgram(join(work, "churn.wasm")), {
    args: ["churn"],
    stdout: (b) => (out += new TextDecoder().decode(b)),
  });
  const code = await proc.exited;
  if (code !== 0 || workers > 4) {
    failures++;
    console.log(`FAIL thread reuse (exit ${code}, ${workers} workers)\n${out}`);
  } else {
    console.log(`ok   thread reuse (${workers} workers for 200 threads)`);
  }
}
// A piped stdin: written while the program runs, which waits for it.
{
  const { Kernel } = await import("../kernel.js");
  const { createNodeWorker, loadProgram } = await import("../node-host.js");
  const kernel = new Kernel({ createWorker: createNodeWorker });
  let out = "";
  let gotLine;
  const proc = kernel.spawn(loadProgram(join(work, "pipe.wasm")), {
    args: ["pipe"],
    stdin: "pipe",
    stdout: (b) => {
      out += new TextDecoder().decode(b);
      gotLine?.();
    },
  });
  const line = () => new Promise((resolve) => (gotLine = resolve));
  const encode = (s) => new TextEncoder().encode(s);
  let reply = line();
  proc.writeStdin(encode("one\n"));
  await reply;
  const first = out;
  reply = line();
  proc.writeStdin(encode("tw"));
  await new Promise((r) => setTimeout(r, 50)); // half a line: no reply yet
  const waited = out === first;
  proc.writeStdin(encode("o\n"));
  await reply;
  proc.closeStdin();
  const code = await proc.exited;
  if (code !== 2 || first !== "got: one\n" || !waited || out !== "got: one\ngot: two\n") {
    failures++;
    console.log(`FAIL piped stdin (exit ${code}, waited ${waited})\n${out}`);
  } else {
    console.log("ok   piped stdin");
  }
}

// A process with threads ending: its exit code, and then every worker ends. A worker closes
// itself when asked (thread-worker.js) unless it is running wasm, a thread waiting on a futex
// included: then the kernel terminates it, which in Safari keeps the process's memory reserved, so
// only the cases with such a thread may need it.
{
  const { Kernel } = await import("../kernel.js");
  const { loadProgram } = await import("../node-host.js");
  const { Worker } = await import("node:worker_threads");
  const program = loadProgram(join(work, "exit.wasm"));
  const cases = [
    { mode: "thread-exit", code: [5], terminated: true }, // the main thread waits in pthread_join
    { mode: "thread-trap", code: [134], terminated: true, stderr: /the program trapped/ },
    { mode: "negative", code: [255], terminated: true },
    { mode: "race", code: [10, 11, 12, 13, 14, 15, 16, 17], terminated: true },
    { mode: "futex", code: [3], terminated: true },
    { mode: "stdin", code: [4], stdin: "pipe" },
    { mode: "sleep", code: [6] },
    { mode: "return", code: [0], terminated: true },
    { mode: "spin", code: [137], terminated: true, kill: true },
    { mode: "spare", code: [7] },
  ];
  for (const c of cases) {
    const workers = [];
    const kernel = new Kernel({
      retireTimeout: 200,
      createWorker: () => {
        const w = new Worker(new URL("../thread-worker.js", import.meta.url));
        const rec = { ended: false, terminated: false };
        w.on("exit", () => (rec.ended = true));
        workers.push(rec);
        return {
          postMessage: (m) => w.postMessage(m),
          onMessage: (f) => w.on("message", f),
          terminate: () => { rec.terminated = true; return w.terminate(); },
        };
      },
    });
    let out = "", err = "";
    const proc = kernel.spawn(program, {
      args: ["exit", c.mode], stdin: c.stdin,
      stdout: (b) => (out += new TextDecoder().decode(b)),
      stderr: (b) => (err += new TextDecoder().decode(b)),
    });
    if (c.kill) {
      while (!out) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 50));
      kernel.kill(proc);
    }
    const code = await proc.exited;
    const deadline = Date.now() + 3000;
    while (workers.some((w) => !w.ended) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const left = workers.filter((w) => !w.ended).length;
    const terminated = workers.filter((w) => w.terminated).length;
    const problems = [
      !c.code.includes(code) && `exit code ${code}, want ${c.code.join(" or ")}`,
      out !== `${c.mode}\n` && `stdout ${JSON.stringify(out)}`,
      c.stderr ? !c.stderr.test(err) && `stderr ${JSON.stringify(err)}` : err && `stderr ${JSON.stringify(err)}`,
      left && `${left} of ${workers.length} workers still running`,
      terminated && !c.terminated && `${terminated} workers terminated rather than closed`,
    ].filter(Boolean);
    if (problems.length) {
      failures++;
      console.log(`FAIL exit: ${c.mode}: ${problems.join("; ")}`);
    } else {
      console.log(`ok   exit: ${c.mode} (${workers.length} workers, ${terminated} terminated)`);
    }
  }
}

// A thread's worker failing: the process ends (rather than waiting for the thread forever), whether
// the worker fails to load or dies while kept for the process's next thread.
{
  const { Kernel } = await import("../kernel.js");
  const { createNodeWorker, loadProgram } = await import("../node-host.js");
  const broken = new URL("data:text/javascript,throw new Error('no such worker')");
  const cases = [
    // the second worker (the first thread's) does not load
    { name: "fails to load", program: "exit", args: ["thread-exit"], worker: (n) => createNodeWorker(n === 2 ? broken : undefined), stderr: /no such worker/ },
    // the second worker says it failed after running its first thread, while kept for the next;
    // it is in fact still running, and must still be ended (closed or terminated)
    {
      name: "dies while kept", program: "churn", args: [], stderr: /died/, mustEnd: 2,
      worker: (n, ended) => {
        const w = createNodeWorker();
        if (n !== 2) return w;
        return {
          ...w,
          onMessage: (f) => w.onMessage((m) => {
            if (m.type === "closing") ended.add(n);
            f(m);
            if (m.type === "thread-exit") f({ type: "failed", message: "died" });
          }),
          terminate: () => { ended.add(n); w.terminate(); },
        };
      },
    },
    // the pool's idle worker fails before any thread is prepared on it (so before the kernel
    // attaches its handlers), and the process's main thread then gets it
    { name: "fails while idle in the pool", program: "exit", args: ["thread-exit"], pool: 1, delay: 300, worker: (n) => createNodeWorker(n === 1 ? broken : undefined), stderr: /no such worker/ },
  ];
  for (const c of cases) {
    let n = 0;
    const ended = new Set();
    const kernel = new Kernel({ createWorker: () => c.worker(++n, ended), retireTimeout: 200, pool: c.pool ?? 0 });
    if (c.delay) await new Promise((r) => setTimeout(r, c.delay));
    let err = "";
    const proc = kernel.spawn(loadProgram(join(work, `${c.program}.wasm`)), {
      args: [c.program, ...c.args],
      stderr: (b) => (err += new TextDecoder().decode(b)),
    });
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("hung"), 5000))]);
    if (c.mustEnd) await new Promise((r) => setTimeout(r, 500));
    if (code !== 134 || !c.stderr.test(err)) {
      failures++;
      console.log(`FAIL worker ${c.name}: exit ${code}, stderr ${JSON.stringify(err)}`);
      if (code === "hung") kernel.kill(proc);
    } else if (c.mustEnd && !ended.has(c.mustEnd)) {
      failures++;
      console.log(`FAIL worker ${c.name}: the failed worker was neither closed nor terminated`);
    } else {
      console.log(`ok   worker ${c.name}`);
    }
  }
}

process.exit(failures ? 1 : 0);
