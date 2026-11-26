import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { buildSurfaceSnapshot, createWindowSurfaceTracker } from '../electron/window-surfaces.cjs';

const geometry = {
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
  displayBounds: { x: 0, y: 0, width: 1000, height: 740 },
};
const rect = (id, x, y, width, height, zOrder = 0) => ({ id, x, y, width, height, zOrder });
const snapshot = (windows, extra = {}) => buildSurfaceSnapshot({ windows, ...extra }, geometry, true, 'ready');

test('unavailable detection retains a work-area floor aligned with the taskbar', () => {
  assert.deepEqual(buildSurfaceSnapshot(null, geometry, true), {
    supported: true, status: 'unavailable', width: 1000, height: 700,
    surfaces: [{ id: 'desktop-floor', kind: 'taskbar', x: 0, y: 700, width: 1000 }],
  });
  assert.equal(buildSurfaceSnapshot(null, { bounds: geometry.bounds }, false).surfaces[0].kind, 'floor');
});

test('physical geometry is converted to DIP before subtracting the overlay origin', () => {
  const value = buildSurfaceSnapshot({ windows: [rect('12', -2000, 300, 800, 500)] }, {
    bounds: { x: -1200, y: 50, width: 1000, height: 700 },
    screenToDipRect: source => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value / 2])),
  }, true, 'ready');
  assert.deepEqual(value.surfaces[1], { id: 'window:12:0', kind: 'window', x: 200, y: 100, width: 400,
    windowId: 'window:12', anchorX: 200, windowWidth: 400 });
});

test('higher windows split lower frame edges; hidden parts are not walkable', () => {
  const value = snapshot([rect('back', 100, 200, 500, 300, 7), rect('front', 250, 100, 100, 250, 2)]);
  assert.deepEqual(value.surfaces.filter(item => item.id.startsWith('window:back:')), [
    { id: 'window:back:0', kind: 'window', x: 100, y: 200, width: 150,
      windowId: 'window:back', anchorX: 100, windowWidth: 500 },
    { id: 'window:back:1', kind: 'window', x: 350, y: 200, width: 250,
      windowId: 'window:back', anchorX: 100, windowWidth: 500 },
  ]);
  const covered = snapshot([rect('back', 200, 200, 100, 300, 1), rect('front', 100, 100, 500, 500, 0)]);
  assert.equal(covered.surfaces.some(item => item.id.startsWith('window:back:')), false);
});

test('off-screen windows occlude correctly without inventing edges at the viewport top', () => {
  const value = snapshot([rect('front', 100, -50, 300, 400, 0), rect('back', -50, 200, 1200, 400, 1)]);
  assert.deepEqual(value.surfaces.slice(1), [
    { id: 'window:back:0', kind: 'window', x: 0, y: 200, width: 100,
      windowId: 'window:back', anchorX: -50, windowWidth: 1200 },
    { id: 'window:back:1', kind: 'window', x: 400, y: 200, width: 600,
      windowId: 'window:back', anchorX: -50, windowWidth: 1200 },
  ]);
});

test('frame IDs survive moves and resizes; disappeared frames leave no platform', () => {
  const first = snapshot([rect('23', 100, 200, 500, 300)]).surfaces[1];
  const moved = snapshot([rect('23', 150, 220, 400, 280)]).surfaces[1];
  assert.equal(first.id, moved.id);
  assert.equal(moved.x - first.x, 50);
  assert.equal(moved.y - first.y, 20);
  assert.equal(moved.anchorX - first.anchorX, 50);
  assert.equal(moved.windowWidth, 400);
  assert.equal(snapshot([]).surfaces.length, 1);
});

