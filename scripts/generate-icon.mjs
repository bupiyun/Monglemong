/** Package the existing MongleMong application branding into a multi-resolution ICO. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'build');
const brandPng = (await readFile(resolve(output, 'icon.png'))).toString('base64');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : process.platform === 'linux' ? { executablePath: '/usr/bin/chromium' } : {}),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });

function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><image href="data:image/png;base64,${brandPng}" width="512" height="512"/></svg>`;
}

async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}svg{display:block}</style>${iconSvg(size)}`);
  return page.screenshot({ omitBackground: true });
}
try {
  const png = await render(512);
  await writeFile(resolve(output, 'icon.png'), png);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push(await render(size));
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    directory[entry] = sizes[i] === 256 ? 0 : sizes[i];
    directory[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  const ico = Buffer.concat([directory, ...images]);
  await writeFile(resolve(output, 'icon.ico'), ico);
  // Check both the ICO directory and every embedded PNG's signature/dimensions.
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(pngSignature) || png.readUInt32BE(16) !== 512) throw new Error('Invalid icon.png');
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== sizes.length) throw new Error('Invalid ICO header');
  images.forEach((_, i) => {
    const entry = 6 + i * 16;
    const start = ico.readUInt32LE(entry + 12);
    const length = ico.readUInt32LE(entry + 8);
    const image = ico.subarray(start, start + length);
    if (!image.subarray(0, 8).equals(pngSignature)
      || image.readUInt32BE(16) !== sizes[i] || image.readUInt32BE(20) !== sizes[i]
      || start + length > ico.length) throw new Error(`Invalid ICO frame ${sizes[i]}`);
  });
  console.log(`Created build/icon.png (512×512) and build/icon.ico (${sizes.join(', ')}px; ${ico.length} bytes).`);
} finally { await browser.close(); }
