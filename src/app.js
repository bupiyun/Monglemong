import { CORE_TYPES, CHARACTER_TYPES, FOOD_GROUPS, TASTES, FOODS, ITEM_TYPES, MONSTER_DROPS, createGame, stepGame, petCharacter, feedCharacter, setCommand, deployCore, buyCore, claimDaily, serializeGame, selectCharacter, getNextCompanion, setCharacterScale, setWindowWalking, MAX_DEPLOYED_COMPANIONS, getDeployedCharacters, setCharacterDeployed, moveCharacter } from './engine.js';
import { RUNTIME_CONFIG } from './runtime-config.js';
import { createAccountClient } from './account-client.js';
import { mountAccountPanel } from './account-ui.js';
import { mountUpdatesPanel } from './updates.js';
import { applyCharacterSprite, setSpriteSheet, preloadBundledSprites, getCharacterFootInset } from './sprites.js';
import { getSpriteSheet, deleteSpriteSheet } from './sprite-storage.js';
import { createWarehouseUI } from './warehouse.js';
import { createSurfaceWalker } from './desktop-surfaces.js';
import { readDesktopLayout, displayForPoint, clampCharacterPoint } from './desktop-layout.js';

const $ = id => document.getElementById(id);
const SAVE_KEY = 'mori.game.v1';
let saved;
try { saved = localStorage.getItem(SAVE_KEY); } catch {}
let state = createGame(saved);
if (!saved) {state.character.x = innerWidth * .39; state.wanderTarget = innerWidth * .47;}
const desktop = window.desktop;
let sceneMode = !desktop;
let paused = false;
let selectedCore = null;
let drag = null;
let lastFrame = performance.now();
let lastUI = 0;
let lastSave = 0;
let lastRegions = 0;
let toastTimer;
let lastInventory = '';
let lastLogs = '';
let lastRoster = '';
let modalCompanionId = null;
let uiTab = 'cores';
let customDock = false;
let accountPanel = null;
let updatesPanel = null;
let settingsGeneration = 0;
let cloudActive = false;
let cloudBlocked = false;
let cloudBusy = false;
let cloudSyncRequested = false;
let cloudEpoch = 0;
let lastCloudSync = 0;
const pendingPlacements = new Map();
let desktopLayout = null;
let topologyReady = !desktop?.requestDisplays;
let resolveTopology;
const topologyLoaded = topologyReady ? Promise.resolve() : new Promise(resolve => { resolveTopology = resolve; });
const loadingCloudSheets = new Set();
const account = createAccountClient({ config: RUNTIME_CONFIG, desktop });
const surfaceWalker = createSurfaceWalker();
let surfaceSnapshot = { supported: false, status: 'unavailable', surfaces: [] };
const surfacePoses = new Map();
const surfaceAnimations = new Map();
const sheetURLs = new Map();
// Keep the old storage namespace so existing installations retain their saves.
const SHEET_CLEANUP_KEY = 'mori.pendingSpriteDeletes.v1';
let resettingGame = false;
let cleanupPromise = null;
const icons = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',play:'<path d="m8 4 12 8-12 8Z"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1-1.5 3m0 3h.01"/>',
  settings:'<path d="m9 3-.8 3-2.9.8-2 2.8 2 2.4-.1 3.2L8 17l1 3h4l1-3 3-1.1 1-3-1-2.9 1-2-2.5-2-3-.2L12 3Z"/><circle cx="10.7" cy="11.5" r="3"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
$('scene-toggle').innerHTML = icon('sun');
$('pause-button').innerHTML = icon('pause');
$('help-button').innerHTML = icon('help');
$('settings-button').innerHTML = icon('settings');
const typeFor = id => CORE_TYPES.find(t => t.id === id);
const itemFor = id => ITEM_TYPES.find(item => item.id === id);
const warehouse = createWarehouseUI({ onInspect: openItemDetail });
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const floor = () => {
  const value = parseFloat(getComputedStyle(document.body).getPropertyValue('--floor'));
  return Number.isFinite(value) ? value : 88;
};
const characterScale = () => state.settings.characterScale;
const characterSize = () => 96 * characterScale();
const worldDisplays = () => desktopLayout?.displays || [{ id: 'primary', x: 0, y: 0,
  width: document.documentElement.clientWidth, height: innerHeight, floorY: innerHeight }];
