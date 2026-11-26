'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_WINDOWS = 128;
const MAX_LINE_BYTES = 128 * 1024;
const STARTUP_TIMEOUT = 15_000;
const HEARTBEAT_TIMEOUT = 3_000;

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && Math.abs(rect.x) < 10_000_000 && Math.abs(rect.y) < 10_000_000
    && rect.width > 0 && rect.height > 0 && rect.width < 1_000_000 && rect.height < 1_000_000;
}

function subtractInterval(segments, left, right) {
  return segments.flatMap(([start, end]) => {
    if (right <= start || left >= end) return [[start, end]];
    const remaining = [];
    if (left > start) remaining.push([start, left]);
    if (right < end) remaining.push([right, end]);
    return remaining;
  });
}

function intersectRects(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function buildMultiDisplaySnapshot(native, geometry, supported, status) {
  const bounds = geometry.bounds;
  const surfaces = [];
  const result = { supported: Boolean(supported), status, surfaces, width: bounds.width, height: bounds.height };
  const convert = typeof geometry.screenToDipRect === 'function' ? geometry.screenToDipRect : rect => rect;
  const ready = supported && status === 'ready' && Array.isArray(native?.windows);
  const seenDisplays = new Set();
  for (const display of geometry.displays.slice(0, 32)) {
    if (!display || !/^[a-z0-9_-]{1,64}$/i.test(String(display.id)) || seenDisplays.has(String(display.id))
        || !validRect(display.bounds)) continue;
    seenDisplays.add(String(display.id));
    const area = intersectRects(bounds, intersectRects(display.bounds,
      validRect(display.workArea) ? display.workArea : display.bounds) || display.bounds);
    if (!area) continue;
    const displayId = String(display.id);
    const localArea = { ...area, x: area.x - bounds.x, y: area.y - bounds.y };
    const floor = { id: `desktop-floor:${displayId}`, displayId,
      kind: area.y + area.height < display.bounds.y + display.bounds.height - 1 ? 'taskbar' : 'floor',
      x: localArea.x, y: localArea.y + area.height, width: area.width };
    surfaces.push(floor);
    if (!ready) continue;

    let physicalDisplay = null;
    if (typeof geometry.dipToScreenRect === 'function') {
      try {
        physicalDisplay = geometry.dipToScreenRect(display.bounds);
        if (!validRect(physicalDisplay)) continue;
      } catch { continue; }
    }
    function toLocal(rect) {
      if (!validRect(rect) || !/^[a-z0-9_-]{1,64}$/i.test(String(rect.id))) return null;
      try {
        let dip;
        if (physicalDisplay) {
          // Electron chooses a monitor for screenToDipRect. Convert only this
          // monitor's physical portion so a spanning window uses each DPI.
          const clipped = intersectRects(rect, physicalDisplay);
          if (!clipped) return null;
          const converted = convert(clipped);
          if (!validRect(converted)) return null;
          const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
          dip = { x: converted.x - (clipped.x - rect.x) / scale,
            y: converted.y - (clipped.y - rect.y) / scale,
            width: rect.width / scale, height: rect.height / scale };
        } else {
          dip = convert({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }
        if (!validRect(dip)) return null;
        return { id: String(rect.id), x: dip.x - bounds.x, y: dip.y - bounds.y,
          width: dip.width, height: dip.height, zOrder: Number.isFinite(rect.zOrder) ? rect.zOrder : MAX_WINDOWS };
      } catch { return null; }
    }
    const windows = native.windows.slice(0, MAX_WINDOWS).map(toLocal).filter(Boolean).sort((a, b) => a.zOrder - b.zOrder);
    const taskbars = (Array.isArray(native.taskbars) ? native.taskbars : []).slice(0, 16).map(toLocal).filter(Boolean);
    if (taskbars.some(rect => Math.abs(rect.y - floor.y) <= 2
        && rect.x < floor.x + floor.width && rect.x + rect.width > floor.x)) floor.kind = 'taskbar';
    const foreground = [];
    const seen = new Set();
    for (const rect of windows) {
      if (seen.has(rect.id)) continue;
      seen.add(rect.id);
      // Keep the original top. Vertical clipping cannot create a walkable edge
      // at a different monitor's upper border or across an empty desktop gap.
      if (rect.y >= localArea.y && rect.y <= localArea.y + localArea.height) {
        let segments = [[Math.max(localArea.x, rect.x), Math.min(localArea.x + localArea.width, rect.x + rect.width)]];
        for (const cover of [...foreground, ...taskbars]) {
          if (cover.y <= rect.y && cover.y + cover.height > rect.y) {
            segments = subtractInterval(segments, cover.x, cover.x + cover.width);
          }
        }
        segments.filter(([left, right]) => right - left >= 1).forEach(([left, right], segment) => {
          surfaces.push({ id: `window:${rect.id}:${displayId}:${segment}`, displayId, kind: 'window',
            x: left, y: rect.y, width: right - left, windowId: `window:${rect.id}`,
            anchorX: rect.x, windowWidth: rect.width });
        });
      }
      foreground.push(rect);
    }
  }
  return result;
}

/** Translate native physical pixels into overlay-local Electron DIP coordinates.
 * Only the actual, visible upper frame edge is walkable; clipping a window at
 * the screen boundary must never invent a new upper edge there.
 */
function buildSurfaceSnapshot(native, geometry = {}, supported = false, status = 'unavailable') {
  const bounds = validRect(geometry.bounds) ? geometry.bounds : { x: 0, y: 0, width: 1, height: 1 };
  if (Array.isArray(geometry.displays) && geometry.displays.length) {
    return buildMultiDisplaySnapshot(native, { ...geometry, bounds }, supported, status);
  }
  const display = validRect(geometry.displayBounds) ? geometry.displayBounds : bounds;
  const width = bounds.width;
  const height = bounds.height;
  const bottomReserved = bounds.y + height < display.y + display.height - 1;
  const surfaces = [{ id: 'desktop-floor', kind: bottomReserved ? 'taskbar' : 'floor', x: 0, y: height, width }];
  const result = { supported: Boolean(supported), status, surfaces, width, height };
  if (!supported || status !== 'ready' || !Array.isArray(native?.windows)) return result;

  const convert = typeof geometry.screenToDipRect === 'function' ? geometry.screenToDipRect : rect => rect;
  function toLocal(rect) {
    if (!validRect(rect) || !/^[a-z0-9_-]{1,64}$/i.test(String(rect.id))) return null;
    try {
      const dip = convert({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      if (!validRect(dip)) return null;
      return { id: String(rect.id), x: dip.x - bounds.x, y: dip.y - bounds.y,
        width: dip.width, height: dip.height, zOrder: Number.isFinite(rect.zOrder) ? rect.zOrder : MAX_WINDOWS };
    } catch {
      return null;
    }
  }

  const windows = native.windows.slice(0, MAX_WINDOWS).map(toLocal).filter(Boolean)
    .sort((a, b) => a.zOrder - b.zOrder);
  const taskbars = (Array.isArray(native.taskbars) ? native.taskbars : []).slice(0, 16).map(toLocal).filter(Boolean);
  // A bottom taskbar remains a valid floor even with automatic hiding enabled.
  // The Electron work area is authoritative; do not move the floor underneath it.
  if (taskbars.some(rect => rect.y >= height - 2 && rect.y <= height + 2
      && rect.x < width && rect.x + rect.width > 0)) surfaces[0].kind = 'taskbar';

  const foreground = [];
  const seen = new Set();
  for (const rect of windows) {
    if (seen.has(rect.id)) continue;
    seen.add(rect.id);
    if (rect.y >= 0 && rect.y <= height) {
      let segments = [[Math.max(0, rect.x), Math.min(width, rect.x + rect.width)]];
      for (const cover of [...foreground, ...taskbars]) {
        if (cover.y <= rect.y && cover.y + cover.height > rect.y) {
          segments = subtractInterval(segments, cover.x, cover.x + cover.width);
        }
      }
      segments.filter(([left, right]) => right - left >= 1).forEach(([left, right], segment) => {
        // A segment may shift or be renumbered when an occluder moves. Carry a
        // passenger using its parent window origin, never the segment origin;
        // the walker must reselect a visible segment containing that passenger.
        surfaces.push({ id: `window:${rect.id}:${segment}`, kind: 'window', x: left, y: rect.y, width: right - left,
          windowId: `window:${rect.id}`, anchorX: rect.x, windowWidth: rect.width });
      });
    }
    // Off-screen upper edges can still occlude a lower window's frame.
    foreground.push(rect);
  }
  return result;
}

function validPayload(value) {
  return value && typeof value === 'object' && Array.isArray(value.windows)
    && value.windows.length <= MAX_WINDOWS
    && (value.taskbars === undefined || (Array.isArray(value.taskbars) && value.taskbars.length <= 16));
}

/** One hidden, persistent Windows helper. Dependencies are injectable for tests.
 * The script is read through Electron's asar-aware fs and passed as UTF-16LE
 * EncodedCommand, so packaged games do not need loose scripts or a policy change.
 */
function createWindowSurfaceTracker(options = {}) {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'win32';
  const spawnHelper = options.spawn ?? spawn;
  const readScript = options.readScript ?? (() => fs.readFileSync(path.join(__dirname, 'native', 'window-surfaces.ps1'), 'utf8'));
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const onSnapshot = options.onSnapshot ?? (() => {});
  let geometry = options.geometry ?? {};
  let active = false;
  let child = null;
  let deadline = null;
  let retry = null;
  let failures = 0;
  let native = null;
  let status = 'unavailable';
  let lastPublished = '';

  function snapshot() {
    return buildSurfaceSnapshot(native, geometry, supported, status);
  }
  function publish(force = false) {
    const current = snapshot();
    const serialized = JSON.stringify(current);
    if (force || serialized !== lastPublished) {
      lastPublished = serialized;
      onSnapshot(current);
    }
  }
  function clearDeadline() {
    if (deadline !== null) cancel(deadline);
    deadline = null;
  }
  function stopChild() {
    const previous = child;
    child = null; // Ignore trailing events from this process after kill().
    clearDeadline();
    if (previous) {
      try { previous.kill(); } catch { /* Already exited. */ }
    }
  }
  function failed(candidate) {
    if (candidate !== child || !active) return;
    stopChild();
    native = null;
    status = 'unavailable';
    publish();
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(failures++, 5)));
    retry = schedule(() => { retry = null; launch(); }, delay);
    retry?.unref?.();
  }
  function watch(candidate, timeout) {
    clearDeadline();
    deadline = schedule(() => failed(candidate), timeout);
    deadline?.unref?.();
  }
  function launch() {
    if (!active || !supported || child) return;
    let candidate;
    try {
      const pid = Number.isInteger(options.processId) && options.processId > 0 ? options.processId : process.pid;
      const command = `$ExcludedProcessId = ${pid}\n${readScript()}`;
      // Use the Windows system binary, never a program resolved from the game
      // directory. There is no shell interpolation or user-supplied script path.
      const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      candidate = spawnHelper(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = candidate;
      let buffer = '';
      candidate.stdout.setEncoding('utf8');
      candidate.stdout.on('data', chunk => {
        if (candidate !== child || !active) return;
        if (Buffer.byteLength(buffer) + Buffer.byteLength(chunk) > MAX_LINE_BYTES) return failed(candidate);
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { return failed(candidate); }
          if (!validPayload(parsed)) return failed(candidate);
          native = parsed;
          status = 'ready';
          failures = 0;
          watch(candidate, HEARTBEAT_TIMEOUT);
          publish();
        }
      });
      // Drain stderr so a blocked pipe cannot freeze the collector. Do not log
      // raw system output or expose it to the renderer.
      candidate.stderr.resume();
      candidate.on('error', () => failed(candidate));
      candidate.on('exit', () => failed(candidate));
      watch(candidate, STARTUP_TIMEOUT);
    } catch {
      if (!candidate) {
        // Treat synchronous spawn/read failures just like an exited helper.
        candidate = { kill() {} };
        child = candidate;
      }
      failed(candidate);
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      publish(true);
      launch();
    },
    stop() {
      active = false;
      if (retry !== null) cancel(retry);
      retry = null;
      stopChild();
      native = null;
      status = 'unavailable';
    },
    setGeometry(next) {
      geometry = next;
      if (active) publish();
    },
    getSnapshot: snapshot,
  };
}

module.exports = { buildSurfaceSnapshot, createWindowSurfaceTracker };
