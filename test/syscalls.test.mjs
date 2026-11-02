// The kernel's system calls, called directly on a process with a plain memory: no wasm program,
// worker or wasi-sdk needed.
//
//   node --test test/syscalls.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { E, Kernel, Process } from "../kernel.js";
import { File } from "../fs.js";

const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const APPEND = 1;
const FILETYPE = { CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 };
const SEEK = { SET: 0, CUR: 1, END: 2 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A kernel and one process with `preopens` (the first is fd 3), and helpers that make its system
 *  calls with arguments in a scratch area of its memory. */
function setup({ preopens = ["/"], args, env, stdin } = {}) {
  const kernel = new Kernel({ createWorker: () => { throw new Error("no threads here"); } });
  const proc = new Process(kernel, 1, { preopens, args, env, stdin });
  proc.memory = new WebAssembly.Memory({ initial: 4 });
  let top = 1024;
  const alloc = (n) => { const p = top; top += (n + 7) & ~7; return p; };
  const view = () => proc.view();
  const string = (s) => { const b = encoder.encode(s); const p = alloc(b.length); proc.bytes(p, b.length).set(b); return [p, b.length]; };
  const sys = (name, ...a) => kernel[`sys_${name}`](proc, a.map((x) => BigInt(x)), null);
  const out = () => alloc(8);
  const u32 = (p) => view().getUint32(p, true);
  const u64 = (p) => view().getBigUint64(p, true);
  const iovec = (bufs) => {
    const iovs = alloc(8 * bufs.length);
    bufs.forEach(([p, n], i) => { view().setUint32(iovs + 8 * i, p, true); view().setUint32(iovs + 8 * i + 4, n, true); });
    return iovs;
  };
  const h = {
    kernel, proc, alloc, sys, u32, u64,
    async open(path, { oflags = 0, fdflags = 0, dir = 3 } = {}) {
      const [p, n] = string(path), o = out();
      const errno = await sys("path_open", dir, 0, p, n, oflags, 0, 0, fdflags, o);
      return { errno, fd: errno === E.SUCCESS ? u32(o) : undefined };
    },
    async create(path, text = "") {
      const { errno, fd } = await h.open(path, { oflags: O.CREAT | O.TRUNC });
      assert.equal(errno, E.SUCCESS, `create ${path}`);
      if (text) h.write(fd, text);
      return fd;
    },
    write(fd, text, at = null) {
      const b = encoder.encode(text), p = alloc(b.length), o = out();
      proc.bytes(p, b.length).set(b);
      const iovs = iovec([[p, b.length]]);
      const errno = at === null ? sys("fd_write", fd, iovs, 1, o) : sys("fd_pwrite", fd, iovs, 1, at, o);
      return { errno, n: u32(o) };
    },
    async read(fd, len = 4096, at = null) {
      const p = alloc(len), o = out();
      const iovs = iovec([[p, len]]);
      const errno = await (at === null ? sys("fd_read", fd, iovs, 1, o) : sys("fd_pread", fd, iovs, 1, at, o));
      return { errno, text: errno === E.SUCCESS ? decoder.decode(proc.bytes(p, u32(o)).slice()) : undefined };
    },
    seek(fd, offset, whence) {
      const o = out();
      const errno = sys("fd_seek", fd, offset, whence, o);
      return { errno, pos: errno === E.SUCCESS ? Number(u64(o)) : undefined };
    },
    close: (fd) => sys("fd_close", fd),
    stat(path, dir = 3) {
      const [p, n] = string(path), o = alloc(64);
      const errno = sys("path_filestat_get", dir, 0, p, n, o);
      if (errno !== E.SUCCESS) return { errno };
      return { errno, ino: u64(o + 8), filetype: view().getUint8(o + 16), size: Number(u64(o + 32)) };
    },
    mkdir: (path, dir = 3) => sys("path_create_directory", dir, ...string(path)),
    rmdir: (path, dir = 3) => sys("path_remove_directory", dir, ...string(path)),
    unlink: (path, dir = 3) => sys("path_unlink_file", dir, ...string(path)),
    rename: (from, to, dir = 3) => sys("path_rename", dir, ...string(from), dir, ...string(to)),
    /** One fd_readdir call: the entries that fit whole, and whether the buffer filled. */
    readdir(fd, cookie = 0, len = 4096) {
      const buf = alloc(len), o = out();
      const errno = sys("fd_readdir", fd, buf, len, cookie, o);
      const used = u32(o), entries = [];
      for (let at = 0; at + 24 <= used;) {
        const namlen = u32(buf + at + 16);
        if (at + 24 + namlen > used) break;
        entries.push({
          next: Number(u64(buf + at)), ino: u64(buf + at + 8), type: view().getUint8(buf + at + 20),
          name: decoder.decode(proc.bytes(buf + at + 24, namlen).slice()),
        });
        at += 24 + namlen;
      }
      return { errno, entries, full: used === len };
    },
    /** All of a directory's names, as wasi-libc's readdir reads them: a buffer at a time, resuming
     *  from the last whole entry's cookie. `each` runs on each name as it is read. */
    listdir(fd, { len = 4096, each = () => {} } = {}) {
      const names = [];
      for (let cookie = 0; ;) {
        const r = h.readdir(fd, cookie, len);
        assert.equal(r.errno, E.SUCCESS);
        for (const e of r.entries) { names.push(e.name); each(e.name); cookie = e.next; }
        if (!r.full) return names;
      }
    },
  };
  return h;
}

// ---- Files -----------------------------------------------------------------

test("write, read back, seek and tell", async () => {
  const h = setup();
  const fd = await h.create("/f.txt", "hello world");
  assert.deepEqual(h.seek(fd, 0, SEEK.CUR), { errno: E.SUCCESS, pos: 11 });
  assert.deepEqual(h.seek(fd, 6, SEEK.SET), { errno: E.SUCCESS, pos: 6 });
  assert.equal((await h.read(fd)).text, "world");
  assert.equal((await h.read(fd)).text, "", "at the end, a read returns nothing");
  assert.deepEqual(h.seek(fd, -5, SEEK.END), { errno: E.SUCCESS, pos: 6 });
  assert.equal(h.seek(fd, -1, SEEK.SET).errno, E.INVAL);
  const o = h.alloc(8);
  assert.equal(h.sys("fd_tell", fd, o), E.SUCCESS);
  assert.equal(h.u64(o), 6n);
});

test("pread and pwrite leave the position alone", async () => {
  const h = setup();
  const fd = await h.create("/f.txt", "abcdef");
  h.seek(fd, 1, SEEK.SET);
  assert.equal((await h.read(fd, 2, 3)).text, "de");
  assert.equal(h.write(fd, "XY", 4).errno, E.SUCCESS);
  assert.equal((await h.read(fd)).text, "bcdXY");
});

test("reading or seeking past the end; writing there leaves a hole of zeros", async () => {
  const h = setup();
  const fd = await h.create("/f.txt", "ab");
  assert.equal(h.seek(fd, 10, SEEK.SET).pos, 10);
  assert.equal((await h.read(fd)).text, "");
  h.write(fd, "z");
  h.seek(fd, 0, SEEK.SET);
  assert.equal((await h.read(fd)).text, "ab" + "\0".repeat(8) + "z");
  assert.equal(h.stat("/f.txt").size, 11);
});

test("truncating and growing again gives zeros, not the old contents", async () => {
  const h = setup();
  const fd = await h.create("/f.txt", "abcdef");
  assert.equal(h.sys("fd_filestat_set_size", fd, 2), E.SUCCESS);
  assert.equal(h.sys("fd_filestat_set_size", fd, 4), E.SUCCESS);
  assert.equal((await h.read(fd, 100, 0)).text, "ab\0\0");
});

test("O_APPEND writes at the end wherever the position is", async () => {
  const h = setup();
  await h.create("/log", "one\n");
  const { fd } = await h.open("/log", { fdflags: APPEND });
  h.seek(fd, 0, SEEK.SET);
  h.write(fd, "two\n");
  assert.equal((await h.read(fd, 100, 0)).text, "one\ntwo\n");
});

test("O_TRUNC empties; O_CREAT|O_EXCL refuses an existing file", async () => {
  const h = setup();
  await h.create("/f.txt", "abc");
  assert.equal((await h.open("/f.txt", { oflags: O.CREAT | O.EXCL })).errno, E.EXIST);
  const { fd } = await h.open("/f.txt", { oflags: O.TRUNC });
  assert.equal((await h.read(fd)).text, "");
});

test("opening what is not there", async () => {
  const h = setup();
  assert.equal((await h.open("/missing")).errno, E.NOENT);
  assert.equal((await h.open("/no/such/dir/f", { oflags: O.CREAT })).errno, E.NOENT);
  await h.create("/f.txt");
  assert.equal((await h.open("/f.txt", { oflags: O.DIRECTORY })).errno, E.NOTDIR);
});

test("O_DIRECTORY|O_CREAT of a missing name creates nothing", async () => {
  const h = setup();
  assert.notEqual((await h.open("/d", { oflags: O.CREAT | O.DIRECTORY })).errno, E.SUCCESS);
  assert.equal(h.stat("/d").errno, E.NOENT);
});

test("an unlinked file stays readable through an open descriptor", async () => {
  const h = setup();
  const fd = await h.create("/f.txt", "still here");
  assert.equal(h.unlink("/f.txt"), E.SUCCESS);
  assert.equal(h.stat("/f.txt").errno, E.NOENT);
  assert.equal((await h.read(fd, 100, 0)).text, "still here");
  // and a new file of the same name is a different file
  await h.create("/f.txt", "new");
  assert.equal((await h.read(fd, 100, 0)).text, "still here");
});

// ---- Directories and paths ---------------------------------------------------

test("stat: types, sizes and distinct inodes", async () => {
  const h = setup();
  await h.create("/a.txt", "12345");
  await h.create("/b.txt");
  assert.equal(h.mkdir("/d"), E.SUCCESS);
  const a = h.stat("/a.txt"), b = h.stat("/b.txt"), d = h.stat("/d");
  assert.deepEqual([a.filetype, a.size], [FILETYPE.REGULAR_FILE, 5]);
  assert.equal(d.filetype, FILETYPE.DIRECTORY);
  assert.equal(new Set([a.ino, b.ino, d.ino]).size, 3);
});

test("directories: create, remove and their errors", async () => {
  const h = setup();
  assert.equal(h.mkdir("/d"), E.SUCCESS);
  assert.equal(h.mkdir("/d"), E.EXIST);
  assert.equal(h.mkdir("/x/y"), E.NOENT);
  assert.equal(h.mkdir("/d/sub/"), E.SUCCESS, "a trailing slash names the directory");
  assert.equal(h.stat("/d/sub/").filetype, FILETYPE.DIRECTORY);
  await h.create("/d/f");
  assert.equal(h.rmdir("/d"), E.NOTEMPTY);
  assert.equal(h.rmdir("/d/f"), E.NOTDIR);
  assert.equal(h.unlink("/d/sub"), E.ISDIR);
  assert.equal(h.unlink("/d/f"), E.SUCCESS);
  assert.equal(h.rmdir("/d/sub"), E.SUCCESS);
  assert.equal(h.rmdir("/d"), E.SUCCESS);
  assert.equal(h.stat("/d").errno, E.NOENT);
});

test("paths relative to a directory descriptor, and . and ..", async () => {
  const h = setup();
  h.mkdir("/a");
  h.mkdir("/a/b");
  await h.create("/a/b/f.txt", "deep");
  const { fd } = await h.open("/a", { oflags: O.DIRECTORY });
  const r = await h.open("b/./../b/f.txt", { dir: fd });
  assert.equal(r.errno, E.SUCCESS);
  assert.equal((await h.read(r.fd)).text, "deep");
});

test("a preopened directory confines its paths", async () => {
  const h = setup({ preopens: ["/sandbox"] });
  h.kernel.fs.writeFile("/secret", "no");
  h.kernel.fs.writeFile("/sandbox/ok", "yes");
  assert.equal((await h.open("ok")).errno, E.SUCCESS);
  assert.notEqual((await h.open("../secret")).errno, E.SUCCESS);
  assert.notEqual((await h.open("/secret")).errno, E.SUCCESS);
});

test("rename: files across directories, replacing a file", async () => {
  const h = setup();
  h.mkdir("/a");
  h.mkdir("/b");
  await h.create("/a/f", "moved");
  await h.create("/b/g", "replaced");
  assert.equal(h.rename("/a/f", "/b/g"), E.SUCCESS);
  assert.equal(h.stat("/a/f").errno, E.NOENT);
  const { fd } = await h.open("/b/g");
  assert.equal((await h.read(fd)).text, "moved");
  assert.equal(h.rename("/a/missing", "/b/x"), E.NOENT);
});

test("rename: a directory into itself, or over a directory that has entries, is refused", async () => {
  const h = setup();
  h.mkdir("/d");
  h.mkdir("/d/sub");
  await h.create("/d/sub/f", "keep");
  assert.equal(h.rename("/d", "/d/sub/inside"), E.INVAL);
  assert.equal(h.stat("/d/sub/f").errno, E.SUCCESS, "the tree is still there");
  h.mkdir("/other");
  await h.create("/other/g");
  assert.equal(h.rename("/d", "/other"), E.NOTEMPTY);
  assert.equal(h.stat("/other/g").errno, E.SUCCESS);
});

test("rename: a file over a directory, or a directory over a file, is refused", async () => {
  const h = setup();
  h.mkdir("/d");
  await h.create("/f");
  assert.equal(h.rename("/f", "/d"), E.ISDIR);
  assert.equal(h.rename("/d", "/f"), E.NOTDIR);
  assert.equal(h.stat("/d").filetype, FILETYPE.DIRECTORY);
  assert.equal(h.stat("/f").filetype, FILETYPE.REGULAR_FILE);
});

// ---- Reading directories -------------------------------------------------------

test("fd_readdir: entries, their types, and resuming from a cookie", async () => {
  const h = setup();
  h.mkdir("/d");
  h.mkdir("/d/sub");
  await h.create("/d/f.txt");
  const { fd } = await h.open("/d", { oflags: O.DIRECTORY });
  const { entries, full } = h.readdir(fd);
  assert.equal(full, false);
  assert.deepEqual(entries.map((e) => e.name), [".", "..", "sub", "f.txt"]);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName.sub.type, FILETYPE.DIRECTORY);
  assert.equal(byName["f.txt"].type, FILETYPE.REGULAR_FILE);
  assert.equal(byName.sub.ino, h.stat("/d/sub").ino);
  // from the cookie after "..": the rest
  assert.deepEqual(h.readdir(fd, byName[".."].next).entries.map((e) => e.name), ["sub", "f.txt"]);
  // past the end: nothing
  assert.deepEqual(h.readdir(fd, byName["f.txt"].next).entries, []);
});

