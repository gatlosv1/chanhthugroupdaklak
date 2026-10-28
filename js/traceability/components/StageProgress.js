import { el } from '../ui.js';
import { STAGES, STAGE_ORDER, getLotStageId } from '../workflow.js';

/**
 * StageProgress: timeline ngang các công đoạn chính, tô màu theo trạng thái của lô
 * (đã đạt / đang chờ / chưa tới).
 */
export function createStageProgress() {
  const element = el('div', 'stage-progress');

  function render(lot) {
    element.replaceChildren();
    if (!lot) return;
    const currentId = getLotStageId(lot);
    const currentDef = STAGES[currentId];
    const stages = lot.stages || {};
    const done = (id) => stages[id]?.status === 'passed';
    // Bước ủ lần 2 / lựa sau ủ 2 chỉ hiện khi lô thực sự đi qua.
    const visibleIds = STAGE_ORDER.filter((id) => !STAGES[id].optional || id === currentId || stages[id]);

    const list = el('ol', 'progress-steps');
    visibleIds.forEach((id) => {
      const def = STAGES[id];
      const isCurrent = id === currentId;
      const state = lot.status === 'completed' || done(id) ? 'done'
        : isCurrent ? 'current'
          : stages[id]?.status === 'rejected' ? 'rejected' : 'todo';
      const step = el('li', `progress-step progress-step--${state}`, {}, [
        el('span', 'progress-dot', { textContent: state === 'done' ? '✓' : String(visibleIds.indexOf(id) + 1) }),
        el('span', 'progress-label', { textContent: def.name })
      ]);
      if (isCurrent) step.setAttribute('aria-current', 'step');
      list.append(step);
    });
    element.append(list);

    if (currentDef?.kind === 'soak') {
      element.append(el('p', 'progress-note', { textContent: `Lô đang ở bước ${currentDef.name}, sau đó chuyển sang ${STAGES[currentDef.next]?.name || ''}.` }));
    }
    if (lot.status === 'rejected') {
      element.append(el('p', 'progress-note progress-note--bad', { textContent: 'Lô đã bị loại bỏ.' }));
    }
  }

  return { element, render };
}