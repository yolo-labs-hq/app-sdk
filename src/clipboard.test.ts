import { describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

describe('copyText (P2.2)', () => {
  it('asks the host for clipboard.copy with the text and passes its answer through', async () => {
    const call = vi.fn(async () => ({ ok: true, payload: { copied: true, chars: 5 } }));
    expect(await copyText({ call } as never, 'hello')).toEqual({ ok: true, payload: { copied: true, chars: 5 } });
    expect(call).toHaveBeenCalledWith('clipboard', 'copy', { text: 'hello' }, undefined);
  });
});
