import { existsSync } from 'node:fs';
import { join } from 'node:path';

let generatedSheet;
let announced = false;

/** Exercise bundled rendering without inventing or shipping the missing artwork. */
export async function installBundledSheetFixture(page, projectRoot) {
  if (existsSync(join(projectRoot, 'assets', 'characters', 'cafemong.png'))) return false;
  if (!announced) {
    console.log('QA substitution: bundled Cafemong artwork is unavailable; tests use a generated 80-cell fixture. Original artwork is NOT verified.');
    announced = true;
  }
  if (!generatedSheet) {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1536; canvas.height = 2400;
      const context = canvas.getContext('2d');
      for (let row = 0; row < 10; row++) {
        for (let frame = 0; frame < 8; frame++) {
          const x = frame * 192, y = row * 240;
          context.fillStyle = `hsl(${row * 36} 55% ${35 + frame * 4}%)`;
          context.fillRect(x + 22, y + 20, 148, 200);
          context.strokeStyle = '#fff'; context.lineWidth = 6;
          context.strokeRect(x + 28, y + 26, 136, 188);
          context.fillStyle = '#fff'; context.font = 'bold 18px sans-serif';
          context.fillText(`QA R${row + 1} F${frame + 1}`, x + 36, y + 61);
        }
      }
      return canvas.toDataURL('image/png').split(',')[1];
    });
    generatedSheet = Buffer.from(png, 'base64');
  }
  await page.route('**/assets/characters/cafemong.png', route => route.fulfill({
    status: 200, contentType: 'image/png', body: generatedSheet,
  }));
  return true;
}
