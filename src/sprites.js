import { CHARACTER_TYPES } from './characters.js';

/**
 * Fixed character sheet: 1536 × 2400, 8 columns × 10 rows, 192 × 240 cells.
 * Register caller-owned Blob URLs, then apply to existing <img> elements.
 * Time is in seconds. `paused` preserves the last visible frame; `still` uses 0.
 * This module never revokes URLs: the storage/UI owner controls their lifetime.
 */
export const SPRITE_SHEET = Object.freeze({
  width: 1536, height: 2400, columns: 8, rows: 10,
  frameWidth: 192, frameHeight: 240, fps: 8,
});

export const SPRITE_ANIMATIONS = Object.freeze([
  { key: 'idle', label: 'Idle', row: 0 },
  { key: 'walk', label: '걷기', row: 1 },
  { key: 'pet', label: '쓰다듬어져 애교부리기', row: 2 },
  { key: 'doze', label: '졸기', row: 3 },
  { key: 'sleep', label: '잠자기', row: 4 },
  { key: 'battleIdle', label: 'Idle · 전투준비', row: 5 },
  { key: 'battleRun', label: '달리기 · 전투준비', row: 6 },
  { key: 'attack', label: '일반 공격', row: 7 },
  { key: 'strongAttack', label: '강한 공격', row: 8 },
  { key: 'collapse', label: '쓰러짐', row: 9 },
].map(Object.freeze));

const animations = new Map(SPRITE_ANIMATIONS.map(item => [item.key, item]));
const sheets = new Map();
const bundledSources = new Map(CHARACTER_TYPES.filter(type => type.spriteSheet).map(type => [type.id, type.spriteSheet]));
const readyBundledSources = new Map();
// Only the 80 measured offsets survive the scan; no canvas or pixel buffer is
// kept. Sources are local packaged images or caller-owned Blob URLs.
const footInsets = new Map();
const rendered = new WeakMap();
const PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E';
const OWNED_STYLES = [
  'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-origin', 'background-clip',
  'box-sizing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'object-fit', 'image-rendering', 'animation',
];

/** Only the authored catalog may introduce packaged image paths. */
export function getBundledSpriteSource(character) {
  return character && !character.custom ? bundledSources.get(character.id) || null : null;
}

export async function preloadBundledSprites() {
  const failures = [];
  await Promise.all([...bundledSources].map(([id, source]) => new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth === SPRITE_SHEET.width && image.naturalHeight === SPRITE_SHEET.height) {
        readyBundledSources.set(id, source);
        if (!footInsets.has(source)) {
          const measurement = { values: null };
          footInsets.set(source, measurement);
          measureFootInsets(image, measurement);
        }
      }
      else failures.push({ id, source, reason: 'dimensions' });
      resolve();
    };
    image.onerror = () => { failures.push({ id, source, reason: 'missing' }); resolve(); };
    image.src = source;
  })));
  return failures;
}

export function setSpriteSheet(sheetId, objectURL) {
  if (typeof sheetId !== 'string' || !sheetId.trim()) throw new TypeError('A sprite sheet ID is required.');
  const oldURL = sheets.get(sheetId);
  if (objectURL === null) {
    sheets.delete(sheetId);
    releaseFootInsets(oldURL);
    return;
  }
  if (typeof objectURL !== 'string' || !objectURL.startsWith('blob:')) {
    throw new TypeError('Sprite sheets require a Blob object URL.');
  }
  sheets.set(sheetId, objectURL);
  if (oldURL !== objectURL) releaseFootInsets(oldURL);
  if (!footInsets.has(objectURL) && typeof Image !== 'undefined') {
    const measurement = { values: null };
    footInsets.set(objectURL, measurement);
    const image = new Image();
    image.onload = () => {
      if (footInsets.get(objectURL) === measurement) measureFootInsets(image, measurement);
    };
    image.onerror = () => {};
    image.src = objectURL;
  }
}

function releaseFootInsets(source) {
  if (source && ![...sheets.values()].includes(source) && ![...readyBundledSources.values()].includes(source)) {
    footInsets.delete(source);
  }
}

