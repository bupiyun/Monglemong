'use strict';

const MAX_DISPLAYS = 32;
const MAX_DESKTOP_AXIS = 65_536;

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && Math.abs(rect.x) < 10_000_000 && Math.abs(rect.y) < 10_000_000
    && rect.width > 0 && rect.height > 0
    && rect.width <= MAX_DESKTOP_AXIS && rect.height <= MAX_DESKTOP_AXIS;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** All public coordinates are DIP relative to one spanning transparent window.
 * Preserve real monitor rectangles: the union can contain areas with no screen.
 */
function buildDisplayLayout(rawDisplays, primaryId) {
  const candidates = (Array.isArray(rawDisplays) ? rawDisplays : []).filter(display => display
    && /^[a-z0-9_-]{1,64}$/i.test(String(display.id)) && validRect(display.bounds))
    .sort((a, b) => Number(String(b.id) === String(primaryId)) - Number(String(a.id) === String(primaryId)));
  const selected = [];
  const ids = new Set();
  let bounds;
  for (const display of candidates) {
    if (selected.length >= MAX_DISPLAYS) break;
    if (ids.has(String(display.id))) continue;
    const next = bounds ? union(bounds, display.bounds) : { ...display.bounds };
    if (next.width > MAX_DESKTOP_AXIS || next.height > MAX_DESKTOP_AXIS) continue;
    bounds = next;
    ids.add(String(display.id));
    selected.push(display);
  }
  if (!selected.length) {
    selected.push({ id: 'fallback', bounds: { x: 0, y: 0, width: 1, height: 1 } });
    bounds = { ...selected[0].bounds };
  }
  const selectedPrimary = selected.some(display => String(display.id) === String(primaryId))
    ? String(primaryId) : String(selected[0].id);
  const local = rect => ({ x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height });
  return {
    origin: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height, primaryId: selectedPrimary,
    displays: selected.map(display => ({
      id: String(display.id), ...local(display.bounds),
      workArea: local(validRect(display.workArea) ? intersect(display.workArea, display.bounds) || display.bounds : display.bounds),
      scaleFactor: Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 && display.scaleFactor <= 16 ? display.scaleFactor : 1,
      primary: String(display.id) === selectedPrimary,
    })),
  };
}

function desktopBounds(layout) {
  return { ...layout.origin, width: layout.width, height: layout.height };
}

function pointInDisplays(layout, point, workAreaOnly = false) {
  return Boolean(layout?.displays.some(display => {
    const rect = workAreaOnly ? display.workArea : display;
    return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
  }));
}

module.exports = { MAX_DISPLAYS, MAX_DESKTOP_AXIS, buildDisplayLayout, desktopBounds, pointInDisplays };
