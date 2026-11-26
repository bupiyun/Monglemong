import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_TYPES, CHARACTER_TYPES, FOOD_GROUPS, TASTES, FOODS, STAT_FIELDS, ANIMATION_KEYS, SPRITE_SHEET, validateCustomDefinition, createCustomCharacter, updateCustomCharacter, deleteCustomCharacter, createGame, stepGame, deployCore, buyCore, petCharacter, feedCharacter, claimDaily, setCommand, serializeGame, selectCharacter, getNextCompanion, ITEM_TYPES, MONSTER_DROPS, MAX_ITEM_STACK, getCharacterBounds, setCharacterScale, setWindowWalking } from '../src/engine.js';

function advance(state, seconds, width = 1280) {
  for (let time = 0; time < seconds; time += 0.1) stepGame(state, 0.1, width, () => 0.5);
}

test('deployment consumes exactly one core only after all placement checks pass', () => {
  const state = createGame();
  assert.equal(deployCore(state, 'grove', NaN).ok, false);
  assert.equal(state.inventory.grove, 2);
  assert.equal(deployCore(state, 'grove', 500).ok, true);
  assert.equal(state.inventory.grove, 1);
  assert.equal(deployCore(state, 'grove', 540).ok, false);
  assert.equal(state.inventory.grove, 1);
  assert.equal(deployCore(state, 'missing', 800).ok, false);
  assert.equal(deployCore(state, 'grove', 800).ok, true);
  assert.equal(deployCore(state, 'grove', 1000).ok, false);
  assert.equal(state.portals.length, 2);
});

test('portal limit never spends a fourth core', () => {
  const state = createGame();
  state.inventory.grove = 4;
  for (const x of [200, 500, 800]) assert.equal(deployCore(state, 'grove', x).ok, true);
  assert.equal(deployCore(state, 'grove', 1100).ok, false);
  assert.equal(state.inventory.grove, 1);
});

test('a dungeon spawns precisely its fixed wave and stops spawning without combat', () => {
  for (const type of CORE_TYPES) {
    const state = createGame();
    state.inventory[type.id] = 1;
    setCommand(state, 'rest');
    deployCore(state, type.id, 600);
    advance(state, 50);
    assert.equal(state.monsters.length, type.count);
    assert.ok(state.monsters.every(monster => monster.type === type.id && monster.name === type.monsterName));
    assert.equal(state.portals[0].remaining, 0);
    assert.equal(state.stats.clears, 0);
  }
});

test('combat clears a finite wave, rewards gold and levels up exactly once', () => {
  const state = createGame();
  deployCore(state, 'grove', 550);
  setCommand(state, 'fight');
  advance(state, 80);
  assert.equal(state.monsters.length, 0);
  assert.equal(state.portals.length, 0);
  assert.equal(state.stats.kills, 3);
  assert.equal(state.stats.clears, 1);
  assert.equal(state.character.level, 2);
  assert.equal(state.character.xp, 8);
  assert.equal(state.character.attack, 7);
  assert.equal(state.gold, 120 + 3 * 8 + 25);
  advance(state, 80);
  assert.equal(state.stats.kills, 3);
  assert.equal(state.gold, 169);
});

test('care cooldowns stop repeated rewards and restore across saves', () => {
  const state = createGame();
  assert.equal(petCharacter(state).ok, true);
  assert.equal(petCharacter(state).ok, false);
  assert.equal(state.character.bond, 1);
  const restored = createGame(serializeGame(state));
  assert.equal(petCharacter(restored).ok, false);
  advance(restored, 3.1);
  assert.equal(petCharacter(restored).ok, true);
  state.character.hp = 50;
  assert.equal(feedCharacter(state).ok, true);
  assert.equal(feedCharacter(state).ok, false);
  assert.equal(state.gold, 110);
  assert.equal(state.character.hp, 62);
});

test('purchases and daily gifts keep accounting consistent', () => {
  const state = createGame();
  assert.equal(buyCore(state, 'crystal').ok, false);
  assert.equal(buyCore(state, 'mushroom').ok, true);
  assert.equal(state.gold, 40);
  assert.equal(state.inventory.mushroom, 1);
  assert.equal(claimDaily(state).ok, true);
  assert.equal(claimDaily(state).ok, false);
  assert.equal(state.gold, 80);
  assert.equal(state.inventory.grove, 3);
  assert.equal(claimDaily(createGame(serializeGame(state))).ok, false);
});

test('active dungeon roundtrips without offline combat or lost waves', () => {
  const state = createGame();
  deployCore(state, 'grove', 600);
  setCommand(state, 'rest');
  advance(state, 2);
  assert.equal(state.monsters.length, 1);
  const restored = createGame(serializeGame(state));
  assert.deepEqual(restored.portals, state.portals);
  assert.deepEqual(restored.monsters, state.monsters);
  assert.equal(restored.elapsed, state.elapsed);
  assert.equal(restored.character.hp, state.character.hp);
  assert.equal(restored.gold, state.gold);
  assert.equal(restored.effects.length, 0);
  advance(restored, 20);
  assert.equal(restored.monsters.length, 3);
});

test('corrupt and partial saves are bounded and usable', () => {
  assert.equal(createGame('{broken').gold, 120);
  assert.equal(createGame(null).character.level, 1);
  assert.equal(createGame('[]').character.hp, 130);
  const state = createGame({
    gold: -50, character: { level: Infinity, hp: -5, x: NaN, command: 'explode' },
    inventory: { grove: -100, mushroom: Infinity },
    portals: [{ id: 'p10', coreId: 'grove', x: Infinity, remaining: -80, defeated: 1 }, { id: 'p10', coreId: 'grove' }, { id: 'p3', coreId: 'unknown' }],
    monsters: [{ id: 'm11', portalId: 'p10', hp: -40 }, { id: 'm11', portalId: 'p10' }, { id: 'm99', portalId: 'missing' }],
  });
  assert.equal(state.gold, 0);
  assert.equal(state.character.hp, 1);
  assert.equal(state.character.command, 'wander');
  assert.equal(state.inventory.grove, 0);
  assert.equal(state.portals.length, 1);
  assert.equal(state.monsters.length, 1);
  assert.equal(state.portals[0].remaining + state.portals[0].defeated + state.monsters.length, 3);
  assert.ok(state.nextId > 11);
  assert.doesNotThrow(() => stepGame(state, 0.1, 800));
});

test('invalid commands do not change behavior; resize clamps all actors', () => {
  const state = createGame();
  assert.equal(setCommand(state, 'launch').ok, false);
  assert.equal(state.character.command, 'wander');
  deployCore(state, 'grove', 1100);
  setCommand(state, 'rest');
  advance(state, 2);
  state.character.x = 2000;
  stepGame(state, 0, 320);
  for (const actor of [state.character, ...state.portals, ...state.monsters]) assert.ok(actor.x >= 38 && actor.x <= 282);
});

test('large inactive-tab deltas are capped, and resting is safe healing', () => {
  const state = createGame();
  state.character.hp = 50;
  setCommand(state, 'rest');
  deployCore(state, 'grove', 300);
  stepGame(state, 3600, 1280);
  assert.equal(state.elapsed, 0.25);
  assert.equal(state.character.hp, 51);
  assert.equal(state.monsters.length, 0);
  advance(state, 60);
  assert.equal(state.character.hp, state.character.maxHp);
  assert.equal(state.monsters.length, 3);
});

test('oversized saved IDs cannot break unique monster identities', () => {
  const state = createGame({
    portals: [
      { id: `p${'9'.repeat(400)}`, coreId: 'grove' },
      { id: 'p9999999999999999', coreId: 'grove' },
      { id: 'p5', coreId: 'grove' },
    ],
    monsters: [{ id: 'm9999999999999999', portalId: 'p5' }],
  });
  assert.equal(state.portals.length, 1);
  assert.equal(state.monsters.length, 0);
  setCommand(state, 'rest');
  advance(state, 20);
  assert.equal(state.monsters.length, 3);
  assert.equal(new Set(state.monsters.map(monster => monster.id)).size, 3);
  assert.ok(Number.isSafeInteger(state.nextId));
});

