/**
 * createTileApp — the typed, origin-safe bridge a YOLO App's iframe code uses
 * to talk to the host. Replaces the hand-rolled postMessage every app would
 * otherwise write.
 *
 * Security properties this owns so app authors can't get them wrong:
 *  - It NEVER touches the user token. The host attaches it in trusted parent
 *    code; the iframe never receives it and this SDK has no token API.
 *  - It PINS the host origin and DROPS any message from a different origin, and
 *    posts ONLY to the pinned origin — never `'*'` (the gap in the hand-rolled
 *    videostitcher client). This is the single most important correctness
 *    property. See §4 of the plan.
 *  - It is a convenience layer over an enforcement boundary it cannot weaken:
 *    the host rejects permissions not declared in the manifest, and the broker
 *    enforces the granted set server-side on every call regardless of what is
 *    sent. A malicious app skipping the SDK gains nothing.
 */
import type {
  BridgeReplyEnvelope,
  EnvProfileAppliedEnvelope,
  HostEventKind,
  OutboundEnvelope,
  OutboundRequestEnvelope,
} from './envelope.js';
import { isBridgeReply, isEnvProfileApplied, isZenStateChanged, BRIDGE_PROTOCOL_VERSION } from './envelope.js';
import { isDockAction, isDockPreviewRequest, isHostHello, type DockPreview } from './envelope.js';

// ── Call timeout defaults ───────────────────────────────────────────────────
//
// 🚨 CROSS-PACKAGE LOCKSTEP. The client must not give up before the SERVER does.
// A tile-app `llm.invoke` runs on the platform's clock: the broker forwards to
// the router and, when the completion comes back, SETTLES CREDITS against the
// served model. If this SDK abandons the call first, the app never sees the
// completion but the account is still debited for work the platform genuinely
// performed and paid for upstream.
//
// So the default here is deliberately LARGER than the server's ceiling. The two
// values live in different codebases (this package is published standalone and
// cannot import from the server), so the ordering is pinned by a server-side test
// that reads BOTH sources: `llm-gateway.timeout-lockstep.test.ts`.

/**
 * MIRROR of the platform's per-forward ceiling —
 * `DEFAULT_TILEAPP_LLM_TIMEOUT_MS` in the server's `credits.ts`, the
 * default for the `TILEAPP_LLM_TIMEOUT_MS` env var that the server's
 * `llm-gateway.ts` aborts on.
 *
 * Changing that constant without changing this one reopens the window where the
 * platform charges for a completion the app threw away. The lockstep test fails
 * on exactly that.
 */
const GATEWAY_LLM_TIMEOUT_MS = 60_000;

/**
 * Headroom over the server's ceiling: the host bridge hop, the broker's own
 * pre/post-forward work (reserve, settle) and message-port latency all sit
 * outside the gateway's abort timer. With this margin the server always gives up
 * first, so a timeout the app observes is a call that was never billed as
 * delivered.
 */
const CALL_TIMEOUT_MARGIN_MS = 15_000;

/** Default per-call timeout: 75s (60s gateway ceiling + 15s margin). */
const DEFAULT_CALL_TIMEOUT_MS = GATEWAY_LLM_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS;

/** The broker's verbatim reply shape — `call()` resolves this union; the caller
 *  branches on `.ok`.
 *
 *  Generic in the payload so the typed helpers below (`llmInvoke`,
 *  `llmDiscover`) can hand back a known shape. Defaults to `unknown`, so the
 *  plain `call()` signature is unchanged. */
/**
 * Why a call came back `ok: false` (mirror of the server's `BrokerDenyReason`,
 * plus the host's own bridge refusals). Widened with `string`: the union is
 * additive, so handle unknown reasons generically.
 *
 *  - `app-not-installed` / `app-not-found` / `permission-not-granted` (`permission` names it)
 *  - `unknown-capability` / `unknown-method`: this host doesn't have it (older host or flag off)
 *  - `invalid-args`, `rate-limited`, `spend-cap-reached`, `insufficient-credits`
 *  - `upstream-not-configured` / `upstream-failed` / `upstream-status` / `timeout`
 *  - `model-not-found` / `model-unavailable` (llm)
 *  - `placement-unsupported`: not available where the app runs (e.g. `fs.*` from an edge backend)
 *  - `deprecated`: retired (e.g. `mcp.mint-token`: use `mcp.call`)
 *  - host: `user-declined`, `busy`, `link-not-declared`, `reconsent-required`, `install-failed`, `not-focused`, `unauthorized`
 */
export type TileAppDenyReason =
  | 'app-not-installed' | 'app-not-found' | 'permission-not-granted'
  | 'unknown-capability' | 'unknown-method' | 'invalid-args'
  | 'upstream-not-configured' | 'upstream-failed' | 'upstream-status' | 'timeout'
  | 'spend-cap-reached' | 'rate-limited' | 'insufficient-credits'
  | 'model-not-found' | 'model-unavailable'
  | 'placement-unsupported' | 'deprecated'
  | 'user-declined' | 'busy' | 'link-not-declared' | 'reconsent-required' | 'install-failed' | 'not-focused' | 'unauthorized'
  | 'not-implemented' | 'unavailable' | 'popup-blocked'
  | (string & {});

