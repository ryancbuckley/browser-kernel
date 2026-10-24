// An in-memory filesystem: directories, regular files and nothing else.
//
// Paths are absolute and '/'-separated. The kernel resolves WASI paths
// (relative to a preopened directory) to absolute ones before calling in.

let nextIno = 1n;

async function inflate(packed) {
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class File {
  constructor(data = new Uint8Array(0)) {
    this.ino = nextIno++;
    this.data = data; // capacity may exceed size
    this.size = data.length;
    this.mtime = BigInt(Date.now()) * 1000000n;
    /** Compressed contents (raw deflate), until `unpack`. */
    this.packed = null;
  }

  /** A file of `size` bytes whose contents stay compressed until `unpack`. */
  static compressed(packed, size) {
    const f = new File();
    f.packed = packed;
    f.size = size;
    return f;
  }

  /** Decompress the contents, if compressed (the kernel does so when the
   *  file is opened). Resolves when they are ready. */
  unpack() {
    if (!this.packed) return Promise.resolve();
    this.unpacking ??= inflate(this.packed).then((data) => {
      this.data = data;
      this.packed = null;
      this.unpacking = null;
    });
    return this.unpacking;
  }

  /** The contents, without spare capacity. */
  bytes() {
    if (this.packed) throw new Error("the file has not been unpacked");
    return this.data.subarray(0, this.size);
  }

  resize(size) {
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

  write(at, src) {
    if (at + src.length > this.size) this.resize(at + src.length);
    this.data.set(src, at);
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

export class Dir {
  constructor() {
    this.ino = nextIno++;
    /** @type {Map<string, File | Dir>} */
    this.entries = new Map();
    this.mtime = BigInt(Date.now()) * 1000000n;
  }
}

/** Split an absolute path into components, resolving `.` and `..`. */
export function components(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

export function join(base, rel) {
  if (rel.startsWith("/")) return rel;
  return base.endsWith("/") ? base + rel : base + "/" + rel;
}

export class MemFS {
  constructor() {
    this.root = new Dir();
  }

  /** The node at `path`, or null. */
  lookup(path) {
    let node = this.root;
    for (const name of components(path)) {
      if (!(node instanceof Dir)) return null;
      node = node.entries.get(name);
      if (!node) return null;
    }
    return node;
  }

  /** The directory that would contain `path` and the last component, or
   *  null if that directory does not exist. */
  parent(path) {
    const parts = components(path);
    const name = parts.pop();
    let node = this.root;
    for (const p of parts) {
      node = node instanceof Dir ? node.entries.get(p) : null;
      if (!node) return null;
    }
    if (!(node instanceof Dir)) return null;
    return [node, name];
  }

  mkdirp(path) {
    let node = this.root;
    for (const name of components(path)) {
      let next = node.entries.get(name);
      if (!next) {
        next = new Dir();
        node.entries.set(name, next);
      }
      node = next;
    }
    return node;
  }

  writeFile(path, bytes) {
    const parts = components(path);
    const name = parts.pop();
    const dir = this.mkdirp("/" + parts.join("/"));
    const file = new File(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes));
    dir.entries.set(name, file);
    return file;
  }

  readFile(path) {
    const node = this.lookup(path);
    return node instanceof File ? node.bytes() : null;
  }

  remove(path) {
    const p = this.parent(path);
    if (p) p[0].entries.delete(p[1]);
  }
}
