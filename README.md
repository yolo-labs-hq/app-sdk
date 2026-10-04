# @yololabs/app-sdk

The client SDK a **YOLO App** imports to talk to the YOLO host.

A YOLO App runs inside a sandboxed, cross-origin `<iframe>`. It has **no** ambient
access to the host page, the user's token, the workspace, or any YOLO API — its
**only** channel to the host is a `postMessage` bridge. This package is the
shared, origin-safe client for that bridge. It is the **only** YOLO package a
third-party app installs.

---

## 1. What it is

There are two layers on opposite sides of the iframe sandbox boundary. This SDK
is the second one **only**.

- **Host chrome — first-party, runs in the privileged YOLO webapp. NOT this SDK,
  never published.** The host renders the
  sandboxed iframe, runs the *trusted* bridge, and — critically — **attaches the
  user's token in trusted parent code** before forwarding a call to the
  Capability Broker. The iframe never sees the token. Publishing this layer would
  hand third parties the token-attach path, so it stays in the webapp.

- **Iframe app code — what you write. This SDK's audience.** Your code runs
  *inside* the cross-origin sandbox with no ambient host access. Its sole channel
  is the bridge envelope.

**Why a shared SDK:** without it every app hand-rolls that envelope — typically a
small `bridgeCall` Promise wrapper that, like most from-scratch versions, posts with
`targetOrigin: '*'` and never validates the origin of replies. That's acceptable
for a first-party demo but **unsafe as a copy-paste template** for untrusted
apps. This SDK removes the duplication and makes the safe origin handling the
default instead of a footgun.

---

## 2. Install

> **Not on npm yet.** Until `@yololabs/app-sdk` is published, build it from this
> repo and vendor the output. It is zero-dependency ESM (React is an optional peer
> dependency, only for `@yololabs/app-sdk/react`):
>
> ```bash
> npm install
> npm run build   # emits dist/index.js (+ dist/react.js and .d.ts types)
> ```
>
> Copy `dist/` into your app and import it by path, or map the bare specifier to
> it with your bundler or an import map. `examples/minimal-app.html` is a
> minimal framework-free app that imports it by that bare name.

Quick start:

```ts
import { createTileApp } from '@yololabs/app-sdk';

const app = createTileApp();

// Capability call — the host attaches your user token server-side.
const res = await app.call('media', 'upload', { name: 'clip.mp4' });
if (res.ok) {
  console.log('uploaded', res.payload);
} else {
  console.warn('upload refused:', res.reason, res.message);
}

// React to host events (e.g. an env-profile being applied to the session).
const off = app.on('env-profile-applied', (e) => {
  console.log('env changed:', e.envVarKeys);
});
```

---

## 3. The bridge client

```ts
import { createTileApp } from '@yololabs/app-sdk';

const app = createTileApp({
  defaultTimeoutMs: 30_000, // optional; per-call override via call(... , { timeoutMs })
  hostOrigin: 'https://yolo.studio', // optional; else discovered from location.ancestorOrigins / document.referrer
});
```

### `app.call(capability, method, args?, opts?)`

Make a capability call. The host attaches your user token in trusted parent code
and forwards to the Capability Broker; **you never see the token**.

```ts
const res = await app.call('media', 'upload', { /* args */ }, { timeoutMs: 30_000 });
// res is the broker's verbatim shape:
//   { ok: true, payload } | { ok: false, reason, message }
if (res.ok) {
  // res.payload
} else {
  // res.reason, res.message
}
```

The promise resolves with the broker's reply union; it does **not** throw on a
broker `{ ok: false }`. It rejects only on transport failure (no host present, or
the call times out).

### `app.llmInvoke(args, opts?)` / `app.llmDiscover(args?, opts?)`

*(≥ 0.6.0)* Typed wrappers over `call('llm', 'invoke' | 'discover', …)` — the same
broker call with the payload shape attached. Both need the single, provider-agnostic
**`llm.invoke`** permission; there is no separate discovery permission and no
per-provider one (a legacy `llm.invoke:<provider>` grant folds into it).

