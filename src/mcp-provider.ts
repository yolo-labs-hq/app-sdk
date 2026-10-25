/**
 * createMcpProvider — serve your app's declared tools (`provides.mcp`) to the agents a user
 * attached it to, from a `worker` backend (docs/TILE_APP_MCP_PROVIDER_PLAN.md §5–§6; card P-1).
 *
 * The tile gateway terminates the agent's MCP session: it verifies the provider token, asks the
 * platform whether the attachment is still allowed on every call, checks the arguments against your
 * pinned `inputSchema`, and only then forwards ONE `tools/call` to your `provides.mcp.path`. What
 * your handler gets is the caller context the gateway injected (`x-yolo-mcp-*`, `x-yolo-user`): the
 * gateway strips every inbound `x-yolo-*` header first, so these can be trusted, and a request
 * without them is not a provider call (your UI's own `/api` calls never carry them).
 *
 *   export default {
 *     fetch(request) {
 *       const url = new URL(request.url);
 *       if (url.pathname === '/api/mcp') return provider(request);
 *       ...
 *     },
 *   };
 *   const provider = createMcpProvider({
 *     tools: {
 *       read_note: async ({ noteId }, ctx) => {
 *         // ctx.scope.resourceIds: what the owner attached (e.g. vault ids). Enforce it.
 *         const note = await findNote(ctx.scope.resourceIds, noteId);
 *         if (!note) throw new McpToolError('note not found in the attached vault');
 *         return { text: note.body, structuredContent: note };
 *       },
 *     },
 *   });
 *
 * Results: return `{ text }` or `{ content: [{ type: 'text', text }] }`, plus `structuredContent`
 * when the tool declares an `outputSchema` (the gateway checks it). Text content only in phase 1.
 * Throw {@link McpToolError} for an error the agent should see; anything else thrown becomes a
 * generic `internal_error` (its message never leaves the app).
 *
 * Scope is enforced by YOU (a reviewed contract for first-party apps in phase 1): read and write
 * only what `ctx.scope.resourceIds` names. Never take an owner, workspace or resource id from the
 * tool's arguments to widen it.
 */

/** Headers the gateway sets on a provider call (and strips from every other request). */
export const MCP_PROVIDER_HEADERS = {
  callerSession: 'x-yolo-mcp-caller-session',
  attachment: 'x-yolo-mcp-attachment',
  scope: 'x-yolo-mcp-scope',
  tool: 'x-yolo-mcp-tool',
  correlation: 'x-yolo-mcp-correlation',
  access: 'x-yolo-mcp-access',
  idempotency: 'x-yolo-mcp-idempotency-key',
  user: 'x-yolo-user',
} as const;

export interface McpProviderScope {
  /** The app's own resource ids the owner attached (a vault, a notebook: the app decides). */
  resourceIds: string[];
  /** Always false in phase 1. */
  global: false;
}

export interface McpToolContext {
  /** The owner whose data this call is about (the tile instance's user). */
  userId: string;
  attachmentId: string;
  /** The calling agent session, `agent_session:<id>:<generation>` (for audit, not for authority). */
  callerSession: string;
  scope: McpProviderScope;
  /** The gateway's correlation id for this call; log it with your own records. */
  correlationId: string;
  tool: string;
  /** The tool's access class as the gateway authorized it. */
  access: 'read' | 'write';
  /**
   * A write's idempotency key: the SHA-256 (hex) of its `idempotencyKey` argument, which every write tool
   * must take. The gateway already answers a repeat within 24 h with the first result and never
   * dispatches it twice; an app that keeps its own record of applied keys is safe beyond that too.
   * Null for a read.
   */
  idempotencyKey: string | null;
  /** Is `resourceId` one the owner attached? */
  allows(resourceId: string): boolean;
}

export interface McpToolResult {
  /** Shorthand for `content: [{ type: 'text', text }]`. */
  text?: string;
  content?: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpToolHandler = (args: Record<string, unknown>, ctx: McpToolContext) => McpToolResult | Promise<McpToolResult>;

/** An error the calling agent sees as a tool error (`isError: true`) with this message. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface McpProviderOptions {
  /** One handler per tool your `provides.mcp.tools` declares, by name. */
  tools: Record<string, McpToolHandler>;
  /** Called with a thrown non-{@link McpToolError} (the agent only sees `internal_error`). */
  onError?: (err: unknown, ctx: McpToolContext) => void;
}

