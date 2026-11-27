import { compareVersions, fetchUpdateManifest, validateUpdateManifest } from './update-manifest.js';

/** User-initiated update checks; installation remains an explicit user action. */
export function mountUpdatesPanel(container, { desktop, version, currentVersion = version, flavor = 'user', fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  container.innerHTML = `<section class="account-panel" aria-labelledby="updates-heading">
    <div class="account-heading"><div><h3 id="updates-heading">프로그램 업데이트</h3><p id="updates-version"></p></div></div>
    <p id="updates-status" class="account-status" role="status"></p>
    <p id="updates-notes" class="account-note" hidden></p>
    <div class="account-actions"><button type="button" id="updates-check" class="primary-button">업데이트 확인</button>
      <a id="updates-download" class="secondary-button" target="_blank" rel="noopener noreferrer" hidden>설치 파일 다운로드</a></div>
    <p class="account-note">새 설치 파일을 내려받은 뒤 게임을 종료하고 직접 설치해 주세요. 기존 기기 저장과 계정 데이터는 유지됩니다.</p>
    <p id="updates-error" class="account-error" role="alert" hidden></p>
  </section>`;
  const find = id => container.querySelector('#' + id);
  let disposed = false, busy = false, release = null, controller = null;
  const native = typeof desktop?.checkUpdates === 'function';
  find('updates-version').textContent = `현재 버전 ${currentVersion}`;
  find('updates-status').textContent = flavor === 'user' ? '필요할 때 새 버전을 확인할 수 있어요.' : '이 빌드는 제공받은 소스로 따로 업데이트해 주세요.';
  find('updates-check').disabled = flavor !== 'user';
  function error(message) { find('updates-error').textContent = message; find('updates-error').hidden = !message; }
  find('updates-check').onclick = async () => {
    if (disposed || busy || flavor !== 'user') return;
    busy = true; release = null; error('');
    find('updates-check').disabled = true;
    find('updates-download').hidden = true; find('updates-download').removeAttribute('href');
    find('updates-notes').hidden = true;
    find('updates-status').textContent = '새 버전을 확인하고 있어요…';
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 15_000);
    try {
      const result = native ? await desktop.checkUpdates() : await (async () => {
        const latest = await fetchUpdateManifest({ fetchImpl, signal: controller.signal });
        return { supported: true, currentVersion, available: Boolean(latest && compareVersions(latest.version, currentVersion) > 0), release: latest };
      })();
      if (disposed) return;
      if (!result.supported) { find('updates-status').textContent = '이 빌드는 제공받은 소스로 따로 업데이트해 주세요.'; return; }
      if (result.release) release = validateUpdateManifest(result.release);
      find('updates-status').textContent = !release ? '아직 공개된 업데이트 파일이 없어요.'
        : result.available ? `${release.version} 버전을 받을 수 있어요. (${(release.size / 1024 / 1024).toFixed(1)} MB)` : '현재 버전이 최신이에요.';
      if (result.available && release) {
        const link = find('updates-download'); link.href = release.url; link.hidden = false;
        find('updates-notes').textContent = release.notes; find('updates-notes').hidden = !release.notes;
      }
    } catch (cause) {
      if (!disposed) { find('updates-status').textContent = '업데이트 확인을 완료하지 못했어요.'; error(cause.message || '잠시 후 다시 확인해 주세요.'); }
    } finally { clearTimeout(timer); controller = null; if (!disposed) { busy = false; find('updates-check').disabled = flavor !== 'user'; } }
  };
  find('updates-download').onclick = async event => {
    if (!native) return;
    event.preventDefault();
    if (disposed || !release) return;
    try { await desktop.openUpdateDownload(); }
    catch (cause) { if (!disposed) error(cause.message || '다운로드를 시작하지 못했어요.'); }
  };
  return { dispose() { disposed = true; controller?.abort(); release = null; } };
}
