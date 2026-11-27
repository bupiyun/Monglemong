import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { prepareClient, resolveClientApiBaseUrl, variantManifest } from '../scripts/prepare-client.mjs';
import { createPreviewServer } from '../scripts/serve.mjs';
import { assertRuntimeMembers } from '../scripts/verify-windows-package.mjs';
import { RUNTIME_CONFIG } from '../src/runtime-config.js';

const require = createRequire(import.meta.url);
const { normalizeApiBaseUrl, createSessionVault, createServiceBridge, validateRequest, readRuntimeConfig } = require('../electron/service-bridge.cjs');
const root = resolve(import.meta.dirname, '..');
const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const token = 'a'.repeat(43);
const otherToken = 'b'.repeat(43);

function restoreApiEnvironment(t) {
  const previous = process.env.MONGLEMONG_API_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.MONGLEMONG_API_URL;
    else process.env.MONGLEMONG_API_URL = previous;
  });
}

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

test('the checked-in service origin reaches default prepared source and its browser policy', async t => {
  restoreApiEnvironment(t);
  delete process.env.MONGLEMONG_API_URL;
  const sourceConfig = JSON.parse(readFileSync(join(root, 'src/runtime-config.json'), 'utf8'));
  assert.deepEqual(RUNTIME_CONFIG, sourceConfig, 'direct source and Electron use the same nonsecret configuration');
  assert.equal(sourceConfig.flavor, 'user');
  assert.equal(new URL(sourceConfig.apiBaseUrl).protocol, 'https:');
  const user = prepareClient({ projectRoot: fixture(t) });
  assert.deepEqual(user.config, sourceConfig);
  assert.deepEqual(readRuntimeConfig(user.directory), sourceConfig);
  const moduleText = readFileSync(join(user.directory, 'src/runtime-config.js'), 'utf8');
  assert.deepEqual((await import('data:text/javascript,' + encodeURIComponent(moduleText))).RUNTIME_CONFIG, sourceConfig);
  const html = readFileSync(join(user.directory, 'index.html'), 'utf8');
  assert.ok(html.includes(`connect-src 'self' ${sourceConfig.apiBaseUrl};`));
  assert.deepEqual(Object.keys(user.config).sort(), ['apiBaseUrl', 'flavor']);
});

test('environment and explicit service overrides preserve local and empty guest-only configurations', t => {
  restoreApiEnvironment(t);
  const projectRoot = fixture(t);
  process.env.MONGLEMONG_API_URL = 'http://localhost:8787';
  assert.equal(prepareClient({ projectRoot }).config.apiBaseUrl, 'http://localhost:8787');
  assert.equal(prepareClient({ projectRoot, apiBaseUrl: 'https://override.example' }).config.apiBaseUrl, 'https://override.example');
  process.env.MONGLEMONG_API_URL = '';
  const guest = prepareClient({ projectRoot });
  assert.equal(guest.config.apiBaseUrl, '');
  assert.match(readFileSync(join(guest.directory, 'index.html'), 'utf8'), /connect-src 'self' https:\/\/monglemong\.kr;/, 'Guest-only builds can still request public update metadata');
  assert.deepEqual(readRuntimeConfig(guest.directory), { flavor: 'user', apiBaseUrl: '' });
  process.env.MONGLEMONG_API_URL = 'https://override.example';
  assert.equal(prepareClient({ projectRoot, apiBaseUrl: '' }).config.apiBaseUrl, '');
  process.env.MONGLEMONG_API_URL = 'http://monglemong.kr';
  assert.throws(() => prepareClient({ projectRoot }), /HTTPS/);
  delete process.env.MONGLEMONG_API_URL;
  writeFileSync(join(projectRoot, 'src/runtime-config.json'), JSON.stringify({ flavor: 'user', apiBaseUrl: 'http://monglemong.kr' }));
  assert.throws(() => resolveClientApiBaseUrl(projectRoot), /HTTPS/);
});

