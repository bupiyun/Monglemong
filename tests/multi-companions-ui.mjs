import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createGame, createCustomCharacter, serializeGame, setCharacterDeployed } from '../src/engine.js';
import { buildDisplayLayout } from '../electron/display-layout.cjs';
import { installOfflineRuntime } from './offline-runtime-fixture.mjs';

// These are Electron DIP rectangles, not physical pixels. Mixed scale factors
// exercise the actual native normalization helper before the mock IPC boundary.
// A physical Windows mixed-DPI drag still needs a Windows acceptance check.
const nativeDisplays = [
  { id: 'primary', bounds: { x: 0, y: 0, width: 1280, height: 900 }, workArea: { x: 0, y: 0, width: 1280, height: 860 }, scaleFactor: 1.25 },
  { id: 'left', bounds: { x: -900, y: 0, width: 900, height: 900 }, workArea: { x: -900, y: 0, width: 900, height: 860 }, scaleFactor: 1 },
  { id: 'upper', bounds: { x: 0, y: -700, width: 1280, height: 700 }, workArea: { x: 0, y: -700, width: 1280, height: 700 }, scaleFactor: 1.5 },
];
const initialLayout = buildDisplayLayout(nativeDisplays, 'primary');
const primaryOnly = buildDisplayLayout([nativeDisplays[0]], 'primary');
assert.deepEqual(initialLayout.origin, { x: -900, y: -700 });
assert.deepEqual([initialLayout.width, initialLayout.height], [2180, 1600]);
assert.deepEqual(initialLayout.displays.map(display => display.scaleFactor), [1.25, 1, 1.5]);
const engineDisplays = initialLayout.displays.map(display => ({ id: display.id, ...display.workArea, floorY: display.workArea.y + display.workArea.height }));
const seed = createGame();
// Only this browser profile owns these fixtures. No extra base characters or
// unpublished character resources are added to the distributed game.
const customIds = Array.from({ length: 3 }, (_, index) => {
  const id = `custom_00000000-0000-4000-8000-${String(index + 31).padStart(12, '0')}`;
  assert.equal(createCustomCharacter(seed, {
    id, sheetId: id, name: `동시 활동 검증 ${index + 1}`, title: '테스트 전용 획득 동료',
    personality: '여러 친구가 함께 자라는지 확인해요.', foodPreference: 'snack', tastePreferences: ['sweet', 'salty'],
    baseStats: { hp: 130, mana: 30, attack: 6, defense: 4, magic: 14, resistance: 9, speed: 8 },
    growthStats: { hp: 10, mana: 5, attack: 1, defense: 2, magic: 2, resistance: 3, speed: 0.5 },
  }).ok, true);
  assert.equal(setCharacterDeployed(seed, id, true, initialLayout.width, {
    displays: engineDisplays, displayId: 'primary', x: 1320 + index * 240,
  }).ok, true);
  return id;
});
seed.worldDisplays = engineDisplays;
seed.gold = 300;
seed.characters.forEach((character, index) => {
  character.x = 1080 + index * 240;
  character.displayId = 'primary';
  character.wanderTarget = character.x;
  character.command = 'rest';
  character.hunger = 45 + index * 3;
  character.mood = 55;
  character.bond = index * 5;
});
seed.characters.find(character => character.id === customIds[1]).hp = 80;
seed.characters.find(character => character.id === customIds[1]).mana = 10;
const fixture = JSON.parse(serializeGame(seed));
const ids = ['cafemong', ...customIds];
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3024';
const saveKey = 'mori.game.v1';
const errors = [];
let browser;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3024' }, stdio: ['ignore', 'pipe', 'pipe'],
});

const actor = (page, id) => page.locator(`#characters > .character[data-character-id="${id}"]`);
async function readSave(page) {
  return page.evaluate(key => {
    window.dispatchEvent(new Event('blur'));
    return JSON.parse(localStorage.getItem(key));
  }, saveKey);
}
const find = (saved, id) => saved.characters.find(character => character.id === id);
async function pose(page, id) {
  return actor(page, id).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, footY: Number(node.dataset.footY), displayId: node.dataset.displayId,
      surfaceId: node.dataset.surfaceId, y: rect.y, width: rect.width, height: rect.height };
  });
}
async function showDock(page) {
  if (await page.locator('#dock').isHidden()) await page.locator('#launcher').click();
}
async function closeActorMenu(page) { await page.keyboard.press('Escape'); }
async function focus(page, id) {
  await actor(page, id).click();
  await expect(page.locator('#character')).toHaveAttribute('data-character-id', id);
}
async function dragTo(page, id, x, footY) {
  const before = await pose(page, id);
  const box = await actor(page, id).boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__mouseCaptured)).toBe(true);
  await page.mouse.move(start.x + x - before.x, start.y + footY - before.footY, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__mouseCaptured)).toBe(false);
}
async function assertActors(page, expectedIds) {
  await expect(page.locator('#characters > .character')).toHaveCount(expectedIds.length);
  for (const id of expectedIds) await expect(actor(page, id)).toBeVisible();
}

