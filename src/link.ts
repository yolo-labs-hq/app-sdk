/**
 * openLink — ask the host to open an external page in a new browser tab.
 *
 * A tile's iframe sandbox has no `allow-popups`, so `<a target="_blank">` and
 * `window.open` do nothing inside it. `link.open` asks the host instead: it
 * has Studio check the URL against the `links.open` patterns in your manifest
 * and your app's grant in this workspace, asks the user the first time for
 * each host ("Open github.com in a new tab?", with an always-allow choice kept
 * per user), then opens the page from the Studio origin with no opener and no
 * referrer. The new tab gets no handle on your app or on Studio. If the
 * browser will not open a tab without a click, the user gets an "Open" prompt;
 * the call succeeds only once a tab actually opened.
 *
 *   "links": { "open": ["https://github.com/*", "https://gitlab.com/my-org/*"] }
 *
 * Only an external page in a new tab: embedding a site in a frame and OAuth
 * sign-in are separate operations apps don't get (the manifest refuses any
 * `links` key but `open`; see the SDK README "Frames and sign-in").
 *
 * Only `https://` URLs on a declared host and path prefix open. Keep the `<a>`
 * with its `href` as a visual fallback (copyable address) and call this from
 * its click handler. Refusal reasons:
 *  - `unknown-method` — the host does not offer `link.open` (switched off, or
 *    an older host). Leave the address visible so the user can copy it.
 *  - `invalid-args` — not an `https://` URL (also `javascript:`, `data:`, `http:`).
 *  - `link-not-declared` — no `links.open` pattern in your manifest matches it.
 *  - `app-not-installed` — your app's grant in this workspace is gone (revoked).
 *  - `user-declined` — the user said no.
 *  - `popup-blocked` — the browser refused the new tab.
 *  - `busy` — another link confirm is already open in this tile.
 *
 * The built-in tile bundles run a transpiled copy of this file: after changing
 * it, run `node scripts/generate-tileapp-sdk-vendor.mjs` (common-api's
 * builtin-bundles-sdk-vendor.test.ts fails until you do).
 */
import type { TileApp } from './client.js';

/** The host's answer to an opened link. */
export interface OpenLinkPayload {
  opened: true;
  /** The host the page opened on, e.g. `github.com`. */
  host: string;
}

/** A refused `link.open`. `reason` is the host's (see the module doc). */
export class LinkOpenError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'LinkOpenError';
    this.reason = reason;
  }
}

/**
 * Open `url` in a new tab through the host. Resolves once the host opened it;
 * rejects with a {@link LinkOpenError} otherwise. Call it from a user action
 * (a click): browsers only open tabs in response to one.
 */
export async function openLink(app: Pick<TileApp, 'call'>, url: string): Promise<OpenLinkPayload> {
  if (typeof url !== 'string' || !url) throw new LinkOpenError('invalid-args', 'openLink needs a URL string');
  const reply = await app.call('link', 'open', { url });
  if (reply.ok) {
    const payload = (reply.payload ?? {}) as Partial<OpenLinkPayload>;
    return { opened: true, host: typeof payload.host === 'string' ? payload.host : '' };
  }
  throw new LinkOpenError(reply.reason || 'unknown', reply.message || 'The link could not be opened');
}