test('preview uses the same default and overridden origins as preparation without contacting production', async t => {
  restoreApiEnvironment(t);
  const projectRoot = fixture(t);
  for (const [override, expected] of [[undefined, RUNTIME_CONFIG.apiBaseUrl], ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'], ['', '']]) {
    if (override === undefined) delete process.env.MONGLEMONG_API_URL;
    else process.env.MONGLEMONG_API_URL = override;
    const server = createPreviewServer({ projectRoot });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const moduleText = await (await fetch(base + '/src/runtime-config.js')).text();
    const config = (await import('data:text/javascript,' + encodeURIComponent(moduleText))).RUNTIME_CONFIG;
    assert.deepEqual(config, { flavor: 'user', apiBaseUrl: expected });
    const html = await (await fetch(base + '/')).text();
    const origins = html.match(/connect-src 'self' ([^;]+);/)[1].split(' ');
    assert.deepEqual(origins, [...new Set([expected, 'https://monglemong.kr'].filter(Boolean))]);
    assert.deepEqual(config, prepareClient({ projectRoot }).config);
  }
});

test('prepared user source preserves identity and excludes privileged or private runtime files', t => {
  const projectRoot = fixture(t);
  const user = prepareClient({ projectRoot, flavor: 'user', apiBaseUrl: 'https://game.example.com/' });
  assert.equal(user.manifest.build.appId, 'studio.mori.desktop');
  assert.equal(user.manifest.build.productName, 'MongleMong');
  assert.equal(user.releaseDirectory, join(projectRoot, 'release', 'user'));
  assert.deepEqual(JSON.parse(readFileSync(join(user.directory, 'src/runtime-config.json'), 'utf8')), user.config);
  assert.equal(user.config.flavor, 'user');
  assert.equal(user.config.apiBaseUrl, 'https://game.example.com');
  assert.match(readFileSync(join(user.directory, 'index.html'), 'utf8'), /connect-src 'self' https:\/\/game\.example\.com https:\/\/monglemong\.kr;/);
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
  assert.match(await (await fetch(base + '/')).text(), /connect-src 'self' https:\/\/game\.example\.com https:\/\/monglemong\.kr;/);
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

function encryptedFixture(value, legacy = false) {
  return Buffer.from((legacy ? 'encrypted:' : 'encrypted-v2:') + Buffer.from(value).toString('base64'));
}

function encryption(available = true, backend = 'dpapi') {
  const deprecatedCalls = [];
  const deprecated = name => () => { deprecatedCalls.push(name); throw new Error(`Deprecated API: ${name}`); };
  return {
    deprecatedCalls,
    isEncryptionAvailable: deprecated('isEncryptionAvailable'),
    encryptString: deprecated('encryptString'),
    decryptString: deprecated('decryptString'),
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async value => encryptedFixture(value),
    decryptStringAsync: async bytes => {
      const value = bytes.toString();
      const prefix = value.startsWith('encrypted-v2:') ? 'encrypted-v2:' : 'encrypted:';
      if (!value.startsWith(prefix)) throw new Error('Invalid encrypted data');
      return { result: Buffer.from(value.slice(prefix.length), 'base64').toString(), shouldReEncrypt: prefix === 'encrypted:' };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('sessions persist encrypted, restore, switch accounts and remove on logout using only async OS APIs', async t => {
  const file = join(temporary(t), 'account.bin');
  const safeStorage = encryption();
  const vault = createSessionVault({ file, safeStorage });
  assert.equal(await vault.has(), false);
  assert.deepEqual(await vault.set(token), { persistent: true });
  assert.equal(readFileSync(file).includes(Buffer.from(token)), false);
  assert.equal(await createSessionVault({ file, safeStorage }).get(), token);
  await vault.set(otherToken);
  assert.equal(await createSessionVault({ file, safeStorage }).get(), otherToken);
  await vault.set(null);
  assert.equal(await vault.has(), false);
  assert.equal(existsSync(file), false);
  assert.throws(() => vault.set('Bearer bad\r\nHeader:value'));
  assert.deepEqual(safeStorage.deprecatedCalls, []);
});

test('false, rejected or plaintext OS availability keeps tokens in memory and removes stale disk sessions', async t => {
  const file = join(temporary(t), 'account.bin');
  const rejected = { ...encryption(), isAsyncEncryptionAvailable: async () => { throw new Error('Keychain unavailable'); } };
  for (const safeStorage of [encryption(false), encryption(true, 'basic_text'), rejected, {}]) {
    let encryptionCalls = 0;
    safeStorage.encryptStringAsync = async () => { encryptionCalls++; throw new Error('Must not encrypt'); };
    writeFileSync(file, 'old session');
    const vault = createSessionVault({ file, safeStorage });
    assert.equal(await vault.has(), false);
    assert.deepEqual(await vault.set(token), { persistent: false });
    assert.equal(await vault.get(), token);
    assert.equal(existsSync(file), false);
    assert.equal(encryptionCalls, 0, 'a Promise resolving false must not be treated as available');
    assert.deepEqual(safeStorage.deprecatedCalls || [], []);
  }
});

test('legacy ciphertext restores from the async result object and rotates atomically when requested', async t => {
  const file = join(temporary(t), 'account.bin');
  const safeStorage = encryption();
  writeFileSync(file, encryptedFixture(token, true));
  assert.equal(await createSessionVault({ file, safeStorage }).get(), token);
  assert.deepEqual(readFileSync(file), encryptedFixture(token));
  assert.equal(existsSync(file + '.tmp'), false);
  assert.equal(await createSessionVault({ file, safeStorage }).get(), token);
  assert.deepEqual(safeStorage.deprecatedCalls, []);
});

test('a failed key-rotation rewrite preserves the previous encrypted session and cleans its temporary file', async t => {
  const file = join(temporary(t), 'account.bin');
  const original = encryptedFixture(token, true);
  writeFileSync(file, original);
  const io = { ...require('node:fs'), renameSync() { throw new Error('Rename denied'); } };
  const vault = createSessionVault({ file, safeStorage: encryption(), io });
  assert.equal(await vault.get(), token);
  assert.deepEqual(readFileSync(file), original);
  assert.equal(existsSync(file + '.tmp'), false);
});

test('corrupt, oversized, invalid and undecryptable session files fail closed without blocking later login', async t => {
  const file = join(temporary(t), 'account.bin');
  const scenarios = [
    { bytes: Buffer.from('not encrypted'), safeStorage: encryption() },
    { bytes: Buffer.alloc(8193), safeStorage: encryption() },
    { bytes: encryptedFixture('invalid token'), safeStorage: encryption() },
    { bytes: encryptedFixture(token), safeStorage: { ...encryption(), decryptStringAsync: async () => { throw new Error('Decrypt failed'); } } },
    { bytes: encryptedFixture(token), safeStorage: { ...encryption(), decryptStringAsync: async () => token } },
  ];
  for (const { bytes, safeStorage } of scenarios) {
    writeFileSync(file, bytes);
    const vault = createSessionVault({ file, safeStorage });
    assert.equal(await vault.get(), null);
    assert.equal(existsSync(file), false);
    assert.deepEqual(await vault.set(otherToken), { persistent: true });
    assert.equal(await vault.get(), otherToken);
    await vault.set(null);
  }
});

test('logout queued during slow restoration cannot be undone by restored or rotated ciphertext', async t => {
  const file = join(temporary(t), 'account.bin');
  writeFileSync(file, encryptedFixture(token, true));
  const started = deferred();
  const release = deferred();
  const safeStorage = encryption();
  const decrypt = safeStorage.decryptStringAsync;
  safeStorage.decryptStringAsync = async bytes => { started.resolve(); await release.promise; return decrypt(bytes); };
  const vault = createSessionVault({ file, safeStorage });
  const logout = vault.set(null);
  const hasSession = vault.has();
  await started.promise;
  release.resolve();
  assert.deepEqual(await logout, { persistent: false });
  assert.equal(await hasSession, false);
  assert.equal(await vault.get(), null);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(file + '.tmp'), false);
});

test('slow encryption serializes account switching and logout without restoring an earlier token', async t => {
  const file = join(temporary(t), 'account.bin');
  const started = deferred();
  const release = deferred();
  const encrypted = [];
  const safeStorage = encryption();
  safeStorage.encryptStringAsync = async value => {
    encrypted.push(value);
    if (encrypted.length === 1) { started.resolve(); await release.promise; }
    return encryptedFixture(value);
  };
  const vault = createSessionVault({ file, safeStorage });
  const first = vault.set(token);
  await started.promise;
  const second = vault.set(otherToken);
  const logout = vault.set(null);
  const finalToken = vault.get();
  assert.deepEqual(encrypted, [token], 'later writes must wait for the first encryption');
  release.resolve();
  assert.deepEqual(await first, { persistent: true });
  assert.deepEqual(await second, { persistent: true });
  assert.deepEqual(await logout, { persistent: false });
  assert.deepEqual(encrypted, [token, otherToken]);
  assert.equal(await finalToken, null);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(file + '.tmp'), false);
});

test('encryption and disk-write failures remove the old account file and allow a later retry', async t => {
  const file = join(temporary(t), 'account.bin');
  for (const failure of ['encrypt', 'write', 'rename']) {
    writeFileSync(file, encryptedFixture(token));
    let failing = true;
    const safeStorage = encryption();
    safeStorage.encryptStringAsync = async value => {
      if (failing && failure === 'encrypt') throw new Error('Encrypt failed');
      return encryptedFixture(value);
    };
    const fs = require('node:fs');
    const io = { ...fs,
      writeFileSync(...args) { if (failing && failure === 'write') throw new Error('Write failed'); return fs.writeFileSync(...args); },
      renameSync(...args) { if (failing && failure === 'rename') throw new Error('Rename failed'); return fs.renameSync(...args); },
    };
    const vault = createSessionVault({ file, safeStorage, io });
    assert.equal(await vault.get(), token);
    assert.deepEqual(await vault.set(otherToken), { persistent: false });
    assert.equal(await vault.get(), otherToken, 'the new session remains usable in memory');
    assert.equal(existsSync(file), false, 'the previous account must not return on restart');
    assert.equal(existsSync(file + '.tmp'), false);
    failing = false;
    assert.deepEqual(await vault.set(otherToken), { persistent: true });
    await vault.set(null);
  }
});

test('failed session cleanup is reported without poisoning the queue for logout or retry', async t => {
  const file = join(temporary(t), 'account.bin');
  writeFileSync(file, encryptedFixture(token));
  let denyRemoval = false;
  const fs = require('node:fs');
  const io = { ...fs, rmSync(target, ...args) {
    if (denyRemoval && target === file) throw new Error('Remove denied');
    return fs.rmSync(target, ...args);
  } };
  const vault = createSessionVault({ file, safeStorage: encryption(), io });
  assert.equal(await vault.get(), token);
  denyRemoval = true;
  await assert.rejects(vault.set(otherToken), /이전 로그인 세션/);
  assert.equal(await vault.get(), null);
  denyRemoval = false;
  await vault.set(otherToken);
  denyRemoval = true;
  await assert.rejects(vault.set(null), /지우지 못했어요/);
  assert.equal(await vault.has(), false);
  denyRemoval = false;
  assert.deepEqual(await vault.set(null), { persistent: false });
  assert.equal(existsSync(file), false);
  assert.deepEqual(await vault.set(token), { persistent: true });
});

test('service requests await vault restoration and queued saves before attaching a bearer token', async t => {
  const file = join(temporary(t), 'account.bin');
  writeFileSync(file, encryptedFixture(token));
  const restoreStarted = deferred();
  const restoreRelease = deferred();
  const saveStarted = deferred();
  const saveRelease = deferred();
  const safeStorage = encryption();
  const decrypt = safeStorage.decryptStringAsync;
  safeStorage.decryptStringAsync = async bytes => { restoreStarted.resolve(); await restoreRelease.promise; return decrypt(bytes); };
  safeStorage.encryptStringAsync = async value => { saveStarted.resolve(); await saveRelease.promise; return encryptedFixture(value); };
  const requests = [];
  const vault = createSessionVault({ file, safeStorage });
  const bridge = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' }, vault,
    fetchImpl: async (_url, options) => { requests.push(options.headers); return Response.json({ ok: true }); } });
  const hasSession = bridge.getAccountSession();
  const restoredRequest = bridge.serviceRequest({ method: 'GET', path: '/v1/me' });
  await restoreStarted.promise;
  assert.equal(requests.length, 0);
  restoreRelease.resolve();
  assert.equal(await hasSession, true);
  await restoredRequest;
  assert.equal(requests[0].Authorization, `Bearer ${token}`);
  const save = bridge.setAccountSession(otherToken);
  await saveStarted.promise;
  const switchedRequest = bridge.serviceRequest({ method: 'GET', path: '/v1/me' });
  assert.equal(requests.length, 1);
  saveRelease.resolve();
  await save;
  await switchedRequest;
  assert.equal(requests[1].Authorization, `Bearer ${otherToken}`);
  assert.deepEqual(safeStorage.deprecatedCalls, []);
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
  assert.deepEqual(validateRequest({ method: 'POST', path: '/v1/auth/login', body: { username: 'player', password: 'fixture-password' } }), {
    method: 'POST', route: '/v1/auth/login', serialized: '{"username":"player","password":"fixture-password"}',
  });
  for (const path of ['/v1/auth/start', '/v1/auth/poll']) assert.throws(() => validateRequest({ method: 'POST', path, body: {} }));
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
  await bridge.serviceRequest({ method: 'POST', path: '/v1/auth/login', body: { username: 'player', password: 'fixture-password' } });
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

test('registration stays anonymous while password changes and deletion require the current session', async () => {
  const requests = [];
  const bridge = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' },
    vault: { has: () => true, get: () => token, set: () => {} },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ ok: true }); } });
  await bridge.serviceRequest({ method: 'POST', path: '/v1/auth/register', body: { username: 'player', password: 'fixture-password' } });
  await bridge.serviceRequest({ method: 'POST', path: '/v1/account/password', body: { currentPassword: 'fixture-password', newPassword: 'replacement-password' } });
  await bridge.serviceRequest({ method: 'DELETE', path: '/v1/account', body: { password: 'replacement-password' } });
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[2].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[2].options.method, 'DELETE');
  assert.equal(JSON.parse(requests[1].options.body).newPassword, 'replacement-password');
  assert.equal(bridge.openAccountLogin, undefined, 'credential login must never open an external authorization page');
  for (const path of ['/v1/auth/start', '/v1/auth/poll']) await assert.rejects(bridge.serviceRequest({ method: 'POST', path }));
  assert.equal(requests.length, 3);
});

test('an unconfigured or unreachable service fails clearly without exposing transport diagnostics', async () => {
  const vault = { has: () => false, get: () => null };
  const empty = createServiceBridge({ config: { apiBaseUrl: '' }, vault });
  await assert.rejects(empty.serviceRequest({ method: 'GET', path: '/v1/me' }), /설정되지/);
  const failed = createServiceBridge({ config: { apiBaseUrl: 'https://game.example.com' }, vault,
    fetchImpl: async () => { throw new Error('internal secret transport detail'); } });
  await assert.rejects(failed.serviceRequest({ method: 'GET', path: '/v1/me' }), error => !error.message.includes('secret') && /연결하지/.test(error.message));
});
