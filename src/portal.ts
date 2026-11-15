/**
 * connectPortalFrame — fit a tile app into a Mogul's CUSTOMER PORTAL: take the
 * portal's theme, and report your height so the portal frame grows with your
 * content (one page scroll, not two).
 *
 * Opt-in and harmless elsewhere: in Studio, or outside any frame, nothing
 * arrives and nothing is sent except one `yolo:ready` to the parent.
 *
 * ## The contract (portal → app)
 *
 *   { __yoloPortalApp: 1, type: 'yolo:theme', nonce, theme: PortalThemeTokens }
 *
 * posted to your origin on load, when you send `yolo:ready`, and whenever the
 * customer's theme (or the provider's accent) changes. `theme` holds design
 * tokens only; any field the portal could not read cleanly is omitted.
 *
 * ## The contract (app → portal)
 *
 *   { __yoloPortalApp: 1, type: 'yolo:ready' }                      (ask for the theme)
 *   { __yoloPortalApp: 1, type: 'yolo:resize', nonce, height }      (CSS px)
 *
 * A resize is honoured only from your frame, from your origin, with the nonce
 * the last theme message carried. The portal clamps it (160..4000 px); above
 * the cap your document scrolls itself.
 *
 * ⚠️ Measure CONTENT, not the viewport: don't give `html`/`body` a `100vh`
 * height or the frame can only ever grow. This helper measures
 * `document.body`'s content box plus its margins.
 */

const NAMESPACE = '__yoloPortalApp';
const PROTOCOL = 1;

export interface PortalThemeTokens {
  /** The portal theme id: `ink`, `porcelain`, `dusk`, `meadow`, `phosphor`. */
  name?: string;
  scheme: 'light' | 'dark';
  background?: string;
  surface?: string;
  ink?: string;
  inkSoft?: string;
  line?: string;
  /** The provider's brand colour when they set a readable one, else the theme's accent. */
  accent?: string;
  /** Text colour on top of `accent`. */
  accentInk?: string;
  /** Corner radius, e.g. `10px`. */
  radius?: string;
  /** A CSS font-family stack. */
  font?: string;
}

/** Token → CSS custom property this helper sets on `<html>`. */
export const PORTAL_THEME_CSS_VARS: Readonly<Record<Exclude<keyof PortalThemeTokens, 'name' | 'scheme'>, string>> = {
  background: '--yolo-background',
  surface: '--yolo-surface',
  ink: '--yolo-ink',
  inkSoft: '--yolo-ink-soft',
  line: '--yolo-line',
  accent: '--yolo-accent',
  accentInk: '--yolo-accent-ink',
  radius: '--yolo-radius',
  font: '--yolo-font',
};

export interface PortalFrameOptions {
  /** Called with every theme the portal sends (after the CSS variables are applied). */
  onTheme?: (theme: PortalThemeTokens) => void;
  /** Set `--yolo-*` variables, `color-scheme` and `data-yolo-scheme` / `data-yolo-theme` on `<html>`. Default true. */
  applyCssVariables?: boolean;
  /** Report the content height whenever it changes. Default true. */
  autoResize?: boolean;
  /** For tests. */
  window?: Window;
}

export interface PortalFrame {
  /** The last theme received, or null before the first one (or outside a portal). */
  readonly theme: PortalThemeTokens | null;
  /** Report the height now (e.g. after a layout change the observer cannot see). */
  reportHeight(): void;
  destroy(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readTokens(v: unknown): PortalThemeTokens | null {
  if (!isRecord(v) || (v.scheme !== 'light' && v.scheme !== 'dark')) return null;
  const out: PortalThemeTokens = { scheme: v.scheme };
  for (const k of ['name', ...Object.keys(PORTAL_THEME_CSS_VARS)] as (keyof PortalThemeTokens)[]) {
    const x = v[k];
    // A value is set as a custom property, never as markup: still, refuse anything that is not a short plain string.
    if (typeof x === 'string' && x.length <= 240 && !/[;{}<>]/.test(x)) (out as unknown as Record<string, string>)[k] = x;
  }
  return out;
}

export function connectPortalFrame(options: PortalFrameOptions = {}): PortalFrame {
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window);
  const applyVars = options.applyCssVariables !== false;
  const autoResize = options.autoResize !== false;
  let theme: PortalThemeTokens | null = null;
  let nonce: string | null = null;
  let hostOrigin: string | null = null;
  let lastHeight = -1;
  let destroyed = false;

  const parent = win && win.parent !== win ? win.parent : null;

  const measure = (): number => {
    const body = win?.document.body;
    if (!body) return 0;
    const cs = win.getComputedStyle(body);
    const margins = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    return Math.ceil(body.getBoundingClientRect().height + margins);
  };

  const reportHeight = () => {
    if (destroyed || !autoResize || !parent || !nonce || !hostOrigin) return;
    const height = measure();
    if (height <= 0 || height === lastHeight) return;
    lastHeight = height;
    parent.postMessage({ [NAMESPACE]: PROTOCOL, type: 'yolo:resize', nonce, height }, hostOrigin);
  };

  const apply = (t: PortalThemeTokens) => {
    const html = win?.document.documentElement;
    if (!html || !applyVars) return;
    for (const [k, cssVar] of Object.entries(PORTAL_THEME_CSS_VARS)) {
      const v = (t as unknown as Record<string, string | undefined>)[k];
      if (v) html.style.setProperty(cssVar, v); else html.style.removeProperty(cssVar);
    }
    html.style.colorScheme = t.scheme;
    html.setAttribute('data-yolo-scheme', t.scheme);
    if (t.name) html.setAttribute('data-yolo-theme', t.name); else html.removeAttribute('data-yolo-theme');
  };

  const onMessage = (e: MessageEvent) => {
    if (destroyed || !parent || e.source !== parent) return;
    const d = e.data;
    if (!isRecord(d) || d[NAMESPACE] !== PROTOCOL || d.type !== 'yolo:theme') return;
    const t = readTokens(d.theme);
    if (!t || typeof d.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(d.nonce)) return;
    // Pin replies to the origin that themed us (the portal), and adopt its nonce.
    if (d.nonce !== nonce || e.origin !== hostOrigin) lastHeight = -1;
    nonce = d.nonce;
    hostOrigin = e.origin;
    theme = t;
    apply(t);
    options.onTheme?.(t);
    reportHeight();
  };

  let observer: ResizeObserver | null = null;
  if (win && parent) {
    win.addEventListener('message', onMessage);
    const RO = (win as Window & typeof globalThis).ResizeObserver;
    if (autoResize && typeof RO === 'function' && win.document.body) {
      observer = new RO(() => reportHeight());
      observer.observe(win.document.body);
    }
    // Carries nothing; the portal answers with the theme (a late listener misses the load-time one).
    parent.postMessage({ [NAMESPACE]: PROTOCOL, type: 'yolo:ready' }, '*');
  }

  return {
    get theme() { return theme; },
    reportHeight,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      win?.removeEventListener('message', onMessage);
    },
  };
}
