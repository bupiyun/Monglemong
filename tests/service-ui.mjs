import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createGame, serializeGame } from '../src/engine.js';

// Application integration against a test-only Electron transport double.
// This public client suite tests account and player flows only.
// No fake login path or credential is introduced into application sources.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3022';
const saveKey = 'mori.game.v1';
const rendererErrors = [];
let browser;
const servers = [spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3022', MONGLEMONG_BUILD_FLAVOR: 'user', MONGLEMONG_API_URL: 'http://127.0.0.1:8787' },
  stdio: ['ignore', 'pipe', 'pipe'],
})];

function fixture(gold) {
  const game = createGame();
  game.gold = gold;
  game.character.command = 'rest';
  game.character.x = 460;
  game.wanderTarget = 460;
  return JSON.parse(serializeGame(game));
}

async function openPage({ role = 'user', configured = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const adminRequests = [];
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('request', request => {
    if (/\/src\/admin\.(js|css)(\?|$)/.test(request.url())) adminRequests.push(request.url());
  });
  if (!configured) await page.route('**/src/runtime-config.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: `export const RUNTIME_CONFIG = Object.freeze(${JSON.stringify({ flavor: 'user', apiBaseUrl: '' })});`,
  }));
  await page.addInitScript(({ guest, online, key, role }) => {
    localStorage.setItem(key, JSON.stringify(guest));
    window.__service = { role, token: null, expired: false, requests: [],
      openedURLs: [], game: online, revision: 1, regions: [] };
    const mock = window.__service;
    const profile = () => ({ id: 'test-account', email: 'fixture@example.test', name: '테스트 모험가', role: mock.role });
    const ok = body => ({ status: 200, body, contentType: 'application/json' });
    const error = (status, code, message) => ({ status, body: { error: { code, message } }, contentType: 'application/json' });
    const envelope = () => ({ game: structuredClone(mock.game), revision: mock.revision,
      newCharacters: [], serverTime: Date.now() });
    window.desktop = {
      isDesktop: true,
      setInteractiveRegions: regions => { mock.regions = regions; },
      setMouseCapture: value => { mock.capturing = value; },
      setSceneMode: () => {}, onToggleMenu: () => () => {}, quit: () => {},
      getAccountSession: async () => Boolean(mock.token),
      setAccountSession: async token => { mock.token = token; },
      openAccountLogin: async value => { mock.openedURLs.push(value); },
      serviceRequest: async ({ method, path, body }) => {
        const recorded = structuredClone(body);
        mock.requests.push({ method, path, body: recorded });
        if (path === '/v1/auth/start') return ok({ flowId: 'test-flow', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test', expiresIn: 300 });
        if (path === '/v1/auth/poll') return ok({ status: 'complete', token: 'test_session_token_123456789012345678901234567890', user: profile() });
        if (!mock.token || mock.expired) return error(401, 'UNAUTHORIZED', '로그인이 만료되었어요.');
        if (path === '/v1/me') return ok({ user: profile() });
        if (path === '/v1/logout') return ok({ ok: true });
        if (path === '/v1/account' && method === 'DELETE') {
          if (!body || typeof body !== 'object') return error(400, 'INVALID_JSON', 'JSON 요청 본문이 필요해요.');
          return ok({ ok: true });
        }
        if (path === '/v1/game/sync') {
          if (Number.isFinite(body.x)) {
            mock.game.character.x = body.x;
            mock.game.characters.find(item => item.id === mock.game.activeCharacterId).x = body.x;
          }
          return ok(envelope());
        }
        if (path === '/v1/game/action') {
          if (body.revision !== mock.revision) return { ...error(409, 'REVISION_CONFLICT', '저장이 변경되었어요.'), body: { error: { code: 'REVISION_CONFLICT', message: '저장이 변경되었어요.' }, ...envelope() } };
          if (body.type === 'setCharacterScale') mock.game.settings.characterScale = body.payload.scale;
          if (body.type === 'setWindowWalking') mock.game.settings.windowWalking = body.payload.enabled;
          mock.revision += 1;
          return ok({ ...envelope(), result: { ok: true, message: '설정을 저장했어요.' } });
        }
        if (path === '/v1/characters') return ok({ characters: [] });
        return error(404, 'TEST_UNHANDLED', `테스트에서 처리하지 않은 요청: ${method} ${path}`);
      },
    };
  }, { guest: fixture(120), online: fixture(321), key: saveKey, role });
  await page.goto(url);
  await expect(page.locator('#settings-button')).toBeVisible();
  await expect(page.locator('#character-sprite')).toHaveAttribute('data-sprite-sheet', 'assets/characters/cafemong.png');
  return { page, adminRequests };
}

async function openSettings(page, tab = 'account') {
  if (await page.locator('#modal').evaluate(node => node.open)) await page.locator('#close-modal').click();
  await page.locator('#settings-button').click();
  await page.locator(`#settings-${tab}-tab`).click();
  await expect(page.locator(`#settings-${tab}`)).toBeVisible();
}

async function login(page) {
  await openSettings(page);
  await page.locator('#account-login').click();
  await expect(page.locator('#gold-text')).toHaveText('321');
  await expect(page.locator('#save-label')).toContainText('계정');
}

const guestSave = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), saveKey);

