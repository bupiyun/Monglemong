import assert from 'node:assert/strict';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWindowsPackage } from './verify-windows-package.mjs';
import { compareVersions, installerURL, validateUpdateManifest } from '../src/update-manifest.js';

const ROOT = resolve(import.meta.dirname, '..');
const APACHE_HEADERS = `<IfModule mod_headers.c>
  <Files "latest.json">
    Header set Cache-Control "no-cache"
    Header set Access-Control-Allow-Origin "*"
    Header set X-Content-Type-Options "nosniff"
  </Files>
  <FilesMatch "\\.exe$">
    Header set Content-Disposition "attachment"
    Header set X-Content-Type-Options "nosniff"
  </FilesMatch>
</IfModule>
`;

async function hashes(file) {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; sha256.update(chunk); sha512.update(chunk); }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size };
}

/** Prepare static upload files from a verified user installer; never build or upload. */
export async function prepareUpdate({ projectRoot = ROOT, installer, appDirectory, notes = '',
  publishedAt = new Date().toISOString(), verify = verifyWindowsPackage } = {}) {
  projectRoot = resolve(projectRoot);
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.build?.appId, 'studio.mori.desktop', 'Only the public user installer can be published');
  assert.equal(manifest.build?.productName, 'MongleMong', 'Only the public user installer can be published');
  const name = `MongleMong-Setup-${manifest.version}-x64.exe`;
  const source = resolve(installer || join(projectRoot, 'release/user', name));
  assert.equal(source.split(/[\\/]/).at(-1), name, 'Installer filename must match the current public user version');
  assert.equal(lstatSync(source).isFile(), true, 'Installer must be a regular file');
  const checked = await verify({ projectRoot, installer: source, appDirectory, flavor: 'user' });
  assert.equal(checked.flavor, 'user'); assert.equal(checked.version, manifest.version);
  // Never let a generated-directory link redirect file writes into other data.
  for (const name of ['release', 'release/updates']) {
    if (existsSync(join(projectRoot, name))) assert.equal(lstatSync(join(projectRoot, name)).isDirectory(), true, 'Update output must be a regular directory');
  }
  const output = join(projectRoot, 'release/updates');
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(projectRoot, 'release/.update-stage-'));
  try {
    const stagedInstaller = join(stage, name);
    copyFileSync(source, stagedInstaller);
    const digest = await hashes(stagedInstaller);
    assert.equal(digest.sha256, checked.sha256, 'Installer changed after package verification; build and verify again');
    const release = validateUpdateManifest({ schemaVersion: 1, version: manifest.version, url: installerURL(manifest.version),
      sha512: digest.sha512, size: digest.size, publishedAt, notes });
    const latest = join(output, 'latest.json');
    if (existsSync(latest)) {
      assert.equal(lstatSync(latest).isFile(), true, 'Update manifest must be a regular file');
      const previous = validateUpdateManifest(JSON.parse(readFileSync(latest, 'utf8')));
      assert.ok(compareVersions(release.version, previous.version) >= 0, 'Refusing to replace a newer published version');
      if (release.version === previous.version) assert.equal(release.sha512, previous.sha512, 'A published version cannot be replaced with different bytes; increase the version');
    }
    const destination = join(output, name);
    if (existsSync(destination)) {
      assert.equal(lstatSync(destination).isFile(), true, 'Update installer must be a regular file');
      assert.equal((await hashes(destination)).sha512, release.sha512, 'A versioned installer cannot be replaced with different bytes');
    } else renameSync(stagedInstaller, destination);
    const headers = join(output, '.htaccess');
    if (existsSync(headers)) assert.equal(lstatSync(headers).isFile(), true, 'Update headers must be a regular file');
    writeFileSync(join(stage, '.htaccess'), APACHE_HEADERS);
    writeFileSync(join(stage, 'latest.json'), JSON.stringify(release, null, 2) + '\n');
    renameSync(join(stage, '.htaccess'), headers);
    // Publish the local manifest last, after its exact installer is present.
    renameSync(join(stage, 'latest.json'), latest);
    return { directory: output, installer: destination, manifest: latest, release };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [installer, appDirectory] = process.argv.slice(2);
    const result = await prepareUpdate({ installer, appDirectory });
    console.log(`Prepared public update files: ${result.directory}`);
    console.log('Upload the installer and .htaccess to HTTPS /updates/ first, then upload latest.json last. No files were uploaded or executed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
