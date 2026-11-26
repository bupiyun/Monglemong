import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installOfflineRuntime } from './offline-runtime-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3017';
const saveKey = 'mori.game.v1';
const errors = [];
let browser;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3017' }, stdio: ['ignore', 'pipe', 'pipe'],
});

async function openPage({ seed, desktop = false, width = 1440, height = 900, random } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await installOfflineRuntime(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(({ key, saved, desktop, random }) => {
    if (saved && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(saved));
    if (typeof random === 'number') Math.random = () => random;
    if (desktop) {
      window.__desktopRegions = [];
      window.desktop = {
        isDesktop: true, setInteractiveRegions: regions => { window.__desktopRegions = regions; },
        setMouseCapture: capture => { window.__mouseCaptured = capture; }, setSceneMode: () => {},
        onToggleMenu: callback => { window.__toggleMenu = callback; return () => {}; }, quit: () => {},
      };
    }
  }, { key: saveKey, saved: seed, desktop, random });
  await page.goto(url);
  await expect(page.locator('#settings-button')).toBeVisible();
  await expect(page.locator('#character-sprite')).toHaveAttribute('data-sprite-sheet', 'assets/characters/cafemong.png');
  return page;
}

async function readSave(page) {
  return page.evaluate(key => {
    window.dispatchEvent(new Event('blur'));
    return JSON.parse(localStorage.getItem(key));
  }, saveKey);
}

async function dimensions(locator) {
  return locator.evaluate(node => {
    const { width, height } = node.getBoundingClientRect(); return { width, height };
  });
}

async function assertScale(page, scale) {
  await expect.poll(() => dimensions(page.locator('#character-sprite'))).toEqual({ width: 96 * scale, height: 96 * scale });
  await expect.poll(() => dimensions(page.locator('#character'))).toEqual({ width: 96 * scale, height: 96 * scale + 16 });
}

async function openSettingsPaused(page) {
  await page.locator('#settings-button').click();
  if ((await page.locator('#setting-pause').textContent()).trim() === '일시 정지') await page.locator('#setting-pause').click();
}

async function dragCharacter(page, x, y) {
  const rect = await page.locator('#character').boundingBox();
  assert.ok(rect, 'Character can be dragged');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

async function inViewport(page, selector) {
  const rect = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1
    && rect.y + rect.height <= viewport.height + 1, `${selector} stays within viewport: ${JSON.stringify(rect)}`);
}

const legacy = {
  version: 3, activeCharacterId: 'cafemong',
  character: { id: 'cafemong', level: 4, xp: 19, command: 'rest', x: 550, hp: 160, mana: 45 },
  characters: [{ id: 'cafemong', level: 4, xp: 19, command: 'rest', x: 550, hp: 160, mana: 45 }],
  gold: 180, inventory: { grove: 4, mushroom: 2, crystal: 1 }, stats: { kills: 8, clears: 2 },
};
// One final survivor of a grove wave. The actual renderer loop deals the lethal
// blow and performs loot rolls, rather than the test directly awarding items.
const battleSeed = {
  version: 3, activeCharacterId: 'cafemong', settings: { characterScale: 2 },
  character: { id: 'cafemong', level: 1, xp: 0, command: 'fight', x: 600, hp: 130, mana: 30 },
  characters: [{ id: 'cafemong', level: 1, xp: 0, command: 'fight', x: 600, hp: 130, mana: 30 }],
  gold: 120, inventory: { grove: 2, mushroom: 0, crystal: 0 }, items: { slime_gel: 4 },
  portals: [{ id: 'p1', coreId: 'grove', x: 630, defeated: 2, spawnIn: 5 }],
  monsters: [{ id: 'm2', portalId: 'p1', x: 635, hp: 1, cooldown: 2 }],
  stats: { kills: 0, clears: 0 }, nextId: 3,
};

try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Scale/loot preview did not become ready')), 10_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Scale/loot server exited (${code})`)); });
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

  const fresh = await openPage();
  await assertScale(fresh, 2);
  await fresh.locator('[data-tab="inventory"]').click();
  await expect(fresh.locator('#inventory-empty')).toBeVisible();
  await expect(fresh.locator('#item-grid [data-item]')).toHaveCount(0);
  await expect(fresh.locator('#item-count')).toHaveText('0');
  const freshSave = await readSave(fresh);
  assert.equal(freshSave.settings.characterScale, 2);
  assert.ok(Object.values(freshSave.items).every(count => count === 0));
  await fresh.close();
  console.log('✓ Fresh games start at double size with an empty warehouse');

  const scalePage = await openPage({ seed: legacy, desktop: true });
  await assertScale(scalePage, 2);
  const before = await readSave(scalePage);
  assert.equal(before.character.level, 4); assert.equal(before.character.xp, 19);
  assert.deepEqual(before.inventory, legacy.inventory);
  const portrait = await dimensions(scalePage.locator('#active-portrait'));
  await openSettingsPaused(scalePage);
  await expect(scalePage.locator('[data-character-scale="2"]')).toHaveAttribute('aria-pressed', 'true');
  for (const scale of [1, 3]) {
    await scalePage.locator(`[data-character-scale="${scale}"]`).click();
    await expect(scalePage.locator(`[data-character-scale="${scale}"]`)).toHaveAttribute('aria-pressed', 'true');
    await assertScale(scalePage, scale);
    assert.equal((await readSave(scalePage)).settings.characterScale, scale);
  }
  assert.deepEqual(await dimensions(scalePage.locator('#active-portrait')), portrait, 'World scaling does not enlarge profile portraits');
  const after = await readSave(scalePage);
  for (const field of ['level', 'xp', 'maxHp', 'maxMana', 'attack', 'defense', 'magic', 'resistance', 'speed']) {
    assert.equal(after.character[field], before.character[field], `Display scale does not change ${field}`);
  }
  await expect(scalePage.locator('#settings-admin-tab')).toHaveCount(0);
  await expect(scalePage.locator('#settings-account-tab')).toBeVisible();
  await scalePage.reload();
  await assertScale(scalePage, 3);
  await openSettingsPaused(scalePage);
  await expect(scalePage.locator('[data-character-scale="3"]')).toHaveAttribute('aria-pressed', 'true');
  await scalePage.locator('#close-modal').click();
  await scalePage.locator('#minimize-button').click();
  await dragCharacter(scalePage, 0, 400);
  await inViewport(scalePage, '#character');
  await scalePage.locator('#character').focus(); await scalePage.keyboard.press('Enter');
  await expect(scalePage.locator('#character-menu')).toBeVisible();
  await inViewport(scalePage, '#character-menu');
  await scalePage.locator('#close-character').click();
  await dragCharacter(scalePage, 1439, 400);
  await inViewport(scalePage, '#character');
  await expect.poll(() => scalePage.evaluate(() => {
    const rect = document.querySelector('#character').getBoundingClientRect();
    return window.__desktopRegions.some(region => Math.abs(region.x - rect.x) < 1 && Math.abs(region.y - rect.y) < 1
      && Math.abs(region.width - rect.width) < 1 && Math.abs(region.height - rect.height) < 1);
  })).toBe(true);
  await scalePage.setViewportSize({ width: 390, height: 844 });
  await assertScale(scalePage, 3);
  await inViewport(scalePage, '#character');
  await dragCharacter(scalePage, 0, 300);
  await inViewport(scalePage, '#character');
  await scalePage.locator('#character').focus(); await scalePage.keyboard.press('Enter');
  await inViewport(scalePage, '#character-menu');
  await scalePage.screenshot({ path: resolve(output, 'character-scale-mobile.png'), animations: 'disabled' });
  await scalePage.close();
  console.log('✓ Scale 1/2/3 persists, preserves stats/portraits, and updates drag/menu/desktop hit regions at screen edges');

  const lootPage = await openPage({ seed: battleSeed, random: 0 });
  await expect(lootPage.locator('.floating-effect.loot')).toHaveCount(2);
  await expect.poll(async () => (await readSave(lootPage)).stats.kills).toBe(1);
  const lootSave = await readSave(lootPage);
  assert.equal(lootSave.items.slime_gel, 5);
  assert.equal(lootSave.items.forest_seed, 1);
  assert.equal(lootSave.monsters.length, 0);
  assert.equal(lootSave.portals.length, 0);
  assert.deepEqual(lootSave.inventory, battleSeed.inventory, 'Item drops do not consume dungeon cores');
  await lootPage.locator('[data-tab="inventory"]').click();
  await expect(lootPage.locator('#inventory-empty')).toBeHidden();
  await expect(lootPage.locator('#item-grid [data-item]')).toHaveCount(2);
  await expect(lootPage.locator('[data-item="slime_gel"] .item-quantity')).toHaveText('× 5');
  await expect(lootPage.locator('[data-item="forest_seed"] .item-quantity')).toHaveText('× 1');
  await expect(lootPage.locator('#item-count')).toHaveText('6');
  await lootPage.locator('[data-item="slime_gel"]').click();
  await expect(lootPage.locator('#modal')).toBeVisible();
  await expect(lootPage.locator('#modal')).toContainText('슬라임 젤리');
  await expect(lootPage.locator('#modal')).toContainText('60%');
  await lootPage.locator('#close-modal').click();
  await lootPage.locator('[data-item="forest_seed"]').click();
  await expect(lootPage.locator('#modal')).toContainText('숲의 씨앗');
  await expect(lootPage.locator('#modal')).toContainText('10%');
  await lootPage.locator('#close-modal').click();
  await lootPage.reload();
  await lootPage.locator('[data-tab="inventory"]').click();
  assert.deepEqual((await readSave(lootPage)).items, lootSave.items, 'Reload does not reroll or duplicate defeated-monster loot');
  assert.equal((await readSave(lootPage)).stats.kills, 1);
  await expect(lootPage.locator('[data-item="slime_gel"] .item-quantity')).toHaveText('× 5');
  await lootPage.screenshot({ path: resolve(output, 'warehouse-desktop.png'), animations: 'disabled' });
  await lootPage.setViewportSize({ width: 390, height: 844 });
  await expect(lootPage.locator('[data-tab="inventory"]')).toBeVisible();
  await inViewport(lootPage, '[data-tab="inventory"]');
  for (const tab of ['cores', 'companions', 'inventory', 'care', 'journal']) await inViewport(lootPage, `[data-tab="${tab}"]`);
  assert.equal(await lootPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Five bag tabs fit the narrow viewport');
  await expect(lootPage.locator('#tab-inventory')).toBeVisible();
  await lootPage.screenshot({ path: resolve(output, 'warehouse-mobile.png'), animations: 'disabled' });
  await lootPage.locator('#minimize-button').click();
  await expect(lootPage.locator('#tab-inventory')).toBeHidden();
  await lootPage.locator('#launcher').click();
  await expect(lootPage.locator('#tab-inventory')).toBeVisible();
  await lootPage.close();
  console.log('✓ Actual monster death drops and auto-collects material stacks; warehouse details, persistence, mobile tabs and minimize work');
  assert.deepEqual(errors, [], 'Scale and loot UI has no renderer errors or missing resources');
  console.log(`Scale and loot UI passed. Screenshots: ${output}/character-scale-mobile.png, warehouse-desktop.png, warehouse-mobile.png`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
