import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARACTER_TYPES } from '../src/characters.js';

export function validateSpritePng(bytes, name = '카페몽') {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`${name} 시트는 PNG 파일이어야 합니다.`);
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== 1536 || height !== 2400) {
    throw new Error(`${name} 시트는 1536 × 2400 PNG여야 합니다. 현재 크기: ${width} × ${height}. 원본을 사용해 주세요.`);
  }
}

export function checkBaseAssets(root = resolve(import.meta.dirname, '..')) {
  for (const character of CHARACTER_TYPES) {
    if (!character.spriteSheet) continue;
    const file = resolve(root, character.spriteSheet);
    const location = relative(root, file);
    if (location.startsWith('..' + sep) || location === '..') throw new Error('기본 캐릭터 시트는 프로젝트 안에 있어야 합니다.');
    let bytes;
    try { bytes = readFileSync(file); }
    catch { throw new Error(`${character.name} 원본 시트가 없습니다: ${character.spriteSheet}\n1536 × 2400 PNG 원본을 이 위치에 넣은 뒤 다시 실행하세요.`); }
    validateSpritePng(bytes, character.name);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkBaseAssets(); console.log('기본 캐릭터 시트 확인 완료.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
