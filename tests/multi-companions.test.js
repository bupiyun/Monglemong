import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DEPLOYED_COMPANIONS, STAT_FIELDS, createGame, createCustomCharacter, deleteCustomCharacter,
  serializeGame, stepGame, selectCharacter, getDeployedCharacters, setCharacterDeployed,
  moveCharacter, setCharacterScale, petCharacter, feedCharacter, setCommand, deployCore, normalizeWorldDisplays,
} from '../src/engine.js';

const displayLayout = [
  { id: 'left', x: 0, y: 0, width: 1280, height: 900, floorY: 860 },
  { id: 'right', x: 1480, y: 200, width: 1000, height: 800, floorY: 960 },
];
function addCompanion(state, index = 1) {
  const id = `custom_${String(index).padStart(8, '0')}-89ab-4cde-8fab-0123456789ab`;
  const outcome = createCustomCharacter(state, {
    id, sheetId: id, name: `동료 ${index}`, title: '함께하는 친구', personality: '다정해요.',
    foodPreference: 'snack', tastePreferences: ['sweet'],
    baseStats: Object.fromEntries(STAT_FIELDS.map(field => [field.key, field.base])),
    growthStats: Object.fromEntries(STAT_FIELDS.map(field => [field.key, field.growth])),
  });
  assert.equal(outcome.ok, true);
  return outcome.character;
}
function withCompanions(count = 2, displays = displayLayout) {
  const state = createGame();
  stepGame(state, 0, 2480, () => 0.5, { displays });
  for (let index = 1; index < count; index++) {
    const character = addCompanion(state, index);
    assert.equal(setCharacterDeployed(state, character.id, true, 2480, { displays }).ok, true);
  }
  return state;
}
function tick(state, seconds, options = {}) {
  for (let time = 0; time < seconds; time += 0.1) stepGame(state, 0.1, 2480, () => 0.5, options);
}
function monster(state, { displayId = 'left', x = 500, hp = 1000, attack = 5, cooldown = 0 } = {}) {
  const actor = { id: `m${state.nextId++}`, portalId: 'p999', type: 'grove', name: '숲 슬라임',
    displayId, x, hp, maxHp: hp, attack, level: 1, defense: 0, resistance: 0, cooldown, facing: -1 };
  state.monsters.push(actor);
  return actor;
}

test('legacy saves deploy only the former active actor; v4 deployment is unique, owned and capped', () => {
  const state = withCompanions();
  selectCharacter(state, state.characters[1].id);
  const legacy = JSON.parse(serializeGame(state));
  legacy.version = 3;
  legacy.wanderTarget = 777;
  const migrated = createGame(legacy);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.deployedCharacterIds, [legacy.activeCharacterId]);
  assert.equal(migrated.character.wanderTarget, 777);
  assert.equal(migrated.cooldowns, migrated.character.cooldowns);
  for (let index = 2; index < 8; index++) addCompanion(state, index);
  const damaged = JSON.parse(serializeGame(state));
  damaged.deployedCharacterIds = ['unknown', ...state.characters.map(character => character.id), state.characters[0].id];
  damaged.activeCharacterId = state.characters.at(-1).id;
  const restored = createGame(damaged);
  assert.equal(getDeployedCharacters(restored).length, MAX_DEPLOYED_COMPANIONS);
  assert.equal(restored.activeCharacterId, restored.deployedCharacterIds[0]);
  assert.deepEqual(restored.deployedCharacterIds, state.characters.slice(0, MAX_DEPLOYED_COMPANIONS).map(character => character.id));
});

test('deployment caps at six, refuses unknown actors and never recalls the final actor', () => {
  const state = withCompanions(6);
  const benched = addCompanion(state, 6);
  assert.equal(setCharacterDeployed(state, benched.id, true).ok, false);
  assert.equal(selectCharacter(state, benched.id).ok, false);
  assert.equal(setCharacterDeployed(state, 'unknown', true).ok, false);
  assert.equal(setCharacterDeployed(state, state.character.id, 'false').ok, false);
  for (const character of [...getDeployedCharacters(state)].slice(1)) assert.equal(setCharacterDeployed(state, character.id, false).ok, true);
  assert.equal(setCharacterDeployed(state, state.character.id, false).ok, false);
  assert.equal(getDeployedCharacters(state).length, 1);
  const focused = state.character;
  moveCharacter(state, focused.id, 1800, 2480, { displayId: 'right' });
  assert.equal(setCharacterDeployed(state, benched.id, true).ok, true);
  assert.equal(benched.displayId, 'right');
  assert.equal(benched.x, focused.x + 100);
});

