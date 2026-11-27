const MAX_JSON_BYTES = 30 * 1024 * 1024;
const REQUEST_TIMEOUT = 20_000;
const AUTH_PATHS = new Set(['/v1/auth/register', '/v1/auth/login']);
const USERNAME = /^[a-z][a-z0-9_]{3,31}$/;

export class ServiceError extends Error {
  constructor(message, { status = 0, code = 'SERVICE_ERROR', data = null } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function normalizeServiceOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return '';
    return url.origin;
  } catch { return ''; }
}

function safeUser(value) {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200
    || !['user', 'admin'].includes(value.role) || typeof value.username !== 'string' || !USERNAME.test(value.username)
    || typeof value.name !== 'string' || [...value.name].length > 40) {
    throw new ServiceError('계정 응답을 확인하지 못했어요. 다시 로그인해 주세요.', { code: 'INVALID_RESPONSE' });
  }
  return { id: value.id, username: value.username, email: '', name: value.name, role: value.role };
}

function abortError() {
  return new ServiceError('로그인을 취소했어요.', { code: 'CANCELLED' });
}

function password(value) {
  if (typeof value !== 'string' || [...value].length < 12 || new TextEncoder().encode(value).byteLength > 72 || value.includes('\0')) {
    throw new ServiceError('비밀번호는 12자 이상, UTF-8 기준 72바이트 이하로 입력해 주세요.', { code: 'INVALID_PASSWORD' });
  }
  return value;
}

function credentials(input, registration) {
  if (!input || typeof input.username !== 'string' || !USERNAME.test(input.username)) {
    throw new ServiceError('아이디는 영문 소문자로 시작하는 4~32자의 영문 소문자·숫자·밑줄로 입력해 주세요.', { code: 'INVALID_USERNAME' });
  }
  const result = { username: input.username, password: password(input.password) };
  if (registration && input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 40) {
      throw new ServiceError('이름은 1~40자로 입력해 주세요.', { code: 'INVALID_NAME' });
    }
    result.name = input.name.trim();
  }
  return result;
}

/**
 * Account API. Browser credentials live only in this closure; Electron keeps
 * its session in the main process. No credential is written to web storage.
 * Injectable dependencies are used by tests, never an alternative login path.
 */
