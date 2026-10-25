# @yolo-labs/app-sdk

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

```bash
npm i @yolo-labs/app-sdk
```

It is zero-dependency ESM. React is an optional peer dependency, needed only for
`@yolo-labs/app-sdk/react`. With no bundler, copy the package's `dist/` next to
your page and import it by path, or map the bare specifier with an import map.
`examples/minimal-app.html` is a minimal framework-free app.

Quick start:

```ts
import { createTileApp } from '@yolo-labs/app-sdk';

const app = createTileApp();

// Capability call — the host attaches your user token server-side.
// (Needs `notifications.send:workspace` in your manifest.)
const res = await app.call('notifications', 'send', {
  destination: 'workspace', title: 'Export ready', message: 'clip.mp4 is done', eventId: 'export-42',
});
if (res.ok) {
  console.log('notified', res.payload);
} else {
  console.warn('refused:', res.reason, res.message);
}

// React to host events (e.g. an env-profile being applied to the session).
const off = app.on('env-profile-applied', (e) => {
  console.log('env changed:', e.envVarKeys);
});
```

---

## 3. The bridge client

```ts
import { createTileApp } from '@yolo-labs/app-sdk';

const app = createTileApp({
  defaultTimeoutMs: 30_000, // optional; per-call override via call(... , { timeoutMs })
  hostOrigin: 'https://yolo.studio', // optional; else discovered from location.ancestorOrigins / document.referrer
});
```

### `app.call(capability, method, args?, opts?)`

Make a capability call. The host attaches your user token in trusted parent code
and forwards to the Capability Broker; **you never see the token**.

```ts
const res = await app.call('llm', 'invoke', { messages: [{ role: 'user', content: 'Hi' }] }, { timeoutMs: 30_000 });
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

**Output length and the spend cap.** Each call reserves its possible cost against
your app's monthly spend cap before it runs, sized by its output limit and the
number of completions (`n`, at most 16). Set `max_tokens` or
`max_completion_tokens` (whichever your model accepts) for the length you need:
with neither, 4,096 output tokens are reserved and the call settles at what it
actually used; a limit above 128,000 is lowered to it; if you set both, the larger
is sent, in `max_completion_tokens`. A call the cap can't cover is refused with
`spend-cap-reached`.

Types: `LlmInvokeArgs`, `LlmInvokePayload`, `LlmModelFallbackNotice`,
`LlmDiscoverArgs`, `LlmDiscoverPayload`, `LlmDiscoverModel`,
`LlmDiscoverCredits`, `LlmDenyReason`.

### `app.mcpCall(args, opts?)`

Typed wrapper over `call('mcp', 'call', …)`: call an MCP route **without holding an
MCP token**. The broker checks every scope in `args.scopes` against the grant
(each needs its `mcp:<scope>` permission), mints a short-lived token with exactly
those scopes server-side, calls the route in your workspace, and returns its
answer. Works from every placement, including a static tile whose CSP only allows
`connect-src 'self'`.

```ts
const res = await app.mcpCall<{ cards: unknown[] }>({
  scopes: ['studio.kanban_get_board'],
  path: '/kanban/board/get',      // relative MCP route path; no host, query, `..` or encoding
  method: 'POST',                 // default
  body: { tileId },
});
if (res.ok) {
  res.status;                     // the route's HTTP status
  res.payload?.cards;
} else if (res.reason === 'upstream-status') {
  res.status; res.code;           // e.g. 403 'FORBIDDEN', 409, 503
  res.retryAfter;                 // seconds, on a 429
} else if (res.reason === 'timeout') {
  // no answer within 30 s; res.status === 504
}
```

The workspace always comes from where the app is installed; a `path` that names
one is refused. Tile pinning follows the same rules as `mcp.mint-token`: keep a
kanban (or checklist) call's scopes to that family, plus `studio.list_tiles`, or
the call stays pinned to your own tile and the route answers 403. Replies are
never cached.

`mcp.call` is switched on per environment (`TILEAPP_MCP_CALL`). Where it is off,
the reply is `reason: 'unknown-method'`. Use `createMcpClient` (below) rather than
falling back to `call('mcp', 'mint-token', …)` yourself: `mint-token` is being
retired, and hosts already refuse it to marketplace apps (`reason: 'deprecated'`).

Types: `McpCallArgs`, `McpCallDenyReason`.

### `createMcpClient(app, { pools })`

MCP routes through `mcp.call` where the host has it, with a `mint-token`
fallback for hosts that don't yet. The first request tries `mcp.call`; an
`unknown-method` reply switches the client to the fallback for good.

```ts
import { createTileApp, createMcpClient, McpRequestError } from '@yolo-labs/app-sdk';

