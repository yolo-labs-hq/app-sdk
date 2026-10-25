// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTileApp, PermissionRequestError } from './client.js';
import type { BridgeReplyEnvelope, EnvProfileAppliedEnvelope, ZenStateChangedEnvelope } from './envelope.js';

const HOST = 'https://host.test';

let postSpy: ReturnType<typeof vi.fn>;

/** Stand in a fake host window (jsdom's window.parent === window) + referrer. */
function installHost(referrer = HOST) {
  postSpy = vi.fn();
  Object.defineProperty(window, 'parent', { value: { postMessage: postSpy }, configurable: true });
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
}

/** The last envelope the SDK posted (and its correlation id). */
function lastPosted(): { env: { id: string; kind: string; [k: string]: unknown }; targetOrigin: string } {
  const call = postSpy.mock.calls[postSpy.mock.calls.length - 1];
  return { env: call[0], targetOrigin: call[1] };
}

/** Simulate the HOST (our parent window) posting a message into the iframe. */
function hostSends(data: unknown, origin = HOST) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: window.parent as Window }));
}

/** Simulate a NON-parent frame posting (must be ignored by the SDK). */
function nonParentSends(data: unknown, origin = HOST) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: { postMessage() {} } as unknown as Window }));
}

beforeEach(() => installHost());
afterEach(() => vi.restoreAllMocks());

it('publishes constrained title status and returns host pulse throttling', async () => {
  const app = createTileApp();
  const status = app.titleBar.setStatus('24:25');
  let posted = lastPosted();
  expect(posted.env).toMatchObject({ kind: 'title-bar-status', text: '24:25' });
  expect(posted.targetOrigin).toBe(HOST);
  hostSends({ __tileapp: true, kind: 'bridge-reply', id: posted.env.id, ok: true });
  expect((await status).ok).toBe(true);
  const pulse = app.dock.pulse();
  posted = lastPosted();
  expect(posted.env.kind).toBe('dock-pulse');
  hostSends({ __tileapp: true, kind: 'bridge-reply', id: posted.env.id, ok: true, payload: { pulsed: false } });
  expect((await pulse).payload).toEqual({ pulsed: false });
  app.destroy();
});

it('acks the host post-reload hello to the pinned origin only', () => {
  const app = createTileApp();
  postSpy.mockClear();
  const hello = { __tileapp: true, kind: 'host-hello', nonce: 'n-1' };
  hostSends(hello, 'https://evil.test'); nonParentSends(hello);
  expect(postSpy).not.toHaveBeenCalled();
  hostSends(hello);
  expect(lastPosted()).toEqual({ env: { __tileapp: true, kind: 'host-hello-ack', nonce: 'n-1' }, targetOrigin: HOST });
  hostSends({ __tileapp: true, kind: 'host-hello' });
  expect(postSpy).toHaveBeenCalledTimes(1);
  app.destroy();
});

it('publishes dock content and only accepts dock actions from the pinned parent', async () => {
  const app = createTileApp();
  const handler = vi.fn();
  const unsubscribe = app.dock.onAction(handler);
  const pending = app.dock.setPreview({ label: 'Focus', countdownEndsAt: Date.now() + 60000, actions: [{ id: 'pause', label: 'Pause' }] });
  const { env, targetOrigin } = lastPosted();
  expect(env.kind).toBe('dock-preview');
  expect(targetOrigin).toBe(HOST);
  hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true });
  expect((await pending).ok).toBe(true);
  hostSends({ __tileapp: true, kind: 'dock-preview-request' });
  expect(lastPosted().env.preview).toEqual(env.preview);
  const action = { __tileapp: true, kind: 'dock-action', actionId: 'pause' };
  hostSends(action, 'https://evil.test'); nonParentSends(action);
  expect(handler).not.toHaveBeenCalled();
  hostSends(action); expect(handler).toHaveBeenCalledWith('pause');
  unsubscribe(); hostSends(action); expect(handler).toHaveBeenCalledTimes(1);
  app.destroy();
});

