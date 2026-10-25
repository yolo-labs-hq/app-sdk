import { mkdtemp, rm } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDirectoryKv, createWorkerKv, isPortableKey, TILE_DATA_URL, TileKvError, type TileKv } from './storage.js';

/** A stand-in for the gateway's `tile-data.internal` API (worker-data.test.ts covers the real one). */
function fakeTileData() {
  const store = new Map<string, Uint8Array>();
  const versions = new Map<string, number>();
  const requests: string[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    expect(url.origin + '/v1').toBe(TILE_DATA_URL);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/usage') {
      // As the gateway's ledger: value bytes plus key bytes.
      let bytes = 0;
      for (const [k, v] of store) bytes += v.byteLength + new TextEncoder().encode(k).byteLength;
      return Response.json({ bytes, keys: store.size, quota: { maxBytes: 100, maxKeys: 10, maxValueBytes: 50 } });
    }
    if (url.pathname === '/v1/keys') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('after');
      const limit = Number(url.searchParams.get('limit'));
      const keys = [...store.keys()].sort().filter((k) => k.startsWith(prefix) && (!after || k > after));
      const page = keys.slice(0, limit);
      return Response.json({ items: page.map((key) => ({ key, size: store.get(key)!.byteLength })), ...(keys.length > limit ? { next: page.at(-1) } : {}) });
    }
    const key = url.pathname.slice('/v1/keys/'.length).split('/').map(decodeURIComponent).join('/');
    if (method === 'GET') return store.has(key) ? new Response(store.get(key), { headers: { 'x-tile-data-version': String(versions.get(key) ?? 1) } }) : Response.json({ error: 'not_found', message: 'no such key' }, { status: 404 });
    if (method === 'DELETE') return store.delete(key) ? new Response(null, { status: 204 }) : Response.json({ error: 'not_found' }, { status: 404 });
    const body = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
    if (body.byteLength > 50) return Response.json({ error: 'value_too_large', message: 'over 50 bytes' }, { status: 413 });
    const ifv = new Headers(init?.headers).get('if-version');
    if (ifv !== null && Number(ifv) !== (store.has(key) ? versions.get(key) ?? 1 : 0)) return Response.json({ error: 'precondition_failed', message: 'changed' }, { status: 412 });
    store.set(key, body);
    versions.set(key, (versions.get(key) ?? 0) + 1);
    return Response.json({ bytes: 0, keys: store.size });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, store };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tilekv-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('portable keys (P1.7)', () => {
  it('match the gateway key rule, minus the reserved temp prefix', () => {
    expect(isPortableKey('notes/2026/a.md')).toBe(true);
    expect(isPortableKey('a~b@c+d=e,f-g_h.i')).toBe(true);
    for (const bad of ['', '/a', 'a/', 'a//b', '../a', 'a/./b', 'a b', 'a?b', 'x'.repeat(513), 'a/.~tilekv-1', 7]) {
      expect(isPortableKey(bad)).toBe(false);
    }
  });
});

describe.each([
  ['worker tile data', () => createWorkerKv({ fetch: fakeTileData().fetchImpl })],
  ['a /data directory', () => createDirectoryKv({ dir: join(dir, 'kv'), fs: fsp as never })],
] as Array<[string, () => TileKv]>)('the portable subset on %s', (_name, make) => {
  it('puts, gets, lists by prefix in key order with paging, deletes and sizes', async () => {
    const kv = make();
    expect(await kv.get('missing')).toBeNull();
    await kv.put('notes/b', 'two');
    await kv.put('notes/a', new Uint8Array([1, 2, 3]));
    await kv.put('other', 'x');
    expect(await kv.getText('notes/b')).toBe('two');
    expect(Array.from((await kv.get('notes/a'))!)).toEqual([1, 2, 3]);
    await kv.put('notes/b', 'replaced');
    expect(await kv.getText('notes/b')).toBe('replaced');
    const first = await kv.list({ prefix: 'notes/', limit: 1 });
    expect(first).toEqual({ keys: ['notes/a'], next: 'notes/a' });
    expect(await kv.list({ prefix: 'notes/', after: first.next })).toEqual({ keys: ['notes/b'] });
    expect((await kv.list()).keys).toEqual(['notes/a', 'notes/b', 'other']);
    expect(await kv.usage()).toMatchObject({ keys: 3, bytes: (3 + 7) + (8 + 7) + (1 + 5) });
    expect(await kv.delete('other')).toBe(true);
    expect(await kv.delete('other')).toBe(false);
    expect((await kv.list()).keys).toEqual(['notes/a', 'notes/b']);
  });

  it('refuses a non-portable key before touching the store', async () => {
    const kv = make();
    await expect(kv.put('../escape', 'x')).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(kv.get('a//b')).rejects.toBeInstanceOf(TileKvError);
  });
});