try {
  await Promise.all(servers.map(server => new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Service UI preview did not start')), 10_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Service UI preview exited (${code})`)); });
    server.stdout.on('data', data => { if (String(data).includes('preview:')) { clearTimeout(timer); ready(); } });
    server.stderr.on('data', data => process.stderr.write(data));
  })));
  const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] });
  await mkdir(output, { recursive: true });

  const { page, adminRequests } = await openPage();
  await expect(page.locator('#gold-text')).toHaveText('120');
  const before = await page.locator('#character').boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await guestSave(page)).character.x).toBeGreaterThan(600);
  assert.equal(await page.evaluate(() => window.__service.capturing), false, 'Drag releases native mouse capture');
  await openSettings(page);
  await expect(page.locator('#settings-admin-tab')).toHaveCount(0);
  await expect(page.locator('#account-login')).toBeEnabled();
  assert.deepEqual(adminRequests, [], 'User flavor never requests admin modules or styles');
  for (const asset of ['admin.js', 'admin.css']) {
    assert.equal((await page.request.get(`${url}/src/${asset}`)).status(), 404, `User preview does not expose ${asset}`);
  }
  await login(page);
  assert.equal((await guestSave(page)).gold, 120, 'Login keeps the guest save instead of replacing it with cloud state');
  assert.equal(await page.evaluate(() => window.__service.openedURLs.length), 1, 'Login uses the system browser bridge');
  const auth = await page.evaluate(() => window.__service.requests.filter(item => item.path.startsWith('/v1/auth/')));
  assert.match(auth.find(item => item.path.endsWith('/start')).body.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(auth.find(item => item.path.endsWith('/poll')).body.verifier, /^[A-Za-z0-9_-]{43}$/);
  await openSettings(page, 'general');
  await page.locator('[data-character-scale="3"]').click();
  await expect(page.locator('[data-character-scale="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__service.game.settings.characterScale)).toBe(3);
  assert.equal((await guestSave(page)).settings.characterScale, 2, 'Online settings never change guest preferences');
  const settingsAction = await page.evaluate(() => window.__service.requests.find(item => item.path === '/v1/game/action' && item.body.type === 'setCharacterScale'));
  assert.equal(settingsAction.body.payload.scale, 3);
  assert.equal(typeof settingsAction.body.revision, 'number');
  assert.match(settingsAction.body.requestId, /^[0-9a-f-]{36}$/i);
  assert.ok(!('game' in settingsAction.body), 'Actions submit commands, never an arbitrary client save');
  await openSettings(page);
  await page.screenshot({ path: resolve(output, 'account-online.png'), animations: 'disabled' });
  await page.locator('#account-logout').click();
  await expect(page.locator('#gold-text')).toHaveText('120');
  assert.equal(await page.evaluate(() => window.__service.token), null);
  assert.equal((await guestSave(page)).settings.characterScale, 2);
  console.log('✓ User flavor omits admin UI/module; login isolates guest/cloud saves, settings use server actions, logout restores guest, and dragging works');

  await login(page);
  await page.evaluate(() => { window.__service.expired = true; });
  await expect(page.locator('#gold-text')).toHaveText('120', { timeout: 12_000 });
  await expect(page.locator('#save-label')).toContainText('기기');
  await openSettings(page);
  await expect(page.locator('#account-login')).toBeVisible();
  assert.equal(await page.evaluate(() => window.__service.token), null, '401 discards the expired session');
  console.log('✓ Expired online sessions return to the retained guest game');
  await page.evaluate(() => { window.__service.expired = false; });
  await login(page);
  await page.locator('#account-delete').click();
  await expect(page.locator('#account-delete-panel')).toBeVisible();
  await page.locator('#account-delete-confirm').click();
  await expect(page.locator('#gold-text')).toHaveText('120');
  const deletion = await page.evaluate(() => window.__service.requests.find(item => item.method === 'DELETE' && item.path === '/v1/account'));
  assert.deepEqual(deletion.body, {}, 'Account deletion sends the JSON body required by the service');
  assert.equal(await page.evaluate(() => window.__service.token), null);
  assert.equal((await guestSave(page)).gold, 120);
  assert.deepEqual(adminRequests, [], 'Account transitions never load admin resources in the user flavor');
  await page.close();
  console.log('✓ Account deletion confirms the destructive action, sends JSON, and preserves the independent guest save');

  const privileged = await openPage({ role: 'admin' });
  await login(privileged.page);
  await expect(privileged.page.locator('#settings-admin-tab')).toHaveCount(0);
  await expect(privileged.page.locator('#admin-form')).toHaveCount(0);
  assert.deepEqual(privileged.adminRequests, [], 'A privileged account still cannot load authoring resources in the user client');
  assert.equal(await privileged.page.evaluate(() => window.__service.requests.filter(item => item.path.startsWith('/v1/admin/')).length), 0);
  await privileged.page.close();
  console.log('✓ An account with server administrator role still receives only the player interface and player requests');

  const unconfigured = await openPage({ configured: false });
  await openSettings(unconfigured.page);
  await expect(unconfigured.page.locator('#account-login')).toBeDisabled();
  await expect(unconfigured.page.locator('#account-status')).toContainText('연결이 아직 준비되지');
  assert.equal(await unconfigured.page.evaluate(() => window.__service.requests.length), 0, 'Unconfigured source never attempts login');
  await unconfigured.page.close();
  assert.deepEqual(rendererErrors, [], 'Player and account flows have no renderer errors');
  console.log('User account UI integration passed with test-only transport; actual Google/Windows checks still require deployment.');
} finally {
  await browser?.close();
  for (const server of servers) server.kill('SIGTERM');
}