test('a defeated companion safely rests, then recovers without losing its dungeon', () => {
  const state = createGame();
  setCommand(state, 'rest');
  deployCore(state, 'grove', 300);
  advance(state, 20);
  state.character.hp = 1;
  state.character.x = 300;
  setCommand(state, 'fight');
  advance(state, 0.2);
  assert.equal(state.character.command, 'rest');
  assert.ok(state.character.hp > 0);
  assert.equal(state.portals.length, 1);
  const enemies = state.monsters.length;
  advance(state, 30);
  assert.equal(state.character.hp, state.character.maxHp);
  assert.equal(state.monsters.length, enemies);
});

test('Cafemong is the only authored companion with the requested traits and exact growth', () => {
  assert.equal(CHARACTER_TYPES.length, 1);
  const type = CHARACTER_TYPES[0];
  assert.equal(type.id, 'cafemong');
  assert.equal(type.name, '카페몽');
  assert.equal(type.title, '카페에서 태어난 고양이형 몽글몬');
  assert.equal(type.personality, '차분하고 늘 방긋방긋 미소 짓는다.\n카페 일을 하며 커피를 내릴 때 가장 행복해 하며, 털에선 늘 부드러운 라떼 향이 난다.');
  assert.equal(type.foodPreference, 'snack');
  assert.deepEqual(type.tastePreferences, ['bitter', 'sweet']);
  assert.deepEqual(type.baseStats, { hp: 130, mana: 30, attack: 6, defense: 4, magic: 14, resistance: 9, speed: 8 });
  assert.deepEqual(type.growthStats, { hp: 10, mana: 5, attack: 1, defense: 2, magic: 2, resistance: 3, speed: 0.5 });
  assert.equal(type.spriteSheet, 'assets/characters/cafemong.png');
  assert.equal(type.sprite, 'assets/character-placeholder.svg');
  assert.deepEqual(FOOD_GROUPS.map(group => group.id), ['meat', 'fish', 'vegetable', 'fruit', 'snack']);
  assert.ok(type.tastePreferences.every(id => TASTES.some(taste => taste.id === id)));
  assert.ok(FOODS.every(food => food.price === 10 && FOOD_GROUPS.some(group => group.id === food.group)));
});

test('fresh games and cleared dungeons keep only Cafemong in the base roster', () => {
  const fresh = createGame();
  assert.deepEqual(fresh.characters.map(c => c.id), ['cafemong']);
  assert.equal(fresh.character, fresh.characters[0]);
  assert.equal(fresh.cooldowns, fresh.character.cooldowns);
  assert.equal(getNextCompanion(fresh), null);
  assert.equal(selectCharacter(fresh, 'bomi').ok, false);
  deployCore(fresh, 'grove', 500);
  setCommand(fresh, 'fight');
  advance(fresh, 60);
  assert.equal(fresh.stats.clears, 1);
  assert.deepEqual(fresh.characters.map(c => c.id), ['cafemong']);
  for (const clears of [0, 1, 12, 1000]) {
    const state = createGame({ stats: { clears } });
    assert.deepEqual(state.characters.map(c => c.id), ['cafemong']);
    assert.equal(getNextCompanion(state), null);
  }
});

test('v1 migration preserves progression and active dungeon while replacing the prototype base', () => {
  const state = createGame({
    version: 1, character: { level: 4, hp: 61, xp: 17, x: 678, hunger: 23, mood: 47, bond: 11, command: 'rest' },
    gold: 357, inventory: { grove: 4, mushroom: 2, crystal: 1 }, stats: { clears: 2, kills: 8 },
    cooldowns: { pet: 2, feed: 1.2 },
    portals: [{ id: 'p40', coreId: 'grove', x: 500, remaining: 1, total: 3, defeated: 1, spawnIn: 2 }],
    monsters: [{ id: 'm41', portalId: 'p40', type: 'grove', x: 520, hp: 7, cooldown: 1 }],
  });
  assert.equal(state.version, 3);
  assert.equal(state.character.id, 'cafemong');
  for (const [key, value] of Object.entries({ level: 4, hp: 61, xp: 17, x: 678, hunger: 23, mood: 47, bond: 11, command: 'rest' })) assert.equal(state.character[key], value);
  assert.equal(state.character.maxHp, 160);
  assert.equal(state.character.attack, 9);
  assert.equal(state.character.speed, 9.5);
  assert.equal(state.character.mana, state.character.maxMana);
  assert.equal(state.gold, 357);
  assert.deepEqual(state.inventory, { grove: 4, mushroom: 2, crystal: 1 });
  assert.deepEqual(state.characters.map(c => c.id), ['cafemong']);
  assert.equal(state.portals[0].remaining, 1);
  assert.equal(state.monsters[0].hp, 7);
  assert.equal(petCharacter(state).ok, false);
  assert.equal(feedCharacter(state).ok, false);
});

const CUSTOM_ID = 'custom_01234567-89ab-4cde-8fab-0123456789ab';
function customInput(overrides = {}) {
  return {
    id: CUSTOM_ID, sheetId: CUSTOM_ID, name: '하루', title: '내가 만든 모험가', personality: '차분하고 친절해요.',
    foodPreference: 'fruit', tastePreferences: ['sweet', 'sour'],
    baseStats: Object.fromEntries(STAT_FIELDS.map(field => [field.key, field.base])),
    growthStats: Object.fromEntries(STAT_FIELDS.map(field => [field.key, field.growth])),
    ...overrides,
  };
}

test('swapping between base and custom companions keeps independent progress across reloads', () => {
  const state = createGame({ character: { level: 4, hp: 61, xp: 17, mana: 9, hunger: 30, mood: 40, bond: 11 } });
  assert.equal(createCustomCharacter(state, customInput()).ok, true);
  state.character.x = 600;
  petCharacter(state);
  const base = state.character;
  assert.equal(selectCharacter(state, CUSTOM_ID).ok, true);
  assert.equal(state.character.x, 600);
  assert.equal(state.character.level, 1);
  Object.assign(state.character, { hp: 50, mana: 10, hunger: 70, xp: 5, x: 750 });
  const custom = state.character;
  assert.equal(selectCharacter(state, 'cafemong').ok, true);
  assert.equal(state.character, base);
  assert.equal(state.character.x, 750);
  assert.equal(state.character.hp, 61);
  assert.equal(state.character.mana, 9);
  assert.equal(state.character.level, 4);
  assert.equal(state.character.xp, 17);
  assert.equal(petCharacter(state).ok, false);
  assert.equal(custom.hp, 50);
  const restored = createGame(serializeGame(state));
  assert.equal(restored.character, restored.characters.find(c => c.id === restored.activeCharacterId));
  assert.equal(restored.cooldowns, restored.character.cooldowns);
  selectCharacter(restored, CUSTOM_ID);
  assert.equal(restored.character.hp, 50);
  assert.equal(restored.character.mana, 10);
  assert.equal(restored.character.hunger, 70);
  assert.equal(restored.character.xp, 5);
  const activeRestored = createGame(serializeGame(restored));
  assert.equal(activeRestored.character.id, CUSTOM_ID);
  assert.equal(activeRestored.character, activeRestored.characters[1]);
  assert.equal(activeRestored.character.hp, 50);
});

test('a companion cannot be swapped during active combat but can after resting', () => {
  const state = createGame();
  createCustomCharacter(state, customInput());
  setCommand(state, 'rest');
  deployCore(state, 'grove', 300);
  advance(state, 2);
  setCommand(state, 'fight');
  assert.equal(selectCharacter(state, CUSTOM_ID).ok, false);
  assert.equal(state.character.id, 'cafemong');
  setCommand(state, 'rest');
  assert.equal(selectCharacter(state, CUSTOM_ID).ok, true);
  assert.equal(state.character.id, CUSTOM_ID);
  assert.equal(state.monsters.length, 1);
});