describe('createTileApp — call', () => {
  it('posts a bridge-call to the pinned host origin (never *) and resolves the reply', async () => {
    const app = createTileApp();
    const p = app.call('media', 'upload', { name: 'x.mp3' });
    const { env, targetOrigin } = lastPosted();
    expect(targetOrigin).toBe(HOST);            // pinned, not '*'
    expect(env.__tileapp).toBe(true);
    expect(env.kind).toBe('bridge-call');
    expect(env.capability).toBe('media');
    expect(env.method).toBe('upload');
    expect(env.protocolVersion).toBe(1); // stamped (telemetry / escape hatch)
    const reply: BridgeReplyEnvelope = { __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { url: 'r2://x' } };
    hostSends(reply);
    await expect(p).resolves.toEqual({ ok: true, payload: { url: 'r2://x' }, reason: undefined, message: undefined });
    app.destroy();
  });

  it('resolves the broker error union on ok:false (does not throw)', async () => {
    const app = createTileApp();
    const p = app.call('media', 'upload', {});
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'forbidden', message: 'nope' } satisfies BridgeReplyEnvelope);
    await expect(p).resolves.toEqual({ ok: false, payload: undefined, reason: 'forbidden', message: 'nope' });
    app.destroy();
  });

  it('normalizes a pre-broker host error reply (no ok, only error) to a failure', async () => {
    const app = createTileApp();
    const p = app.call('media', 'upload', {});
    const { env } = lastPosted();
    // The host forwards an API pre-broker error verbatim: { error } and no ok.
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, error: 'token expired' });
    await expect(p).resolves.toEqual({ ok: false, payload: undefined, reason: undefined, message: 'token expired' });
    app.destroy();
  });

  it('DROPS a reply from a different origin (the load-bearing origin check)', async () => {
    vi.useFakeTimers();
    const app = createTileApp({ defaultTimeoutMs: 1000 });
    const p = app.call('media', 'upload', {});
    const { env } = lastPosted();
    // Same id + correct shape, but a hostile origin — must be ignored.
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: 'evil' }, 'https://evil.test');
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);                // the wrong-origin reply did NOT resolve it
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/timed out/); // it eventually times out instead
    app.destroy();
    vi.useRealTimers();
  });

  it('DROPS a reply from a non-parent window source (anti-poisoning)', async () => {
    vi.useFakeTimers();
    const app = createTileApp({ defaultTimeoutMs: 1000 });
    const p = app.call('media', 'upload', {});
    const { env } = lastPosted();
    // Correct shape + correct origin, but NOT from window.parent — must be ignored.
    nonParentSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: 'evil' });
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/timed out/);
    app.destroy();
    vi.useRealTimers();
  });

  it('only the correlated call resolves (id routing)', async () => {
    const app = createTileApp();
    const a = app.call('cap', 'a', {});
    const idA = lastPosted().env.id;
    const b = app.call('cap', 'b', {});
    const idB = lastPosted().env.id;
    expect(idA).not.toBe(idB);
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: idB, ok: true, payload: 'B' } satisfies BridgeReplyEnvelope);
    await expect(b).resolves.toMatchObject({ payload: 'B' });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: idA, ok: true, payload: 'A' } satisfies BridgeReplyEnvelope);
    await expect(a).resolves.toMatchObject({ payload: 'A' });
    app.destroy();
  });

  it('does not pin a same-app referrer (post in-iframe-navigation) — outbound needs a real host origin', async () => {
    // Referrer is the app's OWN prior page (same origin), not the host; with no
    // ancestorOrigins (jsdom) and no explicit option, the host origin stays
    // unknown and an outbound call surfaces an actionable error.
    Object.defineProperty(document, 'referrer', { value: window.location.origin + '/page1.html', configurable: true });
    const app = createTileApp();
    await expect(app.call('cap', 'm', {})).rejects.toThrow(/host origin unknown/);
    app.destroy();
  });

  it('times out a call with no reply', async () => {
    vi.useFakeTimers();
    const app = createTileApp();
    const p = app.call('cap', 'm', {}, { timeoutMs: 50 });
    vi.advanceTimersByTime(51);
    await expect(p).rejects.toThrow(/timed out after 50ms/);
    app.destroy();
    vi.useRealTimers();
  });

  it('DEFAULT timeout outlives the platform\'s own llm.invoke ceiling — the server must give up first', async () => {
    vi.useFakeTimers();
    const app = createTileApp();
    const p = app.call('llm', 'invoke', {});
    const rejection = expect(p).rejects.toThrow(/timed out after 75000ms/);

    // The gateway aborts its forward at 60s (TILEAPP_LLM_TIMEOUT_MS). If this
    // client gave up first, the app would discard a completion the broker is
    // still settling credits for — charged for a result it never saw.
    vi.advanceTimersByTime(60_000);
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(15_001);
    await rejection;
    app.destroy();
    vi.useRealTimers();
  });
});

