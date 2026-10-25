/**
 * Tile-app manifest types + a convenience validator for app publishers.
 *
 * The types mirror the platform's authoritative server-side manifest types
 * (`TileAppManifest` and friends in the server's `tileapp.ts`) — same
 * field names and optionality — so an app's `tileapp.json` is typed the same on
 * both sides of the boundary.
 *
 * `validateManifest` is a HAND-ROLLED, zero-dependency shape pre-check meant to
 * run locally (in the publisher CLI / a build step) so authors catch obvious
 * manifest mistakes BEFORE server-side ingest. The server re-validates
 * authoritatively (and applies the real policy/tiering/signature gates); this
 * is convenience, NOT the security gate. It is deliberately permissive about
 * unknown/extra fields — the platform manifest is additive.
 */

import { mcpProviderShapeErrors, type TileAppMcpProvider } from './mcp-provider-descriptor.js';

// ── Types (mirror of the server's tileapp.ts) ───────────────────────────────

/**
 * A permission is a namespaced, user-grantable capability. Plain strings on the
 * wire; see `KNOWN_PERMISSIONS` for the well-known catalog. Known shapes:
 *
 *   net:<host>                      e.g. net:api.elevenlabs.io      (never '*')
 *   secret:<KEY_NAME>               a key from the user's environment profile — see the note below
 *   mcp:<scope> / llm.invoke / notifications.send:<where> / device.<capability>
 *   fs.<read|readwrite>:<scope>     retired: refused where the platform runs `TILEAPP_FS_RETIRED`
 *   media.<upload|download>:<kind>  inert: does nothing (use the browser's file picker / downloads)
 *
 * `llm.invoke` is the SINGLE, provider-agnostic LLM permission — there is no
 * per-provider and no per-model permission, and a legacy `llm.invoke:<provider>`
 * still parses and folds into plain `llm.invoke`.
 *
 * 🚨 The permission is provider-agnostic; the CALL is not. `llm.invoke`'s
 * `model` field used to be discarded (the router picked by activity/tier). It is
 * now HONORED: `"provider/model"` is a hard pin, a bare model id is resolved
 * against the model catalog, and absent/`"auto"` keeps the platform's choice.
 * Model selection moved into the call args, not into the permission — granting
 * `llm.invoke` grants the whole catalog. See `llm.discover` (same permission) to
 * enumerate it, and the `LlmInvokeArgs` / `LlmDiscoverArgs` types in
 * `./client.js` for the wire shapes.
 */
export type TileAppPermission = string;

export type TileAppRisk = 'low' | 'medium' | 'high';

export interface TileAppSurface {
  /** v1 only supports 'iframe' (a sandboxed web UI). */
  kind: 'iframe';
  /** Entry document within the app bundle, e.g. 'index.html'. */
  entry: string;
  /** Preferred initial tile size. */
  tilePrefersSize?: { rowSpan: number; colSpan: number };
}

export interface TileAppImage {
  /** Registry path WITHOUT the tag, e.g. `registry.../tileapp-videostitcher`. */
  ref: string;
  /** Tag for human-readable pinning, e.g. `1.0.0`. */
  tag: string;
  /** SHA256 digest for content-addressed pinning. */
  digest?: string;
  /** Hint for UI + disk quota. */
  sizeBytes?: number;
}

/**
 * Where an app runs (CLOUDFLARE_APP_TILES_PLAN §4.2). The platform picks it
 * from the manifest; it is not a manifest field:
 *
 *   ui         no `runtime`: a pure UI served from its own origin, no server.
 *   worker     `runtime.kind: 'worker'`: the backend is an isolated edge worker
 *              (request/response JS). A personal app's version still being
 *              edited runs in live mode, for its owner only.
 *   container  `runtime` with `image` and `isolation: 'dedicated'` (or
 *              `'edge'`): the backend gets its own isolated machine, sized by
 *              `resources.instanceType`.
 *
 * Running inside the user's workspace is first-party workspace mode only; other
 * apps with a server use `worker` or `container`. The consent screen names the
 * placement in these words.
 */
export type TileAppPlacement = 'ui' | 'worker' | 'container';

