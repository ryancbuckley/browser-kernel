// An in-memory filesystem: directories, regular files and nothing else.
//
// Paths are absolute and '/'-separated. The kernel resolves WASI paths
// (relative to a preopened directory) to absolute ones before calling in.

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
    this.data = data; // capacity may exceed size
    this.size = data.length;
    this.mtime = BigInt(Date.now()) * 1000000n;
    /** Produces the contents, until `load`. @type {(() => Promise<Uint8Array>) | null} */
    this.loader = null;
    /** For an evictable file: produces the contents again after `evict`. @type {(() => Promise<Uint8Array>) | null} */
    this.reloader = null;
    /** The load under way. @type {Promise<void> | null} */
    this.loading = null;
    /** How many descriptors have it open. */
    this.opens = 0;
  }

  /** A file of `size` bytes whose contents `load()` (returning a promise of a
   *  Uint8Array) produces when the file is first opened, e.g. by fetching it.
   *  Until then only its size is known.
   *
   *  An `evictable` file drops its contents when no descriptor has it open
   *  (and loads them again with `load` when next opened), until it is
   *  written: for large read-only files that programs read once, which
   *  would otherwise be held both here and in the program's memory.
   *  @param {() => Promise<Uint8Array>} load @param {number} size */
  static lazy(load, size, { evictable = false } = {}) {
    const f = new File();
    f.loader = load;
    f.size = size;
    if (evictable) f.reloader = load;
    return f;
  }

  /** A file of `size` bytes whose contents stay compressed (raw deflate)
   *  until it is first opened.
   *  @param {Uint8Array<ArrayBuffer>} packed @param {number} size */
  static compressed(packed, size) {
    return File.lazy(() => inflate(packed), size);
  }

  /** Whether the contents have yet to be loaded. */
  get pending() {
    return this.loader !== null;
  }

  /** Load the contents, if not yet loaded (the kernel does so when the file
   *  is opened). Resolves when they are ready; if loading fails, the file
   *  stays unloaded, so a later open tries again.
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

  /** Drop an evictable file's contents if no descriptor has it open. */
  evict() {
    if (this.reloader && this.opens === 0 && !this.loader) {
      this.data = new Uint8Array(0);
      this.loader = this.reloader;
    }
  }

  /** `load`, under its name from when only compressed files were lazy. */
  unpack() {
    return this.load();
  }

  /** The contents, without spare capacity. */
  bytes() {
    if (this.loader) throw new Error("the file has not been loaded");
    return this.data.subarray(0, this.size);
  }

  /** @param {number} size */
  resize(size) {
    if (size !== this.size) this.reloader = null; // the contents are now its own
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

/** A directory's entries: a Map that numbers each name as it is added. The numbers are the
 *  positions `fd_readdir` resumes from, which stay put when other names are removed (as programs
 *  do while reading a directory to delete it), unlike indices. They follow the Map's order, since
 *  setting a name it has keeps both its place and its number. */
/** @extends {Map<string, File | Dir>} */
class Entries extends Map {
  /** @type {Map<string, number>} */
  seqs = new Map();
  lastSeq = 0;

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

  /** The entries numbered above `seq`, with their numbers, in order.
   *  @param {number} seq @returns {Generator<[string, File | Dir, number]>} */
  *after(seq) {
    for (const [name, node] of this) {
      const n = /** @type {number} */ (this.seqs.get(name));
      if (n > seq) yield [name, node, n];
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

/** Split an absolute path into components, resolving `.` and `..`.
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

  /** The node at `path`, or null.
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

  /** The directory that would contain `path` and the last component, or
   *  null if that directory does not exist.
   *  @param {string} path @returns {[Dir, string] | null} */
  parent(path) {
    const parts = components(path);
    const name = parts.pop();
    if (!name) return null;
    const dir = this.lookup("/" + parts.join("/"));
    return dir instanceof Dir ? [dir, name] : null;
  }

  /** The directory at `path`, made with any directories above it that are missing.
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