test('saved base duplicates and forged traits or sheet paths cannot overwrite Cafemong', () => {
  const state = createGame({
    version: 3, activeCharacterId: 'cafemong', stats: { clears: 50 },
    characters: [null, { id: 'cafemong', level: 3, hp: 50, mana: -4, personality: '<script>', foodPreference: 'lava', tastePreferences: ['sweet', 'sweet'], attack: Infinity, speed: 9999, spriteSheet: 'https://evil.example/sheet.png', custom: true }, { id: 'cafemong', level: 50 }, { id: 'bomi', level: 40 }, { id: 'unknown' }],
  });
  assert.deepEqual(state.characters.map(c => c.id), ['cafemong']);
  assert.equal(state.activeCharacterId, 'cafemong');
  assert.equal(state.character.level, 3);
  assert.equal(state.character.hp, 50);
  assert.equal(state.character.mana, 0);
  assert.equal(state.character.attack, 8);
  assert.equal(state.character.speed, 9);
  assert.equal(state.character.foodPreference, 'snack');
  assert.deepEqual(state.character.tastePreferences, ['bitter', 'sweet']);
  assert.equal(state.character.personality, CHARACTER_TYPES[0].personality);
  assert.equal(state.character.spriteSheet, CHARACTER_TYPES[0].spriteSheet);
  assert.equal(state.character.custom, undefined);
  assert.equal(selectCharacter(state, 'bomi').ok, false);
});

test('Cafemong food preferences grant category and taste bonuses independently', () => {
  const make = () => {
    const state = createGame();
    Object.assign(state.character, { hunger: 10, mood: 10, bond: 0, hp: 50 });
    return state;
  };
  const favorite = make();
  assert.equal(feedCharacter(favorite, 'snack').ok, true);
  assert.equal(favorite.character.hunger, 48); // 25 base + 10 snack group + 3 sweet taste
  assert.equal(favorite.character.mood, 20);
  assert.equal(favorite.character.bond, 2);
  assert.equal(favorite.character.hp, 62);
  assert.equal(favorite.gold, 110);
  const singleTaste = make();
  feedCharacter(singleTaste, 'fruit');
  assert.equal(singleTaste.character.hunger, 38);
  assert.equal(singleTaste.character.mood, 16);
  assert.equal(singleTaste.character.bond, 1);
  const unrelated = make();
  feedCharacter(unrelated, 'meat');
  assert.equal(unrelated.character.hunger, 35);
  assert.equal(unrelated.character.mood, 14);
  assert.equal(unrelated.character.bond, 0);
  assert.equal(feedCharacter(unrelated, 'not-food').ok, false);
  assert.equal(unrelated.gold, 110);
});

function duel(overrides = {}, monsterType = 'grove') {
  const state = createGame();
  Object.assign(state.character, overrides);
  state.character.x = 280;
  state.monsters.push({ id: 'm900', portalId: 'p900', type: monsterType, name: '연습 상대', x: 310, hp: 1000, maxHp: 1000, attack: 10, level: 5, defense: 0, resistance: 0, cooldown: 0, facing: -1 });
  setCommand(state, 'fight');
  return state;
}

test('magic consumes mana, uses magic power and falls back to physical damage when exhausted', () => {
  const state = duel();
  const mana = state.character.mana;
  stepGame(state, 0.1);
  assert.equal(state.character.mana, mana - 6);
  assert.equal(state.monsters[0].hp, 1000 - Math.round(state.character.magic * 1.6));
  state.character.mana = 0;
  state.cooldowns.attack = 0;
  const hp = state.monsters[0].hp;
  stepGame(state, 0.1);
  assert.equal(state.monsters[0].hp, hp - state.character.attack);
  assert.equal(state.character.mana, 0);
  setCommand(state, 'rest');
  advance(state, 1);
  assert.ok(state.character.mana >= 3 && state.character.mana <= 3.4);
  const restingHp = state.character.hp;
  advance(state, 20);
  assert.equal(state.character.mana, state.character.maxMana);
  assert.ok(state.character.hp >= restingHp);
});

test('physical defense and magic resistance mitigate their respective incoming damage', () => {
  const physical = duel({}, 'grove');
  const magic = duel({}, 'crystal');
  const start = physical.character.hp;
  stepGame(physical, 0.1);
  stepGame(magic, 0.1);
  assert.equal(start - physical.character.hp, Math.round(10 - physical.character.defense * 0.35));
  assert.equal(start - magic.character.hp, Math.round(10 - magic.character.resistance * 0.35));
  assert.ok(magic.character.hp > physical.character.hp);
  const warded = duel({ resistance: 20 }, 'crystal');
  const wardedStart = warded.character.hp;
  stepGame(warded, 0.1);
  assert.ok(wardedStart - warded.character.hp < start - magic.character.hp);
});

test('fractional speed growth changes real movement and attack cadence at every level', () => {
  const first = createGame();
  const second = createGame({ version: 3, activeCharacterId: 'cafemong', characters: [{ id: 'cafemong', level: 2 }] });
  assert.equal(first.character.speed, 8);
  assert.equal(second.character.speed, 8.5);
  assert.deepEqual(Object.fromEntries(['maxHp', 'maxMana', 'attack', 'defense', 'magic', 'resistance', 'speed'].map(key => [key, second.character[key]])), { maxHp: 140, maxMana: 35, attack: 7, defense: 6, magic: 16, resistance: 12, speed: 8.5 });
  const slow = duel({ speed: first.character.speed });
  const fast = duel({ speed: second.character.speed });
  stepGame(slow, 0.1); stepGame(fast, 0.1);
  assert.ok(fast.cooldowns.attack < slow.cooldowns.attack);
  slow.monsters[0].x = fast.monsters[0].x = 900;
  const slowX = slow.character.x, fastX = fast.character.x;
  stepGame(slow, 0.1); stepGame(fast, 0.1);
  assert.ok(fast.character.x - fastX > slow.character.x - slowX);
  deployCore(first, 'grove', 500); setCommand(first, 'fight'); advance(first, 60);
  assert.equal(first.character.level, 2);
  assert.equal(first.character.speed, 8.5);
  assert.equal(createGame(serializeGame(first)).character.speed, 8.5);
});

test('custom metadata validates seven base and growth fields and allows zero to two tastes', () => {
  for (const tastes of [[], ['sweet'], ['sweet', 'sour']]) {
    const checked = validateCustomDefinition(customInput({ tastePreferences: tastes }));
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.definition.tastePreferences, tastes);
    assert.equal(Object.keys(checked.definition.baseStats).length, 7);
    assert.equal(Object.keys(checked.definition.growthStats).length, 7);
  }
  for (const tastes of [['sweet', 'sweet'], ['sweet', 'sour', 'bitter'], ['invalid'], 'sweet']) assert.equal(validateCustomDefinition(customInput({ tastePreferences: tastes })).ok, false);
  for (const field of STAT_FIELDS) {
    for (const value of [NaN, Infinity, '3', field.min - 1, field.max + 1, 3.5]) {
      const input = customInput(); input.baseStats[field.key] = value;
      assert.equal(validateCustomDefinition(input).ok, false, `${field.key} rejects invalid base ${value}`);
    }
    for (const value of [NaN, Infinity, '3', -1, field.growthMax + 1, 0.333]) {
      const input = customInput(); input.growthStats[field.key] = value;
      assert.equal(validateCustomDefinition(input).ok, false, `${field.key} rejects invalid growth ${value}`);
    }
  }
  assert.equal(validateCustomDefinition(customInput({ name: '' })).ok, false);
  assert.equal(validateCustomDefinition(customInput({ name: '하'.repeat(25) })).ok, false);
  assert.equal(validateCustomDefinition(customInput({ foodPreference: 'stone' })).ok, false);
  assert.equal(validateCustomDefinition(customInput({ id: 'lumi' })).ok, false);
  assert.equal(validateCustomDefinition(customInput({ sheetId: 'other-sheet' })).ok, false);
});

