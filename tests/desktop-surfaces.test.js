import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceWalker } from '../src/desktop-surfaces.js';

const base = { characterId: 'cafemong', width: 1200, height: 900, size: 192, x: 400, dt: 0.1 };
const ledge = (id = 'window:1:0', x = 100, y = 400, width = 600) => ({ id, kind: 'window', x, y, width });
const segment = (id, x, width, changes = {}) => ({ ...ledge(id, x, 400, width),
  windowId: 'window:1', anchorX: 100, windowWidth: 900, ...changes });
function snapshot(walker, surfaces = [ledge()], changes = {}) {
  walker.updateSnapshot({ supported: true, status: 'ready', width: 1200, height: 900,
    surfaces: [{ id: 'desktop-floor', kind: 'taskbar', x: 0, y: 900, width: 1200 }, ...surfaces], ...changes });
}
function create(surfaces) {
  const walker = createSurfaceWalker();
  snapshot(walker, surfaces);
  return walker;
}
function drop(walker, changes = {}) {
  walker.beginDrag({ ...base, footY: 400, ...changes });
  return walker.release({ ...base, footY: 400, ...changes });
}
function fallUntilGrounded(walker, changes = {}) {
  let pose;
  for (let frame = 0; frame < 200; frame++) {
    pose = walker.step({ ...base, ...changes });
    if (pose.grounded) return pose;
  }
  assert.fail('character did not land');
}

test('starts on taskbar and lets the RPG own floor movement', () => {
  const walker = create();
  const start = walker.step(base);
  assert.equal(start.footY, 900);
  assert.equal(start.surfaceKind, 'taskbar');
  assert.equal(start.onFloor, true);
  const moved = walker.step({ ...base, x: 450 });
  assert.equal(moved.x, 450);
  assert.equal(moved.action, 'walk');
  assert.equal(moved.facing, 1);
});

test('drag is free in two dimensions and release snaps to a nearby visible top', () => {
  const walker = create();
  const dragged = walker.beginDrag({ ...base, x: 450, footY: 430 });
  assert.equal(dragged.dragging, true);
  assert.equal(dragged.surfaceId, null);
  const moving = walker.step({ ...base, x: 480, footY: 420 });
  assert.equal(moving.x, 480);
  assert.equal(moving.footY, 420);
  const landed = walker.release({ ...base, x: 480, footY: 420 });
  assert.equal(landed.surfaceId, 'window:1:0');
  assert.equal(landed.footY, 400);
  assert.equal(landed.dragging, false);
  assert.equal(landed.onFloor, false);
});

test('frame walking owns x and reverses safely at either edge', () => {
  const walker = create([ledge('a', 200, 400, 400)]);
  drop(walker, { x: 502 });
  const turn = walker.step({ ...base, x: 900, speed: 100 });
  assert.equal(turn.x, 496);
  assert.equal(turn.facing, -1);
  assert.equal(turn.action, 'walk');
  for (let i = 0; i < 80; i++) {
    const pose = walker.step({ ...base, speed: 100 });
    assert.ok(pose.x >= 296 && pose.x <= 504);
    assert.equal(pose.footY, 400);
  }
});

test('a moving window carries its passenger and a resized window clamps it', () => {
  const walker = create();
  drop(walker);
  snapshot(walker, [ledge('window:1:0', 250, 500, 600)]);
  const moved = walker.step({ ...base, command: 'rest' });
  assert.equal(moved.x, 550);
  assert.equal(moved.footY, 500);
  snapshot(walker, [ledge('window:1:0', 250, 500, 250)]);
  const resized = walker.step({ ...base, command: 'rest' });
  assert.equal(resized.x, 404);
  assert.equal(resized.grounded, true);
});

test('an occluder moving a visible boundary does not move a passenger on the same window', () => {
  const walker = create([segment('window:1:0', 100, 700)]);
  drop(walker, { x: 400 });
  snapshot(walker, [segment('window:1:0', 200, 600)]);
  const pose = walker.step({ ...base, command: 'rest' });
  assert.equal(pose.x, 400);
  assert.equal(pose.footY, 400);
  assert.equal(pose.surfaceId, 'window:1:0');
});

