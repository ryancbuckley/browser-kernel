// In-memory filesystem supporting directories and regular files.
//
// All paths passed to MemFS are absolute and '/'-separated. The kernel resolves
// WASI paths relative to preopened directories before calling into MemFS.

const encoder = new TextEncoder();
let nextIno = 1n;

/** @param {Uint8Array<ArrayBuffer>} packed */
async function inflate(packed) {
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class File {
  /** @param {Uint8Array} [data] */
  constructor(data = new Uint8Array(0)) {
    this.ino = nextIno++;
    this.data = data; // buffer capacity may exceed this.size
    this.size = data.length;
    this.mtime = BigInt(Date.now()) * 1000000n;
    /** Loader function if the file's contents have not been loaded yet. @type {(() => Promise<Uint8Array>) | null} */
    this.loader = null;
    /** Loader saved for re-loading after eviction. @type {(() => Promise<Uint8Array>) | null} */
    this.reloader = null;
    /** In-flight load promise, if any. @type {Promise<void> | null} */
    this.loading = null;
    /** Number of open file descriptors referencing this file. */
    this.opens = 0;
  }

  /** Create a lazy file of `size` bytes whose contents are loaded by calling `load()`
   *  when the file is first opened.
   *
   *  If `evictable` is true, the file's contents are discarded when all open descriptors
   *  to it are closed, and reloaded if opened again. Modifying the file disables eviction.
   *  This is for large read-only files that programs read once, which would otherwise be held
   *  both here and in the program's memory.
   *  @param {() => Promise<Uint8Array>} load @param {number} size */
  static lazy(load, size, { evictable = false } = {}) {
    const f = new File();
    f.loader = load;
    f.size = size;
    if (evictable) f.reloader = load;
    return f;
  }

  /** Create a lazy file of `size` uncompressed bytes from raw deflate data.
   *  @param {Uint8Array<ArrayBuffer>} packed @param {number} size */
  static compressed(packed, size) {
    return File.lazy(() => inflate(packed), size);
  }

  /** True if the file's contents have not been loaded yet. */
  get pending() {
    return this.loader !== null;
  }

  /** Load the file's contents if not already loaded. If loading fails, the file
   *  remains unloaded so a subsequent open can retry.
   *  @returns {Promise<void>} */
  load() {
    if (!this.loader) return Promise.resolve();
    this.loading ??= this.loader().then(
      (data) => {
        this.data = data;
        this.size = data.length;
        this.loader = null;
        this.loading = null;
      },
      (/** @type {unknown} */ e) => {
        this.loading = null;
        throw e;
      },
    );
    return this.loading;
  }

  /** Discard an evictable file's contents if no descriptors have it open. */
  evict() {
    if (this.reloader && this.opens === 0 && !this.loader) {
      this.data = new Uint8Array(0);
      this.loader = this.reloader;
    }
  }

  /** Alias for `load()`. */
  unpack() {
    return this.load();
  }

  /** Return the file's contents up to `this.size`. */
  bytes() {
    if (this.loader) throw new Error("file has not been loaded");
    return this.data.subarray(0, this.size);
  }

  /** @param {number} size */
  resize(size) {
    if (size !== this.size) this.reloader = null;
    if (size > this.data.length) {
      const grown = new Uint8Array(Math.max(size, this.data.length * 2, 64));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    } else if (size > this.size) {
      this.data.fill(0, this.size, size);
    }
    this.size = size;
    this.mtime = BigInt(Date.now()) * 1000000n;
  }

  /** @param {number} at @param {Uint8Array} src */
  write(at, src) {
    this.reloader = null;
    if (at + src.length > this.size) this.resize(at + src.length);
    this.data.set(src, at);
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

/** Directory entry map that assigns each inserted entry a monotonically increasing
 *  cookie (starting at 3, since 1 and 2 are reserved for "." and "..").
 *  Using stable cookies instead of array indices ensures `fd_readdir` does not skip
 *  entries when files are unlinked during iteration (e.g. `rm -r`). */
/** @extends {Map<string, File | Dir>} */
class Entries extends Map {
  /** @type {Map<string, number>} */
  seqs = new Map();
  lastSeq = 2;

  /** @param {string} name @param {File | Dir} node */
  set(name, node) {
    if (!this.has(name)) this.seqs.set(name, ++this.lastSeq);
    return super.set(name, node);
  }

  /** @param {string} name */
  delete(name) {
    this.seqs.delete(name);
    return super.delete(name);
  }

  clear() {
    this.seqs.clear();
    super.clear();
  }

  /** Yield `[name, node, cookie]` for all entries with a cookie greater than `cookie`.
   *  @param {number} cookie @returns {Generator<[string, File | Dir, number]>} */
  *after(cookie) {
    for (const [name, node] of this) {
      const seq = /** @type {number} */ (this.seqs.get(name));
      if (seq > cookie) yield [name, node, seq];
    }
  }
}

export class Dir {
  constructor() {
    this.ino = nextIno++;
    this.entries = new Entries();
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

/** Split a path into components, resolving `.` and `..`.
 *  @param {string} path */
export function components(path) {
  /** @type {string[]} */
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** @param {string} base @param {string} rel */
export function join(base, rel) {
  if (rel.startsWith("/")) return rel;
  return base.endsWith("/") ? base + rel : base + "/" + rel;
}

export class MemFS {
  constructor() {
    this.root = new Dir();
  }

  /** Return the node at `path`, or null if it does not exist.
   *  @param {string} path @returns {File | Dir | null} */
  lookup(path) {
    /** @type {File | Dir | undefined} */
    let node = this.root;
    for (const name of components(path)) {
      if (!(node instanceof Dir)) return null;
      node = node.entries.get(name);
      if (!node) return null;
    }
    return node;
  }

  /** Return `[parentDir, basename]` for `path`, or null if `path` is `/` or
   *  its parent directory does not exist.
   *  @param {string} path @returns {[Dir, string] | null} */
  parent(path) {
    const parts = components(path);
    const name = parts.pop();
    if (!name) return null;
    const dir = this.lookup("/" + parts.join("/"));
    return dir instanceof Dir ? [dir, name] : null;
  }

  /** Return the directory at `path`, creating any missing parent directories.
   *  @param {string} path */
  mkdirp(path) {
    let node = this.root;
    for (const name of components(path)) {
      let next = node.entries.get(name);
      if (!next) {
        next = new Dir();
        node.entries.set(name, next);
      }
      if (!(next instanceof Dir)) throw new Error(`${path}: ${name} is not a directory`);
      node = next;
    }
    return node;
  }

  /** @param {string} path @param {Uint8Array | string} bytes */
  writeFile(path, bytes) {
    const parts = components(path);
    const name = parts.pop();
    if (!name) throw new Error(`${path}: not a file path`);
    const dir = this.mkdirp("/" + parts.join("/"));
    const file = new File(bytes instanceof Uint8Array ? bytes : encoder.encode(bytes));
    dir.entries.set(name, file);
    return file;
  }

  /** @param {string} path */
  readFile(path) {
    const node = this.lookup(path);
    return node instanceof File ? node.bytes() : null;
  }

  /** @param {string} path */
  remove(path) {
    const p = this.parent(path);
    if (p) p[0].entries.delete(p[1]);
  }
}
