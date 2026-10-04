// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createTileApp } from './client.js';
import { useRequestPermissions, useTileApp, useTileAppCall, useTileAppEvent } from './react.js';

const HOST = 'https://host.test';
let postSpy: ReturnType<typeof vi.fn>;

/** Stand in a fake host window (jsdom's window.parent === window) + referrer. */
function installHost(referrer = HOST) {
  postSpy = vi.fn();
  Object.defineProperty(window, 'parent', { value: { postMessage: postSpy }, configurable: true });
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
}

/** Simulate the HOST (our parent window) posting a message into the iframe. */
function hostSends(data: unknown, origin = HOST) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: window.parent as Window }));
}

/** The last envelope the SDK posted. */
function lastEnv(): { id: string; kind: string; [k: string]: unknown } {
  return postSpy.mock.calls[postSpy.mock.calls.length - 1][0];
}

beforeEach(() => installHost());
afterEach(() => vi.restoreAllMocks());

describe('useTileApp', () => {
  it('creates one stable client and tears it down on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { result, rerender, unmount } = renderHook(() => useTileApp());
    const app = result.current;
    expect(app).toBeTruthy(); // non-null after the mount effect ran
    rerender();
    expect(result.current).toBe(app); // identity stable across re-renders

    const before = removeSpy.mock.calls.filter((c) => c[0] === 'message').length;
    unmount();
    const after = removeSpy.mock.calls.filter((c) => c[0] === 'message').length;
    expect(after).toBeGreaterThan(before); // destroy() removed its listener
  });

  it('survives StrictMode mount/unmount/remount and stays usable', async () => {
    // StrictMode mounts → unmounts → remounts in dev; the component must settle
    // on ONE live (non-destroyed) client.
    const { result } = renderHook(() => useTileApp(), { wrapper: StrictMode });
    const app = result.current;
    expect(app).not.toBeNull();
    let callP!: Promise<{ ok: boolean }>;
    act(() => { callP = app!.call('cap', 'm', {}) as Promise<{ ok: boolean }>; });
    const env = lastEnv();
    await act(async () => {
      hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true });
      await callP;
    });
    await expect(callP).resolves.toMatchObject({ ok: true });
  });

  it('does not register a listener for a suspended (never-committed) render', () => {
    // Render-time client creation would leak a listener when the render is
    // abandoned; creation-in-effect means a never-committed render adds nothing.
    const addSpy = vi.spyOn(window, 'addEventListener');
    function Suspends() { useTileApp(); throw new Promise<never>(() => {}); }
    // Rendering a component that suspends forever: the hook ran, but no effect
    // committed. Use renderHook on a wrapper that suspends below it.
    const before = addSpy.mock.calls.filter((c) => c[0] === 'message').length;
    try {
      renderHook(() => { Suspends(); return null; });
    } catch { /* the thrown promise / suspend bubbles in this bare setup */ }
    const after = addSpy.mock.calls.filter((c) => c[0] === 'message').length;
    expect(after).toBe(before); // nothing registered from the abandoned render
  });

  it('does not rebuild the client when options identity changes', () => {
    const { result, rerender } = renderHook(({ o }) => useTileApp(o), {
      initialProps: { o: { defaultTimeoutMs: 1000 } },
    });
    const app = result.current;
    rerender({ o: { defaultTimeoutMs: 2000 } }); // new object literal
    expect(result.current).toBe(app); // same live bridge, not rebuilt
  });
});

describe('useTileAppEvent', () => {
  it('fires the handler on a host event and unsubscribes on unmount', () => {
    const app = createTileApp();
    const seen: string[] = [];
    const { unmount } = renderHook(() =>
      useTileAppEvent(app, 'env-profile-applied', (e) => seen.push(e.profileId ?? '')),
    );
    act(() => hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'p1' }));
    expect(seen).toEqual(['p1']);
    unmount();
    act(() => hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'p2' }));
    expect(seen).toEqual(['p1']); // unsubscribed
    app.destroy();
  });

  it('always uses the latest handler without re-subscribing', () => {
    const app = createTileApp();
    let tag = 'first';
    const seen: string[] = [];
    const { rerender } = renderHook(() =>
      useTileAppEvent(app, 'env-profile-applied', () => seen.push(tag)),
    );
    tag = 'second';
    rerender();
    act(() => hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'p' }));
    expect(seen).toEqual(['second']);
    app.destroy();
  });

  it('attaches once the app becomes available (null-tolerant)', () => {
    const app = createTileApp();
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ a }) => useTileAppEvent(a, 'env-profile-applied', (e) => seen.push(e.profileId ?? '')),
      { initialProps: { a: null as ReturnType<typeof createTileApp> | null } },
    );
    act(() => hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'early' }));
    expect(seen).toEqual([]); // no app yet → nothing wired
    rerender({ a: app });
    act(() => hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'late' }));
    expect(seen).toEqual(['late']);
    app.destroy();
  });
});

describe('useTileAppCall', () => {
  it('resolves a capability call and toggles pending', async () => {
    const app = createTileApp();
    const { result } = renderHook(() => useTileAppCall(app));
    expect(result.current.pending).toBe(false);

    let callP!: Promise<unknown>;
    act(() => { callP = result.current.call('media', 'upload', { name: 'x' }); });
    expect(result.current.pending).toBe(true);

    const env = lastEnv();
    await act(async () => {
      hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { url: 'r2://x' } });
      await callP;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.result).toMatchObject({ ok: true, payload: { url: 'r2://x' } });
    expect(result.current.error).toBeNull();
    app.destroy();
  });

  it('records a transport error and rejects', async () => {
    const app = createTileApp();
    const { result } = renderHook(() => useTileAppCall(app));
    let callP!: Promise<unknown>;
    act(() => { callP = result.current.call('cap', 'm', {}, { timeoutMs: 10 }); });
    await act(async () => { await callP.catch(() => {}); });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toMatch(/timed out/);
    expect(result.current.pending).toBe(false);
    app.destroy();
  });
});

describe('useRequestPermissions', () => {
  it('resolves a grant and toggles pending', async () => {
    const app = createTileApp();
    const { result } = renderHook(() => useRequestPermissions(app));
    let reqP!: Promise<unknown>;
    act(() => { reqP = result.current.request(['net:api.elevenlabs.io']); });
    expect(result.current.pending).toBe(true);

    const env = lastEnv();
    expect(env.kind).toBe('request-permissions');
    await act(async () => {
      hostSends({
        __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true,
        payload: { grantedPermissions: ['net:api.elevenlabs.io'], newlyGranted: ['net:api.elevenlabs.io'] },
      });
      await reqP;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.grant).toMatchObject({ newlyGranted: ['net:api.elevenlabs.io'] });
    app.destroy();
  });

  it('keeps pending true when an overlapping request is rejected as busy', async () => {
    const app = createTileApp();
    const { result } = renderHook(() => useRequestPermissions(app));

    let firstP!: Promise<unknown>;
    act(() => { firstP = result.current.request(['net:a']); });
    expect(result.current.pending).toBe(true);

    // A second request before the first settles → core rejects 'busy'
    // synchronously and never hits the wire. Its finally must NOT clear pending.
    await act(async () => { await result.current.request(['net:b']).catch(() => {}); });
    expect(result.current.pending).toBe(true); // first prompt still open

    const env = lastEnv(); // only the first request was posted
    await act(async () => {
      hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { grantedPermissions: ['net:a'], newlyGranted: ['net:a'] } });
      await firstP;
    });
    expect(result.current.pending).toBe(false); // cleared only after the last settles
    app.destroy();
  });
});