const app = createTileApp();
const mcp = createMcpClient(app, {
  pools: {
    // Keep scope families apart, and optional scopes out of required pools.
    kanban: { scopes: ['studio.list_tiles', 'studio.kanban_get_board'] },
    discovery: { scopes: ['studio.ai_access_read'], remintOnForbidden: false },
  },
});

try {
  const board = await mcp.request('kanban', '/kanban/board/get', { body: { tileId } });
} catch (err) {
  if (err instanceof McpRequestError) {
    err.reason;   // 'upstream-status' (route answered non-2xx), 'permission-not-granted', …
    err.status; err.code; err.retryAfter; err.payload; // the route's status and JSON error body
  }
}
mcp.transport(); // 'unknown' | 'call' | 'mint-token'
mcp.reset();     // drop fallback tokens, e.g. after requestPermissions
```

On the fallback each pool keeps one token, reused until 30 s before it expires
(at most 300 s); concurrent mints share a request; a 401, or a 403 unless the
pool sets `remintOnForbidden: false`, re-mints once and retries (a 403 is usually
a tile pin minted before the tile existed).

Types: `McpPool`, `McpClientOptions`, `McpRequestInit`, `McpTransport`, `McpClient`.

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

If your app is React, import the thin hooks from the **`@yolo-labs/app-sdk/react`**
subpath. React is an **optional peer dependency** — the core package never
imports it, so vanilla-HTML apps pay nothing, and the subpath is tree-shaken
away unless you import it.

```ts
import { useTileApp, useTileAppEvent, useTileAppCall, useRequestPermissions } from '@yolo-labs/app-sdk/react';