describe('createTileApp — getContext', () => {
  it('posts a context-request and resolves the host-supplied context', async () => {
    const app = createTileApp();
    const p = app.getContext();
    const { env, targetOrigin } = lastPosted();
    expect(targetOrigin).toBe(HOST);
    expect(env.kind).toBe('context-request');
    expect(env.protocolVersion).toBe(1);
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true,
      payload: { workspaceId: 'w1', tileId: 't1', appId: 'demo', theme: 'dark' } });
    await expect(p).resolves.toEqual({ workspaceId: 'w1', tileId: 't1', appId: 'demo', theme: 'dark' });
    app.destroy();
  });

  it('caches the context — a second getContext posts nothing', async () => {
    const app = createTileApp();
    const p = app.getContext();
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true,
      payload: { workspaceId: 'w1', tileId: 't1', appId: 'demo', theme: 'dark' } });
    await p;
    const postsBefore = postSpy.mock.calls.length;
    await expect(app.getContext()).resolves.toEqual({ workspaceId: 'w1', tileId: 't1', appId: 'demo', theme: 'dark' });
    expect(postSpy.mock.calls.length).toBe(postsBefore);
    app.destroy();
  });

  it('normalizes a partial payload (missing appId → null, missing theme → dark) without caching lies as strings', async () => {
    const app = createTileApp();
    const p = app.getContext();
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { workspaceId: 'w1', tileId: 't1' } });
    await expect(p).resolves.toEqual({ workspaceId: 'w1', tileId: 't1', appId: null, theme: 'dark' });
    app.destroy();
  });

  it('throws on a host failure reply and does NOT cache it', async () => {
    const app = createTileApp();
    const p = app.getContext();
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'invalid-args', message: 'nope' });
    await expect(p).rejects.toThrow(/context request failed: nope/);
    // A retry posts a fresh request (failure was not cached).
    const p2 = app.getContext();
    const { env: env2 } = lastPosted();
    expect(env2.id).not.toBe(env.id);
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env2.id, ok: true,
      payload: { workspaceId: 'w1', tileId: 't1', appId: 'demo', theme: 'dark' } });
    await expect(p2).resolves.toMatchObject({ workspaceId: 'w1' });
    app.destroy();
  });

  it('times out against a host that predates the context envelope', async () => {
    vi.useFakeTimers();
    try {
      const app = createTileApp();
      const p = app.getContext({ timeoutMs: 50 });
      const rejection = expect(p).rejects.toThrow(/timed out/i);
      vi.advanceTimersByTime(60);
      await rejection;
      app.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createTileApp — requestPermissions', () => {
  it('resolves the grant on accept', async () => {
    const app = createTileApp();
    const p = app.requestPermissions(['net:api.elevenlabs.io']);
    const { env } = lastPosted();
    expect(env.kind).toBe('request-permissions');
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { grantedPermissions: ['net:api.elevenlabs.io'], newlyGranted: ['net:api.elevenlabs.io'] } } satisfies BridgeReplyEnvelope);
    await expect(p).resolves.toEqual({ grantedPermissions: ['net:api.elevenlabs.io'], newlyGranted: ['net:api.elevenlabs.io'] });
    app.destroy();
  });

  it('serializes permission prompts across MULTIPLE clients (host holds one per tile)', async () => {
    // The lock is iframe-global, so a second client's request is rejected
    // rather than orphaning the first by overwriting the host-side request.
    const app1 = createTileApp();
    const app2 = createTileApp();
    const first = app1.requestPermissions(['net:a']);
    const second = app2.requestPermissions(['net:b']);
    await expect(second).rejects.toMatchObject({ reason: 'busy' });
    expect(postSpy.mock.calls.length).toBe(1); // app2's request never hit the wire
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { grantedPermissions: ['net:a'], newlyGranted: ['net:a'] } } satisfies BridgeReplyEnvelope);
    await expect(first).resolves.toMatchObject({ newlyGranted: ['net:a'] });
    app1.destroy();
    app2.destroy();
  });

  it('rejects with PermissionRequestError + reason on decline', async () => {
    const app = createTileApp();
    const p = app.requestPermissions(['net:x']);
    const { env } = lastPosted();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'user-declined', message: 'no' } satisfies BridgeReplyEnvelope);
    await expect(p).rejects.toBeInstanceOf(PermissionRequestError);
    await p.catch((e: PermissionRequestError) => expect(e.reason).toBe('user-declined'));
    app.destroy();
  });
});

