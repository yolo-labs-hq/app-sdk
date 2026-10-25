import { describe, expect, it, vi } from 'vitest';
import { createMcpClient } from './mcp.js';

const pools = { read: { scopes: ['studio.read_file:notes/**'] } };
describe('server-held MCP transport policy', () => {
  it.each([undefined, 'server-held-only'] as const)('never mints on an unsupported host (policy %s)', async transportPolicy => {
    const app = {
      call: vi.fn(),
      mcpCall: vi.fn(async () => ({ ok: false as const, reason: 'unknown-method' })),
    };
    const fetch = vi.fn();
    const client = createMcpClient(app as never, { pools, transportPolicy, fetch });
    await expect(client.request('read', '/files/read')).rejects.toMatchObject({ reason: 'server-held-required' });
    expect(app.call).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(client.transport()).not.toBe('mint-token');
  });
  it('returns server-held data with no token mint or direct fetch', async () => {
    const app = { call: vi.fn(), mcpCall: vi.fn(async () => ({ ok: true as const, payload: { content: 'fixture' } })) };
    const fetch = vi.fn();
    const client = createMcpClient(app as never, { pools, fetch });
    await expect(client.request('read', '/files/read')).resolves.toEqual({ content: 'fixture' });
    expect(app.call).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['permission-not-granted', 'timeout', 'upstream-failed'])('never falls back on %s', async reason => {
    const app = { call: vi.fn(), mcpCall: vi.fn(async () => ({ ok: false as const, reason })) };
    const client = createMcpClient(app as never, { pools });
    await expect(client.request('read', '/files/read')).rejects.toMatchObject({ reason });
    expect(app.call).not.toHaveBeenCalled();
  });
  it('refuses an unknown policy before calling any transport', () => {
    const app = { call: vi.fn(), mcpCall: vi.fn() };
    expect(() => createMcpClient(app as never, { pools, transportPolicy: 'anything' as never })).toThrow('invalid MCP transport policy');
    expect(app.call).not.toHaveBeenCalled(); expect(app.mcpCall).not.toHaveBeenCalled();
  });
});
