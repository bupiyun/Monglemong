import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRITE_ANIMATIONS, SPRITE_SHEET, getSpriteFrame, getSpriteLayout, setSpriteSheet, getCharacterFootInset } from '../src/sprites.js';

test('the authored sheet has exactly ten named rows, ending in collapse', () => {
  assert.equal(SPRITE_SHEET.frameWidth * SPRITE_SHEET.columns, 1536);
  assert.equal(SPRITE_SHEET.frameHeight * SPRITE_SHEET.rows, 2400);
  assert.deepEqual(SPRITE_ANIMATIONS.map(({key}) => key), [
    'idle', 'walk', 'pet', 'doze', 'sleep', 'battleIdle', 'battleRun', 'attack', 'strongAttack', 'collapse',
  ]);
  assert.deepEqual(SPRITE_ANIMATIONS.map(({row}) => row), Array.from({length:10}, (_,i) => i));
  assert.equal(SPRITE_ANIMATIONS[9].label, '쓰러짐');
});

test('every animation visits eight frames at 8 fps and loops within its own row', () => {
  for (const {key,row} of SPRITE_ANIMATIONS) {
    assert.deepEqual(Array.from({length:16}, (_,i) => getSpriteFrame(key, i/8)),
      Array.from({length:16}, (_,i) => ({animation:key,row,frame:i%8})));
    assert.equal(getSpriteFrame(key, .124).frame, 0);
    assert.equal(getSpriteFrame(key, .125).frame, 1);
    assert.equal(getSpriteFrame(key, .999).frame, 7);
    assert.equal(getSpriteFrame(key, 1).frame, 0);
  }
});

test('pause holds the visible frame, while still portraits always show the first', () => {
  assert.equal(getSpriteFrame('pet', 20.9, {paused:true,previousFrame:3}).frame, 3);
  assert.equal(getSpriteFrame('pet', 20.9, {paused:true,previousFrame:9}).frame, 0);
  assert.equal(getSpriteFrame('pet', 20.9, {paused:true,still:true,previousFrame:3}).frame, 0);
  assert.deepEqual(getSpriteFrame('collapse', 0.8, {still:true}), {animation:'collapse',row:9,frame:0});
});

test('invalid animation or timing cannot select cells outside the sheet', () => {
  assert.deepEqual(getSpriteFrame('missing', NaN), {animation:'idle',row:0,frame:0});
  for (const time of [-5, Infinity, -Infinity, '2', null]) assert.equal(getSpriteFrame('walk', time).frame, 0);
  for (const time of [0, 99999.99, Number.MAX_VALUE]) {
    const {frame} = getSpriteFrame('collapse', time);
    assert.ok(Number.isInteger(frame) && frame >= 0 && frame < 8);
  }
});

test('full 192:240 cells fit square portraits and wide/tall boxes without stretching', () => {
  for (const [width,height] of [[96,96],[56,56],[62,62],[85,85],[320,120],[80,200],[192,240]]) {
    const layout = getSpriteLayout(width,height);
    assert.ok(Math.abs(layout.frameWidth/layout.frameHeight - 192/240) < 1e-10);
    assert.ok(layout.frameWidth <= width && layout.frameHeight <= height);
    assert.ok(Math.abs(layout.frameWidth + layout.paddingX*2-width) < 1e-10);
    assert.ok(Math.abs(layout.frameHeight + layout.paddingY*2-height) < 1e-10);
  }
  const square = getSpriteLayout(96,96);
  assert.ok(Math.abs(square.paddingX - 9.6) < 1e-10);
  assert.equal(square.paddingY, 0);
  assert.equal(getSpriteLayout(0,NaN).height,96);
});

test('the URL registry accepts caller-owned blob URLs and removes without revoking', () => {
  assert.doesNotThrow(() => setSpriteSheet('sample','blob:https://mori.test/sample'));
  assert.doesNotThrow(() => setSpriteSheet('sample',null));
  assert.throws(() => setSpriteSheet('', 'blob:sample'), TypeError);
  assert.throws(() => setSpriteSheet('sample','https://untrusted.test/image.png'), TypeError);
  assert.throws(() => setSpriteSheet('sample','javascript:alert(1)'), TypeError);
});


