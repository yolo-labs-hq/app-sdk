import { describe, expect, it, vi } from 'vitest';
import { connectPortalFrame, PORTAL_THEME_CSS_VARS } from './portal.js';

const PORTAL = 'https://yolo.studio';
const NONCE = '0123456789abcdef0123456789abcdef';

/** A minimal framed window: a parent that records posts, a body of a settable height. */
function fakeFrame() {
  const listeners = new Set<(e: MessageEvent) => void>();
  const posted: { msg: Record<string, unknown>; origin: string }[] = [];
  const parent = { postMessage: vi.fn((msg: Record<string, unknown>, origin: string) => { posted.push({ msg, origin }); }) };
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  let bodyHeight = 500;
  let roCallback: (() => void) | null = null;
  const html = {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
      colorScheme: '',
    },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  };
  const win = {
    parent,
    document: { documentElement: html, body: { getBoundingClientRect: () => ({ height: bodyHeight }) } },
    getComputedStyle: () => ({ marginTop: '8px', marginBottom: '8px' }),
    addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
    ResizeObserver: class { constructor(cb: () => void) { roCallback = cb; } observe() {} disconnect() { roCallback = null; } },
  };
  return {
    win: win as unknown as Window,
    posted, props, attrs, html,
    send(data: unknown, o: { origin?: string; source?: unknown } = {}) {
      const e = { data, origin: o.origin ?? PORTAL, source: o.source ?? parent } as unknown as MessageEvent;
      for (const fn of listeners) fn(e);
    },
    grow(h: number) { bodyHeight = h; roCallback?.(); },
    listenerCount: () => listeners.size,
  };
}

const themeMsg = (theme: Record<string, unknown>, nonce = NONCE) => ({ __yoloPortalApp: 1, type: 'yolo:theme', nonce, theme });

describe('connectPortalFrame', () => {
  it('announces itself to the parent, carrying nothing', () => {
    const f = fakeFrame();
    connectPortalFrame({ window: f.win });
    expect(f.posted).toEqual([{ msg: { __yoloPortalApp: 1, type: 'yolo:ready' }, origin: '*' }]);
  });

  it('applies the theme as CSS variables and colour scheme, and calls onTheme', () => {
    const f = fakeFrame();
    const onTheme = vi.fn();
    const pf = connectPortalFrame({ window: f.win, onTheme });
    f.send(themeMsg({ name: 'porcelain', scheme: 'light', background: '#F4F6F6', accent: '#0F766E', radius: '10px', font: "'Inter', sans-serif" }));
    expect(f.props.get(PORTAL_THEME_CSS_VARS.background)).toBe('#F4F6F6');
    expect(f.props.get('--yolo-accent')).toBe('#0F766E');
    expect(f.props.get('--yolo-radius')).toBe('10px');
    expect(f.props.get('--yolo-font')).toBe("'Inter', sans-serif");
    expect(f.html.style.colorScheme).toBe('light');
    expect(f.attrs.get('data-yolo-scheme')).toBe('light');
    expect(f.attrs.get('data-yolo-theme')).toBe('porcelain');
    expect(onTheme).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'light', accent: '#0F766E' }));
    expect(pf.theme?.name).toBe('porcelain');
  });

  it('reports its content height with the nonce, to the origin that themed it, only when it changes', () => {
    const f = fakeFrame();
    connectPortalFrame({ window: f.win });
    f.grow(700); // before any theme: nothing to report to
    expect(f.posted).toHaveLength(1);
    f.send(themeMsg({ scheme: 'dark' }));
    expect(f.posted[1]).toEqual({ msg: { __yoloPortalApp: 1, type: 'yolo:resize', nonce: NONCE, height: 716 }, origin: PORTAL });
    f.grow(700);
    expect(f.posted).toHaveLength(2);
    f.grow(920.5);
    expect(f.posted[2]?.msg.height).toBe(937);
  });

  it('ignores theme messages from anyone but the parent, or malformed ones', () => {
    const f = fakeFrame();
    const onTheme = vi.fn();
    connectPortalFrame({ window: f.win, onTheme });
    f.send(themeMsg({ scheme: 'dark' }), { source: {} });
    f.send(themeMsg({ scheme: 'sepia' }));
    f.send(themeMsg({ scheme: 'dark' }, 'not-a-nonce'));
    f.send({ type: 'yolo:theme', nonce: NONCE, theme: { scheme: 'dark' } });
    expect(onTheme).not.toHaveBeenCalled();
    f.send(themeMsg({ scheme: 'dark', accent: 'red; } body { display:none', ink: '#fff' }));
    expect(onTheme).toHaveBeenCalledWith({ scheme: 'dark', ink: '#fff' });
  });

  it('opt-outs and destroy', () => {
    const f = fakeFrame();
    const pf = connectPortalFrame({ window: f.win, applyCssVariables: false, autoResize: false });
    f.send(themeMsg({ scheme: 'dark', accent: '#D9A441' }));
    expect(f.props.size).toBe(0);
    expect(f.posted).toHaveLength(1); // ready only, no resize
    pf.destroy();
    expect(f.listenerCount()).toBe(0);
  });

  it('outside a frame does nothing at all', () => {
    const f = fakeFrame();
    const self = f.win as unknown as { parent: unknown };
    self.parent = self;
    connectPortalFrame({ window: f.win });
    expect(f.posted).toHaveLength(0);
  });
});
