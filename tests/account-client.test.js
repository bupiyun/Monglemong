import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAccountClient, normalizeServiceOrigin, ServiceError } from '../src/account-client.js';

const config = { flavor: 'user', apiBaseUrl: 'https://game.example' };
const profile = { id: 'player-a', username: 'player_a', email: '', name: '모험가', role: 'user' };
const credentials = { username: 'player_a', password: 'fixture-password-123' };
const sessionToken = () => randomBytes(32).toString('base64url');
const session = (token = sessionToken(), user = profile) => ({ token, user, expiresAt: Date.now() + 60_000 });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function browserHarness(extra = {}) {
  const calls = [];
  const token = sessionToken();
  let custom;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body, options });
    if (custom) {
      const result = await custom(path, body, options);
      if (result !== undefined) return result;
    }
    if (path === '/v1/auth/login' || path === '/v1/auth/register') return json(session(token));
    if (path === '/v1/me') return json({ user: profile });
    if (path === '/v1/logout' || path === '/v1/account') return json({ ok: true });
    return json({ error: { code: 'NOT_FOUND', message: '찾을 수 없어요.' } }, 404);
  };
  const client = createAccountClient({ config, fetchImpl, ...extra });
  return { client, calls, token, respond(handler) { custom = handler; } };
}

test('service origins allow HTTPS and loopback development, never credentials or alternate paths', () => {
  assert.equal(normalizeServiceOrigin('https://game.example/'), 'https://game.example');
  assert.equal(normalizeServiceOrigin('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
  assert.equal(normalizeServiceOrigin('http://[::1]:3001'), 'http://[::1]:3001');
  for (const value of ['', 'https://a:b@game.example', 'http://game.example', 'https://game.example/api', 'https://game.example?token=x', 'https://game.example#x', 'javascript:alert(1)']) {
    assert.equal(normalizeServiceOrigin(value), '');
  }
});

test('an unconfigured build remains guest-only without performing a fake login', async () => {
  let calls = 0;
  const client = createAccountClient({ config: {}, fetchImpl: () => { calls++; } });
  assert.equal(client.status, 'unconfigured');
  assert.equal(await client.initialize(), null);
  assert.throws(() => client.login(credentials), error => error.code === 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('credential login sends one direct request and keeps credentials out of snapshots and web storage', async () => {
  const changes = [];
  const run = browserHarness({ onChange: snapshot => changes.push(snapshot) });
  assert.deepEqual(await run.client.login(credentials), profile);
  assert.equal(run.client.status, 'authenticated');
  assert.deepEqual(run.calls[0].body, credentials);
  assert.equal(run.calls[0].path, '/v1/auth/login');
  assert.equal(run.calls[0].options.headers.Authorization, undefined);
  assert.equal(run.calls[0].options.credentials, 'omit');
  assert.equal(run.calls[0].options.redirect, 'error');
  await run.client.request('GET', '/v1/me');
  assert.equal(run.calls[1].options.headers.Authorization, `Bearer ${run.token}`);
  for (const secret of [credentials.password, run.token]) {
    assert.ok(!JSON.stringify(changes).includes(secret));
    assert.ok(!JSON.stringify(run.client.getSession()).includes(secret));
  }
  const copy = run.client.user; copy.role = 'admin';
  assert.equal(run.client.user.role, 'user');
  const next = browserHarness();
  assert.equal(await next.client.initialize(), null);
  assert.equal(next.calls.length, 0);
});

test('registration forwards only validated account fields and accepts the server-created session', async () => {
  const run = browserHarness();
  await run.client.register({ ...credentials, name: ' 모험가 ', role: 'admin', token: 'forged', email: 'forged@example.test' });
  assert.equal(run.calls[0].path, '/v1/auth/register');
  assert.deepEqual(run.calls[0].body, { ...credentials, name: '모험가' });
  assert.deepEqual(run.client.user, profile);
});

test('credential validation bounds Unicode password bytes and rejects invalid fields before network access', async () => {
  const run = browserHarness();
  for (const username of ['abc', 'UPPER', '1player', 'with space', 'a'.repeat(33), null]) {
    assert.throws(() => run.client.login({ ...credentials, username }), error => error.code === 'INVALID_USERNAME');
  }
  for (const password of ['short', 'a'.repeat(73), '한'.repeat(25), 'a'.repeat(11) + '\0']) {
    assert.throws(() => run.client.login({ ...credentials, password }), error => error.code === 'INVALID_PASSWORD');
  }
  for (const name of ['', ' ', '한'.repeat(41)]) {
    assert.throws(() => run.client.register({ ...credentials, name }), error => error.code === 'INVALID_NAME');
  }
  assert.equal(run.calls.length, 0);
  await run.client.register({ ...credentials, password: '😀'.repeat(12) });
  assert.equal(run.calls[0].body.password, '😀'.repeat(12), '12 Unicode code points within 72 UTF-8 bytes are valid');
});

test('failed login returns to guest state and an invalid session response is never persisted', async () => {
  const run = browserHarness();
  run.respond(() => json({ error: { code: 'invalid_credentials', message: '아이디 또는 비밀번호를 확인해 주세요.' } }, 401));
  await assert.rejects(run.client.login(credentials), error => error.code === 'invalid_credentials');
  assert.equal(run.client.status, 'guest');
  for (const invalid of [session('bad'), { ...session(), expiresAt: 1 }, { ...session(), user: { ...profile, username: undefined } }, { ...session(), user: { ...profile, role: 'forged' } }]) {
    const writes = [];
    const client = createAccountClient({ config, desktop: {
      serviceRequest: async () => ({ status: 200, body: invalid }), setAccountSession: async token => writes.push(token),
    } });
    await assert.rejects(client.login(credentials), error => error.code === 'INVALID_RESPONSE');
    assert.deepEqual(writes, [null]);
    assert.equal(client.user, null);
  }
});

test('Electron restores a main-process session without returning its credential', async () => {
  const calls = [];
  const desktop = {
    getAccountSession: async () => true,
    setAccountSession: async value => { calls.push(['set', value]); },
    serviceRequest: async value => { calls.push(['request', value]); return { status: 200, body: { user: profile } }; },
  };
  const client = createAccountClient({ config, desktop });
  assert.deepEqual(await client.initialize(), profile);
  assert.deepEqual(calls, [['request', { method: 'GET', path: '/v1/me' }]]);
  assert.equal(client.getSession().token, undefined);
});

test('Electron login forwards credentials once and hands only the returned token to protected main storage', async () => {
  const token = sessionToken(), writes = [], calls = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    setAccountSession: async value => { writes.push(value); return { persistent: true }; },
    serviceRequest: async value => { calls.push(structuredClone(value)); return { status: 200, body: session(token) }; },
  } });
  await client.login(credentials);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/auth/login', body: credentials }]);
  assert.deepEqual(writes, [token]);
  assert.ok(!JSON.stringify(client.getSession()).includes(token));
});

test('invalid restored account metadata cannot retain an authenticated credential', async () => {
  const writes = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => true,
    setAccountSession: async token => { writes.push(token); },
    serviceRequest: async () => ({ status: 200, body: { user: { ...profile, role: 'forged' } } }),
  } });
  await assert.rejects(client.initialize(), error => error.code === 'INVALID_RESPONSE');
  assert.deepEqual(writes, [null]);
  assert.equal(client.user, null);
  assert.equal(client.status, 'guest');
});

