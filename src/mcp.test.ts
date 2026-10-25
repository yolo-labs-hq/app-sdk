import { describe, expect, it, vi } from 'vitest';
import { createMcpClient, McpRequestError } from './mcp.js';
import type { TileAppCallResult } from './client.js';

const POOLS = {
  discovery: { scopes: ['studio.ai_access_read'], remintOnForbidden: false },
  kanban: { scopes: ['studio.list_tiles', 'studio.kanban_get_board'] },
};

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

/** A fake host. `mcpCall` answers like a host with TILEAPP_MCP_CALL on unless `callOff`. */
function host(opts: { callOff?: boolean; mintReply?: () => TileAppCallResult } = {}) {
  let clock = 1_000_000;
  const mcpCall = vi.fn(async (args: { path: string }): Promise<TileAppCallResult<any>> => opts.callOff
    ? { ok: false, reason: 'unknown-method', message: 'unknown mcp method: call' }
    : { ok: true, status: 200, payload: { via: 'call', path: args.path } });
  const call = vi.fn(async (_c: string, _m: string, _a?: unknown): Promise<TileAppCallResult> => opts.mintReply?.()
    ?? { ok: true, payload: { token: jwt({ workspaceId: 'ws 1', exp: clock / 1000 + 300 }), expiresAt: new Date(clock + 300_000).toISOString() } });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ via: 'fetch' }), { status: 200 }));
  const client = createMcpClient({ call, mcpCall } as never, { pools: POOLS, transportPolicy: 'legacy-compatible', fetch: fetch as never, now: () => clock });
  return { client, call, mcpCall, fetch, advance: (ms: number) => { clock += ms; } };
}

const mintedScopes = (call: ReturnType<typeof host>['call']) => call.mock.calls.map((c) => (c[2] as { scopes: string[] }).scopes);

describe('createMcpClient on a host with mcp.call', () => {
  it('uses mcp.call with the pool scopes and never mints or fetches', async () => {
    const h = host();
    expect(h.client.transport()).toBe('unknown');
    await expect(h.client.request('kanban', '/kanban/board/get', { body: { tileId: 't' } })).resolves.toEqual({ via: 'call', path: '/kanban/board/get' });
    await h.client.request('discovery', '/ai-access/snapshot');
    await h.client.request('kanban', '/tiles', { method: 'GET' });
    expect(h.mcpCall.mock.calls.map((c) => c[0])).toEqual([
      { scopes: POOLS.kanban.scopes, path: '/kanban/board/get', method: 'POST', body: { tileId: 't' } },
      { scopes: POOLS.discovery.scopes, path: '/ai-access/snapshot', method: 'POST', body: undefined },
      { scopes: POOLS.kanban.scopes, path: '/tiles', method: 'GET', body: undefined },
    ]);
    expect(h.client.transport()).toBe('call');
    expect(h.call).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('turns an MCP route status into an McpRequestError with its body, and does not fall back', async () => {
    const h = host();
    h.mcpCall.mockResolvedValueOnce({ ok: false, reason: 'upstream-status', status: 409, code: 'CONFLICT', message: 'stale', retryAfter: null, payload: { note: { id: 'n' } } });
    const err = await h.client.request('kanban', '/notes/update').catch((e) => e);
    expect(err).toBeInstanceOf(McpRequestError);
    expect(err).toMatchObject({ reason: 'upstream-status', status: 409, code: 'CONFLICT', message: 'stale', payload: { note: { id: 'n' } } });
    expect(h.client.transport()).toBe('call');
    expect(h.call).not.toHaveBeenCalled();
  });

  it('surfaces a permission refusal with the missing permission', async () => {
    const h = host();
    h.mcpCall.mockResolvedValueOnce({ ok: false, reason: 'permission-not-granted', message: 'no', permission: 'mcp:studio.ai_access_read' });
    await expect(h.client.request('discovery', '/ai-access/snapshot')).rejects.toMatchObject({ reason: 'permission-not-granted', permission: 'mcp:studio.ai_access_read' });
    expect(h.call).not.toHaveBeenCalled();
  });

  it('carries the broker limiter\'s retryAfterSeconds as retryAfter', async () => {
    const h = host();
    h.mcpCall.mockResolvedValueOnce({ ok: false, reason: 'rate-limited', message: 'slow down', retryAfterSeconds: 9 } as TileAppCallResult);
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'rate-limited', retryAfter: 9 });
  });

  it('a refusal before the broker leaves the transport unsettled', async () => {
    const h = host();
    h.mcpCall.mockResolvedValueOnce({ ok: false, reason: 'unauthorized', message: 'no session token' });
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(h.client.transport()).toBe('unknown');
  });
});

