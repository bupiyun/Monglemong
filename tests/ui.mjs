import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installBundledSheetFixture } from './bundled-sheet-fixture.mjs';
import { installOfflineRuntime } from './offline-runtime-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3011';
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3011' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
const errors = [];

async function readSave(page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    return JSON.parse(localStorage.getItem('mori.game.v1'));
  });
}

async function dragTo(page, locator, x, y) {
  const rect = await locator.boundingBox();
  assert.ok(rect, 'Drag source must be visible');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

// The companion wanders before the rest command. With the default 2× size,
// fixed coordinates can land on its interactive rectangle instead of the floor.
// Choose an actual unoccupied point and preserve the portal-spacing requirement.
async function emptyFloorX(page, y, preferredX) {
  const x = await page.evaluate(({ y, preferredX }) => {
    const zone = document.querySelector('#drop-zone').getBoundingClientRect();
    const portals = [...document.querySelectorAll('.portal')].map(node => {
      const rect = node.getBoundingClientRect(); return rect.x + rect.width / 2;
    });
    const candidates = [];
    for (let x = zone.left + 12; x <= zone.right - 12; x += 4) candidates.push(x);
    candidates.sort((a, b) => Math.abs(a - preferredX) - Math.abs(b - preferredX));
    return candidates.find(x => portals.every(center => Math.abs(center - x) >= 100)
      && document.elementFromPoint(x, y) && !document.elementFromPoint(x, y).closest('.interactive')) ?? null;
  }, { y, preferredX });
  assert.notEqual(x, null, 'An unoccupied floor point is available for click placement');
  return x;
}

function monitor(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
}

try {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Preview server did not become ready')), 10_000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview server exited (${code})`)); });
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
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  monitor(page);
  await installOfflineRuntime(page);
  await installBundledSheetFixture(page, root);
  await page.goto(url);
  await expect(page.locator('[data-core="grove"] .core-qty')).toHaveText('×2');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, 'preview.png') });

  // Holding a core must consume it only after a valid drop, exactly once.
  await page.locator('[data-command="rest"]').click();
  const grove = () => page.locator('[data-core="grove"]');
  const placeX = 820;
  await grove().click();
  const zone = await page.locator('#drop-zone').boundingBox();
  const floorY = zone.y + zone.height * 0.65;
  await page.keyboard.press('Escape');
  await dragTo(page, grove(), placeX, floorY);
  await expect(page.locator('.portal')).toHaveCount(1);
  await expect(grove().locator('.core-qty')).toHaveText('×1');
  await expect.poll(async () => (await readSave(page)).portals.length).toBe(1);
  await expect.poll(() => page.locator('.monster').count(), { timeout: 7000 }).toBeGreaterThan(0);
  await page.screenshot({ path: resolve(output, 'gameplay.png') });

  await dragTo(page, grove(), placeX, floorY);
  await expect(page.locator('.portal')).toHaveCount(1);
  await expect(grove().locator('.core-qty')).toHaveText('×1');
  await expect(page.locator('#toast')).toContainText('떨어진 곳');
  await page.keyboard.press('Escape');
  await grove().click();
  await page.mouse.click(await emptyFloorX(page, floorY, 650), floorY);
  await expect(page.locator('.portal')).toHaveCount(2);
  await expect(grove().locator('.core-qty')).toHaveText('×0');
  console.log('✓ Core drag, click placement and rejected-drop accounting');

  await page.locator('#minimize-button').click();
  await expect(page.locator('#dock')).toBeHidden();
  await expect(page.locator('#companion-card')).toBeHidden();
  await page.locator('#launcher').click();
  await expect(page.locator('#dock')).toBeVisible();
  await expect(page.locator('#companion-card')).toBeVisible();
  const oldDock = await page.locator('#dock').boundingBox();
  const handle = await page.locator('#dock-handle').boundingBox();
  await page.mouse.move(handle.x + 100, handle.y + 25);
  await page.mouse.down();
  await page.mouse.move(handle.x + 30, handle.y + 55, { steps: 10 });
  await page.mouse.up();
  const movedDock = await page.locator('#dock').boundingBox();
  assert.ok(movedDock.x < oldDock.x - 50, 'Menu should follow a drag');
  console.log('✓ Menu minimize, reopen and drag');

  const characterBefore = (await readSave(page)).character.x;
  await dragTo(page, page.locator('#character'), 350, floorY - 35);
  const characterAfter = (await readSave(page)).character.x;
  assert.ok(Math.abs(characterAfter - characterBefore) > 100, 'Character should move after a drag');
  assert.ok(Math.abs(characterAfter - 350) < 5);
  await page.locator('#character').click();
  await expect(page.locator('#character-menu')).toBeVisible();
  await page.locator('#pet-action').click();
  assert.equal((await readSave(page)).character.bond, 1);
  await page.locator('#talk-action').click();
  await page.locator('#talk-input').fill('카페몽 안녕');
  await page.locator('#talk-form button').click();
  await expect(page.locator('#talk-reply')).toContainText('안녕!');
  await page.locator('#close-modal').click();
  await page.locator('[data-command="fight"]').click();
  assert.equal((await readSave(page)).character.command, 'fight');
  await page.locator('[data-command="rest"]').click();
  assert.equal((await readSave(page)).character.command, 'rest');
  console.log('✓ Character drag, petting, conversation and commands');

  await page.locator('[data-tab="care"]').click();
  const goldBefore = (await readSave(page)).gold;
  await page.locator('#care-feed').click();
  const fed = await readSave(page);
  assert.equal(fed.gold, goldBefore - 10);
  assert.ok(fed.character.hunger > 99);
  await page.locator('#daily-button').click();
  const gift = await readSave(page);
  assert.equal(gift.gold, fed.gold + 40);
  assert.equal(gift.inventory.grove, fed.inventory.grove + 1);
  await page.locator('#daily-button').click();
  assert.equal((await readSave(page)).gold, gift.gold);
  await page.locator('[data-tab="cores"]').click();
  await page.locator('#shop-button').click();
  await page.locator('[data-buy="mushroom"]').click();
  const purchased = await readSave(page);
  assert.equal(purchased.inventory.mushroom, 1);
  assert.equal(purchased.gold, gift.gold - 80);
  await page.locator('[data-buy="crystal"]').click();
  assert.equal((await readSave(page)).gold, purchased.gold);
  await expect(page.locator('#toast')).toContainText('140골드');
  await page.locator('#close-modal').click();
  console.log('✓ Feeding, daily gift uniqueness and shop accounting');

  const persisted = await readSave(page);
  await page.reload();
  await expect(page.locator('#gold-text')).toHaveText(String(persisted.gold));
  await expect(page.locator('[data-core="mushroom"] .core-qty')).toHaveText('×1');
  await expect(page.locator('[data-command="rest"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.portal')).toHaveCount(persisted.portals.length);
  assert.equal((await readSave(page)).character.bond, persisted.character.bond);
  await page.locator('#pause-button').click();
  const paused = await readSave(page);
  await page.evaluate(() => new Promise(resolveFrames => {
    let count = 0;
    const next = () => ++count === 15 ? resolveFrames() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }));
  const stillPaused = await readSave(page);
  assert.equal(stillPaused.elapsed, paused.elapsed);
  assert.equal(stillPaused.character.hunger, paused.character.hunger);
  await page.locator('#resume-button').click();
  await expect.poll(async () => (await readSave(page)).elapsed).toBeGreaterThan(paused.elapsed);
  console.log('✓ Persistence, pause freeze and resume');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  monitor(mobile);
  await installOfflineRuntime(mobile);
  await installBundledSheetFixture(mobile, root);
  await mobile.goto(url);
  await expect(mobile.locator('#dock')).toBeVisible();
  const mobileDock = await mobile.locator('#dock').boundingBox();
  assert.ok(mobileDock.x >= 0 && mobileDock.x + mobileDock.width <= 390, 'Mobile menu should fit the screen');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.locator('[data-tab="care"]').click();
  await mobile.locator('#care-rest').click();
  await mobile.locator('[data-tab="cores"]').click();
  await mobile.locator('#minimize-button').click();
  await expect(mobile.locator('#companion-card')).toBeHidden();
  await mobile.locator('#launcher').click();
  await mobile.locator('[data-core="grove"]').click();
  const mobileZone = await mobile.locator('#drop-zone').boundingBox();
  await mobile.locator('#minimize-button').click();
  const mobileFloorY = mobileZone.y + mobileZone.height - 10;
  await mobile.mouse.click(await emptyFloorX(mobile, mobileFloorY, 250), mobileFloorY);
  await expect(mobile.locator('.portal')).toHaveCount(1);
  await expect(mobile.locator('#dock')).toBeHidden();
  await mobile.locator('#launcher').click();
  const touchCard = await mobile.locator('[data-core="grove"]').boundingBox();
  const client = await mobile.context().newCDPSession(mobile);
  const held = { x: 30, y: mobileZone.y + mobileZone.height - 10, id: 1 };
  const secondary = { x: 350, y: 80, id: 2 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchCard.x + 40, y: touchCard.y + 35, id: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [held] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [held, secondary] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [secondary] });
  await expect(mobile.locator('.portal')).toHaveCount(1);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(mobile.locator('.portal')).toHaveCount(2);
  assert.equal((await readSave(mobile)).inventory.grove, 0);
  await client.detach();
  console.log('✓ Narrow-screen controls and placement');

  assert.deepEqual(errors, [], 'The UI must not raise page errors or missing-asset responses');
  console.log(`UI checks passed. Screenshots: ${output}/preview.png and ${output}/gameplay.png`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
