import { el, formatDateTime, formatKg, toMillis } from '../ui.js';
import { STAGES } from '../workflow.js';

const ACTION_LABELS = {
  CREATE: { text: 'Nhập lô', tone: 'info' },
  RECORD_RESULT: { text: 'Ghi kết quả', tone: 'ok' },
  SEND_TO_SOAK: { text: 'Chuyển ủ / làm lại', tone: 'warn' },
  REJECT: { text: 'Loại bỏ', tone: 'bad' },
  SPLIT_FROM_PARENT: { text: 'Tách từ lô mẹ', tone: 'warn' }
};

/** Mô tả ngắn phần khối lượng của một bản ghi lịch sử. */
function describeKg(kg = {}) {
  const parts = [];
  if (kg.initialKg !== undefined) parts.push(`Nhập ${formatKg(kg.initialKg)} kg`);
  if (kg.inputKg !== undefined) parts.push(`Vào ${formatKg(kg.inputKg)}`);
  if (kg.passedKg) parts.push(`đạt ${formatKg(kg.passedKg)}`);
  if (kg.rejectedLightKg) parts.push(`hư nhẹ ${formatKg(kg.rejectedLightKg)}`);
  if (kg.rejectedHeavyKg) parts.push(`hư nặng ${formatKg(kg.rejectedHeavyKg)}`);
  if (kg.lossKg) parts.push(`hao hụt ${formatKg(kg.lossKg)}`);
  if (kg.lightKg) parts.push(`${formatKg(kg.lightKg)} kg`);
  return parts.join(' · ');
}

/** HistoryTimeline: danh sách lịch sử thao tác của một lô, mới nhất ở trên. */
export function createHistoryTimeline() {
  const element = el('ol', 'timeline');

  function render(history) {
    element.replaceChildren();
    const entries = [...(history || [])].sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
    if (!entries.length) {
      element.append(el('li', 'timeline-empty', { textContent: 'Chưa có lịch sử thao tác.' }));
      return;
    }
    entries.forEach((entry) => {
      const label = ACTION_LABELS[entry.action] || { text: entry.action, tone: 'info' };
      const kg = entry.kgData || {};
      const lines = [
        el('div', 'timeline-head', {}, [
          el('strong', '', { textContent: STAGES[entry.stage]?.name || entry.stage }),
          el('span', `timeline-badge timeline-badge--${label.tone}`, { textContent: label.text })
        ]),
        el('div', 'timeline-meta', { textContent: `${entry.operatorName || 'Không rõ'} · ${formatDateTime(entry.timestamp)}` })
      ];
      const kgText = describeKg(kg);
      if (kgText) lines.push(el('div', 'timeline-kg', { textContent: kgText }));
      if (kg.nextStage) lines.push(el('div', 'timeline-kg', { textContent: `→ ${STAGES[kg.nextStage]?.name || kg.nextStage}` }));
      if (kg.childLotCode) lines.push(el('div', 'timeline-kg', { textContent: `Lô con: ${kg.childLotCode}` }));
      if (kg.parentLotCode) lines.push(el('div', 'timeline-kg', { textContent: `Lô mẹ: ${kg.parentLotCode}` }));
      if (entry.note) lines.push(el('div', 'timeline-note', { textContent: entry.note }));
      element.append(el('li', `timeline-item timeline-item--${label.tone}`, {}, lines));
    });
  }

  return { element, render };
}