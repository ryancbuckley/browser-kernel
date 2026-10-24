// A small WASI preview1 "kernel" for wasm32-wasip1-threads programs.
//
// Every wasm thread runs in its own worker on its process's shared memory.
// System calls are synchronous RPCs to the kernel: the thread writes the call
// number and arguments to its channel (a small SharedArrayBuffer), rings the
// kernel's doorbell and blocks in `Atomics.wait` until the kernel posts the
// result. Because the memory is shared, the kernel reads and writes the
// thread's buffers directly. The kernel itself never blocks (it waits with
// `Atomics.waitAsync`), so calls that take time, such as sleeping or running
// a child process, complete later without holding up other threads.
//
// The kernel owns the filesystem (an in-memory `MemFS`), the processes and
// their file descriptors, and passes standard output to callbacks.
//
// Programs must import their memory (`env.memory`, shared), as
// wasm32-wasip1-threads programs do; the kernel creates it.

import { Dir, File, MemFS, join } from "./fs.js";

export const E = {
  SUCCESS: 0, ACCES: 2, AGAIN: 6, BADF: 8, CHILD: 12, EXIST: 20, FAULT: 21,
  INVAL: 28, IO: 29, ISDIR: 31, NAMETOOLONG: 37, NOENT: 44, NOSYS: 52,
  NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, SPIPE: 70,
};
const FILETYPE = { UNKNOWN: 0, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS_APPEND = 1;
const ALL_RIGHTS = 0x1fffffffn;

/** System calls, by number. `thread-spawn` and `playground.spawn` come last. */
export const SYSCALLS = [
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get",
  "clock_res_get", "clock_time_get", "fd_advise", "fd_allocate", "fd_close",
  "fd_datasync", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_fdstat_set_rights",
  "fd_filestat_get", "fd_filestat_set_size", "fd_filestat_set_times", "fd_pread",
  "fd_prestat_get", "fd_prestat_dir_name", "fd_pwrite", "fd_read", "fd_readdir",
  "fd_renumber", "fd_seek", "fd_sync", "fd_tell", "fd_write",
  "path_create_directory", "path_filestat_get", "path_filestat_set_times",
  "path_link", "path_open", "path_readlink", "path_remove_directory",
  "path_rename", "path_symlink", "path_unlink_file", "poll_oneoff", "proc_exit",
  "proc_raise", "random_get", "sched_yield", "sock_accept", "sock_recv",
  "sock_send", "sock_shutdown",
  "thread_spawn", "playground_spawn",
];

// Channel layout: Int32 [0] state, [1] call number, [2] result;
// BigInt64 arguments from byte 16.
export const CHANNEL_BYTES = 128;
export const MAX_ARGS = 12;
const IDLE = 0, REQUEST = 1, DONE = 2, BUSY = 3;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The limits of the memory a module imports, read from its binary.
 *  `bytes` may be a prefix of the module; returns `undefined` if it is too
 *  short to tell, and `null` if the module imports no memory. */
export function importedMemory(bytes) {
  try {
    return importedMemoryOrThrow(bytes);
  } catch (e) {
    if (e === TRUNCATED) return undefined;
    throw e;
  }
}

const TRUNCATED = Symbol("truncated");

function importedMemoryOrThrow(bytes) {
  let p = 8;
  const leb = () => {
    let r = 0, shift = 0, b;
    do {
      if (p >= bytes.length) throw TRUNCATED;
      b = bytes[p++]; r += (b & 0x7f) * 2 ** shift; shift += 7;
    } while (b & 0x80);
    return r;
  };
  const name = () => { const n = leb(); const s = decoder.decode(bytes.subarray(p, p + n)); p += n; return s; };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 2) {
      if (end > bytes.length) throw TRUNCATED;
      for (let n = leb(); n > 0; n--) {
        const mod = name(), field = name(), kind = bytes[p++];
        if (kind === 0) leb();
        else if (kind === 1) { p++; const f = leb(); leb(); if (f & 1) leb(); }
        else if (kind === 3) { p++; p++; }
        else if (kind === 4) { p++; leb(); }
        else if (kind === 2) {
          const flags = leb();
          const initial = leb();
          const maximum = flags & 1 ? leb() : undefined;
          return { module: mod, name: field, initial, maximum, shared: !!(flags & 2) };
        }
      }
      return null;
    }
    p = end;
  }
  return null;
}