describe('createMcpClient on a host without mcp.call (mint-token fallback)', () => {
  it('probes once, then mints per pool and fetches the same-origin MCP route with the token', async () => {
    const h = host({ callOff: true });
    await expect(h.client.request('kanban', '/kanban/board/get', { body: { tileId: 't' } })).resolves.toEqual({ via: 'fetch' });
    await h.client.request('kanban', '/tiles', { method: 'GET' });
    await h.client.request('discovery', '/ai-access/snapshot');
    expect(h.mcpCall).toHaveBeenCalledTimes(1);
    expect(h.client.transport()).toBe('mint-token');
    expect(mintedScopes(h.call)).toEqual([POOLS.kanban.scopes, POOLS.discovery.scopes]);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe('/internal/mcp/workspaces/ws%201/kanban/board/get');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ tileId: 't' }), headers: { authorization: expect.stringMatching(/^Bearer h\./), 'content-type': 'application/json' } });
    expect(h.fetch.mock.calls[1]![1]).toMatchObject({ method: 'GET', headers: { authorization: expect.any(String) } });
    expect((h.fetch.mock.calls[1]![1] as RequestInit).body).toBeUndefined();
  });

  it('coalesces concurrent mints and refreshes 30 s before the 300 s expiry, per pool', async () => {
    const h = host({ callOff: true });
    await h.client.request('kanban', '/tiles');
    await Promise.all([h.client.request('discovery', '/a'), h.client.request('discovery', '/b')]);
    expect(h.call).toHaveBeenCalledTimes(2);
    h.advance(269_000);
    await h.client.request('kanban', '/tiles');
    expect(h.call).toHaveBeenCalledTimes(2);
    h.advance(2_000);
    await h.client.request('kanban', '/tiles');
    expect(mintedScopes(h.call)).toEqual([POOLS.kanban.scopes, POOLS.discovery.scopes, POOLS.kanban.scopes]);
  });

  it.each([401, 403])('re-mints once on %i and retries, then surfaces the second refusal', async (status) => {
    const h = host({ callOff: true });
    h.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'Denied', code: 'FORBIDDEN' }), { status }));
    await expect(h.client.request('kanban', '/kanban/board/get')).rejects.toMatchObject({ reason: 'upstream-status', status, code: 'FORBIDDEN', message: 'Denied', payload: { error: 'Denied', code: 'FORBIDDEN' } });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(mintedScopes(h.call)).toEqual([POOLS.kanban.scopes, POOLS.kanban.scopes]);
  });

  it('a 403 on a pool with remintOnForbidden off is final', async () => {
    const h = host({ callOff: true });
    h.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 }));
    await expect(h.client.request('discovery', '/ai-access/snapshot')).rejects.toMatchObject({ status: 403 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('a stale token recovered by the re-mint answers normally', async () => {
    const h = host({ callOff: true });
    h.fetch.mockImplementationOnce(async () => new Response('{}', { status: 401 }));
    await expect(h.client.request('discovery', '/ai-access/snapshot')).resolves.toEqual({ via: 'fetch' });
    expect(h.call).toHaveBeenCalledTimes(2);
  });

  it('passes Retry-After through on a 429 and drops the cached token', async () => {
    const h = host({ callOff: true });
    h.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429, headers: { 'Retry-After': '7' } }));
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 7 });
    await h.client.request('kanban', '/tiles');
    expect(h.call).toHaveBeenCalledTimes(2);
  });

  it('an unreadable 2xx body is invalid-response, but a body read cut off by the timeout stays a timeout', async () => {
    const h = host({ callOff: true });
    h.fetch.mockImplementationOnce(async () => new Response('<html>', { status: 200 }));
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'invalid-response', status: 200 });
    const timedOut = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    h.fetch.mockImplementationOnce(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw timedOut; } }) as never);
    await expect(h.client.request('kanban', '/tiles')).rejects.toBe(timedOut);
  });

  it('a refused mint (permission, or the sunset) is an McpRequestError and nothing is fetched', async () => {
    for (const reply of [
      { ok: false, reason: 'permission-not-granted', message: 'no', permission: 'mcp:studio.list_tiles' },
      { ok: false, reason: 'deprecated', message: 'use mcp.call' },
    ]) {
      const h = host({ callOff: true, mintReply: () => reply });
      await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: reply.reason, message: reply.message });
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it('refuses a token with no workspace binding', async () => {
    const h = host({ callOff: true, mintReply: () => ({ ok: true, payload: { token: jwt({ exp: 2e9 }) } }) });
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reset() drops cached tokens', async () => {
    const h = host({ callOff: true });
    await h.client.request('kanban', '/tiles');
    h.client.reset();
    await h.client.request('kanban', '/tiles');
    expect(h.call).toHaveBeenCalledTimes(2);
  });
});