test('moving occluders change segments without changing their parent window anchor', () => {
  const initial = snapshot([rect('back', 100, 300, 800, 350, 1), rect('front', 400, 200, 100, 300, 0)])
    .surfaces.filter(surface => surface.windowId === 'window:back');
  const occluded = snapshot([rect('back', 100, 300, 800, 350, 1), rect('front', 50, 200, 500, 300, 0)])
    .surfaces.filter(surface => surface.windowId === 'window:back');
  assert.equal(initial.length, 2);
  assert.equal(occluded.length, 1);
  assert.equal(occluded[0].id, initial[0].id, 'segment indices may be reused after occlusion');
  assert.equal(occluded[0].x, 550);
  assert.equal(occluded[0].anchorX, initial[0].anchorX, 'parent movement remains zero despite a different visible edge');
  assert.equal(occluded[0].windowWidth, initial[0].windowWidth);
  const moved = snapshot([rect('back', 150, 300, 800, 350, 1), rect('front', 50, 200, 500, 300, 0)])
    .surfaces.find(surface => surface.windowId === 'window:back');
  assert.equal(moved.x, occluded[0].x, 'occlusion may leave the segment origin fixed while the window moves');
  assert.equal(moved.anchorX - occluded[0].anchorX, 50, 'parent metadata still reports actual movement');
});

test('invalid, duplicate and fully off-screen geometry is discarded', () => {
  const value = snapshot([
    rect('ok', 100, 200, 300, 300), rect('ok', 200, 300, 400, 400),
    rect('bad-number', NaN, 200, 10, 10), rect('bad-size', 100, 100, -1, 30),
    rect('bad.id', 100, 100, 300, 300), rect('offscreen', 1200, 100, 300, 300),
    rect('below', 100, 800, 300, 300),
  ]);
  assert.deepEqual(value.surfaces.map(item => item.id), ['desktop-floor', 'window:ok:0']);
  const conversionFailure = buildSurfaceSnapshot({ windows: [rect('ok', 1, 2, 3, 4)] }, {
    ...geometry, screenToDipRect() { throw new Error('display disappeared'); },
  }, true, 'ready');
  assert.equal(conversionFailure.surfaces.length, 1);
});

test('auto-hidden taskbar geometry identifies the floor without lowering it', () => {
  const value = buildSurfaceSnapshot({ windows: [], taskbars: [rect('bar', 0, 699, 1000, 40)] }, {
    bounds: geometry.bounds, displayBounds: geometry.bounds,
  }, true, 'ready');
  assert.deepEqual(value.surfaces[0], { id: 'desktop-floor', kind: 'taskbar', x: 0, y: 700, width: 1000 });
});

const multiGeometry = {
  bounds: { x: -800, y: -500, width: 2000, height: 1300 },
  displays: [
    { id: 'primary', bounds: { x: 0, y: 0, width: 1200, height: 800 }, workArea: { x: 0, y: 0, width: 1200, height: 760 } },
    { id: 'left', bounds: { x: -800, y: 0, width: 800, height: 600 }, workArea: { x: -780, y: 0, width: 780, height: 600 } },
    { id: 'upper', bounds: { x: 0, y: -500, width: 1200, height: 500 }, workArea: { x: 0, y: -500, width: 1200, height: 460 } },
  ],
};

test('each monitor has its own work-area floor, including negative origins and side taskbars', () => {
  const value = buildSurfaceSnapshot(null, multiGeometry, true);
  assert.deepEqual(value.surfaces, [
    { id: 'desktop-floor:primary', displayId: 'primary', kind: 'taskbar', x: 800, y: 1260, width: 1200 },
    { id: 'desktop-floor:left', displayId: 'left', kind: 'floor', x: 20, y: 1100, width: 780 },
    { id: 'desktop-floor:upper', displayId: 'upper', kind: 'taskbar', x: 800, y: 460, width: 1200 },
  ]);
});

