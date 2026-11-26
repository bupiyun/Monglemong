import { FOOD_GROUPS, TASTES } from './characters.js';

export const STAT_FIELDS = Object.freeze([
  { key: 'hp', label: '체력', base: 100, growth: 16, min: 1, max: 9999, growthMax: 999 },
  { key: 'mana', label: '마나', base: 30, growth: 5, min: 0, max: 9999, growthMax: 999 },
  { key: 'attack', label: '공격', base: 8, growth: 3, min: 0, max: 9999, growthMax: 999 },
  { key: 'defense', label: '방어', base: 3, growth: 1, min: 0, max: 9999, growthMax: 999 },
  { key: 'magic', label: '마력', base: 5, growth: 2, min: 0, max: 9999, growthMax: 999 },
  { key: 'resistance', label: '저항력', base: 3, growth: 1, min: 0, max: 9999, growthMax: 999 },
  { key: 'speed', label: '속도', base: 10, growth: 0.25, min: 1, max: 100, growthMax: 10 },
].map(Object.freeze));

export const ANIMATION_KEYS = Object.freeze([
  'idle', 'walk', 'pet', 'doze', 'sleep', 'battleIdle', 'battleRun', 'attack', 'strongAttack', 'collapse',
]);

export const SPRITE_SHEET = Object.freeze({ width: 1536, height: 2400, columns: 8, rows: 10, frameWidth: 192, frameHeight: 240 });
export const MAX_CUSTOM_CHARACTERS = 100;

const UUID = /^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const foodIds = new Set(FOOD_GROUPS.map(group => group.id));
const tasteIds = new Set(TASTES.map(taste => taste.id));
const failure = message => ({ ok: false, message, definition: null });
const plainText = value => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '') : '';

/** Validate metadata only. The caller validates and stores the actual 1536×2400 image separately. */
export function validateCustomDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('캐릭터 정보를 확인해 주세요.');
  // A separate sheet revision lets the caller commit replacement artwork before
  // switching saved metadata, while keeping the companion's stable identity.
  if (typeof input.id !== 'string' || !UUID.test(input.id) || typeof input.sheetId !== 'string' || !UUID.test(input.sheetId)) return failure('캐릭터와 스프라이트 시트의 식별자가 올바르지 않아요.');
  const name = plainText(input.name);
  const title = plainText(input.title) || '직접 만든 작은 친구';
  const personality = plainText(input.personality) || '함께 모험하며 알아갈 새로운 친구예요.';
  if (!name || name.length > 24) return failure('이름은 1~24자로 입력해 주세요.');
  if (title.length > 60) return failure('소개는 60자 이내로 입력해 주세요.');
  if (personality.length > 200) return failure('성격은 200자 이내로 입력해 주세요.');
  if (!foodIds.has(input.foodPreference)) return failure('좋아하는 음식군을 하나 선택해 주세요.');
  const tastes = input.tastePreferences ?? [];
  if (!Array.isArray(tastes) || tastes.length > 2 || new Set(tastes).size !== tastes.length || tastes.some(taste => !tasteIds.has(taste))) return failure('좋아하는 맛은 서로 다르게 최대 2개까지 선택할 수 있어요.');
  const baseStats = {}, growthStats = {};
  for (const field of STAT_FIELDS) {
    const base = input.baseStats?.[field.key];
    const growth = input.growthStats?.[field.key];
    if (!Number.isInteger(base) || base < field.min || base > field.max) return failure(`${field.label} 기본값은 ${field.min}~${field.max}의 정수로 입력해 주세요.`);
    if (typeof growth !== 'number' || !Number.isFinite(growth) || growth < 0 || growth > field.growthMax || Math.abs(growth * 100 - Math.round(growth * 100)) > 0.000001) return failure(`${field.label} 성장값은 0~${field.growthMax}, 소수점 둘째 자리까지 입력할 수 있어요.`);
    baseStats[field.key] = base;
    growthStats[field.key] = Math.round(growth * 100) / 100;
  }
  // Explicit projection prevents saved metadata from introducing URLs, data URIs, or image payloads.
  return { ok: true, message: '캐릭터 설정을 확인했어요.', definition: {
    id: input.id, sheetId: input.sheetId, custom: true, name, title, personality,
    foodPreference: input.foodPreference, tastePreferences: [...tastes], baseStats, growthStats,
    sprite: 'assets/character-placeholder.svg', restSprite: 'assets/character-placeholder.svg',
  } };
}