test('custom definitions project safe metadata and never retain external sprite URLs or pixels', () => {
  const input = customInput({
    sprite: 'https://untrusted.example/character.svg', restSprite: 'data:image/png;base64,secret',
    image: 'binary-image-payload', blob: { data: 'raw-pixels' }, extra: { prototype: 'ignored' },
  });
  const checked = validateCustomDefinition(input);
  assert.equal(checked.ok, true);
  assert.equal(checked.definition.sprite, 'assets/character-placeholder.svg');
  assert.equal(checked.definition.restSprite, 'assets/character-placeholder.svg');
  for (const field of ['image', 'blob', 'extra']) assert.equal(field in checked.definition, false);
  input.baseStats.hp = 500;
  input.tastePreferences.push('bitter');
  assert.equal(checked.definition.baseStats.hp, 100);
  assert.deepEqual(checked.definition.tastePreferences, ['sweet', 'sour']);
  assert.deepEqual(SPRITE_SHEET, { width: 1536, height: 2400, columns: 8, rows: 10, frameWidth: 192, frameHeight: 240 });
  assert.deepEqual(ANIMATION_KEYS, ['idle', 'walk', 'pet', 'doze', 'sleep', 'battleIdle', 'battleRun', 'attack', 'strongAttack', 'collapse']);
});

test('custom creation adds one acquired companion without swapping or spending resources', () => {
  const state = createGame();
  const original = state.character;
  const added = createCustomCharacter(state, customInput());
  assert.equal(added.ok, true);
  assert.equal(state.character, original);
  assert.equal(state.activeCharacterId, 'cafemong');
  assert.equal(state.gold, 120);
  assert.equal(state.characters.length, 2);
  assert.equal(state.customDefinitions.length, 1);
  assert.equal(state.characters[1].custom, true);
  assert.equal(state.characters[1].sheetId, CUSTOM_ID);
  assert.equal(createCustomCharacter(state, customInput()).ok, false);
  assert.equal(state.characters.length, 2);
  assert.equal(state.customDefinitions.length, 1);
  assert.equal(selectCharacter(state, CUSTOM_ID).ok, true);
  assert.equal(state.character.name, '하루');
  assert.equal(state.character, state.characters[1]);
  assert.equal(getNextCompanion(state), null);
});

test('custom progression persists, derived stats ignore forged values, invalid definitions are dropped', () => {
  const state = createGame();
  createCustomCharacter(state, customInput({ tastePreferences: [] }));
  selectCharacter(state, CUSTOM_ID);
  Object.assign(state.character, { hp: 53, mana: 9, hunger: 42, mood: 37, bond: 12, xp: 17 });
  petCharacter(state);
  const payload = JSON.parse(serializeGame(state));
  assert.equal(payload.version, 3);
  assert.equal(payload.customDefinitions[0].sheetId, CUSTOM_ID);
  assert.equal(JSON.stringify(payload).includes('data:image'), false);
  assert.equal('animationState' in payload.character, false);
  payload.characters[1].attack = 9999;
  payload.characters[1].sprite = 'https://evil.example/sheet.png';
  payload.customDefinitions.push({ ...payload.customDefinitions[0] });
  payload.customDefinitions.push(customInput({ id: 'invalid' }));
  const restored = createGame(payload);
  assert.equal(restored.character.id, CUSTOM_ID);
  assert.equal(restored.character, restored.characters[1]);
  assert.equal(restored.cooldowns, restored.character.cooldowns);
  assert.equal(restored.customDefinitions.length, 1);
  assert.equal(restored.character.attack, 8);
  assert.equal(restored.character.sprite, 'assets/character-placeholder.svg');
  assert.equal(restored.character.hp, 53);
  assert.equal(restored.character.mana, 9);
  assert.equal(restored.character.hunger, 42);
  assert.equal(restored.character.xp, 17);
  assert.deepEqual(restored.character.tastePreferences, []);
  assert.equal(petCharacter(restored).ok, false);
  payload.customDefinitions = [];
  const orphaned = createGame(payload);
  assert.equal(orphaned.characters.length, 1);
  assert.equal(orphaned.character.id, 'cafemong');
});

test('custom per-level growth is floored consistently on reload and actual combat level-up', () => {
  const state = createGame();
  const growthStats = { hp: 7.5, mana: 2.25, attack: 1.5, defense: 0.5, magic: 1.25, resistance: 0.75, speed: 0.25 };
  createCustomCharacter(state, customInput({ growthStats }));
  selectCharacter(state, CUSTOM_ID);
  state.character.level = 4;
  state.character.xp = 111;
  const restored = createGame(serializeGame(state));
  assert.equal(restored.character.maxHp, 122);
  assert.equal(restored.character.maxMana, 36);
  assert.equal(restored.character.attack, 12);
  assert.equal(restored.character.defense, 4);
  assert.equal(restored.character.magic, 8);
  assert.equal(restored.character.resistance, 5);
  assert.equal(restored.character.speed, 10);
  deployCore(restored, 'grove', 500);
  setCommand(restored, 'fight');
  advance(restored, 60);
  assert.equal(restored.character.level, 5);
  assert.equal(restored.character.maxHp, 130);
  assert.equal(restored.character.maxMana, 39);
  assert.equal(restored.character.attack, 14);
  assert.equal(restored.character.defense, 5);
  assert.equal(restored.character.magic, 10);
  assert.equal(restored.character.resistance, 6);
  assert.equal(restored.character.speed, 11);
  assert.equal(restored.characters.find(c => c.id === 'cafemong').level, 1);
});

test('v2 active prototype progress migrates into Cafemong and other prototypes disappear', () => {
  const state = createGame({
    version: 2, stats: { clears: 12 }, activeCharacterId: 'bomi', gold: 345,
    characters: [{ id: 'lumi', level: 4, hp: 54, xp: 8 }, { id: 'bomi', level: 5, hp: 77, mana: 12, xp: 21, cooldowns: { pet: 2 } }, { id: 'sol', level: 9 }],
  });
  assert.equal(state.version, 3);
  assert.deepEqual(state.customDefinitions, []);
  assert.deepEqual(state.characters.map(c => c.id), ['cafemong']);
  assert.equal(state.activeCharacterId, 'cafemong');
  assert.equal(state.character.hp, 77);
  assert.equal(state.character.mana, 12);
  assert.equal(state.character.maxHp, 170);
  assert.equal(state.character.maxMana, 50);
  assert.equal(state.character.speed, 10);
  assert.equal(state.character.xp, 21);
  assert.equal(state.gold, 345);
  assert.equal(petCharacter(state).ok, false);
});

test('v3 migration preserves active custom companions and prioritizes existing Cafemong progress', () => {
  const state = createGame({
    version: 3, activeCharacterId: CUSTOM_ID, customDefinitions: [customInput()], gold: 888,
    characters: [{ id: 'lumi', level: 20 }, { id: 'bomi', level: 40 }, { id: 'cafemong', level: 3, xp: 12 }, { id: CUSTOM_ID, level: 6, hp: 75, xp: 17 }],
  });
  assert.deepEqual(state.characters.map(c => c.id), ['cafemong', CUSTOM_ID]);
  assert.equal(state.characters[0].level, 3);
  assert.equal(state.characters[0].xp, 12);
  assert.equal(state.activeCharacterId, CUSTOM_ID);
  assert.equal(state.character.hp, 75);
  assert.equal(state.character.level, 6);
  assert.equal(state.customDefinitions[0].sheetId, CUSTOM_ID);
  assert.equal(state.gold, 888);
  const payload = JSON.parse(serializeGame(state));
  assert.ok(!payload.characters.some(c => ['lumi', 'bomi'].includes(c.id)));
  assert.equal(createGame(payload).character.id, CUSTOM_ID);
});

