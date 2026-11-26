/**
 * Ephemeral desktop placement, separate from the saved, one-dimensional RPG.
 * All coordinates are overlay-local DIPs; x is the sprite centre and footY is
 * its bottom. Native snapshots contain only the visible portions of top edges.
 */
const FLOOR_ID = 'desktop-floor';
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function createSurfaceWalker({ gravity = 1200, snapDistance = 56 } = {}) {
  const characters = new Map();
  const acceleration = clamp(finite(gravity, 1200), 100, 5000);
  const snap = clamp(finite(snapDistance, 56), 0, 160);
  let snapshot = { supported: false, status: 'unavailable', width: 1280, height: 720, surfaces: [] };

  function updateSnapshot(value) {
    const source = value && typeof value === 'object' ? value : {};
    const seen = new Set();
    const surfaces = [];
    for (const surface of Array.isArray(source.surfaces) ? source.surfaces : []) {
      if (!surface || typeof surface.id !== 'string' || !surface.id || seen.has(surface.id)
        || !['window', 'floor', 'taskbar'].includes(surface.kind)
        || ![surface.x, surface.y, surface.width].every(Number.isFinite) || surface.width <= 0) continue;
      seen.add(surface.id);
      const hasParent = typeof surface.windowId === 'string' && surface.windowId
        && Number.isFinite(surface.anchorX) && Number.isFinite(surface.windowWidth) && surface.windowWidth > 0;
      surfaces.push({ id: surface.id, kind: surface.kind, x: surface.x, y: surface.y, width: surface.width,
        ...(surface.kind === 'window' ? {
          windowId: hasParent ? surface.windowId : surface.id,
          anchorX: hasParent ? surface.anchorX : surface.x,
          windowWidth: hasParent ? surface.windowWidth : surface.width,
        } : {}),
      });
    }
    snapshot = {
      supported: source.supported === true,
      status: source.status === 'ready' ? 'ready' : 'unavailable',
      width: clamp(finite(source.width, snapshot.width), 1, 20000),
      height: clamp(finite(source.height, snapshot.height), 1, 20000),
      surfaces,
    };
  }

  function geometry(options) {
    const width = clamp(finite(options.width, snapshot.width), 1, 20000);
    const height = clamp(finite(options.height, snapshot.height), 1, 20000);
    const size = clamp(finite(options.size, 192), 1, 20000);
    const half = Math.min(size / 2, width / 2);
    const ready = options.enabled !== false && snapshot.supported && snapshot.status === 'ready';
    const nativeFloor = ready && snapshot.surfaces.find(surface => surface.id === FLOOR_ID && surface.kind !== 'window');
    // The overlay is the primary display work area: its bottom is the taskbar
    // edge (or screen bottom). Never retain an old bottom after display resize.
    const floor = { id: FLOOR_ID, kind: nativeFloor ? nativeFloor.kind : 'floor', x: 0, y: height, width };
    const surfaces = [floor];
    const windows = new Map();
    if (ready) {
      for (const surface of snapshot.surfaces) {
        if (surface.kind !== 'window' || surface.id === FLOOR_ID) continue;
        if (!windows.has(surface.windowId)) windows.set(surface.windowId, surface);
        const left = Math.max(0, surface.x);
        const right = Math.min(width, surface.x + surface.width);
        if (right - left < size || surface.y < size || surface.y >= height) continue;
        surfaces.push({ ...surface, x: left, width: right - left });
      }
    }
    return { width, height, size, half, ready, floor, surfaces, windows };
  }

  function key(options) {
    return options.characterId ?? 'default';
  }

  function getCharacter(options, bounds) {
    let character = characters.get(key(options));
    if (!character) {
      character = {
        x: clamp(finite(options.x, bounds.width / 2), bounds.half, bounds.width - bounds.half),
        footY: bounds.height, facing: 1, velocityY: 0,
        surface: { ...bounds.floor }, dragging: false, action: 'idle',
      };
      characters.set(key(options), character);
    }
    return character;
  }

  function pose(character) {
    return {
      x: character.x, footY: character.footY,
      surfaceId: character.surface?.id ?? null,
      surfaceKind: character.surface?.kind ?? null,
      action: character.action, facing: character.facing,
      grounded: Boolean(character.surface),
      onFloor: Boolean(character.surface && character.surface.kind !== 'window'),
      dragging: character.dragging,
    };
  }

  function attach(character, surface, bounds) {
    const half = surface.kind === 'window' ? bounds.size / 2 : bounds.half;
    character.x = clamp(character.x, surface.x + half, surface.x + surface.width - half);
    character.footY = surface.y;
    character.velocityY = 0;
    character.surface = { ...surface };
    character.action = 'idle';
  }

  function floor(character, options, bounds) {
    character.x = finite(options.x, character.x);
    character.dragging = false;
    attach(character, bounds.floor, bounds);
    return pose(character);
  }

  function setFreePosition(character, options, bounds) {
    character.x = clamp(finite(options.x, character.x), bounds.half, bounds.width - bounds.half);
    character.footY = clamp(finite(options.footY, character.footY), Math.min(bounds.size, bounds.height), bounds.height);
    character.surface = null;
    character.velocityY = 0;
  }

  function beginDrag(options = {}) {
    const bounds = geometry(options);
    const character = getCharacter(options, bounds);
    setFreePosition(character, options, bounds);
    character.dragging = true;
    character.action = 'idle';
    return pose(character);
  }

  function release(options = {}) {
    const bounds = geometry(options);
    const character = getCharacter(options, bounds);
    setFreePosition(character, options, bounds);
    character.dragging = false;
    if (!bounds.ready || options.command === 'fight') return floor(character, options, bounds);
    const candidates = bounds.surfaces.filter(surface => {
      const half = surface.kind === 'window' ? bounds.size / 2 : bounds.half;
      return character.x >= surface.x + half && character.x <= surface.x + surface.width - half
        && Math.abs(surface.y - character.footY) <= snap;
    }).sort((a, b) => Math.abs(a.y - character.footY) - Math.abs(b.y - character.footY) || a.y - b.y);
    if (candidates.length) attach(character, candidates[0], bounds);
    else character.action = 'fall';
    return pose(character);
  }

  function step(options = {}) {
    const bounds = geometry(options);
    const character = getCharacter(options, bounds);
    const dt = clamp(finite(options.dt, 0), 0, 0.1);
    const command = options.command ?? 'wander';
    if (options.dragging === true || (character.dragging && options.dragging !== false)) {
      return beginDrag(options);
    }
    if (character.dragging) release(options);
    if (!bounds.ready || command === 'fight') return floor(character, options, bounds);

    character.footY = clamp(character.footY, Math.min(bounds.size, bounds.height), bounds.height);
    character.action = 'idle';
    if (character.surface) {
      const previous = character.surface;
      if (previous.kind !== 'window') {
        const previousX = character.x;
        floor(character, options, bounds);
        if (!options.paused && command === 'wander' && Math.abs(character.x - previousX) > 0.01) {
          character.action = 'walk';
          character.facing = character.x > previousX ? 1 : -1;
        }
        return pose(character);
      } else {
        const parent = bounds.windows.get(previous.windowId);
        let current;
        if (parent) {
          // Visible segments can move or be renumbered when another window
          // covers them. Only the full parent window can carry its passenger.
          character.x += parent.anchorX - previous.anchorX;
          character.footY = clamp(parent.y, Math.min(bounds.size, bounds.height), bounds.height);
          if (parent.windowWidth !== previous.windowWidth && parent.windowWidth >= bounds.size) {
            character.x = clamp(character.x, parent.anchorX + bounds.size / 2,
              parent.anchorX + parent.windowWidth - bounds.size / 2);
          }
          character.x = clamp(character.x, bounds.half, bounds.width - bounds.half);
          current = bounds.surfaces.find(surface => surface.kind === 'window'
            && surface.windowId === previous.windowId
            && character.x >= surface.x + bounds.size / 2
            && character.x <= surface.x + surface.width - bounds.size / 2);
        }
        if (current) attach(character, current, bounds);
        else {
          character.surface = null;
          character.velocityY = 0;
        }
      }
    }
    character.x = clamp(character.x, bounds.half, bounds.width - bounds.half);

    if (character.surface) {
      if (!options.paused && command === 'wander' && dt > 0) {
        const speed = clamp(finite(options.speed, 32), 0, 1000);
        const left = character.surface.x + bounds.size / 2;
        const right = character.surface.x + character.surface.width - bounds.size / 2;
        const distance = right - left;
        if (distance > 0 && speed > 0) {
          // Fold the travelled distance into the segment. Reflection also works
          // for a very short ledge, without an unbounded bounce loop.
          const phase = character.facing > 0 ? character.x - left : 2 * distance - (character.x - left);
          const progress = (phase + speed * dt) % (2 * distance);
          character.x = left + (progress <= distance ? progress : 2 * distance - progress);
          character.facing = progress < distance ? 1 : -1;
          character.action = 'walk';
        }
      }
      return pose(character);
    }

    // Geometry can change while paused, but elapsed time must not accumulate.
    if (options.paused) return pose(character);
    character.action = 'fall';
    const previousY = character.footY;
    const nextY = previousY + character.velocityY * dt + acceleration * dt * dt / 2;
    character.velocityY = Math.min(1600, character.velocityY + acceleration * dt);
    const collision = bounds.surfaces.filter(surface => {
      const half = surface.kind === 'window' ? bounds.size / 2 : bounds.half;
      return character.x >= surface.x + half && character.x <= surface.x + surface.width - half
        && surface.y >= previousY && surface.y <= nextY;
    }).sort((a, b) => a.y - b.y)[0];
    if (collision) attach(character, collision, bounds);
    else character.footY = Math.min(bounds.height, nextY);
    return pose(character);
  }

  return { updateSnapshot, step, beginDrag, release, forget: characterId => characters.delete(characterId ?? 'default') };
}