test("fd_readdir: a small buffer ends in a cut-off entry, read whole from its cookie", async () => {
  const h = setup();
  h.mkdir("/d");
  for (const n of ["first-long-name", "second-long-name", "third-long-name"]) await h.create(`/d/${n}`);
  const { fd } = await h.open("/d", { oflags: O.DIRECTORY });
  assert.deepEqual(h.listdir(fd, { len: 60 }), [".", "..", "first-long-name", "second-long-name", "third-long-name"]);
});

test("fd_readdir: a large directory, a buffer at a time", async () => {
  const h = setup();
  h.mkdir("/d");
  const want = [];
  for (let i = 0; i < 1000; i++) { want.push(`file-${i}`); h.kernel.fs.writeFile(`/d/file-${i}`, ""); }
  const { fd } = await h.open("/d", { oflags: O.DIRECTORY });
  assert.deepEqual(h.listdir(fd).slice(2), want);
});

test("fd_readdir: removing entries while reading (as rm -r does) still sees each one", async () => {
  const h = setup();
  h.mkdir("/d");
  const want = [];
  for (let i = 0; i < 300; i++) { want.push(`file-${i}`); h.kernel.fs.writeFile(`/d/file-${i}`, ""); }
  const { fd } = await h.open("/d", { oflags: O.DIRECTORY });
  const seen = h.listdir(fd, { each: (n) => n.startsWith("file-") && h.unlink(`/d/${n}`) });
  assert.deepEqual(seen.slice(2), want);
  assert.deepEqual(h.listdir(fd), [".", ".."]);
});

