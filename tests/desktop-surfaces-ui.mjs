import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installOfflineRuntime } from './offline-runtime-fixture.mjs';

// Geometry/IPC integration runs in Chromium with a mock desktop bridge. The
// actual Win32 enumerator still needs a Windows machine for end-to-end testing.
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'test-results');
const url = 'http://127.0.0.1:3018';
const saveKey = 'mori.game.v1';
const errors = [];
const floor = { id: 'desktop-floor', kind: 'taskbar', x: 0, y: 900, width: 1280 };
const ledge = { id: 'window:1:0', kind: 'window', x: 100, y: 440, width: 650 };
const initialSnapshot = { supported: true, status: 'ready', width: 1280, height: 900, surfaces: [floor, ledge] };
let browser;
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '3018' }, stdio: ['ignore', 'pipe', 'pipe'],
});

async function openPage({ desktop = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installOfflineRuntime(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(url) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(({ key, native, snapshot }) => {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({
        version: 3, activeCharacterId: 'cafemong', settings: { characterScale: 2 },
        character: { id: 'cafemong', level: 1, command: 'wander', x: 400, hp: 130, mana: 30 },
        characters: [{ id: 'cafemong', level: 1, command: 'wander', x: 400, hp: 130, mana: 30 }],
      }));
    }
    if (!native) return;
    window.__desktopRegions = [];
    window.__surfaceSnapshot = snapshot;
    window.__publishSurfaces = next => {
      window.__surfaceSnapshot = next;
      window.__surfaceListener?.(next);
    };
    window.desktop = {
      isDesktop: true,
      setInteractiveRegions: regions => { window.__desktopRegions = regions; },
      setMouseCapture: value => { window.__mouseCaptured = value; },
      setSceneMode: value => { window.__sceneMode = value; },
      onToggleMenu: callback => { window.__toggleMenu = callback; return () => {}; },
      onSurfaces: callback => {
        window.__surfaceListener = callback;
        return () => { window.__surfaceListener = null; };
      },
      requestSurfaces: () => { window.__surfaceListener?.(window.__surfaceSnapshot); },
      quit: () => {},
    };
  }, { key: saveKey, native: desktop, snapshot: initialSnapshot });
  await page.goto(url);
  await expect(page.locator('#settings-button')).toBeVisible();
  await expect(page.locator('#character-sprite')).toHaveAttribute('data-sprite-sheet', 'assets/characters/cafemong.png');
  return page;
}

async function pose(page) {
  return page.locator('#character').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, footY: Number(node.dataset.footY),
      id: node.dataset.surfaceId, kind: node.dataset.surfaceKind, left: rect.left, right: rect.right };
  });
}

async function publish(page, surfaces, extra = {}) {
  await page.evaluate(snapshot => window.__publishSurfaces(snapshot), { ...initialSnapshot, ...extra, surfaces });
}

async function showSettings(page) {
  if (await page.locator('#dock').isHidden()) await page.locator('#launcher').click();
  await page.locator('#settings-button').click();
  await expect(page.locator('#settings-general')).toBeVisible();
}

async function pause(page, value) {
  await showSettings(page);
  const button = page.locator('#setting-pause');
  if ((await button.textContent()).trim() !== (value ? '계속하기' : '일시 정지')) await button.click();
  await page.locator('#close-modal').click();
  await page.locator('#minimize-button').click();
}

