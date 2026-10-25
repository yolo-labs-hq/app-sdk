/**
 * The portable key/value storage subset (permission assessment P1.7) for an
 * app's SERVER: the same calls whether it runs on the `worker` placement (tile
 * data, one store per app and user, the same in every workspace) or on
 * `container` / the first-party workspace pod (the tile's own `/data` directory,
 * one per tile instance).
 *
 * The scopes differ, and the difference is the app's to handle: check
 * `capabilities().storage.backend.scope` (`app-user` or `instance`) before
 * assuming two tiles see the same data. `kv.scope` says which this client uses.
 *
 * Portable:
 *  - keys of `/`-separated segments, each 1-128 of `A-Z a-z 0-9 . _ ~ @ + = , -`
 *    (no empty, `.` or `..` segment, none starting `.~tilekv-`), at most 512
 *    characters ({@link isPortableKey});
 *  - a key is a value or a "folder" of other keys, never both: `notes` and
 *    `notes/1` can't both be set (the worker allows it, a directory can't);
 *  - byte or string values (strings are UTF-8);
 *  - `list` by prefix, in key order, paged with `after`;
 *  - `usage` in bytes and keys.
 *
 * Not portable (directory only): append, rename, partial reads and writes,
 * SQLite or other files written in place, values over the worker's per-value cap
 * (10 MiB by default), and content types (the worker keeps one per value, a
 * directory doesn't). An app that needs them stays on a `/data` placement.
 */

export const TILE_DATA_URL = 'http://tile-data.internal/v1';

const MAX_KEY_LENGTH = 512;
const KEY_SEGMENT = /^[A-Za-z0-9._~@+=,-]{1,128}$/;
/** The directory store's temporary files; reserved on every backend. */
const TMP_PREFIX = '.~tilekv-';

/** Is `key` one every backend stores under the same name? */
export function isPortableKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  return key.split('/').every((s) => KEY_SEGMENT.test(s) && s !== '.' && s !== '..' && !s.startsWith(TMP_PREFIX));
}

/**
 * `invalid_key` / `invalid_value`, `value_too_large`, `quota_bytes` / `quota_keys`,
 * `closed` (the store was deleted with the account), `unconfigured` (no store here),
 * `unavailable` (no answer).
 */
export type TileKvErrorCode =
  | 'invalid_key' | 'invalid_value' | 'value_too_large' | 'quota_bytes' | 'quota_keys'
  | 'closed' | 'unconfigured' | 'unavailable' | 'precondition_failed' | 'unsupported'
  /** A provider call under platform attenuation reached outside its attached items (MCP provider A-4). */
  | 'forbidden' | (string & {});

export class TileKvError extends Error {
  constructor(readonly code: TileKvErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'TileKvError';
  }
}

export interface TileKvUsage {
  bytes: number;
  keys: number;
  /** The live ceiling, when the backend has one (worker tile data). */
  quota?: { maxBytes: number; maxKeys: number; maxValueBytes: number };
}

export interface TileKvListOptions {
  prefix?: string;
  /** Return keys after this one (the previous page's `next`). */
  after?: string;
  /** At most this many keys (default 100, at most 1000). */
  limit?: number;
}

export interface TileKv {
  /** `app-user`: worker tile data; `instance`: this tile's `/data`. */
  readonly scope: 'app-user' | 'instance';
  get(key: string): Promise<Uint8Array | null>;
  getText(key: string): Promise<string | null>;
  /**
   * The value and its version (bumped by every write), for a conditional write. Worker tile data only;
   * a directory store throws `unsupported`.
   */
  getWithVersion(key: string): Promise<{ value: Uint8Array; version: number } | null>;
  /**
   * `ifVersion` (worker tile data only): write only if the key is at that version now (0: only if it
   * doesn't exist), atomically; else `precondition_failed`. A directory store throws `unsupported`.
   */
  put(key: string, value: string | Uint8Array, options?: { ifVersion?: number }): Promise<void>;
  /** True when a value was there. */
  delete(key: string): Promise<boolean>;
  list(options?: TileKvListOptions): Promise<{ keys: string[]; next?: string }>;
  usage(): Promise<TileKvUsage>;
}

function requireKey(key: unknown): asserts key is string {
  if (!isPortableKey(key)) throw new TileKvError('invalid_key', 'key segments are 1-128 of A-Z a-z 0-9 . _ ~ @ + = , - (no empty, . or .. segment, none starting .~tilekv-), at most 512 characters');
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) throw new TileKvError('invalid_value', 'limit must be a positive integer');
  return Math.min(limit, 1000);
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new TileKvError('invalid_value', 'value must be a string or a Uint8Array');
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