test('focus changes neither companion positions, actions, cooldowns nor the shared effects', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  Object.assign(first.cooldowns, { attack: 1.3, pet: 2 });
  Object.assign(second.cooldowns, { attack: 0.6, feed: 2.4 });
  first.wanderTarget = 900; second.wanderTarget = 700;
  state.effects.push({ id: 'e999', x: 500, displayId: 'left', text: 'hello', life: 1 });
  const before = structuredClone(state.characters), effects = structuredClone(state.effects);
  assert.equal(selectCharacter(state, second.id).ok, true);
  assert.deepEqual(state.characters, before);
  assert.deepEqual(state.effects, effects);
  assert.equal(state.cooldowns, second.cooldowns);
  assert.equal(state.wanderTarget, 700);
  state.wanderTarget = 650;
  assert.equal(second.wanderTarget, 650);
  assert.equal(first.wanderTarget, 900);
  assert.equal(setCharacterDeployed(state, second.id, false).ok, true);
  assert.equal(state.character, first);
  assert.equal(first.cooldowns.attack, 1.3);
});

test('targeted care and commands use each owned actor without changing focus or sharing cooldowns', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  assert.equal(petCharacter(state, second.id).ok, true);
  assert.equal(first.bond, 0);
  assert.equal(second.bond, 1);
  assert.equal(first.cooldowns.pet, 0);
  assert.equal(petCharacter(state, second.id).ok, false);
  assert.equal(petCharacter(state, first.id).ok, true);
  second.hp = 20;
  assert.equal(feedCharacter(state, 'snack', second.id).ok, true);
  assert.equal(second.hp, 32);
  assert.equal(first.cooldowns.feed, 0);
  assert.equal(setCommand(state, 'rest', second.id).ok, true);
  assert.equal(first.command, 'wander');
  assert.equal(state.activeCharacterId, first.id);
  const before = serializeGame(state);
  assert.equal(petCharacter(state, 'unknown').ok, false);
  assert.equal(feedCharacter(state, 'snack', 'unknown').ok, false);
  assert.equal(setCommand(state, 'rest', 'unknown').ok, false);
  assert.equal(serializeGame(state), before);
});

test('deployed actors progress together while benched actors keep their exact resources and timers', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  const benched = addCompanion(state, 3);
  const beforeBench = structuredClone(benched);
  first.wanderTarget = 900; first.cooldowns.wander = 4;
  second.hp = 20; second.mana = 0;
  setCommand(state, 'rest', second.id);
  const firstX = first.x, hunger = first.hunger;
  tick(state, 1);
  assert.ok(first.x > firstX);
  assert.ok(first.hunger < hunger);
  assert.ok(second.hp > 23.9 && second.mana > 2.9);
  assert.ok(first.animationTime > 0.8 && second.animationTime > 0.8);
  for (const key of ['hp', 'mana', 'hunger', 'mood', 'bond', 'xp', 'level', 'animationTime', 'animationTimer', 'restTime', 'cooldowns']) assert.deepEqual(benched[key], beforeBench[key]);
});

test('one wave and one wallet award serve all fighters on that monitor, with no XP for other monitors or reserves', () => {
  const state = withCompanions(4);
  const [first, second, remote, resting] = state.characters;
  const benched = addCompanion(state, 5);
  for (const character of [first, second, remote, benched]) setCommand(state, 'fight', character.id);
  setCommand(state, 'rest', resting.id);
  moveCharacter(state, remote.id, 1800, 2480, { displayId: 'right' });
  assert.equal(deployCore(state, 'grove', 550, 2480, { displayId: 'left' }).ok, true);
  tick(state, 80);
  assert.equal(state.stats.kills, 3);
  assert.equal(state.stats.clears, 1);
  assert.equal(state.gold, 169);
  assert.equal(state.portals.length, 0);
  assert.equal(state.monsters.length, 0);
  for (const character of [first, second]) { assert.equal(character.level, 2); assert.equal(character.xp, 8); }
  for (const character of [remote, resting, benched]) { assert.equal(character.level, 1); assert.equal(character.xp, 0); }
  assert.equal(state.items.slime_gel, 3);
  assert.equal(state.items.forest_seed, 0);
  tick(state, 20);
  assert.equal(state.gold, 169);
  assert.equal(state.stats.kills, 3);
});

