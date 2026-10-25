/**
 * copyText — ask the host to put text on the user's clipboard (permission
 * assessment P2.2). Call it from a click handler in your UI: the host copies
 * only while the user has just interacted with your app (the page is
 * activated and focus is in your tile), at most once a second, from Studio,
 * and shows the user a "Copied" notice. Plain text, at most 65,536 UTF-16
 * code units. There is no way to read the clipboard.
 *
 * Refusal reasons:
 *  - `unknown-method` / `unknown-capability` — the host doesn't offer copying
 *    (switched off, or an older host). Show the text so the user can copy it.
 *  - `invalid-args` — empty, not a string, or too long.
 *  - `no-user-activation` — the user hasn't just interacted with your app.
 *  - `busy` — another copy is in flight, or one happened less than a second ago.
 *  - `copy-failed` — the browser refused.
 */
import type { TileApp, TileAppCallOptions, TileAppCallResult } from './client.js';

export interface CopyTextPayload {
  copied: true;
  chars: number;
}

export async function copyText(app: Pick<TileApp, 'call'>, text: string, opts?: TileAppCallOptions): Promise<TileAppCallResult<CopyTextPayload>> {
  return (await app.call('clipboard', 'copy', { text }, opts)) as TileAppCallResult<CopyTextPayload>;
}
