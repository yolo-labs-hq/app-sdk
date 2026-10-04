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

// ── Types (mirror of the server's tileapp.ts) ───────────────────────────────

/**
 * A permission is a namespaced, user-grantable capability. Plain strings on the
 * wire; see `KNOWN_PERMISSIONS` for the well-known catalog. Known shapes:
 *
 *   fs.<read|readwrite>:<scope>     e.g. fs.readwrite:app-data, fs.read:workspace
 *   net:<host>                      e.g. net:api.elevenlabs.io      (never '*')
 *   media.<upload|download>:<kind>  e.g. media.upload:video
 *   secret:<KEY_NAME>               first-party only — see note on KNOWN_PERMISSIONS
 *   mcp:<scope> / llm.invoke / device.<capability>
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

export interface TileAppRuntime {
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
  /** Declared resource ceiling — informs the consent screen + bounds the runtime. */
  resources?: { cpu?: string; memory?: string; diskQuota?: string };
  /** Whether the app is installable. Disabled apps stay in the registry but are hidden. */
  enabled?: boolean;
  /** Marketplace discovery only; false preserves direct access and existing installs. Defaults to true. */
  marketplaceListed?: boolean;
  /** Pod isolation tier (P6 untrusted phase): shared vs dedicated. */
  isolation?: 'shared' | 'dedicated';
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
 * NOTE: raw `secret:<KEY>` grants are FIRST-PARTY ONLY — they were killed for
 * third-party apps (marketplace Q5: raw key injection is `internal`). Third
 * parties use brokered credentials (a future SDK surface), so there is
 * deliberately no `secret:` helper here and no secret API in this package.
 */
export const KNOWN_PERMISSIONS = {
  MEDIA_UPLOAD_VIDEO: 'media.upload:video',
  MEDIA_DOWNLOAD_VIDEO: 'media.download:video',
  MEDIA_UPLOAD_AUDIO: 'media.upload:audio',
  MEDIA_DOWNLOAD_AUDIO: 'media.download:audio',
  MEDIA_UPLOAD_IMAGE: 'media.upload:image',
  MEDIA_DOWNLOAD_IMAGE: 'media.download:image',
  FS_READWRITE_APP_DATA: 'fs.readwrite:app-data',
  FS_READ_APP_DATA: 'fs.read:app-data',
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
 * Intentional, audience-correct divergences (this is the THIRD-PARTY
 * validator): it rejects ALL `secret:` grants (server accepts `secret:<preset>`
 * for first-party manifests — raw secrets are first-party-only, Q5; third
 * parties use brokered credentials) and `mcp:work.*` grants (internal, never
 * app-grantable). Other `mcp:` scopes are deferred to the server's per-scope
 * classification.
 */
export function validateManifest(
  value: unknown,
): { ok: true; manifest: TileAppManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
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
    }
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
  if (isObj(value.runtime) && value.image === undefined && !isStr(value.runtime.exec)) {
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
    // Raw secret injection is FIRST-PARTY ONLY (marketplace Q5). This SDK
    // targets third-party apps, which get user secrets via brokered credentials
    // (a future SDK surface), never raw bytes — so reject `secret:` here. (The
    // server accepts `secret:<preset>` for first-party manifests, which don't
    // use this SDK; this is an intentional, audience-correct divergence.)
    if (parsed.namespace === 'secret') {
      errors.push(`secret permissions are not available to third-party apps — use brokered credentials (raw 'secret:' injection is first-party only): '${p}'`);
    }
    // mcp:work.* scopes are internal and never app-grantable (permissions model
    // §2.2). Reject those; OTHER mcp scopes are classified per-scope, so leave
    // their existence/grantability to the authoritative server validator rather
    // than duplicating (and drifting from) the scope catalog here.
    if (parsed.namespace === 'mcp' && (parsed.arg ?? '').startsWith('work.')) {
      errors.push(`mcp:work.* scopes are internal and not grantable to third-party apps: '${p}'`);
    }
  }

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
