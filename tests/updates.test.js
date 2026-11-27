import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVersions, installerURL, validateUpdateManifest, fetchUpdateManifest, UPDATE_MANIFEST_URL } from '../src/update-manifest.js';
import { prepareUpdate } from '../scripts/prepare-update.mjs';

const require = createRequire(import.meta.url);
const { createUpdateService } = require('../electron/update-service.cjs');
const sample = (overrides = {}) => ({ schemaVersion: 1, version: '0.11.0', url: installerURL('0.11.0'),
  sha512: createHash('sha512').update('fixture').digest('base64'), size: 100,
  publishedAt: '2026-11-27T00:00:00.000Z', notes: '새 기능', ...overrides });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('update manifests accept only stable versioned user installers at the fixed HTTPS origin', () => {
  assert.equal(validateUpdateManifest(sample()).version, '0.11.0');
  assert.equal(compareVersions('0.11.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  for (const version of ['01.2.3', '1.0', '1.0.0-beta', '1.0.0+build', '1.0.0/evil', '9999999.0.0']) assert.throws(() => installerURL(version));
  for (const url of ['http://monglemong.kr/updates/MongleMong-Setup-0.11.0-x64.exe',
    'https://evil.example/updates/MongleMong-Setup-0.11.0-x64.exe', 'file:///tmp/setup.exe',
    installerURL('0.11.0') + '?token=x', installerURL('0.11.0').replace('MongleMong-', 'MongleMong-Admin-'),
    installerURL('0.11.0').replace('0.11.0', '0.10.0')]) assert.throws(() => validateUpdateManifest(sample({ url })));
  for (const bad of [{ schemaVersion: 2 }, { size: 0 }, { size: 1_000_000_001 }, { sha512: 'invalid' },
    { publishedAt: '2026-02-30T00:00:00.000Z' }, { notes: 'x'.repeat(4001) }, { extra: 'field' }]) assert.throws(() => validateUpdateManifest(sample(bad)));
});

test('manifest fetch omits credentials, refuses redirects and bounds both announced and streamed bytes', async () => {
  let request;
  const result = await fetchUpdateManifest({ fetchImpl: async (...args) => { request = args; return json(sample()); } });
  assert.equal(result.version, '0.11.0'); assert.equal(request[0], UPDATE_MANIFEST_URL);
  assert.equal(request[1].credentials, 'omit'); assert.equal(request[1].redirect, 'error');
  assert.equal(request[1].headers.Authorization, undefined);
  assert.equal(await fetchUpdateManifest({ fetchImpl: async () => new Response('', { status: 404 }) }), null);
  await assert.rejects(fetchUpdateManifest({ fetchImpl: async () => new Response('<html>error</html>', { status: 503 }) }));
  await assert.rejects(fetchUpdateManifest({ fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '9999999' } }) }));
  await assert.rejects(fetchUpdateManifest({ fetchImpl: async () => new Response(' '.repeat(17000), { headers: { 'Content-Type': 'application/json' } }) }));
});

test('native downloads require a fresh successful newer-version check and ignore caller URLs', async () => {
  let now = 0, calls = 0;
  const opened = [];
  let response = sample();
  const service = createUpdateService({ currentVersion: '0.10.0', clock: () => now,
    fetchImpl: async () => { calls++; return json(response); }, openExternal: async url => opened.push(url) });
  await assert.rejects(service.openUpdateDownload('https://evil.example'));
  const [a, b] = await Promise.all([service.checkUpdates(), service.checkUpdates()]);
  assert.equal(calls, 1); assert.equal(a.available, true); assert.deepEqual(a, b);
  await service.openUpdateDownload('https://evil.example');
  assert.deepEqual(opened, [installerURL('0.11.0')]);
  now = 15 * 60_000 + 1;
  await assert.rejects(service.openUpdateDownload());
  response = sample({ version: '0.10.0', url: installerURL('0.10.0') });
  assert.equal((await service.checkUpdates()).available, false);
  await assert.rejects(service.openUpdateDownload());
  const privateBuild = createUpdateService({ currentVersion: '0.10.0', flavor: 'private', fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal((await privateBuild.checkUpdates()).supported, false);
  await assert.rejects(privateBuild.openUpdateDownload());
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'monglemong-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.11.0', build: { appId: 'studio.mori.desktop', productName: 'MongleMong' } }));
  mkdirSync(join(root, 'release/user'), { recursive: true });
  const installer = join(root, 'release/user/MongleMong-Setup-0.11.0-x64.exe');
  // Inert test bytes, not a built or executable Windows package. Production
  // always invokes the complete installer/archive verifier before staging.
  const bytes = Buffer.from('inert verified-result fixture');
  writeFileSync(installer, bytes);
  const verify = async options => {
    assert.equal(options.flavor, 'user'); assert.equal(options.installer, installer);
    return { flavor: 'user', version: '0.11.0', sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  return { root, installer, verify };
}

test('static staging verifies package before publishing exact byte hashes and writes manifest last', async t => {
  const { root, installer, verify } = fixture(t);
  const result = await prepareUpdate({ projectRoot: root, installer, verify, notes: '변경 내용' });
  assert.equal(result.release.sha512, createHash('sha512').update(readFileSync(installer)).digest('base64'));
  assert.deepEqual(readFileSync(result.installer), readFileSync(installer));
  assert.deepEqual(JSON.parse(readFileSync(result.manifest)), result.release);
  assert.ok(existsSync(join(result.directory, '.htaccess')));
  await assert.rejects(prepareUpdate({ projectRoot: root, installer, verify: async () => { throw new Error('verification failed'); } }), /verification failed/);
  assert.deepEqual(JSON.parse(readFileSync(result.manifest)), result.release, 'prior published files survive a rejected package');
  writeFileSync(installer, 'different bytes under same version');
  await assert.rejects(prepareUpdate({ projectRoot: root, installer, verify }), /changed after/);
});

test('staging rejects administrator names and generated output symlinks', async t => {
  const { root, installer, verify } = fixture(t);
  await assert.rejects(prepareUpdate({ projectRoot: root, installer: installer.replace('MongleMong-', 'MongleMong-Admin-'), verify }), /filename/);
  const other = mkdtempSync(join(tmpdir(), 'monglemong-update-target-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  symlinkSync(other, join(root, 'release/updates'), 'junction');
  await assert.rejects(prepareUpdate({ projectRoot: root, installer, verify }), /regular directory/);
  assert.equal(existsSync(join(other, 'latest.json')), false);
});
