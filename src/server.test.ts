import { describe, expect, it, vi } from 'vitest';
import { createTileServerClient } from './server.js';
import { CancelledError, TimeoutError, createTileApp } from './client.js';

const respond = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createTileServerClient (P1.3)', () => {
  it('posts the broker call to <brokerUrl>/tileapps/<appId>/call with no token of its own', async () => {
    const fetch = vi.fn(respond(200, { ok: true, payload: { pong: true } }));
    const c = createTileServerClient({ brokerUrl: 'https://api.example.test/v1/', appId: 'notes', fetch });
    expect(await c.call('noop', 'ping')).toEqual({ ok: true, payload: { pong: true }, reason: undefined, message: undefined });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/tileapps/notes/call');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ capability: 'noop', method: 'ping', args: {} });
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).toEqual(['content-type']);
  });

  it('typed helpers are the same broker calls as on the UI', async () => {
    const fetch = vi.fn(respond(200, { ok: true, payload: {} }));
    const c = createTileServerClient({ brokerUrl: 'https://api.example.test/v1', appId: 'notes', fetch });
    await c.llmInvoke({ messages: [{ role: 'user', content: 'hi' }] } as never);
    await c.mcpCall({ scopes: ['studio.list_tiles'], path: '/tiles', method: 'GET' });
    await c.sendNotification({ destination: 'global', title: 't', message: 'm', eventId: 'e' } as never);
    expect(fetch.mock.calls.map((c2) => { const b = JSON.parse(String((c2[1] as RequestInit).body)); return `${b.capability}.${b.method}`; }))
      .toEqual(['llm.invoke', 'mcp.call', 'notifications.send']);
  });

  it('keeps the broker refusal shape; unshaped failures come back structured', async () => {
    let c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: respond(403, { ok: false, reason: 'permission-not-granted', message: 'no', permission: 'llm.invoke' }) });
    expect(await c.call('llm', 'invoke')).toMatchObject({ ok: false, reason: 'permission-not-granted', permission: 'llm.invoke' });
    c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: respond(502, '<html>bad gateway</html>') });
    expect(await c.call('llm', 'invoke')).toMatchObject({ ok: false, reason: 'upstream-failed', status: 502 });
    c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: async () => { throw new TypeError('fetch failed'); } });
    expect(await c.call('llm', 'invoke')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('capabilities: the contract, or null where the host has no discovery', async () => {
    const contract = { version: 'tileapp-capabilities/v1', placement: 'worker', decisions: [], implicit: [], ambient: { navigation: '', isolation: null, podLoopback: null } };
    expect(await createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: respond(200, { ok: true, payload: contract }) }).capabilities()).toEqual(contract);
    expect(await createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: respond(404, { ok: false, reason: 'unknown-capability', message: '' }) }).capabilities()).toBeNull();
  });

  it('timeout rejects TimeoutError; a cancelled signal rejects CancelledError', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: hang as typeof fetch });
    await expect(c.call('llm', 'invoke', {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
    const ac = new AbortController();
    const p = c.call('llm', 'invoke', {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    await expect(c.call('llm', 'invoke', {}, { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it('refuses a malformed broker URL or app id', () => {
    expect(() => createTileServerClient({ brokerUrl: 'api.test', appId: 'notes' })).toThrow();
    expect(() => createTileServerClient({ brokerUrl: 'https://a.test', appId: '../x' })).toThrow();
  });
});

describe('createTileServerClient — the whole exchange is bounded (P1.3 review)', () => {
  /** Headers arrive at once; the body never finishes until the request is aborted. */
  const stalledBody = (_u: string, init?: RequestInit) => {
    const stream = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
  };

  it('a stalled body times out', async () => {
    const c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: stalledBody as typeof fetch });
    await expect(c.call('llm', 'invoke', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('cancelling while the body is read rejects CancelledError', async () => {
    const c = createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: stalledBody as typeof fetch });
    const ac = new AbortController();
    const p = c.call('llm', 'invoke', {}, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it('carries the backoff hint from the limiter body or the Retry-After header', async () => {
    const limited = async () => new Response(JSON.stringify({ ok: false, reason: 'rate-limited', message: 'slow', retryAfterSeconds: 7 }), { status: 429, headers: { 'retry-after': '7' } });
    expect(await createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: limited }).call('llm', 'invoke')).toMatchObject({ reason: 'rate-limited', retryAfter: 7 });
    const plain = async () => new Response('busy', { status: 429, headers: { 'retry-after': '3' } });
    expect(await createTileServerClient({ brokerUrl: 'https://a.test/v1', appId: 'notes', fetch: plain }).call('llm', 'invoke')).toMatchObject({ reason: 'rate-limited', retryAfter: 3 });
  });
});