test('temporary server failures preserve a stored session for a later restore', async () => {
  for (const status of [429, 503]) {
    const writes = [];
    let available = false;
    const client = createAccountClient({ config, desktop: {
      getAccountSession: async () => true,
      setAccountSession: async token => { writes.push(token); },
      serviceRequest: async () => available
        ? { status: 200, body: { user: profile } }
        : { status, body: { error: { code: 'TEMPORARY_FAILURE', message: '잠시 후 다시 시도해 주세요.' } } },
    } });
    await assert.rejects(client.initialize(), error => error.status === status);
    assert.equal(client.status, 'offline');
    assert.deepEqual(writes, []);
    available = true;
    assert.deepEqual(await client.initialize(), profile);
    assert.equal(client.status, 'authenticated');
  }
});

test('cancelling an in-flight credential login cannot resurrect a completed session', async () => {
  const pending = deferred(), started = deferred(), writes = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    setAccountSession: async token => writes.push(token),
    serviceRequest: async () => { started.resolve(); return pending.promise; },
  } });
  const login = client.login(credentials);
  assert.equal(client.login(credentials), login, 'double submissions share one request');
  const rejected = assert.rejects(login, error => ['CANCELLED', 'SESSION_CHANGED'].includes(error.code));
  await started.promise;
  await client.cancelLogin();
  pending.resolve({ status: 200, body: session() });
  await rejected;
  assert.equal(client.status, 'guest');
  assert.equal(client.user, null);
  assert.deepEqual(writes, [null]);
});