class OpenFile {
  constructor(node, path, append) {
    this.node = node; this.path = path; this.pos = 0; this.append = append;
  }
}
class OpenDir {
  constructor(node, path, preopen) { this.node = node; this.path = path; this.preopen = preopen; }
}
class Stdio {
  constructor(which) { this.which = which; }
}

/** A process memory: as the module declares it, but no larger than
 *  `maxPages` if given. Shared memory cannot move, so browsers reserve its
 *  maximum up front: address space only, but some have little of it. */
function newMemory(limits, maxPages) {
  const maximum = Math.min(limits.maximum ?? 65536, maxPages ?? 65536);
  return new WebAssembly.Memory({
    initial: limits.initial,
    maximum: Math.max(maximum, limits.initial),
    shared: true,
  });
}

/** The browser would not allocate a process's memory. */
export class OutOfMemoryError extends Error {
  constructor() {
    super("Out of memory: the browser refused to give this page more WebAssembly memory. " +
      "The compiler and each program reserve memory up front (up to 1 GB for the compiler), " +
      "and some browsers allow less than others. Reloading the page frees it.");
    this.name = "OutOfMemoryError";
  }
}

export class Process {
  constructor(kernel, pid, opts) {
    this.kernel = kernel;
    this.pid = pid;
    this.args = opts.args ?? ["program"];
    this.env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    this.stdin = opts.stdin ?? new Uint8Array(0);
    this.stdinPos = 0;
    this.onStdout = opts.stdout ?? (() => {});
    this.onStderr = opts.stderr ?? (() => {});
    this.fds = new Map([[0, new Stdio(0)], [1, new Stdio(1)], [2, new Stdio(2)]]);
    for (const dir of opts.preopens ?? ["/"]) {
      this.fds.set(this.fds.size, new OpenDir(kernel.fs.mkdirp(dir), dir, dir));
    }
    this.threads = new Set();
    /** Processes it started with playground.spawn, still running. */
    this.children = new Set();
    /** Threads prepared (instantiated) for it, waiting to be started. */
    this.spares = [];
    /** How many threads it has started, the main thread included. */
    this.started = 0;
    this.exitCode = null;
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
  }

  view() { return new DataView(this.memory.buffer); }
  bytes(ptr, len) { return new Uint8Array(this.memory.buffer, ptr, len); }
  string(ptr, len) { return decoder.decode(this.bytes(ptr, len).slice()); }

  newFd(obj) {
    let fd = 3;
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, obj);
    return fd;
  }
}

/** At most this many threads are prepared ahead for a process. */
const MAX_SPARE_THREADS = 8;

/** Arguments arrive as BigInts; pointers and sizes are unsigned 32-bit. */
const u32 = (a) => Number(BigInt.asUintN(32, a));

export class Kernel {
  /**
   * @param {object} opts
   * @param {MemFS} [opts.fs]
   * @param {() => {postMessage(m: any): void, onMessage(f: (m: any) => void): void, terminate(): void}} opts.createWorker
   * @param {Record<string, {module: WebAssembly.Module, bytes: Uint8Array}>} [opts.programs]
   *   Programs `playground.spawn` can run, by `argv[0]`.
   * @param {number} [opts.pool] How many idle workers to keep ready, so that
   *   starting a thread does not wait for one to be created.
   */
  constructor({ fs = new MemFS(), createWorker, programs = {}, trace = null, pool = 0 }) {
    this.fs = fs;
    /** Called with a line of text for each system call and thread event. */
    this.trace = trace;
    this.createWorker = createWorker;
    this.programs = programs;
    this.doorbell = new Int32Array(new SharedArrayBuffer(4));
    this.threads = new Map();
    this.nextTid = 1;
    this.nextPid = 1;
    this.poolSize = pool;
    this.idleWorkers = [];
    /** For each module: the most threads a process of it has started. */
    this.threadsUsed = new WeakMap();
    /** Programs to keep a process prepared for (`keepWarm`), by module. */
    this.keptWarm = new Map();
    /** The prepared process for each of them: { memory, threads }. */
    this.warm = new Map();
    this.refillPool();
    this.loop();
  }