const primaryDisplay = () => worldDisplays()[0];
const displayFor = actor => worldDisplays().find(area => area.id === actor?.displayId) || primaryDisplay();
const nativeFloor = () => Boolean(desktopLayout && !sceneMode);
const surfaceMode = () => Boolean(desktop && !sceneMode && state.settings.windowWalking && surfaceSnapshot.supported);
function surfaceOptions(character, extra = {}) {
  const area = displayFor(character);
  return { characterId: character.id, displayId: desktopLayout ? area.id : undefined, x: character.x,
    width: desktopLayout?.width || document.documentElement.clientWidth, height: desktopLayout?.height || innerHeight, size: characterSize(),
    bounds: area, command: character.command, enabled: surfaceMode(),
    paused: paused || cloudBlocked || document.hidden
      || (!$('character-menu').hidden && character.id === state.activeCharacterId)
      || (character.animationState === 'pet' && character.animationTimer > 0),
    speed: 32 * character.speed / 10, ...extra };
}
function syncSurfacePose(character, dt = 0, advance = false) {
  const enabled = surfaceMode();
  const dragging = drag?.kind === 'character' && drag.characterId === character.id;
  const pose = surfaceWalker.step(surfaceOptions(character, { dt,
    ...(dragging && drag.surface ? { dragging: true, footY: drag.footY } : {}) }));
  if (enabled && !dragging && topologyReady) character.x = pose.x;
  const animation = surfaceAnimations.get(character.id) || { walking: false, time: 0 };
  if (!enabled || pose.onFloor || !pose.grounded || character.command !== 'wander' || dragging) animation.walking = false;
  else if (advance && !paused && !document.hidden) {
    animation.walking = pose.action === 'walk';
    if (animation.walking) animation.time += dt;
  }
  if (animation.walking) character.facing = pose.facing;
  surfaceAnimations.set(character.id, animation);
  surfacePoses.set(character.id, pose);
  return pose;
}
function normalizePlacement() {
  if (topologyReady && !cloudActive) stepGame(state, 0, innerWidth, Math.random, { displays: worldDisplays() });
}
// Online topology changes only remap presentation coordinates. Server ticks own
// simulation; keeping this local geometry current also makes repeated events safe.
function remapVisualLayout(game) {
  const displays = worldDisplays(), previous = game.worldDisplays || [];
  for (const actor of [...game.characters, ...game.portals, ...game.monsters, ...game.effects]) {
    const before = previous.find(area => area.id === actor.displayId);
    const area = displays.find(item => item.id === actor.displayId) || displays[0];
    const shift = before ? area.x - before.x : actor.displayId !== area.id ? area.x : 0;
    const point = clampCharacterPoint(area, actor.x + shift, area.floorY, game.characters.includes(actor) ? 96 * game.settings.characterScale : game.effects.includes(actor) ? 0 : 76);
    actor.x = point.x; actor.displayId = area.id;
  }
  game.worldDisplays = displays.map(({ id, x, y, width, height, floorY }) => ({ id, x, y, width, height, floorY }));
}
function positionPrimaryUI() {
  if (!desktopLayout) return;
  const area = primaryDisplay();
  const style = document.body.style;
  for (const [key, value] of Object.entries({ x: area.x, y: area.y, width: area.width, height: area.height,
    right: innerWidth - area.x - area.width, bottom: innerHeight - area.y - area.height,
    center: area.x + area.width / 2, middle: area.y + area.height / 2 })) style.setProperty('--primary-' + key, value + 'px');
  document.body.classList.add('desktop-layout');
  document.body.classList.toggle('compact-primary', area.width < 1050);
  document.body.classList.toggle('short-primary', area.height < 800);
  if (customDock) clampDock();
}
function clampDock(x, y) {
  const area = primaryDisplay(), box = $('dock').getBoundingClientRect();
  $('dock').style.left = Math.max(area.x + 8, Math.min(area.x + area.width - box.width - 8, x ?? box.x)) + 'px';
  $('dock').style.top = Math.max(area.y + 8, Math.min(area.y + area.height - box.height - 70, y ?? box.y)) + 'px';
  $('dock').style.right = 'auto';
}
function surfaceStatusText() {
  if (!surfaceSnapshot.supported) return 'Windows 앱의 바탕화면 모드에서 사용할 수 있어요';
  if (!state.settings.windowWalking) return '켜면 창 윗면에 동료를 놓을 수 있어요';
  if (sceneMode) return '초원 배경을 끄면 창 위를 걸을 수 있어요';
  return surfaceSnapshot.status === 'ready' ? '동료를 창 윗면으로 드래그해 놓아 보세요' : '창 인식을 기다리는 동안 바닥에서 움직여요';
}
const foodName = id => FOOD_GROUPS.find(group => group.id === id)?.name || id;
const withName = name => name + ((name.charCodeAt(name.length - 1) - 0xac00) % 28 === 0 ? '와' : '과');
const tasteName = id => TASTES.find(taste => taste.id === id)?.name || id;
const STAT_LABELS = {hp:'체력',mana:'마나',attack:'공격',defense:'방어',magic:'마력',resistance:'저항력',speed:'속도'};
$('food-select').innerHTML = FOODS.map(food => `<option value="${food.id}">${escape(food.name)} · ${food.price} G</option>`).join('');
$('food-select').value = 'snack';

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3400);
}
function save() {
  if (cloudActive) {
    $('save-label').textContent = cloudBlocked ? '서버 연결을 다시 확인하고 있어요' : '계정에 자동 저장';
    return !cloudBlocked;
  }
  try {localStorage.setItem(SAVE_KEY, serializeGame(state)); $('save-label').textContent = '이 기기에 자동 저장'; return true;}
  catch {$('save-label').textContent = '저장 공간을 사용할 수 없어요'; return false;}
}
async function restoreSpriteSheets() {
  const epoch = cloudEpoch;
  let missing = false;
  await Promise.all((state.customDefinitions || []).map(async definition => {
    try {
      const blob = await getSpriteSheet(definition.sheetId);
      if (epoch !== cloudEpoch || cloudActive || !state.customDefinitions.some(item => item.id === definition.id && item.sheetId === definition.sheetId)) return;
      if (!blob) { missing = true; return; }
      const url = URL.createObjectURL(blob);
      releaseSheetURL(definition.sheetId);
      sheetURLs.set(definition.sheetId, url);
      setSpriteSheet(definition.sheetId, url);
    } catch { missing = true; }
  }));
  lastRoster = '';
  renderUI(); renderWorld();
  if (missing) notify('일부 동료의 저장된 그림을 읽지 못해 기본 모습으로 표시해요.');
}
function releaseSheetURL(id) {
  setSpriteSheet(id, null);
  const url = sheetURLs.get(id);
  if (url) URL.revokeObjectURL(url);
  sheetURLs.delete(id);
}
function cloudPresence() {
  return { width: Math.max(320, Math.min(65536, innerWidth)), paused: paused || document.hidden,
    displays: worldDisplays(), characters: getDeployedCharacters(state).map(character => {
      const pose = surfacePoses.get(character.id);
      const elevated = Boolean(surfaceMode() && pose && !pose.onFloor);
      const placement = pendingPlacements.get(character.id);
      return { characterId: character.id, displayId: character.displayId || displayFor(character).id,
        elevated, paused: drag?.kind === 'character' && drag.characterId === character.id,
        ...(placement ? { x: placement.x, displayId: placement.displayId } : elevated ? { x: character.x } : {}) };
    }) };
}
function clearCompanionPlacement() {
  for (const character of state.characters) surfaceWalker.forget(character.id);
  for (const id of [...sheetURLs.keys()]) releaseSheetURL(id);
  loadingCloudSheets.clear();
  surfacePoses.clear(); surfaceAnimations.clear(); pendingPlacements.clear(); cloudSyncRequested = false;
}
async function loadCloudArtwork() {
  const epoch = cloudEpoch;
  const live = new Set(state.customDefinitions.map(definition => definition.sheetId));
  for (const id of [...sheetURLs.keys()]) if (!live.has(id)) releaseSheetURL(id);
  await Promise.all(state.customDefinitions.map(async definition => {
    if (sheetURLs.has(definition.sheetId) || loadingCloudSheets.has(definition.sheetId)) return;
    loadingCloudSheets.add(definition.sheetId);
    try {
      const blob = await account.fetchSprite(definition.id);
      if (epoch !== cloudEpoch || !cloudActive || !state.customDefinitions.some(item => item.sheetId === definition.sheetId)) return;
      const url = URL.createObjectURL(blob);
      sheetURLs.set(definition.sheetId, url); setSpriteSheet(definition.sheetId, url);
      lastRoster = ''; renderUI(); renderWorld();
    } catch {
      if (epoch === cloudEpoch && cloudActive) $('save-label').textContent = '동료 그림을 다시 불러오는 중';
    } finally { if (epoch === cloudEpoch) loadingCloudSheets.delete(definition.sheetId); }
  }));
}
function applyCloudGame(envelope) {
  if (!envelope?.game || !Array.isArray(envelope.game.characters)) throw new Error('서버의 게임 정보를 확인하지 못했어요.');
  const next = createGame(envelope.game);
  const live = new Set(getDeployedCharacters(next).map(character => character.id));
  for (const id of pendingPlacements.keys()) if (!live.has(id)) pendingPlacements.delete(id);
  if (drag?.kind === 'character' && !live.has(drag.characterId)) {
    try { drag.target.releasePointerCapture(drag.pointerId); } catch {}
    drag = null;
  }
  // Only the configured authenticated server supplies these visual runtime fields.
  for (const character of next.characters) {
    const runtime = envelope.game.characters.find(item => item.id === character.id);
    if (!runtime) continue;
    for (const key of ['animationState', 'animationTime', 'animationTimer', 'animationDuration', 'restTime', 'action', 'speech', 'speechTime']) {
      if (runtime[key] !== undefined) character[key] = runtime[key];
    }
  }
  next.effects = Array.isArray(envelope.game.effects) ? envelope.game.effects.map(effect => ({ ...effect })) : [];
  if (topologyReady) remapVisualLayout(next);
  for (const character of next.characters) {
    const local = state.characters.find(item => item.id === character.id);
    if (local && ((drag?.kind === 'character' && drag.characterId === character.id) || pendingPlacements.has(character.id))) {
      character.x = local.x; character.displayId = local.displayId;
    }
  }
  state = next;
  cloudBlocked = false;
  lastCloudSync = performance.now();
  lastInventory = ''; lastRoster = ''; lastLogs = '';
  renderUI(); renderWorld(); reportRegions(); save();
  void loadCloudArtwork();
  if (envelope.newCharacters?.length) notify(envelope.newCharacters.map(item => item.name).join(', ') + ' 동료가 새로 합류했어요!');
}
async function syncCloudGame() {
  if (!cloudActive || !account.user) return;
  if (cloudBusy) { cloudSyncRequested = true; return; }
  const epoch = cloudEpoch;
  let sentPlacements;
  cloudBusy = true;
  try {
    const response = await account.syncGame(() => { sentPlacements = new Map(pendingPlacements); return cloudPresence(); });
    if (epoch !== cloudEpoch || !cloudActive) return;
    for (const [id, placement] of sentPlacements || []) if (pendingPlacements.get(id) === placement) pendingPlacements.delete(id);
    applyCloudGame(response);
  } catch (cause) {
    if (epoch !== cloudEpoch) return;
    if (cause.status === 409 && cause.data?.game) {
      applyCloudGame(cause.data);
      return;
    }
    cloudBlocked = true; lastCloudSync = performance.now(); save();
    if (!account.user) { await restoreGuestGame(); notify('로그인이 만료되어 이 기기의 모험으로 돌아왔어요. 계정 기록은 서버에 보관돼요.'); }
  } finally {
    if (epoch === cloudEpoch) {
      cloudBusy = false;
      if (cloudSyncRequested) { cloudSyncRequested = false; lastCloudSync = 0; }
    }
  }
}
async function activateCloudGame() {
  await topologyLoaded;
  if (!account.user) return;
  if (!cloudActive && !save()) throw new Error('기기의 모험을 보관하지 못했어요. 저장 공간을 확인해 주세요.');
  const epoch = ++cloudEpoch;
  cloudBusy = true;
  try {
    const response = await account.syncGame({ width: Math.max(320, Math.min(65536, innerWidth)), displays: worldDisplays(), paused, elevated: false });
    if (epoch !== cloudEpoch || !account.user) return;
    // Preserve guest actions taken while the first online response was in flight.
    if (!cloudActive && !save()) throw new Error('기기의 모험을 보관하지 못했어요. 저장 공간을 확인해 주세요.');
    clearCompanionPlacement(); cloudActive = true;
    document.body.classList.add('online-mode');
    applyCloudGame(response);
  } finally { if (epoch === cloudEpoch) cloudBusy = false; }
}
async function restoreGuestGame() {
  cloudEpoch += 1; cloudActive = false; cloudBlocked = false; cloudBusy = false;
  document.body.classList.remove('online-mode');
  clearCompanionPlacement();
  let guest; try { guest = localStorage.getItem(SAVE_KEY); } catch {}
  state = createGame(guest); normalizePlacement(); lastInventory = ''; lastRoster = ''; lastLogs = '';
  if ($('modal').open) $('modal').close();
  renderUI(); renderWorld(); reportRegions(); save();
  await restoreSpriteSheets();
}
function readCleanupQueue() {
  const ids = JSON.parse(localStorage.getItem(SHEET_CLEANUP_KEY) || '[]');
  return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && /^custom_[0-9a-f-]{36}$/i.test(id)) : []);
}
function rememberSheetCleanup(id) {
  const ids = readCleanupQueue(); ids.add(id);
  localStorage.setItem(SHEET_CLEANUP_KEY, JSON.stringify([...ids]));
}
// Metadata is committed before old artwork is deleted. The durable queue also
// collects staged images after an interrupted save; referenced images are kept.
async function cleanupSpriteSheets() {
  if (cloudActive) return true;
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let failed = false;
    try {
      for (const id of readCleanupQueue()) {
        if (cloudActive) break;
        try {
          if (!state.customDefinitions.some(item => item.sheetId === id)) await deleteSpriteSheet(id);
          const remaining = readCleanupQueue(); remaining.delete(id);
          localStorage.setItem(SHEET_CLEANUP_KEY, JSON.stringify([...remaining]));
        } catch { failed = true; }
      }
    } catch { failed = true; }
    return !failed;
  })();
  try { return await cleanupPromise; } finally { cleanupPromise = null; }
}
function commitGuestState(nextState) {
  try { localStorage.setItem(SAVE_KEY, serializeGame(nextState)); }
  catch { throw new Error('게임 정보를 저장할 공간이 부족하거나 저장이 차단됐어요. 공간을 확보한 뒤 다시 시도해 주세요.'); }
  state = nextState;
}
function refreshCharacters() {
  lastRoster = ''; lastLogs = '';
  renderUI(); renderWorld(); reportRegions();
}
async function perform(action, type, payload = {}) {
  if (paused && !['setCharacterScale', 'setWindowWalking'].includes(type)) {notify('계속하기를 눌러 동료를 깨워 주세요.'); return;}
  let result;
  if (cloudActive) {
    const epoch = cloudEpoch;
    try {
      if (!type) throw new Error('이 작업은 계정 모험에서 사용할 수 없어요.');
      let sentPlacements;
      const response = await account.gameAction(type, payload, () => { sentPlacements = new Map(pendingPlacements); return cloudPresence(); });
      if (epoch !== cloudEpoch || !cloudActive) return;
      for (const [id, placement] of sentPlacements || []) if (pendingPlacements.get(id) === placement) pendingPlacements.delete(id);
      applyCloudGame(response); result = response.result;
    } catch (cause) {
      if (epoch !== cloudEpoch) return;
      if (cause.status === 409 && cause.data?.game) applyCloudGame(cause.data);
      else if (!account.user) await restoreGuestGame();
      else cloudBlocked = true;
      notify(cause.message || '서버에 연결하지 못했어요. 다시 시도해 주세요.'); save();
      return { ok: false };
    }
  } else result = action();
  notify(result.message);
  renderWorld(); renderUI(); save();
  return result;
}
function setScene(value) {
  sceneMode = value;
  document.body.classList.toggle('overlay-mode', !value);
  desktop?.setSceneMode(value);
  $('scene-toggle').title = value ? '바탕화면 모드로 전환' : '초원 모드로 전환';
  positionPrimaryUI(); renderWorld();
  if ($('window-walking-status')) $('window-walking-status').textContent = surfaceStatusText();
  reportRegions();
}
function toggleMenu(force) {
  const visible = force ?? $('dock').hidden;
  $('dock').hidden = !visible;
  document.body.classList.toggle('menu-hidden', !visible);
  if (!visible) {
    $('character-menu').hidden = true;
    if ($('modal').open) $('modal').close();
  }
  $('launcher').setAttribute('aria-expanded', String(visible));
  $('launcher-chevron').textContent = visible ? '⌄' : '⌃';
  reportRegions();
}
function setPaused(value) {
  paused = value;
  $('pause-overlay').hidden = !paused;
  $('pause-button').innerHTML = icon(paused ? 'play' : 'pause');
  $('pause-button').setAttribute('aria-label', paused ? '계속하기' : '일시 정지');
  if (paused) cancelPlacement();
  reportRegions();
}
function setTab(name) {
  uiTab = name;
  for (const node of document.querySelectorAll('[data-tab]')) {
    node.classList.toggle('active', node.dataset.tab === name);
    node.setAttribute('aria-pressed', String(node.dataset.tab === name));
  }
  if (name !== 'cores') cancelPlacement();
  for (const tab of ['cores','companions','inventory','care','journal']) $('tab-' + tab).hidden = tab !== name;
  renderUI(); reportRegions();
}

