/** Public Windows downloads are static files. This module never executes them. */
export const UPDATE_ORIGIN = 'https://monglemong.kr';
export const UPDATE_MANIFEST_URL = UPDATE_ORIGIN + '/updates/latest.json';
export const MAX_MANIFEST_BYTES = 16 * 1024;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const HASH = /^[A-Za-z0-9+/]{85}[AQgw]==$/;

export function compareVersions(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !VERSION.test(left) || !VERSION.test(right)) {
    throw new Error('업데이트 버전 정보가 올바르지 않아요.');
  }
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}

export function installerURL(version) {
  compareVersions(version, version);
  return `${UPDATE_ORIGIN}/updates/MongleMong-Setup-${version}-x64.exe`;
}

export function validateUpdateManifest(value) {
  const allowed = ['schemaVersion', 'version', 'url', 'sha512', 'size', 'publishedAt', 'notes'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || value.schemaVersion !== 1) {
    throw new Error('업데이트 정보를 확인하지 못했어요.');
  }
  const url = installerURL(value.version);
  if (value.url !== url || typeof value.sha512 !== 'string' || !HASH.test(value.sha512)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 1_000_000_000
    || typeof value.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.publishedAt)
    || !Number.isFinite(Date.parse(value.publishedAt)) || new Date(value.publishedAt).toISOString() !== value.publishedAt
    || value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.notes))) {
    throw new Error('업데이트 파일 정보가 올바르지 않아요.');
  }
  return Object.freeze({ schemaVersion: 1, version: value.version, url, sha512: value.sha512,
    size: value.size, publishedAt: value.publishedAt, notes: value.notes || '' });
}

export async function fetchUpdateManifest({ fetchImpl = globalThis.fetch?.bind(globalThis), signal } = {}) {
  const response = await fetchImpl(UPDATE_MANIFEST_URL, {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    throw new Error('업데이트 서버에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_MANIFEST_BYTES) { await response.body?.cancel(); throw new Error('업데이트 정보가 너무 커요.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('업데이트 정보를 읽지 못했어요.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new Error('업데이트 정보가 너무 커요.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('업데이트 정보를 읽지 못했어요.'); }
  return validateUpdateManifest(data);
}
