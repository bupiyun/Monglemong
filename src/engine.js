/**
 * MongleMong's dependency-free, mutable simulation. All times are seconds; x is CSS px.
 * stepGame mutates/returns state; actions return { ok, message }. Persist with
 * serializeGame (JSON string), restore with createGame(string | object).
 * No wall-clock catch-up: a simulation step is capped at 0.25 seconds.
 */
import { CHARACTER_TYPES, FOOD_GROUPS, TASTES, FOODS } from './characters.js';
export { CHARACTER_TYPES, FOOD_GROUPS, TASTES, FOODS };
import { STAT_FIELDS, ANIMATION_KEYS, SPRITE_SHEET, MAX_CUSTOM_CHARACTERS, validateCustomDefinition } from './custom-characters.js';
export { STAT_FIELDS, ANIMATION_KEYS, SPRITE_SHEET, validateCustomDefinition };
import { ITEM_TYPES, MONSTER_DROPS, MAX_ITEM_STACK } from './items.js';
export { ITEM_TYPES, MONSTER_DROPS, MAX_ITEM_STACK };

export const CORE_TYPES = Object.freeze([
  { id: 'grove', name: '새싹 숲 코어', description: '작은 슬라임이 사는 평화로운 숲', monsterName: '숲 슬라임', count: 3, level: 1, color: '#83ba87', price: 40 },
  { id: 'mushroom', name: '버섯 숲 코어', description: '장난꾸러기 버섯들의 비밀 정원', monsterName: '꼬마 버섯', count: 4, level: 3, color: '#d293aa', price: 80 },
  { id: 'crystal', name: '달빛 동굴 코어', description: '반짝이는 크리스탈 정령의 동굴', monsterName: '수정 정령', count: 5, level: 5, color: '#9a8ccc', price: 140 },
]);

