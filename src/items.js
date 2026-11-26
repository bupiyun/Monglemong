/** Collectible monster materials. Quantities are shared across all companions. */
export const MAX_ITEM_STACK = 999999;

export const ITEM_TYPES = Object.freeze([
  { id: 'slime_gel', name: '슬라임 젤리', description: '숲 슬라임에게서 얻은 말랑한 젤리예요.', rarity: 'common', monsterType: 'grove' },
  { id: 'forest_seed', name: '숲의 씨앗', description: '작은 생명이 잠들어 있는 희귀한 숲의 씨앗이에요.', rarity: 'rare', monsterType: 'grove' },
  { id: 'mushroom_spore', name: '버섯 포자', description: '꼬마 버섯이 남긴 부드러운 포자 가루예요.', rarity: 'common', monsterType: 'mushroom' },
  { id: 'glowing_mushroom', name: '빛나는 버섯', description: '어두운 곳에서도 은은하게 빛나는 희귀한 버섯이에요.', rarity: 'rare', monsterType: 'mushroom' },
  { id: 'crystal_shard', name: '수정 파편', description: '수정 정령에게서 떨어진 반짝이는 조각이에요.', rarity: 'common', monsterType: 'crystal' },
  { id: 'moon_crystal', name: '달빛 결정', description: '달빛을 머금은 희귀하고 맑은 결정이에요.', rarity: 'rare', monsterType: 'crystal' },
].map(item => Object.freeze({ ...item, icon: `assets/items/${item.id}.svg` })));

// Independent rolls: a defeat can yield zero, one, or both materials.
export const MONSTER_DROPS = Object.freeze(Object.fromEntries(
  ['grove', 'mushroom', 'crystal'].map(type => [type, Object.freeze(
    ITEM_TYPES.filter(item => item.monsterType === type).map(item => Object.freeze({
      itemId: item.id, chance: item.rarity === 'rare' ? 0.1 : 0.6, quantity: 1,
    })),
  )]),
));
