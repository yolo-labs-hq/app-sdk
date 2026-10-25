/**
 * createTileServerClient — the app's SERVER side of the call contract
 * (permission assessment P1.3): the same `call` / `llmInvoke` / `llmDiscover` /
 * `mcpCall` / `sendNotification` / `capabilities` as the UI's {@link createTileApp},
 * for a backend on the `worker` or `container` placement.
 *
 * It holds no token and has no token getter: it posts to
 * `<brokerUrl>/tileapps/<appId>/call`, and the tile gateway injects this
 * instance's server-to-broker token on exactly that route (and refuses every
 * other path on the API host). Identity is the instance's, never the code's.
 *
 * Replies are the broker's structured `{ ok, payload } | { ok: false, reason, message }`.
 * A failure with no structured body (network error, an HTML error page) comes
 * back structured too: `reason: 'unavailable'` (or `rate-limited` / `upstream-failed`
 * by HTTP status). A timeout rejects with {@link TimeoutError}, a cancelled
 * `signal` with {@link CancelledError}, as on the UI.
 *
 * Not for pod backends: a server in the workspace pod has no sanctioned broker
 * channel (its calls would not carry an instance identity), so this client is
 * for edge workers and containers only.
 */
import {
  CancelledError,
  TimeoutError,
  type LlmDiscoverArgs,
  type LlmDiscoverPayload,
  type LlmInvokeArgs,
  type LlmInvokePayload,
  type McpCallArgs,
  type SendNotificationArgs,
  type SendNotificationPayload,
  type TileAppCallOptions,
  type TileAppCallResult,
  type TileAppCapabilities,
  type TileCaller,
} from './client.js';

export interface TileServerClientOptions {
  /**
   * The broker API base, e.g. `https://api.yolo.studio/v1` (its origin is the host
   * the gateway injects the token for). No trailing path beyond the API prefix.
   */
  brokerUrl: string;
  /** This app's id, as in its manifest. */
  appId: string;
  /** Defaults to the global `fetch` (the outbound the gateway mediates). */
  fetch?: typeof fetch;
  /** Per-call timeout in ms; default 75 s, above the platform's own 60 s ceiling. */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 75_000;

/** A structured failure for a reply the broker didn't shape (status 0: no response). */
function unshaped(status: number, message: string): TileAppCallResult {
  const reason = status === 429 ? 'rate-limited' : status >= 500 ? 'upstream-failed' : 'unavailable';
  return { ok: false, reason, message, ...(status ? { status } : {}) };
}

export function createTileServerClient(options: TileServerClientOptions): TileCaller {
  const base = options.brokerUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('@yolo-labs/app-sdk: brokerUrl must be an http(s) URL');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.appId)) throw new Error('@yolo-labs/app-sdk: appId is not a tile app id');
  const url = `${base}/tileapps/${options.appId}/call`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function callCapability(capability: string, method: string, args?: unknown, opts?: TileAppCallOptions): Promise<TileAppCallResult> {
    const kind = `${capability}.${method}`;
    if (opts?.signal?.aborted) throw new CancelledError(kind);
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    // Timeout and cancellation cover the whole exchange, body included.
    const aborted = (): Error | null => {
      if (timedOut) return new TimeoutError(kind, timeoutMs);
      return opts?.signal?.aborted || controller.signal.aborted ? new CancelledError(kind) : null;
    };
    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ capability, method, args: args ?? {} }),
          signal: controller.signal,
        });
      } catch (err) {
        const e = aborted();
        if (e) throw e;
        return unshaped(0, `broker unreachable: ${(err as Error)?.message ?? String(err)}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        const e = aborted();
        if (e) throw e;
        body = undefined;
      }
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') {
        const r = unshaped(res.status, `broker answered HTTP ${res.status} without a result`);
        return Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? { ...r, retryAfter: retryAfterHeader } : r;
      }
      const reply = body as Record<string, unknown>;
      // Backoff hint: mcp.call's `retryAfter`, the broker limiter's `retryAfterSeconds`, or the HTTP header.
      const retryAfter = reply.retryAfter !== undefined ? reply.retryAfter as number | null
        : typeof reply.retryAfterSeconds === 'number' ? reply.retryAfterSeconds
          : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined;
      return {
        ok: reply.ok === true,
        payload: reply.payload,
        reason: typeof reply.reason === 'string' ? reply.reason : undefined,
        message: typeof reply.message === 'string' ? reply.message : typeof reply.error === 'string' ? reply.error : undefined,
        ...(typeof reply.status === 'number' ? { status: reply.status } : {}),
        ...(reply.code !== undefined ? { code: reply.code as string | null } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(typeof reply.permission === 'string' ? { permission: reply.permission } : {}),
      };
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    call: (capability, method, args, opts) => callCapability(capability, method, args, opts),
    async llmInvoke(args: LlmInvokeArgs, opts?: TileAppCallOptions) {
      return (await callCapability('llm', 'invoke', args, opts)) as TileAppCallResult<LlmInvokePayload>;
    },
    async llmDiscover(args?: LlmDiscoverArgs, opts?: TileAppCallOptions) {
      return (await callCapability('llm', 'discover', args ?? {}, opts)) as TileAppCallResult<LlmDiscoverPayload>;
    },
    async mcpCall<TPayload = unknown>(args: McpCallArgs, opts?: TileAppCallOptions) {
      return (await callCapability('mcp', 'call', args, opts)) as TileAppCallResult<TPayload>;
    },
    async sendNotification(args: SendNotificationArgs, opts?: TileAppCallOptions) {
      return (await callCapability('notifications', 'send', args, opts)) as TileAppCallResult<SendNotificationPayload>;
    },
    async capabilities(opts?: TileAppCallOptions) {
      const res = (await callCapability('capabilities', 'get', {}, opts)) as TileAppCallResult<TileAppCapabilities>;
      if (res.ok && res.payload) return res.payload;
      if (res.reason === 'unknown-capability' || res.reason === 'unknown-method') return null;
      throw new Error(`@yolo-labs/app-sdk: capabilities.get failed: ${res.message ?? res.reason ?? 'unknown'}`);
    },
  };
}
