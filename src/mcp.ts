/**
 * createMcpClient — call your workspace's MCP routes without holding a token
 * where the host allows it. Each pool request has one35s wall-clock deadline.
 *
 * `mcp.call` is preferred: the broker mints the token, calls the route and
 * hands back only the answer, so no MCP token ever reaches app code. The
 * `mcp.mint-token` path is an explicit legacy-compatible fallback for hosts without `mcp.call`
 * switched on yet (they answer it with `unknown-method`); `mint-token` is being
 * retired and is already refused for marketplace apps where the host has the
 * sunset on.
 *
 * Default: server-held-only. An unknown-method reply refuses without minting.
 * Only explicit transportPolicy: legacy-compatible permits mint-token fallback.
 * Other errors never select fallback.
 *
 * Pools: each pool is one scope set and, on the fallback, one cached token.
 * Keep scope families apart (a kanban scope minted together with a
 * tile-authorizing scope loses its kanban-tile widening) and keep optional
 * scopes out of the pools your app always needs (one ungranted scope fails the
 * whole mint). On the fallback a token is reused until 30 s before it expires,
 * concurrent mints for one pool share a request (and the first request's
 * deadline; a later waiter may safely fail early), and a 401 (expired) or 403
 * (a tile pin minted before the tile existed) re-mints once and retries.
 *
 * Generated/vendored consumers and package publication have separate owners.
 */
import type { TileApp, TileAppCallResult } from './client.js';

/** One scope set. */
export interface McpPool {
  /** The `mcp:` scopes, without the `mcp:` prefix. */
  scopes: readonly string[];
  /**
   * Fallback only: re-mint and retry once on a 403 as well as on a 401. A 403
   * is usually a tile pin minted before the target tile existed. Default true;
   * turn it off for pools whose routes never check tiles.
   */
  remintOnForbidden?: boolean;
}

export interface McpClientOptions<P extends string> {
  pools: Record<P, McpPool>;
  /** Server-held by default. Legacy mode explicitly permits delegated bearer
   * tokens in app memory and is only for migration of older trusted hosts. */
  transportPolicy?: 'server-held-only' | 'legacy-compatible';
  /** Fallback only. Defaults to same-origin `fetch`; third-party iframes need
   * a trusted adapter that routes this fixed relative workspace URL correctly. */
  fetch?: typeof fetch;
  /** Fallback only, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface McpRequestInit {
  /** Defaults to `POST`. */
  method?: 'POST' | 'GET';
  /** JSON body for a `POST`. */
  body?: unknown;
}

/** `unknown` until the first request has answered. */
export type McpTransport = 'unknown' | 'call' | 'mint-token';

/**
 * A refused or failed MCP request. `reason` is the broker's (`permission-not-granted`,
 * `deprecated`, `timeout`, …) or `upstream-status` when the MCP route answered
 * non-2xx, with its `status`, `code`, `retryAfter` and JSON error body in `payload`.
 */
export class McpRequestError extends Error {
  readonly reason: string;
  readonly status: number | undefined;
  readonly code: string | null | undefined;
  readonly retryAfter: number | null | undefined;
  readonly payload: unknown;
  readonly permission: string | undefined;
  constructor(reason: string, message: string, extra: { status?: number; code?: string | null; retryAfter?: number | null; payload?: unknown; permission?: string } = {}) {
    super(message);
    this.name = 'McpRequestError';
    this.reason = reason;
    this.status = extra.status;
    this.code = extra.code;
    this.retryAfter = extra.retryAfter;
    this.payload = extra.payload;
    this.permission = extra.permission;
  }
}

export interface McpClient<P extends string> {
  /** Call `path` (e.g. `/kanban/board/get`) with `pool`'s scopes; resolves the route's JSON. */
  request<T = unknown>(pool: P, path: string, init?: McpRequestInit): Promise<T>;
  /** Which transport the client settled on. */
  transport(): McpTransport;
  /** Drop cached fallback tokens, e.g. after the user grants more permissions. */
  reset(): void;
}

const TOKEN_MAX_MS = 300_000;
const REFRESH_MARGIN_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 35_000;
function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new McpRequestError('timeout', 'MCP request timed out', { status: 504 });
  return value;
}

interface CachedToken { token: string; workspaceId: string; expiresAt: number }