test('migration never grafts mismatched or orphan custom backup progress onto the base', () => {
  const orphan = createGame({ version: 3, character: { id: CUSTOM_ID, level: 49 } });
  assert.equal(orphan.character.id, 'cafemong');
  assert.equal(orphan.character.level, 1);
  const mismatched = createGame({
    version: 3, activeCharacterId: 'bomi', characters: [{ id: 'lumi', level: 8 }],
    character: { id: CUSTOM_ID, level: 49 },
  });
  assert.equal(mismatched.character.id, 'cafemong');
  assert.equal(mismatched.character.level, 8);
  const missingActive = createGame({ version: 3, activeCharacterId: 'bomi', character: { id: 'bomi', level: 9, xp: 18 } });
  assert.equal(missingActive.character.id, 'cafemong');
  assert.equal(missingActive.character.level, 9);
  assert.equal(missingActive.character.xp, 18);
});

test('matching redundant active custom progress repairs a damaged roster without replacing the base', () => {
  const state = createGame({
    version: 3, activeCharacterId: CUSTOM_ID, customDefinitions: [customInput()],
    characters: [null], character: { id: CUSTOM_ID, level: 9, xp: 18, hp: 75 },
  });
  assert.equal(state.activeCharacterId, CUSTOM_ID);
  assert.equal(state.character.level, 9);
  assert.equal(state.character.hp, 75);
  assert.equal(state.characters[0].id, 'cafemong');
  assert.equal(state.characters[0].level, 1);
  assert.equal(createGame(serializeGame(state)).character.xp, 18);
});

test('pet, doze and sleep animations have finite transitions and never resume stale save frames', () => {
  const state = createGame();
  assert.equal(state.character.animationState, 'idle');
  petCharacter(state);
  assert.equal(state.character.animationState, 'pet');
  const x = state.character.x;
  stepGame(state, 0.25);
  assert.equal(state.character.animationState, 'pet');
  assert.equal(state.character.animationTime, 0.25);
  assert.equal(state.character.x, x);
  advance(state, 1.1);
  assert.notEqual(state.character.animationState, 'pet');
  setCommand(state, 'rest');
  assert.equal(state.character.animationState, 'doze');
  advance(state, 2);
  assert.equal(state.character.animationState, 'doze');
  advance(state, 1.1);
  assert.equal(state.character.animationState, 'sleep');
  const restored = createGame(serializeGame(state));
  assert.equal(restored.character.animationState, 'doze');
  assert.equal(restored.character.animationTime, 0);
  assert.equal(restored.character.animationTimer, 0);
});

test('battle animations distinguish standby, running, physical attacks and strong magic attacks', () => {
  const state = createGame();
  setCommand(state, 'fight');
  assert.equal(state.character.animationState, 'battleIdle');
  stepGame(state, 0.1);
  assert.equal(state.character.animationState, 'battleIdle');
  deployCore(state, 'grove', 900);
  advance(state, 2);
  assert.equal(state.character.animationState, 'battleRun');
  const physical = duel({ mana: 0 });
  stepGame(physical, 0.1);
  assert.equal(physical.character.animationState, 'attack');
  const magic = duel();
  stepGame(magic, 0.1);
  assert.equal(magic.character.animationState, 'strongAttack');
  assert.equal(magic.character.animationTime, 0);
});

test('knockout plays collapse before safe dozing and sleeping while health recovers', () => {
  const state = duel();
  state.character.hp = 1;
  stepGame(state, 0.1);
  assert.equal(state.character.command, 'rest');
  assert.equal(state.character.animationState, 'collapse');
  assert.equal(state.character.animationTimer, 2);
  assert.equal(setCommand(state, 'fight').ok, false);
  const hp = state.character.hp;
  advance(state, 1);
  assert.equal(state.character.animationState, 'collapse');
  assert.ok(state.character.hp > hp);
  advance(state, 1.1);
  assert.equal(state.character.animationState, 'doze');
  advance(state, 3.1);
  assert.equal(state.character.animationState, 'sleep');
  assert.equal(state.monsters.length, 1);
});

test('minimum-health custom heroes preserve knockout recovery across an immediate save', () => {
  for (const maxHp of [1, 2, 3]) {
    const input = customInput();
    input.baseStats.hp = maxHp;
    const state = createGame();
    createCustomCharacter(state, input);
    selectCharacter(state, CUSTOM_ID);
    state.monsters.push({ id: 'm901', portalId: 'p901', type: 'grove', name: '연습 상대', x: 310, hp: 1000, maxHp: 1000, attack: 100, level: 5, defense: 0, resistance: 0, cooldown: 0, facing: -1 });
    setCommand(state, 'fight');
    stepGame(state, 0.1);
    assert.equal(state.character.animationState, 'collapse');
    assert.ok(state.character.hp > 0 && state.character.hp <= maxHp);
    const restored = createGame(serializeGame(state));
    assert.equal(restored.character.hp, state.character.hp);
    assert.equal(restored.character.maxHp, maxHp);
  }
});

const SECOND_CUSTOM_ID = 'custom_11234567-89ab-4cde-8fab-0123456789ab';
const REVISION_SHEET_ID = 'custom_21234567-89ab-4cde-8fab-0123456789ab';

test('active custom edits preserve identity and live progress while recalculating all level stats', () => {
  const state = createGame({
    version: 3, customDefinitions: [customInput()], activeCharacterId: CUSTOM_ID,
    characters: [{ id: CUSTOM_ID, level: 4, xp: 19, hp: 75, mana: 12, hunger: 26, mood: 31, bond: 9, command: 'fight', x: 711, facing: -1 }],
  });
  const character = state.character, cooldowns = state.cooldowns;
  Object.assign(character, { action: 'attack', animationState: 'strongAttack', animationTime: 0.2, animationTimer: 0.3, animationDuration: 0.5, restTime: 0, strikes: 2 });
  Object.assign(cooldowns, { attack: 0.6, hit: 0.3, pet: 1.4, feed: 2.7, wander: 3 });
  const preservedKeys = ['id', 'level', 'xp', 'hp', 'mana', 'hunger', 'mood', 'bond', 'command', 'x', 'facing', 'action', 'animationState', 'animationTime', 'animationTimer', 'animationDuration', 'restTime', 'strikes'];
  const before = Object.fromEntries(preservedKeys.map(key => [key, character[key]]));
  const beforeCooldowns = { ...cooldowns };
  const changed = customInput({
    name: '달빛 하루', title: '수정한 소개', personality: '장난기가 많고 밝아요.',
    foodPreference: 'snack', tastePreferences: ['bitter', 'sweet'], sheetId: REVISION_SHEET_ID,
    baseStats: { hp: 180, mana: 50, attack: 20, defense: 12, magic: 23, resistance: 14, speed: 16 },
    growthStats: { hp: 10.5, mana: 3.25, attack: 2.5, defense: 1.5, magic: 3.25, resistance: 2.5, speed: 0.75 },
  });
  const result = updateCustomCharacter(state, CUSTOM_ID, changed);
  assert.equal(result.ok, true);
  assert.equal(result.previousDefinition.sheetId, CUSTOM_ID);
  assert.equal(state.character, character);
  assert.equal(state.characters.find(item => item.id === CUSTOM_ID), character);
  assert.equal(state.cooldowns, cooldowns);
  assert.deepEqual(cooldowns, beforeCooldowns);
  for (const key of preservedKeys) assert.equal(character[key], before[key], key);
  assert.equal(character.name, '달빛 하루');
  assert.equal(character.title, changed.title);
  assert.equal(character.personality, changed.personality);
  assert.equal(character.foodPreference, 'snack');
  assert.deepEqual(character.tastePreferences, ['bitter', 'sweet']);
  assert.equal(character.sheetId, REVISION_SHEET_ID);
  assert.deepEqual(Object.fromEntries(['maxHp', 'maxMana', 'attack', 'defense', 'magic', 'resistance', 'speed'].map(key => [key, character[key]])), {
    maxHp: 211, maxMana: 59, attack: 27, defense: 16, magic: 32, resistance: 21, speed: 18,
  });
  const restored = createGame(serializeGame(state));
  assert.equal(restored.character.name, changed.name);
  assert.equal(restored.character.level, 4);
  assert.equal(restored.character.xp, 19);
  assert.equal(restored.character.hp, 75);
  assert.equal(restored.character.mana, 12);
  assert.equal(restored.character.sheetId, REVISION_SHEET_ID);
  assert.equal(restored.character.maxHp, 211);
  assert.equal(restored.customDefinitions[0].id, CUSTOM_ID);
  assert.equal(restored.customDefinitions[0].sheetId, REVISION_SHEET_ID);
  // Input arrays/objects cannot mutate a committed definition through aliases.
  changed.tastePreferences.push('sour'); changed.baseStats.hp = 999;
  assert.deepEqual(character.tastePreferences, ['bitter', 'sweet']);
  assert.equal(state.customDefinitions[0].baseStats.hp, 180);
});