// ── worker: tile data over the gateway's outbound path ──────────────────────

export interface WorkerKvOptions {
  /** Defaults to the global `fetch` (the worker's own, which the gateway answers for this host). */
  fetch?: typeof fetch;
}

/** Tile data on the worker placement (`http://tile-data.internal/v1`): one store per app and user. */
export function createWorkerKv(options: WorkerKvOptions = {}): TileKv {
  const doFetch = options.fetch ?? globalThis.fetch;
  async function send(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(`${TILE_DATA_URL}${path}`, init);
    } catch (err) {
      throw new TileKvError('unavailable', `tile data unreachable: ${(err as Error)?.message ?? String(err)}`);
    }
    if (res.ok || res.status === 404) return res;
    let body: { error?: string; message?: string } = {};
    try { body = await res.json() as typeof body; } catch { /* not JSON */ }
    throw new TileKvError(body.error ?? 'unavailable', body.message ?? `tile data answered HTTP ${res.status}`, res.status);
  }
  const kv: TileKv = {
    scope: 'app-user',
    async get(key) {
      requireKey(key);
      const res = await send(`/keys/${encodeKey(key)}`);
      return res.status === 404 ? null : new Uint8Array(await res.arrayBuffer());
    },
    async getText(key) {
      const bytes = await kv.get(key);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async getWithVersion(key) {
      requireKey(key);
      const res = await send(`/keys/${encodeKey(key)}`);
      if (res.status === 404) return null;
      const version = Number(res.headers.get('x-tile-data-version') ?? '1');
      return { value: new Uint8Array(await res.arrayBuffer()), version: Number.isSafeInteger(version) ? version : 1 };
    },
    async put(key, value, options = {}) {
      requireKey(key);
      const body = bytesOf(value);
      if (options.ifVersion !== undefined && (!Number.isSafeInteger(options.ifVersion) || options.ifVersion < 0)) throw new TileKvError('invalid_value', 'ifVersion must be a non-negative integer');
      const res = await send(`/keys/${encodeKey(key)}`, {
        method: 'PUT',
        headers: {
          'content-type': typeof value === 'string' ? 'text/plain' : 'application/octet-stream',
          ...(options.ifVersion !== undefined ? { 'if-version': String(options.ifVersion) } : {}),
        },
        body: body as unknown as BodyInit,
      });
      if (res.status === 404) throw new TileKvError('unconfigured', 'tile data is not available here', 404);
    },
    async delete(key) {
      requireKey(key);
      const res = await send(`/keys/${encodeKey(key)}`, { method: 'DELETE' });
      return res.status !== 404;
    },
    async list(opts = {}) {
      if (opts.prefix !== undefined && typeof opts.prefix !== 'string') throw new TileKvError('invalid_value', 'prefix must be a string');
      const q = new URLSearchParams({ limit: String(listLimit(opts.limit)) });
      if (opts.prefix) q.set('prefix', opts.prefix);
      if (opts.after) q.set('after', opts.after);
      const res = await send(`/keys?${q}`);
      if (res.status === 404) throw new TileKvError('unconfigured', 'tile data is not available here', 404);
      const page = await res.json() as { items: Array<{ key: string }>; next?: string };
      return { keys: page.items.map((i) => i.key), ...(page.next ? { next: page.next } : {}) };
    },
    async usage() {
      const res = await send('/usage');
      if (res.status === 404) throw new TileKvError('unconfigured', 'tile data is not available here', 404);
      return await res.json() as TileKvUsage;
    },
  };
  return kv;
}

// ── directory: a tile's /data (container, first-party workspace pod) ────────

/** The `node:fs/promises` calls the directory store needs (pass `await import('node:fs/promises')`). */
export interface TileKvFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  /** Removes an empty directory (fails on a non-empty one). */
  rmdir(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  stat(path: string): Promise<{ size: number }>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
}

export interface DirectoryKvOptions {
  /** The directory the store keeps its files in, e.g. `/data/kv`. Each key is a file under it. */
  dir: string;
  fs: TileKvFs;
}

const errCode = (err: unknown) => (err as { code?: string })?.code;
const isMissing = (err: unknown) => errCode(err) === 'ENOENT';
/** A key that is also another key's "folder" (`a` beside `a/b`). */
const isShapeClash = (err: unknown) => ['ENOTDIR', 'EISDIR', 'EEXIST'].includes(errCode(err) ?? '');
const shapeClash = (key: string) => new TileKvError('invalid_key', `${key} is both a value and a folder of other keys, which isn't portable`);
const utf8Length = (s: string) => new TextEncoder().encode(s).byteLength;