function measureFootInsets(image, measurement) {
  if (typeof document === 'undefined' || image.naturalWidth !== SPRITE_SHEET.width || image.naturalHeight !== SPRITE_SHEET.height) return;
  let canvas;
  try {
    canvas = document.createElement('canvas');
    canvas.width = SPRITE_SHEET.width;
    canvas.height = SPRITE_SHEET.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const values = new Uint16Array(SPRITE_SHEET.columns * SPRITE_SHEET.rows);
    for (let row = 0; row < SPRITE_SHEET.rows; row += 1) {
      for (let frame = 0; frame < SPRITE_SHEET.columns; frame += 1) {
        // RGB values in fully transparent padding are deliberately ignored.
        findFoot: for (let y = SPRITE_SHEET.frameHeight - 1; y >= 0; y -= 1) {
          const start = ((row * SPRITE_SHEET.frameHeight + y) * SPRITE_SHEET.width + frame * SPRITE_SHEET.frameWidth) * 4;
          for (let x = 0; x < SPRITE_SHEET.frameWidth; x += 1) {
            if (data[start + x * 4 + 3] >= 32) {
              values[row * SPRITE_SHEET.columns + frame] = SPRITE_SHEET.frameHeight - y - 1;
              break findFoot;
            }
          }
        }
      }
    }
    measurement.values = values;
  } catch {
    // A blocked canvas or unavailable image keeps the ordinary cell baseline.
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/**
 * Transparent pixels below the visible feet, in CSS pixels in a square sprite.
 * Pass applyCharacterSprite's result to match paused/still frames exactly.
 * Unloaded, missing, or entirely transparent frames safely use zero inset.
 */
export function getCharacterFootInset(character, size = 96, displayedFrame) {
  if (!character) return 0;
  const source = character.custom ? sheets.get(character.sheetId) : readyBundledSources.get(character.id);
  const values = footInsets.get(source)?.values;
  if (!values) return 0;
  const selection = displayedFrame ?? getSpriteFrame(resolveAnimation(character), character.animationTime, { duration: character.animationDuration });
  if (!Number.isInteger(selection.row) || selection.row < 0 || selection.row >= SPRITE_SHEET.rows
    || !Number.isInteger(selection.frame) || selection.frame < 0 || selection.frame >= SPRITE_SHEET.columns) return 0;
  const layout = getSpriteLayout(size, size);
  return layout.paddingY + values[selection.row * SPRITE_SHEET.columns + selection.frame] * layout.frameHeight / SPRITE_SHEET.frameHeight;
}

/** Pure frame selection; unknown animations and invalid times fall back safely. */
export function getSpriteFrame(animation = 'idle', time = 0, {
  paused = false, still = false, previousFrame = 0, duration,
} = {}) {
  const definition = animations.get(animation) || animations.get('idle');
  const seconds = typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0;
  const heldFrame = Number.isInteger(previousFrame) && previousFrame >= 0 && previousFrame < SPRITE_SHEET.columns ? previousFrame : 0;
  const timedAttack = ['attack', 'strongAttack'].includes(definition.key)
    && typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
  // World attacks fit all eight authored frames inside their actual cooldown.
  // Preview calls omit duration and retain the ordinary 8 fps loop.
  const phase = timedAttack ? (seconds % duration) / duration : seconds;
  const frame = still ? 0 : paused ? heldFrame : Math.floor((phase % 1) * SPRITE_SHEET.fps);
  return { animation: definition.key, row: definition.row, frame };
}

/** Fit one complete cell in an arbitrary image box, with transparent letterboxing. */
export function getSpriteLayout(width, height) {
  const safe = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 96;
  width = safe(width); height = safe(height);
  const scale = Math.min(width / SPRITE_SHEET.frameWidth, height / SPRITE_SHEET.frameHeight);
  const frameWidth = Math.min(width, SPRITE_SHEET.frameWidth * scale);
  const frameHeight = Math.min(height, SPRITE_SHEET.frameHeight * scale);
  return { width, height, frameWidth, frameHeight, paddingX: (width - frameWidth) / 2, paddingY: (height - frameHeight) / 2 };
}

function resolveAnimation(character, explicit) {
  if (explicit !== undefined) return animations.has(explicit) ? explicit : 'idle';
  if (animations.has(character.animationState)) return character.animationState;
  if (character.command === 'rest' || character.action === 'rest') return 'sleep';
  if (character.action === 'attack') return 'attack';
  if (character.action === 'walk') return character.command === 'fight' ? 'battleRun' : 'walk';
  return character.command === 'fight' ? 'battleIdle' : 'idle';
}

function saveStyles(img) {
  return OWNED_STYLES.map(name => [name, img.style.getPropertyValue(name), img.style.getPropertyPriority(name)]);
}

function restoreStyles(img, previous) {
  if (previous?.styles) {
    for (const [name, value, priority] of previous.styles) {
      if (value) img.style.setProperty(name, value, priority);
      else img.style.removeProperty(name);
    }
  }
  img.classList.remove('sprite-sheet');
  for (const key of ['spriteRow', 'spriteFrame', 'spriteAnimation', 'spriteSheet']) delete img.dataset[key];
  rendered.delete(img);
}

function imageBox(img) {
  // client sizes exclude CSS transforms, so character facing/breathing cannot
  // alter the crop. Computed dimensions also support currently hidden portraits.
  const computed = img.ownerDocument?.defaultView?.getComputedStyle(img);
  const px = value => typeof value === 'string' && /^\d+(\.\d+)?px$/.test(value) ? parseFloat(value) : 0;
  return getSpriteLayout(img.clientWidth || px(computed?.width) || img.width || 96,
    img.clientHeight || px(computed?.height) || img.height || 96);
}

/**
 * Preserve the img DOM node and its outer CSS size. Backgrounds are clipped to
 * the padded content box, so adjacent sheet cells never fill its letterboxing.
 * For a missing sheet, use the character's built-in fallback until registered.
 */
export function applyCharacterSprite(img, character, options = {}) {
  if (!img?.style || !img?.dataset || !character) return null;
  const animation = resolveAnimation(character, options.animation);
  const bundledSource = getBundledSpriteSource(character);
  const sheetURL = character.custom ? sheets.get(character.sheetId) : readyBundledSources.get(character.id);
  const sheetIdentity = character.custom ? character.sheetId : bundledSource;
  const previous = rendered.get(img);
  if (!sheetURL) {
    restoreStyles(img, previous);
    const resting = animation === 'sleep' || animation === 'doze' || animation === 'collapse';
    const src = (resting ? character.restSprite : character.sprite) || character.sprite || 'assets/character-placeholder.svg';
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    return { ...getSpriteFrame(animation, 0), custom: false, missing: Boolean(character.custom || bundledSource) };
  }

  const sameSequence = previous?.sheetId === sheetIdentity && previous?.animation === animation;
  const frame = getSpriteFrame(animation, options.time ?? character.animationTime ?? 0, {
    paused: options.paused,
    still: options.still,
    previousFrame: sameSequence ? previous.frame : 0,
    duration: options.time === undefined ? character.animationDuration : undefined,
  });
  const styles = previous?.styles || saveStyles(img);
  const layout = imageBox(img);
  const set = (name, value) => { if (img.style.getPropertyValue(name) !== value) img.style.setProperty(name, value); };
  set('box-sizing', 'border-box');
  set('padding-top', `${layout.paddingY}px`);
  set('padding-bottom', `${layout.paddingY}px`);
  set('padding-left', `${layout.paddingX}px`);
  set('padding-right', `${layout.paddingX}px`);
  set('background-image', `url(${JSON.stringify(sheetURL)})`);
  set('background-size', `${SPRITE_SHEET.columns * 100}% ${SPRITE_SHEET.rows * 100}%`);
  set('background-position', `${frame.frame / (SPRITE_SHEET.columns - 1) * 100}% ${frame.row / (SPRITE_SHEET.rows - 1) * 100}%`);
  set('background-repeat', 'no-repeat');
  set('background-origin', 'content-box');
  set('background-clip', 'content-box');
  set('object-fit', 'fill');
  set('image-rendering', 'pixelated');
  // Authored sheet movement replaces the original SVG's CSS bobbing animation.
  set('animation', 'none');
  if (img.getAttribute('src') !== PLACEHOLDER) img.setAttribute('src', PLACEHOLDER);
  img.classList.add('sprite-sheet');
  img.dataset.spriteSheet = sheetIdentity;
  img.dataset.spriteRow = String(frame.row);
  img.dataset.spriteFrame = String(frame.frame);
  img.dataset.spriteAnimation = frame.animation;
  rendered.set(img, { sheetId: sheetIdentity, ...frame, styles });
  return { ...frame, custom: Boolean(character.custom), missing: false };
}