function refusal(result: TileAppCallResult & { retryAfterSeconds?: unknown }): McpRequestError {
  // The broker limiter (`rate-limited`) names its hint `retryAfterSeconds`; a raw host reply keeps it.
  const retryAfter = result.retryAfter !== undefined ? result.retryAfter
    : typeof result.retryAfterSeconds === 'number' ? result.retryAfterSeconds : undefined;
  return new McpRequestError(result.reason ?? 'unknown', result.message ?? 'MCP request failed', {
    status: result.status, code: result.code, retryAfter, permission: result.permission,
    payload: result.ok ? undefined : result.payload,
  });
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    if (token.length > 16_384 || token.split('.').length !== 3) return {};
    const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : {};
  } catch { return {}; }
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export function createMcpClient<P extends string>(app: Pick<TileApp, 'call' | 'mcpCall'>, options: McpClientOptions<P>): McpClient<P> {
  const transportPolicy = options.transportPolicy ?? 'server-held-only';
  if (transportPolicy !== 'server-held-only' && transportPolicy !== 'legacy-compatible') throw new McpRequestError('invalid-args', 'invalid MCP transport policy');
  const now = options.now ?? (() => Date.now());
  let transport: McpTransport = 'unknown';
  const tokens = new Map<P, CachedToken>();
  const minting = new Map<P, Promise<CachedToken>>();

  function poolOf(name: P): McpPool {
    const pool = options.pools[name];
    if (!pool) throw new McpRequestError('invalid-args', `unknown MCP pool: ${String(name)}`);
    return pool;
  }

  function tokenFor(name: P, force: boolean, deadline: number): Promise<CachedToken> {
    const cached = tokens.get(name);
    if (!force && cached && cached.expiresAt > now() + REFRESH_MARGIN_MS) return Promise.resolve(cached);
    const inFlight = minting.get(name);
    if (inFlight) return inFlight;
    tokens.delete(name);
    const mint = (async () => {
      const at = now();
      const result = await app.call('mcp', 'mint-token', { scopes: [...poolOf(name).scopes] }, { timeoutMs: remaining(deadline) });
      remaining(deadline);
      if (!result.ok) throw refusal(result);
      const payload = (result.payload ?? {}) as { token?: unknown; expiresAt?: unknown };
      const token = typeof payload.token === 'string' ? payload.token : '';
      const claims = decodeClaims(token);
      if (!token || typeof claims.workspaceId !== 'string' || !claims.workspaceId || claims.workspaceId.length > 256
          || claims.workspaceId === '.' || claims.workspaceId === '..'
          || claims.workspaceId.trim() !== claims.workspaceId || /[\u0000-\u001f\u007f]/.test(claims.workspaceId)) {
        throw new McpRequestError('invalid-token', 'minted token has no workspace binding');
      }
      if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= 0) {
        throw new McpRequestError('invalid-token', 'minted token has no valid expiry');
      }
      if ((typeof payload.expiresAt === 'number' && !Number.isFinite(payload.expiresAt))
          || (payload.expiresAt !== undefined && typeof payload.expiresAt !== 'number' && typeof payload.expiresAt !== 'string')) {
        throw new McpRequestError('invalid-token', 'minted token has no valid expiry');
      }
      const stated = typeof payload.expiresAt === 'number' ? payload.expiresAt * (payload.expiresAt < 1e12 ? 1000 : 1)
        : typeof payload.expiresAt === 'string' ? Date.parse(payload.expiresAt) : claims.exp * 1000;
      const exp = claims.exp * 1000;
      const expiresAt = Math.min(stated, exp, at + TOKEN_MAX_MS);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new McpRequestError('invalid-token', 'minted token has expired');
      const fresh = { token, workspaceId: claims.workspaceId, expiresAt };
      tokens.set(name, fresh);
      return fresh;
    })().finally(() => { minting.delete(name); });
    minting.set(name, mint);
    return mint;
  }

  async function viaMintToken<T>(name: P, path: string, init: McpRequestInit, deadline: number): Promise<T> {
    const pool = poolOf(name);
    const doFetch = options.fetch ?? fetch;
    const method = init.method ?? 'POST';
    let credentials = await tokenFor(name, false, deadline);
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`/internal/mcp/workspaces/${encodeURIComponent(credentials.workspaceId)}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining(deadline))),
        headers: { authorization: `Bearer ${credentials.token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      remaining(deadline);
      if (attempt === 0 && (res.status === 401 || (res.status === 403 && pool.remintOnForbidden !== false))) {
        credentials = await tokenFor(name, true, deadline);
        continue;
      }
      // An unreadable body is null; a body read cut off by the timeout stays a timeout.
      const json: unknown = await res.json().catch((err: unknown) => {
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'AbortError' || name === 'TimeoutError') throw err;
        return null;
      });
      remaining(deadline);
      if (!res.ok) {
        tokens.delete(name);
        const body = (json && typeof json === 'object' ? json : {}) as { code?: unknown; error?: unknown };
        throw new McpRequestError('upstream-status', typeof body.error === 'string' ? body.error : `MCP route answered ${res.status}`, {
          status: res.status, code: typeof body.code === 'string' ? body.code : null,
          retryAfter: retryAfterSeconds(res.headers.get('Retry-After')), payload: json,
        });
      }
      if (json === null) throw new McpRequestError('invalid-response', 'the MCP route answer could not be read', { status: res.status });
      return json as T;
    }
  }

  return {
    async request<T = unknown>(name: P, path: string, init: McpRequestInit = {}): Promise<T> {
      const deadline = Date.now() + REQUEST_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = (async () => {
        const pool = poolOf(name);
        if (typeof path !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path) || path.length > 1024
            || !['POST', 'GET'].includes(init.method ?? 'POST')) {
          throw new McpRequestError('invalid-args', 'invalid MCP route');
        }
        if (transport !== 'mint-token') {
          const result = await app.mcpCall<T>({ scopes: [...pool.scopes], path, method: init.method ?? 'POST', body: init.body }, { timeoutMs: remaining(deadline) });
          remaining(deadline);
          if (result.ok || result.reason !== 'unknown-method') {
            // A route status proves the host ran mcp.call. A refusal before the
            // broker (an expired session, a rate limit) proves nothing either way.
            if (result.ok || typeof result.status === 'number') transport = 'call';
            if (result.ok) return result.payload as T;
            throw refusal(result);
          }
          if (transportPolicy !== 'legacy-compatible') throw new McpRequestError('server-held-required', 'This app requires server-held MCP calls; upgrade or enable the host mcp.call transport');
          transport = 'mint-token';
        }
        return viaMintToken<T>(name, path, init, deadline);
      })();
      try {
        return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new McpRequestError('timeout', 'MCP request timed out', { status: 504 })), remaining(deadline));
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
    transport: () => transport,
    reset() { tokens.clear(); },
  };
}
