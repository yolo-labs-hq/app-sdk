/**
 * Publish @yolo-labs/app-sdk via npm's own `libnpmpublish` library.
 *
 * Why not plain `npm publish`: the npm CLI's publish path 403s ("forbidden by
 * your security policy") with our @yolo-labs token — its otplease/2FA wrapper
 * issues the request in a way the registry rejects — confirmed BOTH locally and
 * in CI. Calling `libnpmpublish.publish()` directly with `forceAuth: { token }`
 * sends a clean Bearer and succeeds (proven by @yolo-labs/flexdb 0.1.0-0.1.3).
 * This script does exactly that, so the CI auto-publish actually lands.
 *
 * Inputs:
 *   - NODE_AUTH_TOKEN (or NPM_TOKEN) in env — the npm auth token.
 *   - A packed tarball in cwd — the workflow runs `npm pack` first (which runs
 *     prepack = build). Published with public access.
 */
const { execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

/** Load npm's bundled libnpmpublish (always ships with the npm CLI) — no devDep. */
function loadPublish() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'npm', 'node_modules', 'libnpmpublish')).publish;
  } catch (e1) {
    try {
      return require('libnpmpublish').publish; // fallback if it's installed normally
    } catch (e2) {
      throw new Error(`Could not load libnpmpublish: ${e1.message} / ${e2.message}`);
    }
  }
}

(async () => {
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!token) {
    console.error('No NODE_AUTH_TOKEN / NPM_TOKEN in env.');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  // npm pack flattens the scoped name: @yolo-labs/app-sdk → yolo-labs-app-sdk
  const tgz = `${manifest.name.replace(/^@/, '').replace(/\//g, '-')}-${manifest.version}.tgz`;
  if (!existsSync(tgz)) {
    console.error(`Tarball ${tgz} not found — run \`npm pack\` first.`);
    process.exit(1);
  }
  const publish = loadPublish();
  try {
    await publish(manifest, readFileSync(tgz), {
      registry: 'https://registry.npmjs.org/',
      access: (manifest.publishConfig && manifest.publishConfig.access) || 'public',
      defaultTag: 'latest',
      forceAuth: { token },
    });
    console.log(`Published ${manifest.name}@${manifest.version} (public).`);
  } catch (e) {
    console.error(`Publish failed: code=${e.code} status=${e.statusCode}`);
    console.error('body:', typeof e.body === 'object' ? JSON.stringify(e.body) : String(e.body || '').slice(0, 500));
    process.exit(1);
  }
})();
