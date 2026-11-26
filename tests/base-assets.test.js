import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBaseAssets } from '../scripts/check-base-assets.mjs';

// Header-only unit fixture; not production artwork or a decode/render test.
function pngHeader(width = 1536, height = 2400) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mori-base-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assetDirectory = join(root, 'assets', 'characters');
  mkdirSync(assetDirectory, { recursive: true });
  return { root, sheet: join(assetDirectory, 'cafemong.png') };
}

test('accepts a bundled PNG with the required dimensions', t => {
  const { root, sheet } = setup(t);
  writeFileSync(sheet, pngHeader());
  assert.doesNotThrow(() => checkBaseAssets(root));
});

test('rejects wrong dimensions or non-PNG bundled assets', t => {
  const { root, sheet } = setup(t);
  for (const bytes of [pngHeader(1280, 2000), Buffer.from('not png')]) {
    writeFileSync(sheet, bytes);
    assert.throws(() => checkBaseAssets(root), /PNG/);
  }
});

test('missing bundled original stops validation without creating substitute artwork', t => {
  const { root, sheet } = setup(t);
  assert.throws(() => checkBaseAssets(root), /원본 시트가 없습니다/);
  assert.equal(existsSync(sheet), false);
});