  // ---- Starting threads ahead of time ----------------------------------------
  //
  // Starting a thread means creating a worker (a few ms) and instantiating
  // the module in it (a few more for rustc). Both can happen before the
  // thread is needed: idle workers wait in a pool, each process gets its
  // threads prepared (instantiated, waiting to start) as soon as it starts,
  // as many as processes of its module have used before, and `keepWarm`
  // keeps a whole process prepared for the next run of a program.

  /** An idle worker from the pool, or a new one. */
  takeWorker() {
    const w = this.idleWorkers.pop() ?? this.createWorker();
    this.refillPool();
    return w;
  }

  refillPool() {
    if (this.refilling || this.idleWorkers.length >= this.poolSize) return;
    this.refilling = true;
    setTimeout(() => {
      this.refilling = false;
      while (this.idleWorkers.length < this.poolSize) this.idleWorkers.push(this.createWorker());
    }, 0);
  }

  /** A thread of `module` instantiated on `memory`, waiting for `startThread`. */
  prepareThread(module, memory) {
    const buffer = new SharedArrayBuffer(CHANNEL_BYTES);
    const t = {
      tid: null, proc: null,
      ctl: new Int32Array(buffer, 0, 4),
      args: new BigInt64Array(buffer, 16, MAX_ARGS),
      worker: this.takeWorker(),
    };
    t.worker.onMessage((m) => this.onThreadMessage(t, m));
    t.worker.postMessage({
      type: "prepare", module, memory, channel: buffer,
      doorbell: this.doorbell.buffer, syscalls: SYSCALLS,
    });
    return t;
  }

  prepareThreads(module, memory, n) {
    return Array.from({ length: Math.min(n, MAX_SPARE_THREADS) }, () => this.prepareThread(module, memory));
  }

  /** Keep a process of `program` prepared, so that spawning it starts at once. */
  keepWarm(program) {
    this.keptWarm.set(program.module, program);
    this.warmUp(program.module);
  }

  warmUp(module) {
    const program = this.keptWarm.get(module);
    if (!program || this.warm.has(module)) return;
    let memory;
    try {
      const max = Array.isArray(program.maxPages) ? program.maxPages[0] : program.maxPages;
      memory = newMemory(program.limits ?? importedMemory(program.bytes), max);
    } catch {
      // No memory to spare: stop preparing processes ahead.
      this.coolDown();
      return;
    }
    const threads = this.prepareThreads(module, memory, this.threadsUsed.get(module) ?? 1);
    this.warm.set(module, { memory, threads });
  }

  /** Stop keeping processes prepared, and let go of the prepared ones: each
   *  holds a memory, which some browsers have few of. */
  coolDown() {
    this.keptWarm.clear();
    for (const { threads } of this.warm.values()) {
      for (const t of threads) t.worker.terminate();
    }
    this.warm.clear();
  }

