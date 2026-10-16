import { el, formatKg, toMillis } from '../ui.js';
import { getLotInputKg } from '../workflow.js';

const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

/**
 * LotSelector: danh sách lô đang chờ ở một công đoạn, có ô tìm kiếm và trạng thái rỗng.
 * Chọn lô → onSelect(lot). Lô được lọc theo công đoạn ở nơi truy vấn (stagePage), component chỉ hiển thị.
 */
export function createLotSelector({ onSelect = () => {} } = {}) {
  let lots = [];
  let selectedId = null;

  const search = el('input', '', { type: 'search', placeholder: 'Tìm mã lô, biển số, loại hàng...', autocomplete: 'off' });
  search.setAttribute('aria-label', 'Tìm lô');
  const list = el('div', 'lot-queue');
  const empty = el('p', 'queue-empty');
  const element = el('div', 'lot-selector', {}, [search, list]);

  function render() {
    const keyword = normalize(search.value.trim());
    const visible = lots.filter((lot) => !keyword
      || normalize([lot.lotCode, lot.intake?.vehiclePlate, lot.intake?.productType, lot.intake?.origin].join(' ')).includes(keyword));

    list.replaceChildren();
    if (!visible.length) {
      empty.textContent = lots.length ? 'Không có lô phù hợp.' : 'Chưa có lô nào đang chờ ở công đoạn này.';
      list.append(empty);
      return;
    }
    visible.forEach((lot) => {
      const card = el('button', 'lot-card', { type: 'button' }, [
        el('strong', '', { textContent: lot.lotCode || lot.id }),
        el('span', '', {
          textContent: `${formatKg(getLotInputKg(lot))} kg · ${lot.intake?.productType || '-'} · ${lot.intake?.vehiclePlate || '-'}`
        })
      ]);
      card.setAttribute('aria-current', String(lot.id === selectedId));
      card.addEventListener('click', () => { selectedId = lot.id; render(); onSelect(lot); });
      list.append(card);
    });
  }

  search.addEventListener('input', render);

  return {
    element,
    /** Nhận danh sách mới (cũ nhất lên trước để xử lý theo thứ tự vào). */
    setLots(nextLots) {
      lots = [...nextLots].sort((a, b) => toMillis(a.stageEnteredAt || a.updatedAt) - toMillis(b.stageEnteredAt || b.updatedAt));
      render();
    },
    setSelected(id) { selectedId = id; render(); },
    getLots: () => lots
  };
}