export interface TileAppCallResult<TPayload = unknown> {
  ok: boolean;
  payload?: TPayload;
  reason?: TileAppDenyReason;
  message?: string;
  status?: number;
  code?: string | null;
  retryAfter?: number | null;
  permission?: string;
}

export interface TileAppCallOptions {
  /**
   * Per-call timeout in ms (overrides the client default).
   *
   * ⚠️ A value SHORTER than the platform's own ceiling (60s for `llm.invoke`)
   * can leave you charged for work you never receive: giving up here does not
   * cancel the upstream completion, and the broker still settles credits against
   * the model that actually ran. That cost was really incurred — the platform
   * paid for those tokens. The default ({@link CreateTileAppOptions.defaultTimeoutMs})
   * is sized so the server always gives up first; shorten it per call only when
   * you would rather pay for a late answer than wait for it.
   */
  timeoutMs?: number;
  /**
   * Cancels the call: it rejects with {@link CancelledError}. Like the timeout, this
   * stops waiting; it doesn't undo work the platform already started.
   */
  signal?: AbortSignal;
}

/** Result of an accepted `requestPermissions`. */
export interface PermissionGrant {
  grantedPermissions: string[];
  newlyGranted: string[];
}

/** Error thrown by `requestPermissions` on a non-accept outcome. `reason` is the
 *  host's machine code (`'user-declined' | 'invalid-args' | 'timeout' | …`). */
export class PermissionRequestError extends Error {
  readonly reason: string | undefined;
  constructor(message: string, reason: string | undefined) {
    super(message);
    this.name = 'PermissionRequestError';
    this.reason = reason;
  }
}

export interface CreateTileAppOptions {
  /**
   * Default per-call timeout (ms). Default **75000** — the platform's own
   * `llm.invoke` ceiling (60s) plus margin, so the SERVER always gives up before
   * this client does.
   *
   * That ordering is the point, not the number. A shorter default (this was
   * 30000 through v0.6.0) discards a completion the server is still settling —
   * the app sees a timeout and the account is debited anyway, for a result it
   * never received. Lower it only if you accept being billed for late answers.
   */
  defaultTimeoutMs?: number;
  /**
   * Timeout for a permission prompt (ms). Default 600000 (10 min). Permission
   * requests are USER-gated (a host dialog), so they must NOT inherit the
   * broker-call timeout — a user can take far longer than a minute, and timing
   * out while the dialog is still open would orphan the request. The host always
   * replies (accept / decline / dismiss); this is only a host-crash safety net.
   */
  permissionTimeoutMs?: number;
  /**
   * Explicitly pin the host origin (e.g. `'https://yolo.studio'`). When omitted
   * the SDK derives it, in order, from: `document.referrer` (the page that
   * embedded the iframe), then `location.ancestorOrigins[0]` (the parent origin
   * in Chromium/WebKit — referrer-independent). The tile-app iframe runs in
   * Chromium with `allow-same-origin`, so one of these is normally present. Only
   * if BOTH are unavailable (e.g. a referrer-stripped non-Chromium embedding)
   * must you pass this explicitly — otherwise the first outbound `call()` /
   * `requestPermissions()` can't target the host and throws.
   */
  hostOrigin?: string;
}

/**
 * The app's own context, answered by the host from state it already holds.
 * `theme` is the host UI theme the tile renders inside ('dark' today — the
 * host is dark-only; the field exists so a future light theme is additive).
 */
export interface TileAppContext {
  workspaceId: string;
  tileId: string;
  /** null when the hosting tile carries no app identity (shouldn't happen for a real app tile). */
  appId: string | null;
  theme: string;
}

// ── llm.invoke / llm.discover ───────────────────────────────────────────────
//
// Both ride the SINGLE provider-agnostic `llm.invoke` permission. There is no
// `llm.discover` permission and no per-provider permission: a legacy
// `llm.invoke:<provider>` grant still parses and folds into plain `llm.invoke`.
// Model choice moved into the CALL (the `model` field below), never into the
// permission.

/** One OpenAI-chat message. `content` may be a string or a content-part array. */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  content: unknown;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

/**
 * `llm.invoke` args — a thin OpenAI `/v1/chat/completions` body.
 *
 * Two fields the broker treats specially:
 *  - `model` — see {@link LlmInvokeArgs.model}. Model selection lives HERE.
 *  - `stream` — forced to `false` server-side (the bridge is request/response),
 *    and `stream_options` is dropped with it. Don't send either.
 */
