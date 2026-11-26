import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { prepareClient, variantManifest } from '../scripts/prepare-client.mjs';
import { createPreviewServer } from '../scripts/serve.mjs';
import { assertRuntimeMembers } from '../scripts/verify-windows-package.mjs';

const require = createRequire(import.meta.url);
const { normalizeApiBaseUrl, createSessionVault, createServiceBridge, validateRequest, readRuntimeConfig } = require('../electron/service-bridge.cjs');
const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const token = 'a'.repeat(43);
const otherToken = 'b'.repeat(43);
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=example&client_id=example';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'monglemong-variants-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t) {
  const projectRoot = temporary(t);
  for (const name of ['src', 'assets', 'electron', 'build', 'index.html', 'package.json']) {
    cpSync(join(root, name), join(projectRoot, name), { recursive: true });
  }
  const files = [];
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(directory, entry.name), prefix + entry.name + '/');
      else files.push(prefix + entry.name);
    }
  }
  collect(projectRoot);
  files.push('public-source-policy.json');
  writeFileSync(join(projectRoot, 'public-source-policy.json'), JSON.stringify({ schemaVersion: 1, files }));
  return projectRoot;
}

test('prepared user source preserves identity and excludes privileged or private runtime files', t => {
  const projectRoot = fixture(t);
  const user = prepareClient({ projectRoot, flavor: 'user', apiBaseUrl: 'https://game.example.com/' });
  assert.equal(user.manifest.build.appId, 'studio.mori.desktop');
  assert.equal(user.manifest.build.productName, 'MongleMong');
  assert.equal(user.releaseDirectory, join(projectRoot, 'release', 'user'));
  assert.deepEqual(JSON.parse(readFileSync(join(user.directory, 'src/runtime-config.json'), 'utf8')), user.config);
  assert.equal(user.config.flavor, 'user');
  assert.equal(user.config.apiBaseUrl, 'https://game.example.com');
  assert.match(readFileSync(join(user.directory, 'index.html'), 'utf8'), /connect-src 'self' https:\/\/game\.example\.com;/);
  for (const forbidden of ['server', '.env', 'src/.env', 'node_modules', 'assets/characters/unreleased.png', 'src/admin.js', 'src/admin.css']) {
    assert.equal(existsSync(join(user.directory, forbidden)), false, forbidden);
  }
  assert.ok(existsSync(join(user.directory, 'electron/service-bridge.cjs')));
  assert.ok(existsSync(join(user.directory, 'electron/native/window-surfaces.ps1')));
  const original = readFileSync(join(root, 'assets/characters/cafemong.png'));
  const bundled = readFileSync(join(user.directory, 'assets/characters/cafemong.png'));
  assert.equal(createHash('sha256').update(bundled).digest('hex'), createHash('sha256').update(original).digest('hex'));
  assert.equal(user.manifest.devDependencies, undefined);
  assert.doesNotMatch(readFileSync(join(user.directory, 'index.html'), 'utf8'), /src\/admin\.css/);
  assert.equal(source.version, user.manifest.version);
});

test('source preparation fails closed for private, unapproved, or missing allowlisted files', t => {
  const projectRoot = fixture(t);
  prepareClient({ projectRoot });
  const marker = join(projectRoot, 'build-clients/user/verified-marker.txt');
  writeFileSync(marker, 'Previous prepared output stays intact on rejection');
  for (const name of ['src/private-helper.js', 'src/admin.js', 'src/.env', 'assets/characters/unreleased.png']) {
    const file = join(projectRoot, name);
    writeFileSync(file, 'must-not-ship');
    assert.throws(() => prepareClient({ projectRoot }), /Public source check rejected/);
    assert.equal(existsSync(marker), true);
    rmSync(file);
  }
  mkdirSync(join(projectRoot, 'server'));
  writeFileSync(join(projectRoot, 'server', '.env'), 'must-not-ship');
  assert.throws(() => prepareClient({ projectRoot }), /private directories/);
  rmSync(join(projectRoot, 'server'), { recursive: true });
  rmSync(join(projectRoot, 'src/runtime-config.js'));
  assert.throws(() => prepareClient({ projectRoot }), /approved.*missing/);
});

test('generated directory links cannot redirect preparation into unrelated files', t => {
  const projectRoot = fixture(t);
  const unrelated = temporary(t);
  mkdirSync(join(unrelated, 'user'));
  const sentinel = join(unrelated, 'user', 'keep.txt');
  writeFileSync(sentinel, 'keep this data');
  for (const folder of ['build-clients', 'release']) {
    const link = join(projectRoot, folder);
    symlinkSync(unrelated, link, 'junction');
    assert.throws(() => prepareClient({ projectRoot }), /cannot be symlinks/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep this data');
    rmSync(link);
  }
});

test('privileged build arguments fail before generating or starting anything', t => {
  const projectRoot = temporary(t);
  assert.throws(() => prepareClient({ projectRoot, flavor: 'admin' }), /user builds only/);
  assert.throws(() => variantManifest(source, 'admin'), /user builds only/);
  assert.throws(() => createPreviewServer({ flavor: 'admin' }), /user builds only/);
  assert.equal(existsSync(join(projectRoot, 'build-clients')), false);
  for (const script of ['prepare-client.mjs', 'start-client.mjs', 'build-windows.mjs', 'verify-windows-package.mjs', 'serve.mjs']) {
    for (const mode of ['argument', 'environment']) {
      const child = spawnSync(process.execPath, [join(root, 'scripts', script), mode === 'argument' ? 'admin' : 'user'], {
        cwd: root, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, MONGLEMONG_BUILD_FLAVOR: mode === 'environment' ? 'admin' : 'user' },
      });
      assert.equal(child.error, undefined, script + ' must reject without launching a server or build');
      assert.equal(child.status, 1, script + ':' + mode);
      assert.match(child.stderr, /user builds only/);
    }
  }
});

