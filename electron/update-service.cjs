'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const manifestModule = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'update-manifest.js')).href);

/** Opens only the verified, recently checked public installer in a browser. */
function createUpdateService({ currentVersion, flavor = 'user', fetchImpl = fetch, openExternal, clock = Date.now }) {
  let approved = null;
  let checking = null;
  async function check() {
    if (flavor !== 'user') return { supported: false, currentVersion, available: false, release: null };
    if (checking) return checking;
    approved = null;
    checking = (async () => {
      const { compareVersions, fetchUpdateManifest } = await manifestModule();
      const release = await fetchUpdateManifest({ fetchImpl, signal: AbortSignal.timeout(15_000) });
      const available = Boolean(release && compareVersions(release.version, currentVersion) > 0);
      if (available) approved = { release, expiresAt: clock() + 15 * 60_000 };
      return { supported: true, currentVersion, available, release };
    })().catch(() => { throw new Error('업데이트를 확인하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'); })
      .finally(() => { checking = null; });
    return checking;
  }
  async function openDownload() {
    if (!approved || flavor !== 'user' || approved.expiresAt < clock()) throw new Error('업데이트를 다시 확인한 뒤 다운로드해 주세요.');
    // No URL or file path supplied by the renderer is accepted.
    const { validateUpdateManifest } = await manifestModule();
    const release = validateUpdateManifest(approved.release);
    await openExternal(release.url);
    return true;
  }
  return { checkUpdates: check, openUpdateDownload: openDownload };
}

module.exports = { createUpdateService };
