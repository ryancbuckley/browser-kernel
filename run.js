#!/usr/bin/env node
// Run a wasm32-wasip1-threads program under the kernel:
//   node run.js [--dir host=guest]... [--program name=file.wasm]...
//       [--env name=value]... [--save guest=host]... prog.wasm [args...]
//
// Files live in memory; --save writes a guest file to the host after exit.

import process from "node:process";
import { writeFileSync } from "node:fs";
import { Kernel } from "./kernel.js";
import { createNodeWorker, loadDir, loadProgram } from "./node-host.js";

const argv = process.argv.slice(2);
const kernel = new Kernel({
  createWorker: createNodeWorker,
  trace: process.env.KERNEL_TRACE ? (line) => process.stderr.write(line + "\n") : null,
});
/** @type {[string, string][]} */
const saves = [];
/** @type {Record<string, string>} */
const env = { RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "0" };
while (argv[0]?.startsWith("--")) {
  const flag = argv.shift();
  if (flag === "--") break;
  if (flag !== "--dir" && flag !== "--program" && flag !== "--save" && flag !== "--env") {
    process.stderr.write(`run.js: unknown option ${flag}\n`);
    process.exit(2);
  }
  const value = argv.shift();
  const eq = value?.indexOf("=") ?? -1;
  if (value === undefined || eq === -1) {
    process.stderr.write(`run.js: ${flag} expects name=value\n`);
    process.exit(2);
  }
  const a = value.slice(0, eq), b = value.slice(eq + 1);
  if (flag === "--dir") loadDir(kernel.fs, a, b);
  else if (flag === "--program") kernel.programs[a] = loadProgram(b);
  else if (flag === "--save") saves.push([a, b]);
  else if (flag === "--env") env[a] = b;
}
const [file, ...args] = argv;
if (!file) {
  process.stderr.write("usage: run.js [--dir host=guest]... [--program name=file.wasm]... [--env name=value]... [--save guest=host]... prog.wasm [args...]\n");
  process.exit(2);
}
const proc = kernel.spawn(loadProgram(file), {
  args: [file, ...args],
  env,
  stdout: (b) => process.stdout.write(b),
  stderr: (b) => process.stderr.write(b),
});
const code = await proc.exited;
for (const [guest, host] of saves) {
  const data = kernel.fs.readFile(guest);
  if (data) writeFileSync(host, data);
  else process.stderr.write(`run.js: ${guest} does not exist\n`);
}
if (process.env.KERNEL_TRACE || code !== 0) process.stderr.write(`run.js: exit code ${code}\n`);
process.exit(code);
