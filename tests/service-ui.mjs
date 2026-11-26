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
    const applyPresence = body => {
      if (Array.isArray(body.displays)) mock.game.worldDisplays = structuredClone(body.displays);
      for (const presence of body.characters || []) {
        const character = mock.game.characters.find(item => item.id === presence.characterId);
        if (!character || !mock.game.deployedCharacterIds.includes(character.id)) continue;
        if (Number.isFinite(presence.x)) character.x = presence.x;
        if (presence.displayId) character.displayId = presence.displayId;
      }
      mock.game.character = structuredClone(mock.game.characters.find(item => item.id === mock.game.activeCharacterId));
    };
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
          if (mock.holdPausedSync && body.characters?.some(character => character.paused)) {
            mock.holdPausedSync = false;
            await new Promise(resolveSync => { mock.releaseHeldSync = resolveSync; });
            mock.releaseHeldSync = null;
          }
          applyPresence(body);
          return ok(envelope());
        }
        if (path === '/v1/game/action') {
          if (body.revision !== mock.revision) return { ...error(409, 'REVISION_CONFLICT', '저장이 변경되었어요.'), body: { error: { code: 'REVISION_CONFLICT', message: '저장이 변경되었어요.' }, ...envelope() } };
          applyPresence(body);
          if (body.type === 'setCharacterScale') mock.game.settings.characterScale = body.payload.scale;
          if (body.type === 'setWindowWalking') mock.game.settings.windowWalking = body.payload.enabled;
          if (body.type === 'command') {
            const character = mock.game.characters.find(item => item.id === body.payload.characterId);
            if (!character) return error(400, 'INVALID_CHARACTER', '대상 동료가 필요해요.');
            character.command = body.payload.command;
            mock.game.character = structuredClone(mock.game.characters.find(item => item.id === mock.game.activeCharacterId));
          }
          const placement = body.characters?.find(character => Number.isFinite(character.x));
          if (placement && mock.nextPlacementOffset) {
            const character = mock.game.characters.find(item => item.id === placement.characterId);
            character.x += mock.nextPlacementOffset;
            mock.placementAck = { input: placement.x, output: character.x, requestIndex: mock.requests.length - 1 };
            mock.nextPlacementOffset = 0;
            mock.game.character = structuredClone(mock.game.characters.find(item => item.id === mock.game.activeCharacterId));
          }
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
  await page.locator('#close-modal').click();
  await page.locator('[data-command="fight"]').click();
  await expect.poll(() => page.evaluate(() => window.__service.game.character.command)).toBe('fight');
  const targetedCommand = await page.evaluate(() => window.__service.requests.find(item => item.path === '/v1/game/action' && item.body.type === 'command'));
  assert.deepEqual(targetedCommand.body.payload, { characterId: 'cafemong', command: 'fight' }, 'Online commands identify the intended owned companion');
  await page.locator('[data-command="rest"]').click();
  await expect.poll(() => page.evaluate(() => window.__service.game.character.command)).toBe('rest');
  // Hold the first drag heartbeat so a command queues behind it. Releasing
  // the pointer then supplies the explicit placement to that queued action.
  // The server advances the result by 40px; a stale pending x would rewind it.
  await page.evaluate(() => { window.__service.holdPausedSync = true; window.__service.nextPlacementOffset = 40; });
  const onlineBeforeDrag = await page.locator('#character').boundingBox();
  await page.mouse.move(onlineBeforeDrag.x + onlineBeforeDrag.width / 2, onlineBeforeDrag.y + onlineBeforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(760, 650, { steps: 12 });
  await expect.poll(() => page.evaluate(() => typeof window.__service.releaseHeldSync)).toBe('function');
  const heldPresence = await page.evaluate(() => window.__service.requests.find(item => item.path === '/v1/game/sync'
    && item.body.characters?.some(character => character.characterId === 'cafemong' && character.paused)));
  assert.ok(heldPresence, 'The server receives a paused heartbeat while the pointer is still held');
  // Dispatch a genuine command button handler without moving the captured mouse.
  await page.evaluate(() => document.querySelector('[data-command="rest"]').click());
  await page.mouse.up();
  await page.evaluate(() => window.__service.releaseHeldSync());
  await expect.poll(() => page.evaluate(() => window.__service.placementAck?.input || 0)).toBeGreaterThan(700);
  const ack = await page.evaluate(() => window.__service.placementAck);
  const placementAction = await page.evaluate(index => window.__service.requests[index], ack.requestIndex);
  assert.equal(placementAction.path, '/v1/game/action');
  assert.equal(placementAction.body.type, 'command');
  assert.ok(placementAction.body.displays.length >= 1, 'Online placement includes display regions');
  assert.equal(placementAction.body.characters[0].displayId, 'primary');
  assert.equal(placementAction.body.characters[0].paused, false, 'Release resumes the target companion');
  assert.equal(typeof placementAction.body.characters[0].elevated, 'boolean');
  assert.ok(!('game' in placementAction.body), 'Placement actions do not submit a client game save');
  await expect.poll(() => page.evaluate(index => window.__service.requests.slice(index + 1)
    .filter(item => item.path === '/v1/game/sync').length, ack.requestIndex)).toBeGreaterThan(0);
  const afterAck = await page.evaluate(index => window.__service.requests.slice(index + 1)
    .filter(item => item.path === '/v1/game/sync'), ack.requestIndex);
  for (const sync of afterAck) assert.ok(sync.body.characters.every(character => !('x' in character)), 'Acknowledged action placement is not submitted again by sync');
  assert.equal(await page.evaluate(() => window.__service.game.character.x), ack.output, 'Later sync cannot rewind the server position to the released drag x');
  await expect.poll(() => page.locator('#character').evaluate(node => {
    const box = node.getBoundingClientRect(); return box.x + box.width / 2;
  })).toBe(ack.output);
  assert.equal((await guestSave(page)).gold, 120, 'Online movement leaves the guest game intact');
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
  console.log('✓ User flavor omits admin UI/module; login isolates guest/cloud saves, settings/targeted commands/placements use server actions, logout restores guest, and dragging works');

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