test('same horizontal coordinates on vertically stacked monitors never share combat or XP', () => {
  const displays = [displayLayout[0], { id: 'above', x: 0, y: 1000, width: 1280, height: 720, floorY: 1680 }];
  const state = withCompanions(2, displays);
  const [first, second] = state.characters;
  moveCharacter(state, first.id, 500, 1280, { displays, displayId: 'left' });
  moveCharacter(state, second.id, 500, 1280, { displays, displayId: 'above' });
  setCommand(state, 'fight', first.id); setCommand(state, 'fight', second.id);
  const remoteHP = second.hp, remoteMana = second.mana;
  monster(state, { hp: 1, cooldown: 10 });
  stepGame(state, 0.1, 1280, () => 1, { displays });
  assert.equal(first.xp, 16);
  assert.equal(second.xp, 0);
  assert.equal(second.hp, remoteHP);
  assert.equal(second.mana, remoteMana);
  assert.ok(state.effects.every(effect => effect.displayId === 'left'));
});

test('monsters target the nearest eligible companion and ignore dragged, resting and elevated companions', () => {
  const state = withCompanions(3);
  const [first, second, third] = state.characters;
  for (const character of state.characters) { character.x = 500; character.cooldowns.attack = 5; }
  setCommand(state, 'rest', first.id);
  const firstHP = first.hp, secondHP = second.hp, thirdHP = third.hp;
  monster(state);
  stepGame(state, 0.1, 2480, () => 0.5, { pausedCharacterIds: [second.id] });
  assert.equal(first.hp, firstHP); assert.equal(second.hp, secondHP); assert.ok(third.hp < thirdHP);
  third.hp = thirdHP;
  state.monsters[0].cooldown = 0;
  stepGame(state, 0.1, 2480, () => 0.5, { elevatedCharacterIds: [second.id, third.id] });
  assert.equal(second.hp, secondHP); assert.equal(third.hp, thirdHP);
  setCommand(state, 'fight', third.id);
  state.monsters[0].cooldown = 0;
  stepGame(state, 0.1, 2480, () => 0.5, { elevatedCharacterIds: [second.id, third.id] });
  assert.ok(third.hp < thirdHP, 'Fight command returns its actor to the floor');
});

test('drag pause excludes only its actor from simulation while other actors and the shared dungeon advance', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  setCommand(state, 'rest', first.id); setCommand(state, 'rest', second.id);
  first.hp = second.hp = 20;
  deployCore(state, 'grove', 800, 2480, { displayId: 'left' });
  const before = structuredClone(first);
  tick(state, 2, { pausedCharacterIds: [first.id] });
  assert.deepEqual(first, before);
  assert.ok(Math.abs(second.hp - 28) < 1e-9);
  assert.equal(state.monsters.length, 1);
  assert.ok(state.elapsed >= 2);
});

test('cross-monitor moves respect monitor bounds and scale and reject unknown or benched actors atomically', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  const benched = addCompanion(state, 5);
  assert.equal(moveCharacter(state, first.id, 1480, 2480, { displayId: 'right' }).ok, true);
  assert.equal(first.displayId, 'right');
  assert.equal(first.x, 1480 + 96);
  assert.equal(first.wanderTarget, first.x);
  assert.equal(second.displayId, 'left');
  assert.equal(setCharacterScale(state, 3, 2480, { displays: displayLayout }).ok, true);
  assert.equal(first.x, 1480 + 144);
  const before = serializeGame(state);
  for (const [characterId, x, options] of [[first.id, 1800, { displayId: 'removed' }], [benched.id, 500, {}], ['unknown', 500, {}], [first.id, NaN, {}], [first.id, -1, {}], [first.id, 65537, {}]]) {
    assert.equal(moveCharacter(state, characterId, x, 2480, options).ok, false);
    assert.equal(serializeGame(state), before);
  }
  assert.equal(state.activeCharacterId, first.id);
});

test('changing display origins preserves local positions and removed monitors safely return their actors and dungeon to primary', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  moveCharacter(state, second.id, 1800, 2480, { displayId: 'right' });
  deployCore(state, 'grove', 1900, 2480, { displayId: 'right' });
  setCommand(state, 'rest', first.id); setCommand(state, 'rest', second.id);
  tick(state, 2);
  const localActor = second.x - 1480, localPortal = state.portals[0].x - 1480, localMonster = state.monsters[0].x - 1480;
  const shifted = [{ ...displayLayout[0], x: 1000 }, { ...displayLayout[1], x: 0 }];
  stepGame(state, 0, 2480, () => 0.5, { displays: shifted });
  assert.equal(first.x, 1280);
  assert.equal(second.x, localActor);
  assert.equal(state.portals[0].x, localPortal);
  assert.equal(state.monsters[0].x, localMonster);
  assert.equal(second.displayId, 'right');
  stepGame(state, 0, 1280, () => 0.5, { displays: [displayLayout[0]] });
  assert.equal(first.x, 280);
  assert.equal(second.x, localActor);
  assert.equal(second.displayId, 'left');
  assert.equal(state.portals[0].displayId, 'left');
  assert.equal(state.monsters[0].displayId, 'left');
  assert.ok(state.characters.every(character => character.x >= 96 && character.x <= 1184));
});