test('spanning frame edges are clipped per monitor without crossing gaps or inventing top edges', () => {
  const value = buildSurfaceSnapshot({ windows: [rect('wide', -1000, -300, 2400, 1000)] }, multiGeometry, true, 'ready');
  assert.deepEqual(value.surfaces.filter(surface => surface.kind === 'window'), [
    { id: 'window:wide:upper:0', displayId: 'upper', kind: 'window', x: 800, y: 200, width: 1200,
      windowId: 'window:wide', anchorX: -200, windowWidth: 2400 },
  ], 'window top in upper monitor cannot create another top on the lower monitors');
  const split = buildSurfaceSnapshot({ windows: [rect('wide', -1000, 200, 2400, 500), rect('front', -100, 100, 200, 300, -1)] }, multiGeometry, true, 'ready');
  assert.deepEqual(split.surfaces.filter(surface => surface.windowId === 'window:wide').map(({ displayId, x, y, width }) => ({ displayId, x, y, width })), [
    { displayId: 'primary', x: 900, y: 700, width: 1100 },
    { displayId: 'left', x: 20, y: 700, width: 680 },
  ]);
});

test('mixed-DPI windows convert each physical display portion before restoring window anchors', () => {
  const calls = [];
  const value = buildSurfaceSnapshot({ windows: [rect('spanning', -400, 200, 800, 400)] }, {
    bounds: { x: -800, y: 0, width: 1800, height: 800 },
    displays: [
      { id: 'left', bounds: { x: -800, y: 0, width: 800, height: 600 }, workArea: { x: -800, y: 0, width: 800, height: 580 }, scaleFactor: 2 },
      { id: 'right', bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 }, scaleFactor: 1 },
    ],
    dipToScreenRect: source => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value * (source.x < 0 ? 2 : 1)])),
    screenToDipRect(source) {
      calls.push(source);
      const scale = source.x < 0 ? 2 : 1;
      return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value / scale]));
    },
  }, true, 'ready');
  assert.deepEqual(value.surfaces.filter(surface => surface.kind === 'window'), [
    { id: 'window:spanning:left:0', displayId: 'left', kind: 'window', x: 600, y: 100, width: 200,
      windowId: 'window:spanning', anchorX: 600, windowWidth: 400 },
    { id: 'window:spanning:right:0', displayId: 'right', kind: 'window', x: 800, y: 200, width: 400,
      windowId: 'window:spanning', anchorX: 400, windowWidth: 800 },
  ]);
  assert.deepEqual(calls, [{ x: -400, y: 200, width: 400, height: 400 }, { x: 0, y: 200, width: 400, height: 400 }]);
});

function harness(overrides = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const children = [];
  const published = [];
  const launches = [];
  const options = {
    platform: 'win32', processId: 4321, geometry,
    readScript: () => '# local trusted collector',
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    spawn(binary, args, spawnOptions) {
      launches.push({ binary, args, options: spawnOptions });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = { resume() {} };
      child.kills = 0;
      child.kill = () => { child.kills++; child.emit('exit', 0); };
      children.push(child);
      return child;
    },
    onSnapshot(value) { published.push(value); },
    ...overrides,
  };
  const tracker = createWindowSurfaceTracker(options);
  return {
    tracker, children, published, launches, timers,
    send(value, index = children.length - 1) { children[index].stdout.emit('data', `${JSON.stringify(value)}\n`); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].callback();
      }
      now = end;
    },
  };
}

test('non-Windows sessions expose the fallback without starting a helper', () => {
  const run = harness({ platform: 'linux' });
  run.tracker.start();
  assert.equal(run.launches.length, 0);
  assert.equal(run.published[0].supported, false);
  assert.equal(run.published[0].status, 'unavailable');
  run.tracker.stop();
});

test('collector runs hidden with an encoded, packaged script and no shell or policy changes', () => {
  const script = readFileSync(new URL('../electron/native/window-surfaces.ps1', import.meta.url), 'utf8');
  const run = harness({ readScript: () => script });
  run.tracker.start();
  const launch = run.launches[0];
  assert.match(launch.binary, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.shell, undefined);
  assert.equal(launch.args.includes('-ExecutionPolicy'), false);
  const encoded = launch.args.at(-1);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), `$ExcludedProcessId = 4321\n${script}`);
  assert.ok(launch.binary.length + launch.args.join(' ').length < 32_000, 'fits the Windows CreateProcess command length limit');
  run.tracker.stop();
  assert.equal(run.children[0].kills, 1);
  assert.equal(run.timers.size, 0);
});