test('short world attacks reach frame seven before their duration ends; previews stay at 8 fps', () => {
  for (const animation of ['attack', 'strongAttack']) {
    for (const duration of [0.4, 0.5]) {
      assert.equal(getSpriteFrame(animation, duration * .999, {duration}).frame, 7);
      assert.deepEqual(Array.from({length:8}, (_,i) => getSpriteFrame(animation, duration * (i + .1) / 8, {duration}).frame), [0,1,2,3,4,5,6,7]);
    }
    assert.equal(getSpriteFrame(animation, .499).frame, 3);
    assert.equal(getSpriteFrame(animation, .499, {duration:0}).frame, 3);
    assert.equal(getSpriteFrame(animation, .499, {duration:Infinity}).frame, 3);
    assert.equal(getSpriteFrame(animation, .499, {duration:.5,paused:true,previousFrame:2}).frame, 2);
  }
  assert.equal(getSpriteFrame('walk', .375, {duration:.5}).frame, 3);
});

test('visible feet ignore transparent RGB and scale the exact displayed frame; measurements follow URL ownership', () => {
  const previousImage = globalThis.Image;
  const previousDocument = globalThis.document;
  const pixels = new Uint8ClampedArray(SPRITE_SHEET.width * SPRITE_SHEET.height * 4);
  const pixel = (row, frame, x, y, alpha) => {
    const index = ((row * 240 + y) * 1536 + frame * 192 + x) * 4;
    pixels[index] = 255;
    pixels[index + 3] = alpha;
  };
  pixel(0, 0, 90, 199, 255); // Forty source pixels below the visible foot.
  pixel(0, 0, 90, 239, 0);   // Hidden RGB must not shift that foot.
  pixel(0, 1, 90, 219, 32);
  pixel(0, 1, 90, 239, 31);  // Faint padding below the alpha threshold.
  pixel(9, 7, 90, 209, 255);
  let scans = 0;
  globalThis.Image = class {
    naturalWidth = 1536;
    naturalHeight = 2400;
    set src(value) { this.onload(); }
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        getContext: () => ({
          drawImage() { scans += 1; },
          getImageData: () => ({ data: pixels }),
        }),
      };
    },
  };
  const character = { custom: true, sheetId: 'foot-test', animationState: 'idle', animationTime: 0 };
  try {
    assert.equal(getCharacterFootInset(character, 192), 0);
    setSpriteSheet('foot-test', 'blob:foot-test');
    assert.equal(getCharacterFootInset(character, 96), 16);
    assert.equal(getCharacterFootInset(character, 192), 32);
    assert.equal(getCharacterFootInset(character, 288), 48);
    assert.equal(getCharacterFootInset(character, 192, { row: 0, frame: 1 }), 16);
    assert.equal(getCharacterFootInset(character, 288, { row: 9, frame: 7 }), 36);
    assert.equal(getCharacterFootInset(character, 192, { row: 0, frame: 2 }), 0);
    assert.equal(getCharacterFootInset(character, 192, { row: 10, frame: 0 }), 0);
    assert.equal(getCharacterFootInset({ ...character, animationTime: 0.125 }, 192), 16);
    setSpriteSheet('foot-test', 'blob:foot-test');
    setSpriteSheet('foot-test-shared', 'blob:foot-test');
    assert.equal(scans, 1);
    setSpriteSheet('foot-test', null);
    assert.equal(getCharacterFootInset(character, 192), 0);
    assert.equal(getCharacterFootInset({ ...character, sheetId: 'foot-test-shared' }, 192), 32);
    setSpriteSheet('foot-test-shared', null);
    setSpriteSheet('foot-test', 'blob:foot-test');
    assert.equal(scans, 2);
  } finally {
    setSpriteSheet('foot-test', null);
    setSpriteSheet('foot-test-shared', null);
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