```ts
// What can this app run, and what does it cost?
const cat = await app.llmDiscover({ capabilities: ['tools'], maxCreditsPerMTokOutput: 10_000 });
const pick = cat.payload?.models[0];          // LlmDiscoverModel

// Run it. `pick.id` is "provider/model" — pass it back VERBATIM.
const res = await app.llmInvoke({
  model: pick?.id ?? 'auto',
  messages: [{ role: 'user', content: 'Summarise this.' }],
  max_tokens: 256,
});
if (res.ok) console.log(res.payload?.choices?.[0]?.message?.content);
```

**`model` is honored, not advisory.** `"provider/model"` is a hard pin;
a bare model id is resolved against the catalog (ambiguous ⇒ `invalid-args`
naming the candidates; unmatched ⇒ auto-routing plus a `payload.modelFallback`
note, for back-compat with apps that already send ignored ids); absent or
`"auto"` lets the platform choose. Streaming is not available through the broker.

Types: `LlmInvokeArgs`, `LlmInvokePayload`, `LlmModelFallbackNotice`,
`LlmDiscoverArgs`, `LlmDiscoverPayload`, `LlmDiscoverModel`,
`LlmDiscoverCredits`, `LlmDenyReason`.

### `app.getContext(opts?)`

The app's own context, answered by the host from state it already holds — no
server round-trip, no token involved. Cached after the first successful reply.

```ts
const ctx = await app.getContext();
// ctx.workspaceId  — the hosting workspace id
// ctx.tileId       — this app tile's id
// ctx.appId        — the app id the host bound to this tile (string | null)
// ctx.theme        — host UI theme ('dark' today; additive room for 'light')
```

Against a host deployed before this envelope existed the request never gets a
reply and the promise rejects with a `TimeoutError` — treat that as "context
unavailable" and degrade (don't retry in a loop). Never try to recover the
workspaceId from tokens or URLs; this is the sanctioned source.

### `app.on(kind, handler)`

Subscribe to host → app events. Returns an unsubscribe function.

```ts
const off = app.on('env-profile-applied', (e) => {
  // e.profileId, e.profileName, e.envVarKeys
});
off(); // stop listening
```

Unknown event kinds are ignored (the host contract is additive-only), so a newer
host can ship new kinds without breaking older apps.

### `app.requestPermissions(permissions)`

Request runtime permissions the user hasn't granted yet. The host shows a consent
dialog. The requested permissions **must already be declared in your manifest's
`optional` set** — see §4.

```ts
try {
  const grant = await app.requestPermissions(['net:api.elevenlabs.io']);
  // grant.grantedPermissions — the full granted set after this request
  // grant.newlyGranted      — just what this request added
} catch (err) {
  // err.reason: 'user-declined' | 'invalid-args' | 'timeout' | 'busy'
}
```

### `app.destroy()`

Remove the SDK's single message listener and reject any in-flight calls. Call this
when your app is torn down.

### Origin safety

The SDK **pins the host origin** (from `location.ancestorOrigins` / `document.referrer`, or the first valid host
message, or the `hostOrigin` you pass) and:

- **drops any reply whose `event.origin` doesn't match** the pinned host origin —
  closing the gap in the hand-rolled videostitcher client, which validated nothing;
- **posts only to the pinned origin**, never `'*'`.

You never handle the user token, and you never post to a wildcard target.

### React bindings (optional)

If your app is React, import the thin hooks from the **`@yololabs/app-sdk/react`**
subpath. React is an **optional peer dependency** — the core package never
imports it, so vanilla-HTML apps pay nothing, and the subpath is tree-shaken
away unless you import it.