test('inactive custom edits leave the active companion and world unchanged and never heal for free', () => {
  const state = createGame();
  createCustomCharacter(state, customInput());
  const active = state.character, activeBefore = structuredClone(active);
  const custom = state.characters[1];
  custom.hp = 45; custom.mana = 10;
  deployCore(state, 'grove', 800);
  const world = JSON.stringify({ gold: state.gold, inventory: state.inventory, portals: state.portals, monsters: state.monsters, effects: state.effects, wanderTarget: state.wanderTarget });
  // Deployment changes active speech, so capture its resulting live state.
  Object.assign(activeBefore, structuredClone(active));
  const stats = customInput().baseStats;
  assert.equal(updateCustomCharacter(state, CUSTOM_ID, { name: '작은 하루', baseStats: { ...stats, hp: 20, mana: 0 } }).ok, true);
  assert.equal(custom.maxHp, 20); assert.equal(custom.hp, 20);
  assert.equal(custom.maxMana, 0); assert.equal(custom.mana, 0);
  assert.equal(updateCustomCharacter(state, CUSTOM_ID, { baseStats: { ...stats, hp: 200, mana: 100 } }).ok, true);
  assert.equal(custom.maxHp, 200); assert.equal(custom.hp, 20);
  assert.equal(custom.maxMana, 100); assert.equal(custom.mana, 0);
  assert.equal(custom.sheetId, CUSTOM_ID);
  assert.equal(state.character, active);
  assert.deepEqual(active, activeBefore);
  assert.equal(JSON.stringify({ gold: state.gold, inventory: state.inventory, portals: state.portals, monsters: state.monsters, effects: state.effects, wanderTarget: state.wanderTarget }), world);
});

test('invalid updates and all base edits/deletes fail without changing any live state', () => {
  const state = createGame();
  createCustomCharacter(state, customInput());
  for (const [characterId, patch] of [
    ['cafemong', { name: '변경 금지' }], ['missing', { name: '없음' }], [CUSTOM_ID, null],
    [CUSTOM_ID, []], [CUSTOM_ID, { id: SECOND_CUSTOM_ID }], [CUSTOM_ID, { name: '' }],
    [CUSTOM_ID, { sheetId: 'https://invalid.example/image.png' }],
    [CUSTOM_ID, { tastePreferences: ['sweet', 'sour', 'bitter'] }],
    [CUSTOM_ID, { baseStats: { ...customInput().baseStats, hp: 0 } }],
  ]) {
    const before = JSON.stringify(state);
    assert.equal(updateCustomCharacter(state, characterId, patch).ok, false);
    assert.equal(JSON.stringify(state), before);
  }
  for (const characterId of ['cafemong', 'missing']) {
    const before = JSON.stringify(state);
    assert.equal(deleteCustomCharacter(state, characterId).ok, false);
    assert.equal(JSON.stringify(state), before);
  }
});

test('independent sheet revisions roundtrip but companions cannot share a persisted sprite record', () => {
  const state = createGame();
  const first = customInput({ sheetId: REVISION_SHEET_ID });
  assert.equal(validateCustomDefinition(first).ok, true);
  assert.equal(createCustomCharacter(state, first).ok, true);
  const second = customInput({ id: SECOND_CUSTOM_ID, sheetId: SECOND_CUSTOM_ID });
  let before = JSON.stringify(state);
  assert.equal(createCustomCharacter(state, { ...second, sheetId: REVISION_SHEET_ID }).ok, false);
  assert.equal(JSON.stringify(state), before);
  assert.equal(createCustomCharacter(state, second).ok, true);
  before = JSON.stringify(state);
  assert.equal(updateCustomCharacter(state, SECOND_CUSTOM_ID, { sheetId: REVISION_SHEET_ID }).ok, false);
  assert.equal(JSON.stringify(state), before);
  const payload = JSON.parse(serializeGame(state));
  payload.customDefinitions[1].sheetId = REVISION_SHEET_ID;
  const restored = createGame(payload);
  assert.deepEqual(restored.customDefinitions.map(item => item.id), [CUSTOM_ID]);
  assert.deepEqual(restored.characters.map(item => item.id), ['cafemong', CUSTOM_ID]);
  assert.equal(restored.customDefinitions[0].sheetId, REVISION_SHEET_ID);
});

test('deleting an inactive companion preserves others and cannot restore its old progress on reload', () => {
  const state = createGame();
  createCustomCharacter(state, customInput());
  createCustomCharacter(state, customInput({ id: SECOND_CUSTOM_ID, sheetId: SECOND_CUSTOM_ID, name: '두 번째 친구' }));
  selectCharacter(state, SECOND_CUSTOM_ID);
  Object.assign(state.character, { hp: 61, mana: 8, xp: 23, bond: 12 });
  const active = state.character, activeBefore = structuredClone(active);
  const removed = deleteCustomCharacter(state, CUSTOM_ID);
  assert.equal(removed.ok, true);
  assert.equal(removed.definition.id, CUSTOM_ID);
  assert.equal(removed.definition.sheetId, CUSTOM_ID);
  assert.equal(removed.activeCharacterId, SECOND_CUSTOM_ID);
  assert.equal(state.character, active);
  assert.deepEqual(active, activeBefore);
  const payload = JSON.parse(serializeGame(state));
  assert.deepEqual(payload.customDefinitions.map(item => item.id), [SECOND_CUSTOM_ID]);
  assert.deepEqual(payload.characters.map(item => item.id), ['cafemong', SECOND_CUSTOM_ID]);
  const restored = createGame(payload);
  assert.deepEqual(restored.characters.map(item => item.id), ['cafemong', SECOND_CUSTOM_ID]);
  assert.equal(restored.character.id, SECOND_CUSTOM_ID);
  assert.equal(restored.character.xp, 23);
  assert.equal(restored.character.bond, 12);
  assert.equal(selectCharacter(restored, CUSTOM_ID).ok, false);
  assert.equal(deleteCustomCharacter(restored, CUSTOM_ID).ok, false);
});