test('chunked snapshots publish changed geometry only and update the heartbeat', () => {
  const run = harness();
  run.tracker.start();
  const line = JSON.stringify({ windows: [rect('23', 100, 200, 400, 300)] });
  run.children[0].stdout.emit('data', line.slice(0, 20));
  assert.equal(run.published.length, 1);
  run.children[0].stdout.emit('data', `${line.slice(20)}\r\n`);
  assert.equal(run.published.at(-1).status, 'ready');
  assert.equal(run.published.at(-1).surfaces[1].id, 'window:23:0');
  run.advance(2000);
  run.children[0].stdout.emit('data', `${line}\n`);
  assert.equal(run.published.length, 2);
  run.advance(2000);
  assert.equal(run.children[0].kills, 0);
  run.tracker.setGeometry({ ...geometry, bounds: { ...geometry.bounds, x: 50 } });
  assert.equal(run.published.at(-1).surfaces[1].x, 50);
  run.tracker.stop();
});

test('heartbeat loss clears stale frames, restarts, and ignores events from the dead child', () => {
  const run = harness();
  run.tracker.start();
  run.send({ windows: [rect('23', 100, 200, 400, 300)] });
  run.advance(3000);
  assert.equal(run.children[0].kills, 1);
  assert.equal(run.published.at(-1).status, 'unavailable');
  assert.equal(run.published.at(-1).surfaces.length, 1);
  run.advance(1000);
  assert.equal(run.children.length, 2);
  run.send({ windows: [rect('stale', 100, 200, 400, 300)] }, 0);
  assert.equal(run.tracker.getSnapshot().status, 'unavailable');
  run.send({ windows: [rect('24', 100, 200, 400, 300)] });
  assert.equal(run.tracker.getSnapshot().surfaces[1].id, 'window:24:0');
  run.tracker.stop();
});

test('repeated helper failures back off and stopping cancels pending restarts', () => {
  const run = harness();
  run.tracker.start();
  run.children[0].emit('error', new Error('cannot start'));
  run.advance(999);
  assert.equal(run.children.length, 1);
  run.advance(1);
  assert.equal(run.children.length, 2);
  run.children[1].emit('exit', 1);
  run.advance(1999);
  assert.equal(run.children.length, 2);
  run.advance(1);
  assert.equal(run.children.length, 3);
  run.children[2].emit('exit', 1);
  run.tracker.stop();
  run.advance(100_000);
  assert.equal(run.children.length, 3);
  assert.equal(run.timers.size, 0);
});

test('malformed or oversized messages invalidate the helper without keeping old geometry', () => {
  for (const bad of ['{broken}\n', `${JSON.stringify({ windows: Array(129).fill({}) })}\n`, 'x'.repeat(128 * 1024 + 1)]) {
    const run = harness();
    run.tracker.start();
    run.send({ windows: [rect('23', 100, 200, 400, 300)] });
    run.children[0].stdout.emit('data', bad);
    assert.equal(run.children[0].kills, 1);
    assert.equal(run.tracker.getSnapshot().status, 'unavailable');
    assert.equal(run.tracker.getSnapshot().surfaces.length, 1);
    run.tracker.stop();
  }
});

test('missing script and startup timeout both retry without crashing the game', () => {
  const missing = harness({ readScript() { throw new Error('missing script'); } });
  assert.doesNotThrow(() => missing.tracker.start());
  assert.equal(missing.tracker.getSnapshot().status, 'unavailable');
  assert.equal(missing.timers.size, 1);
  missing.tracker.stop();
  const slow = harness();
  slow.tracker.start();
  slow.advance(15_000);
  assert.equal(slow.children[0].kills, 1);
  slow.tracker.stop();
});