test('independent positions, commands, cooldowns, display IDs and wandering targets survive save and restore', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  moveCharacter(state, second.id, 1900, 2480, { displayId: 'right' });
  setCommand(state, 'rest', second.id);
  first.wanderTarget = 750; second.wanderTarget = 2000;
  petCharacter(state, first.id); feedCharacter(state, 'snack', second.id);
  selectCharacter(state, second.id);
  const restored = createGame(serializeGame(state));
  assert.deepEqual(restored.deployedCharacterIds, state.deployedCharacterIds);
  assert.deepEqual(restored.worldDisplays, state.worldDisplays);
  for (const character of state.characters) {
    const other = restored.characters.find(item => item.id === character.id);
    for (const key of ['x', 'displayId', 'wanderTarget', 'hp', 'mana', 'command']) assert.equal(other[key], character[key]);
    assert.deepEqual(other.cooldowns, character.cooldowns);
  }
  assert.equal(restored.cooldowns, restored.character.cooldowns);
  stepGame(restored, 0);
  assert.equal(restored.characters[1].displayId, 'right', 'A missing topology notification does not discard saved physical monitor IDs');
  assert.equal(restored.characters[1].x, 1900);
});

test('deleting the only deployed custom companion returns Cafemong to that monitor without disturbing reserves', () => {
  const state = withCompanions();
  const [first, second] = state.characters;
  moveCharacter(state, second.id, 2000, 2480, { displayId: 'right' });
  setCharacterDeployed(state, first.id, false);
  assert.equal(deleteCustomCharacter(state, second.id).ok, true);
  assert.deepEqual(state.deployedCharacterIds, [first.id]);
  assert.equal(state.character, first);
  assert.equal(first.x, 2000);
  assert.equal(first.displayId, 'right');
});

test('server-style raw legacy state lazily upgrades aliases and missing runtime fields without advancing reserves', () => {
  const state = withCompanions();
  const raw = JSON.parse(serializeGame(state));
  raw.version = 3; delete raw.deployedCharacterIds; delete raw.worldDisplays;
  for (const character of raw.characters) { delete character.displayId; delete character.wanderTarget; }
  const secondHunger = raw.characters[1].hunger;
  stepGame(raw, 0.1, 1280, () => 0.5);
  assert.equal(raw.version, 4);
  assert.deepEqual(raw.deployedCharacterIds, [raw.activeCharacterId]);
  assert.equal(raw.character, raw.characters[0]);
  assert.equal(raw.cooldowns, raw.character.cooldowns);
  assert.equal(raw.characters[1].hunger, secondHunger);
  assert.ok(Number.isFinite(raw.character.animationTime));
  assert.ok(Number.isFinite(raw.character.wanderTarget));
});

test('display validation bounds dimensions, duplicates and count, and tiny monitors never strand actors', () => {
  assert.equal(normalizeWorldDisplays(null, 2500)[0].width, 2500);
  const normalized = normalizeWorldDisplays([
    { id: 'bad', x: -1, y: 0, width: 100, height: 100 },
    { id: 'tiny', x: 50, y: 10, width: 20, height: 20, floorY: 900 },
    { id: 'tiny', x: 0, y: 0, width: 100, height: 100 },
    { id: 7, x: 65000, y: 65000, width: 2000, height: 2000, floorY: -1 },
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].floorY, 30);
  assert.equal(normalized[1].width, 536);
  assert.equal(normalized[1].floorY, 65000);
  assert.equal(normalizeWorldDisplays(Array.from({ length: 40 }, (_, id) => ({ id, x: id * 100, y: 0, width: 100, height: 100 }))).length, 32);
  const state = createGame();
  stepGame(state, 0, 100, () => 0.5, { displays: [normalized[0]] });
  assert.equal(state.character.x, 60);
  deployCore(state, 'grove', 900, 100, { displays: [normalized[0]] });
  assert.equal(state.portals[0].x, 60);
});


test('selecting a benched companion on a wide legacy primary display keeps the existing topology', () => {
  const state = createGame();
  stepGame(state, 0, 3200);
  state.character.x = 2500;
  const companion = addCompanion(state);
  assert.equal(selectCharacter(state, companion.id).ok, true);
  assert.equal(companion.x, 2600);
  assert.equal(state.worldDisplays[0].width, 3200);
});
