import { el, formatKg } from '../ui.js';
import { STAGES, getLotInputKg } from '../workflow.js';
import { createKgInputGroup } from './KgInputGroup.js';

/**
 * StageActionForm: biểu mẫu thao tác một lô tại một công đoạn.
 *  - Nhập khối lượng đạt / hư nặng / hư nhẹ (KgInputGroup) rồi "Ghi nhận kết quả".
 *  - "Chuyển cả lô sang ủ / làm lại" và "Loại bỏ cả lô" là thao tác nhanh có xác nhận.
 * Các callback trả Promise; form tự khoá nút trong lúc chờ. Việc hiện toast/lỗi do trang gọi lo.
 */
export function createStageActionForm({ onSubmit, onSendToSoak, onReject }) {
  let stage = null;
  let lot = null;
  let busy = false;

  const kg = createKgInputGroup({ onChange: () => syncSubmitState() });
  const title = el('h3', 'action-title', { textContent: 'Chưa chọn lô' });
  const subtitle = el('p', 'action-subtitle');

  const targetSelect = el('select', '');
  const targetField = el('label', 'field is-hidden', {}, [
    el('span', 'field-label', { textContent: 'Phần hư nhẹ / không đạt chuyển tới' }),
    targetSelect
  ]);
  const note = el('textarea', '', { rows: 2, maxLength: 500, placeholder: 'Ghi chú tình trạng, lý do loại bỏ (bắt buộc khi loại cả lô)...' });
  const noteField = el('label', 'field', {}, [el('span', 'field-label', { textContent: 'Ghi chú' }), note]);
  const message = el('p', 'field-error', { role: 'alert' });

  const submit = el('button', 'primary-action', { type: 'submit' }, [
    el('span', 'btn-spinner'),
    el('span', 'btn-label', { textContent: 'Ghi nhận kết quả' })
  ]);
  const soakButton = el('button', 'secondary-action', { type: 'button' });
  const rejectButton = el('button', 'danger-action danger-action--wide', { type: 'button', textContent: 'Loại bỏ cả lô' });
  const quick = el('div', 'action-quick', {}, [soakButton, rejectButton]);

  const element = el('form', 'stage-action-form', { noValidate: true }, [
    title, subtitle, kg.element, targetField, noteField, message, submit, quick
  ]);

  const selectedTarget = () => (stage?.lightTo.length > 1 ? targetSelect.value : stage?.lightTo[0] || '');

  /** Dữ liệu chung gửi lên server cho mọi thao tác. */
  const basePayload = () => ({
    lotId: lot.id,
    stageId: stage.id,
    expectedInputKg: getLotInputKg(lot),
    note: note.value.trim()
  });

  function syncSubmitState() {
    const ready = Boolean(stage && lot) && !busy;
    submit.disabled = !ready || !kg.validate().valid;
    soakButton.disabled = !ready;
    rejectButton.disabled = !ready;
  }

  function setBusy(value) {
    busy = value;
    submit.classList.toggle('is-loading', value);
    submit.querySelector('.btn-label').textContent = value ? 'Đang ghi nhận...' : 'Ghi nhận kết quả';
    syncSubmitState();
  }

  async function run(action) {
    message.textContent = '';
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!stage || !lot || busy) return;
    const check = kg.validate();
    if (!check.valid) {
      message.textContent = check.message;
      return;
    }
    const values = kg.getValues();
    if (values.rejectedLightKg > 0 && !selectedTarget()) {
      message.textContent = 'Chọn nơi nhận phần hư nhẹ.';
      return;
    }
    run(() => onSubmit({ ...basePayload(), ...values, ...(values.rejectedLightKg > 0 ? { soakTarget: selectedTarget() } : {}) }));
  });

  soakButton.addEventListener('click', () => {
    if (!stage || !lot || busy) return;
    const target = STAGES[selectedTarget()];
    if (!window.confirm(`Chuyển toàn bộ ${formatKg(getLotInputKg(lot))} kg của lô ${lot.lotCode} sang ${target?.name}?`)) return;
    run(() => onSendToSoak({ ...basePayload(), soakTarget: selectedTarget() }));
  });

  rejectButton.addEventListener('click', () => {
    if (!stage || !lot || busy) return;
    if (note.value.trim().length < 3) {
      message.textContent = 'Nhập lý do loại bỏ vào ô Ghi chú (tối thiểu 3 ký tự).';
      note.focus();
      return;
    }
    if (!window.confirm(`Loại bỏ toàn bộ lô ${lot.lotCode}? Thao tác này không thể hoàn tác.`)) return;
    run(() => onReject(basePayload()));
  });

  return {
    element,
    /** Gắn công đoạn + lô đang chọn; truyền lot = null để khoá form. */
    setContext(nextStage, nextLot) {
      const sameLot = lot?.id === nextLot?.id && stage?.id === nextStage?.id;
      stage = nextStage;
      lot = nextLot;
      const hasLot = Boolean(stage && lot);
      title.textContent = hasLot ? `Lô ${lot.lotCode}` : 'Chưa chọn lô';
      subtitle.textContent = hasLot
        ? `${stage.name} · ${lot.intake?.productType || '-'} · ${lot.intake?.vehiclePlate || '-'}`
        : 'Chọn một lô ở danh sách bên trái để nhập kết quả.';

      const hasLight = hasLot && stage.lightTo.length > 0;
      kg.setLightEnabled(hasLight, stage?.lightLabel);
      kg.setByproductLabel(stage?.byproductLabel || '');
      kg.setInputKg(hasLot ? getLotInputKg(lot) : 0, hasLot);
      note.disabled = !hasLot;
      soakButton.classList.toggle('is-hidden', !hasLight);
      targetField.classList.toggle('is-hidden', !(hasLight && stage.lightTo.length > 1));
      if (hasLight) {
        targetSelect.replaceChildren(...stage.lightTo.map((id) => el('option', '', { value: id, textContent: STAGES[id].name })));
        soakButton.textContent = stage.lightTo.length > 1 ? 'Chuyển cả lô làm lại' : `Chuyển cả lô sang ${STAGES[stage.lightTo[0]].name}`;
      }
      if (!sameLot) this.reset();
      syncSubmitState();
    },
    /** Xoá dữ liệu đã nhập (sau khi ghi nhận thành công hoặc đổi lô). */
    reset() {
      kg.reset();
      note.value = '';
      message.textContent = '';
    },
    setBusy,
    focus: () => kg.focus()
  };
}
