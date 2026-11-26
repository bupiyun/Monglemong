import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const url = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage test server did not start')), 10_000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Storage test server exited: ${code}`)); });
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/MongleMong preview: http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolveReady(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // Isolate storage tests from concurrent UI implementation and game saves.
  await page.route(`${url}/storage-test.html`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Sprite storage test</title>' }));
  await page.goto(`${url}/storage-test.html`);

  const first = await page.evaluate(async () => {
    const storage = await import('/src/sprite-storage.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const rejection = async (operation, expected) => {
      try { await operation(); } catch (error) {
        check(expected.test(error.message), `Unexpected error: ${error.message}`);
        return;
      }
      throw new Error('Expected rejection');
    };
    const canvas = document.createElement('canvas');
    canvas.width = 1536; canvas.height = 2400;
    const context = canvas.getContext('2d');
    context.fillStyle = '#9476b8'; context.fillRect(10, 10, 128, 128);
    const image = type => new Promise(resolve => canvas.toBlob(blob => resolve(new File([blob], `sheet.${type.slice(6)}`, { type })), type));
    const files = await Promise.all(['image/png', 'image/webp', 'image/jpeg'].map(image));
    for (const file of files) {
      const result = await storage.validateSpriteFile(file);
      check(result.width === 1536 && result.height === 2400, 'Decoded dimensions differ');
      check(result.fileName === file.name, 'Original filename was not retained');
      check(result.blob.size === file.size, 'Original bytes were transformed');
    }
    await rejection(() => storage.validateSpriteFile(new Blob()), /빈 파일/);
    await rejection(() => storage.validateSpriteFile(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)])), /20MiB/);
    await rejection(() => storage.validateSpriteFile(new File(['<svg width="1536" height="2400"></svg>'], 'spoof.png', { type: 'image/png' })), /PNG, WebP 또는 JPEG/);
    await rejection(() => storage.validateSpriteFile(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })), /손상/);
    canvas.width = 1536; canvas.height = 2399;
    await rejection(() => image('image/png').then(storage.validateSpriteFile), /1536 × 2400.*1536 × 2399/);
    const sheetId = `custom_${crypto.randomUUID()}`;
    await rejection(() => storage.putSpriteSheet('custom_invalid', files[0]), /식별자/);
    const normalized = await storage.validateSpriteFile(new File([files[0]], 'mislabeled.jpg', { type: 'application/octet-stream' }));
    check(normalized.blob.type === 'image/png', 'Verified MIME was not normalized');
    await storage.putSpriteSheet(sheetId, normalized.blob);
    const stored = await storage.getSpriteSheet(sheetId);
    const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
    const hash = await digest(files[0]);
    check(await digest(stored) === hash, 'Stored bytes differ from original upload');
    check(localStorage.length === 0, 'Image bytes must not use localStorage');

    const quotaId = `custom_${crypto.randomUUID()}`;
    const originalPut = IDBObjectStore.prototype.put;
    try {
      IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); };
      await rejection(() => storage.putSpriteSheet(quotaId, normalized.blob), /저장 공간이 부족/);
    } finally { IDBObjectStore.prototype.put = originalPut; }
    check(await storage.getSpriteSheet(quotaId) === null, 'Failed write persisted a record');

    const abortedId = `custom_${crypto.randomUUID()}`;
    try {
      IDBObjectStore.prototype.put = function (...args) {
        const request = originalPut.apply(this, args);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
      await rejection(() => storage.putSpriteSheet(abortedId, normalized.blob), /중단/);
    } finally { IDBObjectStore.prototype.put = originalPut; }
    check(await storage.getSpriteSheet(abortedId) === null, 'Request success was incorrectly treated as a committed write');
    await storage.putSpriteSheet(abortedId, normalized.blob);
    await storage.deleteSpriteSheet(abortedId);
    check(await storage.getSpriteSheet(abortedId) === null, 'Deletion was not committed');
    return { sheetId, hash };
  });

  await page.reload();
  const reloaded = await page.evaluate(async ({ sheetId }) => {
    const storage = await import('/src/sprite-storage.js');
    const blob = await storage.getSpriteSheet(sheetId);
    if (!blob) throw new Error('Uploaded image did not survive page reload');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
    await storage.validateSpriteFile(blob);
    await storage.deleteSpriteSheet(sheetId);
    const removed = await storage.getSpriteSheet(sheetId) === null;
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('mori-sprite-sheets');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Storage operations left an open database connection'));
    });
    const originalCreateStore = IDBDatabase.prototype.createObjectStore;
    let schemaError;
    try {
      IDBDatabase.prototype.createObjectStore = function () { throw new DOMException('Test schema quota', 'QuotaExceededError'); };
      try { await storage.getSpriteSheet(sheetId); } catch (error) { schemaError = error.message; }
    } finally { IDBDatabase.prototype.createObjectStore = originalCreateStore; }
    if (!schemaError?.includes('저장 공간이 부족')) throw new Error(`Schema failure was not reported: ${schemaError}`);
    if (await storage.getSpriteSheet(sheetId) !== null) throw new Error('Store did not recover after schema failure');
    return { hash, removed, localKeys: localStorage.length };
  }, first);
  assert.equal(reloaded.hash, first.hash);
  assert.equal(reloaded.removed, true);
  assert.equal(reloaded.localKeys, 0);
  assert.deepEqual(pageErrors, []);
  console.log('Sprite storage checks passed: real image decoding, size/format/dimension validation, original bytes, reload persistence, quota/abort rollback, deletion, no localStorage image data.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