const MAX_BODY_BYTES = 256 * 1024;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rpcResult = (id: unknown, result: unknown) => json(200, { jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolError = (text: string): McpToolResult & { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text', text }], isError: true });

/** The gateway-injected caller context, or null when `request` is not a provider call. */
export function mcpProviderContext(request: Request): Omit<McpToolContext, 'allows'> | null {
  const h = (name: string) => request.headers.get(name);
  const userId = h(MCP_PROVIDER_HEADERS.user);
  const attachmentId = h(MCP_PROVIDER_HEADERS.attachment);
  const callerSession = h(MCP_PROVIDER_HEADERS.callerSession);
  const tool = h(MCP_PROVIDER_HEADERS.tool);
  const correlationId = h(MCP_PROVIDER_HEADERS.correlation) ?? '';
  const access = h(MCP_PROVIDER_HEADERS.access) === 'write' ? 'write' : 'read';
  const idempotencyKey = h(MCP_PROVIDER_HEADERS.idempotency);
  // A write always arrives with its key; one without it isn't a call the gateway made.
  if (access === 'write' && !idempotencyKey) return null;
  const rawScope = h(MCP_PROVIDER_HEADERS.scope);
  if (!userId || !attachmentId || !callerSession || !tool || !rawScope) return null;
  // A UI request carries the tile header; a provider call never does.
  if (request.headers.has('x-yolo-tile')) return null;
  let scope: unknown;
  try { scope = JSON.parse(rawScope); } catch { return null; }
  const s = scope as { resourceIds?: unknown; global?: unknown } | null;
  if (!s || typeof s !== 'object' || s.global !== false || !Array.isArray(s.resourceIds) || !s.resourceIds.every((r) => typeof r === 'string')) return null;
  return { userId, attachmentId, callerSession, tool, correlationId, access, idempotencyKey: access === 'write' ? idempotencyKey : null, scope: { resourceIds: [...s.resourceIds as string[]], global: false } };
}

function normalize(result: McpToolResult): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const content = result.content ?? (typeof result.text === 'string' ? [{ type: 'text' as const, text: result.text }] : null);
  if (!Array.isArray(content) || content.length === 0 || !content.every((c) => c && c.type === 'text' && typeof c.text === 'string')) return null;
  return {
    content: content.map((c) => ({ type: 'text', text: c.text })),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

/** A `fetch`-style handler for your `provides.mcp.path`. Answers 403 to anything that isn't a provider call. */
export function createMcpProvider(options: McpProviderOptions): (request: Request) => Promise<Response> {
  const tools = new Map(Object.entries(options.tools));
  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const base = mcpProviderContext(request);
    if (!base) return json(403, { error: 'not_a_provider_call' });
    const ctx: McpToolContext = { ...base, allows: (id) => base.scope.resourceIds.includes(id) };

    const raw = await request.arrayBuffer().catch(() => null);
    if (!raw || raw.byteLength > MAX_BODY_BYTES) return json(413, { error: 'request_too_large' });
    let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try { msg = JSON.parse(new TextDecoder().decode(raw)); } catch { return rpcError(null, -32700, 'Parse error'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || !('id' in msg)) return rpcError(null, -32600, 'Invalid Request');
    const id = msg.id;
    // The gateway answers everything but tools/call itself.
    if (msg.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {}) as { name?: unknown; arguments?: unknown };
    // The tool the gateway authorized is the one in its header; a body naming another is refused.
    if (params.name !== ctx.tool) return rpcError(id, -32602, 'Unknown tool');
    const handler = tools.get(ctx.tool);
    if (!handler) return rpcError(id, -32602, 'Unknown tool');
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};

    let result: McpToolResult;
    try {
      result = await handler(args, ctx);
    } catch (err) {
      if (err instanceof McpToolError) return rpcResult(id, toolError(err.message));
      try { options.onError?.(err, ctx); } catch { /* never let a logger fail the call */ }
      return rpcResult(id, toolError('internal_error'));
    }
    const normalized = normalize(result);
    if (!normalized) {
      try { options.onError?.(new Error('tool handler returned no text content'), ctx); } catch { /* */ }
      return rpcResult(id, toolError('internal_error'));
    }
    return rpcResult(id, normalized);
  };
}