test('a cancelled pending credential write is cleared after it finishes', async () => {
  const pending = deferred(), started = deferred(), writes = [], token = sessionToken();
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    setAccountSession: async value => { writes.push(value); if (value) { started.resolve(); await pending.promise; } },
    serviceRequest: async () => ({ status: 200, body: session(token) }),
  } });
  const rejected = assert.rejects(client.login(credentials), error => error.code === 'SESSION_CHANGED');
  await started.promise;
  const cancelled = client.cancelLogin(); pending.resolve();
  await cancelled; await rejected;
  assert.deepEqual(writes, [token, null]);
  assert.equal(client.user, null);
});

test('password rotation waits for a game request, keeps its revision, and uses the new token thereafter', async () => {
  const run = browserHarness(); await run.client.login(credentials);
  const pending = deferred(), started = deferred(), rotated = sessionToken();
  let syncs = 0;
  run.respond(async (path, body, options) => {
    if (path.endsWith('/sync')) {
      syncs++;
      if (syncs === 1) { started.resolve(); await pending.promise; }
      else assert.equal(options.headers.Authorization, `Bearer ${rotated}`);
      return json({ revision: 7 + syncs, game: { gold: 120 } });
    }
    if (path.endsWith('/password')) {
      assert.equal(options.headers.Authorization, `Bearer ${run.token}`);
      assert.deepEqual(body, { currentPassword: credentials.password, newPassword: 'replacement-password-123' });
      return json(session(rotated));
    }
  });
  const syncing = run.client.syncGame(); await started.promise;
  const changing = run.client.changePassword({ currentPassword: credentials.password, newPassword: 'replacement-password-123' });
  assert.equal(run.calls.some(call => call.path.endsWith('/password')), false);
  pending.resolve(); await syncing; await changing;
  assert.equal(run.client.revision, 8); assert.deepEqual(run.client.user, profile);
  await run.client.syncGame(); assert.equal(run.client.revision, 9);
});

test('wrong current password keeps the account active and is required for password change and deletion', async () => {
  const run = browserHarness(); await run.client.login(credentials);
  run.respond(() => json({ error: { code: 'invalid_password', message: '현재 비밀번호를 확인해 주세요.' } }, 403));
  await assert.rejects(run.client.changePassword({ currentPassword: credentials.password, newPassword: 'replacement-password-123' }), error => error.code === 'invalid_password');
  await assert.rejects(run.client.deleteAccount({ password: credentials.password }), error => error.code === 'invalid_password');
  assert.deepEqual(run.client.user, profile);
  assert.throws(() => run.client.changePassword({ newPassword: credentials.password }), error => error.code === 'INVALID_PASSWORD');
  await assert.rejects(run.client.deleteAccount({}), error => error.code === 'INVALID_PASSWORD');
});

test('an old in-flight request cannot clear a newly rotated credential', async () => {
  const run = browserHarness(); await run.client.login(credentials);
  const pending = deferred(), started = deferred();
  run.respond(async path => {
    if (path === '/v1/me') { started.resolve(); return pending.promise; }
    if (path.endsWith('/password')) return json(session());
    return json({ revision: 1, game: {} });
  });
  const old = run.client.request('GET', '/v1/me');
  const rejected = assert.rejects(old, error => error.code === 'SESSION_CHANGED');
  await started.promise;
  await run.client.changePassword({ currentPassword: credentials.password, newPassword: 'replacement-password-123' });
  pending.resolve(json({ error: { code: 'unauthorized', message: '만료된 세션' } }, 401));
  await rejected;
  assert.deepEqual(run.client.user, profile); assert.equal(run.client.status, 'authenticated');
});