test('an occluded passenger falls instead of teleporting to a renumbered segment', () => {
  const walker = create([
    segment('window:1:0', 100, 350), segment('window:1:1', 600, 400),
  ]);
  drop(walker, { x: 300 });
  snapshot(walker, [segment('window:1:0', 600, 400)]);
  const pose = walker.step({ ...base, x: 300, command: 'rest' });
  assert.equal(pose.x, 300);
  assert.equal(pose.grounded, false);
  assert.equal(pose.action, 'fall');
  assert.ok(pose.footY > 400);
  assert.equal(fallUntilGrounded(walker, { x: 300, command: 'rest' }).onFloor, true);
});

test('a passenger keeps its parent window when a surviving visible segment is renumbered', () => {
  const walker = create([
    segment('window:1:0', 100, 350), segment('window:1:1', 600, 400),
  ]);
  drop(walker, { x: 800 });
  snapshot(walker, [segment('window:1:0', 600, 400)]);
  const pose = walker.step({ ...base, command: 'rest' });
  assert.equal(pose.x, 800);
  assert.equal(pose.surfaceId, 'window:1:0');
  assert.equal(pose.grounded, true);
});

test('actual window movement carries passengers even if an occluder fixes the visible boundary', () => {
  const walker = create([segment('window:1:0', 300, 600)]);
  drop(walker, { x: 500 });
  snapshot(walker, [segment('window:1:0', 300, 650, { anchorX: 150, y: 450 })]);
  const pose = walker.step({ ...base, command: 'rest' });
  assert.equal(pose.x, 550);
  assert.equal(pose.footY, 450);
  assert.equal(pose.grounded, true);
});

test('actual resize clamps to parent bounds, while covered parent edges cannot hold a passenger', () => {
  const walker = create([segment('window:1:0', 100, 900)]);
  drop(walker, { x: 850 });
  snapshot(walker, [segment('window:1:0', 100, 500, { windowWidth: 500 })]);
  const resized = walker.step({ ...base, command: 'rest' });
  assert.equal(resized.x, 504);
  assert.equal(resized.grounded, true);
  snapshot(walker, [segment('window:1:0', 100, 300, { windowWidth: 400 })]);
  const covered = walker.step({ ...base, command: 'rest' });
  assert.equal(covered.x, 404);
  assert.equal(covered.grounded, false);
});

test('occluding a top edge below full sprite width makes its passenger fall', () => {
  const walker = create([segment('window:1:0', 100, 600)]);
  drop(walker, { x: 400 });
  snapshot(walker, [segment('window:1:0', 350, 100)]);
  const pose = walker.step({ ...base, command: 'rest' });
  assert.equal(pose.x, 400);
  assert.equal(pose.grounded, false);
});

test('closing a window falls onto the first lower visible surface', () => {
  const walker = create([ledge(), ledge('lower', 100, 650, 600)]);
  drop(walker);
  snapshot(walker, [ledge('lower', 100, 650, 600)]);
  const falling = walker.step(base);
  assert.equal(falling.action, 'fall');
  assert.ok(falling.footY > 400 && falling.footY < 650);
  const landed = fallUntilGrounded(walker);
  assert.equal(landed.surfaceId, 'lower');
  assert.equal(landed.footY, 650);
});

test('drop far above a ledge uses swept gravity and does not fall through it', () => {
  const walker = create([ledge('lower', 100, 650, 600)]);
  assert.equal(drop(walker, { footY: 200 }).action, 'fall');
  const landed = fallUntilGrounded(walker, { dt: 500 });
  assert.equal(landed.footY, 650);
  assert.equal(landed.surfaceId, 'lower');
});

test('cannot attach to a hidden gap, narrow segment, or frame above sprite headroom', () => {
  const walker = create([
    ledge('left', 0, 400, 300), ledge('right', 500, 400, 400),
    ledge('narrow', 300, 600, 100), ledge('too-high', 100, 100, 600),
  ]);
  const released = drop(walker, { x: 400, footY: 390 });
  assert.equal(released.surfaceId, null);
  assert.equal(fallUntilGrounded(walker).surfaceId, 'desktop-floor');
  assert.equal(drop(walker, { x: 150, footY: 400 }).surfaceId, 'left');
});

