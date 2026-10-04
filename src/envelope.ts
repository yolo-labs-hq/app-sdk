/**
 * The postMessage wire contract between a YOLO App's iframe code and the host.
 *
 * This is the single source of truth for the envelope shapes the SDK sends and
 * receives. It mirrors the host's guards (`TileApp.tsx` /
 * `use-tile-app-bridge.ts` in the web app: `isBridgeCall`,
 * `isPermissionRequest`, the `bridge-reply` / `env-profile-applied` shapes).
 * Every message carries `__tileapp: true` as a coarse discriminator.
 *
 * Versioning stance (decided in the SDK design): the host owns
 * this contract and stays **additive-only FOREVER** — new optional fields / new
 * `kind`s only; existing fields are never removed, renamed, or repurposed. That
 * is the actual compatibility mechanism: a third-party app pins an SDK version
 * and runs against whatever host is deployed, so the host must keep accepting
 * what any old SDK sends and replying in the shape it expects. There is NO
 * negotiation handshake. `protocolVersion` (below) is stamped on outbound
 * messages purely as telemetry + a future escape hatch (if we are ever forced
 * to make a breaking change we can version-gate it, never the common path); the
 * host ignores it today. The protocol version is DECOUPLED from the SDK's npm
 * semver — it moves only on a breaking wire change (which we commit to avoiding).
 */

/** Stamped on outbound envelopes. Bumped ONLY on a breaking wire change (we keep
 *  the host additive-only, so in practice this stays 1). Not the SDK's npm
 *  version — see the versioning stance above. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

// ── iframe → host (SDK sends) ───────────────────────────────────────────────

/** A capability call the app makes; the host attaches the user token and
 *  forwards to the Capability Broker. */
export interface BridgeCallEnvelope {
  __tileapp: true;
  kind: 'bridge-call';
  id: string;
  capability: string;
  method: string;
  args?: unknown;
  /** = BRIDGE_PROTOCOL_VERSION. Telemetry / escape hatch, not negotiated. */
  protocolVersion?: number;
}

/** A runtime permission request — the host shows a consent dialog and, on
 *  accept, updates the grant. Replies arrive as a `bridge-reply` with this id. */
export interface RequestPermissionsEnvelope {
  __tileapp: true;
  kind: 'request-permissions';
  id: string;
  permissions: string[];
  /** = BRIDGE_PROTOCOL_VERSION. Telemetry / escape hatch, not negotiated. */
  protocolVersion?: number;
}

/** Ask the host for the app's own context (workspaceId, tileId, appId, theme).
 *  The host answers directly from state it already holds — no server round-trip,
 *  no token involved. Reply arrives as a `bridge-reply` with this id whose
 *  `payload` is the context object. Added 2026-07-18 (field retro: apps had no
 *  sanctioned way to learn their workspaceId and resorted to guessing). An older
 *  host that predates this kind simply never replies — the SDK's timeout
 *  surfaces that as a TimeoutError. */
export interface ContextRequestEnvelope {
  __tileapp: true;
  kind: 'context-request';
  id: string;
  /** = BRIDGE_PROTOCOL_VERSION. Telemetry / escape hatch, not negotiated. */
  protocolVersion?: number;
}

/** Request workspace Zen Mode for this tile. Host-local; no manifest permission. */
export interface ZenRequestEnvelope {
  __tileapp: true;
  kind: 'zen-request';
  id: string;
  action: 'enter' | 'exit' | 'status';
  protocolVersion?: number;
}

export interface DockPreview {
  label: string;
  value?: string;
  description?: string;
  progress?: number;
  countdownEndsAt?: number;
  actions?: { id: string; label: string; disabled?: boolean }[];
}
export interface DockPreviewEnvelope {
  __tileapp: true;
  kind: 'dock-preview';
  id: string;
  preview: DockPreview | null;
}
export function isDockAction(v: unknown): v is { __tileapp: true; kind: 'dock-action'; actionId: string } {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.__tileapp === true && m.kind === 'dock-action' && typeof m.actionId === 'string';
}
export function isDockPreviewRequest(v: unknown): v is { __tileapp: true; kind: 'dock-preview-request' } {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.__tileapp === true && m.kind === 'dock-preview-request';
}
export type OutboundEnvelope = { __tileapp: true; kind: 'title-bar-status'; id: string; text: string | null } | { __tileapp: true; kind: 'dock-pulse'; id: string } | DockPreviewEnvelope | ZenRequestEnvelope | BridgeCallEnvelope | RequestPermissionsEnvelope | ContextRequestEnvelope;

// ── host → iframe (SDK receives) ────────────────────────────────────────────

/** The host's reply to a `bridge-call` or `request-permissions`, correlated by
 *  `id`. The `{ ok, payload } | { ok:false, reason, message }` body is the
 *  broker's verbatim shape. */
export interface BridgeReplyEnvelope {
  __tileapp: true;
  kind: 'bridge-reply';
  id: string;
  /** OPTIONAL: a pre-broker host failure (expired token, workspace-access
   *  denial) is forwarded as a correlated reply whose body may lack `ok` and
   *  instead carry `error`. The client normalizes a non-`true` `ok` to a
   *  failure result rather than dropping the reply (which would hang the call). */
  ok?: boolean;
  payload?: unknown;
  reason?: string;
  message?: string;
  /** The API's error field on pre-broker failures (no structured `ok`). */
  error?: string;
}

/** Fired by the host after a new env-profile is applied to the session, so the
 *  app can refresh env-derived display state without a remount. */
export interface EnvProfileAppliedEnvelope {
  __tileapp: true;
  kind: 'env-profile-applied';
  profileId?: string;
  profileName?: string;
  envVarKeys?: string[];
}

/** Fired whenever this tile enters or exits workspace Zen Mode. */
export interface ZenStateChangedEnvelope {
  __tileapp: true;
  kind: 'zen-state-changed';
  active: boolean;
}

export type InboundEnvelope = BridgeReplyEnvelope | EnvProfileAppliedEnvelope | ZenStateChangedEnvelope;

/** The host → iframe event kinds the SDK surfaces via `app.on(kind, …)`. */
export type HostEventKind = 'env-profile-applied';

// ── guards (used on RECEIVED messages, which are attacker-influenceable) ─────

function isTileAppMessage(v: unknown): v is { __tileapp: true; kind: string } {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).__tileapp === true
    && typeof (v as Record<string, unknown>).kind === 'string';
}

export function isBridgeReply(v: unknown): v is BridgeReplyEnvelope {
  if (!isTileAppMessage(v)) return false;
  const m = v as Record<string, unknown>;
  // A correlated reply only needs the kind + id; `ok` may be absent on a
  // pre-broker host error (the client normalizes that to a failure result).
  return m.kind === 'bridge-reply' && typeof m.id === 'string';
}

export function isEnvProfileApplied(v: unknown): v is EnvProfileAppliedEnvelope {
  if (!isTileAppMessage(v)) return false;
  return (v as Record<string, unknown>).kind === 'env-profile-applied';
}

export function isZenStateChanged(v: unknown): v is ZenStateChangedEnvelope {
  if (!isTileAppMessage(v)) return false;
  const m = v as Record<string, unknown>;
  return m.kind === 'zen-state-changed' && typeof m.active === 'boolean';
}
