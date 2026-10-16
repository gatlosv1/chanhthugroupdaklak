import { el } from '../ui.js';
import { PROGRESS_STAGE_IDS, STAGES, getLotStageId } from '../workflow.js';

/**
 * StageProgress: timeline ngang các công đoạn chính, tô màu theo trạng thái của lô
 * (đã đạt / đang chờ / chưa tới). Bước ủ không nằm trên đường chính nên hiện thành nhãn riêng.
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

    const list = el('ol', 'progress-steps');
    PROGRESS_STAGE_IDS.forEach((id) => {
      const def = STAGES[id];
      const isCurrent = id === currentId;
      const state = lot.status === 'completed' || done(id) ? 'done'
        : isCurrent ? 'current'
          : stages[id]?.status === 'rejected' ? 'rejected' : 'todo';
      const step = el('li', `progress-step progress-step--${state}`, {}, [
        el('span', 'progress-dot', { textContent: state === 'done' ? '✓' : String(PROGRESS_STAGE_IDS.indexOf(id) + 1) }),
        el('span', 'progress-label', { textContent: def.name })
      ]);
      if (isCurrent) step.setAttribute('aria-current', 'step');
      list.append(step);
    });
    element.append(list);

    if (currentDef?.kind === 'soak') {
      element.append(el('p', 'progress-note', { textContent: `Lô đang ở bước ${currentDef.name}, sau đó quay lại ${STAGES[currentDef.next]?.name || ''}.` }));
    }
    if (lot.status === 'rejected') {
      element.append(el('p', 'progress-note progress-note--bad', { textContent: 'Lô đã bị loại bỏ.' }));
    }
  }

  return { element, render };
}