import { el, formatKg } from '../ui.js';
import { KG_EPSILON, round3 } from '../workflow.js';

/**
 * KgInputGroup: ba ô nhập khối lượng (đạt / hư nặng / hư nhẹ) kèm thanh tổng kết trực quan
 * và kiểm tra passed + heavy + light ≤ inputKg ngay khi gõ.
 * onChange(validation) được gọi mỗi khi giá trị thay đổi.
 */
export function createKgInputGroup({ onChange = () => {} } = {}) {
  let inputKg = 0;
  let lightOn = true;
  const element = el('div', 'kg-group');

  const makeField = (key, label, hint, tone) => {
    const input = el('input', '', {
      type: 'number', min: '0', step: '0.01', inputMode: 'decimal', placeholder: '0', disabled: true
    });
    input.setAttribute('aria-label', label);
    const error = el('small', 'field-error');
    const box = el('label', `kg-field kg-field--${tone}`, {}, [
      el('span', 'field-label', { textContent: label }),
      input,
      el('small', 'field-hint', { textContent: hint })
    ]);
    return { key, input, box, error };
  };

  const passed = makeField('passedKg', 'Đạt (kg)', 'Đi tiếp công đoạn sau', 'ok');
  const heavy = makeField('rejectedHeavyKg', 'Hư nặng (kg)', 'Loại bỏ', 'bad');
  const light = makeField('rejectedLightKg', 'Hư nhẹ (kg)', 'Ủ / làm lại', 'warn');
  const fields = [passed, heavy, light];

  const fillButton = el('button', 'ghost-action kg-fill', { type: 'button', textContent: 'Đạt toàn bộ', disabled: true });
  const bar = el('div', 'kg-bar', {}, [
    el('span', 'kg-bar__seg kg-bar__seg--ok'),
    el('span', 'kg-bar__seg kg-bar__seg--bad'),
    el('span', 'kg-bar__seg kg-bar__seg--warn')
  ]);
  const summary = el('div', 'kg-summary');
  const message = el('p', 'field-error kg-message', { role: 'alert' });

  element.append(
    el('div', 'kg-fields', {}, fields.map((field) => field.box)),
    fillButton, bar, summary, message
  );

  function getValues() {
    const read = (field) => {
      const raw = field.input.value.trim();
      return raw === '' ? 0 : Number(raw);
    };
    return { passedKg: read(passed), rejectedHeavyKg: read(heavy), rejectedLightKg: read(light) };
  }

  /** Trả về { valid, message, total, lossKg }. */
  function validate({ requireAny = true } = {}) {
    const values = getValues();
    const numbers = Object.values(values);
    if (!numbers.every(Number.isFinite) || numbers.some((n) => n < 0)) {
      return { valid: false, message: 'Khối lượng phải là số không âm.', total: 0, lossKg: 0 };
    }
    const total = round3(numbers.reduce((sum, n) => sum + n, 0));
    if (total > inputKg + KG_EPSILON) {
      return { valid: false, message: `Tổng ${formatKg(total)} kg vượt khối lượng vào ${formatKg(inputKg)} kg.`, total, lossKg: 0 };
    }
    if (requireAny && total <= 0) {
      return { valid: false, message: 'Nhập ít nhất một khối lượng lớn hơn 0.', total, lossKg: inputKg };
    }
    return { valid: true, message: '', total, lossKg: Math.max(0, round3(inputKg - total)) };
  }

  function render() {
    const values = getValues();
    const result = validate({ requireAny: false });
    const pct = (kg) => (inputKg > 0 && Number.isFinite(kg) ? Math.min(100, (kg / inputKg) * 100) : 0);
    const [okSeg, badSeg, warnSeg] = bar.children;
    okSeg.style.width = `${pct(values.passedKg)}%`;
    badSeg.style.width = `${pct(values.rejectedHeavyKg)}%`;
    warnSeg.style.width = `${pct(values.rejectedLightKg)}%`;
    bar.classList.toggle('kg-bar--over', !result.valid);
    summary.textContent = `Khối lượng vào ${formatKg(inputKg)} kg · Đã nhập ${formatKg(result.total)} kg`
      + (result.valid ? ` · Hao hụt ${formatKg(result.lossKg)} kg` : '');
    message.textContent = result.message;
    fields.forEach((field) => field.input.toggleAttribute('aria-invalid', !result.valid));
    onChange(result);
  }

  fields.forEach((field) => field.input.addEventListener('input', render));
  fillButton.addEventListener('click', () => {
    passed.input.value = String(inputKg);
    heavy.input.value = '';
    light.input.value = '';
    render();
  });

  return {
    element,
    getValues,
    validate,
    focus: () => passed.input.focus(),
    /** Đặt khối lượng vào của lô và bật/tắt cả nhóm. */
    setInputKg(kg, enabled = true) {
      inputKg = Number.isFinite(kg) ? kg : 0;
      fields.forEach((field) => { field.input.disabled = !enabled; });
      light.input.disabled = !enabled || !lightOn;
      fillButton.disabled = !enabled;
      render();
    },
    /** Bật/tắt ô hư nhẹ (một số công đoạn không có đường ủ/làm lại). */
    setLightEnabled(enabled, label) {
      lightOn = enabled;
      light.input.disabled = !enabled || passed.input.disabled;
      if (!enabled) light.input.value = '';
      light.box.classList.toggle('is-hidden', !enabled);
      if (label) light.box.querySelector('.field-hint').textContent = label;
      render();
    },
    setByproductLabel(label) {
      heavy.box.querySelector('.field-label').textContent = label ? `${label} (kg)` : 'Hư nặng (kg)';
      heavy.box.querySelector('.field-hint').textContent = label ? 'Phụ phẩm' : 'Loại bỏ';
    },
    reset() {
      fields.forEach((field) => { field.input.value = ''; });
      render();
    }
  };
}