```ts
import { useTileApp, useTileAppEvent, useTileAppCall, useRequestPermissions } from '@yololabs/app-sdk/react';

function Stitcher() {
  const app = useTileApp();                       // one client, destroyed on unmount
  const { call, pending, result } = useTileAppCall(app);

  useTileAppEvent(app, 'env-profile-applied', () => refreshKeyBadges());

  return <button disabled={pending} onClick={() => call('media', 'upload', file)}>Upload</button>;
}
```

- **`useTileApp(options?)`** — creates one bridge client bound to the component
  lifecycle. Returns `null` on the first render (the client is built in a
  post-commit effect, so a suspended/abandoned render can't leak a listener),
  then a stable client that's destroyed on unmount. The other hooks accept that
  initial `null`, so you can pass it straight through. `options` is read once (a
  new object literal on a later render does **not** rebuild the live bridge).
- **`useTileAppEvent(app, kind, handler)`** — subscribe to a host event with
  auto-unsubscribe; always uses the latest `handler` without re-subscribing.
  `app` may be null while still initializing.
- **`useTileAppCall(app)`** — `{ call, pending, result, error }`; `call` is
  stable and `pending` is correct under concurrent calls.
- **`useRequestPermissions(app)`** — `{ request, pending, grant, error }`.

A `useBrokeredFetch` hook will join this subpath once the P2 `brokeredFetch`
client ships (gated on the brokered-credentials backend).

---

## 4. Manifest

Your app ships a manifest (`tileapp.json`) declaring
`id`, `version`, `publisher`, `displayName`, `surface`, `runtime`, and a
`permissions` block with `required[]` and `optional[]`.

```ts
import { validateManifest, KNOWN_PERMISSIONS } from '@yololabs/app-sdk';

const v = validateManifest(json);
if (v.ok) {
  // v.manifest is the typed manifest
} else {
  // v.errors: string[]
}
```

`validateManifest` is a **local convenience** — it catches shape errors before you
publish. The server re-validates authoritatively at ingest; the SDK validator is
not the gate.

`KNOWN_PERMISSIONS` is the catalog of permission strings so you reference them by
name rather than hand-typing raw strings.

**The manifest's declared permission set is the CEILING.** The host rejects any
permission not declared in the manifest, and the broker enforces the *granted*
subset on every `call` server-side regardless of what the SDK sends. A malicious
app that skips the SDK and hand-posts envelopes gains nothing — the SDK is a
convenience layer over an enforcement boundary it cannot weaken.

---

## 5. Security model

This SDK runs in **untrusted iframe code** — the app author is treated as
adversarial. Hard rules:

- **No token access.** The host attaches the user token in trusted parent code;
  the iframe never receives it. There is no token API in this SDK and never will
  be.
- **Origin-validated on every reply.** Replies from any origin other than the
  pinned host origin are dropped; the SDK posts only to the pinned origin. This is
  the SDK's single most important correctness property.
- **Brokered credentials only for user secrets.** Raw `secret:<KEY>` injection is
  first-party-only and **killed for third parties**. The brokered-credentials
  surface (`brokeredFetch` — the broker attaches a user's vendor key server-side
  and the app sees only the response) is **not in Phase 1**; it is part of the
  marketplace permissions model. There is no
  SDK API that returns secret bytes.
- **`work.*` capabilities are never app-grantable.** All `work.*` MCP scopes are
  `internal`. The SDK exposes no path to them.

---

## 6. Versioning & compatibility

**Pin any version of this SDK and your app keeps working.** The host's bridge
protocol is **additive-only** — new optional fields or message kinds may appear,
but existing ones are never removed, renamed, or repurposed. There is no version
handshake to manage: the SDK stamps a `protocolVersion` on its messages purely
as a signal, and the host stays backward-compatible with every published SDK
version. The SDK's npm version (semver) tracks the SDK's own API surface; it is
**not** the protocol version. (Internally the protocol is at version 1 and is
expected to stay there.)

---

## 7. Status

**Phase 1** — the bridge client (`createTileApp` → `call` / `on` /
`requestPermissions` / `destroy`) plus manifest types and `validateManifest` /
`KNOWN_PERMISSIONS`, and the optional **`@yololabs/app-sdk/react`** hooks.

**0.6.0** adds typed `llmInvoke` / `llmDiscover` helpers and the `Llm*` arg/payload
types (additive — `call()` is unchanged).

Later phases, gated behind the YOLO Apps marketplace:

- **Brokered credentials** (`brokeredFetch`) — co-designed with the
  brokered-credentials backend.
- **Publisher CLI** — `yolo tileapp init | sign | push-image | publish`, which
  re-uses `validateManifest` to lint manifests with the same code this SDK ships.

---

## 8. More host APIs

### In-app notifications

Apps can send one notification to the global bell, the current workspace's
command bar, or both. A notification delivered to both uses one record: reading
or dismissing it applies to both surfaces. These are Studio notifications, not
OS/browser push alerts or a scheduler that runs after the workspace closes.

Declare destinations as optional permissions in your manifest:

```json
{"permissions":{"required":[],"optional":["notifications.send:global","notifications.send:workspace"]}}
```

Ask for permission only after the user opts in. Sending to `both` requires both
permissions. The host derives the recipient, app attribution and workspace from
the installed app; apps cannot choose another user/workspace or spoof a system
notification.

```ts
await app.requestPermissions(['notifications.send:global', 'notifications.send:workspace']);
const result = await app.sendNotification({
  destination: 'both', // 'global' | 'workspace' | 'both'
  title: 'Focus complete',
  message: 'Your short break is ready.',
  eventId: 'session-unique-id', // reuse for a retry of this same occurrence
});
if (!result.ok) console.warn(result.message);
```

The wire call is `app.call('notifications', 'send', args)`, which also works with
older SDK versions. Titles are limited to 120 characters, messages to 2,000 and
event IDs to 128. Notification calls remain subject to the host's rate limit.

### Workspace Zen Mode

An app can expand its own tile into Studio's existing Zen Mode without reloading
its iframe. Call this from a button inside the focused app:

```ts
const result = await app.zen.enter();
if (!result.ok) showMessage(result.message ?? 'Use the tile menu to enter Zen Mode.');
const initial = await app.zen.status();
const unsubscribe = app.zen.onChange(active => renderZenButton(active));
// The same button can call app.zen.exit() while active.
```

This changes workspace presentation (not browser fullscreen), requires no manifest
permission, and keeps Studio's exit controls. Requests from unfocused apps are
rejected. Exit only exits this app's tile; it cannot dismiss another tile's Zen
Mode. Hosts predating this additive API time out; handle errors and leave the app
usable inside its tile. `status()` reports initial state; `onChange()` tracks
host chrome, Escape, and tile switches. Raw bridge clients send `kind:
'zen-request'`, `id`, and `action: 'enter' | 'exit' | 'status'` in the usual
`__tileapp: true` envelope, receive `{active: boolean}` in the normal reply, and
listen for host `zen-state-changed` envelopes with an `active` boolean.

### Dock and title bar

Apps can request a gentle dock pulse with `app.dock.pulse()` (host limited to
once per minute) and publish a short title-bar status with
`app.titleBar.setStatus('24:25')`. Use `null` to clear the status. Status accepts
up to 32 single-line characters; the host controls styling and truncation.

Use `app.dock.setPreview({ label, value, description, progress, countdownEndsAt,
actions })` to publish a compact host-rendered dock card, and
`app.dock.onAction(id => ...)` to handle its buttons. No additional permission
is required. Pass `null` to clear the card. The SDK republishes the latest
snapshot when the host remounts.

---

## Source & contributing

[github.com/yolo-labs-hq/app-sdk](https://github.com/yolo-labs-hq/app-sdk) is a public mirror of `packages/app-sdk` in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](./LICENSE).
