/** Authored companion identities. Saved games only restore progress, never these traits. */
export const FOOD_GROUPS = Object.freeze([
  { id: 'meat', name: '고기' }, { id: 'fish', name: '생선' },
  { id: 'vegetable', name: '채소' }, { id: 'fruit', name: '과일' },
  { id: 'snack', name: '간식' },
]);

export const TASTES = Object.freeze([
  { id: 'sweet', name: '단맛' }, { id: 'salty', name: '짠맛' },
  { id: 'sour', name: '신맛' }, { id: 'bitter', name: '쓴맛' },
  { id: 'spicy', name: '매운맛' }, { id: 'savory', name: '감칠맛' },
]);

export const FOODS = Object.freeze([
  { id: 'meat', name: '따끈한 고기 꼬치', group: 'meat', tastes: ['savory', 'spicy'], price: 10 },
  { id: 'fish', name: '노릇한 생선구이', group: 'fish', tastes: ['salty', 'savory'], price: 10 },
  { id: 'vegetable', name: '싱그러운 채소 접시', group: 'vegetable', tastes: ['bitter', 'savory'], price: 10 },
  { id: 'fruit', name: '새콤달콤 과일 그릇', group: 'fruit', tastes: ['sweet', 'sour'], price: 10 },
  { id: 'snack', name: '바삭한 별 쿠키', group: 'snack', tastes: ['sweet', 'salty'], price: 10 },
]);

/** The shipped base roster. Additional companions can be authored here later. */
export const CHARACTER_TYPES = Object.freeze([
  Object.freeze({
    id: 'cafemong', name: '카페몽', title: '카페에서 태어난 고양이형 몽글몬',
    personality: '차분하고 늘 방긋방긋 미소 짓는다.\n카페 일을 하며 커피를 내릴 때 가장 행복해 하며, 털에선 늘 부드러운 라떼 향이 난다.',
    foodPreference: 'snack', tastePreferences: Object.freeze(['bitter', 'sweet']), unlockClears: 0,
    sprite: 'assets/character-placeholder.svg', restSprite: 'assets/character-placeholder.svg',
    spriteSheet: 'assets/characters/cafemong.png',
    baseStats: Object.freeze({ hp: 130, mana: 30, attack: 6, defense: 4, magic: 14, resistance: 9, speed: 8 }),
    growthStats: Object.freeze({ hp: 10, mana: 5, attack: 1, defense: 2, magic: 2, resistance: 3, speed: 0.5 }),
    statRounding: 'fractional',
  }),
]);
