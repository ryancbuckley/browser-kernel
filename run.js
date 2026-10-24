#!/usr/bin/env node
// Run a wasm32-wasip1-threads program under the kernel:
//   node run.js [--dir host=guest]... [--program name=file.wasm]...
//       [--save guest=host]... prog.wasm [args...]
// Output goes to the console. Files live in memory; --save copies a guest
// file out after the program exits.

import process from "node:process";
import { writeFileSync } from "node:fs";
import { Kernel } from "./kernel.js";
import { createNodeWorker, loadDir, loadProgram } from "./node-host.js";

const argv = process.argv.slice(2);
const kernel = new Kernel({
  createWorker: createNodeWorker,
  trace: process.env.KERNEL_TRACE ? (line) => process.stderr.write(line + "\n") : null,
});
const saves = [];
while (argv[0]?.startsWith("--")) {
  const [flag, value] = [argv.shift(), argv.shift()];
  const [a, b] = value.split("=");
  if (flag === "--dir") loadDir(kernel.fs, a, b);
  else if (flag === "--program") kernel.programs[a] = loadProgram(b);
  else if (flag === "--save") saves.push([a, b]);
}
const [file, ...args] = argv;
const proc = kernel.spawn(loadProgram(file), {
  args: [file, ...args],
  env: { RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "0" },
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