test('game sync and actions serialize revisions, and caller fields cannot replace server protocol fields', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  let remoteRevision = 3;
  const actions = [];
  run.respond(async (path, body) => {
    if (path.endsWith('/action')) { actions.push(body); assert.equal(body.revision, remoteRevision); }
    await new Promise(resolve => setTimeout(resolve, 2));
    remoteRevision++;
    return json({ revision: remoteRevision, game: { gold: 120 }, newCharacters: [] });
  });
  await Promise.all([
    run.client.syncGame({ width: 1280 }),
    run.client.gameAction('pet', {}, { x: 300, revision: 999, role: 'admin', requestId: 'forged' }),
    run.client.gameAction('feed', { foodId: 'snack' }, () => ({ width: 800, paused: true })),
  ]);
  assert.equal(run.client.revision, 6);
  assert.equal(actions[0].revision, 4);
  assert.equal(actions[0].role, undefined);
  assert.notEqual(actions[0].requestId, actions[1].requestId);
  assert.match(actions[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(actions[1].width, 800);
});

test('multi-display presence copies only bounded controls and never forwards character progress', async () => {
  const run = browserHarness(); await run.client.login(credentials);
  run.respond(() => json({ revision: 1, game: { gold: 120 }, newCharacters: [] }));
  const displays = [
    { id: 'primary', x: 1920, y: 0, width: 1920, height: 1040, floorY: 1040, scaleFactor: 2 },
    { id: 'left', x: 0, y: 0, width: 1920, height: 1040, floorY: 1040 },
  ];
  await run.client.syncGame({ width: 3840, displays, paused: false, stats: { kills: 900 }, characters: [
    { characterId: 'cafemong', x: 500, displayId: 'left', elevated: true, paused: false, hp: 9999 },
    { characterId: 'custom_friend', displayId: 'primary', elevated: false, paused: true, level: 50 },
  ] });
  const body = run.calls.at(-1).body;
  assert.equal(body.width, 3840); assert.equal(body.stats, undefined);
  assert.equal(body.displays[0].scaleFactor, undefined);
  assert.deepEqual(body.characters, [
    { characterId: 'cafemong', x: 500, displayId: 'left', elevated: true, paused: false },
    { characterId: 'custom_friend', displayId: 'primary', elevated: false, paused: true },
  ]);
  const requestCount = run.calls.length;
  for (const invalid of [
    { width: 65537 }, { displays: Array(33).fill(displays[0]) }, { displays: [] },
    { characters: Array(7).fill({ characterId: 'cafemong' }) }, { characters: [{ characterId: 'cafemong', x: Infinity }] },
    { characters: [{ characterId: 'cafemong', displayId: 'x'.repeat(81) }] },
  ]) await assert.rejects(run.client.syncGame(invalid), error => error.code === 'INVALID_PRESENCE');
  assert.equal(run.calls.length, requestCount, 'invalid presence never reaches either transport');
});

test('a presence conflict exposes the canonical roster and updates the revision for the next corrected request', async () => {
  const run = browserHarness(); await run.client.login(credentials);
  let conflict = true;
  run.respond((path, body) => {
    if (conflict) return json({ error: { code: 'presence_conflict', message: '다른 기기에서 동료를 보관했어요.' },
      revision: 3, game: { deployedCharacterIds: ['cafemong'] }, newCharacters: [] }, 409);
    if (path.endsWith('/action')) assert.equal(body.revision, 4);
    else assert.deepEqual(body.characters.map(character => character.characterId), ['cafemong']);
    return json({ revision: path.endsWith('/action') ? 5 : 4, game: { deployedCharacterIds: ['cafemong'] }, newCharacters: [] });
  });
  await assert.rejects(run.client.syncGame({ characters: [{ characterId: 'cafemong' }, { characterId: 'custom_recalled' }] }), error => {
    assert.equal(error.code, 'presence_conflict');
    assert.deepEqual(error.data.game.deployedCharacterIds, ['cafemong']);
    return true;
  });
  assert.equal(run.client.revision, 3);
  conflict = false;
  await run.client.syncGame({ characters: [{ characterId: 'cafemong' }] });
  await run.client.gameAction('pet', { characterId: 'cafemong' });
  assert.equal(run.client.revision, 5);
});

test('an action without a revision synchronizes first; conflicts surface canonical state without retrying a spend', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  let attempts = 0;
  run.respond((path, body) => {
    if (path.endsWith('/sync')) return json({ game: { gold: 120 }, revision: 1 });
    attempts++;
    assert.equal(body.revision, 1);
    return json({ error: { code: 'REVISION_CONFLICT', message: '다른 기기에서 변경했어요.' }, game: { gold: 110 }, revision: 2 }, 409);
  });
  await assert.rejects(run.client.gameAction('buyCore', { coreId: 'grove' }), error => error instanceof ServiceError
    && error.status === 409 && error.data.game.gold === 110);
  assert.equal(run.client.revision, 2);
  assert.equal(attempts, 1);
});