  /** A new process memory. `maxPages` is a limit, or a list of limits to try
   *  in turn, largest first: the largest the browser will reserve wins. On
   *  failure, free the prepared processes' memories and try once more. */
  allocateMemory(limits, maxPages) {
    const limitsToTry = Array.isArray(maxPages) ? maxPages : [maxPages];
    const attempt = () => {
      for (const max of limitsToTry) {
        try {
          return newMemory(limits, max);
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
      }
      return null;
    };
    let memory = attempt();
    if (!memory) {
      this.coolDown();
      memory = attempt();
    }
    if (!memory) throw new OutOfMemoryError();
    return memory;
  }

  async loop() {
    for (;;) {
      const seen = Atomics.load(this.doorbell, 0);
      for (const t of this.threads.values()) {
        if (Atomics.compareExchange(t.ctl, 0, REQUEST, BUSY) === REQUEST) this.dispatch(t);
      }
      const r = Atomics.waitAsync(this.doorbell, 0, seen);
      if (r.async) await r.value;
    }
  }

  /**
   * Start a program: `{ module, limits }`, with `limits` from
   * `importedMemory` (or `{ module, bytes }` to compute them), and optionally
   * `maxPages`, a limit on its memory below the module's own (or a list of
   * them to try, largest first). Resolves the returned process's `exited`
   * with the exit code.
   */
  spawn(program, opts = {}) {
    const limits = program.limits ?? importedMemory(program.bytes);
    if (!limits || limits.module !== "env" || limits.name !== "memory" || !limits.shared) {
      throw new Error("program must import a shared env.memory (target wasm32-wasip1-threads)");
    }
    const proc = new Process(this, this.nextPid++, opts);
    proc.module = program.module;
    const warm = this.warm.get(program.module);
    if (warm) {
      this.warm.delete(program.module);
      proc.memory = warm.memory;
      proc.spares = warm.threads;
      this.startThread(proc, null);
    } else {
      proc.memory = this.allocateMemory(limits, program.maxPages);
      this.startThread(proc, null);
      proc.spares = this.prepareThreads(proc.module, proc.memory, (this.threadsUsed.get(proc.module) ?? 1) - 1);
    }
    return proc;
  }

  startThread(proc, startArg) {
    const t = proc.spares.shift() ?? this.prepareThread(proc.module, proc.memory);
    t.tid = this.nextTid++;
    t.proc = proc;
    this.threads.set(t.tid, t);
    proc.threads.add(t);
    proc.started++;
    this.trace?.(`[${proc.pid}:${t.tid}] start${startArg === null ? " main" : ` thread arg=${startArg}`}`);
    t.worker.postMessage({ type: "start", tid: t.tid, startArg });
    return t.tid;
  }

  onThreadMessage(t, m) {
    if (!this.threads.has(t.tid)) return;
    this.trace?.(`[${t.proc.pid}:${t.tid}] ${m.type}${m.message ? `: ${m.message}` : ""}`);
    if (m.type === "exit") {
      // `_start` returned without `proc_exit`.
      this.exit(t.proc, 0);
    } else if (m.type === "thread-exit") {
      this.threads.delete(t.tid);
      t.proc.threads.delete(t);
      t.worker.terminate();
    } else if (m.type === "trap") {
      // A Rust panic with panic=abort ends in `unreachable`, after printing
      // the panic message; the wasm stack is only interesting when tracing.
      const stack = this.trace && m.stack ? `${m.stack}\n` : "";
      t.proc.onStderr(encoder.encode(`error: the program trapped (${m.message})\n${stack}`));
      this.exit(t.proc, 134);
    }
  }

  /** Terminate a process (and all its threads) with exit code `code`. */
  kill(proc, code = 137) {
    this.exit(proc, code);
  }

  exit(proc, code) {
    if (proc.exitCode !== null) return;
    proc.exitCode = code;
    // A killed compiler takes its linker with it.
    for (const child of proc.children) this.exit(child, code);
    for (const t of proc.threads) {
      this.threads.delete(t.tid);
      t.worker.terminate();
    }
    proc.threads.clear();
    for (const t of proc.spares) t.worker.terminate();
    proc.spares = [];
    this.threadsUsed.set(proc.module, Math.max(this.threadsUsed.get(proc.module) ?? 0, proc.started));
    // The next process of a kept-warm program, prepared while nothing runs.
    if (this.keptWarm.has(proc.module)) setTimeout(() => this.warmUp(proc.module), 0);
    proc.resolveExit(code);
  }

  dispatch(t) {
    const name = SYSCALLS[t.ctl[1]];
    const handler = this[`sys_${name}`];
    let r;
    try {
      r = handler ? handler.call(this, t.proc, t.args, t) : E.NOSYS;
    } catch (e) {
      t.proc.onStderr(encoder.encode(`kernel: ${name} failed: ${e}\n${e.stack}\n`));
      r = E.IO;
    }
    if (this.trace) {
      const shown = Array.from(t.args.slice(0, 6), String).join(", ");
      const log = (v) => this.trace(`[${t.proc.pid}:${t.tid}] ${name}(${shown}) = ${v}`);
      if (r instanceof Promise) r.then(log); else log(r);
    }
    if (r instanceof Promise) r.then((v) => this.reply(t, v));
    else if (r !== undefined) this.reply(t, r);
  }

  reply(t, value) {
    if (!this.threads.has(t.tid)) return;
    t.ctl[2] = value;
    Atomics.store(t.ctl, 0, DONE);
    Atomics.notify(t.ctl, 0);
  }

  // ---- Arguments, environment, clocks, randomness --------------------------

  writeStrings(proc, list, ptrsPtr, bufPtr) {
    const v = proc.view();
    let p = bufPtr;
    list.forEach((s, i) => {
      const b = encoder.encode(s + "\0");
      v.setUint32(ptrsPtr + 4 * i, p, true);
      proc.bytes(p, b.length).set(b);
      p += b.length;
    });
    return E.SUCCESS;
  }
  sizes(proc, list, countPtr, sizePtr) {
    const v = proc.view();
    v.setUint32(countPtr, list.length, true);
    v.setUint32(sizePtr, list.reduce((n, s) => n + encoder.encode(s).length + 1, 0), true);
    return E.SUCCESS;
  }
  sys_args_get(p, a) { return this.writeStrings(p, p.args, u32(a[0]), u32(a[1])); }
  sys_args_sizes_get(p, a) { return this.sizes(p, p.args, u32(a[0]), u32(a[1])); }
  sys_environ_get(p, a) { return this.writeStrings(p, p.env, u32(a[0]), u32(a[1])); }
  sys_environ_sizes_get(p, a) { return this.sizes(p, p.env, u32(a[0]), u32(a[1])); }

  now(id) {
    if (id === 0) return BigInt(Date.now()) * 1000000n;
    return BigInt(Math.round(performance.now() * 1e6));
  }
  sys_clock_res_get(p, a) { p.view().setBigUint64(u32(a[1]), 1000n, true); return E.SUCCESS; }
  sys_clock_time_get(p, a) {
    p.view().setBigUint64(u32(a[2]), this.now(u32(a[0])), true);
    return E.SUCCESS;
  }
  sys_random_get(p, a) {
    const buf = new Uint8Array(u32(a[1]));
    for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
    p.bytes(u32(a[0]), buf.length).set(buf);
    return E.SUCCESS;
  }
  sys_sched_yield() { return E.SUCCESS; }
  // Exit statuses are 8 bits, as on Unix: exit(-1) is 255. (It also keeps
  // them apart from playground_spawn's -1, "no such program".)
  sys_proc_exit(p, a) { this.exit(p, u32(a[0]) & 0xff); return undefined; }
  sys_proc_raise() { return E.NOSYS; }

  sys_poll_oneoff(p, a) {
    const [inPtr, outPtr, n, neventsPtr] = [u32(a[0]), u32(a[1]), u32(a[2]), u32(a[3])];
    const v = p.view();
    let wait = 0n;
    const ready = [];
    for (let i = 0; i < n; i++) {
      const s = inPtr + 48 * i;
      const tag = v.getUint8(s + 8);
      if (tag === 0) {
        const id = v.getUint32(s + 16, true);
        let timeout = v.getBigUint64(s + 24, true);
        if (v.getUint16(s + 40, true) & 1) timeout -= this.now(id);
        if (timeout > wait) wait = timeout;
      }
      ready.push({ userdata: v.getBigUint64(s, true), tag });
    }
    const finish = () => {
      const v = p.view();
      ready.forEach((e, i) => {
        const o = outPtr + 32 * i;
        v.setBigUint64(o, e.userdata, true);
        v.setUint16(o + 8, 0, true);
        v.setUint8(o + 10, e.tag);
        v.setBigUint64(o + 16, 0n, true);
        v.setUint16(o + 24, 0, true);
      });
      v.setUint32(neventsPtr, ready.length, true);
      return E.SUCCESS;
    };
    if (wait <= 0n) return finish();
    return new Promise((resolve) => setTimeout(() => resolve(finish()), Number(wait / 1000000n)));
  }

  // ---- File descriptors ----------------------------------------------------

  sys_fd_write(p, a) { return this.write(p, u32(a[0]), u32(a[1]), u32(a[2]), u32(a[3]), null); }
  sys_fd_pwrite(p, a) { return this.write(p, u32(a[0]), u32(a[1]), u32(a[2]), u32(a[4]), Number(a[3])); }
  sys_fd_read(p, a) { return this.read(p, u32(a[0]), u32(a[1]), u32(a[2]), u32(a[3]), null); }
  sys_fd_pread(p, a) { return this.read(p, u32(a[0]), u32(a[1]), u32(a[2]), u32(a[4]), Number(a[3])); }

  write(p, fd, iovs, n, nwrittenPtr, at) {
    const f = p.fds.get(fd);
    if (!f || f instanceof OpenDir) return E.BADF;
    const v = p.view();
    let total = 0;
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const ptr = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
      chunks.push(p.bytes(ptr, len).slice());
      total += len;
    }
    if (f instanceof Stdio) {
      const out = f.which === 2 ? p.onStderr : p.onStdout;
      for (const c of chunks) if (c.length) out(c);
    } else {
      let pos = at ?? (f.append ? f.node.size : f.pos);
      for (const c of chunks) { f.node.write(pos, c); pos += c.length; }
      if (at === null) f.pos = pos;
    }
    v.setUint32(nwrittenPtr, total, true);
    return E.SUCCESS;
  }

