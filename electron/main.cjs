'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, globalShortcut, dialog, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { buildSurfaceSnapshot, createWindowSurfaceTracker } = require('./window-surfaces.cjs');
const { buildDisplayLayout, desktopBounds, pointInDisplays } = require('./display-layout.cjs');
const { readRuntimeConfig, createSessionVault, createServiceBridge } = require('./service-bridge.cjs');

const PAGE = path.resolve(__dirname, '..', 'index.html');
const PAGE_URL = pathToFileURL(PAGE).href;
const runtimeConfig = readRuntimeConfig(path.resolve(__dirname, '..'));
const SHORTCUT = 'CommandOrControl+Shift+M';
const appLabel = '몽글몽';
let window;
let tray;
let polling;
let regions = [];
let mouseCaptured = false;
let captureUntil = 0;
let sceneMode = false;
let ignoresMouse = null;
let startupFailed = false;
let surfaceTracker;
let serviceBridge;
let displayLayout;

function showStartupError(error) {
  if (startupFailed) return;
  startupFailed = true;
  dialog.showErrorBox('몽글몽 실행 오류', `몽글몽을 시작하지 못했습니다.\n\n${error instanceof Error ? error.message : String(error)}\n\n앱을 다시 실행해 주세요. 문제가 계속되면 이 오류 내용을 알려 주세요.`);
  app.exit(1);
}

// Development versions used package.name for their profile directory. Pin it
// before the instance lock and session initialization so installed branding
// does not move saved progress into a new profile.
try {
  const userDataPath = path.join(app.getPath('appData'), 'mori-desktop-rpg');
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
} catch (error) {
  showStartupError(error);
}

function isOurRenderer(event) {
  return window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === PAGE_URL;
}

function setIgnoringMouse(ignore) {
  if (!window || window.isDestroyed() || ignoresMouse === ignore) return;
  ignoresMouse = ignore;
  // Cursor polling also handles platforms without Electron's mouse forwarding.
  window.setIgnoreMouseEvents(ignore, { forward: true });
}

function updateHitTest() {
  if (!window || window.isDestroyed()) return;
  if (mouseCaptured && Date.now() > captureUntil) mouseCaptured = false;
  const cursor = screen.getCursorScreenPoint();
  const bounds = window.getBounds();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (!pointInDisplays(displayLayout, { x, y })) return setIgnoringMouse(true);
  if (mouseCaptured) return setIgnoringMouse(false);
  // Sprite labels can extend below their feet. Those rectangles must not steal
  // taskbar clicks; an active drag can still finish outside the work area.
  if (!pointInDisplays(displayLayout, { x, y }, true)) return setIgnoringMouse(true);
  if (sceneMode) return setIgnoringMouse(false);
  const hit = regions.some(rect => x >= rect.x && y >= rect.y
    && x <= rect.x + rect.width && y <= rect.y + rect.height);
  setIgnoringMouse(!hit);
}

function fitWorkArea() {
  if (!window || window.isDestroyed()) return;
  displayLayout = buildDisplayLayout(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
  window.setBounds(desktopBounds(displayLayout));
  // Coordinates from the previous topology are no longer valid for hit tests.
  regions = [];
  mouseCaptured = false;
  sendDisplays();
  surfaceTracker?.setGeometry(getSurfaceGeometry());
  updateHitTest();
}

function getSurfaceGeometry() {
  return {
    bounds: window && !window.isDestroyed() ? window.getBounds() : desktopBounds(displayLayout),
    displays: displayLayout.displays.map(display => ({
      id: display.id, scaleFactor: display.scaleFactor,
      bounds: { x: display.x + displayLayout.origin.x, y: display.y + displayLayout.origin.y,
        width: display.width, height: display.height },
      workArea: { ...display.workArea, x: display.workArea.x + displayLayout.origin.x,
        y: display.workArea.y + displayLayout.origin.y },
    })),
    // The helper enumerates physical pixels; the overlay and pointer events use
    // DIP. Electron also handles negative monitor origins and display scaling.
    screenToDipRect: rect => process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect,
    dipToScreenRect: rect => process.platform === 'win32' ? screen.dipToScreenRect(null, rect) : rect,
  };
}

function sendDisplays() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('desktop:displays', displayLayout);
  }
}

function sendSurfaces(snapshot) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('desktop:surfaces', snapshot);
  }
}

function toggleMenu() {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
  window.webContents.send('desktop:toggle-menu');
}