test('deleting an active custom companion during combat falls back to Cafemong without losing the dungeon', () => {
  const state = createGame();
  const base = state.character;
  Object.assign(base, { hp: 67, mana: 11, xp: 13, bond: 4, command: 'rest' });
  createCustomCharacter(state, customInput());
  selectCharacter(state, CUSTOM_ID);
  state.character.x = 600; state.character.facing = -1;
  deployCore(state, 'grove', 600);
  setCommand(state, 'rest'); advance(state, 2);
  setCommand(state, 'fight');
  const world = JSON.stringify({ gold: state.gold, inventory: state.inventory, stats: state.stats, portals: state.portals, monsters: state.monsters, elapsed: state.elapsed });
  assert.equal(selectCharacter(state, 'cafemong').ok, false, 'Ordinary combat switching is still blocked');
  state.effects.push({ id: 'e999', x: 600, text: 'old attack', kind: 'damage', life: 1 });
  const deleted = deleteCustomCharacter(state, CUSTOM_ID);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.activeCharacterId, 'cafemong');
  assert.equal(state.character, base);
  assert.equal(state.cooldowns, base.cooldowns);
  assert.equal(base.x, 600); assert.equal(base.facing, -1);
  assert.equal(base.hp, 67); assert.equal(base.mana, 11); assert.equal(base.xp, 13); assert.equal(base.bond, 4);
  assert.equal(state.wanderTarget, 600);
  assert.equal(base.action, 'rest'); assert.equal(base.animationState, 'doze'); assert.equal(base.animationTime, 0);
  assert.deepEqual(state.effects, []);
  assert.deepEqual(state.characters.map(item => item.id), ['cafemong']);
  assert.deepEqual(state.customDefinitions, []);
  assert.equal(JSON.stringify({ gold: state.gold, inventory: state.inventory, stats: state.stats, portals: state.portals, monsters: state.monsters, elapsed: state.elapsed }), world);
  const restored = createGame(serializeGame(state));
  assert.equal(restored.character.id, 'cafemong');
  assert.deepEqual(restored.customDefinitions, []);
  assert.deepEqual(restored.monsters, state.monsters);
  assert.deepEqual(restored.portals, state.portals);
  assert.doesNotThrow(() => stepGame(restored, 0.1));
});

function lootEncounter(type = 'grove') {
  const state = createGame();
  state.character.x = 550;
  state.character.command = 'fight';
  state.cooldowns.attack = 0;
  state.inventory[type] = 1;
  assert.equal(deployCore(state, type, 550).ok, true);
  const portal = state.portals[0];
  portal.spawnIn = 5; portal.remaining = 0; portal.defeated = portal.total - 1;
  state.monsters.push({
    id: 'm999', portalId: portal.id, type, name: CORE_TYPES.find(core => core.id === type).monsterName,
    x: 550, hp: 1, maxHp: 1, attack: 0, level: 1, defense: 0, resistance: 0, cooldown: 2, facing: -1,
  });
  return state;
}

test('monster tables provide independent common and rare material rolls for every dungeon', () => {
  assert.equal(ITEM_TYPES.length, 6);
  assert.equal(new Set(ITEM_TYPES.map(item => item.id)).size, 6);
  for (const core of CORE_TYPES) {
    const drops = MONSTER_DROPS[core.id];
    assert.equal(drops.length, 2);
    assert.deepEqual(drops.map(drop => drop.chance), [0.6, 0.1]);
    for (const drop of drops) {
      const item = ITEM_TYPES.find(item => item.id === drop.itemId);
      assert.equal(item.monsterType, core.id);
      assert.equal(item.icon, `assets/items/${item.id}.svg`);
      assert.equal(drop.quantity, 1);
    }
  }
});

test('actual kills award each passing drop once, preserve core counts, and never reroll on reload', () => {
  for (const core of CORE_TYPES) {
    const state = lootEncounter(core.id);
    const inventory = { ...state.inventory };
    let rolls = 0;
    stepGame(state, 0.1, 1280, () => { rolls++; return 0; });
    assert.equal(rolls, 2, 'Each authored material is rolled once for one actual defeat');
    assert.equal(state.stats.kills, 1);
    assert.equal(state.monsters.length, 0);
    assert.deepEqual(state.inventory, inventory, 'Loot never enters or spends the dungeon-core inventory');
    const droppedIds = MONSTER_DROPS[core.id].map(drop => drop.itemId);
    assert.deepEqual(ITEM_TYPES.filter(item => state.items[item.id]).map(item => item.id), droppedIds);
    assert.ok(droppedIds.every(itemId => state.items[itemId] === 1));
    const lootEffects = state.effects.filter(effect => effect.kind === 'loot');
    assert.deepEqual(lootEffects.map(effect => effect.itemId), droppedIds);
    assert.deepEqual(lootEffects.map(effect => effect.lootIndex), [0, 1]);
    assert.ok(lootEffects.every(effect => effect.text.includes('×1') && effect.life === 1.4));
    assert.equal(state.logs.filter(entry => entry.text.includes('창고에 보관')).length, 2);
    const restored = createGame(serializeGame(state));
    assert.deepEqual(restored.items, state.items);
    assert.equal(restored.effects.filter(effect => effect.kind === 'loot').length, 0);
    stepGame(restored, 0.25, 1280, () => { throw new Error('Defeated monsters must not roll again'); });
    assert.deepEqual(restored.items, state.items);
    assert.equal(restored.stats.kills, 1);
  }
});

test('loot chance thresholds are exclusive and common/rare rolls are independent', () => {
  for (const [rolls, expected] of [
    [[0.6, 0.1], [0, 0]],
    [[0.599999, 0.1], [1, 0]],
    [[0.6, 0.099999], [0, 1]],
    [[0.599999, 0.099999], [1, 1]],
    [[0.999999, 0.999999], [0, 0]],
  ]) {
    const state = lootEncounter();
    let index = 0;
    stepGame(state, 0.1, 1280, () => rolls[index++]);
    assert.equal(index, 2);
    assert.deepEqual([state.items.slime_gel, state.items.forest_seed], expected);
  }
  for (const invalid of [NaN, Infinity, -0.1, 1, 2, undefined, null, '0']) {
    const state = lootEncounter();
    stepGame(state, 0.1, 1280, () => invalid);
    assert.equal(Object.values(state.items).reduce((sum, count) => sum + count, 0), 0);
  }
  const throwing = lootEncounter();
  assert.doesNotThrow(() => stepGame(throwing, 0.1, 1280, () => { throw new Error('Invalid random provider'); }));
  assert.equal(Object.values(throwing.items).reduce((sum, count) => sum + count, 0), 0);
});

test('warehouse counts sanitize old/damaged saves and saturate without phantom loot', () => {
  const old = createGame({ version: 3, gold: 456, inventory: { grove: 4, mushroom: 3, crystal: 2 } });
  assert.deepEqual(old.items, Object.fromEntries(ITEM_TYPES.map(item => [item.id, 0])));
  assert.equal(old.gold, 456);
  assert.deepEqual(old.inventory, { grove: 4, mushroom: 3, crystal: 2 });
  const damaged = createGame({ items: {
    slime_gel: -5, forest_seed: Infinity, mushroom_spore: '25', glowing_mushroom: 2.75,
    crystal_shard: MAX_ITEM_STACK + 100, moon_crystal: NaN, unknown_item: 900,
  } });
  assert.deepEqual(damaged.items, { slime_gel: 0, forest_seed: 0, mushroom_spore: 0, glowing_mushroom: 2, crystal_shard: MAX_ITEM_STACK, moon_crystal: 0 });
  const state = lootEncounter();
  state.items.slime_gel = MAX_ITEM_STACK;
  state.items.forest_seed = MAX_ITEM_STACK - 1;
  stepGame(state, 0.1, 1280, () => 0);
  assert.equal(state.items.slime_gel, MAX_ITEM_STACK);
  assert.equal(state.items.forest_seed, MAX_ITEM_STACK);
  assert.deepEqual(state.effects.filter(effect => effect.kind === 'loot').map(effect => effect.itemId), ['forest_seed']);
  assert.deepEqual(createGame(serializeGame(state)).items, state.items);
});

test('character size defaults to two, persists valid choices, and rejects invalid values without mutation', () => {
  assert.deepEqual(createGame().settings, { characterScale: 2, windowWalking: true });
  assert.deepEqual(createGame({ version: 3, gold: 777 }).settings, { characterScale: 2, windowWalking: true });
  for (const scale of [1, 2, 3]) {
    const state = createGame();
    assert.equal(setCharacterScale(state, scale, 1280).ok, true);
    assert.equal(state.settings.characterScale, scale);
    assert.equal(createGame(serializeGame(state)).settings.characterScale, scale);
  }
  const state = createGame();
  for (const scale of [0, 4, 1.5, NaN, Infinity, '2', null, undefined]) {
    const before = JSON.stringify(state);
    assert.equal(setCharacterScale(state, scale).ok, false);
    assert.equal(JSON.stringify(state), before);
    assert.equal(createGame({ settings: { characterScale: scale } }).settings.characterScale, 2);
  }
});