describe('createTileApp — events', () => {
  it('fires env-profile-applied handlers and unsubscribes', async () => {
    const app = createTileApp();
    const seen: EnvProfileAppliedEnvelope[] = [];
    const off = app.on('env-profile-applied', (e) => seen.push(e));
    hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'p1', envVarKeys: ['K'] } satisfies EnvProfileAppliedEnvelope);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.profileId).toBe('p1');
    off();
    hostSends({ __tileapp: true, kind: 'env-profile-applied', profileId: 'p2' } satisfies EnvProfileAppliedEnvelope);
    expect(seen).toHaveLength(1); // unsubscribed
    app.destroy();
  });

  it('ignores non-tileapp messages and unknown kinds', async () => {
    const app = createTileApp();
    const seen: unknown[] = [];
    app.on('env-profile-applied', (e) => seen.push(e));
    hostSends({ hello: 'world' });
    hostSends({ __tileapp: true, kind: 'some-future-kind' });
    expect(seen).toHaveLength(0);
    app.destroy();
  });
});

describe('createTileApp — destroy', () => {
  it('rejects in-flight calls and stops listening', async () => {
    const app = createTileApp();
    const p = app.call('cap', 'm', {});
    const { env } = lastPosted();
    app.destroy();
    await expect(p).rejects.toThrow(/destroyed/);
    // A late reply after destroy must not throw / resolve anything.
    expect(() => hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true } satisfies BridgeReplyEnvelope)).not.toThrow();
  });
});


describe('tile-app notifications', () => {
  it('uses the pinned bridge and preserves destination, event identity and permission denial', async () => {
    const app = createTileApp();
    const args = { destination: 'both' as const, title: 'Focus complete', message: 'Time for a break.', eventId: 'focus-1' };
    const pending = app.sendNotification(args);
    const { env, targetOrigin } = lastPosted();
    expect(targetOrigin).toBe(HOST);
    expect(env).toMatchObject({ capability: 'notifications', method: 'send', args });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'permission-not-granted', message: 'Enable notifications first.' });
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'permission-not-granted' });
    app.destroy();
  });
});

describe('mcp.call', () => {
  it('posts mcp.call and surfaces the MCP route status, code and Retry-After', async () => {
    const app = createTileApp();
    const args = { scopes: ['studio.kanban_get_board'], path: '/kanban/board/get', method: 'POST' as const, body: { tileId: 't1' } };
    const ok = app.mcpCall<{ cards: unknown[] }>(args);
    let { env, targetOrigin } = lastPosted();
    expect(targetOrigin).toBe(HOST);
    expect(env).toMatchObject({ kind: 'bridge-call', capability: 'mcp', method: 'call', args });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, status: 200, payload: { cards: [] } });
    await expect(ok).resolves.toStrictEqual({ ok: true, status: 200, payload: { cards: [] }, reason: undefined, message: undefined, code: undefined, retryAfter: undefined, permission: undefined });

    const limited = app.mcpCall(args);
    ({ env } = lastPosted());
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'upstream-status', status: 429, code: 'RATE_LIMITED', message: 'slow down', retryAfter: 12 });
    await expect(limited).resolves.toStrictEqual({ ok: false, payload: undefined, reason: 'upstream-status', message: 'slow down', status: 429, code: 'RATE_LIMITED', retryAfter: 12, permission: undefined });

    // The broker's own limiter answers before any route, naming its hint retryAfterSeconds.
    const brokerLimited = app.mcpCall(args);
    ({ env } = lastPosted());
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'rate-limited', message: 'too many broker calls', retryAfterSeconds: 20 });
    await expect(brokerLimited).resolves.toStrictEqual({ ok: false, payload: undefined, reason: 'rate-limited', message: 'too many broker calls', retryAfter: 20, status: undefined, code: undefined, permission: undefined });
    app.destroy();
  });
});