function renderUI() {
  const c = state.character;
  $('active-name').textContent = c.name;
  document.querySelector('.place-label h1').textContent = `${c.name}의 작은 초원`;
  $('world').setAttribute('aria-label', `동료 ${getDeployedCharacters(state).length}명이 함께하는 모험 공간`);
  $('active-title').textContent = c.title;
  applyCharacterSprite($('active-portrait'), c, { animation: 'idle', still: true });
  $('active-portrait').alt = c.name;
  if ($('world-name')) $('world-name').textContent = c.name;
  $('character-menu-title').textContent = `${withName(c.name)} 함께`;
  applyCharacterSprite($('care-portrait'), c, { animation: 'sleep', still: true });
  $('care-portrait').alt = `쉬고 있는 ${c.name}`;
  $('care-caption').textContent = `${c.name}는 당신 곁이 좋아요.`;
  $('character')?.setAttribute('aria-label', `${c.name}와 상호작용. 드래그하여 이동할 수 있습니다.`);
  document.querySelector('.command-switch').setAttribute('aria-label', `${c.name} 행동`);
  $('level-badge').textContent = 'Lv. ' + c.level;
  if ($('world-level')) $('world-level').textContent = 'Lv.' + c.level;
  $('hp-text').textContent = `${Math.ceil(c.hp)} / ${c.maxHp}`;
  $('hp-bar').style.width = (c.hp / c.maxHp * 100) + '%';
  $('mana-text').textContent = `${Math.floor(c.mana)} / ${c.maxMana}`;
  $('mana-bar').style.width = (c.maxMana > 0 ? c.mana / c.maxMana * 100 : 0) + '%';
  $('xp-text').textContent = `${c.xp} / ${c.nextXp}`;
  $('xp-bar').style.width = (c.xp / c.nextXp * 100) + '%';
  $('hunger-text').textContent = Math.round(c.hunger) + '%';
  $('mood-text').textContent = Math.round(c.mood) + '%';
  $('gold-text').textContent = state.gold.toLocaleString('ko-KR');
  $('bond-label').textContent = `♡ ${c.bond < 5 ? '우리의 첫 만남' : c.bond < 20 ? '조금씩 가까워지는 중' : '너는 나의 소중한 친구'} · ${c.bond}`;
  for (const b of document.querySelectorAll('[data-command]')) {b.classList.toggle('active', b.dataset.command === c.command); b.setAttribute('aria-pressed', String(b.dataset.command === c.command));}
  $('activity-text').textContent = paused ? '잠시 쉬어 가는 중이에요' : c.action === 'attack' ? `${c.name} · 용감하게 싸우는 중` : c.command === 'rest' ? `${c.name} · 체력과 마나를 회복하는 중` : c.command === 'fight' ? `${c.name} · 모험하는 중` : `${c.name} · 초원을 산책하는 중`;
  $('kills-text').textContent = state.stats.kills;
  $('clears-text').textContent = state.stats.clears;
  $('core-count').textContent = Object.values(state.inventory).reduce((a,b) => a+b, 0);
  if (state.stats.clears > 0) {
    $('quest-title').textContent = '함께 자라는 모험';
    $('quest-copy').textContent = `${state.stats.clears}개의 던전을 탐험했어요. 상점에서 새로운 코어를 만나 보세요.`;
  } else if (state.portals.length) {
    $('quest-title').textContent = `${c.name}, 모험을 부탁해!`;
    $('quest-copy').textContent = '캐릭터 상태에서 모험을 선택하세요. 몬스터를 모두 처치하면 보상을 받아요.';
  }
  const inventoryKey = JSON.stringify(state.inventory) + selectedCore;
  if (lastInventory !== inventoryKey && !drag) {
    lastInventory = inventoryKey;
    $('core-list').innerHTML = CORE_TYPES.map(t => `<button class="core-card ${state.inventory[t.id] ? '' : 'depleted'} ${selectedCore === t.id ? 'selected' : ''}" data-core="${t.id}" aria-label="${t.name}, ${state.inventory[t.id]}개, ${t.monsterName} ${t.count}마리 소환"><span class="core-art"><img src="assets/core-${t.id}.svg" alt=""></span><span class="core-info"><span class="core-name">${t.name}</span><small>${t.monsterName} ${t.count}마리 소환</small><span class="core-meta"><span>권장 Lv.${t.level}</span><span>${t.id === 'grove' ? '초급' : t.id === 'mushroom' ? '중급' : '상급'}</span></span></span><span class="core-qty">×${state.inventory[t.id]}</span></button>`).join('');
  }
  const logKey = state.logs.map(l => l.id).join(',');
  if (logKey !== lastLogs || !$('logs').children.length) {
    lastLogs = logKey;
    $('logs').innerHTML = state.logs.length ? state.logs.map(l => `<li>${escape(l.text)}</li>`).join('') : '<li>카페몽과의 첫 페이지가 열렸어요.<br>초원에 코어를 놓고 모험을 시작해 보세요.</li>';
  }
  renderRoster();
  renderFoodPreview();
  renderCompanionDetail();
  warehouse.render(state.items);
}