// ---- Descriptors ---------------------------------------------------------------

test("closed and unknown descriptors", async () => {
  const h = setup();
  const fd = await h.create("/f");
  assert.equal(h.close(fd), E.SUCCESS);
  assert.equal(h.close(fd), E.BADF);
  assert.equal((await h.read(fd)).errno, E.BADF);
  assert.equal(h.write(fd, "x").errno, E.BADF);
  assert.equal(h.seek(99, 0, SEEK.SET).errno, E.BADF);
});

test("descriptors that are not files", async () => {
  const h = setup();
  assert.equal(h.seek(1, 0, SEEK.SET).errno, E.SPIPE, "stdout cannot seek");
  const { fd } = await h.open("/", { oflags: O.DIRECTORY });
  assert.equal((await h.read(fd)).errno, E.ISDIR);
  const o = h.alloc(24);
  assert.equal(h.sys("fd_fdstat_get", 1, o), E.SUCCESS);
  assert.equal(h.proc.view().getUint8(o), FILETYPE.CHARACTER_DEVICE);
  assert.equal(h.sys("fd_fdstat_get", fd, o), E.SUCCESS);
  assert.equal(h.proc.view().getUint8(o), FILETYPE.DIRECTORY);
});

test("fd_renumber moves a descriptor, closing the one it replaces", async () => {
  const h = setup();
  const a = await h.create("/a", "A");
  const b = await h.create("/b", "B");
  assert.equal(h.sys("fd_renumber", a, b), E.SUCCESS);
  assert.equal((await h.read(b, 10, 0)).text, "A");
  assert.equal((await h.read(a)).errno, E.BADF);
});

