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
];

let failures = 0;
for (const t of tests) {
  const wasm = join(work, `${t.name}.wasm`);
  execFileSync(join(sdk, "bin", "clang"), [
    "--target=wasm32-wasip1-threads", `--sysroot=${join(sdk, "share", "wasi-sysroot")}`, "-pthread", "-O2",
    join(here, `${t.name}.c`), "-o", wasm,
    "-Wl,--import-memory,--export-memory,--max-memory=67108864",
  ]);
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
process.exit(failures ? 1 : 0);