export interface TileAppRuntime {
  /**
   * Runtime flavour. Absent or `'process'`: a process from `image` (the
   * `container` placement). `'worker'`: a request-driven edge backend (the
   * `worker` placement). See {@link TileAppPlacement}.
   */
  kind?: 'process' | 'worker';
  /** Port the app process listens on; proxied to the iframe surface. */
  port: number;
  /** Substring/regex matched against process stdout to detect ready. */
  readyPattern?: string;
  /** Disk quota for the app's working dir, e.g. '2Gi'. */
  workdirQuota?: string;
  /** Command override for the rare bare-process app; ignored when `image` is set. */
  exec?: string;
}

export interface TileAppPermissions {
  /** Must be granted at install or the app cannot be installed. */
  required: TileAppPermission[];
  /** Per-permission opt-in toggles; the app must degrade gracefully if declined. */
  optional?: TileAppPermission[];
}

/** See {@link TileAppManifest.links}. */
export interface TileAppLinks {
  open?: string[];
}

export interface TileAppManifest {
  id: string;
  version: string;
  displayName: string;
  // publisher / description / ui are REQUIRED by the authoritative server
  // validator (the server's tileapp.ts) — kept required here so the SDK
  // preflight can't pass a manifest the server will reject at ingest.
  publisher: string;
  description: string;
  ui: { icon: string; color: string; label: string };
  surface: TileAppSurface;
  /** Pure-UI apps (no server process) omit this. */
  runtime?: TileAppRuntime;
  /** OCI image the runtime launches for this app's server. Pure-UI apps omit it. */
  image?: TileAppImage;
  permissions: TileAppPermissions;
  /**
   * External pages the app may ask the host to open in a new tab
   * (`app.openLink(url)` / `openLink(app, url)`). Each pattern is
   * `https://<host><path>`: one exact host (no wildcard, port or user info) and a
   * path, where a trailing `*` makes the path a prefix — e.g.
   * `https://github.com/*`. The consent screen lists the hosts.
   */
  links?: TileAppLinks;
  /** What the app serves to others: `mcp`, tools for the workspace's agents (server-gated). */
  provides?: { mcp?: TileAppMcpProvider };
  /**
   * Declared resource ceiling — informs the consent screen + bounds the runtime.
   * `instanceType` is the `container` placement's machine size (`basic` when absent or unknown).
   */
  resources?: { cpu?: string; memory?: string; diskQuota?: string; instanceType?: string };
  /** Whether the app is installable. Disabled apps stay in the registry but are hidden. */
  enabled?: boolean;
  /** Marketplace discovery only; false preserves direct access and existing installs. Defaults to true. */
  marketplaceListed?: boolean;
  /**
   * Isolation for a server: `'dedicated'` (or `'edge'`) asks for the `container`
   * placement, its own machine. `'shared'` is first-party workspace mode only.
   */
  isolation?: 'shared' | 'dedicated' | 'edge';
  /** Ed25519 signature (base64) over the canonical manifest — P6 untrusted phase. */
  signature?: string;
  /** Id of the publisher key that produced `signature`. */
  publisherKeyId?: string;
}

// ── Known permission catalog ────────────────────────────────────────────────

/**
 * Well-known permission strings, for ergonomic reference instead of raw
 * literals. This is NOT exhaustive — the wire type is a free-form string and the
 * platform is additive — but it covers the common catalog of the marketplace
 * permissions model.
 *
 * NOTE on `secret:<KEY>`: how the key reaches your app depends on who published it and where it
 * runs, and a third-party app never receives the key itself. On the worker and container
 * placements the gateway attaches it to requests to the key's vendor host (a header); a
 * first-party app in the workspace pod gets it in its server's environment. A key the placement
 * can't deliver (no vendor descriptor, a key sent in the URL on the edge) is listed in the launch's
 * `withheldSecrets`; a required one refuses the launch. There is no API in this package that
 * returns secret bytes.
 */