function renderRoster() {
  $('companion-count').textContent = state.characters.length;
  $('roster-count').textContent = `${state.characters.length} / ${CHARACTER_TYPES.length + (state.customDefinitions?.length || 0)}`;
  const deployed = new Set(getDeployedCharacters(state).map(c => c.id));
  $('deployed-count').textContent = `${deployed.size} / ${MAX_DEPLOYED_COMPANIONS}`;
  const key = state.characters.map(c => `${c.id}:${c.level}`).join(',') + state.activeCharacterId + [...deployed].join(',');
  if (key !== lastRoster) {
    lastRoster = key;
    $('roster-grid').innerHTML = state.characters.map(c => `<div role="listitem" class="roster-entry"><button class="roster-card ${c.id === state.activeCharacterId ? 'is-active' : ''}" data-companion="${escape(c.id)}" aria-label="${escape(c.name)}, 레벨 ${c.level}${deployed.has(c.id) ? ', 화면에 함께하는 동료' : ''}, 상세 보기"><img src="${c.sprite}" alt=""><strong>${escape(c.name)}</strong><small>Lv. ${c.level} · ${deployed.has(c.id) ? '함께하는 중' : '대기 중'}</small>${c.id === state.activeCharacterId ? '<span class="roster-active-mark" aria-hidden="true">✓</span>' : ''}</button><button class="roster-deploy" data-deploy-character="${escape(c.id)}" data-deployed="${deployed.has(c.id)}" ${deployed.has(c.id) ? deployed.size === 1 ? 'disabled' : '' : deployed.size >= MAX_DEPLOYED_COMPANIONS ? 'disabled' : ''} aria-label="${escape(c.name)} ${deployed.has(c.id) ? '보관하기' : '화면에 꺼내기'}">${deployed.has(c.id) ? '보관하기' : '화면에 꺼내기'}</button></div>`).join('');
  }
  for (const card of $('roster-grid').querySelectorAll('[data-companion]')) {
    const companion = state.characters.find(c => c.id === card.dataset.companion);
    applyCharacterSprite(card.querySelector('img'), companion, { animation: 'idle', still: true });
  }
  const next = getNextCompanion(state);
  $('next-companion-title').textContent = next ? `다음 동료 · ${next.name}` : '기본 동료 · 카페몽';
  $('next-companion-copy').textContent = next ? `던전 ${next.unlockClears}회 완료하면 합류해요. 현재 ${state.stats.clears}회 완료` : '새 동료를 만나면 이곳에서 함께할 동료를 골라 보세요.';
  $('recruit-progress').parentElement.hidden = !next;
  $('recruit-progress').style.width = (next ? Math.min(100, state.stats.clears / next.unlockClears * 100) : 100) + '%';
}
function renderFoodPreview() {
  const food = FOODS.find(f => f.id === $('food-select').value) || FOODS[0];
  const c = state.character;
  const matches = food.tastes.filter(taste => c.tastePreferences.includes(taste)).length;
  $('food-preview').textContent = `${foodName(food.group)} · ${food.tastes.map(tasteName).join(' · ')}`;
  $('food-affinity').textContent = [food.group === c.foodPreference ? '좋아하는 음식 종류' : '', matches ? `좋아하는 맛 ${matches}개 일치` : ''].filter(Boolean).join(' · ') || '새로운 맛도 함께 즐겨요.';
}
function openCompanionDetail(id) {
  const c = state.characters.find(character => character.id === id);
  if (!c) return;
  openModal('동료 이야기', `<section id="companion-detail" aria-label="캐릭터 상세 정보"><div class="profile-hero"><div class="profile-image"><img src="${c.sprite}" alt="${escape(c.name)}"></div><div><h3>${escape(c.name)}<span id="detail-level">Lv. ${c.level}</span></h3><p>${escape(c.title)}</p></div></div><p class="profile-label">A LITTLE MORE ABOUT ME</p><dl class="profile-traits"><div><dt>성격</dt><dd id="detail-personality">${escape(c.personality)}</dd></div><div><dt>선호하는 식습관</dt><dd id="detail-food">${escape(foodName(c.foodPreference))}</dd></div><div><dt>좋아하는 맛 · ${c.tastePreferences.length}가지</dt><dd id="detail-tastes">${c.tastePreferences.map(taste => `<span class="taste-chip">${escape(tasteName(taste))}</span>`).join('') || '<span class="taste-chip">아직 없어요</span>'}</dd></div></dl><p class="profile-label">ADVENTURE STATS</p><dl id="detail-stats">${Object.entries(STAT_LABELS).map(([key,label]) => `<div class="detail-stat" data-stat="${key}"><dt>${label}</dt><dd id="detail-${key}"></dd></div>`).join('')}</dl><p class="stat-explainer">방어는 물리 피해, 저항력은 마법 피해를 줄여요.<br>마나는 마법 공격에 사용하고, 속도는 이동에 반영돼요.</p><button class="primary-button" id="activate-companion"></button><button class="secondary-button full" id="toggle-companion-deployment"></button></section>`);
  modalCompanionId = id;
  $('modal').classList.add('companion-dialog');
  $('activate-companion').onclick = async () => {
    const result = await perform(() => selectCharacter(state,id), 'selectCharacter', { characterId: id });
    if (result?.ok) {lastRoster = '';renderWorld();renderUI();reportRegions();}
  };
  $('toggle-companion-deployment').onclick = () => toggleCompanionDeployment(id);
  renderCompanionDetail();
}
function renderCompanionDetail() {
  if (!modalCompanionId || !$('modal').open || !$('companion-detail')) return;
  const c = state.characters.find(character => character.id === modalCompanionId);
  if (!c) {$('modal').close();return;}
  applyCharacterSprite(document.querySelector('.profile-image img'), c, { animation: 'idle', still: true });
  $('detail-level').textContent = 'Lv. ' + c.level;
  for (const key of Object.keys(STAT_LABELS)) {
    $('detail-' + key).textContent = key === 'hp' ? `${Math.ceil(c.hp)} / ${c.maxHp}` : key === 'mana' ? `${Math.floor(c.mana)} / ${c.maxMana}` : String(c[key]);
  }
  const active = c.id === state.activeCharacterId;
  $('activate-companion').textContent = active ? '지금 선택한 동료' : `${c.name} 선택하기`;
  $('activate-companion').disabled = active;
  $('activate-companion').classList.toggle('companion-current', active);
  const deployed = getDeployedCharacters(state), shown = deployed.some(item => item.id === c.id);
  const toggle = $('toggle-companion-deployment');
  toggle.textContent = shown ? '화면에서 보관하기' : '화면에 꺼내기';
  toggle.disabled = shown ? deployed.length === 1 : deployed.length >= MAX_DEPLOYED_COMPANIONS;
  $('activate-companion').disabled = active || (!shown && deployed.length >= MAX_DEPLOYED_COMPANIONS);
}
async function toggleCompanionDeployment(id) {
  const deployed = !getDeployedCharacters(state).some(character => character.id === id);
  const area = displayFor(state.character);
  const result = await perform(() => setCharacterDeployed(state, id, deployed, innerWidth,
    { displays: worldDisplays(), displayId: area.id }), 'setCharacterDeployed', { characterId: id, deployed });
  if (result?.ok && !deployed) { surfaceWalker.forget(id); surfacePoses.delete(id); surfaceAnimations.delete(id); pendingPlacements.delete(id); }
  reportRegions();
}
function focusCompanion(id) {
  if (state.activeCharacterId === id) return;
  // Selection is immediate presentation; all progress and online commands still
  // target an explicit owned character on the authoritative server.
  selectCharacter(state, id);
  if (cloudActive) void perform(() => {}, 'selectCharacter', { characterId: id });
  renderWorld(); renderUI(); save();
}
function syncActors(container, actors, create, update) {
  const live = new Set(actors.map(a => a.id));
  for (const node of [...container.children]) if (!live.has(node.dataset.id)) node.remove();
  for (const actor of actors) {
    let node = [...container.children].find(n => n.dataset.id === actor.id);
    if (!node) {node = create(actor); node.dataset.id = actor.id; container.append(node);}
    update(node, actor);
  }
}
function renderWorld() {
  document.body.classList.toggle('surface-mode', surfaceMode() || nativeFloor());
  const deployed = getDeployedCharacters(state);
  // IDs remain stable aliases for the selected companion, while every actor is
  // independently addressable by data-character-id.
  for (const node of $('characters').querySelectorAll('[id]')) node.removeAttribute('id');
  syncActors($('characters'), deployed, c => {
    const node = document.createElement('div');
    node.setAttribute('role', 'button'); node.tabIndex = 0;
    node.dataset.characterId = c.id;
    node.innerHTML = '<div class="speech"></div><div class="character-shadow"></div><img class="character-sprite" draggable="false"><div class="character-name"><span class="world-level"></span><span class="world-name"></span><i></i></div>';
    return node;
  }, (char, c) => {
    const area = displayFor(c), pose = syncSurfacePose(c);
    const animation = surfaceAnimations.get(c.id);
    const dragging = drag?.kind === 'character' && drag.characterId === c.id;
    const focused = c.id === state.activeCharacterId;
    const sprite = char.querySelector('.character-sprite'), speech = char.querySelector('.speech');
    if (focused) {
      char.id = 'character'; sprite.id = 'character-sprite'; speech.id = 'speech';
      char.querySelector('.world-name').id = 'world-name'; char.querySelector('.world-level').id = 'world-level';
    }
    char.style.setProperty('--character-scale', characterScale()); char.dataset.scale = String(characterScale());
    char.dataset.displayId = c.displayId || area.id;
    char.className = `character interactive ${animation?.walking ? 'walk' : c.action} ${dragging ? 'dragging' : ''} ${cloudActive && (!surfaceMode() || pose.onFloor) ? 'cloud-floor' : ''} ${focused ? 'is-focused' : ''}`;
    char.setAttribute('aria-label', `${c.name}와 상호작용. 드래그하여 이동할 수 있습니다.`);
    char.setAttribute('aria-pressed', String(focused));
    const spriteFrame = applyCharacterSprite(sprite, c, { paused, still: document.body.classList.contains('reduced-motion'),
      ...(animation?.walking && !(c.animationState === 'pet' && c.animationTimer > 0) ? { animation: 'walk', time: animation.time } : {}) });
    const inset = getCharacterFootInset(c, characterSize(), spriteFrame);
    const footMode = surfaceMode() || nativeFloor();
    char.style.left = (c.x - characterSize() / 2) + 'px';
    if (footMode || dragging) {
      const footY = dragging ? drag.footY : surfaceMode() ? pose.footY : area.floorY;
      char.style.bottom = (innerHeight - footY - 16 - inset) + 'px';
      char.style.setProperty('--foot-inset', inset + 'px');
      char.dataset.surfaceId = pose.surfaceId || ''; char.dataset.surfaceKind = dragging ? 'air' : pose.surfaceKind || 'floor';
      char.dataset.footY = String(footY);
    } else {
      char.style.bottom = (innerHeight - area.floorY + floor()) + 'px';
      delete char.dataset.surfaceId; delete char.dataset.surfaceKind; delete char.dataset.footY;
      char.style.removeProperty('--foot-inset');
    }
    char.classList.toggle('custom-character', Boolean(c.custom || c.spriteSheet));
    sprite.alt = c.name; sprite.style.scale = `${c.facing} 1`;
    char.querySelector('.world-name').textContent = c.name; char.querySelector('.world-level').textContent = 'Lv.' + c.level;
    speech.textContent = c.speechTime > 0 ? c.speech : '';
    const speechHalf = speech.offsetWidth / 2;
    const speechCenter = Math.max(area.x + speechHalf + 8, Math.min(area.x + area.width - speechHalf - 8, c.x));
    speech.style.left = (characterSize() / 2 + speechCenter - c.x) + 'px';
  });
  syncActors($('drop-zones'), worldDisplays(), () => {
    const zone = document.createElement('div'); zone.className = 'drop-zone';
    zone.setAttribute('aria-label', '던전 코어 배치 영역');
    zone.innerHTML = '<span class="drop-plus">+</span><span>이곳에 던전 코어를 놓아 주세요</span>';
    return zone;
  }, (zone, area) => {
    zone.id = area.id === primaryDisplay().id ? 'drop-zone' : '';
    zone.style.left = (area.x + 22) + 'px'; zone.style.width = Math.max(1, area.width - 44) + 'px';
    zone.style.bottom = (innerHeight - area.floorY + (nativeFloor() ? 8 : floor() + 8)) + 'px';
  });
  syncActors($('portals'), state.portals, p => {
    const el = document.createElement('button');
    el.className = 'portal interactive';
    el.innerHTML = `<span class="portal-label"></span><span class="portal-glow"></span><img src="assets/portal-${p.coreId}.svg" alt="${typeFor(p.coreId).name} 던전 입구">`;
    el.addEventListener('click', () => {const active = state.portals.find(a => a.id === p.id); if (active) notify(`${typeFor(active.coreId).monsterName} ${active.defeated}/${active.total}마리 처치 · 모험 명령으로 싸워 주세요.`);});
    return el;
  }, (el,p) => {el.style.left = p.x + 'px';el.style.bottom = (innerHeight - displayFor(p).floorY + (nativeFloor() ? 6 : floor() + 6)) + 'px';el.querySelector('.portal-label').textContent = `${typeFor(p.coreId).name.replace(' 코어','')} · ${p.defeated}/${p.total}`;});
  syncActors($('monsters'), state.monsters, m => {
    const el = document.createElement('div'); el.className = 'monster';
    el.innerHTML = `<div class="monster-health"><i></i></div><img src="assets/${m.type === 'grove' ? 'slime' : m.type}.svg" alt="${escape(m.name)}">`;
    return el;
  }, (el,m) => {el.style.left = m.x + 'px';el.style.bottom = (innerHeight - displayFor(m).floorY + (nativeFloor() ? 0 : floor() + 18)) + 'px';el.querySelector('i').style.width = (m.hp / m.maxHp * 100) + '%';});
  syncActors($('effects'), state.effects, e => {
    const el = document.createElement('div'); el.className = 'floating-effect ' + e.kind;
    const item = e.kind === 'loot' ? itemFor(e.itemId) : null;
    if (item) {
      const art = document.createElement('img'); art.src = item.icon; art.alt = '';
      const label = document.createElement('span'); label.textContent = e.text;
      el.append(art, label); el.dataset.itemDrop = item.id;
    } else el.textContent = e.text;
    return el;
  }, (el,e) => {
    el.style.bottom = (innerHeight - displayFor(e).floorY + (nativeFloor() ? 0 : floor()) + (e.kind === 'loot' ? 28 : 90)) + 'px';
    const half = e.kind === 'loot' ? el.offsetWidth / 2 + 8 : 0;
    el.style.left = Math.max(half, Math.min(innerWidth - half, e.x)) + 'px';
    el.style.transform = `translate(-50%,${-(1.4 - e.life) * 40 - (e.lootIndex || 0) * 34}px)`;
    el.style.opacity = Math.min(1, e.life * 2);
  });
  if (!$('character-menu').hidden) positionCharacterMenu();
}
function positionCharacterMenu() {
  const menu = $('character-menu'), area = displayFor(state.character), actor = $('character');
  if (!actor) return;
  menu.style.left = Math.max(area.x + 12, Math.min(area.x + area.width - menu.offsetWidth - 12, state.character.x - menu.offsetWidth / 2)) + 'px';
  const top = Math.max(area.y + 12, Math.min(area.y + area.height - menu.offsetHeight - 12, actor.getBoundingClientRect().top - menu.offsetHeight - 12));
  menu.style.top = top + 'px'; menu.style.bottom = 'auto';
}
function selectCore(id) {
  if (paused) {notify('계속하기를 누른 뒤 코어를 배치해 주세요.'); return false;}
  if (!state.inventory[id]) {openShop(); notify('이 코어는 상점에서 구입할 수 있어요.');return false;}
  selectedCore = id;
  document.body.classList.add('placing');
  $('placement-banner').hidden = false;
  $('placement-text').textContent = `${typeFor(id).name} · 초원 바닥을 선택해 주세요`;
  $('character-menu').hidden = true;
  renderUI(); reportRegions();
  return true;
}
function cancelPlacement() {
  selectedCore = null;
  document.body.classList.remove('placing');
  $('placement-banner').hidden = true;
  $('drag-preview').hidden = true;
  renderUI(); reportRegions();
}
async function placeAt(x,y) {
  if (!selectedCore) return;
  const area = displayForPoint(worldDisplays(), x, y);
  const zone = [...$('drop-zones').children].find(node => node.dataset.id === area.id)?.getBoundingClientRect();
  if (!zone || y < zone.top || y > zone.bottom || x < zone.left || x > zone.right) {notify('점선으로 표시된 초원 바닥에 놓아 주세요.');return;}
  const coreId = selectedCore;
  const result = await perform(() => deployCore(state, coreId, x, innerWidth, { displays: worldDisplays(), displayId: area.id }), 'deployCore', { coreId, x, displayId: area.id });
  if (result?.ok) {cancelPlacement(); if (innerWidth < 760) toggleMenu(false);}
}

