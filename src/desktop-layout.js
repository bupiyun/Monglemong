// Electron publishes device-independent, overlay-local coordinates. Keep real
// work areas separate so empty space between monitors never becomes a floor.
export function readDesktopLayout(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.displays)) return null;
  const seen = new Set();
  const displays = snapshot.displays.flatMap(display => {
    const area = display?.workArea;
    if (!display || typeof display.id !== 'string' || seen.has(display.id) || !area
      || ![area.x, area.y, area.width, area.height].every(Number.isFinite)
      || area.width <= 0 || area.height <= 0) return [];
    seen.add(display.id);
    return [{ id: display.id, x: area.x, y: area.y, width: area.width, height: area.height,
      floorY: area.y + area.height, primary: display.id === snapshot.primaryId || display.primary === true }];
  });
  if (!displays.length) return null;
  displays.sort((a, b) => Number(b.primary) - Number(a.primary));
  return { displays, width: snapshot.width, height: snapshot.height };
}

export function displayForPoint(displays, x, y) {
  const inside = displays.find(area => x >= area.x && x <= area.x + area.width
    && y >= area.y && y <= area.y + area.height);
  if (inside) return inside;
  // A staggered monitor layout can leave gaps. Snap to the nearest real area.
  const distance = area => Math.hypot(Math.max(area.x - x, 0, x - area.x - area.width),
    Math.max(area.y - y, 0, y - area.y - area.height));
  return displays.reduce((nearest, area) => distance(area) < distance(nearest) ? area : nearest, displays[0]);
}

export function clampCharacterPoint(area, x, footY, size) {
  const half = Math.min(size / 2, area.width / 2);
  return { x: Math.max(area.x + half, Math.min(area.x + area.width - half, x)),
    footY: Math.max(Math.min(area.y + size, area.floorY), Math.min(area.floorY, footY)) };
}