test('overlapping slow periodic syncs share one request instead of delaying subsequent commands', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  const pending = deferred();
  let requests = 0;
  run.respond(async () => { requests++; await pending.promise; return json({ game: { gold: 120 }, revision: 8 }); });
  const first = run.client.syncGame();
  const second = run.client.syncGame();
  assert.equal(first, second);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(run.client.revision, 8);
});

test('expired credentials clear the session and queued old-account operations cannot run', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  run.respond(() => json({ error: { code: 'UNAUTHORIZED', message: '로그인이 필요해요.' } }, 401));
  const results = await Promise.allSettled([run.client.syncGame(), run.client.gameAction('pet')]);
  assert.equal(results[0].reason.status, 401);
  assert.equal(results[1].reason.code, 'SESSION_CHANGED');
  assert.equal(run.client.user, null);
  assert.equal(run.client.status, 'guest');
});

test('network failure pauses account connectivity without silently switching its data to a guest', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  run.respond(() => { throw new Error('socket closed'); });
  await assert.rejects(run.client.syncGame(), error => error.code === 'NETWORK_ERROR');
  assert.equal(run.client.status, 'offline');
  assert.equal(run.client.user.id, profile.id);
  run.respond(() => json({ game: { gold: 120 }, revision: 4 }));
  await run.client.syncGame();
  assert.equal(run.client.status, 'authenticated');
});

test('logout clears local authentication even when revocation cannot reach the server', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  run.respond(() => { throw new Error('offline'); });
  assert.deepEqual(await run.client.logout(), { revoked: false });
  assert.equal(run.client.user, null);
  assert.equal(run.client.status, 'guest');
  await run.client.initialize();
  assert.equal(run.client.status, 'guest');
});

test('account deletion keeps an authenticated session on failure and clears it only after success', async () => {
  const run = browserHarness();
  await run.client.login(credentials);
  run.respond(() => json({ error: { code: 'TEMPORARY_FAILURE', message: '잠시 후 다시 시도해 주세요.' } }, 503));
  await assert.rejects(run.client.deleteAccount({ password: credentials.password }), error => error.status === 503);
  assert.equal(run.client.user.id, profile.id);
  run.respond(() => json({ ok: true }));
  await run.client.deleteAccount({ password: credentials.password });
  assert.equal(run.client.user, null);
  const request = run.calls.findLast(call => call.path === '/v1/account');
  assert.deepEqual(request.body, { password: credentials.password });
  assert.equal(request.options.headers['Content-Type'], 'application/json');
});

test('only restricted service paths are accepted and acquired sprite bytes become a Blob', async () => {
  const calls = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false, setAccountSession: async () => {},
    serviceRequest: async request => { calls.push(request); return { status: 200, encoding: 'base64', contentType: 'image/png', body: btoa('test-png-bytes') }; },
  } });
  for (const path of ['https://attacker.example', '/v1/../secrets', '//attacker.example', '/v1/me?redirect=bad', '/v1/%2e%2e/file']) {
    await assert.rejects(client.request('GET', path), error => error.code === 'INVALID_REQUEST');
  }
  const blob = await client.fetchSprite('custom_123');
  assert.equal(blob.type, 'image/png');
  assert.equal(await blob.text(), 'test-png-bytes');
  assert.equal(calls.length, 1);
});