  read(p, fd, iovs, n, nreadPtr, at) {
    const f = p.fds.get(fd);
    if (!f || f instanceof OpenDir) return f ? E.ISDIR : E.BADF;
    const v = p.view();
    let total = 0;
    let pos = f instanceof Stdio ? p.stdinPos : at ?? f.pos;
    const src = f instanceof Stdio ? p.stdin : f.node.bytes();
    for (let i = 0; i < n; i++) {
      const ptr = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
      const chunk = src.subarray(pos, Math.min(pos + len, src.length));
      p.bytes(ptr, chunk.length).set(chunk);
      pos += chunk.length;
      total += chunk.length;
      if (chunk.length < len) break;
    }
    if (f instanceof Stdio) p.stdinPos = pos;
    else if (at === null) f.pos = pos;
    v.setUint32(nreadPtr, total, true);
    return E.SUCCESS;
  }

  sys_fd_close(p, a) { return p.fds.delete(u32(a[0])) ? E.SUCCESS : E.BADF; }
  sys_fd_seek(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!f) return E.BADF;
    if (!(f instanceof OpenFile)) return E.SPIPE;
    const off = Number(a[1]);
    const whence = u32(a[2]);
    const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size;
    if (base + off < 0) return E.INVAL;
    f.pos = base + off;
    p.view().setBigUint64(u32(a[3]), BigInt(f.pos), true);
    return E.SUCCESS;
  }
  sys_fd_tell(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!(f instanceof OpenFile)) return f ? E.SPIPE : E.BADF;
    p.view().setBigUint64(u32(a[1]), BigInt(f.pos), true);
    return E.SUCCESS;
  }
  sys_fd_advise() { return E.SUCCESS; }
  sys_fd_allocate() { return E.SUCCESS; }
  sys_fd_datasync() { return E.SUCCESS; }
  sys_fd_sync() { return E.SUCCESS; }
  sys_fd_fdstat_set_flags() { return E.SUCCESS; }
  sys_fd_fdstat_set_rights() { return E.SUCCESS; }
  sys_fd_filestat_set_times() { return E.SUCCESS; }
  sys_path_filestat_set_times() { return E.SUCCESS; }

  sys_fd_fdstat_get(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!f) return E.BADF;
    const v = p.view(), o = u32(a[1]);
    const type = f instanceof Stdio ? FILETYPE.CHARACTER_DEVICE
      : f instanceof OpenDir ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE;
    v.setUint8(o, type);
    v.setUint16(o + 2, f instanceof OpenFile && f.append ? FDFLAGS_APPEND : 0, true);
    v.setBigUint64(o + 8, ALL_RIGHTS, true);
    v.setBigUint64(o + 16, ALL_RIGHTS, true);
    return E.SUCCESS;
  }

  filestat(p, node, o) {
    const v = p.view();
    v.setBigUint64(o, 0n, true);
    v.setBigUint64(o + 8, node ? node.ino : 0n, true);
    v.setUint8(o + 16, !node ? FILETYPE.CHARACTER_DEVICE
      : node instanceof Dir ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
    v.setBigUint64(o + 24, 1n, true);
    v.setBigUint64(o + 32, BigInt(node instanceof File ? node.size : 0), true);
    const t = node ? node.mtime : 0n;
    v.setBigUint64(o + 40, t, true);
    v.setBigUint64(o + 48, t, true);
    v.setBigUint64(o + 56, t, true);
    return E.SUCCESS;
  }
  sys_fd_filestat_get(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!f) return E.BADF;
    return this.filestat(p, f instanceof Stdio ? null : f.node, u32(a[1]));
  }
  sys_fd_filestat_set_size(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!(f instanceof OpenFile)) return E.BADF;
    f.node.resize(Number(a[1]));
    return E.SUCCESS;
  }
  sys_fd_prestat_get(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!(f instanceof OpenDir) || !f.preopen) return E.BADF;
    const v = p.view(), o = u32(a[1]);
    v.setUint8(o, 0);
    v.setUint32(o + 4, encoder.encode(f.preopen).length, true);
    return E.SUCCESS;
  }
  sys_fd_prestat_dir_name(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!(f instanceof OpenDir) || !f.preopen) return E.BADF;
    const b = encoder.encode(f.preopen);
    p.bytes(u32(a[1]), Math.min(b.length, u32(a[2]))).set(b.subarray(0, u32(a[2])));
    return E.SUCCESS;
  }
  sys_fd_renumber(p, a) {
    const from = u32(a[0]), to = u32(a[1]);
    const f = p.fds.get(from);
    if (!f) return E.BADF;
    p.fds.delete(from);
    p.fds.set(to, f);
    return E.SUCCESS;
  }
  sys_fd_readdir(p, a) {
    const f = p.fds.get(u32(a[0]));
    if (!(f instanceof OpenDir)) return E.BADF;
    const [buf, len] = [u32(a[1]), u32(a[2])];
    const cookie = Number(a[3]);
    const names = [[".", f.node], ["..", f.node], ...f.node.entries];
    const v = p.view();
    let used = 0;
    for (let i = cookie; i < names.length && used < len; i++) {
      const [name, node] = names[i];
      const nb = encoder.encode(name);
      const ent = new Uint8Array(24 + nb.length);
      const dv = new DataView(ent.buffer);
      dv.setBigUint64(0, BigInt(i + 1), true);
      dv.setBigUint64(8, node.ino, true);
      dv.setUint32(16, nb.length, true);
      dv.setUint8(20, node instanceof Dir ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
      ent.set(nb, 24);
      const n = Math.min(ent.length, len - used);
      p.bytes(buf + used, n).set(ent.subarray(0, n));
      used += n;
    }
    v.setUint32(u32(a[4]), used, true);
    return E.SUCCESS;
  }

  // ---- Paths ---------------------------------------------------------------

  /** The absolute path of `path` relative to directory descriptor `fd`. */
  resolve(p, fd, ptr, len) {
    const d = p.fds.get(fd);
    if (!(d instanceof OpenDir)) return null;
    return join(d.path, p.string(ptr, len));
  }

  sys_path_open(p, a) {
    const path = this.resolve(p, u32(a[0]), u32(a[2]), u32(a[3]));
    if (path === null) return E.BADF;
    const oflags = u32(a[4]), fdflags = u32(a[7]);
    let node = this.fs.lookup(path);
    // A compressed file is unpacked when first opened; then open it again.
    if (node instanceof File && node.packed) return node.unpack().then(() => this.sys_path_open(p, a));
    if (node && oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT) return E.EXIST;
    if (!node) {
      if (!(oflags & OFLAGS.CREAT)) return E.NOENT;
      const parent = this.fs.parent(path);
      if (!parent) return E.NOENT;
      node = new File();
      parent[0].entries.set(parent[1], node);
    }
    if (oflags & OFLAGS.DIRECTORY && !(node instanceof Dir)) return E.NOTDIR;
    let fd;
    if (node instanceof Dir) {
      fd = p.newFd(new OpenDir(node, path, null));
    } else {
      if (oflags & OFLAGS.TRUNC) node.resize(0);
      fd = p.newFd(new OpenFile(node, path, !!(fdflags & FDFLAGS_APPEND)));
    }
    p.view().setUint32(u32(a[8]), fd, true);
    return E.SUCCESS;
  }
  sys_path_filestat_get(p, a) {
    const path = this.resolve(p, u32(a[0]), u32(a[2]), u32(a[3]));
    if (path === null) return E.BADF;
    const node = this.fs.lookup(path);
    if (!node) return E.NOENT;
    return this.filestat(p, node, u32(a[4]));
  }
  sys_path_create_directory(p, a) {
    const path = this.resolve(p, u32(a[0]), u32(a[1]), u32(a[2]));
    if (path === null) return E.BADF;
    if (this.fs.lookup(path)) return E.EXIST;
    const parent = this.fs.parent(path);
    if (!parent) return E.NOENT;
    parent[0].entries.set(parent[1], new Dir());
    return E.SUCCESS;
  }
  sys_path_remove_directory(p, a) {
    const path = this.resolve(p, u32(a[0]), u32(a[1]), u32(a[2]));
    if (path === null) return E.BADF;
    const node = this.fs.lookup(path);
    if (!node) return E.NOENT;
    if (!(node instanceof Dir)) return E.NOTDIR;
    if (node.entries.size) return E.NOTEMPTY;
    this.fs.remove(path);
    return E.SUCCESS;
  }
  sys_path_unlink_file(p, a) {
    const path = this.resolve(p, u32(a[0]), u32(a[1]), u32(a[2]));
    if (path === null) return E.BADF;
    const node = this.fs.lookup(path);
    if (!node) return E.NOENT;
    if (node instanceof Dir) return E.ISDIR;
    this.fs.remove(path);
    return E.SUCCESS;
  }
  sys_path_rename(p, a) {
    const from = this.resolve(p, u32(a[0]), u32(a[1]), u32(a[2]));
    const to = this.resolve(p, u32(a[3]), u32(a[4]), u32(a[5]));
    if (from === null || to === null) return E.BADF;
    const node = this.fs.lookup(from);
    if (!node) return E.NOENT;
    const parent = this.fs.parent(to);
    if (!parent) return E.NOENT;
    this.fs.remove(from);
    parent[0].entries.set(parent[1], node);
    return E.SUCCESS;
  }
  sys_path_readlink() { return E.INVAL; }
  sys_path_link() { return E.NOTSUP; }
  sys_path_symlink() { return E.NOTSUP; }
  sys_sock_accept() { return E.NOSYS; }
  sys_sock_recv() { return E.NOSYS; }
  sys_sock_send() { return E.NOSYS; }
  sys_sock_shutdown() { return E.NOSYS; }

  // ---- Threads and processes -----------------------------------------------

  sys_thread_spawn(p, a) {
    return this.startThread(p, u32(a[0]));
  }

  /**
   * `playground.spawn(argv, argc) -> i32`: run the program `argv[0]` from
   * `programs` to completion with arguments `argv` (an array of
   * NUL-terminated strings) and the same filesystem and output, returning
   * its exit code, or -1 if there is no such program.
   */
  sys_playground_spawn(p, a) {
    const v = p.view();
    const argv = [];
    for (let i = 0; i < u32(a[1]); i++) {
      let s = v.getUint32(u32(a[0]) + 4 * i, true), e = s;
      while (v.getUint8(e)) e++;
      argv.push(p.string(s, e - s));
    }
    const name = argv[0].split("/").pop();
    const program = this.programs[name];
    if (!program) {
      p.onStderr(encoder.encode(`kernel: no program named ${name}\n`));
      return -1;
    }
    const child = this.spawn(program, {
      args: argv,
      env: Object.fromEntries(p.env.map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
      stdout: p.onStdout,
      stderr: p.onStderr,
    });
    p.children.add(child);
    return child.exited.then((code) => {
      p.children.delete(child);
      return code;
    });
  }
}