describe('worker tile data client', () => {
  it('reports its scope, encodes key segments, and surfaces the gateway error code', async () => {
    const { fetchImpl, requests } = fakeTileData();
    const kv = createWorkerKv({ fetch: fetchImpl });
    expect(kv.scope).toBe('app-user');
    await kv.put('a=1/b,2', 'v');
    expect(requests.at(-1)).toBe('PUT /v1/keys/a%3D1/b%2C2');
    await expect(kv.put('big', 'x'.repeat(51))).rejects.toMatchObject({ code: 'value_too_large', status: 413 });
    expect((await kv.usage()).quota).toEqual({ maxBytes: 100, maxKeys: 10, maxValueBytes: 50 });
  });

  it('a store deleted with the account is `closed`; no answer is `unavailable`', async () => {
    const closed = createWorkerKv({ fetch: (async () => Response.json({ error: 'closed', message: 'deleted with the account' }, { status: 410 })) as unknown as typeof fetch });
    await expect(closed.put('a', 'x')).rejects.toMatchObject({ code: 'closed', status: 410 });
    const down = createWorkerKv({ fetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch });
    await expect(down.get('a')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('directory store', () => {
  it('is instance scoped, and refuses a key that is also a folder of other keys', async () => {
    const kv = createDirectoryKv({ dir, fs: fsp as never });
    expect(kv.scope).toBe('instance');
    await kv.put('notes', 'file');
    await expect(kv.put('notes/1', 'x')).rejects.toMatchObject({ code: 'invalid_key' });
    await kv.put('folder/1', 'x');
    await expect(kv.put('folder', 'x')).rejects.toMatchObject({ code: 'invalid_key' });
    expect(await kv.get('folder')).toBeNull();
    expect(await kv.delete('folder')).toBe(false);
    expect((await kv.list()).keys).toEqual(['folder/1', 'notes']);
  });

  it('a deleted key frees its folder name; a key crossing a symlink is refused', async () => {
    const kv = createDirectoryKv({ dir, fs: fsp as never });
    await kv.put('notes/1', 'x');
    expect(await kv.delete('notes/1')).toBe(true);
    await kv.put('notes', 'now a value');
    expect(await kv.getText('notes')).toBe('now a value');

    const outside = await mkdtemp(join(tmpdir(), 'tilekv-outside-'));
    try {
      await fsp.writeFile(join(outside, 'secret'), 'private');
      await fsp.symlink(outside, join(dir, 'linked'));
      await fsp.symlink(join(outside, 'secret'), join(dir, 'leaf'));
      for (const op of [() => kv.get('linked/secret'), () => kv.put('linked/new', 'x'), () => kv.delete('linked/secret'), () => kv.get('leaf')]) {
        await expect(op()).rejects.toMatchObject({ code: 'invalid_key' });
      }
      expect(await fsp.readdir(outside)).toEqual(['secret']);
      expect((await kv.list()).keys).toEqual(['notes']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('leaves no temporary files behind and ignores non-portable files already in /data', async () => {
    const kv = createDirectoryKv({ dir, fs: fsp as never });
    await fsp.writeFile(join(dir, 'has space.txt'), 'legacy');
    await kv.put('a', 'x');
    expect((await fsp.readdir(dir)).sort()).toEqual(['a', 'has space.txt']);
    expect((await kv.list()).keys).toEqual(['a']);
  });
});

describe('conditional writes (W-3)', () => {
  it('worker tile data: getWithVersion and put with ifVersion (0: a new key); precondition_failed otherwise', async () => {
    const kv = createWorkerKv({ fetch: fakeTileData().fetchImpl });
    await kv.put('n', 'one', { ifVersion: 0 });
    await expect(kv.put('n', 'dup', { ifVersion: 0 })).rejects.toMatchObject({ code: 'precondition_failed' });
    const got = await kv.getWithVersion('n');
    expect(got?.version).toBe(1);
    expect(new TextDecoder().decode(got!.value)).toBe('one');
    await kv.put('n', 'two', { ifVersion: 1 });
    await expect(kv.put('n', 'stale', { ifVersion: 1 })).rejects.toMatchObject({ code: 'precondition_failed' });
    expect(await kv.getWithVersion('missing')).toBeNull();
    await expect(kv.put('n', 'x', { ifVersion: -1 })).rejects.toMatchObject({ code: 'invalid_value' });
  });
  it('a directory store refuses them (unsupported) rather than pretending', async () => {
    const kv = createDirectoryKv({ dir: join(dir, 'kv'), fs: fsp as never });
    await expect(kv.put('n', 'x', { ifVersion: 0 })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(kv.getWithVersion('n')).rejects.toMatchObject({ code: 'unsupported' });
  });
});