const TYPES = new Map(CORE_TYPES.map(type => [type.id, type]));
const COMPANIONS = new Map(CHARACTER_TYPES.map(type => [type.id, type]));
// IDs only: removed prototype characters are recognized solely to migrate progress.
const RETIRED_CHARACTER_IDS = new Set(['lumi', 'bomi', 'nabi', 'hodu', 'sora', 'yul', 'mocha', 'byeol', 'sol']);
const FOOD_TYPES = new Map(FOODS.map(food => [food.id, food]));
const ITEMS = new Map(ITEM_TYPES.map(item => [item.id, item]));
const COMMANDS = new Set(['wander', 'fight', 'rest']);
export const MAX_DEPLOYED_COMPANIONS = 6;
export const MAX_WORLD_EXTENT = 65536;
const displayKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : 'primary';
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const number = (value, fallback, low, high) => typeof value === 'number' && Number.isFinite(value) ? clamp(value, low, high) : fallback;
const integer = (value, fallback, low, high) => Math.floor(number(value, fallback, low, high));
const nextXP = level => 40 + (level - 1) * 24;
const monsterHP = type => 12 + (type.level - 1) * 8;
const monsterAttack = type => 2 + (type.level - 1) * 2;
const id = (state, prefix) => `${prefix}${state.nextId++}`;
const result = (ok, message) => ({ ok, message });
const cleanText = value => String(value).replace(/[<>\u0000-\u001f]/g, '').slice(0, 200);
const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}\\d{1,10}$`).test(value) && Number(value.slice(1)) <= 1_000_000_000;
const particle = (word, consonant, vowel) => {
  const code = word.charCodeAt(word.length - 1);
  return word + (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? consonant : vowel);
};

function bounds(width) {
  const safeWidth = number(width, 1280, 1, MAX_WORLD_EXTENT);
  const margin = Math.min(38, safeWidth / 2);
  return { low: margin, high: safeWidth - margin };
}

/** Coordinates are local DIP within the union of attached displays. */
export function normalizeWorldDisplays(displays, width = 1280) {
  const normalized = [], seen = new Set();
  for (const value of Array.isArray(displays) ? displays.slice(0, 32) : []) {
    if (!value || !['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
      || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x >= MAX_WORLD_EXTENT || value.y >= MAX_WORLD_EXTENT) continue;
    const key = typeof value.id === 'number' ? String(value.id) : value.id;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(key) || seen.has(key)) continue;
    const x = value.x, y = value.y;
    const w = Math.min(value.width, MAX_WORLD_EXTENT - x), h = Math.min(value.height, MAX_WORLD_EXTENT - y);
    normalized.push({ id: key, x, y, width: w, height: h, floorY: number(value.floorY, y + h, y, y + h) });
    seen.add(key);
  }
  return normalized.length ? normalized : [{ id: 'primary', x: 0, y: 0, width: number(width, 1280, 1, MAX_WORLD_EXTENT), height: 1080, floorY: 1080 }];
}

function linkFocus(state) {
  state.character = state.characters.find(character => character.id === state.activeCharacterId) || state.characters[0];
  state.activeCharacterId = state.character.id;
  state.cooldowns = state.character.cooldowns;
  // Compatibility for older UI/consumers; the actual target is per companion.
  Object.defineProperty(state, 'wanderTarget', { configurable: true, enumerable: true,
    get() { return this.character.wanderTarget; }, set(value) { this.character.wanderTarget = value; } });
}

function ensureGroupState(state) {
  const priorTarget = state.wanderTarget;
  if (!Array.isArray(state.effects)) state.effects = [];
  for (const character of state.characters) {
    character.displayId = displayKey(character.displayId);
    if (!character.cooldowns) character.cooldowns = { pet: 0, feed: 0, attack: 0, wander: 0, hit: 0 };
    if (!Number.isFinite(character.animationTime)) resetAnimation(character);
    if (!Number.isFinite(character.restTime)) character.restTime = 0;
    if (!Number.isFinite(character.speechTime)) { character.speechTime = 0; character.speech = ''; }
    if (!Number.isFinite(character.wanderTarget)) character.wanderTarget = character.id === state.activeCharacterId && Number.isFinite(priorTarget) ? priorTarget : character.x;
  }
  state.deployedCharacterIds = [...new Set((Array.isArray(state.deployedCharacterIds) ? state.deployedCharacterIds : [state.activeCharacterId])
    .filter(key => state.characters.some(character => character.id === key)))].slice(0, MAX_DEPLOYED_COMPANIONS);
  if (!state.deployedCharacterIds.length) state.deployedCharacterIds = [state.characters[0].id];
  if (!state.deployedCharacterIds.includes(state.activeCharacterId)) state.activeCharacterId = state.deployedCharacterIds[0];
  if (!Array.isArray(state.worldDisplays)) state.worldDisplays = [];
  state.version = 4;
  linkFocus(state);
}

export function getDeployedCharacters(state) {
  const keys = Array.isArray(state.deployedCharacterIds) ? state.deployedCharacterIds : [state.activeCharacterId];
  return [...new Set(keys)].map(key => state.characters.find(character => character.id === key)).filter(Boolean).slice(0, MAX_DEPLOYED_COMPANIONS);
}

function regionFor(actor, displays) { return displays.find(display => display.id === actor.displayId) || displays[0]; }
function regionBounds(display, scale) {
  const local = scale === undefined ? bounds(display.width) : getCharacterBounds(display.width, scale);
  return { low: display.x + local.low, high: display.x + local.high };
}
function currentDisplays(state, width, options) {
  const saved = state.worldDisplays;
  const physicalLayout = saved?.length && (saved.length > 1 || saved[0].id !== 'primary');
  return normalizeWorldDisplays(options?.displays ?? (physicalLayout ? saved : undefined), width);
}
function applyWorldLayout(state, width, options = {}) {
  ensureGroupState(state);
  const displays = currentDisplays(state, width, options);
  const previous = state.worldDisplays;
  for (const actor of [...state.characters, ...state.portals, ...state.monsters, ...state.effects]) {
    const before = previous.find(display => display.id === actor.displayId);
    const same = displays.find(display => display.id === actor.displayId);
    const display = same || displays[0];
    const offset = before ? display.x - before.x : !same ? display.x : 0;
    actor.x += offset;
    if ('wanderTarget' in actor) actor.wanderTarget += offset;
    actor.displayId = display.id;
    const { low, high } = regionBounds(display, state.characters.includes(actor) ? state.settings.characterScale : undefined);
    actor.x = clamp(actor.x, low, high);
    if ('wanderTarget' in actor) actor.wanderTarget = clamp(actor.wanderTarget, low, high);
  }
  state.worldDisplays = displays;
  return displays;
}

export function setCharacterDeployed(state, characterId, deployed, width = 1280, options = {}) {
  ensureGroupState(state);
  const character = state.characters.find(item => item.id === characterId);
  if (!character || typeof deployed !== 'boolean') return result(false, '함께할 동료를 확인해 주세요.');
  const shown = state.deployedCharacterIds.includes(characterId);
  if (shown === deployed) return result(false, deployed ? '이미 화면에 함께하고 있어요.' : '이미 가방에서 쉬고 있어요.');
  if (!deployed) {
    if (state.deployedCharacterIds.length === 1) return result(false, '화면에는 최소 한 명의 동료가 함께해야 해요.');
    state.deployedCharacterIds = state.deployedCharacterIds.filter(key => key !== characterId);
    if (state.activeCharacterId === characterId) { state.activeCharacterId = state.deployedCharacterIds[0]; linkFocus(state); }
    return result(true, `${character.name}를 가방으로 돌려보냈어요. 성장 기록은 유지돼요.`);
  }
  if (state.deployedCharacterIds.length >= MAX_DEPLOYED_COMPANIONS) return result(false, `화면에는 ${MAX_DEPLOYED_COMPANIONS}명까지 함께할 수 있어요.`);
  const displays = currentDisplays(state, width, options);
  const display = options.displayId === undefined ? regionFor(state.character, displays) : displays.find(item => item.id === String(options.displayId));
  if (!display) return result(false, '사용할 수 있는 모니터를 선택해 주세요.');
  const { low, high } = regionBounds(display, state.settings.characterScale);
  const wanted = Number.isFinite(options.x) ? options.x : state.character.displayId === display.id ? state.character.x + 100 : display.x + display.width / 2;
  character.x = clamp(wanted, low, high);
  character.displayId = display.id;
  character.wanderTarget = character.x;
  character.cooldowns.wander = Math.max(character.cooldowns.wander, 1);
  state.deployedCharacterIds.push(characterId);
  state.worldDisplays = displays;
  return result(true, `${character.name}도 화면에서 함께 자라요.`);
}

export function moveCharacter(state, characterId, x, width = 1280, options = {}) {
  ensureGroupState(state);
  const character = state.characters.find(item => item.id === characterId);
  if (!character || !state.deployedCharacterIds.includes(characterId)) return result(false, '화면에 함께하는 동료만 옮길 수 있어요.');
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > MAX_WORLD_EXTENT) return result(false, '동료를 놓을 위치를 확인해 주세요.');
  const displays = currentDisplays(state, width, options);
  const display = options.displayId === undefined ? regionFor(character, displays) : displays.find(item => item.id === String(options.displayId));
  if (!display) return result(false, '사용할 수 있는 모니터를 선택해 주세요.');
  const { low, high } = regionBounds(display, state.settings.characterScale);
  character.x = clamp(x, low, high);
  character.displayId = display.id;
  character.wanderTarget = character.x;
  character.cooldowns.wander = 2;
  state.worldDisplays = displays;
  return result(true, `${character.name}를 옮겼어요.`);
}

/** Only display bounds change with scale; battle distances and stats stay fixed. */
export function getCharacterBounds(width = 1280, scale = 2) {
  const safeWidth = number(width, 1280, 1, MAX_WORLD_EXTENT);
  const selected = [1, 2, 3].includes(scale) ? scale : 2;
  const halfWidth = Math.min(48 * selected, safeWidth / 2);
  return { low: halfWidth, high: safeWidth - halfWidth };
}

export function setCharacterScale(state, scale, width = 1280, options = {}) {
  if (![1, 2, 3].includes(scale)) return result(false, '캐릭터 크기는 1배, 2배, 3배 중에서 선택해 주세요.');
  ensureGroupState(state);
  state.settings = { ...state.settings, characterScale: scale };
  const displays = currentDisplays(state, width, options);
  for (const character of state.characters) {
    const { low, high } = regionBounds(regionFor(character, displays), scale);
    character.x = clamp(character.x, low, high);
    character.wanderTarget = clamp(character.wanderTarget, low, high);
  }
  return result(true, `캐릭터 크기를 ${scale}배로 설정했어요.`);
}

export function setWindowWalking(state, enabled) {
  if (typeof enabled !== 'boolean') return result(false, '창 위 걷기 설정은 켜기 또는 끄기로 선택해 주세요.');
  state.settings = { ...state.settings, windowWalking: enabled };
  return result(true, `창 위 걷기를 ${enabled ? '켰어요' : '껐어요'}.`);
}

function say(state, text, duration = 4, character = state.character) {
  character.speech = text;
  character.speechTime = duration;
}

function log(state, text, kind = 'info') {
  state.logs.unshift({ id: id(state, 'l'), text, kind, time: Date.now() });
  state.logs = state.logs.slice(0, 35);
}

function effect(state, x, text, kind = 'info', itemId, lootIndex = 0, displayId = state.character.displayId) {
  state.effects.push({ id: id(state, 'e'), x, displayId: displayKey(displayId), text, kind, life: 1.4, ...(itemId ? { itemId, lootIndex } : {}) });
  if (state.effects.length > 30) state.effects.shift();
}

function characterType(state, characterId) {
  return COMPANIONS.get(characterId) || state.customDefinitions.find(type => type.id === characterId);
}

function setAnimation(character, animationState, duration = 0, restart = false) {
  if (character.animationState !== animationState || restart) character.animationTime = 0;
  character.animationState = animationState;
  character.animationTimer = duration;
  character.animationDuration = duration;
}

function resetAnimation(character) {
  character.restTime = 0;
  setAnimation(character, character.command === 'rest' ? 'doze' : character.command === 'fight' ? 'battleIdle' : 'idle', 0, true);
}

function settleAnimation(character) {
  if (character.animationTimer > 0 && ['pet', 'attack', 'strongAttack', 'collapse'].includes(character.animationState)) return;
  const animation = character.command === 'rest' ? (character.restTime < 3 ? 'doze' : 'sleep')
    : character.action === 'walk' ? (character.command === 'fight' ? 'battleRun' : 'walk')
    : character.command === 'fight' ? 'battleIdle' : 'idle';
  setAnimation(character, animation);
}

function characterStats(type, level) {
  const gain = level - 1;
  const values = Object.fromEntries(STAT_FIELDS.map(field => {
    const value = type.baseStats[field.key] + type.growthStats[field.key] * gain;
    // Authored fractional growth is real gameplay precision, not display-only.
    // Keep the established floor rule for administrator-created companions.
    const amount = type.statRounding === 'fractional' ? Math.round(value * 100) / 100 : Math.floor(value + 1e-9);
    return [field.key, amount];
  }));
  const { hp: maxHp, mana: maxMana, ...stats } = values;
  return { maxHp, maxMana, ...stats };
}

function createCharacter(type, saved = {}) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const level = integer(source.level, 1, 1, 50);
  const stats = characterStats(type, level);
  const cooldowns = { pet: 0, feed: 0, attack: 0, wander: 0, hit: 0 };
  for (const key of Object.keys(cooldowns)) cooldowns[key] = number(source.cooldowns?.[key], 0, 0, 10);
  return {
    id: type.id, name: type.name, title: type.title, personality: type.personality,
    foodPreference: type.foodPreference, tastePreferences: [...type.tastePreferences],
    sprite: type.sprite, restSprite: type.restSprite, ...(type.spriteSheet ? { spriteSheet: type.spriteSheet } : {}),
    ...(type.custom ? { custom: true, sheetId: type.sheetId } : {}),
    level, ...stats, nextXp: nextXP(level), xp: number(source.xp, 0, 0, nextXP(level) - 1),
    hp: number(source.hp, stats.maxHp, 1, stats.maxHp), mana: number(source.mana, stats.maxMana, 0, stats.maxMana),
    x: number(source.x, 280, 0, MAX_WORLD_EXTENT), displayId: displayKey(source.displayId),
    wanderTarget: number(source.wanderTarget, number(source.x, 280, 0, MAX_WORLD_EXTENT), 0, MAX_WORLD_EXTENT), hunger: number(source.hunger, 86, 0, 100),
    mood: number(source.mood, 92, 0, 100), bond: integer(source.bond, 0, 0, 100),
    command: COMMANDS.has(source.command) ? source.command : 'wander', facing: source.facing === -1 ? -1 : 1,
    animationState: source.command === 'rest' ? 'doze' : source.command === 'fight' ? 'battleIdle' : 'idle', animationTime: 0, animationTimer: 0, animationDuration: 0, restTime: 0,
    action: 'idle', speech: `안녕! 나는 ${type.name}야. 잘 부탁해!`, speechTime: 7,
    cooldowns, strikes: integer(source.strikes, 0, 0, 2),
  };
}

function unlockCompanions(state, announce = false) {
  for (const type of CHARACTER_TYPES) {
    if (state.stats.clears < type.unlockClears || state.characters.some(c => c.id === type.id)) continue;
    state.characters.push(createCharacter(type));
    if (announce) log(state, `새 친구 ${type.name} 등장! 동료 목록에서 함께할 친구를 바꿀 수 있어요.`, 'success');
  }
}

export function createCustomCharacter(state, input) {
  const checked = validateCustomDefinition(input);
  if (!checked.ok) return checked;
  const definition = checked.definition;
  if (state.customDefinitions.length >= MAX_CUSTOM_CHARACTERS) return result(false, `직접 만든 캐릭터는 ${MAX_CUSTOM_CHARACTERS}명까지 보관할 수 있어요.`);
  if (state.customDefinitions.some(type => type.id === definition.id) || state.characters.some(c => c.id === definition.id)) return result(false, '같은 식별자의 캐릭터가 이미 있어요.');
  if (state.customDefinitions.some(type => type.sheetId === definition.sheetId)) return result(false, '다른 캐릭터가 사용 중인 스프라이트 식별자예요. 이미지를 다시 저장해 주세요.');
  const character = createCharacter(definition);
  state.customDefinitions.push(definition);
  state.characters.push(character);
  log(state, `${definition.name} 생성 완료! 동료 목록에서 함께할 수 있어요.`, 'success');
  return { ...result(true, `${definition.name}를 동료 목록에 추가했어요.`), definition, character };
}

/** Update authoring fields without recreating the companion or its live progress. */
export function updateCustomCharacter(state, characterId, input) {
  const index = state.customDefinitions.findIndex(type => type.id === characterId);
  const character = state.characters.find(item => item.id === characterId);
  if (COMPANIONS.has(characterId) || index < 0 || !character?.custom) return result(false, '직접 만든 캐릭터만 수정할 수 있어요.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result(false, '수정할 캐릭터 정보를 확인해 주세요.');
  if (input.id !== undefined && input.id !== characterId) return result(false, '캐릭터 식별자는 변경할 수 없어요.');
  const previousDefinition = state.customDefinitions[index];
  const checked = validateCustomDefinition({ ...previousDefinition, ...input, id: characterId });
  if (!checked.ok) return checked;
  const definition = checked.definition;
  if (state.customDefinitions.some(type => type.id !== characterId && type.sheetId === definition.sheetId)) return result(false, '다른 캐릭터가 사용 중인 스프라이트 식별자예요. 이미지를 다시 저장해 주세요.');
  const stats = characterStats(definition, character.level);
  Object.assign(character, {
    name: definition.name, title: definition.title, personality: definition.personality,
    foodPreference: definition.foodPreference, tastePreferences: [...definition.tastePreferences],
    sprite: definition.sprite, restSprite: definition.restSprite, sheetId: definition.sheetId,
    ...stats, hp: Math.min(character.hp, stats.maxHp), mana: Math.min(character.mana, stats.maxMana),
  });
  state.customDefinitions[index] = definition;
  if (state.activeCharacterId === characterId) {
    state.character = character;
    state.cooldowns = character.cooldowns;
  }
  log(state, `${definition.name}의 정보를 수정했어요.`, 'info');
  return { ...result(true, `${definition.name}의 정보를 저장했어요.`), definition, previousDefinition, character };
}

/** Deleting an authored actor preserves every remaining companion's progress. */
export function deleteCustomCharacter(state, characterId) {
  ensureGroupState(state);
  const index = state.customDefinitions.findIndex(type => type.id === characterId);
  const character = state.characters.find(item => item.id === characterId);
  if (COMPANIONS.has(characterId) || index < 0 || !character?.custom) return result(false, '직접 만든 캐릭터만 삭제할 수 있어요.');
  const definition = state.customDefinitions[index];
  const active = state.activeCharacterId === characterId;
  const fallback = state.characters.find(item => item.id === CHARACTER_TYPES[0].id);
  if (!fallback) return result(false, '기본 캐릭터를 찾지 못했어요. 게임을 다시 열고 시도해 주세요.');
  state.customDefinitions.splice(index, 1);
  state.characters = state.characters.filter(item => item.id !== characterId);
  state.deployedCharacterIds = state.deployedCharacterIds.filter(key => key !== characterId);
  if (!state.deployedCharacterIds.length) {
    fallback.x = character.x;
    fallback.displayId = character.displayId;
    fallback.wanderTarget = character.x;
    state.deployedCharacterIds = [fallback.id];
  }
  if (active) state.activeCharacterId = state.deployedCharacterIds[0];
  linkFocus(state);
  log(state, `${definition.name}를 만든 캐릭터 목록에서 삭제했어요.`, 'info');
  return { ...result(true, `${definition.name}를 삭제했어요.${active ? ` ${particle(state.character.name, '과', '와')} 함께해요.` : ''}`), definition, character, activeCharacterId: state.activeCharacterId };
}

export function getNextCompanion(state) {
  return CHARACTER_TYPES.find(type => !state.characters.some(c => c.id === type.id)) || null;
}

export function selectCharacter(state, characterId) {
  ensureGroupState(state);
  const next = state.characters.find(c => c.id === characterId);
  if (!next) return result(false, '아직 만나지 못한 친구예요.');
  if (next === state.character) return result(false, `${particle(next.name, '과', '와')} 이미 함께하고 있어요.`);
  if (!state.deployedCharacterIds.includes(next.id)) {
    const deployed = setCharacterDeployed(state, next.id, true, 1280, { displays: state.worldDisplays.length ? state.worldDisplays : undefined });
    if (!deployed.ok) return deployed;
  }
  state.activeCharacterId = next.id;
  linkFocus(state);
  return result(true, `${next.name}를 선택했어요. 다른 친구들도 계속 함께 자라요.`);
}

export function createGame(saved) {
  const first = createCharacter(CHARACTER_TYPES[0]);
  const state = {
    version: 4, customDefinitions: [], characters: [first], activeCharacterId: first.id, character: first,
    deployedCharacterIds: [first.id], worldDisplays: [],
    gold: 120, inventory: { grove: 2, mushroom: 0, crystal: 0 },
    items: Object.fromEntries(ITEM_TYPES.map(item => [item.id, 0])), settings: { characterScale: 2, windowWalking: true },
    portals: [], monsters: [], effects: [], logs: [],
    stats: { kills: 0, clears: 0 }, dailyClaimed: '', elapsed: 0, nextId: 1,
    cooldowns: first.cooldowns, wanderTarget: 380,
  };
  first.wanderTarget = 380;
  linkFocus(state);
  let source;
  try { source = typeof saved === 'string' ? JSON.parse(saved) : saved; } catch { return state; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return state;
  state.gold = integer(source.gold, 120, 0, 1_000_000);
  for (const type of CORE_TYPES) state.inventory[type.id] = integer(source.inventory?.[type.id], state.inventory[type.id], 0, 9999);
  for (const item of ITEM_TYPES) state.items[item.id] = integer(source.items?.[item.id], 0, 0, MAX_ITEM_STACK);
  state.settings.characterScale = [1, 2, 3].includes(source.settings?.characterScale) ? source.settings.characterScale : 2;
  state.settings.windowWalking = typeof source.settings?.windowWalking === 'boolean' ? source.settings.windowWalking : true;
  state.stats.kills = integer(source.stats?.kills, 0, 0, 1_000_000);
  state.stats.clears = integer(source.stats?.clears, 0, 0, 1_000_000);
  state.dailyClaimed = typeof source.dailyClaimed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.dailyClaimed) ? source.dailyClaimed : '';
  state.elapsed = number(source.elapsed, 0, 0, 1_000_000_000);
  state.nextId = integer(source.nextId, 1, 1, 1_000_000_000);
  const customIds = new Set(), customSheetIds = new Set();
  for (const candidate of Array.isArray(source.customDefinitions) ? source.customDefinitions.slice(0, MAX_CUSTOM_CHARACTERS * 2) : []) {
    const checked = validateCustomDefinition(candidate);
    if (!checked.ok || customIds.has(checked.definition.id) || customSheetIds.has(checked.definition.sheetId) || state.customDefinitions.length >= MAX_CUSTOM_CHARACTERS) continue;
    customIds.add(checked.definition.id);
    customSheetIds.add(checked.definition.sheetId);
    state.customDefinitions.push(checked.definition);
  }
  const roster = new Map();
  const retiredRoster = new Map();
  const savedCharacters = Array.isArray(source.characters)
    ? source.characters.slice(0, MAX_CUSTOM_CHARACTERS + CHARACTER_TYPES.length + RETIRED_CHARACTER_IDS.size) : [];
  for (const item of savedCharacters) {
    const type = item && characterType(state, item.id);
    if (type && (type.custom || state.stats.clears >= type.unlockClears) && !roster.has(type.id)) roster.set(type.id, item);
    if (item && RETIRED_CHARACTER_IDS.has(item.id) && !retiredRoster.has(item.id)) retiredRoster.set(item.id, item);
  }
  const baseId = CHARACTER_TYPES[0].id;
  const single = source.character && typeof source.character === 'object' && !Array.isArray(source.character) ? source.character : null;
  const singleType = single && characterType(state, single.id);
  // A matching redundant active-character record can repair a missing roster
  // entry, but a different or orphan character must never become the new base.
  if (singleType && (!source.activeCharacterId || source.activeCharacterId === single.id) && !roster.has(single.id)) roster.set(single.id, single);
  if (single && RETIRED_CHARACTER_IDS.has(single.id) && (!source.activeCharacterId || source.activeCharacterId === single.id) && !retiredRoster.has(single.id)) retiredRoster.set(single.id, single);
  if (!roster.has(baseId)) {
    // New base metadata always comes from source; migrate only saved progress.
    // Prefer the formerly active base companion, then the old starting companion.
    const activeProgress = RETIRED_CHARACTER_IDS.has(source.activeCharacterId) ? retiredRoster.get(source.activeCharacterId) : null;
    const legacySingle = (source.version || 1) < 2 && single && (!single.id || RETIRED_CHARACTER_IDS.has(single.id)) ? single : null;
    const priorProgress = activeProgress || legacySingle || retiredRoster.get('lumi') || retiredRoster.values().next().value;
    if (priorProgress) roster.set(baseId, priorProgress);
  }
  state.characters = [...CHARACTER_TYPES.filter(type => state.stats.clears >= type.unlockClears), ...state.customDefinitions].map(type => createCharacter(type, roster.get(type.id)));
  state.character = state.characters.find(c => c.id === source.activeCharacterId) || state.characters[0];
  state.activeCharacterId = state.character.id;
  state.cooldowns = state.character.cooldowns;
  if ((source.version || 1) < 2) for (const key of Object.keys(state.cooldowns)) state.cooldowns[key] = number(source.cooldowns?.[key], 0, 0, 10);
  state.character.speech = '다시 만나서 반가워!';
  state.character.speechTime = 4;
  if ((source.version || 1) < 4 || !Number.isFinite(roster.get(state.character.id)?.wanderTarget)) state.character.wanderTarget = number(source.wanderTarget, state.character.x, 0, MAX_WORLD_EXTENT);
  const deployed = source.version >= 4 && Array.isArray(source.deployedCharacterIds) ? source.deployedCharacterIds : [state.activeCharacterId];
  state.deployedCharacterIds = [...new Set(deployed.filter(value => state.characters.some(c => c.id === value)))].slice(0, MAX_DEPLOYED_COMPANIONS);
  if (!state.deployedCharacterIds.length) state.deployedCharacterIds = [state.activeCharacterId];
  if (!state.deployedCharacterIds.includes(state.activeCharacterId)) state.activeCharacterId = state.deployedCharacterIds[0];
  state.worldDisplays = Array.isArray(source.worldDisplays) && source.worldDisplays.length ? normalizeWorldDisplays(source.worldDisplays) : [];
  linkFocus(state);

  const seen = new Set();
  for (const item of Array.isArray(source.portals) ? source.portals.slice(0, 3) : []) {
    if (!item || !TYPES.has(item.coreId) || !validId(item.id, 'p') || seen.has(item.id)) continue;
    const type = TYPES.get(item.coreId);
    seen.add(item.id);
    const portal = {
      id: item.id, coreId: type.id, x: number(item.x, 600, 0, MAX_WORLD_EXTENT), displayId: displayKey(item.displayId),
      total: type.count, defeated: integer(item.defeated, 0, 0, type.count),
      remaining: type.count, spawnIn: number(item.spawnIn, 1, 0, 5),
    };
    state.portals.push(portal);
    state.nextId = Math.max(state.nextId, Number(item.id.slice(1)) + 1);
  }
  for (const item of Array.isArray(source.monsters) ? source.monsters.slice(0, 15) : []) {
    if (!item || !validId(item.id, 'm') || seen.has(item.id)) continue;
    const portal = state.portals.find(p => p.id === item.portalId);
    if (!portal || state.monsters.filter(m => m.portalId === portal.id).length >= portal.total - portal.defeated) continue;
    const type = TYPES.get(portal.coreId);
    seen.add(item.id);
    state.monsters.push({
      id: item.id, portalId: portal.id, type: type.id, name: type.monsterName, displayId: portal.displayId,
      x: number(item.x, portal.x, 38, MAX_WORLD_EXTENT), hp: number(item.hp, monsterHP(type), 1, monsterHP(type)),
      maxHp: monsterHP(type), attack: monsterAttack(type), level: type.level, defense: type.level - 1, resistance: type.id === 'crystal' ? 3 : 0,
      cooldown: number(item.cooldown, 1.2, 0, 2), facing: item.facing === -1 ? -1 : 1,
    });
    state.nextId = Math.max(state.nextId, Number(item.id.slice(1)) + 1);
  }
  // Reconcile damaged saves so every portal still has exactly its authored wave.
  for (const portal of state.portals) portal.remaining = portal.total - portal.defeated - state.monsters.filter(m => m.portalId === portal.id).length;
  state.logs = (Array.isArray(source.logs) ? source.logs : []).slice(0, 35).filter(item => item && typeof item.text === 'string').map(item => ({
    id: id(state, 'l'), text: cleanText(item.text), kind: ['info', 'success', 'combat', 'care'].includes(item.kind) ? item.kind : 'info',
    time: number(item.time, Date.now(), 0, 9_999_999_999_999),
  }));
  return state;
}

export function petCharacter(state, characterId = state.activeCharacterId) {
  const c = state.characters.find(character => character.id === characterId);
  if (!c) return result(false, '아직 만나지 못한 친구예요.');
  if (c.cooldowns.pet > 0) return result(false, `${particle(c.name, '이', '가')} 아직 기분 좋은 여운을 즐기고 있어요.`);
  c.cooldowns.pet = 3;
  if (c.animationState !== 'collapse') setAnimation(c, 'pet', 1.2, true);
  c.mood = Math.min(100, c.mood + 8);
  c.bond = Math.min(100, c.bond + 1);
  say(state, ['헤헤, 따뜻해… ♡', '네가 쓰다듬어 주는 게 제일 좋아!', '고마워! 오늘도 같이 놀자.'][c.bond % 3], 4, c);
  effect(state, c.x, '♥ +1', 'heart', undefined, 0, c.displayId);
  return result(true, `쓰담쓰담! ${particle(c.name, '과', '와')} 조금 더 가까워졌어요.`);
}

export function feedCharacter(state, foodId = 'snack', characterId = state.activeCharacterId) {
  const food = FOOD_TYPES.get(foodId);
  const c = state.characters.find(character => character.id === characterId);
  if (!c) return result(false, '아직 만나지 못한 친구예요.');
  if (!food) return result(false, '알 수 없는 음식이에요.');
  if (c.cooldowns.feed > 0) return result(false, '천천히 냠냠! 조금만 기다려 주세요.');
  if (c.hunger >= 99 && c.hp >= c.maxHp) return result(false, `${particle(c.name, '은', '는')} 지금 배가 불러요.`);
  if (state.gold < food.price) return result(false, `음식에는 ${food.price}골드가 필요해요.`);
  const favorite = c.foodPreference === food.group;
  const matches = food.tastes.filter(taste => c.tastePreferences.includes(taste)).length;
  const hungerGain = 25 + (favorite ? 10 : 0) + matches * 3;
  const moodGain = 4 + (favorite ? 4 : 0) + matches * 2;
  const bondGain = (favorite ? 1 : 0) + matches;
  const hungerBefore = c.hunger, moodBefore = c.mood, bondBefore = c.bond;
  state.gold -= food.price;
  c.cooldowns.feed = 3;
  c.hunger = Math.min(100, c.hunger + hungerGain);
  c.hp = Math.min(c.maxHp, c.hp + 12);
  c.mood = Math.min(100, c.mood + moodGain);
  c.bond = Math.min(100, c.bond + bondGain);
  say(state, favorite ? '내가 좋아하는 음식이야! 취향을 기억해 줘서 고마워.' : matches ? '냠냠! 내가 좋아하는 맛이 나!' : '냠냠! 다시 힘이 나는걸!', 4, c);
  effect(state, c.x, `포만감 +${Math.round(c.hunger - hungerBefore)}`, 'heal', undefined, 0, c.displayId);
  const bonus = favorite || matches ? ` 취향 보너스: 포만감 +${(favorite ? 10 : 0) + matches * 3}, 행복 +${(favorite ? 4 : 0) + matches * 2}, 유대감 +${bondGain} (최대 100).` : '';
  log(state, `${c.name}에게 ${particle(food.name, '을', '를')} 주었어요. −${food.price}골드${bonus}`, 'care');
  return result(true, `${food.name}! 포만감 +${Math.round(c.hunger - hungerBefore)}, 행복 +${Math.round(c.mood - moodBefore)}, 유대감 +${c.bond - bondBefore}.${favorite || matches ? ' 취향에 맞아 더 좋아해요.' : ''}`);
}

export function setCommand(state, command, characterId = state.activeCharacterId) {
  const c = state.characters.find(character => character.id === characterId);
  if (!c) return result(false, '아직 만나지 못한 친구예요.');
  if (!COMMANDS.has(command)) return result(false, '알 수 없는 명령이에요.');
  if (c.animationState === 'collapse' && c.animationTimer > 0 && command !== 'rest') return result(false, '쓰러진 친구가 회복할 때까지 잠깐 기다려 주세요.');
  const changed = c.command !== command;
  c.command = command;
  if (changed) resetAnimation(c);
  c.action = command === 'rest' ? 'rest' : 'idle';
  c.cooldowns.wander = 0;
  const messages = { wander: '가볍게 산책하고 올게!', fight: '모험 준비 끝! 내가 지켜 줄게.', rest: '잠깐 쉬어 갈게… 쿨쿨.' };
  say(state, messages[command], 4, c);
  return result(true, messages[command]);
}

export function deployCore(state, coreId, x, width = 1280, options = {}) {
  ensureGroupState(state);
  const type = TYPES.get(coreId);
  if (!type) return result(false, '알 수 없는 던전 코어예요.');
  if (state.inventory[coreId] < 1) return result(false, '이 코어가 부족해요. 상점에서 구입할 수 있어요.');
  if (state.portals.length >= 3) return result(false, '던전은 동시에 3개까지 열 수 있어요.');
  if (!Number.isFinite(x)) return result(false, '바닥의 빈 곳에 코어를 놓아 주세요.');
  const displays = currentDisplays(state, width, options);
  const display = options.displayId === undefined ? regionFor(state.character, displays) : displays.find(item => item.id === String(options.displayId));
  if (!display) return result(false, '사용할 수 있는 모니터를 선택해 주세요.');
  const { low, high } = regionBounds(display);
  const position = clamp(x, low, high);
  if (state.portals.some(portal => portal.displayId === display.id && Math.abs(portal.x - position) < 90)) return result(false, '다른 던전에서 조금 떨어진 곳에 놓아 주세요.');
  state.inventory[coreId] -= 1;
  state.worldDisplays = displays;
  state.portals.push({ id: id(state, 'p'), coreId, displayId: display.id, x: position, remaining: type.count, spawnIn: 1.5, total: type.count, defeated: 0 });
  log(state, `${type.name} 개방! ${type.monsterName} ${type.count}마리가 나타나요.`);
  say(state, '새로운 모험이 열렸어! 탐험을 시작해 볼까?');
  return result(true, `${type.name}를 배치했어요. 전투 명령으로 모험을 시작하세요.`);
}

export function buyCore(state, coreId) {
  const type = TYPES.get(coreId);
  if (!type) return result(false, '알 수 없는 던전 코어예요.');
  if (state.gold < type.price) return result(false, `${type.price}골드가 필요해요.`);
  if (state.inventory[coreId] >= 9999) return result(false, '코어 보관함이 가득 찼어요.');
  state.gold -= type.price;
  state.inventory[coreId] += 1;
  log(state, `${type.name} 구입. −${type.price}골드`, 'success');
  return result(true, `${type.name}가 가방에 들어왔어요.`);
}

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function claimDaily(state) {
  const today = localDate();
  if (state.dailyClaimed === today) return result(false, '오늘의 선물은 이미 받았어요. 내일 다시 만나요!');
  state.dailyClaimed = today;
  state.gold += 40;
  state.inventory.grove += 1;
  log(state, '오늘의 선물: 새싹 숲 코어 1개, 40골드!', 'success');
  return result(true, '새싹 숲 코어 1개와 40골드를 받았어요!');
}

function gainXP(state, amount, c) {
  c.xp += amount;
  while (c.xp >= c.nextXp && c.level < 50) {
    c.xp -= c.nextXp;
    c.level += 1;
    c.nextXp = nextXP(c.level);
    Object.assign(c, characterStats(characterType(state, c.id), c.level));
    c.hp = c.maxHp;
    c.mana = c.maxMana;
    say(state, `레벨 ${c.level}! 너와 함께라서 더 강해졌어!`, 5, c);
    effect(state, c.x, 'LEVEL UP!', 'level', undefined, 0, c.displayId);
    log(state, `${particle(c.name, '이', '가')} 레벨 ${c.level}이 되었어요! 체력과 마나를 모두 회복했어요.`, 'success');
  }
  if (c.level === 50) c.xp = Math.min(c.xp, c.nextXp - 1);
}

function defeatMonster(state, monster, random, attacker, participants) {
  // A defeat consumes the living monster exactly once before awarding anything.
  if (!state.monsters.some(item => item.id === monster.id)) return;
  const type = TYPES.get(monster.type);
  const xp = 16 + (type.level - 1) * 7;
  const gold = 8 + (type.level - 1) * 4;
  state.monsters = state.monsters.filter(item => item.id !== monster.id);
  const portal = state.portals.find(item => item.id === monster.portalId);
  if (portal) portal.defeated += 1;
  state.stats.kills += 1;
  state.gold += gold;
  effect(state, monster.x, `+${xp} XP · +${gold} G`, 'reward', undefined, 0, monster.displayId);
  // Experience is shared with deployed fighters on this display; the wallet,
  // loot roll, kill count and portal wave are awarded only once globally.
  for (const character of participants) if (character === attacker || (character.displayId === monster.displayId && character.command === 'fight')) gainXP(state, xp, character);
  log(state, `${monster.name} 처치! +${xp} 경험치 · +${gold}골드`, 'combat');
  for (const [lootIndex, drop] of (MONSTER_DROPS[monster.type] || []).entries()) {
    let roll;
    try { roll = random(); } catch { continue; }
    if (typeof roll !== 'number' || !Number.isFinite(roll) || roll < 0 || roll >= 1 || roll >= drop.chance) continue;
    const item = ITEMS.get(drop.itemId);
    const before = state.items[item.id];
    const quantity = Math.min(drop.quantity, MAX_ITEM_STACK - before);
    if (quantity <= 0) continue;
    state.items[item.id] = before + quantity;
    effect(state, monster.x, `${item.name} ×${quantity}`, 'loot', item.id, lootIndex, monster.displayId);
    log(state, `${item.name} ×${quantity} 획득! 창고에 보관했어요.`, 'success');
  }
}

function moveToward(actor, target, speed, dt) {
  const distance = target - actor.x;
  if (Math.abs(distance) < 1) return false;
  actor.facing = distance < 0 ? -1 : 1;
  actor.x += Math.sign(distance) * Math.min(Math.abs(distance), speed * dt);
  return true;
}

export function stepGame(state, dtSeconds, width = 1280, random = Math.random, options = {}) {
  const displays = applyWorldLayout(state, width, options);
  const dt = number(dtSeconds, 0, 0, 0.25);
  if (dt <= 0) return state;
  const companions = getDeployedCharacters(state);
  const paused = new Set(Array.isArray(options.pausedCharacterIds) ? options.pausedCharacterIds : []);
  const elevatedIds = new Set(Array.isArray(options.elevatedCharacterIds) ? options.elevatedCharacterIds : []);
  if (options.onElevatedSurface === true) elevatedIds.add(state.activeCharacterId);
  // The desktop controller owns ledge/drag motion. A fight command returns an
  // actor to the floor, while a dragged actor is excluded from combat entirely.
  const elevated = character => elevatedIds.has(character.id) && character.command !== 'fight';
  const participants = companions.filter(character => !paused.has(character.id));
  state.elapsed += dt;
  state.effects = state.effects.filter(item => (item.life -= dt) > 0);

  for (const portal of state.portals) {
    portal.spawnIn -= dt;
    if (portal.remaining > 0 && portal.spawnIn <= 0) {
      const type = TYPES.get(portal.coreId);
      const { low, high } = regionBounds(regionFor(portal, displays));
      const offset = number(random(), 0.5, 0, 1) < 0.5 ? -24 : 24;
      state.monsters.push({
        id: id(state, 'm'), portalId: portal.id, type: type.id, name: type.monsterName, displayId: portal.displayId,
        x: clamp(portal.x + offset, low, high), hp: monsterHP(type), maxHp: monsterHP(type),
        attack: monsterAttack(type), level: type.level, defense: type.level - 1, resistance: type.id === 'crystal' ? 3 : 0, cooldown: 1.5, facing: -1,
      });
      portal.remaining -= 1;
      portal.spawnIn = 4;
    }
  }

  for (const c of participants) {
    const { low, high } = regionBounds(regionFor(c, displays), state.settings.characterScale);
    c.animationTime += dt;
    c.animationTimer = Math.max(0, c.animationTimer - dt);
    c.restTime = c.command === 'rest' && c.animationState !== 'collapse' ? c.restTime + dt : 0;
    for (const key of Object.keys(c.cooldowns)) c.cooldowns[key] = Math.max(0, c.cooldowns[key] - dt);
    c.speechTime = Math.max(0, c.speechTime - dt);
    c.hunger = Math.max(0, c.hunger - dt * 0.045);
    c.mood = Math.max(0, c.mood - dt * 0.018);
    c.action = c.command === 'rest' ? 'rest' : 'idle';
    if (c.command === 'rest') {
      c.hp = Math.min(c.maxHp, c.hp + dt * 4);
      c.mana = Math.min(c.maxMana, c.mana + dt * 3);
      c.mood = Math.min(100, c.mood + dt * 0.12);
      continue;
    }
    if (elevated(c)) continue;
    const nearest = state.monsters.filter(monster => monster.displayId === c.displayId)
      .sort((a, b) => Math.abs(a.x - c.x) - Math.abs(b.x - c.x))[0];
    if (c.command === 'fight' && nearest) {
      const gap = nearest.x - c.x;
      if (Math.abs(gap) > 42) c.action = moveToward(c, nearest.x - Math.sign(gap) * 38, 78 * c.speed / 10, dt) ? 'walk' : 'idle';
    } else if (c.command === 'wander' && !(c.animationState === 'pet' && c.animationTimer > 0) && (!nearest || Math.abs(nearest.x - c.x) > 65)) {
      if (c.cooldowns.wander <= 0) {
        c.wanderTarget = low + number(random(), 0.5, 0, 1) * (high - low);
        c.cooldowns.wander = 6 + number(random(), 0.5, 0, 1) * 5;
      }
      c.action = moveToward(c, c.wanderTarget, 32 * c.speed / 10, dt) ? 'walk' : 'idle';
    }
    c.x = clamp(c.x, low, high);
    if (nearest && Math.abs(nearest.x - c.x) <= 51 && c.cooldowns.attack <= 0) {
      c.facing = nearest.x >= c.x ? 1 : -1;
      c.action = 'attack';
      c.cooldowns.hit = 0.3;
      c.cooldowns.attack = clamp(0.9 * 10 / c.speed, 0.4, 1.8);
      c.strikes = (c.strikes + 1) % 3;
      const magical = c.mana >= 6 && (c.magic > c.attack || c.strikes === 0);
      if (magical) c.mana -= 6;
      setAnimation(c, magical ? 'strongAttack' : 'attack', Math.min(0.5, c.cooldowns.attack), true);
      const armor = magical ? (nearest.resistance || 0) : (nearest.defense || 0);
      const power = (magical ? c.magic * 1.6 : c.attack) * (c.hunger < 15 ? 0.75 : 1);
      const damage = Math.max(1, Math.round(power - armor * 0.35));
      nearest.hp = Math.max(0, nearest.hp - damage);
      effect(state, nearest.x, `${magical ? '✦ ' : ''}−${damage}`, magical ? 'magic' : 'damage', undefined, 0, c.displayId);
      if (nearest.hp === 0) defeatMonster(state, nearest, random, c, participants);
    }
    if (c.cooldowns.hit > 0) c.action = 'attack';
  }

  for (const monster of state.monsters) {
    monster.cooldown = Math.max(0, monster.cooldown - dt);
    const c = participants.filter(character => character.displayId === monster.displayId && character.command !== 'rest' && !elevated(character)
      && (character.command === 'fight' || Math.abs(character.x - monster.x) < 170))
      .sort((a, b) => Math.abs(a.x - monster.x) - Math.abs(b.x - monster.x))[0];
    if (!c) continue;
    const gap = c.x - monster.x;
    if (Math.abs(gap) > 38) moveToward(monster, c.x - Math.sign(gap) * 34, 21 + monster.level * 2, dt);
    if (Math.abs(monster.x - c.x) <= 43 && monster.cooldown <= 0) {
      const magical = monster.type === 'crystal';
      const mitigation = magical ? c.resistance : c.defense;
      const damage = Math.max(1, Math.round(monster.attack - mitigation * 0.35));
      c.hp = Math.max(0, c.hp - damage);
      monster.cooldown = 1.6;
      effect(state, c.x, `${magical ? '✦ ' : ''}−${damage}`, 'hurt', undefined, 0, c.displayId);
      if (c.hp === 0) {
        c.hp = Math.max(1, c.maxHp * 0.25);
        c.command = 'rest';
        c.action = 'rest';
        c.restTime = 0;
        setAnimation(c, 'collapse', 2, true);
        say(state, '조금 지쳤어… 쉬고 나면 다시 힘낼게.', 5, c);
        log(state, `${particle(c.name, '이', '가')} 지쳐서 휴식을 시작했어요. 휴식 중에는 안전하게 회복해요.`, 'care');
      }
    }
  }

  for (const portal of [...state.portals]) {
    if (portal.remaining === 0 && !state.monsters.some(monster => monster.portalId === portal.id)) {
      const type = TYPES.get(portal.coreId);
      const reward = 20 + type.level * 5;
      state.portals = state.portals.filter(item => item.id !== portal.id);
      state.stats.clears += 1;
      unlockCompanions(state, true);
      state.gold += reward;
      for (const c of participants.filter(character => character.displayId === portal.displayId)) {
        c.mood = Math.min(100, c.mood + 5);
        say(state, '해냈어! 우리 정말 좋은 팀인 것 같아.', 5, c);
      }
      effect(state, portal.x, `CLEAR! +${reward} G`, 'level', undefined, 0, portal.displayId);
      log(state, `${type.name} 탐험 완료! 보너스 ${reward}골드`, 'success');
    }
  }
  for (const c of participants) settleAnimation(c);
  return state;
}

function persistentCharacter(character) {
  const { animationState, animationTime, animationTimer, animationDuration, restTime, action, speech, speechTime, ...saved } = character;
  return saved;
}

export function serializeGame(state) {
  ensureGroupState(state);
  return JSON.stringify({
    version: 4, deployedCharacterIds: [...state.deployedCharacterIds], worldDisplays: state.worldDisplays, customDefinitions: state.customDefinitions, characters: state.characters.map(persistentCharacter), activeCharacterId: state.activeCharacterId, character: persistentCharacter(state.character), gold: state.gold, inventory: state.inventory,
    items: state.items, settings: state.settings,
    portals: state.portals, monsters: state.monsters, logs: state.logs, stats: state.stats,
    dailyClaimed: state.dailyClaimed, elapsed: state.elapsed, nextId: state.nextId,
    cooldowns: state.cooldowns, wanderTarget: state.wanderTarget,
  });
}