test('scale changes reject a ledge that no longer fits and keep the viewport safe', () => {
  const walker = create([ledge('small', 200, 400, 200)]);
  assert.equal(drop(walker, { x: 300, size: 96 }).surfaceId, 'small');
  const bigger = walker.step({ ...base, x: 300, size: 288 });
  assert.equal(bigger.grounded, false);
  assert.equal(fallUntilGrounded(walker, { size: 288 }).surfaceId, 'desktop-floor');
  const tiny = walker.step({ ...base, x: -10, width: 100, height: 100, size: 288 });
  assert.equal(tiny.x, 50);
  assert.equal(tiny.footY, 100);
});

test('pause freezes travel and gravity while following moved window geometry', () => {
  const walker = create();
  drop(walker);
  assert.equal(walker.step({ ...base, paused: true, speed: 100 }).x, 400);
  snapshot(walker, [ledge('window:1:0', 200, 450)]);
  const moved = walker.step({ ...base, paused: true });
  assert.equal(moved.x, 500);
  assert.equal(moved.footY, 450);
  snapshot(walker, []);
  const detached = walker.step({ ...base, paused: true });
  assert.equal(detached.footY, 450);
  assert.equal(detached.grounded, false);
  for (let frame = 0; frame < 5; frame++) assert.equal(walker.step({ ...base, paused: true }).footY, 450);
  assert.ok(walker.step(base).footY > 450);
});

test('rest stays on its frame and fight returns immediately to ground combat', () => {
  const walker = create();
  drop(walker);
  const resting = walker.step({ ...base, command: 'rest', x: 900 });
  assert.equal(resting.x, 400);
  assert.equal(resting.action, 'idle');
  const fighting = walker.step({ ...base, command: 'fight', x: 600 });
  assert.equal(fighting.x, 600);
  assert.equal(fighting.footY, 900);
  assert.equal(fighting.onFloor, true);
  const drag = walker.step({ ...base, command: 'fight', dragging: true, footY: 400 });
  assert.equal(drag.dragging, true);
  assert.equal(walker.release({ ...base, command: 'fight', footY: 400 }).onFloor, true);
});

test('turning recognition off or losing native support safely discards window placement', () => {
  const walker = create();
  drop(walker);
  assert.equal(walker.step({ ...base, enabled: false }).onFloor, true);
  assert.equal(walker.step(base).onFloor, true);
  drop(walker);
  snapshot(walker, [ledge()], { status: 'unavailable' });
  const fallback = walker.step(base);
  assert.equal(fallback.onFloor, true);
  assert.equal(fallback.surfaceKind, 'floor');
  snapshot(walker, [ledge()], { supported: false });
  assert.equal(drop(walker).onFloor, true);
});

test('drag positions and frame delta time are bounded', () => {
  const walker = create();
  const outside = walker.beginDrag({ ...base, x: -1000, footY: 20 });
  assert.equal(outside.x, 96);
  assert.equal(outside.footY, 192);
  const otherSide = walker.step({ ...base, dragging: true, x: 99999, footY: 99999 });
  assert.equal(otherSide.x, 1104);
  assert.equal(otherSide.footY, 900);
  drop(walker, { footY: 200 });
  const capped = walker.step({ ...base, dt: 100 });
  assert.equal(capped.footY, 206);
  const invalid = walker.step({ ...base, dt: NaN });
  assert.equal(invalid.footY, 206);
});

test('character placements are independent, forget is effective, snapshots are copied', () => {
  const walker = create();
  const surface = ledge();
  snapshot(walker, [surface]);
  surface.y = 800;
  assert.equal(drop(walker).footY, 400);
  assert.equal(walker.step({ ...base, characterId: 'other' }).onFloor, true);
  assert.equal(walker.step({ ...base, command: 'rest' }).onFloor, false);
  assert.equal(walker.forget('cafemong'), true);
  assert.equal(walker.step(base).onFloor, true);
});

test('malformed surfaces cannot create invalid positions or override the floor', () => {
  const walker = create();
  snapshot(walker, [null, {}, ledge('bad', NaN), ledge('bad2', 0, Infinity), ledge('bad3', 0, 400, -1),
    { ...ledge('desktop-floor'), width: 5000 }, ledge('valid'), ledge('valid', 800)]);
  assert.equal(drop(walker).surfaceId, 'valid');
  walker.updateSnapshot(null);
  const fallback = walker.step({ ...base, x: Infinity, dt: Infinity });
  assert.equal(fallback.onFloor, true);
  assert.equal(Number.isFinite(fallback.x), true);
  assert.equal(fallback.footY, 900);
});