test("fd_renumber of a descriptor onto itself changes nothing", async () => {
  const h = setup();
  h.kernel.fs.writeFile("/f", "contents");
  const file = File.lazy(async () => encoder.encode("lazy"), 4, { evictable: true });
  h.kernel.fs.root.entries.set("lazy", file);
  const { fd } = await h.open("/lazy");
  assert.equal(h.sys("fd_renumber", fd, fd), E.SUCCESS);
  assert.equal((await h.read(fd)).text, "lazy");
  assert.equal(file.opens, 1);
});

test("the preopens: their names, and nothing else is one", async () => {
  const h = setup({ preopens: ["/", "/data"] });
  const o = h.alloc(8);
  assert.equal(h.sys("fd_prestat_get", 4, o), E.SUCCESS);
  const len = h.u32(o + 4);
  const p = h.alloc(len);
  assert.equal(h.sys("fd_prestat_dir_name", 4, p, len), E.SUCCESS);
  assert.equal(decoder.decode(h.proc.bytes(p, len).slice()), "/data");
  assert.equal(h.sys("fd_prestat_get", 5, o), E.BADF);
  const { fd } = await h.open("/data", { oflags: O.DIRECTORY });
  assert.equal(h.sys("fd_prestat_get", fd, o), E.BADF);
});

