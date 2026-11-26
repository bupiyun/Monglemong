import { ITEM_TYPES } from './items.js';

/** The shared warehouse shows only acquired stacks; the caller owns the save. */
export function createWarehouseUI({ onInspect = () => {} } = {}) {
  const grid = document.getElementById('item-grid');
  const empty = document.getElementById('inventory-empty');
  const summary = document.getElementById('inventory-summary');
  const count = document.getElementById('item-count');
  const cards = new Map();
  const format = value => value.toLocaleString('ko-KR');
  let previous = '';

  function makeCard(item) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item-card ' + (item.rarity === 'rare' ? 'item-rare' : 'item-common');
    button.dataset.item = item.id;
    const art = document.createElement('span'); art.className = 'item-art';
    const image = document.createElement('img'); image.src = item.icon; image.alt = '';
    art.append(image);
    const rarity = document.createElement('span'); rarity.className = 'item-rarity';
    rarity.textContent = item.rarity === 'rare' ? '희귀 재료' : '일반 재료';
    const name = document.createElement('strong'); name.textContent = item.name;
    const amount = document.createElement('span'); amount.className = 'item-quantity';
    button.append(art, rarity, name, amount);
    button.addEventListener('click', () => onInspect(item.id));
    wrapper.append(button);
    return { wrapper, button, amount };
  }

  return {
    render(items = {}) {
      const owned = ITEM_TYPES.map(item => {
        const raw = items?.[item.id];
        const quantity = Number.isFinite(raw) ? Math.max(0, Math.min(999999, Math.floor(raw))) : 0;
        return { item, quantity };
      }).filter(entry => entry.quantity > 0);
      const signature = owned.map(({ item, quantity }) => `${item.id}:${quantity}`).join('|');
      if (signature === previous && grid.dataset.ready === 'true') return;
      previous = signature; grid.dataset.ready = 'true';
      const total = owned.reduce((sum, entry) => sum + entry.quantity, 0);
      count.textContent = total > 999 ? '999+' : String(total);
      count.title = `아이템 총 ${format(total)}개`;
      count.setAttribute('aria-label', `총 ${format(total)}개`);
      summary.textContent = owned.length ? `${owned.length}종 · 총 ${format(total)}개 보관 중` : '보관 중인 아이템이 없어요.';
      empty.hidden = owned.length !== 0;
      const current = new Set(owned.map(entry => entry.item.id));
      for (const [id, card] of cards) {
        if (!current.has(id)) { card.wrapper.remove(); cards.delete(id); }
      }
      for (const { item, quantity } of owned) {
        let card = cards.get(item.id);
        if (!card) {
          card = makeCard(item); cards.set(item.id, card);
          const next = owned.slice(owned.findIndex(entry => entry.item.id === item.id) + 1)
            .map(entry => cards.get(entry.item.id)?.wrapper).find(Boolean);
          grid.insertBefore(card.wrapper, next || null);
        }
        card.amount.textContent = `× ${format(quantity)}`;
        card.button.setAttribute('aria-label', `${item.name}, ${item.rarity === 'rare' ? '희귀' : '일반'} 재료, ${format(quantity)}개, 정보 보기`);
      }
    },
  };
}
