import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { buildDisplayLayout, desktopBounds, pointInDisplays, MAX_DISPLAYS, MAX_DESKTOP_AXIS } from '../electron/display-layout.cjs';

const monitor = (id, x, y, width, height, extra = {}) => ({ id, bounds: { x, y, width, height },
  workArea: { x, y, width, height: height - 40 }, scaleFactor: 1, ...extra });

test('left and upper monitors share one normalized DIP space, independent of display scale', () => {
  const value = buildDisplayLayout([
    monitor(2, -900, 0, 900, 900, { scaleFactor: 1.5 }),
    monitor(1, 0, 0, 1280, 900),
    monitor(3, 0, -700, 1280, 700, { scaleFactor: 2 }),
  ], 1);
  assert.deepEqual(desktopBounds(value), { x: -900, y: -700, width: 2180, height: 1600 });
  assert.equal(value.primaryId, '1');
  assert.deepEqual(value.displays[0], { id: '1', x: 900, y: 700, width: 1280, height: 900,
    workArea: { x: 900, y: 700, width: 1280, height: 860 }, scaleFactor: 1, primary: true });
  assert.equal(value.displays[1].scaleFactor, 1.5);
  assert.equal(value.displays[2].y, 0);
  assert.equal(pointInDisplays(value, { x: 500, y: 300 }), false, 'missing upper-left screen is a gap');
  assert.equal(pointInDisplays(value, { x: 950, y: 100 }), true);
  assert.equal(pointInDisplays(value, { x: 950, y: 1590 }), true);
  assert.equal(pointInDisplays(value, { x: 950, y: 1590 }, true), false, 'taskbar is excluded from placement hit tests');
  assert.equal(pointInDisplays(value, { x: 2180, y: 900 }), false, 'right bounds are exclusive');
});

test('removing a monitor recalculates origin and preserves remaining monitor identities', () => {
  const primary = monitor(1, 0, 0, 1920, 1080);
  const left = monitor(2, -1280, -200, 1280, 1024);
  const before = buildDisplayLayout([left, primary], 1);
  const after = buildDisplayLayout([primary], 1);
  assert.deepEqual(before.origin, { x: -1280, y: -200 });
  assert.deepEqual(after.origin, { x: 0, y: 0 });
  assert.equal(after.displays[0].id, before.displays[0].id);
  assert.equal(after.displays[0].workArea.y + after.displays[0].workArea.height, 1040);
});

test('work areas are clipped to their display and invalid areas fall back to the monitor', () => {
  const value = buildDisplayLayout([
    monitor(1, 0, 0, 1000, 800, { workArea: { x: 50, y: -10, width: 2000, height: 810 } }),
    monitor(2, 1000, 0, 1000, 800, { workArea: { x: 5000, y: 0, width: 100, height: 100 }, scaleFactor: NaN }),
  ], 1);
  assert.deepEqual(value.displays[0].workArea, { x: 50, y: 0, width: 950, height: 800 });
  assert.deepEqual(value.displays[1].workArea, { x: 1000, y: 0, width: 1000, height: 800 });
  assert.equal(value.displays[1].scaleFactor, 1);
});