describe('workspace Zen Mode', () => {
  it('posts host-local enter/exit requests and returns host errors', async () => {
    const app = createTileApp();
    const entering = app.zen.enter();
    const first = lastPosted();
    expect(first.targetOrigin).toBe(HOST);
    expect(first.env).toMatchObject({ __tileapp: true, kind: 'zen-request', action: 'enter', protocolVersion: 1 });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: first.env.id, ok: true, payload: { active: true } });
    await expect(entering).resolves.toMatchObject({ ok: true, payload: { active: true } });
    const exiting = app.zen.exit();
    const second = lastPosted();
    expect(second.env).toMatchObject({ kind: 'zen-request', action: 'exit' });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: second.env.id, ok: false, reason: 'not-focused', message: 'Focus this app first' });
    await expect(exiting).resolves.toMatchObject({ ok: false, reason: 'not-focused' });
    app.destroy();
  });
  it('queries current state and observes host-driven changes', async () => {
    const app = createTileApp();
    const states: boolean[] = [];
    const off = app.zen.onChange((active) => states.push(active));
    const status = app.zen.status();
    const request = lastPosted();
    expect(request.env).toMatchObject({ kind: 'zen-request', action: 'status' });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: request.env.id, ok: true, payload: { active: false } });
    await expect(status).resolves.toMatchObject({ ok: true, payload: { active: false } });
    hostSends({ __tileapp: true, kind: 'zen-state-changed', active: true } satisfies ZenStateChangedEnvelope);
    hostSends({ __tileapp: true, kind: 'zen-state-changed', active: false } satisfies ZenStateChangedEnvelope);
    expect(states).toEqual([true, false]);
    off();
    hostSends({ __tileapp: true, kind: 'zen-state-changed', active: true } satisfies ZenStateChangedEnvelope);
    expect(states).toEqual([true, false]);
    app.destroy();
  });
});

describe('link.open (card C7)', () => {
  it('app.openLink posts link.open on the pinned bridge and returns the host reply', async () => {
    const app = createTileApp();
    const opened = app.openLink('https://github.com/org/repo');
    let { env, targetOrigin } = lastPosted();
    expect(targetOrigin).toBe(HOST);
    expect(env).toMatchObject({ kind: 'bridge-call', capability: 'link', method: 'open', args: { url: 'https://github.com/org/repo' } });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: { opened: true, host: 'github.com' } });
    await expect(opened).resolves.toMatchObject({ ok: true, payload: { opened: true, host: 'github.com' } });

    const refused = app.openLink('https://evil.test/');
    ({ env } = lastPosted());
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: false, reason: 'link-not-declared', message: 'not declared' });
    await expect(refused).resolves.toMatchObject({ ok: false, reason: 'link-not-declared' });
    app.destroy();
  });
});

// P1.2: capability discovery, additive. A host without it answers unknown-capability → null.
describe('createTileApp — capabilities', () => {
  const CONTRACT = {
    version: 'tileapp-capabilities/v1', placement: 'worker',
    decisions: [{ permission: 'llm.invoke', family: 'llm', required: true, granted: true, state: 'enforced', enforcement: { by: 'broker', capability: 'llm' }, surfaces: { ui: true, backend: true } }],
    implicit: [], ambient: { navigation: 'n', isolation: null, podLoopback: null },
  };

  it('asks capabilities.get through the bridge and resolves the contract', async () => {
    const app = createTileApp();
    const p = app.capabilities();
    const { env } = lastPosted();
    expect([env.kind, env.capability, env.method]).toEqual(['bridge-call', 'capabilities', 'get']);
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: CONTRACT });
    expect(await p).toEqual(CONTRACT);
    app.destroy();
  });

  it.each(['unknown-capability', 'unknown-method'])('resolves null on a host without discovery (%s)', async (reason) => {
    const app = createTileApp();
    const p = app.capabilities();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: lastPosted().env.id, ok: false, reason, message: 'no' });
    expect(await p).toBeNull();
    app.destroy();
  });

  it('throws on any other refusal', async () => {
    const app = createTileApp();
    const p = app.capabilities();
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: lastPosted().env.id, ok: false, reason: 'app-not-installed', message: 'not installed' });
    await expect(p).rejects.toThrow(/not installed/);
    app.destroy();
  });
});