function reportRegions() {
  if (!desktop) return;
  const targets = [...document.querySelectorAll('.interactive')];
  if (selectedCore) targets.push(...$('drop-zones').children);
  if (paused) targets.push($('resume-button'));
  const rects = targets.filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => {const r = n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  desktop.setInteractiveRegions(rects);
  desktop.setMouseCapture(Boolean(drag || $('modal').open));
}
function startDrag(event, kind, extra = {}) {
  if (event.button !== 0 || drag) return;
  const target = extra.target || event.currentTarget;
  drag = {kind, startX:event.clientX, startY:event.clientY, moved:false, pointerId:event.pointerId, ...extra, target};
  target.setPointerCapture(event.pointerId);
  desktop?.setMouseCapture(true);
  if (kind === 'character' && cloudActive) { lastCloudSync = 0; void syncCloudGame(); }
}
$('core-list').addEventListener('pointerdown', e => {
  const card = e.target.closest('[data-core]');
  if (!card || drag || e.button !== 0 || !selectCore(card.dataset.core)) return;
  startDrag(e, 'core', {id:card.dataset.core});
  $('drag-preview').querySelector('img').src = `assets/core-${card.dataset.core}.svg`;
});
$('core-list').addEventListener('click', e => {if (e.detail === 0) {const card = e.target.closest('[data-core]');if (card) selectCore(card.dataset.core);}});
$('characters').addEventListener('pointerdown', e => {
  const node = e.target.closest('[data-character-id]');
  if (!node || selectedCore || e.button !== 0 || drag) return;
  const character = state.characters.find(c => c.id === node.dataset.characterId);
  if (!character) return;
  focusCompanion(character.id);
  const pose = syncSurfacePose(character), box = node.getBoundingClientRect();
  const footY = surfaceMode() || nativeFloor() ? pose.footY : box.bottom - 16 - getCharacterFootInset(character, characterSize());
  startDrag(e, 'character', { target: node, characterId: character.id, x: box.left + box.width / 2,
    surface: surfaceMode(), startFootY: footY, footY, startDisplayId: character.displayId });
});
$('characters').addEventListener('keydown', e => {
  const node = e.target.closest('[data-character-id]');
  if (node && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault(); focusCompanion(node.dataset.characterId);
    $('character-menu').hidden = !$('character-menu').hidden; positionCharacterMenu(); reportRegions();
  }
});
$('dock-handle').addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  const rect = $('dock').getBoundingClientRect();startDrag(e,'dock',{x:rect.x,y:rect.y});
});
window.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (Math.hypot(dx,dy) > 5) drag.moved = true;
  if (!drag.moved) return;
  if (drag.kind === 'core') {$('drag-preview').hidden = false;$('drag-preview').style.transform = `translate(${e.clientX-32}px,${e.clientY-32}px)`;}
  if (drag.kind === 'character') {
    const character = state.characters.find(c => c.id === drag.characterId);
    if (!character) return;
    const area = displayForPoint(worldDisplays(), e.clientX, e.clientY);
    const point = clampCharacterPoint(area, drag.x + dx, drag.startFootY + dy, characterSize());
    character.x = point.x; character.displayId = area.id; drag.footY = point.footY;
    if (drag.surface) surfacePoses.set(character.id, surfaceWalker.beginDrag(surfaceOptions(character, { footY: drag.footY })));
    $('character-menu').hidden = true; renderWorld();
  }
  if (drag.kind === 'dock') {customDock = true;clampDock(drag.x + dx, drag.y + dy);}

});
function endDrag(e, cancelled = false) {
  if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return;
  const previous = drag; drag = null;
  try {previous.target.releasePointerCapture(previous.pointerId);} catch {}
  if (previous.kind === 'core' && previous.moved && !cancelled) {
    const hit = document.elementFromPoint(e.clientX,e.clientY);
    if (hit?.closest('.dock,#bottom-bar,#modal')) notify('메뉴 바깥의 초원 바닥에 놓아 주세요.');
    else void placeAt(e.clientX,e.clientY);
  }
  if (previous.kind === 'character') {
    const character = state.characters.find(c => c.id === previous.characterId);
    if (character) {
      if (cancelled && previous.moved) {
        character.x = previous.x; character.displayId = previous.startDisplayId; surfaceWalker.forget(character.id);
        if (cloudActive) pendingPlacements.set(character.id, { x: character.x, displayId: character.displayId });
      }
      else if (previous.moved) {
        moveCharacter(state, character.id, character.x, innerWidth, { displays: worldDisplays(), displayId: character.displayId });
        if (cloudActive) { pendingPlacements.set(character.id, { x: character.x, displayId: character.displayId }); lastCloudSync = 0; }
        character.speech = previous.surface && character.command === 'fight' ? '모험은 바닥에서 계속할게!' : '여기도 멋진 곳이네!'; character.speechTime = 3;
      } else if (!cancelled) { $('character-menu').hidden = !$('character-menu').hidden; positionCharacterMenu(); }
      if (previous.surface && !cancelled) surfacePoses.set(character.id, surfaceWalker.release(surfaceOptions(character, { footY: previous.footY })));
      save();
      if (cloudActive) { lastCloudSync = 0; void syncCloudGame(); }
    }
  }
  $('drag-preview').hidden = true;
  renderWorld(); renderUI(); reportRegions();
}
window.addEventListener('pointerup', e => endDrag(e));
window.addEventListener('pointercancel', e => {
  if (drag && e.pointerId !== drag.pointerId) return;
  endDrag(e,true);cancelPlacement();
});
window.addEventListener('blur', () => {if (drag) endDrag({},true);save();});
$('world').addEventListener('click', e => {
  if (selectedCore && !e.target.closest('.interactive')) placeAt(e.clientX,e.clientY);
  else if (!e.target.closest('.interactive')) {$('character-menu').hidden = true;reportRegions();}
});

