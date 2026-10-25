import { describe, it, expect } from 'vitest';
import { validateManifest, KNOWN_PERMISSIONS, linkPatternError, net, parsePermission } from './manifest.js';

/** The videostitcher manifest shape — a known-good, complete manifest. */
function validManifest(): Record<string, unknown> {
  return {
    id: 'videostitcher',
    version: '3.20.0',
    publisher: 'yolo-labs',
    displayName: 'Video Stitcher',
    description: 'Upload a screencast, draft narration, stitch a voiceover back over it.',
    ui: { icon: 'movie', color: '#7c5cff', label: 'Video Stitcher' },
    surface: { kind: 'iframe', entry: 'index.html', tilePrefersSize: { rowSpan: 3, colSpan: 3 } },
    image: { ref: 'reg/tileapp-videostitcher', tag: '3.20.0' },
    runtime: { port: 7891, readyPattern: 'listening on', workdirQuota: '2Gi' },
    permissions: {
      required: ['media.upload:video', 'media.download:video', 'fs.readwrite:app-data'],
      optional: ['net:api.elevenlabs.io', 'fs.read:workspace'],
    },
    resources: { cpu: '2', memory: '2Gi', diskQuota: '2Gi' },
    enabled: true,
  };
}

describe('validateManifest', () => {
  it('accepts explicit marketplace visibility and rejects string booleans', () => {
    for (const marketplaceListed of [true, false]) {
      const result = validateManifest({ ...validManifest(), marketplaceListed });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.manifest.marketplaceListed).toBe(marketplaceListed);
    }
    expect(validateManifest({ ...validManifest(), marketplaceListed: 'false' })).toEqual({
      ok: false, errors: ['marketplaceListed must be a boolean when present'],
    });
  });
  it('accepts a valid (videostitcher-shaped) manifest', () => {
    const res = validateManifest(validManifest());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.id).toBe('videostitcher');
  });

  it('accepts a minimal pure-UI manifest (no image/runtime/optional)', () => {
    const res = validateManifest({
      id: 'hello',
      version: '0.1.0',
      publisher: 'acme',
      displayName: 'Hello',
      description: 'A hello app.',
      ui: { icon: 'star', color: '#fff', label: 'Hello' },
      surface: { kind: 'iframe', entry: 'index.html' },
      permissions: { required: [] },
    });
    expect(res.ok).toBe(true);
  });

  it('fails when server-required metadata (publisher/description/ui) is missing', () => {
    const m = validManifest();
    delete m.publisher;
    delete m.description;
    delete m.ui;
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('publisher is required');
      expect(res.errors).toContain('description is required');
      expect(res.errors).toContain('ui must have string icon, color, label');
    }
  });

  it('rejects a non-object', () => {
    const res = validateManifest('nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('manifest is not an object');
  });

  it('fails when id is missing', () => {
    const m = validManifest();
    delete m.id;
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('id must be a lowercase kebab-case slug (2-64 chars)');
  });

  // ── semantic checks (mirror the server) ──
  it('rejects a non-kebab id', () => {
    const m = validManifest();
    m.id = 'Bad_Id';
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('id must be a lowercase kebab-case slug (2-64 chars)');
  });

  it('rejects a non-semver version', () => {
    const m = validManifest();
    m.version = 'latest';
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('version must be semver (e.g. 1.0.0)');
  });

  it("rejects a non-'iframe' surface.kind", () => {
    const m = validManifest();
    m.surface = { kind: 'popup', entry: 'index.html' };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("surface.kind must be 'iframe' (v1)");
  });

  it('rejects a wildcard net permission', () => {
    const m = validManifest();
    m.permissions = { required: [], optional: ['net:*'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("net permission must name a specific host (no wildcards): 'net:*'");
  });

  it('accepts a bare provider-agnostic llm.invoke permission', () => {
    const m = validManifest();
    m.permissions = { required: [], optional: ['llm.invoke'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
  });

  it('still accepts a legacy llm.invoke:<provider> permission (provider is advisory)', () => {
    const m = validManifest();
    m.permissions = { required: [], optional: ['llm.invoke:claude'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
  });

  // P2.4: the server accepts secret:<preset> from any publisher and delivers it without exposing
  // the key (P1.8); the SDK checks only the key's shape.
  it('accepts a secret permission naming an UPPER_SNAKE_CASE key, and refuses another shape', () => {
    const m = validManifest();
    m.permissions = { required: [], optional: ['secret:OPENAI_API_KEY'] };
    expect(validateManifest(m).ok).toBe(true);
    m.permissions = { required: [], optional: ['secret:openai-key'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('UPPER_SNAKE_CASE'))).toBe(true);
  });

  it('rejects internal mcp:work.* permissions (never app-grantable)', () => {
    const m = validManifest();
    m.permissions = { required: ['mcp:work.get_artifact'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('mcp:work.* scopes are internal'))).toBe(true);
  });

  it('accepts a non-work mcp scope (server classifies it authoritatively)', () => {
    const m = validManifest();
    m.permissions = { required: [], optional: ['mcp:studio.list_artifacts'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
  });

  it('rejects an unrecognized permission', () => {
    const m = validManifest();
    m.permissions = { required: ['bogus.scope:x'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("unrecognized permission: 'bogus.scope:x'");
  });

  it('fails when permissions.required is missing', () => {
    const m = validManifest();
    m.permissions = { optional: ['net:api.elevenlabs.io'] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('permissions.required must be an array');
  });

  it('fails when permissions.required is wrong-typed', () => {
    const m = validManifest();
    m.permissions = { required: 'media.upload:video' };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('permissions.required must be an array');
  });

  it('fails when permissions.required contains a non-string', () => {
    const m = validManifest();
    m.permissions = { required: ['media.upload:video', 42] };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('permission must be a string: 42');
  });

  it('fails when surface is missing entry', () => {
    const m = validManifest();
    m.surface = { kind: 'iframe' };
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('surface.entry is required');
  });

  it('rejects runtime without image or exec', () => {
    const m = validManifest();
    m.runtime = { port: 7891 };
    delete m.image;
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('runtime requires either `image` (OCI image, recommended) or `runtime.exec` (bare-process override)');
  });

  it('collects multiple errors at once (not fail-fast)', () => {
    const res = validateManifest({ surface: {}, permissions: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(2);
  });

  it('tolerates extra unknown fields (additive platform)', () => {
    const m = validManifest();
    m.futureField = { anything: true };
    m._packaging = 'internal note';
    const res = validateManifest(m);
    expect(res.ok).toBe(true);
  });

  it('rejects bad optional blocks only when present', () => {
    const m = validManifest();
    m.image = { ref: 'reg/x' }; // missing tag
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain('image.tag is required');
  });
});

describe('permission helpers', () => {
  it('KNOWN_PERMISSIONS map the right strings', () => {
    expect(KNOWN_PERMISSIONS.MEDIA_UPLOAD_VIDEO).toBe('media.upload:video');
    expect(KNOWN_PERMISSIONS.MEDIA_DOWNLOAD_VIDEO).toBe('media.download:video');
    expect(KNOWN_PERMISSIONS.FS_READWRITE_APP_DATA).toBe('fs.readwrite:app-data');
    expect(KNOWN_PERMISSIONS.FS_READ_WORKSPACE).toBe('fs.read:workspace');
  });

  it('net() builds a net:<host> string', () => {
    expect(net('api.elevenlabs.io')).toBe('net:api.elevenlabs.io');
    expect(net('generativelanguage.googleapis.com')).toBe('net:generativelanguage.googleapis.com');
  });
});


describe('notification permissions', () => {
  it('accepts only explicit global and workspace destinations', () => {
    expect(parsePermission('notifications.send:global')).toMatchObject({ namespace: 'notifications', action: 'send', arg: 'global' });
    expect(parsePermission('notifications.send:workspace')).toMatchObject({ namespace: 'notifications', action: 'send', arg: 'workspace' });
    for (const value of ['notifications.send', 'notifications.send:both', 'notifications.send:*', 'notifications.send.extra:global']) expect(parsePermission(value)).toBeNull();
    expect(validateManifest({ ...validManifest(), permissions: { required: [], optional: ['notifications.send:global', 'notifications.send:workspace'] } }).ok).toBe(true);
  });
});

describe('validateManifest — links (card C7)', () => {
  it('accepts https host + path-prefix patterns', () => {
    const res = validateManifest({ ...validManifest(), links: { open: ['https://github.com/*', 'https://gitlab.com/org/*', 'https://docs.example.com/page'] } });
    expect(res.ok).toBe(true);
  });
  it.each([
    ['https://*.github.com/*', /no wildcards/],
    ['javascript:alert(1)', /https:\/\//],
    ['data:text/html,x', /https:\/\//],
    ['http://github.com/*', /https:\/\//],
    ['https://github.com:444/*', /no port/],
    ['https://github.com', /needs a path/],
    ['https://github.com/*/x', /only at the end/],
    ['https://github.com/a/../*', /normal form/],
  ])('rejects %s', (pattern, error) => {
    const res = validateManifest({ ...validManifest(), links: { open: [pattern] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join('\n')).toMatch(error);
    expect(linkPatternError(pattern)).toMatch(error);
  });
  it('rejects a malformed links block', () => {
    expect(validateManifest({ ...validManifest(), links: ['https://github.com/*'] })).toEqual({ ok: false, errors: ['links must be an object when present'] });
    // P2.1: only links.open; a frame or an OAuth sign-in is refused, not ignored.
    const frame = validateManifest({ ...validManifest(), links: { open: ['https://github.com/*'], frame: ['https://maps.example.com/*'] } });
    expect(frame.ok).toBe(false);
    expect(frame.ok ? [] : frame.errors).toEqual([expect.stringMatching(/^links\.frame isn't supported/)]);
    expect(validateManifest({ ...validManifest(), links: { open: 'https://github.com/*' } })).toEqual({ ok: false, errors: ['links.open must be an array of strings when present'] });
  });
});

// Card PM-b: the manifest picks ui / worker / container; the SDK pre-check
// accepts what the server accepts for each.
describe('validateManifest — placements', () => {
  const base = () => { const m = validManifest(); delete m.image; delete m.runtime; return m; };

  it('worker: runtime.kind worker with neither image nor exec', () => {
    expect(validateManifest({ ...base(), runtime: { kind: 'worker', port: 8080 } }).ok).toBe(true);
  });

  it('worker: an image or exec would be ignored, so it is an error', () => {
    const withImage = validateManifest({ ...base(), runtime: { kind: 'worker', port: 8080 }, image: { ref: 'r', tag: 't' } });
    expect(withImage.ok).toBe(false);
    const withExec = validateManifest({ ...base(), runtime: { kind: 'worker', port: 8080, exec: 'node s.js' } });
    expect(withExec.ok).toBe(false);
  });

  it('container: an image with dedicated or edge isolation and an instance type', () => {
    for (const isolation of ['dedicated', 'edge']) {
      expect(validateManifest({ ...base(), runtime: { port: 8080 }, image: { ref: 'r', tag: 't' }, isolation, resources: { instanceType: 'standard-1' } }).ok, isolation).toBe(true);
    }
  });

  it('refuses unknown runtime kinds and isolation values', () => {
    expect(validateManifest({ ...base(), runtime: { kind: 'lambda', port: 8080 }, image: { ref: 'r', tag: 't' } }).ok).toBe(false);
    expect(validateManifest({ ...base(), isolation: 'vm' }).ok).toBe(false);
  });
});

// Parity with the server, whose worker rules apply only with `worker` in TILEAPP_CF_PLACEMENTS.
describe('validateManifest — worker placement off on the target server', () => {
  const base = () => { const m = validManifest(); delete m.image; delete m.runtime; return m; };
  it('a worker runtime then needs an image or exec, and may carry one', () => {
    expect(validateManifest({ ...base(), runtime: { kind: 'worker', port: 8080 } }, { workerPlacement: false }).ok).toBe(false);
    expect(validateManifest({ ...base(), runtime: { kind: 'worker', port: 8080 }, image: { ref: 'r', tag: 't' } }, { workerPlacement: false }).ok).toBe(true);
  });
});

// P1.2: against the cutover profile the pre-check refuses what the server's publish refuses.
describe('validateManifest — cutover profile options', () => {
  const ui = (perms: string[]) => { const m = validManifest(); delete m.image; delete m.runtime; m.permissions = { required: perms }; return m; };
  const CUTOVER = { consentV2: true, fsRetired: true, staticPlacement: true };
  it('consent v2 refuses media.*, device.* and net: without a runtime', () => {
    for (const p of ['media.upload:video', 'device.clipboard:read', 'net:api.example.com']) {
      expect(validateManifest(ui([p]), { consentV2: true }).ok, p).toBe(false);
      expect(validateManifest(ui([p])).ok, `${p} by default`).toBe(true);
    }
  });
  it('fs retirement refuses every fs.*; without it, a pure-UI non-workspace fs.* is inert where static is on', () => {
    expect(validateManifest(ui(['fs.read:workspace']), CUTOVER).ok).toBe(false);
    expect(validateManifest(ui(['fs.readwrite:app-data']), { consentV2: true, staticPlacement: true }).ok).toBe(false);
    expect(validateManifest(ui(['fs.read:workspace']), { consentV2: true, staticPlacement: true }).ok).toBe(true);
  });
});