export interface LlmInvokeArgs {
  /**
   * Which model to run. **Honored** — this is not an advisory hint.
   *
   *  - absent / `''` / `'auto'` → the platform routes by activity + tier
   *    (the long-standing default; unchanged).
   *  - `'provider/model'` (an `id` from {@link LlmDiscoverModel}) → a HARD PIN,
   *    validated against the model catalog. There is no fallback: an unknown
   *    pair is `model-not-found` (400), a real-but-unreachable pair is
   *    `model-unavailable` (409).
   *  - a bare model id (no `/`) → resolved against the catalog. Exactly one
   *    match pins it; several providers serving it is `invalid-args` naming the
   *    candidates; NO match falls back to auto-routing with a
   *    {@link LlmModelFallbackNotice} on the payload — deliberately a warning,
   *    not an error, because apps in the wild already send ignored ids.
   *
   * Prefer the `provider/model` form from `llm.discover` — pass the row's `id`
   * back VERBATIM. Reconstructing it from `provider` + `model` by hand is one
   * string-join bug away from an unpinnable request.
   */
  model?: string;
  messages: LlmChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

/**
 * Present on the `llm.invoke` payload ONLY when a bare `model` id could not be
 * resolved and the call was auto-routed instead of refused. `requested` echoes
 * your string verbatim so you can grep for it.
 */
export interface LlmModelFallbackNotice {
  requested: string;
  /** `not-in-catalog` — the id matched nothing. `catalog-unavailable` — the catalog could not be read. */
  reason: 'not-in-catalog' | 'catalog-unavailable';
}

export interface LlmInvokeChoice {
  index?: number;
  finish_reason?: string | null;
  message?: {
    role?: string;
    /**
     * The answer. When a reasoning model finishes a normal stop with empty
     * `content` and the answer stranded in `reasoning_content`, the broker
     * promotes it here — so this is the one field to read.
     */
    content?: string | null;
    reasoning_content?: string | null;
    refusal?: string | null;
    tool_calls?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * The router's completion body, returned VERBATIM as `payload` (OpenAI-chat
 * shape on every lane — an Anthropic-native model is translated for you, so
 * your app never sees an Anthropic body).
 */
export interface LlmInvokePayload {
  id?: string;
  /** The model that actually served the call. */
  model?: string;
  choices?: LlmInvokeChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
  };
  /** Only present on a bare-id fallback — see {@link LlmModelFallbackNotice}. */
  modelFallback?: LlmModelFallbackNotice;
  [key: string]: unknown;
}

/** `llm.discover` filters. Every field is optional; `{}` lists the catalog. */
export interface LlmDiscoverArgs {
  /** Free text over displayName / description / model id / family / tags. EVERY whitespace-separated term must match. */
  query?: string;
  /** AND-filter over capability keys, e.g. `['vision','tools']`. */
  capabilities?: Array<'vision' | 'tools' | 'jsonMode' | 'reasoning' | (string & {})>;
  /** Exact family match, case-insensitive: `'claude'`, `'qwen'`, `'gemini'`, … */
  family?: string;
  minContextWindow?: number;
  /** Price ceiling in CREDITS per million output tokens (not USD), markup included. */
  maxCreditsPerMTokOutput?: number;
  /** Default false — unreachable models are omitted unless you ask for them. */
  includeUnavailable?: boolean;
  /** Default 50, clamped to [1, 200]. Out-of-range values are clamped, never rejected. */
  limit?: number;
}

export interface LlmModelCapabilities {
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  /** Always `false` — the broker is request/response and cannot relay a stream. */
  streaming: boolean;
}

/** Credits per MILLION tokens. Markup INCLUDED, so a quote multiplies out to the real debit. */
export interface LlmModelCreditRates {
  perMTokInput: number;
  perMTokOutput: number;
  perMTokCachedInput: number;
}

/** Why a catalogued model cannot serve a call right now. */
export type LlmModelUnavailableReason =
  | 'not-routable'
  | 'blacklisted'
  | 'key-unavailable'
  | (string & {});

export interface LlmDiscoverModel {
  /** `"provider/model"`. PASS THIS BACK VERBATIM as `llm.invoke`'s `model`. */
  id: string;
  provider: string;
  model: string;
  displayName: string;
  family: string;
  description: string;
  capabilities: LlmModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
  speed: 'fast' | 'balanced' | 'slow' | (string & {});
  quality: 'basic' | 'good' | 'frontier' | (string & {});
  tags: string[];
  credits: LlmModelCreditRates;
  /**
   * ROUTABLE, not "will serve right now". True means an enabled tile-app
   * routing rule declares this model and it is not blacklisted — facts the
   * platform can see. It does NOT reflect provider-key presence, circuit
   * breakers, or budget pressure, which live in the router and are not visible
   * to the catalog.
   *
   * So `available: true` can still be followed by a `model-unavailable` (409)
   * on invoke, for a runtime reason discovery could not see. Handle that 409;
   * it is retryable and usually transient. `false` is authoritative.
   */
  available: boolean;
  /** Why it is not routable. Only set when `available` is false. */
  unavailableReason: LlmModelUnavailableReason | null;
  /** Which router lane serves it. Informational — the broker picks the lane for you. */
  wireFormat: 'openai-chat' | 'anthropic-messages' | (string & {});
}

/**
 * The caller's credit position, so a discovery call doubles as a budget check.
 *
 * `null` figures mean UNMETERED (enterprise), never zero — rendering a null as
 * `0` tells an account with no bound at all that it is broke.
 */
export interface LlmDiscoverCredits {
  /** Spendable now = `allowanceRemaining + max(0, purchasedRemaining)`. `null` when unmetered. */
  balance: number | null;
  allowanceCredits: number | null;
  allowanceRemaining: number | null;
  /** May be NEGATIVE after a refund clawback of already-spent credits. */
  purchasedRemaining: number;
  unmetered: boolean;
  /** `YYYY-MM` (UTC) the allowance figures belong to. */
  period: string;
}

export interface LlmDiscoverPayload {
  models: LlmDiscoverModel[];
  /** `null` when the balance could not be read — the models are still valid. */
  credits: LlmDiscoverCredits | null;
  /** Hand-bumped stamp; compare it to tell "the catalog changed" from "my filter changed". */
  catalogVersion: string;
}

/**
 * Machine-readable refusal codes an `llm.*` call can come back with, in
 * `TileAppCallResult.reason`. Widened with `string` because the broker's union
 * is additive.
 *
 *  - `model-not-found` (400) — you pinned an explicit `provider/model` that is
 *    not in the catalog. Fix the id; `llm.discover` lists the valid ones.
 *  - `model-unavailable` (409) — a REAL pair that cannot serve right now
 *    (blacklisted, breaker open, key missing, budget-shed). Retry, or pick
 *    another model. Transient — do not treat it as a bad id.
 *  - `insufficient-credits` (402) — the account balance cannot cover the call.
 *  - `spend-cap-reached` (402) — this app's own monthly USD cap, a separate
 *    bound from credits. Both must pass.
 *  - `permission-not-granted` (403) — `llm.invoke` was never granted.
 */
export type LlmDenyReason =
  | 'model-not-found'
  | 'model-unavailable'
  | 'insufficient-credits'
  | 'spend-cap-reached'
  | 'permission-not-granted'
  | 'invalid-args'
  | 'upstream-failed'
  | 'upstream-not-configured'
  | (string & {});

// ── capabilities.get ────────────────────────────────────────────────────────

/** Mirror of the server's capability contract (`tileapp-capabilities/v1`). Additive: ignore unknown fields. */
export interface TileAppCapabilityDecision {
  permission: string;
  family: 'net' | 'secret' | 'mcp' | 'llm' | 'notifications' | 'fs' | 'media' | 'device' | 'other' | (string & {});
  required: boolean;
  /** Whether this install holds it. */
  granted: boolean;
  /** `enforced`: something acts on it here; `refused`: install refuses it; `inert`: accepted, does nothing; `unavailable`: not delivered here. */
  state: 'enforced' | 'refused' | 'inert' | 'unavailable' | (string & {});
  enforcement?: { by: string; [k: string]: unknown };
  reason?: string;
  /** Which surface can use it where the app runs: the UI (this bridge) and/or the app's server. */
  surfaces: { ui: boolean; backend: boolean };
  vendorHost?: string;
  /** A required permission whose absence here refuses the launch. */
  blocksLaunch?: true;
}

export interface TileAppCapabilities {
  version: string;
  /** Internal hosting placement (`static`, `worker`, `container`, `pod`, `pod-static`), or null when it can't run here. */
  placement: string | null;
  /** `running`: where this tile's instance runs now; `prospective`: where a new launch would run. */
  basis?: 'running' | 'prospective' | (string & {});
  decisions: TileAppCapabilityDecision[];
  implicit: Array<{ id: string; surfaces: { ui: boolean; backend: boolean }; available: boolean; note: string; hosts?: string[] }>;
  ambient: { navigation: string; isolation: string | null; podLoopback: string | null };
  /** Where this tile's state lives and who shares it (P1.7). Absent from servers that predate it. */
  storage?: TileAppStorageContract;
}

/**
 * Browser scopes: `app-version-origin` (each app version has its own, shared by every
 * workspace and account on the browser), `app-origin`,
 * `shared-origin` (every pod-hosted UI can read it), `workspace-preview-origin`.
 * Backend scopes: `app-user` (worker tile data: the same in every workspace) or
 * `instance` (this tile's `/data`). The portable key/value API: `createWorkerKv` / `createDirectoryKv`.
 */
export interface TileAppStorageContract {
  browser: { scope: 'app-version-origin' | 'app-origin' | 'shared-origin' | 'workspace-preview-origin' | (string & {}) | null; note: string };
  backend: {
    scope: 'app-user' | 'instance' | (string & {}) | null;
    api: 'kv' | 'directory' | (string & {}) | null;
    quota: { maxBytes: number; maxKeys?: number; maxValueBytes?: number } | null;
    exportable: boolean;
    deletedWithAccount: boolean;
    note: string;
  };
}

/** In-app delivery surfaces. `both` is one notification with shared read/dismiss state. */
// ── mcp.call ────────────────────────────────────────────────────────────────

/**
 * `mcp.call` args. The broker checks every scope against the grant, mints a
 * token with exactly those scopes server-side, calls the MCP route in your
 * workspace and returns its answer — the token never reaches the app.
 */
export interface McpCallArgs {
  /** The `mcp:` scopes this call needs, without the `mcp:` prefix. Each must be granted. */
  scopes: string[];
  /** Relative MCP route path, e.g. `/kanban/board/get`. No scheme, host, query, `..` or encoding. */
  path: string;
  /** Defaults to `POST`. */
  method?: 'POST' | 'GET';
  /** JSON body for a `POST`. */
  body?: unknown;
}

/**
 * Refusal reasons specific to `mcp.call`, on top of the usual broker ones
 * (`permission-not-granted`, `invalid-args`, `unknown-method` while the host has
 * it switched off):
 *  - `upstream-status` — the MCP route answered non-2xx; read `status`, `code`
 *    and, for a 429, `retryAfter`.
 *  - `timeout` — no answer within 30 s; `status` is 504.
 */
export type McpCallDenyReason = 'upstream-status' | 'timeout';

export type TileAppNotificationDestination = 'global' | 'workspace' | 'both';
export interface SendNotificationArgs {
  destination: TileAppNotificationDestination;
  title: string;
  message: string;
  /** Stable identifier for this occurrence; reuse when retrying the same event. */
  eventId: string;
}
export interface SendNotificationPayload {
  notificationId: string | null;
}

export interface TileApp {
  dock: {
    /** Request one gentle pulse. Host limits requests to once per minute per tile. */
    pulse(opts?: TileAppCallOptions): Promise<TileAppCallResult<{ pulsed: boolean }>>;
    setPreview(preview: DockPreview | null, opts?: TileAppCallOptions): Promise<TileAppCallResult>;
    onAction(handler: (actionId: string) => void): () => void;
  };
  titleBar: {
    /** Plain single-line status, up to 32 characters. Null clears it. */
    setStatus(text: string | null, opts?: TileAppCallOptions): Promise<TileAppCallResult>;
  };
  /** Expand this focused app in workspace Zen Mode, preserving its running iframe.
   * Invoke from a user action. This is workspace presentation, not browser fullscreen. */
  zen: {
    enter(opts?: TileAppCallOptions): Promise<TileAppCallResult<{ active: boolean }>>;
    exit(opts?: TileAppCallOptions): Promise<TileAppCallResult<{ active: boolean }>>;
    status(opts?: TileAppCallOptions): Promise<TileAppCallResult<{ active: boolean }>>;
    onChange(handler: (active: boolean) => void): () => void;
  };
  /**
   * Invoke a host capability. The host attaches your user token server-side and
   * forwards to the Capability Broker; you get the broker's verbatim reply.
   */
  call(capability: string, method: string, args?: unknown, opts?: TileAppCallOptions): Promise<TileAppCallResult>;
  /**
   * Typed `llm.invoke`. Exactly `call('llm', 'invoke', args)` with the shapes
   * above attached — no extra round-trip, no client-side validation.
   * Requires the `llm.invoke` permission.
   */
  llmInvoke(args: LlmInvokeArgs, opts?: TileAppCallOptions): Promise<TileAppCallResult<LlmInvokePayload>>;
  /**
   * Typed `llm.discover` — enumerate the models this app can pin, with credit
   * prices (markup included) and the account's balance. Read-only, spends
   * nothing, and requires the SAME `llm.invoke` permission (there is
   * deliberately no separate discovery permission). `llm.browse` is accepted as
   * an alias server-side.
   */
  llmDiscover(args?: LlmDiscoverArgs, opts?: TileAppCallOptions): Promise<TileAppCallResult<LlmDiscoverPayload>>;
  /** Server-held MCP call; returns route data/status, default/capped35s (shorter override allowed). */
  mcpCall<TPayload = unknown>(args: McpCallArgs, opts?: TileAppCallOptions): Promise<TileAppCallResult<TPayload>>;
  /** Send a permission-gated notification to Studio's bell, workspace bar, or both. */
  sendNotification(args: SendNotificationArgs, opts?: TileAppCallOptions): Promise<TileAppCallResult<SendNotificationPayload>>;
  /**
   * Typed `link.open` — exactly `call('link', 'open', { url })`. The host opens
   * an `https://` URL that matches your manifest's `links.open` patterns in a
   * new tab, after asking the user once per host. Call it from a click. Refusals
   * (`unknown-method` on hosts without it, `invalid-args`, `link-not-declared`,
   * `user-declined`, `busy`) come back as `ok: false`. See {@link openLink} in
   * `./link.js` for a throwing variant.
   */
  openLink(url: string, opts?: TileAppCallOptions): Promise<TileAppCallResult<{ opened: true; host: string }>>;
  /**
   * What this app can do where it runs (`capabilities.get`): each declared
   * permission's state, whether it is granted and which surface can use it, the
   * implicit capabilities and the ambient disclosures. Resolves null on a host
   * without discovery (`unknown-capability` / `unknown-method`), so feature-detect
   * rather than assume. Needs no permission.
   */
  capabilities(opts?: TileAppCallOptions): Promise<TileAppCapabilities | null>;
  /**
   * The app's own context (workspaceId, tileId, appId, theme), answered by the
   * host with no server round-trip. Cached after the first successful reply.
   * Throws {@link TimeoutError} against a host that predates the context
   * envelope (older deployments never reply) — treat that as "context
   * unavailable" and degrade, don't retry in a loop.
   */
  getContext(opts?: TileAppCallOptions): Promise<TileAppContext>;
  /**
   * Ask the user to grant additional permissions (must be in the manifest's
   * `optional` set). Resolves the new grant on accept; rejects with a
   * {@link PermissionRequestError} otherwise.
   */
  requestPermissions(permissions: string[]): Promise<PermissionGrant>;
  /** Subscribe to a host → app event. Returns an unsubscribe function. */
  on(kind: HostEventKind, handler: (event: EnvProfileAppliedEnvelope) => void): () => void;
  /** Tear down: remove the message listener and reject all in-flight calls. */
  destroy(): void;
}

interface Pending {
  resolve: (reply: BridgeReplyEnvelope) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Removes this call's abort listener from its signal; run on every settlement. */
  unlisten?: () => void;
}

// The host holds ONE pending permission request per tile (iframe), so the
// single-flight lock must be shared across ALL clients in this iframe — a
// per-client flag wouldn't stop two clients from both prompting and orphaning
// the first. One module instance == one iframe, so module scope is iframe scope.
let modulePermissionInFlight = false;

export function createTileApp(options: CreateTileAppOptions = {}): TileApp {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 600_000;
  // The pinned host origin: explicit option → the parent's origin via
  // ancestorOrigins (Chromium/WebKit; authoritative + navigation-independent) →
  // document.referrer (fallback; only correct on the FIRST page load — after an
  // in-iframe navigation the referrer is the app's own prior page, not the host,
  // so originFromReferrer ignores same-app referrers). null ⇒ still unknown, in
  // which case we can RECEIVE (adopting the first parent-sourced message's
  // origin) but can't safely send until the host is identified.
  let hostOrigin: string | null = options.hostOrigin ?? originFromAncestor() ?? originFromReferrer();

  const pending = new Map<string, Pending>();
  const eventHandlers = new Map<HostEventKind, Set<(e: EnvProfileAppliedEnvelope) => void>>();
  const zenStateHandlers = new Set<(active: boolean) => void>();
  const dockActionHandlers = new Set<(id: string) => void>();
  let dockPreview: DockPreview | null = null;
  let titleBarStatus: string | null = null;
  let destroyed = false;

  function settle(id: string, fn: (p: Pending) => void): void {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.unlisten?.();
    pending.delete(id);
    fn(p);
  }

  function onMessage(e: MessageEvent): void {
    if (destroyed) return;
    // The host is our PARENT window and nothing else. Drop anything from a
    // nested/sibling frame even if it's tileapp-shaped — otherwise such a frame
    // could poison the trust-on-first-use origin pin (when there's no referrer)
    // or get processed once it learns the pinned origin. Mirrors the host-side
    // `e.source === iframe.contentWindow` check.
    if (typeof window !== 'undefined' && e.source !== window.parent) return;
    const data: unknown = e.data;
    const isOurs = isBridgeReply(data) || isEnvProfileApplied(data) || isZenStateChanged(data) || isDockAction(data) || isDockPreviewRequest(data) || isHostHello(data);
    if (!isOurs) return;
    // Origin pinning — the load-bearing check. If we already know the host
    // origin, drop anything from elsewhere; otherwise adopt this (parent-sourced,
    // tile-app-shaped) sender as the host.
    if (hostOrigin === null) {
      hostOrigin = e.origin;
    } else if (e.origin !== hostOrigin) {
      return;
    }
    if (isHostHello(data)) {
      // The host's post-reload handshake: answering proves this document is
      // still on the origin the host launched (card C10).
      post({ __tileapp: true, kind: 'host-hello-ack', nonce: data.nonce });
    } else if (isDockPreviewRequest(data)) {
      post({ __tileapp: true, kind: 'title-bar-status', id: newId(), text: titleBarStatus });
      post({ __tileapp: true, kind: 'dock-preview', id: newId(), preview: dockPreview });
    } else if (isDockAction(data)) {
      for (const handler of dockActionHandlers) { try { handler(data.actionId); } catch { /* isolate handlers */ } }
    } else if (isBridgeReply(data)) {
      settle(data.id, (p) => p.resolve(data));
    } else if (isEnvProfileApplied(data)) {
      const hs = eventHandlers.get('env-profile-applied');
      if (hs) for (const h of hs) { try { h(data); } catch { /* a handler throwing must not break the bus */ } }
    } else if (isZenStateChanged(data)) {
      for (const handler of zenStateHandlers) { try { handler(data.active); } catch { /* isolate app handlers */ } }
    }
  }

  window.addEventListener('message', onMessage);

  function post(env: OutboundEnvelope): void {
    const parent = typeof window !== 'undefined' ? window.parent : undefined;
    if (!parent || parent === window) {
      throw new HostUnavailableError('@yolo-labs/app-sdk: no host window — not running inside a YOLO tile');
    }
    if (hostOrigin === null) {
      // Not "no host": a host whose origin can't be pinned is a misconfiguration, so it throws.
      throw new Error('@yolo-labs/app-sdk: host origin unknown — cannot target a message safely (no document.referrer and no host message yet; pass { hostOrigin })');
    }
    // Pinned origin, never '*'.
    parent.postMessage(env, hostOrigin);
  }

  function send(env: OutboundRequestEnvelope, timeoutMs: number, signal?: AbortSignal): Promise<BridgeReplyEnvelope> {
    return new Promise<BridgeReplyEnvelope>((resolve, reject) => {
      if (destroyed) { reject(new Error('@yolo-labs/app-sdk: client destroyed')); return; }
      if (signal?.aborted) { reject(new CancelledError(env.kind)); return; }
      const timer = setTimeout(() => {
        settle(env.id, (p) => p.reject(new TimeoutError(env.kind, timeoutMs)));
      }, timeoutMs);
      const onAbort = () => settle(env.id, (p) => p.reject(new CancelledError(env.kind)));
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(env.id, { resolve, reject, timer, unlisten: signal ? () => signal.removeEventListener('abort', onAbort) : undefined });
      try {
        post(env);
      } catch (err) {
        settle(env.id, (p) => p.reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  // Context is immutable for the life of the iframe (workspace/tile/app identity
  // never changes without a remount; theme is host-static today), so one
  // successful reply is cached for the client's lifetime.
  let cachedContext: TileAppContext | null = null;

  // One implementation, shared by `call` and the typed `llm*` helpers below —
  // those are the SAME broker call with a payload type attached, so they must
  // not be a second code path that can drift from it.
  async function callCapability(
    capability: string,
    method: string,
    args?: unknown,
    opts?: TileAppCallOptions,
  ): Promise<TileAppCallResult> {
    let reply: BridgeReplyEnvelope;
    try {
      reply = await send(
        { __tileapp: true, kind: 'bridge-call', id: newId(), capability, method, args, protocolVersion: BRIDGE_PROTOCOL_VERSION },
        opts?.timeoutMs ?? defaultTimeoutMs,
        opts?.signal,
      );
    } catch (err) {
      // No host window (not in a tile): a structured refusal, like any other.
      if (err instanceof HostUnavailableError) return { ok: false, reason: 'unavailable', message: err.message };
      throw err;
    }
    // Normalize: a non-`true` ok (incl. a pre-broker error reply with no `ok`,
    // only `error`) is a failure. Surface the host's error text as `message`.
    return {
      ok: reply.ok === true,
      payload: reply.payload,
      reason: reply.reason,
      message: reply.message ?? (typeof reply.error === 'string' ? reply.error : undefined),
      status: typeof reply.status === 'number' && Number.isInteger(reply.status) && reply.status >= 100 && reply.status <= 599 ? reply.status : undefined,
      code: reply.code === null || typeof reply.code === 'string' ? reply.code : undefined,
      retryAfter: reply.retryAfter === null ? null
        : typeof reply.retryAfter === 'number' && Number.isFinite(reply.retryAfter) && reply.retryAfter >= 0 ? reply.retryAfter
        : typeof reply.retryAfterSeconds === 'number' && Number.isFinite(reply.retryAfterSeconds) && reply.retryAfterSeconds >= 0 ? reply.retryAfterSeconds : undefined,
      permission: typeof reply.permission === 'string' ? reply.permission : undefined,
    };
  }

  async function requestZen(action: 'enter' | 'exit' | 'status', opts?: TileAppCallOptions): Promise<TileAppCallResult<{ active: boolean }>> {
    const reply = await send(
      { __tileapp: true, kind: 'zen-request', id: newId(), action, protocolVersion: BRIDGE_PROTOCOL_VERSION },
      opts?.timeoutMs ?? defaultTimeoutMs,
    );
    return { ok: reply.ok === true, payload: reply.payload as { active: boolean } | undefined, reason: reply.reason, message: reply.message };
  }

  return {
    zen: {
      enter: (opts) => requestZen('enter', opts),
      exit: (opts) => requestZen('exit', opts),
      status: (opts) => requestZen('status', opts),
      onChange: (handler) => { zenStateHandlers.add(handler); return () => zenStateHandlers.delete(handler); },
    },
    titleBar: {
      setStatus: async (text, opts) => {
        titleBarStatus = text;
        const reply = await send({ __tileapp: true, kind: 'title-bar-status', id: newId(), text }, opts?.timeoutMs ?? defaultTimeoutMs);
        return { ok: reply.ok === true, reason: reply.reason, message: reply.message };
      },
    },
    dock: {
      pulse: async (opts) => {
        const reply = await send({ __tileapp: true, kind: 'dock-pulse', id: newId() }, opts?.timeoutMs ?? defaultTimeoutMs);
        return { ok: reply.ok === true, payload: reply.payload as { pulsed: boolean } | undefined, reason: reply.reason, message: reply.message };
      },
      setPreview: async (preview, opts) => {
        dockPreview = preview;
        const reply = await send({ __tileapp: true, kind: 'dock-preview', id: newId(), preview }, opts?.timeoutMs ?? defaultTimeoutMs);
        return { ok: reply.ok === true, reason: reply.reason, message: reply.message };
      },
      onAction: handler => { dockActionHandlers.add(handler); return () => { dockActionHandlers.delete(handler); }; },
    },
    call: callCapability,

    async llmInvoke(args, opts) {
      return (await callCapability('llm', 'invoke', args, opts)) as TileAppCallResult<LlmInvokePayload>;
    },

    async llmDiscover(args, opts) {
      return (await callCapability('llm', 'discover', args ?? {}, opts)) as TileAppCallResult<LlmDiscoverPayload>;
    },

    async mcpCall<TPayload = unknown>(args: McpCallArgs, opts?: TileAppCallOptions) {
      const timeoutMs = typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? Math.min(opts.timeoutMs, 35_000) : 35_000;
      return (await callCapability('mcp', 'call', args, { ...opts, timeoutMs })) as TileAppCallResult<TPayload>;
    },

    async sendNotification(args, opts) {
      return (await callCapability('notifications', 'send', args, opts)) as TileAppCallResult<SendNotificationPayload>;
    },

    async capabilities(opts) {
      const res = (await callCapability('capabilities', 'get', {}, opts)) as TileAppCallResult<TileAppCapabilities>;
      if (res.ok && res.payload) return res.payload;
      if (res.reason === 'unknown-capability' || res.reason === 'unknown-method') return null;
      throw new Error(`@yolo-labs/app-sdk: capabilities.get failed: ${res.message ?? res.reason ?? 'unknown'}`);
    },

    async openLink(url, opts) {
      return (await callCapability('link', 'open', { url }, opts)) as TileAppCallResult<{ opened: true; host: string }>;
    },

    async getContext(opts) {
      if (cachedContext) return cachedContext;
      const reply = await send(
        { __tileapp: true, kind: 'context-request', id: newId(), protocolVersion: BRIDGE_PROTOCOL_VERSION },
        opts?.timeoutMs ?? defaultTimeoutMs,
      );
      if (reply.ok !== true) {
        throw new Error(`@yolo-labs/app-sdk: context request failed: ${reply.message ?? reply.reason ?? reply.error ?? 'unknown'}`);
      }
      const p = (reply.payload ?? {}) as Partial<TileAppContext>;
      cachedContext = {
        workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : '',
        tileId: typeof p.tileId === 'string' ? p.tileId : '',
        appId: typeof p.appId === 'string' ? p.appId : null,
        theme: typeof p.theme === 'string' ? p.theme : 'dark',
      };
      return cachedContext;
    },

    async requestPermissions(permissions) {
      if (modulePermissionInFlight) {
        throw new PermissionRequestError('a permission request is already pending — await it before starting another', 'busy');
      }
      modulePermissionInFlight = true;
      let reply: BridgeReplyEnvelope;
      try {
        reply = await send(
          { __tileapp: true, kind: 'request-permissions', id: newId(), permissions, protocolVersion: BRIDGE_PROTOCOL_VERSION },
          permissionTimeoutMs,
        );
      } catch (err) {
        if (err instanceof TimeoutError) throw new PermissionRequestError(err.message, 'timeout');
        throw err;
      } finally {
        modulePermissionInFlight = false;
      }
      if (reply.ok !== true) {
        throw new PermissionRequestError(reply.message || reply.reason || reply.error || 'permission request denied', reply.reason);
      }
      const payload = (reply.payload ?? {}) as Partial<PermissionGrant>;
      return {
        grantedPermissions: Array.isArray(payload.grantedPermissions) ? payload.grantedPermissions : [],
        newlyGranted: Array.isArray(payload.newlyGranted) ? payload.newlyGranted : [],
      };
    },

    on(kind, handler) {
      let set = eventHandlers.get(kind);
      if (!set) { set = new Set(); eventHandlers.set(kind, set); }
      set.add(handler);
      return () => { eventHandlers.get(kind)?.delete(handler); };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('message', onMessage);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.unlisten?.();
        p.reject(new Error('@yolo-labs/app-sdk: client destroyed'));
      }
      pending.clear();
      eventHandlers.clear();
      zenStateHandlers.clear();
      dockActionHandlers.clear();
    },
  };
}

/** A call that got no answer within its timeout. */
export class TimeoutError extends Error {
  constructor(kind: string, timeoutMs: number) {
    super(`@yolo-labs/app-sdk: ${kind} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Thrown by the bridge when there is no host window (not in a tile); capability calls turn it into `reason: 'unavailable'`. */
export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnavailableError';
  }
}

/** A call cancelled through its `signal`. */
export class CancelledError extends Error {
  constructor(kind: string) {
    super(`@yolo-labs/app-sdk: ${kind} was cancelled`);
    this.name = 'CancelledError';
  }
}

/**
 * The calls an app makes the same way from its UI ({@link createTileApp}) and its
 * server (`createTileServerClient` in `./server.js`): one contract, so code
 * written against it runs on either side. Feature-detect with `capabilities()`.
 */
export type TileCaller = Pick<TileApp, 'call' | 'llmInvoke' | 'llmDiscover' | 'mcpCall' | 'sendNotification' | 'capabilities'>;

function originFromReferrer(): string | null {
  try {
    if (typeof document === 'undefined' || !document.referrer) return null;
    const origin = new URL(document.referrer).origin;
    // After an in-iframe navigation the referrer is the app's OWN prior page,
    // not the host — never pin our own origin as the host.
    if (typeof window !== 'undefined' && origin === window.location.origin) return null;
    return origin;
  } catch {
    return null;
  }
}

function originFromAncestor(): string | null {
  try {
    // ancestorOrigins is a Chromium/WebKit API (absent in Firefox); [0] is the
    // immediate parent frame's origin — a referrer-independent host-origin
    // source. The tile-app runs in Chromium, so this is normally available.
    const ao = typeof window !== 'undefined' ? window.location.ancestorOrigins : undefined;
    const first = ao && ao.length > 0 ? ao[0] : null;
    return first && first !== 'null' ? first : null;
  } catch {
    return null;
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return 'tac-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
