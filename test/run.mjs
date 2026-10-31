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
const work = mkdtempSync(join(tmpdir(), "wasi-kernel-test-"));

const tests = [
  { name: "basic", args: ["one", "two words"], code: 7 },
  { name: "pipe" },
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

process.exit(failures ? 1 : 0);