function Stitcher() {
  const app = useTileApp();                       // one client, destroyed on unmount
  const { call, pending, result } = useTileAppCall(app);

  useTileAppEvent(app, 'env-profile-applied', () => refreshKeyBadges());

  return <button disabled={pending} onClick={() => call('llm', 'invoke', { messages: [{ role: 'user', content: text }] })}>Ask</button>;
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

There is no credentials hook: a granted secret is attached to your server's
vendor requests by the platform and never reaches the browser.

---

### Your server: `createTileServerClient`

A backend on the `worker` or `container` placement makes the same calls as your UI,
through the broker, with the instance's own identity: the tile gateway injects its
server-to-broker token on the one broker route, so your code never holds a token.

```ts
import { createTileServerClient, type TileCaller } from '@yolo-labs/app-sdk';

const yolo: TileCaller = createTileServerClient({ brokerUrl: 'https://api.yolo.studio/v1', appId: 'my-app' });
const caps = await yolo.capabilities();          // null on a host without discovery
if (caps?.decisions.some((d) => d.permission === 'llm.invoke' && d.granted && d.surfaces.backend)) {
  const res = await yolo.llmInvoke({ messages: [{ role: 'user', content: 'Hello' }] });
}
```

`createTileApp()` (UI) and `createTileServerClient()` (server) both implement
`TileCaller` (`call`, `llmInvoke`, `llmDiscover`, `mcpCall`, `sendNotification`,
`capabilities`): refusals come back as `{ ok: false, reason, message }` (see
`TileAppDenyReason`), a timeout rejects `TimeoutError` and a cancelled `signal`
rejects `CancelledError`. Pod backends have no broker channel; use a container.

### Your server's storage: `createWorkerKv` / `createDirectoryKv`

Storage scope depends on where the app runs, so ask before you assume two tiles
share data. `capabilities()` returns a `storage` block:

| Placement | `storage.backend.scope` | API | Who shares it | Exported / deleted with the account |
|---|---|---|---|---|
| worker | `app-user` | key/value (`createWorkerKv`) | the user's every workspace and tile of this app | yes / yes |
| container | `instance` | `/data` directory | this tile only | no / no (kept as R2 archives) |
| first-party workspace pod | `instance` | `/data` directory | this tile only | no / no (lives with the workspace) |
| ui only | none | none | none | none |

`storage.browser.scope` is the UI's origin storage (localStorage, IndexedDB). On
`app-version-origin` (static, worker and container UIs) **each app version has its
own**: a new version doesn't see what an earlier one stored, and going back to a
version finds what was left there. Every workspace and every account signed in on
that browser shares it. Keep anything that matters on the server.

The portable subset is key/value, the same calls on both backends:

```ts
import { createWorkerKv, createDirectoryKv, isPortableKey } from '@yolo-labs/app-sdk';

// worker placement: tile data, reached through the gateway (no token, no binding)
const kv = createWorkerKv();
// container / workspace pod: the same calls on your /data directory
// const kv = createDirectoryKv({ dir: '/data/kv', fs: await import('node:fs/promises') });

await kv.put('notes/2026-10-11', JSON.stringify(note));
const page = await kv.list({ prefix: 'notes/', limit: 50 });   // key order; pass page.next as `after`
const text = await kv.getText('notes/2026-10-11');
```

Portable: keys of `/`-separated segments (`A-Z a-z 0-9 . _ ~ @ + = , -`, ≤ 512
characters; `isPortableKey`), string or byte values, prefix listing with paging,
`usage()`. A key is a value or a "folder" of other keys, never both. Not portable
(keep these on a `/data` placement): append, rename, partial writes, SQLite and
other in-place files, values over 10 MiB (the worker default), content types.
Errors are `TileKvError` with a `code` (`invalid_key`, `value_too_large`,
`quota_bytes`, `quota_keys`, `closed` after account deletion, `unavailable`).

On worker tile data, `getWithVersion(key)` returns a value with its version
(bumped by every write) and `put(key, value, { ifVersion })` writes only if the
key is still at that version (`0`: only if it doesn't exist yet); otherwise it
throws `precondition_failed`. Use it for read-modify-write, so two writers can't
both win. A `/data` directory store throws `unsupported` for both.

Moving an app from a `/data` placement to worker widens scope from one tile to
every workspace. The platform never does that silently: when more than one tile
instance holds data, the user picks which one moves, and an import never merges
into a store that already has data.

### Serving tools to agents: `createMcpProvider` (preview)

An app on the `worker` placement can serve the tools it declares in
`provides.mcp` to agents a user explicitly attached it to. This is behind
platform flags and a per-app allowlist; until your app is admitted,
`provides.mcp` is refused at publish.

```js
import { createMcpProvider, McpToolError } from '@yolo-labs/app-sdk';

const provider = createMcpProvider({
  tools: {
    read_note: async ({ noteId }, ctx) => {
      // ctx.scope.resourceIds: what the owner attached (e.g. vault ids). Enforce it.
      const note = await findNote(ctx.scope.resourceIds, noteId);
      if (!note) throw new McpToolError('note not found in the attached vault');
      return { text: note.body, structuredContent: note };
    },
  },
});

export default {
  fetch(request) {
    if (new URL(request.url).pathname === '/api/mcp') return provider(request);
    // ... your UI's own /api routes
  },
};
```

The platform's gateway terminates the agent's MCP session. It verifies the
caller, checks on every call that the attachment is still allowed, validates
the arguments against your pinned `inputSchema`, and forwards exactly one
`tools/call` to your `provides.mcp.path` with the caller context in
`x-yolo-mcp-*` headers. It strips those headers from every other request, so
`createMcpProvider` answers 403 to anything else, including your own UI.

- Read and write only what `ctx.scope.resourceIds` names. Never take an owner,
  workspace or resource id from the tool's arguments to widen it.
- Return text content (`{ text }` or `{ content: [{ type: 'text', text }] }`).
  Add `structuredContent` when the tool declares an `outputSchema`; the gateway
  checks it and the size cap.
- Throw `McpToolError` for an error the agent should see. Anything else becomes
  `internal_error`, and its message stays inside your app.

## 4. Manifest

Your app ships a manifest (`tileapp.json`) declaring
`id`, `version`, `publisher`, `displayName`, `surface`, `runtime`, and a
`permissions` block with `required[]` and `optional[]`.

```ts
import { validateManifest, KNOWN_PERMISSIONS } from '@yolo-labs/app-sdk';

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

### Placements: what works where

Where your app runs follows from its manifest: no `runtime` → **ui** (static
files); `runtime.kind: 'worker'` → **worker**; a `runtime` with a container
`image` and `isolation: 'dedicated'` → **container** (a third-party server needs
both); the workspace pod (**workspace**) is only for first-party apps. Ask at runtime
with `capabilities()`: each decision says whether it is enforced here and from
which surface (`ui` or `backend`).

| You need | ui | worker | container | workspace (first-party) |
|---|---|---|---|---|
| `llm.invoke`, `mcp.call`, `notifications.send` from the UI | yes | yes | yes | yes |
| …the same from your server | — | yes (`createTileServerClient`) | yes | no broker channel |
| `net:<host>` from your server | — | yes (gateway) | yes (gateway) | yes (pod egress) |
| `secret:<KEY>` | — | attached to its vendor host | attached to its vendor host | raw env (first-party) |
| Server storage | — | tile data, per app and user (`createWorkerKv`) | `/data`, per tile | `/data`, per tile |
| Workspace files | `mcp:studio.read_file:<folder>/**` via `mcp.call` | same | same | same |
| Open a web page | `link.open` (declared `links.open`) | same | same | same |

Not available anywhere: `fs.*` (retired), `media.*` (inert: use the browser's
file picker and downloads), embedding another site in a frame, OAuth sign-in
(see "Frames and sign-in").

**These guarantees hold with the platform's cutover profile on.** The platform
checks it with its preflight in cutover mode (`npm run tileapp:preflight --
--cutover`, with web, gateway and workspace evidence); among others it needs consent v2
(so a declaration nothing enforces is refused, not silently ignored), `fs.*`
retired, `mcp.call` and MCP file scopes on, first-party-only workspace pods with
measured isolation, and per-app origins. On a server without it, `capabilities()`
tells you which rows apply.

**Moving between placements.** Server storage changes scope: `/data` is per tile,
worker tile data is per app and user across workspaces. The platform never merges
several tiles' data into one store silently (see "Your server's storage"). Browser
storage is per origin: on ui, worker and container it is per app *version*, so a
new version doesn't see the old one's. Secrets change delivery (env → header): a
key that needs to be in the URL can't be delivered on worker or container.

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
- **A third-party app never holds a user's key.** A granted `secret:<KEY>` is
  attached by the platform to requests to that key's vendor host (worker and
  container placements); only a first-party app in the workspace pod receives the
  raw key in its server's environment. There is no SDK API that returns secret
  bytes. Keys a placement can't deliver are named in `withheldSecrets` (a required
  one refuses the launch); keys with no value yet in `missingSecrets`.
- **`work.*` capabilities are never app-grantable.** All `work.*` MCP scopes are
  `internal`. The SDK exposes no path to them.
- **Your tile stays on its own origin.** An app can open web pages inside its own
  tile (`location.href = …`, a `_self` link, a meta refresh) without any grant.
  Studio is closing this: its `frame-src` allowlist blocks frame navigations to
  non-tile origins once enforced. Until then, users are told on the consent
  screen. After any reload of the tile frame, the host may post a `host-hello`.
  The SDK answers it automatically (`host-hello-ack`). A host with the navigation
  guard on closes a reloaded frame that answers nothing from its launch origin.
  So an app that reloads itself without this SDK must send some bridge message
  within a few seconds of loading.

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
`KNOWN_PERMISSIONS`, and the optional **`@yolo-labs/app-sdk/react`** hooks.

**0.6.0** adds typed `llmInvoke` / `llmDiscover` helpers and the `Llm*` arg/payload
types (additive — `call()` is unchanged).

**Unreleased** adds the typed `mcpCall` helper, `McpCallArgs`, and the optional
`status` / `code` / `retryAfter` fields on a call result (present only on
`mcp.call` replies; additive).

**Unreleased** also answers the host's post-reload `host-hello` with
`host-hello-ack` (the navigation guard handshake; additive, nothing to call).

**Unreleased** also adds the server client (`createTileServerClient`, the
`TileCaller` interface shared with the UI), capability discovery
(`capabilities()`, with the `storage` contract), the portable storage helpers
(`createWorkerKv`, `createDirectoryKv`) and `validateManifest` refusing `links`
keys other than `open`.

Later phases, gated behind the YOLO Apps marketplace:

- **Host-mediated OAuth** — designed, not built (see "Frames and sign-in").
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

### Opening external links

Your tile's sandbox has no `allow-popups`, so `<a target="_blank">` and
`window.open` do nothing inside it. Ask the host to open the page instead.
Declare the pages you link to in your manifest:

```json
{"links":{"open":["https://github.com/*","https://gitlab.com/my-org/*"]}}
```

Each pattern is `https://` plus one exact host (no wildcard host, port or user
info) plus a path. A trailing `*` makes the path a prefix; without it the path
must match exactly. The consent screen lists the hosts ("can open links to
github.com, gitlab.com").

```ts
link.addEventListener('click', async (event) => {
  event.preventDefault(); // keep the <a href> visible as the copyable address
  const result = await app.openLink(link.href);
  if (!result.ok && result.reason !== 'user-declined') showAddress(link.href);
});
```

The host has Studio check the URL against your patterns and your app's grant
in this workspace. The first time your app opens a given host, it asks the user
("Open github.com in a new tab?", with an always-allow option, remembered for
that user). It then opens the page from Studio with no opener and no referrer.
Call it from a click: if the browser will not open a tab without one, the user
gets an "Open" prompt instead, and the result is `ok` only when a tab actually
opened. Refusals: `unknown-method` (the host does not offer `link.open`),
`invalid-args` (not `https:`, including `javascript:`, `data:` and `http:`),
`link-not-declared`, `app-not-installed` (your app's grant here is gone),
`user-declined`, `popup-blocked` (the browser refused the tab), and `busy`
(another confirm is open). `openLink(app, url)` is a variant that throws
a `LinkOpenError` instead. The wire call is `app.call('link', 'open', { url })`.

---

### Frames and sign-in

Embedding another site in a frame isn't supported: a manifest that asks for
one (`links.frame`, or any `links` key other than `open`) is refused at
publish, and on the ui, worker and container placements the tile's content
policy blocks frames (`frame-src 'none'`). Don't rely on frames working
anywhere else either. Signing in to another
service through OAuth isn't available to apps yet either; it will be run by the
host (new tab, Studio callback, token kept server-side), never by redirecting
your frame. Until then, use a declared `secret:` key or an MCP provider.

## Source & contributing

[github.com/yolo-labs-hq/app-sdk](https://github.com/yolo-labs-hq/app-sdk) is a public mirror of `packages/app-sdk` in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](./LICENSE).

### Server-held MCP calls and optional legacy pools

`app.mcpCall<T>({ scopes, path, method: 'POST', body })` uses the existing origin-safe
host bridge. The broker keeps its delegated token and returns route data/status;
`status`, `code` and `retryAfter` describe the inner MCP route even when the broker's
HTTP response is200. An upstream401/429, permission refusal or timeout does not
select a delegated-token fallback. The helper defaults/caps its own timeout at35s
(shorter explicit timeouts work); the global bridge default is unchanged.

`createMcpClient(app, { pools: { files: { scopes: ['studio.read_file'], remintOnForbidden: false } } })`
adds per-pool requests and throws `McpRequestError` for refused routes. Only an
explicit `unknown-method` reply selects its separately retained legacy
`mcp.mint-token` transport. That fallback exposes a delegated token to app code,
validates its workspace/expiry fields locally, and caches it per pool until30s
before expiry (maximum five minutes). Local JWT decoding does not authenticate the
signature or grant authority; the host/API still performs those checks. A direct
fallback401 re-mints/retries once;403 does so only when `remintOnForbidden` is not
false. Server-held route statuses never take that refresh path.

Each pool request has one35s wall-clock budget across preferred call, fallback
mint, fetch and the optional one retry. Later dispatches use only the remaining
budget. Concurrent mints share the first caller's deadline, so a later waiter can
safely fail early. Giving up does not prove cancellation of an already-dispatched
host operation. Fallback fetches use only the fixed relative
`/internal/mcp/workspaces/<encoded-token-workspace>/<route>` URL with redirects
refused. This needs same-origin host routing or a trusted supplied `fetch`
adapter; it is **not universal third-party iframe fallback compatibility**, and
no URL from a mint payload is trusted. Prefer `mcp.call` for third-party apps.

These source exports do not publish a new package version or update any generated,
vendored or deployed consumer. Actual app/host/API/container qualification remains
separate.

MCP errors preserve upstream payload/message data. This SDK is not a private-error
or credential-redaction boundary; the API owns reflected-token refusal and safe
error shaping. Do not infer that arbitrary error payloads are safe to log.

### Server-held MCP transport policy

The combined-source SDK defaults `createMcpClient` to `transportPolicy: 'server-held-only'`. It refuses an older/disabled host's `unknown-method` response without requesting a token. Enable and qualify the host's `mcp.call` before rebuilding a consumer with this default. An explicitly selected `transportPolicy: 'legacy-compatible'` retains older mint-token behavior for migration; it places a delegated bearer in app memory and does not carry the token-free security claim. Other errors never trigger fallback. This source change does not publish an npm package or rebuild existing consumers.

The five existing built-in bundles explicitly select legacy-compatible during migration so disabled/older hosts retain their existing behavior. They do not inherit the new token-free default by implication. Their vendored client must be regenerated from this exact source with scripts/generate-tileapp-sdk-vendor.mjs; drift tests remain mandatory.