function openModal(title, content) {
  accountPanel?.dispose(); accountPanel = null;
  updatesPanel?.dispose(); updatesPanel = null;
  settingsGeneration += 1;
  modalCompanionId = null;
  $('modal').classList.remove('companion-dialog', 'settings-dialog');
  cancelPlacement();$('character-menu').hidden = true;
  $('modal-title').textContent = title;$('modal-content').innerHTML = content;
  if (!$('modal').open) $('modal').showModal();
  reportRegions();
}
function openHelp() {
  openModal('작은 모험을 시작해 볼까요?', `<p class="modal-copy">카페몽은 바탕화면에서 함께 자라는 작은 친구예요.<br>천천히, 당신의 속도로 놀아 주세요.</p><div class="guide-step"><span>1</span><div><strong>여러 동료와 함께해요</strong><p>동료 탭에서 최대 6명까지 화면에 꺼내세요. 동료를 누르면 그 동료를 돌보고 지시할 수 있어요.<br>드래그해서 다른 모니터나 창 위로 옮겨 보세요.</p></div></div><div class="guide-step"><span>2</span><div><strong>코어로 던전을 열어요</strong><p>가방의 코어를 바닥으로 끌어 놓으세요. 코어를 선택하고 바닥을 눌러도 돼요. 던전은 동시에 3개까지 열려요.</p></div></div><div class="guide-step"><span>3</span><div><strong>모험하고, 돌보고, 성장해요</strong><p>‘모험’을 선택하면 카페몽이 몬스터와 싸워요. 경험치와 골드로 성장하고, 휴식과 간식으로 회복해 주세요. 상점과 오늘의 선물에서 코어를 얻어요.</p></div></div><p class="talk-hint">메뉴 상단을 잡아 이동 · 우측 하단 버튼으로 메뉴 접기<br>Esc: 배치 취소 · 데스크톱 앱: Ctrl/⌘ + Shift + M으로 메뉴 전환</p><button class="primary-button full" id="start-guide">카페몽과 함께하기</button>`);
  $('start-guide').onclick = () => $('modal').close();
}
function openShop() {
  openModal('초원의 작은 코어 상점', `<p class="modal-copy">모험으로 모은 골드로 새로운 길을 열어 보세요.<br>보유 골드 <strong id="shop-gold">${state.gold} G</strong></p>${CORE_TYPES.map(t => `<div class="shop-item"><img src="assets/core-${t.id}.svg" alt=""><div><strong>${t.name}</strong><p>${t.monsterName} ${t.count}마리 · 권장 Lv.${t.level}</p></div><button data-buy="${t.id}">${t.price} G 구매</button></div>`).join('')}`);
  for (const button of document.querySelectorAll('[data-buy]')) button.onclick = async () => {await perform(() => buyCore(state,button.dataset.buy), 'buyCore', { coreId: button.dataset.buy });if ($('shop-gold')) $('shop-gold').textContent = state.gold + ' G';};
}
function openItemDetail(id) {
  const item = itemFor(id);
  if (!item || !state.items[id]) return;
  const sources = CORE_TYPES.flatMap(type => (MONSTER_DROPS[type.id] || [])
    .filter(drop => drop.itemId === id)
    .map(drop => `<li><span>${escape(type.monsterName)}</span><b>${Math.round(drop.chance * 100)}% · ${drop.quantity}개</b></li>`)).join('');
  openModal(item.name, `<div class="item-detail"><div class="item-detail-hero"><img src="${item.icon}" alt=""><div><strong>보유 수량 ${state.items[id].toLocaleString('ko-KR')}개</strong><p>${item.rarity === 'rare' ? '희귀 재료' : '일반 재료'}</p></div></div><p class="item-detail-info">${escape(item.description)}</p><h3>획득 방법</h3><ul class="item-detail-sources">${sources}</ul><p class="talk-hint">몬스터를 처치하면 확률에 따라 창고에 자동 보관돼요.<br>이 아이템은 창고에 보관하는 수집용 재료예요.</p></div>`);
}
function openTalk() {
  const c = state.character;
  openModal(`${c.name}에게 말을 걸어 보세요`, `<img class="talk-face" src="${c.sprite}" alt="${escape(c.name)}"><div class="talk-reply" id="talk-reply">오늘 하루는 어땠어? 네 이야기가 궁금해.</div><form class="talk-form" id="talk-form"><input id="talk-input" maxlength="120" autocomplete="off" placeholder="${escape(c.name)}, 안녕!" aria-label="동료에게 할 말"><button class="primary-button" type="submit">보내기</button></form><p class="talk-hint">안녕, 성격, 좋아하는 음식, 모험, 쉬자 같은 말에 반응해요.</p>`);
  applyCharacterSprite(document.querySelector('.talk-face'), c, { animation: 'idle', still: true });
  $('talk-form').onsubmit = e => {
    e.preventDefault();const text = $('talk-input').value.trim();if (!text) return;
    let reply = /성격/.test(text) ? c.personality : /음식|식성|맛/.test(text) ? `나는 ${foodName(c.foodPreference)}을(를) 좋아해!${c.tastePreferences.length ? ` 특히 ${c.tastePreferences.map(tasteName).join(', ')}이면 더 좋아.` : ' 다양한 맛을 알아가는 중이야.'}` : /안녕|반가/.test(text) ? '안녕! 네가 와서 초원이 더 따뜻해졌어.' : /사랑|좋아|귀여/.test(text) ? '나도 네가 정말 좋아! 우리 오래오래 함께하자. ♡' : /힘들|슬퍼|피곤/.test(text) ? '오늘도 수고했어. 내가 옆에 있을게. 잠깐 같이 쉬자.' : /모험|싸워|전투/.test(text) ? '모험 준비 완료! 상태 창에서 모험을 눌러 주면 출발할게.' : /쉬|자자|잘자/.test(text) ? '하암… 포근한 휴식도 중요하지. 휴식 버튼으로 함께 쉬어 가자.' : /배고|밥|간식/.test(text) ? '냠냠, 맛있는 음식 생각이 나! 가방의 돌보기에서 식사를 고를 수 있어.' : /이름|누구/.test(text) ? `나는 ${c.name}! ${c.title}야.` : '응, 듣고 있어. 너와 함께하는 이 시간이 좋아.';
    $('talk-reply').textContent = reply;const target = state.characters.find(character => character.id === c.id);if (target) {target.speech = reply;target.speechTime = 6;}$('talk-input').value = '';
  };
  $('talk-input').focus();
}
function openSettings(initialTab = 'general') {
  const tabs = ['general', 'account', 'updates'];
  openModal('우리의 작은 공간', `<div class="settings-tabs" role="tablist" aria-label="설정 메뉴"><button type="button" id="settings-general-tab" role="tab" aria-selected="true" aria-controls="settings-general">일반</button><button type="button" id="settings-account-tab" role="tab" aria-selected="false" aria-controls="settings-account" tabindex="-1">계정</button><button type="button" id="settings-updates-tab" role="tab" aria-selected="false" aria-controls="settings-updates" tabindex="-1">업데이트</button></div><section id="settings-general" class="settings-panel" role="tabpanel" aria-labelledby="settings-general-tab"><div class="settings-row"><span>초원 배경<small>${desktop ? '끄면 실제 바탕화면 위에서 놀아요' : '브라우저에서는 단색 배경으로 전환해요'}</small></span><button id="setting-scene">${sceneMode ? '켜짐' : '꺼짐'}</button></div><div class="settings-row character-size-setting"><span>캐릭터 크기<small>1배는 기존 크기 · 기본값은 2배</small></span><div class="scale-options" role="group" aria-label="캐릭터 크기">${[1,2,3].map(scale => `<button type="button" data-character-scale="${scale}" aria-pressed="${characterScale() === scale}">${scale}배</button>`).join('')}</div></div><div class="settings-row"><label for="window-walking-toggle">창 위에서 걷기<small id="window-walking-status">${surfaceStatusText()}</small></label><input type="checkbox" id="window-walking-toggle" ${state.settings.windowWalking ? 'checked' : ''}></div><div class="settings-row"><span>모션 줄이기<small>픽셀 애니메이션을 쉬게 해요</small></span><button id="setting-motion">${document.body.classList.contains('reduced-motion') ? '켜짐' : '꺼짐'}</button></div><div class="settings-row"><span>게임 진행<small>잠깐 쉬어 가고 싶을 때</small></span><button id="setting-pause">${paused ? '계속하기' : '일시 정지'}</button></div><p class="talk-hint">${cloudActive ? '계정 모험은 서버에 자동 저장돼요. 기기의 모험은 별도로 보관해요.' : '이 기기의 모험을 플레이 중이에요. 계정 탭에서 온라인 모험에 로그인할 수 있어요.'}</p>${desktop ? '<button class="secondary-button full" id="quit-game">저장하고 종료</button>' : ''}<button class="danger-button" id="reset-game">처음부터 다시 시작하기</button></section><section id="settings-account" class="settings-panel" role="tabpanel" aria-labelledby="settings-account-tab" hidden></section><section id="settings-updates" class="settings-panel" role="tabpanel" aria-labelledby="settings-updates-tab" hidden></section>`);
  $('modal').classList.add('settings-dialog');
  const generation = settingsGeneration;
  accountPanel = mountAccountPanel($('settings-account'), {
    client: account, getPlayMode: () => cloudActive ? 'online' : 'guest',
    onLogin: async credentials => {
      await account.login(credentials); await activateCloudGame();
      if (generation === settingsGeneration && $('modal').open) openSettings('account');
      notify('온라인 계정의 모험을 불러왔어요.');
    },
    onRegister: async credentials => {
      await account.register(credentials); await activateCloudGame();
      if (generation === settingsGeneration && $('modal').open) openSettings('account');
      notify('계정을 만들고 온라인 모험을 시작했어요.');
    },
    onChangePassword: async credentials => {
      await account.changePassword(credentials);
      notify('비밀번호를 변경했어요. 다른 기기의 로그인은 해제돼요.');
    },
    onLogout: async () => {
      if (!cloudActive && !save()) throw new Error('기기의 모험을 저장하지 못했어요. 저장 공간을 확인해 주세요.');
      cloudEpoch += 1;
      const result = await account.logout(); await restoreGuestGame();
      openSettings('account'); notify(result.revoked ? '로그아웃하고 이 기기의 모험으로 돌아왔어요.' : '기기에서 로그아웃했어요. 서버 세션 종료는 연결 상태를 확인해 주세요.');
    },
    onSync: async () => {
      if (!account.user) await account.initialize();
      if (!cloudActive) await activateCloudGame();
      else await syncCloudGame();
      if (cloudBlocked) throw new Error('서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    },
    onDelete: async credentials => {
      if (!cloudActive && !save()) throw new Error('기기의 모험을 저장하지 못했어요. 저장 공간을 확인해 주세요.');
      await account.deleteAccount(credentials); await restoreGuestGame();
      openSettings('account'); notify('온라인 계정과 진행도를 삭제했어요. 기기의 모험은 유지돼요.');
    },
  });
  updatesPanel = mountUpdatesPanel($('settings-updates'), { desktop, version: document.querySelector('.version-tag b').textContent.trim() });
  function settingsTab(name) {
    for (const tab of tabs) {
      const active = tab === name;
      $('settings-' + tab).hidden = !active;
      $('settings-' + tab + '-tab').setAttribute('aria-selected', String(active));
      $('settings-' + tab + '-tab').tabIndex = active ? 0 : -1;
    }
    reportRegions();
  }
  for (const tab of tabs) {
    const button = $('settings-' + tab + '-tab');
    button.onclick = () => settingsTab(tab);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length];
      settingsTab(next); $('settings-' + next + '-tab').focus();
    };
  }
  settingsTab(tabs.includes(initialTab) ? initialTab : 'general');
  for (const button of document.querySelectorAll('[data-character-scale]')) {
    button.onclick = async () => {
      const scale = Number(button.dataset.characterScale);
      const result = cloudActive ? await perform(() => {}, 'setCharacterScale', { scale }) : setCharacterScale(state, scale, document.documentElement.clientWidth, { displays: worldDisplays() });
      if (!result?.ok) { if (result?.message) notify(result.message); return; }
      for (const control of document.querySelectorAll('[data-character-scale]')) control.setAttribute('aria-pressed', String(Number(control.dataset.characterScale) === characterScale()));
      renderWorld(); reportRegions();
      if (!save()) notify('배율을 적용했지만 저장하지 못했어요. 저장 공간을 확인해 주세요.');
    };
  }
  $('setting-scene').onclick = e => {setScene(!sceneMode);e.target.textContent = sceneMode ? '켜짐' : '꺼짐';};
  $('window-walking-toggle').onchange = async e => {
    if (cloudActive) await perform(() => {}, 'setWindowWalking', { enabled: e.target.checked });
    else setWindowWalking(state, e.target.checked);
    e.target.checked = state.settings.windowWalking;
    renderWorld(); reportRegions();
    if ($('window-walking-status')) $('window-walking-status').textContent = surfaceStatusText();
    if (!save()) notify('설정을 적용했지만 저장하지 못했어요. 저장 공간을 확인해 주세요.');
  };
  $('setting-motion').onclick = e => {document.body.classList.toggle('reduced-motion');e.target.textContent = document.body.classList.contains('reduced-motion') ? '켜짐' : '꺼짐';};
  $('setting-pause').onclick = e => {setPaused(!paused);e.target.textContent = paused ? '계속하기' : '일시 정지';};
  if (desktop) $('quit-game').onclick = () => {save();desktop.quit();};
  $('reset-game').onclick = () => {
    if (resettingGame) { notify('초기화가 끝난 뒤 다시 시도해 주세요.'); return; }
    openModal('새로운 모험을 시작할까요?', `<p class="modal-copy">${cloudActive ? '이 계정의 동료 획득, 성장 기록, 골드, 아이템, 코어와 모험 기록을 초기화해요. 기기의 모험은 유지돼요.' : '직접 만든 동료와 업로드한 그림을 포함하여, 이 기기의 동료와 성장 기록, 골드, 아이템, 코어와 모험 기록을 초기화해요.'} 되돌릴 수 없어요.</p><button class="primary-button full" id="confirm-reset">초기화하고 다시 시작</button><button class="secondary-button full" id="cancel-reset" style="margin-top:10px">지금의 모험 계속하기</button>`);
    $('cancel-reset').onclick = () => $('modal').close();
    $('confirm-reset').onclick = async () => {
      if (resettingGame) { notify('초기화가 끝난 뒤 다시 시도해 주세요.'); return; }
      const button = $('confirm-reset'); button.disabled = true; resettingGame = true;
      try {
        if (cloudActive) {
          const response = await account.gameAction('reset', {}, cloudPresence);
          clearCompanionPlacement(); applyCloudGame(response);
          $('modal').close(); notify('계정 모험을 처음부터 시작해요.'); return;
        }
        const nextState = createGame(); nextState.character.x = primaryDisplay().x + primaryDisplay().width * .39;
        for (const character of state.characters) surfaceWalker.forget(character.id);
        for (const item of state.customDefinitions) rememberSheetCleanup(item.sheetId);
        commitGuestState(nextState); normalizePlacement();
        for (const id of [...sheetURLs.keys()]) releaseSheetURL(id);
        lastInventory = '';
        $('quest-title').textContent = '작은 모험의 시작';
        $('quest-copy').textContent = '가방 속 던전 코어를 초원에 놓아 보세요.';
        setPaused(false); refreshCharacters(); $('modal').close();
        notify('카페몽과의 새로운 이야기가 시작돼요.');
        const cleaned = await cleanupSpriteSheets();
        if (!cleaned) notify('남은 이미지 정리를 다음 실행에서 다시 시도할게요.');
      } catch (cause) { notify(cause.message || '초기화 내용을 저장하지 못했어요.'); }
      finally { button.disabled = false; resettingGame = false; }
    };
  };
}