// ---- Lazy files ------------------------------------------------------------------

test("a lazy file loads when first opened, once, and stat does not load it", async () => {
  const h = setup();
  let loads = 0;
  h.kernel.fs.root.entries.set("lazy", File.lazy(async () => (loads++, encoder.encode("abc")), 3));
  assert.equal(h.stat("/lazy").size, 3);
  assert.equal(loads, 0);
  const [a, b] = await Promise.all([h.open("/lazy"), h.open("/lazy")]);
  assert.equal(loads, 1);
  assert.equal((await h.read(a.fd)).text, "abc");
  assert.equal((await h.read(b.fd)).text, "abc");
});

test("a lazy file whose load fails gives EIO, and loads on the next open", async () => {
  const h = setup();
  let fail = true;
  h.kernel.fs.root.entries.set("lazy", File.lazy(async () => {
    if (fail) throw new Error("offline");
    return encoder.encode("ok");
  }, 2));
  let stderr = "";
  h.proc.onStderr = (b) => (stderr += decoder.decode(b));
  assert.equal((await h.open("/lazy")).errno, E.IO);
  assert.match(stderr, /offline/);
  fail = false;
  const { errno, fd } = await h.open("/lazy");
  assert.equal(errno, E.SUCCESS);
  assert.equal((await h.read(fd)).text, "ok");
});

test("an evictable file is dropped at its last close, and kept once written", async () => {
  const h = setup();
  let loads = 0;
  const file = File.lazy(async () => (loads++, encoder.encode("abc")), 3, { evictable: true });
  h.kernel.fs.root.entries.set("lazy", file);
  const a = (await h.open("/lazy")).fd, b = (await h.open("/lazy")).fd;
  h.close(a);
  assert.equal(file.pending, false, "still open through b");
  h.close(b);
  assert.equal(file.pending, true);
  const c = (await h.open("/lazy")).fd;
  assert.equal(loads, 2);
  h.write(c, "X", 0);
  h.close(c);
  assert.equal(file.pending, false);
  assert.equal((await h.read((await h.open("/lazy")).fd)).text, "Xbc");
});