export const KNOWN_PERMISSIONS = {
  /** @deprecated Does nothing: tile apps upload and download with the browser's file picker. Remove it (with consent v2 on, the platform refuses inert permissions). */
  MEDIA_UPLOAD_VIDEO: 'media.upload:video',
  /** @deprecated Does nothing: use the browser's downloads. Remove it. */
  MEDIA_DOWNLOAD_VIDEO: 'media.download:video',
  /** @deprecated Does nothing: use the browser's file picker. Remove it. */
  MEDIA_UPLOAD_AUDIO: 'media.upload:audio',
  /** @deprecated Does nothing: use the browser's downloads. Remove it. */
  MEDIA_DOWNLOAD_AUDIO: 'media.download:audio',
  /** @deprecated Does nothing: use the browser's file picker. Remove it. */
  MEDIA_UPLOAD_IMAGE: 'media.upload:image',
  /** @deprecated Does nothing: use the browser's downloads. Remove it. */
  MEDIA_DOWNLOAD_IMAGE: 'media.download:image',
  /** @deprecated `fs.*` is being retired. App data: your server's own storage (`/data`, or tile data on a worker). Workspace files: `mcp:studio.read_file:<folder>/**` through `mcp.call`. */
  FS_READWRITE_APP_DATA: 'fs.readwrite:app-data',
  /** @deprecated `fs.*` is being retired: use your server's own storage. */
  FS_READ_APP_DATA: 'fs.read:app-data',
  /** @deprecated `fs.*` is being retired: request `mcp:studio.read_file:<folder>/**` (and `mcp:studio.list_files:<folder>/**`) and call it through `mcp.call`. */
  FS_READ_WORKSPACE: 'fs.read:workspace',
  NOTIFICATIONS_SEND_GLOBAL: 'notifications.send:global',
  NOTIFICATIONS_SEND_WORKSPACE: 'notifications.send:workspace',
} as const;

/**
 * Build a `net:<host>` permission string for an egress host.
 *
 * The manifest's declared set is the CEILING: the host rejects any egress to a
 * host not present in the manifest's `permissions.optional` (or `required`), so
 * a `net()` string only works if the same host is declared in the manifest.
 * Wildcards are never allowed — name a specific host.
 */
export function net(host: string): TileAppPermission {
  return `net:${host}`;
}

// ── Permission grammar (mirror of the server's parsePermission) ─────────────

export interface ParsedPermission {
  raw: string;
  namespace: 'fs' | 'net' | 'mcp' | 'llm' | 'media' | 'secret' | 'device' | 'notifications';
  action?: string;
  arg?: string;
}

/**
 * Parse a permission string into its namespace/action/arg, or null if it isn't
 * a recognized shape. Mirrors the server's `parsePermission` (tileapp.ts)
 * so a manifest that passes this preflight uses well-formed permission strings.
 * (The server additionally validates that an `mcp:<scope>` names a real scope —
 * but `mcp:`/`work.*` are internal and never app-grantable, so third-party apps
 * don't use them; that catalog check stays server-authoritative.)
 */