$('scene-toggle').onclick = () => setScene(!sceneMode);
$('pause-button').onclick = () => setPaused(!paused);
$('resume-button').onclick = () => setPaused(false);
$('launcher').onclick = () => toggleMenu();
$('minimize-button').onclick = () => toggleMenu(false);
$('cancel-placement').onclick = cancelPlacement;
$('close-character').onclick = () => {$('character-menu').hidden = true;reportRegions();};
$('close-modal').onclick = () => $('modal').close();
$('modal').addEventListener('close', () => {if ($('modal').open) return;settingsGeneration += 1;accountPanel?.dispose();accountPanel=null;updatesPanel?.dispose();updatesPanel=null;modalCompanionId=null;reportRegions();});
$('help-button').onclick = openHelp;$('guide-link').onclick = openHelp;
$('shop-button').onclick = openShop;$('settings-button').onclick = openSettings;
function careAction(type, value) {
  const characterId = state.activeCharacterId;
  if (type === 'pet') return perform(() => petCharacter(state, characterId), 'pet', { characterId });
  if (type === 'feed') return perform(() => feedCharacter(state, value, characterId), 'feed', { foodId: value, characterId });
  return perform(() => setCommand(state, value, characterId), 'command', { command: value, characterId });
}
$('pet-action').onclick = $('care-pet').onclick = () => careAction('pet');
$('feed-action').onclick = () => careAction('feed', 'snack');
$('care-feed').onclick = () => careAction('feed', $('food-select').value);
$('food-select').onchange = renderFoodPreview;
$('active-detail-button').onclick = () => openCompanionDetail(state.activeCharacterId);
$('roster-grid').onclick = e => {
  const control = e.target.closest('[data-deploy-character]');
  if (control) { void toggleCompanionDeployment(control.dataset.deployCharacter); return; }
  const card = e.target.closest('[data-companion]'); if (card) openCompanionDetail(card.dataset.companion);
};
$('care-rest').onclick = () => careAction('command', 'rest');
$('talk-action').onclick = openTalk;
$('adventure-action').onclick = () => {void careAction('command', 'fight');$('character-menu').hidden = true;};
$('daily-button').onclick = () => perform(() => claimDaily(state), 'claimDaily');
for (const node of document.querySelectorAll('[data-tab]')) node.onclick = () => setTab(node.dataset.tab);
for (const node of document.querySelectorAll('[data-command]')) node.onclick = () => careAction('command', node.dataset.command);
document.querySelector('.brand').onclick = e => {e.preventDefault();toggleMenu(true);};
document.addEventListener('keydown', e => {if (e.key === 'Escape') {cancelPlacement();$('character-menu').hidden = true;}});
desktop?.onToggleMenu(() => toggleMenu());
desktop?.onDisplays?.(snapshot => {
  const next = readDesktopLayout(snapshot);
  if (!next) return;
  if (drag) endDrag({}, true);
  desktopLayout = next; topologyReady = true;
  for (const character of state.characters) surfaceWalker.forget(character.id);
  surfacePoses.clear();
  normalizePlacement(); positionPrimaryUI();
  if (cloudActive) {
    // Geometry is sent to the server for authoritative remapping. Render a safe
    // temporary placement without stepping online combat while that sync runs.
    remapVisualLayout(state);
    for (const character of getDeployedCharacters(state)) if (pendingPlacements.has(character.id)) {
      pendingPlacements.set(character.id, { x: character.x, displayId: character.displayId });
    }
    lastCloudSync = 0;
  }
  renderWorld(); renderUI(); reportRegions(); save();
  resolveTopology?.(); resolveTopology = null;
});
desktop?.requestDisplays?.();
desktop?.onSurfaces?.(snapshot => {
  surfaceSnapshot = snapshot; surfaceWalker.updateSnapshot(snapshot);
  renderWorld(); reportRegions();
  if ($('window-walking-status')) $('window-walking-status').textContent = surfaceStatusText();
});
desktop?.requestSurfaces?.();
window.addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', () => {lastFrame = performance.now();if (document.hidden) save();});
window.addEventListener('resize', () => {
  // Electron follows with a topology event. A viewport-only fallback here would
  // otherwise overwrite the saved positions on left/upper monitors.
  if (!desktop?.requestDisplays) normalizePlacement();
  positionPrimaryUI(); if (customDock) clampDock();
  renderWorld(); reportRegions();
});

