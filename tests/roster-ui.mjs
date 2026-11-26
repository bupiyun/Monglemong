import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installBundledSheetFixture } from './bundled-sheet-fixture.mjs';
import { installOfflineRuntime } from './offline-runtime-fixture.mjs';
import { CHARACTER_TYPES, FOOD_GROUPS, TASTES, FOODS } from '../src/engine.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3012';
const saveKey = 'mori.game.v1';
const statKeys = ['hp', 'mana', 'attack', 'defense', 'magic', 'resistance', 'speed'];
// QA fixture for migration from the original one-character save.
const legacySave = {
  version: 1,
  character: { level: 4, xp: 17, hp: 90, hunger: 72, mood: 80, bond: 8, command: 'wander', x: 550 },
  gold: 170,
  inventory: { grove: 3, mushroom: 1, crystal: 0 },
  stats: { kills: 48, clears: 12 },
};

const BASE_ID = 'cafemong';
// These definitions exist only in this isolated browser test profile. They are
// admin-created fixtures, not extra authored characters or dungeon unlocks.
const customFixtures = Array.from({ length: 8 }, (_, index) => {
  const id = `custom_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return {
    id, sheetId: id, name: `테스트 동료 ${index + 1}`, title: '목록 검증용 임시 동료',
    personality: '목록과 교대 기능을 확인하는 테스트 친구예요.', foodPreference: 'fruit', tastePreferences: ['sweet', 'sour'],
    baseStats: { hp: 90 + index, mana: 30, attack: 7, defense: 4, magic: 8, resistance: 5, speed: 10 },
    growthStats: { hp: 10, mana: 5, attack: 1, defense: 2, magic: 2, resistance: 3, speed: 0.5 },
  };
});
const progressedSave = {
  ...legacySave, version: 3, activeCharacterId: BASE_ID,
  character: { ...legacySave.character, id: BASE_ID },
  characters: [{ ...legacySave.character, id: BASE_ID }], customDefinitions: customFixtures,
};
const rosterSize = 1 + customFixtures.length;

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3012' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
const errors = [];

function monitor(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
}

async function openPage({ seed, width = 1440, height = 900, desktop = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
  monitor(page);
  await installOfflineRuntime(page);
  if (seed) {
    await page.addInitScript(({ key, saved }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(saved));
    }, { key: saveKey, saved: seed });
  }
  if (desktop) {
    await page.addInitScript(() => {
      window.__desktopRegions = [];
      window.desktop = {
        isDesktop: true,
        setInteractiveRegions: regions => { window.__desktopRegions = regions; },
        setMouseCapture: captured => { window.__mouseCaptured = captured; },
        setSceneMode: mode => { window.__sceneMode = mode; },
        onToggleMenu: callback => {
          window.__toggleMenu = callback;
          return () => { window.__toggleMenu = undefined; };
        },
        quit: () => {},
      };
    });
  }
  await installBundledSheetFixture(page, root);
  await page.goto(url);
  await expect(page.locator('[data-tab="companions"]')).toBeVisible();
  return page;
}

async function readSave(page) {
  return page.evaluate(key => {
    window.dispatchEvent(new Event('blur'));
    return JSON.parse(localStorage.getItem(key));
  }, saveKey);
}

async function assertProfile(page, character) {
  await expect(page.locator('#detail-personality')).toContainText(character.personality);
  await expect(page.locator('#detail-food')).toContainText(FOOD_GROUPS.find(group => group.id === character.foodPreference).name);
  await expect(page.locator('#detail-tastes .taste-chip')).toHaveCount(2);
  const tastes = await page.locator('#detail-tastes .taste-chip').allTextContents();
  const expected = character.tastePreferences.map(id => TASTES.find(taste => taste.id === id).name);
  for (const label of expected) assert.ok(tastes.some(text => text.includes(label)), `Expected taste ${label}`);
  assert.equal(new Set(tastes).size, 2, 'Preferred tastes must be distinct');
  const keys = await page.locator('#detail-stats [data-stat]').evaluateAll(nodes => nodes.map(node => node.dataset.stat));
  assert.deepEqual(keys.sort(), [...statKeys].sort(), 'Profile exposes all seven stats exactly once');
}

async function assertGridAndScroll(page, width) {
  const cards = page.locator('#roster-grid [data-companion]');
  await expect(cards).toHaveCount(rosterSize);
  const metrics = await cards.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width };
  }));
  assert.ok(Math.abs(metrics[0].y - metrics[1].y) < 1 && Math.abs(metrics[1].y - metrics[2].y) < 1, 'First three cards share a row');
  assert.ok(metrics[0].x < metrics[1].x && metrics[1].x < metrics[2].x, 'The row has three distinct columns');
  assert.ok(Math.abs(metrics[3].x - metrics[0].x) < 1 && metrics[3].y > metrics[0].y, 'Fourth card starts the next row');
  assert.ok(metrics.every(rect => rect.x >= 0 && rect.x + rect.width <= width + 1), `Roster cards stay within ${width}px viewport: ${JSON.stringify(metrics)}`);
  const scroll = page.locator('#roster-scroll');
  assert.ok(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), 'Acquired roster overflows its own scroll region');
  await scroll.hover();
  await page.mouse.wheel(0, 550);
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await cards.last().click();
  await assertProfile(page, customFixtures.at(-1));
  await page.locator('#close-modal').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal page overflow');
}

try {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Roster preview server did not become ready')), 10_000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Roster server exited (${code})`)); });
    server.stdout.on('data', data => {
      if (data.toString().includes('MongleMong preview:')) { clearTimeout(timeout); resolveReady(); }
    });
    server.stderr.on('data', data => process.stderr.write(data));
  });
  await mkdir(output, { recursive: true });
  const executablePath = process.env.CHROMIUM_PATH || [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean).find(existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] });

  const fresh = await openPage();
  await fresh.locator('[data-tab="companions"]').click();
  await expect(fresh.locator('#roster-grid [data-companion]')).toHaveCount(1);
  await expect(fresh.locator('[data-companion="cafemong"]')).toBeVisible();
  await fresh.locator('[data-companion="cafemong"]').click();
  await assertProfile(fresh, CHARACTER_TYPES.find(character => character.id === BASE_ID));
  assert.equal((await readSave(fresh)).characters.length, 1, 'Unacquired companions are not invented');
  const baseType = CHARACTER_TYPES.find(character => character.id === BASE_ID);
  assert.equal(CHARACTER_TYPES.length, 1, 'Cafemong is the sole authored base character');
  assert.deepEqual(baseType.baseStats, { hp: 130, mana: 30, attack: 6, defense: 4, magic: 14, resistance: 9, speed: 8 });
  await expect(fresh.locator('#detail-hp')).toHaveText('130 / 130');
  await expect(fresh.locator('#detail-mana')).toHaveText('30 / 30');
  for (const key of ['attack', 'defense', 'magic', 'resistance', 'speed']) await expect(fresh.locator('#detail-' + key)).toHaveText(String(baseType.baseStats[key]));
  await expect(fresh.locator('.profile-image img')).toHaveAttribute('data-sprite-row', '0');
  await fresh.locator('#close-modal').click();
  await fresh.locator('[data-command="rest"]').click();
  const baseSprite = fresh.locator('#character-sprite');
  await expect(baseSprite).toHaveAttribute('data-sprite-row', '3');
  const firstFrame = await baseSprite.getAttribute('data-sprite-frame');
  await expect.poll(() => baseSprite.getAttribute('data-sprite-frame')).not.toBe(firstFrame);
  await expect(baseSprite).toHaveAttribute('data-sprite-row', '4', { timeout: 5000 });
  console.log('✓ Fresh game has only Cafemong with the specified stats/preferences; bundled sheet frames follow doze and sleep');

  const legacy = await openPage({ seed: legacySave });
  const legacyMigrated = await readSave(legacy);
  assert.deepEqual(legacyMigrated.characters.map(character => character.id), [BASE_ID], 'Past dungeon clears must not reintroduce removed base characters');
  assert.equal(legacyMigrated.activeCharacterId, BASE_ID);
  assert.equal(legacyMigrated.character.level, 4);
  assert.equal(legacyMigrated.character.xp, 17);
  assert.equal(legacyMigrated.character.maxHp, 160);
  assert.equal(legacyMigrated.character.speed, 9.5, 'Fractional base speed growth must reach the actual character');
  assert.equal(legacyMigrated.gold, 170);
  await legacy.close();
  console.log('✓ Legacy progress migrates to Cafemong; removed base characters do not unlock again');

  const page = await openPage({ seed: progressedSave });
  const migrated = await readSave(page);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.character.level, 4);
  assert.equal(migrated.character.xp, 17);
  assert.equal(migrated.character.hp, 90);
  assert.equal(migrated.gold, 170);
  assert.equal(migrated.inventory.grove, 3);
  assert.equal(migrated.characters.length, rosterSize);
  assert.deepEqual(migrated.characters.filter(character => !character.custom).map(character => character.id), [BASE_ID]);
  await page.locator('[data-tab="companions"]').click();
  await assertGridAndScroll(page, 1440);
  const beforeInspect = (await readSave(page)).activeCharacterId;
  const otherType = customFixtures[0];
  await page.locator(`[data-companion="${otherType.id}"]`).click();
  await assertProfile(page, otherType);
  assert.equal((await readSave(page)).activeCharacterId, beforeInspect, 'Inspecting a card must not swap the active character');
  const baseBefore = (await readSave(page)).characters.find(character => character.id === BASE_ID);
  await page.locator('#activate-companion').click();
  await expect(page.locator('#active-name')).toHaveText(otherType.name);
  const afterSwap = await readSave(page);
  assert.equal(afterSwap.activeCharacterId, customFixtures[0].id);
  assert.equal(afterSwap.character.level, 1);
  assert.equal(afterSwap.characters.find(character => character.id === BASE_ID).level, baseBefore.level);
  assert.equal(afterSwap.characters.find(character => character.id === BASE_ID).hp, baseBefore.hp);
  await expect(page.locator('#character-sprite')).toHaveAttribute('src', afterSwap.character.sprite);
  await expect(page.locator('#mana-text')).not.toBeEmpty();
  await expect(page.locator('#activate-companion')).toBeDisabled();
  await page.locator('#close-modal').click();
  await page.reload();
  await expect(page.locator('#active-name')).toHaveText(otherType.name);
  assert.equal((await readSave(page)).activeCharacterId, customFixtures[0].id);
  await page.locator('[data-tab="companions"]').click();
  await page.locator('[data-companion="cafemong"]').click();
  await page.locator('#activate-companion').click();
  const restored = await readSave(page);
  assert.equal(restored.character.level, baseBefore.level);
  assert.equal(restored.character.hp, baseBefore.hp);
  await page.locator('#close-modal').click();
  console.log('✓ Admin-created companions remain selectable; inspection, switching and reload preserve independent progress');

  await page.locator('#minimize-button').click();
  await expect(page.locator('#roster-scroll')).toBeHidden();
  await page.locator('#launcher').click();
  await expect(page.locator('#roster-scroll')).toBeVisible();
  await expect(page.locator('[data-tab="companions"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-tab="care"]').click();
  const food = FOODS.find(item => item.group === restored.character.foodPreference);
  await page.locator('#food-select').selectOption(food.id);
  for (const taste of food.tastes) await expect(page.locator('#food-preview')).toContainText(TASTES.find(item => item.id === taste).name);
  const beforeFeed = await readSave(page);
  await page.locator('#care-feed').click();
  const afterFeed = await readSave(page);
  assert.equal(afterFeed.gold, beforeFeed.gold - food.price);
  assert.ok(afterFeed.character.hunger > beforeFeed.character.hunger);
  assert.ok(afterFeed.character.bond > beforeFeed.character.bond, 'Preferred food should improve bond');
  await page.locator('[data-tab="companions"]').click();
  await expect(page.locator('#toast')).not.toHaveClass(/\bshow\b/);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, 'companions.png') });
  await page.locator('[data-companion="cafemong"]').click();
  await page.screenshot({ path: resolve(output, 'companion-detail.png'), animations: 'disabled' });
  await page.locator('#close-modal').click();
  console.log('✓ Menu-owned roster follows minimize; selected food applies its preference bonus');

  const mobile = await openPage({ seed: progressedSave, width: 390, height: 844 });
  await mobile.locator('[data-tab="companions"]').click();
  await assertGridAndScroll(mobile, 390);
  await mobile.screenshot({ path: resolve(output, 'companions-mobile.png') });
  console.log('✓ Acquired roster keeps three columns and vertical scrolling on narrow screens');

  const nativeBridge = await openPage({ seed: progressedSave, desktop: true });
  await nativeBridge.locator('[data-tab="companions"]').click();
  await expect.poll(() => nativeBridge.evaluate(() => window.__desktopRegions.length)).toBeGreaterThan(0);
  await nativeBridge.locator('[data-companion="cafemong"]').click();
  await expect(nativeBridge.locator('#modal')).toBeVisible();
  await expect.poll(() => nativeBridge.evaluate(() => window.__mouseCaptured)).toBe(true);
  await nativeBridge.evaluate(() => window.__toggleMenu());
  await expect(nativeBridge.locator('#dock')).toBeHidden();
  await expect(nativeBridge.locator('#modal')).toBeHidden();
  await expect.poll(() => nativeBridge.evaluate(() => window.__mouseCaptured)).toBe(false);
  await nativeBridge.evaluate(() => window.__toggleMenu());
  await expect(nativeBridge.locator('#roster-scroll')).toBeVisible();
  await expect(nativeBridge.locator('[data-tab="companions"]')).toHaveAttribute('aria-pressed', 'true');
  const dock = await nativeBridge.locator('#dock').boundingBox();
  const point = { x: dock.x + dock.width / 2, y: dock.y + 100 };
  const capturesPoint = () => nativeBridge.evaluate(({ x, y }) => window.__desktopRegions.some(rect => x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height), point);
  await expect.poll(capturesPoint).toBe(true);
  await nativeBridge.locator('#minimize-button').click();
  await expect.poll(capturesPoint).toBe(false);
  await nativeBridge.locator('#launcher').click();
  await expect.poll(capturesPoint).toBe(true);
  await nativeBridge.locator('[data-tab="cores"]').click();
  await expect(nativeBridge.locator('#roster-scroll')).toBeHidden();
  await nativeBridge.locator('#minimize-button').click();
  await expect.poll(capturesPoint).toBe(false);
  console.log('✓ Global menu shortcut closes dependent detail; hidden UI releases desktop input');

  assert.deepEqual(errors, [], 'Roster UI must have no renderer errors or missing assets');
  console.log(`Roster UI passed. Test-profile screenshots: ${output}/companions.png and companions-mobile.png`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