/**
 * The same key/value calls on a directory: the tile's own `/data` on container and the first-party
 * workspace pod (one per tile instance). A put writes a temporary file and renames it into place.
 * A key whose path crosses a symbolic link under `dir` is refused (`invalid_key`), and `list`
 * doesn't follow links, so a link left in `/data` (by a migration, an older version) doesn't take
 * the store elsewhere. It is a guard against mistakes, not a security boundary: the check runs
 * before each operation, and code that can swap a link in meanwhile already has the store's own
 * filesystem access. Usage counts value bytes plus key bytes, as the worker does.
 */
export function createDirectoryKv(options: DirectoryKvOptions): TileKv {
  const root = options.dir.replace(/\/+$/, '');
  const { fs } = options;
  const pathOf = (key: string) => `${root}/${key}`;

  /** Refuses a key whose path, below `dir`, crosses a symbolic link (checked component by component). */
  async function refuseLinks(key: string): Promise<void> {
    let path = root;
    for (const segment of key.split('/')) {
      path = `${path}/${segment}`;
      let st;
      try {
        st = await fs.lstat(path);
      } catch (err) {
        if (isMissing(err) || isShapeClash(err)) return;
        throw err;
      }
      if (st.isSymbolicLink()) throw new TileKvError('invalid_key', `${key} crosses a symbolic link, which the store doesn't follow`);
    }
  }

  /** After a delete: drop the folders it emptied, so their names can hold values again. */
  async function pruneEmptyParents(key: string): Promise<void> {
    const segments = key.split('/');
    for (let n = segments.length - 1; n > 0; n--) {
      try {
        await fs.rmdir(`${root}/${segments.slice(0, n).join('/')}`);
      } catch {
        return;
      }
    }
  }

  /** Every key under `dir` (a `/`-separated path relative to root), sorted. */
  async function walk(dir: string, rel: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith(TMP_PREFIX)) continue;
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(`${dir}/${e.name}`, key, out);
      else if (e.isFile() && isPortableKey(key)) out.push(key);
    }
  }
  async function allKeys(): Promise<string[]> {
    const out: string[] = [];
    await walk(root, '', out);
    return out.sort();
  }

  const kv: TileKv = {
    scope: 'instance',
    async get(key) {
      requireKey(key);
      await refuseLinks(key);
      try {
        return new Uint8Array(await fs.readFile(pathOf(key)));
      } catch (err) {
        if (isMissing(err) || isShapeClash(err)) return null;
        throw err;
      }
    },
    async getText(key) {
      const bytes = await kv.get(key);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async getWithVersion() {
      throw new TileKvError('unsupported', 'versions are only kept by worker tile data');
    },
    async put(key, value, options = {}) {
      if (options.ifVersion !== undefined) throw new TileKvError('unsupported', 'conditional writes are only available on worker tile data');
      requireKey(key);
      const body = bytesOf(value);
      await refuseLinks(key);
      const path = pathOf(key);
      const dir = path.slice(0, path.lastIndexOf('/'));
      const tmp = `${dir}/${TMP_PREFIX}${Math.random().toString(36).slice(2)}`;
      // A concurrent delete may prune the folder between mkdir and the write: make it again.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (err) {
          throw isShapeClash(err) ? shapeClash(key) : err;
        }
        try {
          await fs.writeFile(tmp, body);
          break;
        } catch (err) {
          if (!isMissing(err) || attempt >= 2) throw err;
        }
      }
      try {
        await fs.rename(tmp, path);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw isShapeClash(err) ? shapeClash(key) : err;
      }
    },
    async delete(key) {
      requireKey(key);
      await refuseLinks(key);
      // Only a file is a value: a "folder" of other keys isn't deleted by its name.
      try {
        await fs.readFile(pathOf(key));
      } catch (err) {
        if (isMissing(err) || isShapeClash(err)) return false;
        throw err;
      }
      await fs.rm(pathOf(key), { force: true });
      await pruneEmptyParents(key);
      return true;
    },
    async list(opts = {}) {
      const limit = listLimit(opts.limit);
      const prefix = opts.prefix ?? '';
      const keys = (await allKeys()).filter((k) => k.startsWith(prefix) && (opts.after === undefined || k > opts.after));
      const page = keys.slice(0, limit);
      return { keys: page, ...(keys.length > limit ? { next: page[page.length - 1] } : {}) };
    },
    async usage() {
      const keys = await allKeys();
      let bytes = 0;
      let count = 0;
      for (const k of keys) {
        try {
          bytes += (await fs.stat(pathOf(k))).size + utf8Length(k);
          count++;
        } catch (err) {
          // Deleted while this ran: it no longer counts.
          if (!isMissing(err)) throw err;
        }
      }
      return { bytes, keys: count };
    },
  };
  return kv;
}
