import { describe, expect, it, vi } from 'vitest';
import { LinkOpenError, openLink } from './link.js';

describe('openLink', () => {
  it('sends link.open { url } and resolves the opened host', async () => {
    const call = vi.fn(async () => ({ ok: true, payload: { opened: true, host: 'github.com' } }));
    await expect(openLink({ call }, 'https://github.com/org/repo')).resolves.toEqual({ opened: true, host: 'github.com' });
    expect(call).toHaveBeenCalledWith('link', 'open', { url: 'https://github.com/org/repo' });
  });

  it.each(['unknown-method', 'link-not-declared', 'user-declined', 'invalid-args'])('rejects a %s refusal with its reason', async (reason) => {
    const call = vi.fn(async () => ({ ok: false, reason, message: 'refused' }));
    const error = await openLink({ call }, 'https://github.com/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkOpenError);
    expect(error).toMatchObject({ reason, message: 'refused' });
  });

  it('refuses a missing URL without calling the host', async () => {
    const call = vi.fn();
    await expect(openLink({ call }, '')).rejects.toMatchObject({ reason: 'invalid-args' });
    expect(call).not.toHaveBeenCalled();
  });
});