test('preview exposes only user runtime resources and the configured service origin', async t => {
  const projectRoot = fixture(t);
  const server = createPreviewServer({ projectRoot, apiBaseUrl: 'https://game.example.com' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  // Even files added after preview validation cannot expand the served set.
  writeFileSync(join(projectRoot, 'src', 'admin.js'), 'must-not-ship');
  writeFileSync(join(projectRoot, 'src', 'private-helper.js'), 'must-not-ship');
  writeFileSync(join(projectRoot, 'assets', 'characters', 'unreleased.png'), 'must-not-ship');
  assert.match(await (await fetch(base + '/')).text(), /connect-src 'self' https:\/\/game\.example\.com;/);
  const config = await (await fetch(base + '/src/runtime-config.js')).text();
  assert.match(config, /"flavor":"user"/);
  assert.match(config, /"apiBaseUrl":"https:\/\/game.example.com"/);
  for (const path of ['/src/admin.js', '/src/admin.css', '/src/%61dmin.js', '/server/.env', '/src/.env', '/assets/characters/unreleased.png', '/src/private-helper.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/src/app.js')).status, 200);
  assert.equal((await fetch(base + '/assets/characters/cafemong.png')).status, 200);
});

test('public API configuration accepts HTTPS and local development only', () => {
  assert.equal(normalizeApiBaseUrl(''), '');
  assert.equal(normalizeApiBaseUrl('https://game.example.com/'), 'https://game.example.com');
  assert.equal(normalizeApiBaseUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
  assert.equal(normalizeApiBaseUrl('http://[::1]:3001'), 'http://[::1]:3001');
  for (const url of ['http://game.example.com', 'https://user:password@game.example.com', 'file:///tmp/x', 'https://game.example.com/private', 'https://game.example.com?token=x', 'https://game.example.com/#x']) {
    assert.throws(() => normalizeApiBaseUrl(url));
  }
  assert.throws(() => variantManifest(source, '../admin'));
});

test('installer verification rejects server data and authoring files in user builds', () => {
  for (const name of ['server/app.mjs', 'server/.env', 'data/game.sqlite', '.env.production', 'signing.key']) {
    assert.throws(() => assertRuntimeMembers(['index.html', name]));
  }
  assert.throws(() => assertRuntimeMembers(['src/admin.js'], { flavor: 'user' }));
  assert.throws(() => assertRuntimeMembers(['src/admin.css'], { flavor: 'user' }));
  assert.throws(() => assertRuntimeMembers(['src/admin.js', 'src/admin.css'], { flavor: 'admin' }));
  assert.throws(() => assertRuntimeMembers(['src/admin.js']));
  assert.throws(() => assertRuntimeMembers(['src/admin/authoring.js']));
  assert.throws(() => assertRuntimeMembers(['index.html', 'src/private-helper.js'], { approvedPaths: ['index.html', 'src/app.js'] }), /approved user source/);
  assert.doesNotThrow(() => assertRuntimeMembers(['src', 'src/app.js'], { approvedPaths: ['src/app.js'] }));
});

function encryption(available = true, backend = 'dpapi') {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from('encrypted:' + Buffer.from(value).toString('base64')),
    decryptString: bytes => {
      const value = bytes.toString();
      if (!value.startsWith('encrypted:')) throw new Error('Invalid encrypted data');
      return Buffer.from(value.slice(10), 'base64').toString();
    },
  };
}

test('sessions persist encrypted, restore, switch accounts and remove on logout', t => {
  const file = join(temporary(t), 'account.bin');
  const safeStorage = encryption();
  const vault = createSessionVault({ file, safeStorage });
  assert.equal(vault.has(), false);
  assert.deepEqual(vault.set(token), { persistent: true });
  assert.equal(readFileSync(file).includes(Buffer.from(token)), false);
  assert.equal(createSessionVault({ file, safeStorage }).get(), token);
  vault.set(otherToken);
  assert.equal(createSessionVault({ file, safeStorage }).get(), otherToken);
  vault.set(null);
  assert.equal(vault.has(), false);
  assert.equal(existsSync(file), false);
  assert.throws(() => vault.set('Bearer bad\r\nHeader:value'));
});

test('unavailable or plaintext OS storage keeps tokens in memory and removes stale disk sessions', t => {
  const file = join(temporary(t), 'account.bin');
  for (const safeStorage of [encryption(false), encryption(true, 'basic_text')]) {
    writeFileSync(file, 'old session');
    const vault = createSessionVault({ file, safeStorage });
    assert.equal(vault.has(), false);
    assert.deepEqual(vault.set(token), { persistent: false });
    assert.equal(vault.get(), token);
    assert.equal(existsSync(file), false);
  }
});

test('the transport rejects external paths, traversal and unsupported methods', () => {
  for (const path of ['https://evil.example/v1/me', '//evil.example/v1/me', '/v1/../admin', '/v1/me?token=x', '/v1/characters/%2f/sprite']) {
    assert.throws(() => validateRequest({ method: 'GET', path }));
  }
  for (const [path, methods] of [['/v1/admin/characters', ['GET', 'POST']], ['/v1/admin/characters/custom_fixture', ['GET', 'PUT', 'DELETE']]]) {
    for (const method of methods) assert.throws(() => validateRequest({ method, path, ...(method === 'GET' ? {} : { body: {} }) }));
  }
  assert.throws(() => validateRequest({ method: 'PATCH', path: '/v1/me' }));
  assert.throws(() => validateRequest({ method: 'GET', path: '/v1/me', body: { token } }));
  assert.deepEqual(validateRequest({ method: 'POST', path: '/v1/auth/poll', body: { verifier: 'x' } }), {
    method: 'POST', route: '/v1/auth/poll', serialized: '{"verifier":"x"}',
  });
});

test('changing runtime config cannot enable privileged transport', async t => {
  const directory = temporary(t);
  mkdirSync(join(directory, 'src'));
  const configFile = join(directory, 'src/runtime-config.json');
  writeFileSync(configFile, JSON.stringify({ flavor: 'user', apiBaseUrl: 'https://game.example.com' }));
  assert.deepEqual(readRuntimeConfig(directory), { flavor: 'user', apiBaseUrl: 'https://game.example.com' });
  writeFileSync(configFile, JSON.stringify({ flavor: 'admin', apiBaseUrl: 'https://game.example.com' }));
  assert.throws(() => readRuntimeConfig(directory), /클라이언트 종류/);
  let calls = 0;
  const bridge = createServiceBridge({ config: { flavor: 'admin', apiBaseUrl: 'https://game.example.com' },
    vault: { has: () => true, get: () => token },
    fetchImpl: async () => { calls++; return Response.json({ ok: true }); } });
  await assert.rejects(bridge.serviceRequest({ method: 'POST', path: '/v1/admin/characters', body: {} }));
  assert.equal(calls, 0, 'No privileged network request may be sent even with a tampered config or valid token');
});

test('authenticated API traffic stays on the configured origin and sprite bytes remain intact', async () => {
  const requests = [];
  const vault = { has: () => true, get: () => token, set: () => {} };
  const bridge = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' }, vault,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith('/sprite') ? new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'image/png' } })
        : Response.json({ ok: true });
    } });
  await bridge.serviceRequest({ method: 'POST', path: '/v1/auth/start', body: { challenge: 'x' } });
  await bridge.serviceRequest({ method: 'GET', path: '/v1/me' });
  const image = await bridge.serviceRequest({ method: 'GET', path: '/v1/characters/custom_123/sprite' });
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].url, 'https://game.example.com/v1/me');
  assert.equal(image.encoding, 'base64');
  assert.deepEqual(Buffer.from(image.body, 'base64'), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(bridge.serviceRequest({ method: 'GET', path: 'https://evil.example/v1/me' }));
});