async function dragTo(page, x, footY, { inspectDuring = false } = {}) {
  const before = await pose(page);
  const rect = await page.locator('#character').boundingBox();
  const start = { x: rect.x + rect.width / 2, y: Math.min(850, rect.y + rect.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  if (inspectDuring) await expect.poll(() => page.evaluate(() => window.__mouseCaptured)).toBe(true);
  await page.mouse.move(start.x + x - before.x, start.y + footY - before.footY, { steps: 12 });
  if (inspectDuring) {
    const during = await pose(page);
    assert.ok(Math.abs(during.x - x) < 2, 'Dragging updates the horizontal position before release');
    assert.ok(Math.abs(during.footY - footY) < 2, 'Dragging updates the vertical position before release');
  }
  await page.mouse.up();
  if (inspectDuring) await expect.poll(() => page.evaluate(() => window.__mouseCaptured)).toBe(false);
}

async function assertFootContact(page, expectedY) {
  // Inspect the authored frame alpha rather than confusing transparent sheet
  // padding or the character-name box with the character's visible feet.
  const actualY = await page.locator('#character-sprite').evaluate(async node => {
    const image = new Image();
    image.src = node.dataset.spriteSheet;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 240;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, Number(node.dataset.spriteFrame) * 192, Number(node.dataset.spriteRow) * 240, 192, 240, 0, 0, 192, 240);
    const pixels = ctx.getImageData(0, 0, 192, 240).data;
    let bottom = -1;
    for (let y = 239; y >= 0 && bottom < 0; y--) {
      for (let x = 0; x < 192; x++) if (pixels[(y * 192 + x) * 4 + 3] >= 32) { bottom = y; break; }
    }
    const box = node.getBoundingClientRect();
    return box.top + (bottom + 1) * box.height / 240;
  });
  assert.ok(Math.abs(actualY - expectedY) <= 1.5, `Visible sprite foot ${actualY} meets surface ${expectedY}`);
}

try {
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop surfaces preview did not become ready')), 10_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Desktop surfaces server exited (${code})`)); });
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

  const page = await openPage();
  await expect(page.locator('body')).toHaveClass(/surface-mode/);
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', 'desktop-floor');
  await expect(page.locator('#character')).toHaveAttribute('data-surface-kind', 'taskbar');
  await pause(page, true);
  await assertFootContact(page, 900);
  await dragTo(page, 380, 440, { inspectDuring: true });
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', ledge.id);
  assert.equal((await pose(page)).footY, 440);
  await assertFootContact(page, 440);
  const stopped = await pose(page);
  await page.waitForTimeout(300);
  assert.deepEqual(await pose(page), stopped, 'Paused simulation holds the companion on its ledge');

  await publish(page, [floor, { ...ledge, x: 140, y: 380, width: 680 }]);
  await expect.poll(async () => (await pose(page)).footY).toBe(380);
  assert.ok(Math.abs((await pose(page)).x - stopped.x - 40) < 1, 'A moving window carries its companion');
  await publish(page, [floor, { ...ledge, x: 140, y: 380, width: 320 }]);
  await expect.poll(async () => (await pose(page)).x).toBeLessThanOrEqual(364);
  assert.ok((await pose(page)).x >= 236, 'Window resize clamps the full character onto its remaining ledge');
  await assertFootContact(page, 380);
  console.log('✓ Native snapshots place visible feet on taskbar/window edges; free dragging, capture, pause, move and resize work');

  await pause(page, false);
  const walkingX = (await pose(page)).x;
  await expect.poll(async () => Math.abs((await pose(page)).x - walkingX)).toBeGreaterThan(4);
  await expect(page.locator('#character-sprite')).toHaveAttribute('data-sprite-animation', 'walk');
  await publish(page, [floor]);
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', 'desktop-floor');
  assert.equal((await pose(page)).footY, 900);
  await publish(page, [floor, ledge]);
  await dragTo(page, 400, 440);
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', ledge.id);
  await page.locator('#character').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#character-menu')).toBeVisible();
  const menu = await page.locator('#character-menu').boundingBox();
  assert.ok(menu.y >= 0 && menu.y + menu.height <= 900, 'The interaction menu remains visible above a window ledge');
  await page.locator('#adventure-action').click();
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', 'desktop-floor');
  await expect.poll(async () => (await pose(page)).footY).toBe(900);
  console.log('✓ Companions walk on frames, fall when the frame closes, and return to the ground for combat');

  await page.locator('#launcher').click();
  await page.locator('[data-command="wander"]').click();
  await page.locator('#minimize-button').click();
  await pause(page, true);
  await dragTo(page, 400, 440);
  await showSettings(page);
  await expect(page.locator('#window-walking-toggle')).toBeChecked();
  await page.locator('#window-walking-toggle').uncheck();
  await expect(page.locator('body')).not.toHaveClass(/surface-mode/);
  const saved = await page.evaluate(key => {
    window.dispatchEvent(new Event('blur'));
    return JSON.parse(localStorage.getItem(key));
  }, saveKey);
  assert.equal(saved.settings.windowWalking, false);
  await page.reload();
  await expect(page.locator('body')).not.toHaveClass(/surface-mode/);
  await showSettings(page);
  await expect(page.locator('#window-walking-toggle')).not.toBeChecked();
  await page.locator('#window-walking-toggle').check();
  await expect(page.locator('body')).toHaveClass(/surface-mode/);
  await page.locator('#setting-scene').click();
  await expect(page.locator('body')).not.toHaveClass(/surface-mode/);
  await page.locator('#setting-scene').click();
  await expect(page.locator('body')).toHaveClass(/surface-mode/);
  await page.locator('[data-character-scale="3"]').click();
  await page.locator('#close-modal').click();
  await page.locator('#minimize-button').click();
  await pause(page, true);
  await dragTo(page, 400, 440);
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', ledge.id);
  await assertFootContact(page, 440);
  await expect.poll(() => page.evaluate(() => {
    const rect = document.querySelector('#character').getBoundingClientRect();
    return window.__desktopRegions.some(region => region.x <= rect.x + 1 && region.y <= rect.y + 1
      && region.x + region.width >= rect.right - 1 && region.y + region.height >= Math.min(rect.bottom, innerHeight) - 1);
  })).toBe(true);
  await page.screenshot({ path: resolve(output, 'desktop-window-walking.png'), animations: 'disabled' });
  await publish(page, [], { status: 'unavailable' });
  await expect(page.locator('#character')).toHaveAttribute('data-surface-id', 'desktop-floor');
  await publish(page, [], { supported: false, status: 'unavailable' });
  await expect(page.locator('body')).not.toHaveClass(/surface-mode/);
  await page.close();
  console.log('✓ Window walking setting persists; meadow mode, 3× sprites, hit regions and unavailable native snapshots fall back safely');

  const fallback = await openPage({ desktop: false });
  await expect(fallback.locator('body')).not.toHaveClass(/surface-mode/);
  await showSettings(fallback);
  await expect(fallback.locator('#window-walking-toggle')).toBeChecked();
  await fallback.locator('#close-modal').click();
  await fallback.close();
  assert.deepEqual(errors, [], 'Desktop-surface UI has no renderer errors or missing resources');
  console.log('Desktop surface UI passed with mocked Windows geometry. Actual Win32 discovery was not executed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