// P1.3: the UI call takes a signal too; cancelling rejects CancelledError.
describe('createTileApp — cancellation', () => {
  it('a cancelled signal rejects CancelledError and drops the pending call', async () => {
    const { CancelledError } = await import('./client.js');
    const app = createTileApp();
    const ac = new AbortController();
    const p = app.call('llm', 'invoke', {}, { signal: ac.signal });
    const { env } = lastPosted();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    // A late reply for it is ignored.
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: env.id, ok: true, payload: 1 });
    await expect(app.call('llm', 'invoke', {}, { signal: ac.signal })).rejects.toBeInstanceOf(CancelledError);
    app.destroy();
  });
});

describe('createTileApp — signal listeners and missing host (P1.3 review)', () => {
  it('a settled call removes its abort listener from a long-lived signal', async () => {
    const app = createTileApp();
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    const p = app.call('llm', 'invoke', {}, { signal: ac.signal });
    hostSends({ __tileapp: true, kind: 'bridge-reply', id: lastPosted().env.id, ok: true, payload: 1 });
    await p;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    app.destroy();
  });

  it('with no host window, a capability call is a structured unavailable refusal', async () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    const app = createTileApp();
    expect(await app.call('llm', 'invoke', {})).toMatchObject({ ok: false, reason: 'unavailable' });
    app.destroy();
  });

});

it('mcpCall uses origin-safe correlation and preserves bounded route status metadata', async () => {
  const app = createTileApp();
  const pending = app.mcpCall<{ note: string }>({ scopes: ['studio.read_file'], path: '/files/read', body: { path: 'docs/a.txt' } });
  const posted = lastPosted();
  expect(posted.targetOrigin).toBe(HOST);
  expect(posted.env).toMatchObject({ kind: 'bridge-call', capability: 'mcp', method: 'call', args: { path: '/files/read' } });
  let settled = false; void pending.then(() => { settled = true; });
  const response = { __tileapp: true, kind: 'bridge-reply', id: posted.env.id, ok: false, reason: 'upstream-status', status: 429, code: 'RATE_LIMITED', retryAfter: 7, permission: 'mcp:studio.read_file', payload: { note: 'denied' } };
  hostSends(response, 'https://untrusted.test'); nonParentSends(response); await Promise.resolve(); expect(settled).toBe(false);
  hostSends(response);
  expect(await pending).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED', retryAfter: 7, permission: 'mcp:studio.read_file', payload: { note: 'denied' } });
  app.destroy();
});

it('mcpCall normalizes malformed optional metadata and rate-limit hint without loosening envelope origin checks', async () => {
  const app = createTileApp();
  const pending = app.mcpCall({ scopes: [], path: '/files/list' });
  hostSends({ __tileapp: true, kind: 'bridge-reply', id: lastPosted().env.id, ok: false, reason: 'rate-limited', status: '429', code: {}, retryAfter: -1, retryAfterSeconds: 4, permission: [] });
  const result = await pending;
  expect(result).toMatchObject({ retryAfter: 4 }); expect(result.status).toBeUndefined(); expect(result.code).toBeUndefined(); expect(result.permission).toBeUndefined();
  app.destroy();
});

it('mcpCall caps only its own timeout at35s while allowing a shorter caller deadline', async () => {
  vi.useFakeTimers();
  const app = createTileApp();
  try {
    const pending = app.mcpCall({ scopes: [], path: '/files/list' }, { timeoutMs: 90_000 });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(35_000); await rejected;
    const shorter = app.mcpCall({ scopes: [], path: '/files/list' }, { timeoutMs: 5 });
    const shorterRejected = expect(shorter).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(5); await shorterRejected;
  } finally { app.destroy(); vi.useRealTimers(); }
});