// ---- Arguments, environment, stdin, clocks, randomness -----------------------------

test("arguments and environment, in UTF-8", () => {
  const h = setup({ args: ["prog", "héllo", ""], env: { NAME: "wörld" } });
  const count = h.alloc(4), size = h.alloc(4);
  assert.equal(h.sys("args_sizes_get", count, size), E.SUCCESS);
  assert.equal(h.u32(count), 3);
  assert.equal(h.u32(size), encoder.encode("prog\0héllo\0\0").length);
  const ptrs = h.alloc(12), buf = h.alloc(h.u32(size));
  assert.equal(h.sys("args_get", ptrs, buf), E.SUCCESS);
  assert.equal(decoder.decode(h.proc.bytes(h.u32(ptrs + 4), 6).slice()), "héllo");
  assert.equal(h.sys("environ_sizes_get", count, size), E.SUCCESS);
  const eptrs = h.alloc(4), ebuf = h.alloc(h.u32(size));
  h.sys("environ_get", eptrs, ebuf);
  assert.equal(decoder.decode(h.proc.bytes(ebuf, h.u32(size)).slice()), "NAME=wörld\0");
});

test("stdin from bytes: read to the end", async () => {
  const h = setup({ stdin: encoder.encode("in") });
  assert.equal((await h.read(0)).text, "in");
  assert.equal((await h.read(0)).text, "");
});

test("a piped stdin: a read waits for input, and gets end of file once closed", async () => {
  const h = setup({ stdin: "pipe" });
  let done = false;
  const r = h.read(0).then((x) => ((done = true), x));
  await new Promise((s) => setTimeout(s, 20));
  assert.equal(done, false);
  h.proc.writeStdin(encoder.encode("line\n"));
  assert.equal((await r).text, "line\n");
  const end = h.read(0);
  h.proc.closeStdin();
  assert.equal((await end).text, "");
});

test("poll_oneoff: a relative clock sleeps, an absolute time in the past does not", async () => {
  const h = setup();
  const sub = h.alloc(48), ev = h.alloc(32), n = h.alloc(4);
  const v = h.proc.view();
  const clock = (timeout, abs) => {
    v.setBigUint64(sub, 7n, true); // userdata
    v.setUint8(sub + 8, 0); // clock
    v.setUint32(sub + 16, 1, true); // monotonic
    v.setBigUint64(sub + 24, timeout, true);
    v.setUint16(sub + 40, abs ? 1 : 0, true);
  };
  clock(30_000_000n, false);
  let t = performance.now();
  assert.equal(await h.sys("poll_oneoff", sub, ev, 1, n), E.SUCCESS);
  assert.ok(performance.now() - t >= 25, "slept");
  assert.equal(h.u32(n), 1);
  assert.equal(h.u64(ev), 7n);
  clock(1n, true);
  t = performance.now();
  assert.equal(await h.sys("poll_oneoff", sub, ev, 1, n), E.SUCCESS);
  assert.ok(performance.now() - t < 10, "did not sleep");
});

test("clock_time_get: realtime is the date, monotonic does not go back", () => {
  const h = setup();
  const o = h.alloc(8);
  h.sys("clock_time_get", 0, 1000, o);
  assert.ok(Math.abs(Number(h.u64(o) / 1_000_000n) - Date.now()) < 1000);
  h.sys("clock_time_get", 1, 1000, o);
  const a = h.u64(o);
  h.sys("clock_time_get", 1, 1000, o);
  assert.ok(h.u64(o) >= a);
});

test("random_get fills more than one crypto.getRandomValues call allows", () => {
  const h = setup();
  const len = 200_000, p = h.alloc(len);
  assert.equal(h.sys("random_get", p, len), E.SUCCESS);
  const tail = h.proc.bytes(p + len - 1024, 1024);
  assert.ok(tail.some((b) => b !== 0));
});

test("unimplemented calls say so", () => {
  const h = setup();
  assert.equal(h.sys("sock_accept", 0, 0, 0), E.NOSYS);
  assert.equal(h.sys("proc_raise", 6), E.NOSYS);
});
