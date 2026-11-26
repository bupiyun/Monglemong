import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createAccountClient, normalizeServiceOrigin, ServiceError } from '../src/account-client.js';

const config = { flavor: 'user', apiBaseUrl: 'https://game.example' };
const profile = { id: 'player-a', email: 'player@example.test', name: '모험가', role: 'user' };
const sessionToken = () => randomBytes(32).toString('base64url');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function browserHarness(extra = {}) {
  const calls = [];
  const opened = [];
  const token = sessionToken();
  let challenge;
  let custom;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, body, options });
    if (path === '/v1/auth/start') {
      challenge = body.challenge;
      return json({ flowId: 'flow-a', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=public-id', expiresIn: 300 });
    }
    if (path === '/v1/auth/poll') {
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge, 'the poll secret proves the originating app challenge');
      return json({ status: 'complete', token, user: profile });
    }
    if (custom) return custom(path, body, options);
    if (path === '/v1/me') return json({ user: profile });
    if (path === '/v1/logout' || path === '/v1/account') return json({ ok: true });
    return json({ error: { code: 'NOT_FOUND', message: '찾을 수 없어요.' } }, 404);
  };
  const client = createAccountClient({ config, fetchImpl, openLogin: async url => { opened.push(url); }, ...extra });
  return { client, calls, opened, token, respond(handler) { custom = handler; } };
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
  assert.throws(() => client.login(), error => error.code === 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('browser login uses a PKCE-bound poll and keeps credentials out of snapshots and web storage', async () => {
  const changes = [];
  const run = browserHarness({ onChange: snapshot => changes.push(snapshot) });
  assert.deepEqual(await run.client.login(), profile);
  assert.equal(run.client.status, 'authenticated');
  assert.equal(run.opened.length, 1);
  const me = run.calls.find(call => call.path === '/v1/me');
  assert.equal(me.options.headers.Authorization, `Bearer ${run.token}`);
  assert.equal(me.options.credentials, 'omit');
  assert.equal(me.options.redirect, 'error');
  assert.equal(run.calls[0].options.headers.Authorization, undefined);
  assert.equal(run.calls[1].options.headers.Authorization, undefined);
  assert.ok(!JSON.stringify(changes).includes(run.token));
  assert.ok(!JSON.stringify(run.client.getSession()).includes(run.token));
  const copy = run.client.user; copy.role = 'admin';
  assert.equal(run.client.user.role, 'user');
  // A new browser client cannot recover the previous closure's credential.
  const next = browserHarness();
  assert.equal(await next.client.initialize(), null);
  assert.equal(next.calls.length, 0);
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

test('Electron completes login by handing the one-time token to protected main storage', async () => {
  const token = sessionToken();
  const writes = [];
  const opened = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    setAccountSession: async value => { writes.push(value); return { persistent: true }; },
    openAccountLogin: async url => opened.push(url),
    serviceRequest: async ({ path }) => ({ status: 200, body: path.endsWith('/start')
      ? { flowId: 'native-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresIn: 300 }
      : path.endsWith('/poll') ? { status: 'complete', token } : { user: profile } }),
  } });
  await client.login();
  assert.deepEqual(writes, [token]);
  assert.equal(opened.length, 1);
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

test('an unexpected authorization destination is rejected before opening a browser', async () => {
  let opened = false;
  const client = createAccountClient({ config, openLogin: () => { opened = true; },
    fetchImpl: async () => json({ flowId: 'flow', authorizationUrl: 'https://attacker.example/login', expiresIn: 300 }) });
  await assert.rejects(client.login(), error => error.code === 'INVALID_RESPONSE');
  assert.equal(opened, false);
  assert.equal(client.user, null);
  assert.equal(client.status, 'guest');
});

test('cancelling an in-flight login cannot resurrect a completed session', async () => {
  const pending = deferred();
  const started = deferred();
  const writes = [];
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    setAccountSession: async token => { writes.push(token); },
    openAccountLogin: async () => {},
    serviceRequest: async ({ path }) => {
      if (path.endsWith('/start')) return { status: 200, body: { flowId: 'flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresIn: 300 } };
      started.resolve();
      return pending.promise;
    },
  } });
  const login = client.login();
  const rejected = assert.rejects(login, error => ['CANCELLED', 'SESSION_CHANGED'].includes(error.code));
  await started.promise;
  await client.cancelLogin();
  pending.resolve({ status: 200, body: { status: 'complete', token: sessionToken(), user: profile } });
  await rejected;
  assert.equal(client.status, 'guest');
  assert.equal(client.user, null);
  assert.deepEqual(writes, [null]);
});

test('a cancelled pending credential write is cleared after it finishes', async () => {
  const pending = deferred();
  const started = deferred();
  const writes = [];
  const token = sessionToken();
  const client = createAccountClient({ config, desktop: {
    getAccountSession: async () => false,
    openAccountLogin: async () => {},
    setAccountSession: async value => {
      writes.push(value);
      if (value) { started.resolve(); await pending.promise; }
    },
    serviceRequest: async ({ path }) => ({ status: 200, body: path.endsWith('/start')
      ? { flowId: 'flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresIn: 300 }
      : path.endsWith('/poll') ? { status: 'complete', token } : { user: profile } }),
  } });
  const rejected = assert.rejects(client.login(), error => error.code === 'SESSION_CHANGED');
  await started.promise;
  const cancelled = client.cancelLogin();
  pending.resolve();
  await cancelled; await rejected;
  assert.deepEqual(writes, [token, null]);
  assert.equal(client.user, null);
});

test('login expiry is bounded even if a provider keeps reporting pending', async () => {
  let time = 0;
  let polls = 0;
  const client = createAccountClient({ config, now: () => time, pollIntervalMs: 100,
    sleep: async ms => { time += ms; }, openLogin: async () => {},
    fetchImpl: async url => new URL(url).pathname.endsWith('/start')
      ? json({ flowId: 'flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresIn: 1 })
      : (polls++, json({ status: 'pending' })),
  });
  await assert.rejects(client.login(), error => error.code === 'LOGIN_EXPIRED');
  assert.equal(polls, 10);
  assert.equal(client.status, 'guest');
});

test('game sync and actions serialize revisions, and caller fields cannot replace server protocol fields', async () => {
  const run = browserHarness();
  await run.client.login();
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

test('an action without a revision synchronizes first; conflicts surface canonical state without retrying a spend', async () => {
  const run = browserHarness();
  await run.client.login();
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
  await run.client.login();
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
  await run.client.login();
  run.respond(() => json({ error: { code: 'UNAUTHORIZED', message: '로그인이 필요해요.' } }, 401));
  const results = await Promise.allSettled([run.client.syncGame(), run.client.gameAction('pet')]);
  assert.equal(results[0].reason.status, 401);
  assert.equal(results[1].reason.code, 'SESSION_CHANGED');
  assert.equal(run.client.user, null);
  assert.equal(run.client.status, 'guest');
});

test('network failure pauses account connectivity without silently switching its data to a guest', async () => {
  const run = browserHarness();
  await run.client.login();
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
  await run.client.login();
  run.respond(() => { throw new Error('offline'); });
  assert.deepEqual(await run.client.logout(), { revoked: false });
  assert.equal(run.client.user, null);
  assert.equal(run.client.status, 'guest');
  await run.client.initialize();
  assert.equal(run.client.status, 'guest');
});

test('account deletion keeps an authenticated session on failure and clears it only after success', async () => {
  const run = browserHarness();
  await run.client.login();
  run.respond(() => json({ error: { code: 'TEMPORARY_FAILURE', message: '잠시 후 다시 시도해 주세요.' } }, 503));
  await assert.rejects(run.client.deleteAccount(), error => error.status === 503);
  assert.equal(run.client.user.id, profile.id);
  run.respond(() => json({ ok: true }));
  await run.client.deleteAccount();
  assert.equal(run.client.user, null);
  const request = run.calls.findLast(call => call.path === '/v1/account');
  assert.deepEqual(request.body, {});
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