test('malformed, duplicate and pathological desktop layouts cannot create unbounded windows', () => {
  const primary = monitor(99, 0, 0, 1000, 800);
  const value = buildDisplayLayout([
    monitor(1, NaN, 0, 100, 100), monitor(2, -MAX_DESKTOP_AXIS, 0, 1000, 800),
    ...Array.from({ length: 50 }, (_, index) => monitor(index + 100, index * 1000, 0, 1000, 800)),
    primary, { ...primary, bounds: { x: 999999, y: 0, width: 1000, height: 800 } },
  ], 99);
  assert.equal(value.displays.length, MAX_DISPLAYS);
  assert.equal(value.displays[0].id, '99', 'primary has priority even in a truncated topology');
  assert.equal(value.displays.filter(display => display.id === '99').length, 1);
  assert.ok(value.width <= MAX_DESKTOP_AXIS && value.height <= MAX_DESKTOP_AXIS);
  assert.equal(value.displays.some(display => display.id === '2'), false);
  const fallback = buildDisplayLayout([], 1);
  assert.deepEqual(desktopBounds(fallback), { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(fallback.displays.length, 1);
});

test('one native window publishes topology, keeps drag capture across monitors and clears capture after removal', async () => {
  const require = createRequire(import.meta.url);
  const directory = fileURLToPath(new URL('../electron/', import.meta.url));
  let displays = [monitor(1, 0, 0, 1280, 900), monitor(2, -900, 0, 900, 900), monitor(3, 0, -700, 1280, 700)];
  let cursor = { x: 100, y: 100 };
  let tick;
  const windows = [];
  const trackerGeometries = [];
  const app = Object.assign(new EventEmitter(), {
    getPath: () => '/tmp/monglemong-native-test', getVersion: () => '0.11.0', setPath() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, quit() {},
    exit() { throw new Error('unexpected startup error'); },
  });
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => displays[0], getAllDisplays: () => displays,
    getCursorScreenPoint: () => cursor, screenToDipRect: (_window, value) => value, dipToScreenRect: (_window, value) => value,
  });
  const handlers = new Map();
  const updateCalls = [];
  const ipcMain = Object.assign(new EventEmitter(), { handle(name, callback) { handlers.set(name, callback); } });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      windows.push(this);
      this.options = options;
      this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]]));
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: pathToFileURL(fileURLToPath(new URL('../index.html', import.meta.url))).href },
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        setWindowOpenHandler() {}, isDestroyed: () => false, send: (channel, value) => this.sent.push({ channel, value }),
      });
    }
    isDestroyed() { return false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(ignored) { this.ignored = ignored; }
    showInactive() {}
    loadFile() { return Promise.resolve(); }
  }
  const electron = { app, screen, ipcMain, BrowserWindow, safeStorage: {}, shell: {},
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
    nativeImage: { createFromBitmap() {} }, globalShortcut: { register: () => true },
    dialog: { showErrorBox() { throw new Error('unexpected startup error'); } },
  };
  const collector = { buildSurfaceSnapshot: require('../electron/window-surfaces.cjs').buildSurfaceSnapshot,
    createWindowSurfaceTracker(options) {
      trackerGeometries.push(options.geometry);
      return { start() {}, setGeometry(value) { trackerGeometries.push(value); }, getSnapshot: () => ({ surfaces: [] }) };
    },
  };
  vm.runInNewContext(readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'), {
    __dirname: directory, Buffer, console, process: { platform: 'win32' },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {},
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return { mkdirSync() {} };
      if (name === './window-surfaces.cjs') return collector;
      if (name === './display-layout.cjs') return require('../electron/display-layout.cjs');
      if (name === './update-service.cjs') return { createUpdateService: options => ({
        checkUpdates: () => { updateCalls.push(['check', options.currentVersion]); return { available: false }; },
        openUpdateDownload: (...args) => { updateCalls.push(['open', ...args]); return true; },
      }) };
      if (name === './service-bridge.cjs') return {
        readRuntimeConfig: () => ({ apiBaseUrl: '' }), createSessionVault() {}, createServiceBridge: () => ({}),
      };
      return require(name);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(windows.length, 1, 'one renderer owns the entire simulation');
  const window = windows[0];
  assert.deepEqual(window.bounds, { x: -900, y: -700, width: 2180, height: 1600 });
  window.emit('ready-to-show');
  assert.equal(window.sent.at(-1).channel, 'desktop:displays');
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.throws(() => handlers.get('desktop:checkUpdates')({ sender: {} }), /허용되지/);
  assert.throws(() => handlers.get('desktop:openUpdateDownload')({ sender: {} }), /허용되지/);
  handlers.get('desktop:checkUpdates')(sender);
  handlers.get('desktop:openUpdateDownload')(sender, 'https://untrusted.example/installer.exe');
  assert.deepEqual(updateCalls, [['check', '0.11.0'], ['open']], 'native update IPC never accepts a renderer download URL');
  ipcMain.emit('desktop:request-displays', sender);
  assert.equal(window.sent.at(-1).value.displays.length, 3);
  const messages = window.sent.length;
  ipcMain.emit('desktop:request-displays', { sender: {} });
  assert.equal(window.sent.length, messages, 'foreign frames cannot request native geometry');

  ipcMain.emit('desktop:capture', sender, true);
  cursor = { x: -600, y: 300 };
  tick();
  assert.equal(window.ignored, false, 'drag remains captured on the left monitor');
  cursor = { x: -600, y: -300 };
  tick();
  assert.equal(window.ignored, true, 'empty upper-left gap cannot capture input');
  cursor = { x: 600, y: -300 };
  tick();
  assert.equal(window.ignored, false, 'drag remains captured on the upper monitor');

  displays = [displays[0]];
  screen.emit('display-removed');
  assert.deepEqual(window.bounds, { x: 0, y: 0, width: 1280, height: 900 });
  assert.equal(window.sent.at(-1).value.displays.length, 1);
  assert.equal(trackerGeometries.at(-1).displays.length, 1);
  cursor = { x: 100, y: 100 };
  tick();
  assert.equal(window.ignored, true, 'topology reset releases stale drag capture');
  ipcMain.emit('desktop:regions', sender, [{ x: 90, y: 90, width: 20, height: 20 }]);
  assert.equal(window.ignored, false);
  cursor = { x: 100, y: 890 };
  ipcMain.emit('desktop:regions', sender, [{ x: 90, y: 850, width: 20, height: 50 }]);
  assert.equal(window.ignored, true, 'sprite labels extending below the floor cannot block taskbar clicks');
  ipcMain.emit('desktop:scene-mode', sender, true);
  tick();
  assert.equal(window.ignored, true, 'placement mode leaves the taskbar interactive');
});

test('preload display subscriptions expose data only and can be removed', () => {
  const ipcRenderer = Object.assign(new EventEmitter(), { sent: [], send(channel) { this.sent.push(channel); } });
  let desktop;
  vm.runInNewContext(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(_key, value) { desktop = value; } } }),
  });
  const received = [];
  const stop = desktop.onDisplays(snapshot => received.push(snapshot));
  desktop.requestDisplays();
  assert.deepEqual(ipcRenderer.sent, ['desktop:request-displays']);
  const snapshot = buildDisplayLayout([monitor(1, 0, 0, 1000, 800)], 1);
  ipcRenderer.emit('desktop:displays', { secret: 'event is not exposed' }, snapshot);
  assert.deepEqual(received, [snapshot]);
  stop();
  ipcRenderer.emit('desktop:displays', {}, snapshot);
  assert.equal(received.length, 1);
});
