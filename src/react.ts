/**
 * @yolo-labs/app-sdk/react — OPTIONAL React bindings for the bridge client.
 *
 * Thin, tree-shakeable hooks over the vanilla {@link createTileApp} client.
 * Importing THIS subpath is the only thing that pulls React in; the core
 * (`@yolo-labs/app-sdk`) never imports React, so a vanilla-HTML app (like
 * videostitcher) pays nothing for these. React is an OPTIONAL peer dependency —
 * you already have it if you reach for this entry point.
 *
 * Browser-only: each hook ultimately calls `createTileApp`, which registers a
 * `window` message listener — these are client-side hooks, not for SSR.
 *
 * No brokered-credentials hook ships here yet: `useBrokeredFetch` waits on the
 * P2 `brokeredFetch` client, which is gated on the
 * brokered-credentials backend.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTileApp } from './client.js';
import type {
  CreateTileAppOptions,
  PermissionGrant,
  TileApp,
  TileAppCallOptions,
  TileAppCallResult,
} from './client.js';
import type { EnvProfileAppliedEnvelope, HostEventKind } from './envelope.js';

/**
 * Create a single {@link TileApp} bound to the component's lifecycle: one client
 * created on mount and destroyed on unmount.
 *
 * Returns `null` on the very first render (the client is created in a
 * post-commit effect, NOT during render — so a suspended or abandoned render
 * never leaks a `window` listener), then a STABLE client for the rest of the
 * component's life. All the other hooks here accept that initial `null`, so you
 * can pass the result straight through:
 *
 * ```ts
 * const app = useTileApp();
 * const { call, pending } = useTileAppCall(app);  // null-tolerant
 * useTileAppEvent(app, 'env-profile-applied', refresh);
 * ```
 *
 * `options` is read once at creation; passing a new object literal on later
 * renders does NOT tear down and rebuild the live bridge (which would drop the
 * pinned host origin and any in-flight calls). StrictMode-safe: the dev
 * mount/unmount/remount cycle settles on a single live client.
 */
export function useTileApp(options?: CreateTileAppOptions): TileApp | null {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [app, setApp] = useState<TileApp | null>(null);

  useEffect(() => {
    // Created AFTER commit, so an abandoned/suspended render can't leave a
    // listener behind. StrictMode (dev) runs this effect, its cleanup, then the
    // effect again: the first instance is destroyed and the second replaces it
    // in state, so the component settles on one live client.
    const instance = createTileApp(optionsRef.current);
    setApp(instance);
    return () => {
      instance.destroy();
      // Only clear if a newer instance hasn't already taken over (StrictMode).
      setApp((current) => (current === instance ? null : current));
    };
  }, []);

  return app;
}

/**
 * Subscribe to a host → app event for the life of the component (auto-unsubscribe
 * on unmount). `app` may be null/undefined while the client is still
 * initializing — the subscription attaches once it's available. The latest
 * `handler` is always used without re-subscribing on every render.
 */
export function useTileAppEvent(
  app: TileApp | null | undefined,
  kind: HostEventKind,
  handler: (event: EnvProfileAppliedEnvelope) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!app) return;
    const off = app.on(kind, (e) => handlerRef.current(e));
    return off;
  }, [app, kind]);
}

/** Imperative capability-call helper with request state. */
export interface UseTileAppCall {
  /** Invoke a host capability; resolves the broker's verbatim reply. Rejects
   *  only on transport failure (no host, timeout, destroyed) — a broker
   *  `ok:false` resolves normally and lands in {@link UseTileAppCall.result}. */
  call: (capability: string, method: string, args?: unknown, opts?: TileAppCallOptions) => Promise<TileAppCallResult>;
  /** True while at least one call started here is in flight. */
  pending: boolean;
  /** The most recent resolved reply, or null. */
  result: TileAppCallResult | null;
  /** The most recent transport error, or null (cleared on the next success). */
  error: Error | null;
}

/**
 * Wrap {@link TileApp.call} with React state: a stable `call` callback plus
 * `pending` / `result` / `error`. Calls are imperative (fire them from an event
 * handler); the hook tracks in-flight count so `pending` is correct under
 * concurrent calls and never updates state after unmount.
 */
export function useTileAppCall(app: TileApp | null | undefined): UseTileAppCall {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const inflight = useRef(0);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TileAppCallResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const call = useCallback(
    async (capability: string, method: string, args?: unknown, opts?: TileAppCallOptions): Promise<TileAppCallResult> => {
      if (!app) throw new Error('@yolo-labs/app-sdk/react: TileApp not ready yet');
      inflight.current += 1;
      if (mounted.current) setPending(true);
      try {
        const r = await app.call(capability, method, args, opts);
        if (mounted.current) { setResult(r); setError(null); }
        return r;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) setError(e);
        throw e;
      } finally {
        inflight.current -= 1;
        if (mounted.current && inflight.current === 0) setPending(false);
      }
    },
    [app],
  );

  return { call, pending, result, error };
}

/** Imperative permission-request helper with request state. */
export interface UseRequestPermissions {
  /** Prompt the user to grant `permissions` (must be in the manifest's optional
   *  set). Resolves the grant on accept; rejects with a `PermissionRequestError`
   *  otherwise. */
  request: (permissions: string[]) => Promise<PermissionGrant>;
  /** True while a permission prompt is open. */
  pending: boolean;
  /** The most recent accepted grant, or null. */
  grant: PermissionGrant | null;
  /** The most recent request error (decline/timeout/busy), or null. */
  error: Error | null;
}

/**
 * Wrap {@link TileApp.requestPermissions} with React state. The host holds one
 * pending prompt per tile, so overlapping requests reject with `reason:'busy'`
 * (enforced in the core client) — don't fire a second while one is open.
 */
export function useRequestPermissions(app: TileApp | null | undefined): UseRequestPermissions {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // In-flight count, NOT a boolean: a second `request()` fired before the first
  // settles (e.g. a double-click) gets the core client's synchronous `busy`
  // rejection. A boolean's `finally` would clear `pending` while the first
  // prompt is still open — re-enabling UI mid-prompt. Counting keeps `pending`
  // true until the last outstanding request resolves.
  const inflight = useRef(0);
  const [pending, setPending] = useState(false);
  const [grant, setGrant] = useState<PermissionGrant | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const request = useCallback(
    async (permissions: string[]): Promise<PermissionGrant> => {
      if (!app) throw new Error('@yolo-labs/app-sdk/react: TileApp not ready yet');
      inflight.current += 1;
      if (mounted.current) setPending(true);
      try {
        const g = await app.requestPermissions(permissions);
        if (mounted.current) { setGrant(g); setError(null); }
        return g;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) setError(e);
        throw e;
      } finally {
        inflight.current -= 1;
        if (mounted.current && inflight.current === 0) setPending(false);
      }
    },
    [app],
  );

  return { request, pending, grant, error };
}
