import { el, formatKg } from '../ui.js';
import { KG_EPSILON, STAGES, getLotInputKg, round3 } from '../workflow.js';
import { createKgInputGroup } from './KgInputGroup.js';

/**
 * StageActionForm: biểu mẫu thao tác một lô tại một công đoạn.
 *  - Nhập khối lượng đạt / hư nặng / hư nhẹ (KgInputGroup) rồi "Ghi nhận kết quả".
 *  - Công đoạn ủ chỉ cần xác nhận ủ xong để chuyển sang bước lựa.
 *  - Công đoạn lựa sau ủ: chọn số lượng xuất (toàn bộ / số đã nhập), rồi Đạt + Không đạt phải đúng bằng số xuất.
 *  - Ô "Công đoạn tiếp theo" luôn cho biết từng phần sẽ đi đâu.
 *  - "Chuyển cả lô sang ủ / làm lại" và "Loại bỏ cả lô" là thao tác nhanh có xác nhận.
 * Các callback trả Promise; form tự khoá nút trong lúc chờ. Việc hiện toast/lỗi do trang gọi lo.
 */
export function createStageActionForm({ onSubmit, onSendToSoak, onReject }) {
  let stage = null;
  let lot = null;
  let busy = false;
  let exportKg = null; // Số lượng xuất đã chốt ở công đoạn lựa sau ủ; null = chưa chốt.

  const kg = createKgInputGroup({ onChange: () => syncSubmitState() });
  const title = el('h3', 'action-title', { textContent: 'Chưa chọn lô' });
  const subtitle = el('p', 'action-subtitle');

  const nextBox = el('div', 'next-stage-box is-hidden', { role: 'status' });

  const exportInput = el('input', '', {
    type: 'number', min: '0', step: '0.01', inputMode: 'decimal', placeholder: '0', disabled: true
  });
  const exportAllButton = el('button', 'ghost-action', { type: 'button', textContent: 'Xuất ủ toàn bộ' });
  const exportPartialButton = el('button', 'ghost-action', { type: 'button', textContent: 'Xuất ủ số đã nhập' });
  const exportLabel = el('span', 'field-label', { textContent: 'Số lượng xuất ủ (kg)' });
  const exportStatus = el('p', 'export-box__status');
  const exportBox = el('div', 'export-box is-hidden', {}, [
    el('label', 'export-box__input', {}, [exportLabel, exportInput]),
    el('div', 'export-box__actions', {}, [exportAllButton, exportPartialButton]),
    exportStatus
  ]);

  const targetSelect = el('select', '');
  const targetField = el('label', 'field is-hidden', {}, [
    el('span', 'field-label', { textContent: 'Phần hư nhẹ / không đạt chuyển tới' }),
    targetSelect
  ]);
  const note = el('textarea', '', { rows: 2, maxLength: 500, placeholder: 'Ghi chú tình trạng, lý do loại bỏ (bắt buộc khi loại cả lô)...' });
  const noteField = el('label', 'field', {}, [el('span', 'field-label', { textContent: 'Ghi chú' }), note]);
  const message = el('p', 'field-error', { role: 'alert' });

  const submitLabel = el('span', 'btn-label', { textContent: 'Ghi nhận kết quả' });
  const submit = el('button', 'primary-action', { type: 'submit' }, [el('span', 'btn-spinner'), submitLabel]);
  const soakButton = el('button', 'secondary-action', { type: 'button' });
  const rejectButton = el('button', 'danger-action danger-action--wide', { type: 'button', textContent: 'Loại bỏ cả lô' });
  const quick = el('div', 'action-quick', {}, [soakButton, rejectButton]);

  const element = el('form', 'stage-action-form', { noValidate: true }, [
    title, subtitle, nextBox, exportBox, kg.element, targetField, noteField, message, submit, quick
  ]);

  const isSoak = () => stage?.kind === 'soak';
  const isGrade = () => stage?.kind === 'grade';
  // Ủ lần 1: chỉ chuyển một phần sang lựa sau ủ, phần còn lại là hàng tồn ở lại.
  const isStockSoak = () => isSoak() && Boolean(stage?.partialExport);
  const hasExportBox = () => isGrade() || isStockSoak();
  const idleSubmitText = () => (isSoak()
    ? (isStockSoak() ? `Chuyển sang ${STAGES[stage.next]?.name || ''}` : `Ủ xong, chuyển sang ${STAGES[stage.next]?.name || ''}`)
    : isGrade() ? 'Ghi nhận lựa sau ủ' : 'Ghi nhận kết quả');
  const selectedTarget = () => (stage?.lightTo.length > 1 ? targetSelect.value : stage?.lightTo[0] || '');

  /** Dữ liệu chung gửi lên server cho mọi thao tác. */
  const basePayload = () => ({
    lotId: lot.id,
    stageId: stage.id,
    expectedInputKg: getLotInputKg(lot),
    note: note.value.trim()
  });

  /** Ô "Công đoạn tiếp theo": mỗi dòng là một phần khối lượng và nơi nó đi tới. */
  function renderNextBox() {
    nextBox.replaceChildren();
    if (!stage) {
      nextBox.classList.add('is-hidden');
      return;
    }
    const rows = [];
    const nextName = stage.next ? STAGES[stage.next].name : 'Hoàn tất lô';
    if (isSoak()) {
      rows.push([`Ủ xong → ${nextName}`, '']);
      if (isStockSoak()) rows.push([`Hàng tồn → ở lại ${stage.name}`, 'warn']);
    } else if (isGrade()) {
      rows.push([`Đạt → ${nextName}`, '']);
      rows.push(stage.lightTo.length
        ? [`Không đạt → ${STAGES[stage.lightTo[0]].name}`, 'warn']
        : ['Không đạt → Hao hụt, bỏ luôn', 'bad']);
    } else {
      rows.push([`Đạt → ${nextName}`, '']);
      if (stage.lightTo.length) rows.push([stage.lightLabel, 'warn']);
      rows.push([`${stage.byproductLabel || 'Hư nặng'} → ${stage.byproductLabel ? 'Phụ phẩm' : 'Loại bỏ'}`, 'bad']);
    }
    nextBox.append(
      el('span', 'next-stage-box__label', { textContent: 'Công đoạn tiếp theo' }),
      ...rows.map(([text, tone]) => el('span', `next-stage-box__row${tone ? ` next-stage-box__row--${tone}` : ''}`, { textContent: text }))
    );
    nextBox.classList.remove('is-hidden');
  }

  /** Đồng bộ nhóm ô kg với chế độ của công đoạn (thường / lựa sau ủ cần chốt số lượng xuất trước). */
  function applyKgState() {
    const hasLot = Boolean(stage && lot);
    if (isGrade()) {
      kg.setExactTotal(true);
      kg.setInputKg(exportKg ?? 0, hasLot && exportKg !== null);
      return;
    }
    kg.setExactTotal(false);
    kg.setInputKg(hasLot ? getLotInputKg(lot) : 0, hasLot);
  }

  function renderExportStatus() {
    const available = lot ? getLotInputKg(lot) : 0;
    const stock = stage?.partialExport;
    const nextName = STAGES[stage?.next]?.name || '';
    if (exportKg === null) {
      exportStatus.textContent = stock
        ? `Đang có ${formatKg(available)} kg. Nhập số lượng chuyển sang ${nextName}, phần còn lại là hàng tồn ở ${stage.name}.`
        : `Đang có ${formatKg(available)} kg. Chọn số lượng xuất để nhập Đạt / Không đạt.`;
      return;
    }
    const rest = round3(available - exportKg);
    exportStatus.textContent = stock
      ? `Chuyển ${formatKg(exportKg)} kg sang ${nextName}`
        + (rest > KG_EPSILON ? `, hàng tồn còn ${formatKg(rest)} kg ở ${stage.name}.` : ' (toàn bộ).')
      : `Đã chốt xuất ${formatKg(exportKg)} kg`
        + (rest > KG_EPSILON ? `, còn lại ${formatKg(rest)} kg ở lại ${stage.name}.` : ' (toàn bộ).');
  }

  function lockExport(value) {
    exportKg = value;
    exportInput.value = String(value);
    kg.reset();
    applyKgState();
    renderExportStatus();
    syncSubmitState();
    if (isGrade()) kg.focus();
  }

  function syncSubmitState() {
    const ready = Boolean(stage && lot) && !busy;
    if (isSoak()) submit.disabled = !ready || (isStockSoak() && exportKg === null);
    else submit.disabled = !ready || (isGrade() && exportKg === null) || !kg.validate().valid;
    soakButton.disabled = !ready;
    rejectButton.disabled = !ready;
    exportAllButton.disabled = !ready;
    exportPartialButton.disabled = !ready;
    exportInput.disabled = !ready;
  }

  function setBusy(value) {
    busy = value;
    submit.classList.toggle('is-loading', value);
    submitLabel.textContent = value ? 'Đang ghi nhận...' : idleSubmitText();
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

  exportInput.addEventListener('input', () => {
    if (exportKg === null) return;
    exportKg = null;
    kg.reset();
    applyKgState();
    renderExportStatus();
    syncSubmitState();
  });

  exportAllButton.addEventListener('click', () => {
    if (!stage || !lot || busy) return;
    message.textContent = '';
    lockExport(getLotInputKg(lot));
  });

  exportPartialButton.addEventListener('click', () => {
    if (!stage || !lot || busy) return;
    const value = round3(Number(exportInput.value));
    const available = getLotInputKg(lot);
    if (!exportInput.value.trim() || !Number.isFinite(value) || value <= 0) {
      message.textContent = 'Nhập số lượng xuất lớn hơn 0.';
      exportInput.focus();
      return;
    }
    if (value > available + KG_EPSILON) {
      message.textContent = `Số lượng xuất vượt khối lượng đang có (${formatKg(available)} kg).`;
      exportInput.focus();
      return;
    }
    message.textContent = '';
    lockExport(value);
  });

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!stage || !lot || busy) return;
    if (isSoak()) {
      if (isStockSoak() && exportKg === null) {
        message.textContent = 'Chọn số lượng chuyển sang lựa sau ủ (toàn bộ hoặc số đã nhập).';
        return;
      }
      const moveKg = isStockSoak() ? exportKg : getLotInputKg(lot);
      run(() => onSubmit({ ...basePayload(), passedKg: moveKg, ...(isStockSoak() ? { exportKg: moveKg } : {}) }));
      return;
    }
    if (isGrade() && exportKg === null) {
      message.textContent = 'Chọn số lượng xuất trước (xuất toàn bộ hoặc số đã nhập).';
      return;
    }
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
    run(() => onSubmit({
      ...basePayload(),
      ...values,
      ...(isGrade() ? { exportKg } : {}),
      ...(values.rejectedLightKg > 0 ? { soakTarget: selectedTarget() } : {})
    }));
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

      const soak = isSoak();
      const grade = isGrade();
      const hasLight = hasLot && stage.lightTo.length > 0;
      if (!sameLot) exportKg = null;
      // Lô vừa bị đổi khối lượng ở nơi khác: bỏ số lượng xuất đã chốt.
      if (exportKg !== null && lot && exportKg > getLotInputKg(lot) + KG_EPSILON) {
        exportKg = null;
        exportInput.value = '';
      }

      renderNextBox();
      exportBox.classList.toggle('is-hidden', !hasExportBox());
      exportLabel.textContent = isStockSoak() ? 'Số lượng chuyển sang lựa sau ủ (kg)' : 'Số lượng xuất ủ (kg)';
      exportAllButton.textContent = isStockSoak() ? 'Chuyển toàn bộ' : 'Xuất ủ toàn bộ';
      exportPartialButton.textContent = isStockSoak() ? 'Chuyển số đã nhập (còn lại là hàng tồn)' : 'Xuất ủ số đã nhập';
      kg.element.classList.toggle('is-hidden', soak);
      kg.setLightEnabled(hasLight, stage?.lightLabel, stage?.lightName);
      kg.setHeavyEnabled(!grade || !stage.lightTo.length);
      kg.setByproductLabel(stage?.byproductLabel || '', stage?.byproductHint);
      note.disabled = !hasLot;
      soakButton.classList.toggle('is-hidden', !hasLight || grade);
      rejectButton.classList.toggle('is-hidden', soak || grade);
      targetField.classList.toggle('is-hidden', !(hasLight && stage.lightTo.length > 1));
      if (hasLight) {
        targetSelect.replaceChildren(...stage.lightTo.map((id) => el('option', '', { value: id, textContent: STAGES[id].name })));
        soakButton.textContent = stage.lightTo.length > 1 ? 'Chuyển cả lô làm lại' : `Chuyển cả lô sang ${STAGES[stage.lightTo[0]].name}`;
      }
      if (!sameLot) this.reset();
      applyKgState();
      renderExportStatus();
      submitLabel.textContent = busy ? 'Đang ghi nhận...' : idleSubmitText();
      syncSubmitState();
    },
    /** Xoá dữ liệu đã nhập (sau khi ghi nhận thành công hoặc đổi lô). */
    reset() {
      exportKg = null;
      exportInput.value = '';
      kg.reset();
      note.value = '';
      message.textContent = '';
      renderExportStatus();
    },
    setBusy,
    focus: () => (hasExportBox() ? exportInput.focus() : kg.focus())
  };
}