test('scaled display bounds clamp placement and zero-time resize while world actors keep their bounds', () => {
  for (const scale of [1, 2, 3]) {
    const state = createGame();
    const edge = 48 * scale;
    assert.deepEqual(getCharacterBounds(390, scale), { low: edge, high: 390 - edge });
    state.character.x = -500; state.wanderTarget = 1000;
    assert.equal(setCharacterScale(state, scale, 390).ok, true);
    assert.equal(state.character.x, edge);
    assert.equal(state.wanderTarget, 390 - edge);
    state.character.x = 1000; state.wanderTarget = -500;
    deployCore(state, 'grove', 1000, 390);
    stepGame(state, 0, 390);
    assert.equal(state.character.x, 390 - edge);
    assert.equal(state.wanderTarget, edge);
    assert.equal(state.portals[0].x, 352, 'Dungeon objects keep the original 38px margin');
    state.character.command = 'wander'; state.cooldowns.wander = 0;
    stepGame(state, 0.1, 390, () => 0);
    assert.equal(state.wanderTarget, edge);
    assert.ok(state.character.x >= edge && state.character.x <= 390 - edge);
    stepGame(state, 0, 100);
    const narrow = getCharacterBounds(100, scale);
    assert.ok(state.character.x >= narrow.low && state.character.x <= narrow.high);
  }
  assert.deepEqual(getCharacterBounds(100, 3), { low: 50, high: 50 });
});

test('scale changes do not alter combat stats, speed, or center-screen attack reach', () => {
  const stats = character => Object.fromEntries(['maxHp', 'maxMana', 'attack', 'defense', 'magic', 'resistance', 'speed', 'level', 'xp'].map(key => [key, character[key]]));
  const baseline = createGame();
  const expectedStats = stats(baseline.character);
  const outcomes = [];
  for (const scale of [1, 2, 3]) {
    const state = createGame();
    setCharacterScale(state, scale, 1280);
    assert.deepEqual(stats(state.character), expectedStats);
    state.character.x = 500; state.character.command = 'wander'; state.wanderTarget = 900; state.cooldowns.wander = 5;
    stepGame(state, 0.2, 1280, () => 0.5);
    const moved = state.character.x;
    state.character.x = 500; state.character.command = 'fight';
    state.monsters.push({ id: 'm800', portalId: 'p800', type: 'grove', name: '숲 슬라임', x: 540, hp: 100, maxHp: 100, attack: 0, level: 1, defense: 0, resistance: 0, cooldown: 5, facing: -1 });
    stepGame(state, 0.01, 1280, () => 0.5);
    outcomes.push({ moved, enemyHp: state.monsters[0].hp, cooldown: state.cooldowns.attack, mana: state.character.mana });
  }
  assert.deepEqual(outcomes[1], outcomes[0]); assert.deepEqual(outcomes[2], outcomes[0]);
});

test('window walking defaults on for legacy saves and only persists boolean choices', () => {
  for (const saved of [undefined, { version: 3 }, { settings: { characterScale: 3 } }]) {
    assert.equal(createGame(saved).settings.windowWalking, true);
  }
  for (const enabled of [true, false]) {
    const state = createGame();
    const before = JSON.parse(serializeGame(state));
    assert.equal(setWindowWalking(state, enabled).ok, true);
    const after = JSON.parse(serializeGame(state));
    before.settings.windowWalking = enabled;
    assert.deepEqual(after, before, 'Toggling window walking must only change the display setting');
    assert.equal(createGame(serializeGame(state)).settings.windowWalking, enabled);
  }
  const state = createGame();
  setWindowWalking(state, false);
  for (const invalid of [0, 1, 'false', null, undefined, NaN, {}, []]) {
    const before = JSON.stringify(state);
    assert.equal(setWindowWalking(state, invalid).ok, false);
    assert.equal(JSON.stringify(state), before);
    assert.equal(createGame({ settings: { windowWalking: invalid } }).settings.windowWalking, true);
  }
});

test('an elevated character and ground monsters cannot hit each other or chase across height', () => {
  const state = duel();
  setCommand(state, 'wander');
  const enemy = state.monsters[0];
  enemy.x = state.character.x;
  const heroHp = state.character.hp, enemyHp = enemy.hp, mana = state.character.mana;
  for (let i = 0; i < 20; i++) stepGame(state, 0.25, 1280, () => 0.5, { onElevatedSurface: true });
  assert.equal(state.character.hp, heroHp);
  assert.equal(enemy.hp, enemyHp);
  assert.equal(state.character.mana, mana);
  enemy.x += 100;
  const enemyX = enemy.x, heroX = state.character.x;
  stepGame(state, 0.25, 1280, () => 0.5, { onElevatedSurface: true });
  assert.equal(enemy.x, enemyX, 'A nearby ground monster must not chase an elevated target');
  assert.equal(state.character.x, heroX);
});

test('elevated wandering leaves movement to the desktop controller while simulation and spawning continue', () => {
  const state = createGame();
  setCommand(state, 'wander');
  state.character.x = 500;
  state.wanderTarget = 900;
  state.cooldowns.wander = 0;
  state.cooldowns.attack = 1;
  deployCore(state, 'grove', 500);
  state.character.speechTime = 1;
  state.portals[0].spawnIn = 0;
  const hunger = state.character.hunger, mood = state.character.mood;
  const animationTime = state.character.animationTime;
  let randomCalls = 0;
  stepGame(state, 0.25, 1280, () => { randomCalls++; return 0.5; }, { onElevatedSurface: true });
  assert.equal(state.character.x, 500);
  assert.equal(state.wanderTarget, 900);
  assert.equal(state.cooldowns.wander, 0);
  assert.equal(state.cooldowns.attack, 0.75);
  assert.equal(state.character.speechTime, 0.75);
  assert.equal(state.elapsed, 0.25);
  assert.equal(state.character.animationTime, animationTime + 0.25);
  assert.ok(state.character.hunger < hunger);
  assert.ok(state.character.mood < mood);
  assert.equal(state.monsters.length, 1);
  assert.equal(state.monsters[0].x, 524);
  assert.equal(state.monsters[0].cooldown, 1.25);
  assert.equal(randomCalls, 1, 'Only monster spawning may consume randomness while elevated');
});

test('resting on a window still restores health and mana and advances rest animation', () => {
  const state = duel({ hp: 40, mana: 0 });
  setCommand(state, 'rest');
  const x = state.character.x;
  stepGame(state, 0.25, 1280, () => 0.5, { onElevatedSurface: true });
  assert.equal(state.character.hp, 41);
  assert.equal(state.character.mana, 0.75);
  assert.equal(state.character.restTime, 0.25);
  assert.equal(state.character.x, x);
  assert.equal(state.monsters[0].hp, 1000);
  assert.equal(state.character.action, 'rest');
});

test('the fight command retains normal ground pursuit and combat even with the elevated flag', () => {
  const normal = duel(), flagged = duel();
  stepGame(normal, 0.1, 1280, () => 0.5);
  stepGame(flagged, 0.1, 1280, () => 0.5, { onElevatedSurface: true });
  assert.ok(flagged.character.hp < flagged.character.maxHp);
  assert.ok(flagged.monsters[0].hp < 1000);
  assert.deepEqual(flagged.character, normal.character);
  assert.deepEqual(flagged.monsters, normal.monsters);
  normal.monsters[0].x = flagged.monsters[0].x = 900;
  const heroX = flagged.character.x;
  stepGame(normal, 0.1, 1280, () => 0.5);
  stepGame(flagged, 0.1, 1280, () => 0.5, { onElevatedSurface: true });
  assert.ok(flagged.character.x > heroX);
  assert.ok(flagged.monsters[0].x < 900);
  assert.deepEqual(flagged.character, normal.character);
  assert.deepEqual(flagged.monsters, normal.monsters);
});