function frame(now) {
  const dt = Math.min((now-lastFrame)/1000,.1); lastFrame=now;
  const characters = getDeployedCharacters(state);
  const elevatedCharacterIds = characters.filter(c => surfaceMode() && !syncSurfacePose(c).onFloor).map(c => c.id);
  const running = topologyReady && !paused && !cloudBlocked && !document.hidden;
  const pausedCharacterIds = drag?.kind === 'character' ? [drag.characterId] : [];
  if (running && !cloudActive) stepGame(state,dt,innerWidth,Math.random,{ displays: worldDisplays(), elevatedCharacterIds, pausedCharacterIds });
  else if (running && cloudActive) {
    // Online rewards/progress come only from the server. Advance visual time,
    // never roll loot or resolve combat again on the client.
    for (const character of characters) if (!pausedCharacterIds.includes(character.id)) {
      character.animationTime += dt;
      character.speechTime = Math.max(0, character.speechTime - dt);
    }
    state.effects = state.effects.filter(effect => (effect.life -= dt) > 0);
  }
  for (const character of getDeployedCharacters(state)) syncSurfacePose(character, running ? dt : 0, true);
  renderWorld();
  if (now-lastUI>200) {renderUI();lastUI=now;}
  if (now-lastRegions>100) {reportRegions();lastRegions=now;}
  if (topologyReady && now-lastSave>5000) {save();lastSave=now;}
  if (cloudActive && !account.user && !cloudBusy) {
    void restoreGuestGame(); notify('로그인이 만료되어 이 기기의 모험으로 돌아왔어요.');
  } else if (cloudActive && now-lastCloudSync>1000 && !cloudBusy) void syncCloudGame();
  requestAnimationFrame(frame);
}
if (matchMedia('(prefers-reduced-motion: reduce)').matches) document.body.classList.add('reduced-motion');
// Native topology must arrive before restoring multi-monitor positions.
normalizePlacement();
setScene(sceneMode);renderWorld();renderUI();requestAnimationFrame(frame);
restoreSpriteSheets();
cleanupSpriteSheets();
account.initialize().then(user => user ? activateCloudGame() : null).catch(cause => {
  notify(cause.message || '온라인 연결을 확인하지 못했어요. 이 기기의 모험을 계속할 수 있어요.');
});

preloadBundledSprites().then(failures => {
  lastRoster = ''; renderUI(); renderWorld();
  if (failures.length) notify('기본 캐릭터 시트를 읽지 못했어요. 소스의 카페몽 원본 PNG를 확인해 주세요.');
});
