'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 32 * 1024 * 1024;
const MAX_RESPONSE = 24 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ROUTES = [
  [/^\/v1\/auth\/(register|login)$/, ['POST']],
  [/^\/v1\/me$/, ['GET']],
  [/^\/v1\/logout$/, ['POST']],
  [/^\/v1\/account$/, ['DELETE']],
  [/^\/v1\/account\/password$/, ['POST']],
  [/^\/v1\/game\/(sync|action)$/, ['POST']],
  [/^\/v1\/characters$/, ['GET']],
  [/^\/v1\/characters\/[A-Za-z0-9_-]{1,100}\/sprite$/, ['GET']],
];

function normalizeApiBaseUrl(value) {
  if (value === '' || value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('서비스 주소가 올바르지 않아요.');
  let url;
  try { url = new URL(value); } catch { throw new Error('서비스 주소가 올바르지 않아요.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('서비스 주소는 HTTPS 원점을 사용해 주세요. 로컬 개발에서는 localhost HTTP를 사용할 수 있어요.');
  }
  return url.origin;
}

function readRuntimeConfig(root) {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'src', 'runtime-config.json'), 'utf8'));
  if (value.flavor !== 'user') throw new Error('클라이언트 종류가 올바르지 않아요.');
  return { flavor: value.flavor, apiBaseUrl: normalizeApiBaseUrl(value.apiBaseUrl) };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('올바르지 않은 서비스 요청이에요.');
  const { method, path: route, body } = request;
  if (typeof route !== 'string' || !ROUTES.some(([pattern, methods]) => pattern.test(route) && methods.includes(method))) {
    throw new Error('허용되지 않은 서비스 요청이에요.');
  }
  if (method === 'GET' && body !== undefined && body !== null) throw new Error('GET 요청에 본문을 보낼 수 없어요.');
  let serialized;
  if (body !== undefined && body !== null) {
    if (typeof body !== 'object' || Array.isArray(body)) throw new Error('요청 본문이 올바르지 않아요.');
    try { serialized = JSON.stringify(body); } catch { throw new Error('요청 본문을 읽지 못했어요.'); }
    if (Buffer.byteLength(serialized) > MAX_BODY) throw new Error('요청 크기가 너무 커요.');
  }
  return { method, route, serialized };
}

/** Store only encrypted opaque sessions. Linux's plaintext fallback is refused. */
function createSessionVault({ file, safeStorage, io = fs }) {
  let token = null;
  const encryptionAvailable = async () => {
    try {
      return await safeStorage?.isAsyncEncryptionAvailable() === true
        && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  };
  const remove = () => {
    try { io.rmSync(file, { force: true }); return true; } catch { return false; }
  };
  const persist = async value => {
    const temporary = file + '.tmp';
    try {
      const encrypted = await safeStorage.encryptStringAsync(value);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 8192) throw new Error('Invalid encrypted session');
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(temporary, encrypted, { mode: 0o600 });
      io.renameSync(temporary, file);
      return true;
    } catch {
      try { io.rmSync(temporary, { force: true }); } catch {}
      return false;
    }
  };
  // Initialize without delaying the window/tray. Every account operation waits
  // for restoration, and writes run in order so logout cannot be undone by a
  // slower encryption operation that started earlier.
  let pending = (async () => {
    if (!await encryptionAvailable()) { remove(); return; }
    try {
      const encrypted = io.readFileSync(file);
      if (encrypted.length > 8192) throw new Error('Invalid encrypted session');
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
      if (typeof result !== 'string' || !TOKEN.test(result)) throw new Error('Invalid session');
      token = result;
      // Old synchronous ciphertext is compatible. Rotate it atomically when
      // requested; a failed rewrite preserves the still-valid encrypted file.
      if (shouldReEncrypt) await persist(result);
    } catch { remove(); }
  })();
  return {
    get: async () => { await pending; return token; },
    has: async () => { await pending; return Boolean(token); },
    set(value) {
      if (value !== null && (typeof value !== 'string' || !TOKEN.test(value))) throw new Error('로그인 세션이 올바르지 않아요.');
      const operation = pending.then(async () => {
        token = value;
        if (!value) {
          if (!remove()) throw new Error('저장된 로그인 세션을 지우지 못했어요. 앱을 종료하기 전에 다시 시도해 주세요.');
          return { persistent: false };
        }
        // Never leave a previous account's session on disk after a failed switch.
        if (!remove()) { token = null; throw new Error('이전 로그인 세션을 정리하지 못했어요.'); }
        if (!await encryptionAvailable()) return { persistent: false };
        return { persistent: await persist(value) };
      });
      // A failed operation is reported to its caller, but must not poison the
      // queue and prevent a later logout or retry from running.
      pending = operation.then(() => {}, () => {});
      return operation;
    },
  };
}

async function readBoundedResponse(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw new Error('서버 응답이 너무 커요.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('서버 응답이 너무 커요.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

function createServiceBridge({ config, vault, fetchImpl = fetch }) {
  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  return {
    getAccountSession: () => vault.has(),
    setAccountSession: token => vault.set(token),
    async serviceRequest(request) {
      if (!apiBaseUrl) throw new Error('온라인 서비스 주소가 설정되지 않았어요.');
      const { method, route, serialized } = validateRequest(request);
      const headers = { Accept: 'application/json, image/png' };
      if (serialized) headers['Content-Type'] = 'application/json';
      const token = await vault.get();
      if (token && !route.startsWith('/v1/auth/')) headers.Authorization = `Bearer ${token}`;
      let response;
      try {
        response = await fetchImpl(apiBaseUrl + route, {
          method, headers, body: serialized, redirect: 'error', signal: AbortSignal.timeout(20_000),
        });
      } catch { throw new Error('서버에 연결하지 못했어요. 연결 상태와 서비스 주소를 확인해 주세요.'); }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const bytes = await readBoundedResponse(response);
      if (contentType === 'image/png' && route.endsWith('/sprite') && method === 'GET' && response.ok) {
        return { status: response.status, contentType, encoding: 'base64', body: bytes.toString('base64') };
      }
      if (contentType !== 'application/json') throw new Error('서버 응답 형식이 올바르지 않아요.');
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('서버 응답을 읽지 못했어요.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('서버 응답 형식이 올바르지 않아요.');
      return { status: response.status, contentType, body };
    },
  };
}

module.exports = { normalizeApiBaseUrl, readRuntimeConfig, validateRequest, createSessionVault, createServiceBridge };