function makeTrayIcon() {
  // A local, dependency-free 32px pixel cat. NativeImage expects BGRA pixels.
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  function rect(x, y, width, height, color) {
    for (let j = y; j < y + height; j++) {
      for (let i = x; i < x + width; i++) {
        const offset = (j * size + i) * 4;
        pixels[offset] = color[2];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[0];
        pixels[offset + 3] = 255;
      }
    }
  }
  const purple = [107, 82, 174];
  const cream = [255, 244, 224];
  rect(5, 9, 22, 19, purple);
  rect(5, 4, 7, 8, purple);
  rect(20, 4, 7, 8, purple);
  rect(9, 11, 14, 12, cream);
  rect(10, 15, 3, 4, purple);
  rect(19, 15, 3, 4, purple);
  rect(15, 20, 2, 2, purple);
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function createWindow() {
  displayLayout = buildDisplayLayout(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
  window = new BrowserWindow({
    ...desktopBounds(displayLayout),
    title: '몽글몽 · MongleMong',
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  window.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once('ready-to-show', () => {
    window.showInactive();
    sendDisplays();
    updateHitTest();
    surfaceTracker.start();
  });
  window.on('blur', () => {
    mouseCaptured = false;
    updateHitTest();
  });
  window.webContents.on('render-process-gone', () => {
    mouseCaptured = false;
    regions = [];
    updateHitTest();
  });
  window.on('closed', () => {
    surfaceTracker?.stop();
    window = null;
    clearInterval(polling);
  });
  surfaceTracker = createWindowSurfaceTracker({
    geometry: getSurfaceGeometry(),
    onSnapshot: sendSurfaces,
  });
  window.loadFile(PAGE).catch(showStartupError);
  polling = setInterval(updateHitTest, 40);
}

ipcMain.on('desktop:regions', (event, supplied) => {
  if (!isOurRenderer(event) || !Array.isArray(supplied)) return;
  const bounds = window.getBounds();
  regions = supplied.slice(0, 128).filter(rect => rect &&
    ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0 &&
    rect.width <= bounds.width * 2 && rect.height <= bounds.height * 2)
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
  updateHitTest();
});

ipcMain.on('desktop:capture', (event, captured) => {
  if (!isOurRenderer(event) || typeof captured !== 'boolean') return;
  mouseCaptured = captured;
  // A lost pointerup cannot block the desktop indefinitely. The renderer may
  // renew capture while dragging; normal gestures finish well before 30s.
  captureUntil = Date.now() + 30_000;
  updateHitTest();
});

ipcMain.on('desktop:scene-mode', (event, enabled) => {
  if (!isOurRenderer(event) || typeof enabled !== 'boolean') return;
  sceneMode = enabled;
  updateHitTest();
});

ipcMain.on('desktop:request-surfaces', event => {
  if (!isOurRenderer(event)) return;
  surfaceTracker?.setGeometry(getSurfaceGeometry());
  sendSurfaces(surfaceTracker?.getSnapshot()
    ?? buildSurfaceSnapshot(null, getSurfaceGeometry(), process.platform === 'win32'));
});

ipcMain.on('desktop:request-displays', event => {
  if (isOurRenderer(event)) sendDisplays();
});

ipcMain.on('desktop:quit', event => {
  if (isOurRenderer(event)) app.quit();
});

for (const method of ['serviceRequest', 'setAccountSession', 'getAccountSession', 'openAccountLogin']) {
  ipcMain.handle(`desktop:${method}`, (event, argument) => {
    if (!isOurRenderer(event) || !serviceBridge) throw new Error('허용되지 않은 서비스 요청이에요.');
    return serviceBridge[method](argument);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', toggleMenu);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('studio.mori.desktop');
    const originHash = createHash('sha256').update(runtimeConfig.apiBaseUrl).digest('hex').slice(0, 24);
    const vault = createSessionVault({ file: path.join(app.getPath('userData'), `account-session-${originHash}.bin`), safeStorage });
    serviceBridge = createServiceBridge({ config: runtimeConfig, vault, openExternal: url => shell.openExternal(url) });
    createWindow();
    tray = new Tray(makeTrayIcon());
    tray.setToolTip(`${appLabel} · Ctrl/⌘ + Shift + M`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '메뉴 열기 / 접기', click: toggleMenu },
      { label: '전체 모니터에 맞추기', click: fitWorkArea },
      { type: 'separator' },
      { label: `${appLabel} 종료`, click: () => app.quit() },
    ]));
    tray.on('double-click', toggleMenu);
    if (!globalShortcut.register(SHORTCUT, toggleMenu)) {
      console.warn('Menu shortcut is unavailable; use the tray menu instead.');
    }
    screen.on('display-metrics-changed', fitWorkArea);
    screen.on('display-added', fitWorkArea);
    screen.on('display-removed', fitWorkArea);
  }).catch(showStartupError);
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  clearInterval(polling);
  surfaceTracker?.stop();
  globalShortcut.unregisterAll();
  tray?.destroy();
});
