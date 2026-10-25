import { describe, expect, it, vi } from 'vitest';
import { createMcpProvider, mcpProviderContext, McpToolError, MCP_PROVIDER_HEADERS as H } from './mcp-provider.js';

const SCOPE = JSON.stringify({ global: false, resourceIds: ['vault-1'] });
const providerHeaders = (over: Record<string, string> = {}) => ({
  [H.user]: 'u1', [H.attachment]: 'att-1', [H.callerSession]: 'agent_session:s:1', [H.tool]: 'read_note', [H.scope]: SCOPE, [H.correlation]: 'c1', ...over,
});
const call = (body: unknown, headers: Record<string, string> = providerHeaders(), method = 'POST') =>
  new Request('https://app.example/api/mcp', { method, headers, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
const req = (args: unknown = { noteId: 'n1' }, id: unknown = 7, name = 'read_note') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('createMcpProvider (P-1)', () => {
  it('runs the handler with the injected context and wraps its result', async () => {
    const seen: unknown[] = [];
    const provider = createMcpProvider({ tools: { read_note: (args, ctx) => { seen.push(args, ctx.scope, ctx.allows('vault-1'), ctx.allows('vault-2'), ctx.userId, ctx.correlationId); return { text: 'hi', structuredContent: { noteId: 'n1' } }; } } });
    const res = await provider(call(req()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'hi' }], structuredContent: { noteId: 'n1' } } });
    expect(seen).toEqual([{ noteId: 'n1' }, { resourceIds: ['vault-1'], global: false }, true, false, 'u1', 'c1']);
  });

  it('is not a provider call without every injected header, with a tile header, or with a widened scope', async () => {
    const handler = vi.fn(() => ({ text: 'x' }));
    const provider = createMcpProvider({ tools: { read_note: handler } });
    for (const headers of [
      {},
      providerHeaders({ [H.attachment]: '' }),
      { ...providerHeaders(), 'x-yolo-tile': 't1' },
      providerHeaders({ [H.scope]: JSON.stringify({ global: true, resourceIds: [] }) }),
      providerHeaders({ [H.scope]: '{nope' }),
    ]) {
      expect((await provider(call(req(), headers as Record<string, string>))).status).toBe(403);
    }
    expect((await provider(call(null, providerHeaders(), 'GET'))).status).toBe(405);
    expect(handler).not.toHaveBeenCalled();
    expect(mcpProviderContext(call(req()))).toMatchObject({ tool: 'read_note', attachmentId: 'att-1' });
  });

  it('only tools/call, only the tool the gateway authorized, only declared handlers', async () => {
    const provider = createMcpProvider({ tools: { read_note: () => ({ text: 'x' }) } });
    const err = async (r: Request) => (await (await provider(r)).json() as { error: { code: number } }).error.code;
    expect(await err(call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).toBe(-32601);
    expect(await err(call(req({}, 1, 'delete_everything')))).toBe(-32602);
    expect(await err(call(req({}, 1, 'search'), providerHeaders({ [H.tool]: 'search' })))).toBe(-32602);
    expect(await err(call('{bad'))).toBe(-32700);
    expect(await err(call({ jsonrpc: '2.0', method: 'tools/call' }))).toBe(-32600);
  });

  it('McpToolError is the agent-visible error; anything else is internal_error and reported', async () => {
    const onError = vi.fn();
    const provider = createMcpProvider({
      tools: { read_note: (args) => { if (args.noteId === 'missing') throw new McpToolError('note not found'); throw new Error('db secret detail'); } },
      onError,
    });
    const result = async (args: unknown) => (await (await provider(call(req(args)))).json() as { result: unknown }).result;
    expect(await result({ noteId: 'missing' })).toEqual({ content: [{ type: 'text', text: 'note not found' }], isError: true });
    expect(await result({ noteId: 'other' })).toEqual({ content: [{ type: 'text', text: 'internal_error' }], isError: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a handler result without text content is internal_error; content blocks keep only type and text', async () => {
    const results: unknown[] = [{}, { content: [{ type: 'image', data: 'x' }] }, { content: [{ type: 'text', text: 'a', annotations: { x: 1 } }], isError: true }];
    const provider = createMcpProvider({ tools: { read_note: () => results.shift() as never } });
    const out = async () => (await (await provider(call(req()))).json() as { result: unknown }).result;
    expect(await out()).toEqual({ content: [{ type: 'text', text: 'internal_error' }], isError: true });
    expect(await out()).toEqual({ content: [{ type: 'text', text: 'internal_error' }], isError: true });
    expect(await out()).toEqual({ content: [{ type: 'text', text: 'a' }], isError: true });
  });

  it('W-2: a write carries its access and idempotency key; a write header without a key is not a provider call', async () => {
    const seen: unknown[] = [];
    const provider = createMcpProvider({ tools: { create_note: (_a, ctx) => { seen.push(ctx.access, ctx.idempotencyKey); return { text: 'ok' }; }, read_note: (_a, ctx) => { seen.push(ctx.access, ctx.idempotencyKey); return { text: 'r' }; } } });
    const w = providerHeaders({ [H.tool]: 'create_note', [H.access]: 'write', [H.idempotency]: 'k-12345678' });
    expect((await provider(call(req({ title: 't', idempotencyKey: 'k-12345678' }, 1, 'create_note'), w))).status).toBe(200);
    expect((await provider(call(req(), providerHeaders({ [H.access]: 'read' })))).status).toBe(200);
    expect(seen).toEqual(['write', 'k-12345678', 'read', null]);
    expect((await provider(call(req({}, 1, 'create_note'), providerHeaders({ [H.tool]: 'create_note', [H.access]: 'write' })))).status).toBe(403);
  });
});