export function createAccountClient({
  config = {}, desktop, onChange = () => {}, fetchImpl = globalThis.fetch?.bind(globalThis),
  cryptoImpl = globalThis.crypto, now = Date.now,
} = {}) {
  const origin = normalizeServiceOrigin(config.apiBaseUrl);
  const native = typeof desktop?.serviceRequest === 'function';
  const listeners = new Set([onChange]);
  let user = null;
  let status = origin ? 'guest' : 'unconfigured';
  let revision = null;
  let lastError = '';
  let browserToken = null;
  let epoch = 0;
  let disposed = false;
  let loginTask = null;
  let loginController = null;
  let gameQueue = Promise.resolve();
  let syncTask = null;
  let credentialQueue = Promise.resolve();

  function snapshot() {
    return { status, user: user ? { ...user } : null, configured: Boolean(origin), revision, error: lastError };
  }
  function emit() {
    if (disposed) return;
    const value = snapshot();
    for (const listener of listeners) {
      try { listener(value); } catch { /* A view must not interrupt session cleanup. */ }
    }
  }
  function ensureCurrent(expected) {
    if (disposed || expected !== epoch) throw new ServiceError('계정 상태가 변경되었어요.', { code: 'SESSION_CHANGED' });
  }
  function ensureConfigured() {
    if (!origin) throw new ServiceError('온라인 연결이 아직 준비되지 않았어요. 이 기기에서 플레이해 주세요.', { code: 'NOT_CONFIGURED' });
    if (disposed) throw new ServiceError('계정 연결이 종료되었어요.', { code: 'DISPOSED' });
  }
  function writeCredential(token, expected) {
    const task = credentialQueue.catch(() => {}).then(async () => {
      ensureCurrent(expected);
      if (native) await desktop.setAccountSession(token);
      else browserToken = token;
      ensureCurrent(expected);
    });
    credentialQueue = task;
    return task;
  }
  async function clearSession(expected, message = '') {
    ensureCurrent(expected);
    const current = ++epoch;
    browserToken = null;
    user = null; revision = null;
    status = origin ? 'guest' : 'unconfigured'; lastError = message;
    emit();
    await writeCredential(null, current);
    return current;
  }

  async function transport(method, path, body, { expected = epoch, signal } = {}) {
    ensureConfigured(); ensureCurrent(expected);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !/^\/v1\/[A-Za-z0-9/_-]+$/.test(path)) {
      throw new ServiceError('지원하지 않는 계정 요청이에요.', { code: 'INVALID_REQUEST' });
    }
    const authenticated = !AUTH_PATHS.has(path);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
      throw new ServiceError('전송할 정보가 너무 커요.', { code: 'BODY_TOO_LARGE' });
    }
    let response;
    const aborter = new AbortController();
    const forwardAbort = () => aborter.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => aborter.abort(), REQUEST_TIMEOUT);
    try {
      if (native) {
        response = await desktop.serviceRequest({ method, path, ...(body !== undefined ? { body } : {}) });
      } else {
        const headers = { Accept: 'application/json, image/png' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (authenticated && browserToken) headers.Authorization = `Bearer ${browserToken}`;
        const result = await fetchImpl(origin + path, { method, headers, body: serialized,
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: aborter.signal });
        const contentType = result.headers.get('content-type') || '';
        let payload;
        if (contentType.split(';')[0] === 'image/png' && result.ok) payload = await result.blob();
        else {
          try { payload = await result.json(); }
          catch { throw new ServiceError('서버 응답을 읽지 못했어요.', { status: result.status, code: 'INVALID_RESPONSE' }); }
        }
        response = { status: result.status, body: payload, contentType };
      }
      ensureCurrent(expected);
      if (signal?.aborted) throw abortError();
    } catch (cause) {
      ensureCurrent(expected);
      if (signal?.aborted) throw abortError();
      const error = cause instanceof ServiceError ? cause
        : new ServiceError('서버에 연결하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.', { code: 'NETWORK_ERROR' });
      if (user && error.code === 'NETWORK_ERROR') status = 'offline';
      lastError = error.message; emit();
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort);
    }
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) {
      throw new ServiceError('서버 응답 형식이 올바르지 않아요.', { code: 'INVALID_RESPONSE' });
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = response.body?.error;
      const message = typeof detail?.message === 'string' ? detail.message.slice(0, 500) : '요청을 처리하지 못했어요. 다시 시도해 주세요.';
      const error = new ServiceError(message, { status: response.status,
        code: typeof detail?.code === 'string' ? detail.code : 'SERVICE_ERROR', data: response.body });
      if (response.status === 401 && authenticated) await clearSession(expected, '로그인이 만료되었어요. 다시 로그인해 주세요.');
      else { if (response.status >= 500 && user) status = 'offline'; lastError = message; emit(); }
      throw error;
    }
    if (user && status === 'offline') { status = 'authenticated'; lastError = ''; emit(); }
    if (response.encoding === 'base64') {
      if (response.contentType?.split(';')[0] !== 'image/png' || typeof response.body !== 'string') {
        throw new ServiceError('캐릭터 이미지를 읽지 못했어요.', { code: 'INVALID_RESPONSE' });
      }
      try {
        const bytes = Uint8Array.from(atob(response.body), value => value.charCodeAt(0));
        return new Blob([bytes], { type: 'image/png' });
      } catch { throw new ServiceError('캐릭터 이미지를 읽지 못했어요.', { code: 'INVALID_RESPONSE' }); }
    }
    return response.body;
  }

  async function initialize() {
    if (!origin) { emit(); return null; }
    const expected = ++epoch;
    status = 'checking'; lastError = ''; emit();
    try {
      const hasSession = native ? await desktop.getAccountSession() : Boolean(browserToken);
      ensureCurrent(expected);
      if (!hasSession) { user = null; revision = null; status = 'guest'; emit(); return null; }
      const result = await transport('GET', '/v1/me', undefined, { expected });
      ensureCurrent(expected);
      user = safeUser(result?.user); status = 'authenticated'; lastError = ''; emit();
      return { ...user };
    } catch (error) {
      if (expected === epoch) {
        if (error.code === 'NETWORK_ERROR' || error.status >= 500 || error.status === 429) {
          status = 'offline'; lastError = error.message; emit();
        }
        else await clearSession(expected, error.message);
      }
      if (error.status === 401 || error.code === 'SESSION_CHANGED') return null;
      throw error;
    }
  }

  function checkedSession(result) {
    const profile = safeUser(result?.user);
    if (typeof result?.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(result.token)
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) {
      throw new ServiceError('로그인 세션을 확인하지 못했어요.', { code: 'INVALID_RESPONSE' });
    }
    return profile;
  }

  async function performLogin(expected, controller, path, body) {
    try {
      const result = await transport('POST', path, body, { expected, signal: controller.signal });
      const profile = checkedSession(result);
      await writeCredential(result.token, expected);
      ensureCurrent(expected);
      user = profile; revision = null;
      status = 'authenticated'; lastError = ''; emit();
      return { ...user };
    } catch (error) {
      if (expected === epoch) await clearSession(expected, error.message || '로그인하지 못했어요.');
      throw error;
    } finally {
      body.password = '';
      if (loginController === controller) loginController = null;
    }
  }

  function authenticate(input, registration = false) {
    ensureConfigured();
    if (user) return Promise.resolve({ ...user });
    if (loginTask) return loginTask;
    const body = credentials(input, registration);
    const expected = ++epoch;
    const controller = new AbortController();
    loginController = controller;
    status = 'authenticating'; lastError = ''; emit();
    const task = performLogin(expected, controller, registration ? '/v1/auth/register' : '/v1/auth/login', body);
    const wrapped = task.finally(() => { if (loginTask === wrapped) loginTask = null; });
    loginTask = wrapped;
    return wrapped;
  }
  const login = input => authenticate(input);
  const register = input => authenticate(input, true);

  async function cancelLogin() {
    if (!loginController) return;
    const expected = epoch;
    loginController.abort();
    await clearSession(expected, '로그인을 취소했어요.');
  }

  async function logout() {
    if (loginController) await cancelLogin();
    const expected = ++epoch;
    let revoked = true;
    try { if (origin && user) await transport('POST', '/v1/logout', {}, { expected }); }
    catch { revoked = false; }
    if (expected === epoch) await clearSession(expected, revoked ? '' : '이 기기에서 로그아웃했어요. 연결 오류로 서버 세션은 만료될 때까지 남을 수 있어요.');
    return { revoked };
  }

  async function deleteAccount(input) {
    const body = { password: password(input?.password) };
    const expected = epoch;
    try {
      await transport('DELETE', '/v1/account', body, { expected });
      await clearSession(expected);
      return { ok: true };
    } finally { body.password = ''; }
  }

  function changePassword(input) {
    const body = { currentPassword: password(input?.currentPassword), newPassword: password(input?.newPassword) };
    // Complete an in-flight game request before rotating its authentication.
    return queueGame(async expected => {
      try {
        if (!user) throw new ServiceError('먼저 로그인해 주세요.', { code: 'AUTH_REQUIRED' });
        const result = await transport('POST', '/v1/account/password', body, { expected });
        const profile = checkedSession(result);
        if (profile.id !== user.id) throw new ServiceError('계정 응답을 확인하지 못했어요.', { code: 'INVALID_RESPONSE' });
        // Old in-flight requests cannot invalidate the newly rotated session.
        const renewed = ++epoch;
        try { await writeCredential(result.token, renewed); }
        catch (error) { if (renewed === epoch) await clearSession(renewed, '다시 로그인해 주세요.'); throw error; }
        ensureCurrent(renewed);
        user = profile; status = 'authenticated'; lastError = ''; emit();
        return { ...user };
      } finally { body.currentPassword = ''; body.newPassword = ''; }
    });
  }

  function presenceBody(presence) {
    const value = typeof presence === 'function' ? presence() : presence || {};
    const invalid = () => { throw new ServiceError('화면과 동료 위치 정보를 확인해 주세요.', { code: 'INVALID_PRESENCE' }); };
    const number = (input, low = 0, high = 65536) => {
      if (typeof input !== 'number' || !Number.isFinite(input) || input < low || input > high) invalid();
      return input;
    };
    const id = input => {
      if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input)) invalid();
      return input;
    };
    const body = { ...(value.width === undefined ? {} : { width: number(value.width, 320) }),
      ...(value.x === undefined ? {} : { x: number(value.x) }),
      ...(typeof value.elevated === 'boolean' ? { elevated: value.elevated } : {}),
      ...(typeof value.paused === 'boolean' ? { paused: value.paused } : {}) };
    if (value.displays !== undefined) {
      if (!Array.isArray(value.displays) || !value.displays.length || value.displays.length > 32) invalid();
      body.displays = value.displays.map(display => {
        if (!display || typeof display !== 'object') invalid();
        return { id: id(display.id), x: number(display.x), y: number(display.y), width: number(display.width, 1),
          height: number(display.height, 1), floorY: number(display.floorY) };
      });
    }
    if (value.characters !== undefined) {
      if (!Array.isArray(value.characters) || value.characters.length > 6) invalid();
      body.characters = value.characters.map(character => {
        if (!character || typeof character !== 'object') invalid();
        return { characterId: id(character.characterId),
          ...(character.x === undefined ? {} : { x: number(character.x) }),
          ...(character.displayId === undefined ? {} : { displayId: id(character.displayId) }),
          ...(typeof character.elevated === 'boolean' ? { elevated: character.elevated } : {}),
          ...(typeof character.paused === 'boolean' ? { paused: character.paused } : {}) };
      });
    }
    return body;
  }
  function acceptGame(result) {
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || !result.game || typeof result.game !== 'object') {
      throw new ServiceError('온라인 저장 정보를 확인하지 못했어요.', { code: 'INVALID_RESPONSE' });
    }
    revision = result.revision; emit();
    return result;
  }
  function queueGame(operation) {
    const expected = epoch;
    const next = gameQueue.catch(() => {}).then(async () => { ensureCurrent(expected); return operation(expected); });
    gameQueue = next;
    return next;
  }
  const request = (method, path, body) => transport(method, path, body);
  function syncGame(presence) {
    // Polling may outlive its interval on a slow connection. One pending sync
    // avoids filling the command queue with obsolete presence updates.
    if (syncTask?.epoch === epoch) return syncTask.promise;
    const expected = epoch;
    const task = queueGame(async current => {
      try { return acceptGame(await transport('POST', '/v1/game/sync', presenceBody(presence), { expected: current })); }
      catch (error) {
        // Another signed-in device may have recalled a companion included in
        // this presence snapshot. Let the UI adopt the canonical roster and
        // retry its remaining placements without reviving the recalled actor.
        if (error.status === 409 && error.data?.game && Number.isSafeInteger(error.data.revision) && error.data.revision >= 0) {
          revision = error.data.revision; emit();
        }
        throw error;
      }
    });
    const promise = task.finally(() => { if (syncTask?.promise === promise) syncTask = null; });
    syncTask = { epoch: expected, promise };
    return promise;
  }
  function gameAction(type, payload = {}, presence = {}) {
    return queueGame(async expected => {
      if (revision === null) acceptGame(await transport('POST', '/v1/game/sync', presenceBody(presence), { expected }));
      try {
        return acceptGame(await transport('POST', '/v1/game/action', { type, payload, revision,
          requestId: cryptoImpl.randomUUID(), ...presenceBody(presence) }, { expected }));
      } catch (error) {
        if (error.status === 409 && error.data?.game && Number.isSafeInteger(error.data.revision)) {
          revision = error.data.revision; emit();
        }
        throw error;
      }
    });
  }
  async function fetchSprite(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new ServiceError('캐릭터 식별자가 올바르지 않아요.', { code: 'INVALID_REQUEST' });
    const blob = await request('GET', `/v1/characters/${id}/sprite`);
    if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size > 20 * 1024 * 1024) {
      throw new ServiceError('캐릭터 이미지를 확인하지 못했어요.', { code: 'INVALID_RESPONSE' });
    }
    return blob;
  }

  return {
    get user() { return user ? { ...user } : null; }, get status() { return status; },
    get revision() { return revision; }, get configured() { return Boolean(origin); },
    getSession: snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize, login, register, cancelLogin, logout, deleteAccount, changePassword, request, syncGame, gameAction, fetchSprite,
    dispose() {
      disposed = true; epoch += 1; loginController?.abort(); browserToken = null;
      listeners.clear();
    },
  };
}