try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Multi-companion preview did not become ready')), 10_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Multi-companion server exited (${code})`)); });
    server.stdout.on('data', data => { if (String(data).includes('preview:')) { clearTimeout(timer); ready(); } });
    server.stderr.on('data', data => process.stderr.write(data));
  });
  const executablePath = process.env.CHROMIUM_PATH || [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean).find(existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] });
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: initialLayout.width, height: initialLayout.height } });
  await installOfflineRuntime(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(({ key, game, initial }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(game));
    const stored = sessionStorage.getItem('multi-test-layout');
    window.__layout = stored ? JSON.parse(stored) : initial;
    window.__desktopRegions = [];
    const surfaces = () => ({ supported: true, status: 'ready', width: window.__layout.width, height: window.__layout.height,
      surfaces: window.__layout.displays.map(display => ({ id: `desktop-floor:${display.id}`, displayId: display.id, kind: 'taskbar',
        x: display.workArea.x, y: display.workArea.y + display.workArea.height, width: display.workArea.width })) });
    window.__publishDisplays = next => {
      window.__layout = next;
      sessionStorage.setItem('multi-test-layout', JSON.stringify(next));
      window.__displayListener?.(next);
      window.__surfaceListener?.(surfaces());
    };
    window.desktop = {
      isDesktop: true,
      setInteractiveRegions: value => { window.__desktopRegions = value; },
      setMouseCapture: value => { window.__mouseCaptured = value; },
      setSceneMode: value => { window.__sceneMode = value; },
      onToggleMenu: callback => { window.__toggleMenu = callback; return () => {}; },
      onDisplays: callback => { window.__displayListener = callback; return () => {}; },
      requestDisplays: () => { window.__displayListener?.(window.__layout); },
      onSurfaces: callback => { window.__surfaceListener = callback; return () => {}; },
      requestSurfaces: () => { window.__surfaceListener?.(surfaces()); },
      quit: () => {},
    };
  }, { key: saveKey, game: fixture, initial: initialLayout });
  await page.goto(url);
  await assertActors(page, ids);
  await expect(page.locator('#deployed-count')).toHaveText('4 / 6');
  const dock = await page.locator('#dock').boundingBox();
  assert.ok(dock.x >= 900 && dock.y >= 700 && dock.x + dock.width <= 2180 && dock.y + dock.height <= 1561, 'Menu is inside the primary work area even when the desktop origin is negative');
  await page.locator('#minimize-button').click();
  const initialSaved = await readSave(page);
  assert.deepEqual(initialSaved.deployedCharacterIds, ids);
  for (const id of ids) await expect(actor(page, id)).toHaveAttribute('data-display-id', 'primary');
  console.log('✓ Four owned companions render together on a negative-origin mixed-scale desktop');

  await focus(page, customIds[0]);
  const beforePet = await readSave(page);
  await page.locator('#pet-action').click();
  const afterPet = await readSave(page);
  assert.equal(find(afterPet, customIds[0]).bond, find(beforePet, customIds[0]).bond + 1);
  for (const id of ids.filter(id => id !== customIds[0])) assert.equal(find(afterPet, id).bond, find(beforePet, id).bond, 'Petting does not affect another companion');
  await assertActors(page, ids);
  await closeActorMenu(page);
  await focus(page, customIds[1]);
  const beforeFeed = await readSave(page);
  await page.locator('#feed-action').click();
  const afterFeed = await readSave(page);
  assert.equal(afterFeed.gold, beforeFeed.gold - 10);
  assert.ok(find(afterFeed, customIds[1]).hunger > find(beforeFeed, customIds[1]).hunger + 25);
  assert.ok(find(afterFeed, customIds[1]).hp > find(beforeFeed, customIds[1]).hp + 10, 'Food heals the intended companion');
  assert.ok(find(afterFeed, customIds[1]).mana > 10, 'The resting companion recovers its own mana');
  assert.equal(find(afterFeed, 'cafemong').mana, 30);
  for (const id of ids.filter(id => id !== customIds[1])) {
    assert.equal(find(afterFeed, id).bond, find(beforeFeed, id).bond, 'Feeding only changes the target bond');
    assert.ok(find(afterFeed, id).hunger <= find(beforeFeed, id).hunger, 'Other companions do not receive food');
  }
  await closeActorMenu(page);
  await showDock(page);
  await page.locator('[data-command="wander"]').click();
  const beforeWalk = await readSave(page);
  assert.equal(find(beforeWalk, customIds[1]).command, 'wander');
  for (const id of ids.filter(id => id !== customIds[1])) assert.equal(find(beforeWalk, id).command, 'rest');
  await expect.poll(async () => Math.abs(find(await readSave(page), customIds[1]).x - find(beforeWalk, customIds[1]).x)).toBeGreaterThan(2);
  const afterWalk = await readSave(page);
  for (const id of ids.filter(id => id !== customIds[1])) assert.equal(find(afterWalk, id).x, find(beforeWalk, id).x, 'Resting companions keep their own positions');
  await page.locator('[data-command="rest"]').click();
  await assertActors(page, ids);
  console.log('✓ Focus, petting, feeding and commands target one companion while others remain visible');

  // Pause prevents random wandering during geometry assertions; desktop dragging
  // remains usable, just as it does for the original one-character surface test.
  await page.locator('#settings-button').click();
  await page.locator('#setting-pause').click();
  await page.locator('#close-modal').click();
  await page.locator('#minimize-button').click();
  const parked = Object.fromEntries(await Promise.all(ids.map(async id => [id, await pose(page, id)])));
  await dragTo(page, customIds[0], 420, 1560);
  await expect(actor(page, customIds[0])).toHaveAttribute('data-display-id', 'left');
  await expect(actor(page, customIds[0])).toHaveAttribute('data-surface-id', 'desktop-floor:left');
  await dragTo(page, customIds[1], 1480, 700);
  await expect(actor(page, customIds[1])).toHaveAttribute('data-display-id', 'upper');
  await expect(actor(page, customIds[1])).toHaveAttribute('data-surface-id', 'desktop-floor:upper');
  assert.ok(Math.abs((await pose(page, customIds[0])).x - 420) < 2);
  assert.ok(Math.abs((await pose(page, customIds[1])).x - 1480) < 2);
  assert.equal((await pose(page, customIds[0])).footY, 1560);
  assert.equal((await pose(page, customIds[1])).footY, 700);
  for (const id of ['cafemong', customIds[2]]) assert.deepEqual(await pose(page, id), parked[id], 'Dragging one companion does not move another');
  const placed = await readSave(page);
  assert.equal(find(placed, customIds[0]).displayId, 'left');
  assert.equal(find(placed, customIds[1]).displayId, 'upper');
  await page.screenshot({ path: resolve(output, 'multi-companions-monitors.png') });
  await page.reload();
  await assertActors(page, ids);
  for (const id of ids) {
    await expect(actor(page, id)).toHaveAttribute('data-display-id', find(placed, id).displayId);
    assert.ok(Math.abs((await pose(page, id)).x - find(placed, id).x) < 2, 'Each monitor and horizontal position survive reload');
  }
  console.log('✓ Independent drags cross left and upper monitors and restore saved placements');

  // A native topology update includes a new overlay origin. Remaining monitors
  // rebase, and companions on unplugged monitors return to the primary display.
  // BrowserWindow.resize can arrive before the replacement display snapshot.
  await page.setViewportSize({ width: primaryOnly.width, height: primaryOnly.height });
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
  await page.evaluate(layout => window.__publishDisplays(layout), primaryOnly);
  await expect.poll(async () => (await readSave(page)).worldDisplays.length).toBe(1);
  for (const id of ids) {
    await expect(actor(page, id)).toHaveAttribute('data-display-id', 'primary');
    await expect(actor(page, id)).toHaveAttribute('data-surface-id', 'desktop-floor:primary');
    const current = await pose(page, id);
    assert.ok(current.x > 0 && current.x < 1280 && current.footY === 860, 'A removed monitor cannot strand a companion outside the primary screen');
  }
  await showDock(page);
  await page.locator('[data-tab="companions"]').click();
  const progress = await readSave(page);
  await page.locator(`[data-deploy-character="${customIds[2]}"]`).click();
  await expect(actor(page, customIds[2])).toHaveCount(0);
  await expect(page.locator('#deployed-count')).toHaveText('3 / 6');
  assert.equal(find(await readSave(page), customIds[2]).bond, find(progress, customIds[2]).bond, 'Returning a companion preserves progress');
  await page.locator(`[data-deploy-character="${customIds[2]}"]`).click();
  await assertActors(page, ids);
  await expect(page.locator('#deployed-count')).toHaveText('4 / 6');
  for (const id of customIds) await page.locator(`[data-deploy-character="${id}"]`).click();
  await assertActors(page, ['cafemong']);
  await expect(page.locator('#deployed-count')).toHaveText('1 / 6');
  const finalReturn = page.locator('[data-deploy-character="cafemong"]');
  if (await finalReturn.isEnabled()) await finalReturn.click();
  await assertActors(page, ['cafemong']);
  assert.deepEqual((await readSave(page)).deployedCharacterIds, ['cafemong'], 'At least one companion stays deployed');
  await page.reload();
  await assertActors(page, ['cafemong']);
  assert.equal((await readSave(page)).characters.length, 4, 'Returning companions never deletes owned data');
  assert.deepEqual(errors, [], 'Multi-companion UI has no renderer errors or missing files');
  console.log('✓ Monitor removal returns companions safely; roster deployment/return and minimum one persist');
  console.log(`Multi-companion mock-desktop UI passed. Screenshot: ${output}/multi-companions-monitors.png`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