export function parsePermission(raw: TileAppPermission): ParsedPermission | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const [head, ...argParts] = raw.split(':');
  const arg = argParts.length > 0 ? argParts.join(':') : undefined;
  const [ns, action] = (head ?? '').split('.');
  switch (ns) {
    case 'fs':
      if (action !== 'read' && action !== 'readwrite') return null;
      if (!arg) return null;
      return { raw, namespace: 'fs', action, arg };
    case 'net':
      if (action || !arg) return null;
      return { raw, namespace: 'net', arg };
    case 'mcp':
      if (action || !arg) return null;
      return { raw, namespace: 'mcp', arg };
    case 'llm':
      // llm.invoke — the single provider-agnostic LLM permission. A legacy
      // `llm.invoke:<provider>` still parses (the arg is carried but ignored at
      // enforcement, where it folds into plain `llm.invoke`). The PERMISSION
      // never names a model or provider — model choice lives in the call's
      // `model` field, where it is honored as a pin. Head must be EXACTLY
      // `llm.invoke`: bare is valid, but empty `llm.invoke:` and extra segments
      // `llm.invoke.foo` are rejected. Mirrors the server's parsePermission.
      if (head !== 'llm.invoke' || arg === '') return null;
      return { raw, namespace: 'llm', action, arg };
    case 'media':
      if (action !== 'upload' && action !== 'download') return null;
      if (!arg) return null;
      return { raw, namespace: 'media', action, arg };
    case 'secret':
      if (action || !arg) return null;
      return { raw, namespace: 'secret', action: arg };
    case 'notifications':
      if (head !== 'notifications.send' || (arg !== 'global' && arg !== 'workspace')) return null;
      return { raw, namespace: 'notifications', action, arg };
    case 'device':
      if (!action) return null;
      return { raw, namespace: 'device', action, arg };
    default:
      return null;
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

// Mirror of the server's id / version shape (tileapp.ts).
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

export type ManifestValidation =
  | { ok: true; manifest: TileAppManifest }
  | { ok: false; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a raw parsed-JSON value as a `TileAppManifest`. Collects EVERY error
 * (not fail-fast) so a publisher sees all problems at once. **Faithfully mirrors
 * the authoritative server validator** (`validateManifest` in the server's
 * tileapp.ts) — same shape AND semantic checks (id slug, semver,
 * surface kind, runtime/image rules, permission grammar, net-wildcard) and the
 * same error messages — so a manifest that passes here passes the server's
 * shape gate. It is still a CONVENIENCE pre-check: the server re-validates
 * authoritatively and adds policy/tiering/signature gates this can't see (and
 * the deep `mcp:`-scope catalog check stays server-side — apps don't use mcp).
 * Permissive about extra/unknown keys (the platform manifest is additive).
 *
 * Differences from the server: `secret:<KEY>` is checked for shape only
 * (UPPER_SNAKE_CASE); the server also requires a known environment-profile
 * preset and, with consent v2, a `runtime` to deliver it to. `mcp:work.*` grants
 * are refused (internal, never app-grantable); other `mcp:` scopes are deferred
 * to the server's per-scope classification.
 */
const MAX_LINK_PATTERNS = 32;
const LINK_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const LINK_HOST_RE = new RegExp(`^${LINK_LABEL}(?:\\.${LINK_LABEL})+$`);
const LINK_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()+,;=:@%/]*\*?$/;

/**
 * Why a `links.open` pattern is invalid, or null when it is valid: https only,
 * one exact lowercase DNS host (no wildcard, port or user info), a path that
 * may end in `*` (prefix) and has no other `*`, query, fragment or `.`/`..`
 * segment.
 */
export function linkPatternError(raw: string): string | null {
  const quoted = JSON.stringify(raw);
  if (!raw || raw.length > 512) return `link pattern must be 1-512 characters: ${quoted.slice(0, 80)}`;
  if (!raw.startsWith('https://')) return `link pattern must start with https:// (no http, javascript: or data:): ${quoted}`;
  const rest = raw.slice('https://'.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  if (host.includes('*')) return `link pattern must name one host, no wildcards: ${quoted}`;
  if (!LINK_HOST_RE.test(host) || !/[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))) {
    return `link pattern host must be a lowercase DNS name with no port or user info: ${quoted}`;
  }
  if (!path) return `link pattern needs a path, e.g. https://${host}/*: ${quoted}`;
  if (!LINK_PATH_RE.test(path)) return `link pattern path may use '*' only at the end, and no query or fragment: ${quoted}`;
  const literal = path.endsWith('*') ? path.slice(0, -1) : path;
  let normalized = '';
  try { normalized = new URL(`https://${host}${literal}`).pathname; } catch { /* stays '' */ }
  if (normalized !== literal) return `link pattern path is not in normal form (no '.' or '..' segments): ${quoted}`;
  return null;
}

/** Options for {@link validateManifest}. */
export interface ValidateManifestOptions {
  /**
   * Whether the target server has the `worker` placement on (default true, the
   * platform's cutover state). Off, the server treats `runtime.kind: 'worker'`
   * like any runtime: it needs an `image` or `runtime.exec`, and the worker-only
   * rules don't apply.
   */
  workerPlacement?: boolean;
  /**
   * The target server's TILEAPP_CONSENT_V2 (default false, as on servers today; pass
   * true — with `fsRetired` and `staticPlacement` — to check against the cutover profile): on, a
   * permission that would be granted and do nothing is refused at publish —
   * `media.*`, `device.*`, `net:` without a runtime, and a pure-UI app's
   * non-workspace `fs.*` where static placement is on. (Internal `mcp:` scopes are
   * refused there too; this pre-check can't classify scopes, so the server decides.)
   */
  consentV2?: boolean;
  /** The target server's TILEAPP_FS_RETIRED (default false): on, any `fs.*` is refused at publish. */
  fsRetired?: boolean;
  /** Whether the target server has the `static` placement on (default false). */
  staticPlacement?: boolean;
}

export function validateManifest(
  value: unknown,
  opts: ValidateManifestOptions = {},
): { ok: true; manifest: TileAppManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const workerPlacement = opts.workerPlacement !== false;
  const consentV2 = opts.consentV2 === true;
  const fsRetired = opts.fsRetired === true;
  const staticPlacement = opts.staticPlacement === true;
  if (!isObj(value)) return { ok: false, errors: ['manifest is not an object'] };

  if (!isStr(value.id) || !ID_RE.test(value.id)) {
    errors.push('id must be a lowercase kebab-case slug (2-64 chars)');
  }
  if (!isStr(value.version) || !SEMVER_RE.test(value.version)) {
    errors.push('version must be semver (e.g. 1.0.0)');
  }
  if (!isStr(value.displayName)) errors.push('displayName is required');
  if (!isStr(value.publisher)) errors.push('publisher is required');
  if (!isStr(value.description)) errors.push('description is required');
  if (!isObj(value.ui) || !isStr(value.ui.icon) || !isStr(value.ui.color) || !isStr(value.ui.label)) {
    errors.push('ui must have string icon, color, label');
  }

  // surface
  if (!isObj(value.surface)) {
    errors.push('surface is required');
  } else {
    if (value.surface.kind !== 'iframe') errors.push("surface.kind must be 'iframe' (v1)");
    if (!isStr(value.surface.entry)) errors.push('surface.entry is required');
    if (value.surface.tilePrefersSize !== undefined) {
      const s = value.surface.tilePrefersSize;
      if (!isObj(s) || typeof s.rowSpan !== 'number' || typeof s.colSpan !== 'number') {
        errors.push('surface.tilePrefersSize must be { rowSpan, colSpan }');
      }
    }
  }

  // runtime (optional)
  if (value.runtime !== undefined) {
    const rt = value.runtime;
    if (!isObj(rt)) {
      errors.push('runtime must be an object when present');
    } else {
      if (typeof rt.port !== 'number' || rt.port <= 0) errors.push('runtime.port must be a positive number');
      if (rt.exec !== undefined && !isStr(rt.exec)) errors.push('runtime.exec must be a non-empty string when present');
      if (rt.kind !== undefined && rt.kind !== 'process' && rt.kind !== 'worker') errors.push("runtime.kind must be 'process' | 'worker' when present");
    }
  }
  // Like the server, `runtime.kind: 'worker'` is a worker only where the worker placement is on.
  const workerRuntime = workerPlacement && isObj(value.runtime) && value.runtime.kind === 'worker';
  // A worker runs from the bundle's _worker/ modules: an image or exec would be ignored (the server refuses both at publish).
  if (workerRuntime && value.image !== undefined) errors.push("runtime.kind 'worker' runs from the bundle's _worker/ modules — remove `image`, it would be ignored");
  if (workerRuntime && isObj(value.runtime) && value.runtime.exec !== undefined) errors.push("runtime.kind 'worker' runs from the bundle's _worker/ modules — remove `runtime.exec`, it would be ignored");
  if (value.isolation !== undefined && value.isolation !== 'shared' && value.isolation !== 'dedicated' && value.isolation !== 'edge') {
    errors.push("isolation must be 'shared' | 'dedicated' | 'edge' when present");
  }

  // image (optional)
  if (value.image !== undefined) {
    const img = value.image;
    if (!isObj(img)) {
      errors.push('image must be an object when present');
    } else {
      if (!isStr(img.ref)) errors.push('image.ref is required (registry path without tag)');
      if (!isStr(img.tag)) errors.push('image.tag is required');
      if (img.digest !== undefined && !isStr(img.digest)) errors.push('image.digest must be a string when present');
      if (img.sizeBytes !== undefined && (typeof img.sizeBytes !== 'number' || img.sizeBytes < 0)) {
        errors.push('image.sizeBytes must be a non-negative number when present');
      }
    }
  }
  // A manifest with `runtime` must carry an `image` OR (legacy) `runtime.exec`.
  if (isObj(value.runtime) && !workerRuntime && value.image === undefined && !isStr(value.runtime.exec)) {
    errors.push('runtime requires either `image` (OCI image, recommended) or `runtime.exec` (bare-process override)');
  }

  // permissions — required array + each a well-formed permission string.
  const allPerms: unknown[] = [];
  if (!isObj(value.permissions)) {
    errors.push('permissions is required');
  } else {
    const { required, optional } = value.permissions;
    if (!Array.isArray(required)) errors.push('permissions.required must be an array');
    else allPerms.push(...required);
    if (optional !== undefined) {
      if (!Array.isArray(optional)) errors.push('permissions.optional must be an array when present');
      else allPerms.push(...optional);
    }
  }
  for (const p of allPerms) {
    if (typeof p !== 'string') { errors.push(`permission must be a string: ${JSON.stringify(p)}`); continue; }
    const parsed = parsePermission(p);
    if (!parsed) { errors.push(`unrecognized permission: '${p}'`); continue; }
    if (parsed.namespace === 'net' && (parsed.arg === '*' || parsed.arg?.includes('*'))) {
      errors.push(`net permission must name a specific host (no wildcards): '${p}'`);
    }
    // `secret:<KEY>`: a key from the user's environment profile. A third-party app never receives
    // the key itself: the platform attaches it to requests to its vendor host (P1.8). The server
    // checks the key is one it knows (an environment-profile preset); here only its shape.
    if (parsed.namespace === 'secret' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.action ?? '')) {
      errors.push(`secret permissions name an environment-profile key in UPPER_SNAKE_CASE: '${p}'`);
    }
    // mcp:work.* scopes are internal and never app-grantable (permissions model
    // §2.2). Reject those; OTHER mcp scopes are classified per-scope, so leave
    // their existence/grantability to the authoritative server validator rather
    // than duplicating (and drifting from) the scope catalog here.
    if (parsed.namespace === 'mcp' && (parsed.arg ?? '').startsWith('work.')) {
      errors.push(`mcp:work.* scopes are internal and not grantable to third-party apps: '${p}'`);
    }
    // Mirrors the server's publish refusals (validateManifestForPublish) for the target's flags.
    const hasRuntime = isObj(value.runtime);
    if (parsed.namespace === 'fs' && fsRetired) {
      errors.push(`fs.* permissions are retired: request a read-only MCP folder scope (mcp:studio.read_file:<folder>/**) and call it through mcp.call: '${p}'`);
    } else if (consentV2) {
      if (parsed.namespace === 'media') errors.push(`'${p}' does nothing: tile apps upload and download files with the browser's file picker. Remove it.`);
      if (parsed.namespace === 'device') errors.push(`'${p}' does nothing: tile apps have no device access through a permission. Remove it.`);
      if (parsed.namespace === 'net' && !hasRuntime) errors.push(`'${p}' does nothing for an app without a server (runtime). Remove it, or add a runtime that uses it.`);
      if (parsed.namespace === 'fs' && !hasRuntime && staticPlacement && parsed.arg !== 'workspace') {
        errors.push(`'${p}' does nothing for an app without a server: its UI runs from YOLO's edge and has no workspace data directory. Remove it.`);
      }
    }
  }

  // links (optional) — the same pattern rules as the server's
  // services/tileapp/link-patterns.ts and the host's link-open.ts.
  if (value.links !== undefined) {
    if (!isObj(value.links)) {
      errors.push('links must be an object when present');
    } else {
      // Only `open` (P2.1): sub-frames and OAuth are separate operations apps don't get yet.
      for (const k of Object.keys(value.links)) {
        if (k !== 'open') errors.push(`links.${k} isn't supported: an app opens external pages with links.open (a new tab). Embedding another site in a frame and signing in through OAuth aren't available to apps yet (see the link, frame and OAuth contract)`);
      }
    }
    if (isObj(value.links) && value.links.open !== undefined) {
      const open = value.links.open;
      if (!Array.isArray(open) || !open.every((p) => typeof p === 'string')) {
        errors.push('links.open must be an array of strings when present');
      } else {
        if (open.length > MAX_LINK_PATTERNS) errors.push(`links.open may declare at most ${MAX_LINK_PATTERNS} patterns`);
        for (const p of open) {
          const problem = linkPatternError(p);
          if (problem) errors.push(problem);
        }
      }
    }
  }

  // provides.mcp (serving tools to agents): the shape here; the server also requires its provider
  // flag, the per-app allowlist and the worker placement (docs/TILE_APP_MCP_PROVIDER_PLAN.md).
  errors.push(...mcpProviderShapeErrors(value.provides));

  if (value.resources !== undefined && !isObj(value.resources)) {
    errors.push('resources must be an object when present');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    errors.push('enabled must be a boolean when present');
  }
  if (value.marketplaceListed !== undefined && typeof value.marketplaceListed !== 'boolean') {
    errors.push('marketplaceListed must be a boolean when present');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: value as unknown as TileAppManifest };
}