test('only a fresh Google URL from the trusted login response can open a browser once', async () => {
  const opened = [];
  let now = 1;
  const bridge = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' },
    vault: { has: () => false, get: () => null, set: () => {} }, clock: () => now,
    fetchImpl: async () => Response.json({ authorizationUrl: authUrl }), openExternal: url => { opened.push(url); } });
  await assert.rejects(bridge.openAccountLogin(authUrl));
  await bridge.serviceRequest({ method: 'POST', path: '/v1/auth/start' });
  await assert.rejects(bridge.openAccountLogin('https://evil.example/'));
  await bridge.openAccountLogin(authUrl);
  assert.deepEqual(opened, [authUrl]);
  await assert.rejects(bridge.openAccountLogin(authUrl));
  await bridge.serviceRequest({ method: 'POST', path: '/v1/auth/start' });
  now += 300_001;
  await assert.rejects(bridge.openAccountLogin(authUrl));
});

test('an unconfigured or unreachable service fails clearly without exposing transport diagnostics', async () => {
  const vault = { has: () => false, get: () => null };
  const empty = createServiceBridge({ config: { apiBaseUrl: '' }, vault });
  await assert.rejects(empty.serviceRequest({ method: 'GET', path: '/v1/me' }), /설정되지/);
  const failed = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' }, vault,
    fetchImpl: async () => { throw new Error('internal secret transport detail'); } });
  await assert.rejects(failed.serviceRequest({ method: 'GET', path: '/v1/me' }), error => !error.message.includes('secret') && /연결하지/.test(error.message));
});