describe('bounded transport and token validation', () => {
  it('never selects token fallback for status, permission, misleading text or transport failure', async () => {
    for (const reply of [
      { ok: false, reason: 'permission-not-granted', status: 403 },
      { ok: false, reason: 'upstream-status', status: 401 },
      { ok: false, reason: 'upstream-status', status: 429, retryAfter: 7 },
      { ok: false, reason: 'upstream-status', status: 404, message: 'unknown-method' },
      { ok: false, reason: 'timeout', status: 504 },
      { ok: false, reason: 'unknown-capability' },
    ]) {
      const h = host(); h.mcpCall.mockResolvedValueOnce(reply);
      await expect(h.client.request('kanban', '/tiles')).rejects.toBeInstanceOf(McpRequestError);
      expect(h.call).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    }
    const h = host(); h.mcpCall.mockRejectedValueOnce(new Error('transport'));
    await expect(h.client.request('kanban', '/tiles')).rejects.toThrow('transport'); expect(h.call).not.toHaveBeenCalled();
  });
  it('refuses malformed workspace and absent/non-finite/expired JWT expiry before fetch', async () => {
    for (const claims of [{ workspaceId: 'ws' }, { workspaceId: 'ws', exp: 0 }, { workspaceId: 'ws', exp: null }, { workspaceId: ' ', exp: 2e9 }, { workspaceId: 'bad\nws', exp: 2e9 }]) {
      const h = host({ callOff: true, mintReply: () => ({ ok: true, payload: { token: jwt(claims) } }) });
      await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'invalid-token' }); expect(h.fetch).not.toHaveBeenCalled();
    }
  });
  it('rejects malformed route before any host call or token dispatch', async () => {
    const h = host({ callOff: true });
    for (const route of ['https://other.test', '//other.test', '/a/../b', '/a?b=c', '/a%2fb', '/a\\b']) await expect(h.client.request('kanban', route)).rejects.toMatchObject({ reason: 'invalid-args' });
    expect(h.call).not.toHaveBeenCalled(); expect(h.mcpCall).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('one whole request deadline prevents late unknown-method from dispatching mint', async () => {
    vi.useFakeTimers();
    try {
      const h = host(); let resolve: ((value: TileAppCallResult) => void) | undefined;
      h.mcpCall.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const pending = h.client.request('kanban', '/tiles');
      const rejected = expect(pending).rejects.toMatchObject({ reason: 'timeout', status: 504 });
      await vi.advanceTimersByTimeAsync(35_000); await rejected;
      resolve?.({ ok: false, reason: 'unknown-method' }); await Promise.resolve(); await Promise.resolve();
      expect(h.call).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

it('shared first mint deadline can safely refuse later waiters without late fetch', async () => {
  vi.useFakeTimers();
  try {
    const h = host({ callOff: true });
    let resolve: ((value: TileAppCallResult) => void) | undefined;
    h.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = h.client.request('kanban', '/tiles');
    const firstRejected = expect(first).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(10_000);
    const second = h.client.request('kanban', '/tiles');
    const secondRejected = expect(second).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(25_000); await firstRejected;
    resolve?.({ ok: true, payload: { token: jwt({ workspaceId: 'ws', exp: 2e9 }) } });
    await secondRejected;
    expect(h.call).toHaveBeenCalledTimes(1); expect(h.fetch).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('rejects exact dot workspace segments before bearer fetch and keeps a valid normalized namespace', async () => {
  for (const workspaceId of ['.', '..']) {
    const h = host({ callOff: true, mintReply: () => ({ ok: true, payload: { token: jwt({ workspaceId, exp: 2e9 }) } }) });
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(h.fetch).not.toHaveBeenCalled();
  }
  const h = host({ callOff: true }); await h.client.request('kanban', '/tiles');
  const input = String(h.fetch.mock.calls[0]?.[0]);
  expect(new URL(input, 'https://api.test').pathname).toBe('/internal/mcp/workspaces/ws%201/tiles');
});

it('decodes JWT UTF-8 workspace exactly and refuses malformed UTF-8 bytes', async () => {
  const workspaceId = 'ws é';
  const h = host({ callOff: true, mintReply: () => ({ ok: true, payload: { token: jwt({ workspaceId, exp: 2e9 }) } }) });
  await h.client.request('kanban', '/tiles');
  const input = String(h.fetch.mock.calls[0]?.[0]);
  expect(new URL(input, 'https://api.test').pathname).toBe('/internal/mcp/workspaces/ws%20%C3%A9/tiles');
  const bytes = Buffer.concat([Buffer.from('{"workspaceId":"'), Buffer.from([255]), Buffer.from('","exp":2000000000}')]);
  const invalid = host({ callOff: true, mintReply: () => ({ ok: true, payload: { token: `h.${bytes.toString('base64url')}.s` } }) });
  await expect(invalid.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'invalid-token' }); expect(invalid.fetch).not.toHaveBeenCalled();
});

it('refuses overflowing Retry-After hints instead of returning Infinity', async () => {
  const h = host({ callOff: true });
  h.fetch.mockImplementationOnce(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '9'.repeat(400) } }));
  await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ status: 429, retryAfter: null });
});

it('refuses a response body resolving past the absolute deadline before delayed timers fire', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000_000);
    const h = host({ callOff: true });
    h.fetch.mockImplementationOnce(async () => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => {
        // Advance wall time only; do not execute the request timeout callback.
        vi.setSystemTime(1_035_001);
        return { lateSuccess: true };
      },
    } as Response));
    await expect(h.client.request('kanban', '/tiles')).rejects.toMatchObject({ reason: 'timeout', status: 504 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
