'use strict';

/**
 * Định nghĩa quy trình truy xuất xoài đông lạnh (nguồn sự thật phía server).
 * Bản sao cho trình duyệt nằm ở js/traceability/workflow.js; scripts/test-workflow.mjs
 * kiểm tra hai bản luôn khớp nhau.
 *
 * Mỗi công đoạn:
 *  - next:     công đoạn kế tiếp khi phần "đạt" đi tiếp (null = công đoạn cuối).
 *  - lightTo:  các công đoạn có thể nhận phần "hư nhẹ" (ủ, làm lại). Rỗng = không có đường này.
 *  - rework:   true nếu lightTo là vòng lặp quay lại (bị giới hạn bởi MAX_REWORK).
 */
const MAX_REWORK = 2;
const INTAKE_STAGE_ID = 'SORT_1';
const KG_EPSILON = 0.0005;

const DEPARTMENTS = {
  PREPROCESS: 'Sơ chế',
  PROCESSING: 'Chế biến',
  FREEZE_PACK: 'Cấp đông & đóng gói'
};

const PHASES = {
  A: 'Phân loại hàng hoá',
  B: 'Lấy má / Chế biến',
  C: 'Đóng gói / Đông lạnh'
};

const stage = (id, name, short, phase, departmentId, kind, next, lightTo = [], extra = {}) => ({
  id, name, short, phase, departmentId, kind, next, lightTo, rework: false, lightLabel: 'Hư nhẹ', ...extra
});

const STAGES = {
  SORT_1: stage('SORT_1', 'Phân loại xuống xe', 'P1', 'A', 'PREPROCESS', 'sort', 'SOAK_1'),
  SOAK_1: stage('SOAK_1', 'Ủ lần 1', 'U1', 'A', 'PREPROCESS', 'soak', 'SORT_SOAK_1', [], { partialExport: true }),
  // 'grade': lựa sau ủ. Có thể xuất một phần; đạt + không đạt phải bằng số lượng xuất.
  SORT_SOAK_1: stage('SORT_SOAK_1', 'Lựa sau ủ 1', 'L1', 'A', 'PREPROCESS', 'grade', 'PEEL', ['SOAK_2'], {
    lightLabel: 'Không đạt → Ủ lần 2', lightName: 'Không đạt'
  }),
  SOAK_2: stage('SOAK_2', 'Ủ lần 2', 'U2', 'A', 'PREPROCESS', 'soak', 'SORT_SOAK_2', [], { optional: true }),
  SORT_SOAK_2: stage('SORT_SOAK_2', 'Lựa sau ủ 2', 'L2', 'A', 'PREPROCESS', 'grade', 'PEEL', [], {
    byproductLabel: 'Không đạt', byproductHint: 'Hao hụt, bỏ luôn', optional: true
  }),

  PEEL: stage('PEEL', 'Gọt vỏ', 'GV', 'B', 'PROCESSING', 'process', 'FLESH', [], { byproductLabel: 'Vỏ' }),
  FLESH: stage('FLESH', 'Lạng má', 'LM', 'B', 'PROCESSING', 'process', 'CHECK_FLESH', [], { byproductLabel: 'Hạt' }),
  CHECK_FLESH: stage('CHECK_FLESH', 'Kiểm má', 'KM', 'B', 'PROCESSING', 'check', 'SHAPE', ['FLESH'], {
    rework: true, lightLabel: 'Không đạt → làm lại'
  }),
  SHAPE: stage('SHAPE', 'Định hình', 'DH', 'B', 'PROCESSING', 'process', 'PACK', [], { byproductLabel: 'Vụn' }),

  PACK: stage('PACK', 'Vô túi PE/PA + đóng thùng carton', 'DG', 'C', 'FREEZE_PACK', 'pack', null)
};

const STAGE_ORDER = Object.keys(STAGES);

const round3 = (value) => Math.round(value * 1000) / 1000;

/** Suy ra bộ phận từ hồ sơ người dùng (giống logic phía trình duyệt). */
function resolveDepartmentId(user) {
  if (user?.departmentId) return user.departmentId;
  const department = String(user?.department || '').trim().toUpperCase();
  if (department.includes('SƠ CHẾ')) return 'PREPROCESS';
  if (department.includes('CHẾ BIẾN')) return 'PROCESSING';
  if (department.includes('CẤP ĐÔNG') || department.includes('ĐÓNG GÓI')) return 'FREEZE_PACK';
  return '';
}

const isPrivileged = (role) => role === 'admin' || role === 'dev';

/** Admin/dev làm được mọi công đoạn; nhân viên chỉ làm công đoạn thuộc bộ phận của mình. */
function canOperate(stageDef, { role, departmentId }) {
  return Boolean(stageDef) && (isPrivileged(role) || (Boolean(departmentId) && departmentId === stageDef.departmentId));
}

/** Các công đoạn đã bị bỏ: lô còn kẹt ở đó được xem như đang ở công đoạn thay thế. */
const LEGACY_STAGE_MAP = {
  SORT_2: 'SORT_SOAK_1',
  SORT_3: 'SORT_SOAK_1',
  SORT_4: 'SORT_SOAK_1',
  SOAK_1_1: 'SOAK_1',
  SOAK_3: 'SOAK_2'
};
const normalizeStageId = (id) => LEGACY_STAGE_MAP[id] || id || null;

/** Công đoạn hiện tại của lô; lô cũ chỉ có pendingStageId. */
function getLotStageId(lot) {
  return normalizeStageId(lot?.currentStage || lot?.pendingStageId || null);
}

/** Khối lượng đang có của lô; lô cũ chưa có currentKg thì lấy khối lượng nhập. */
function getLotInputKg(lot) {
  const value = Number(lot?.currentKg ?? lot?.intake?.initialKg);
  return Number.isFinite(value) ? round3(value) : 0;
}

/**
 * Kiểm tra và tính kết quả một công đoạn (hàm thuần, không đụng Firestore).
 * Trả về { error } hoặc { inputKg, exportKg, remainderKg, passedKg, rejectedHeavyKg, rejectedLightKg, lossKg, lightTarget, outcome }.
 * outcome: passed (có phần đạt) | failed (không đạt nhưng còn phần hư nhẹ đi tiếp) | rejected (loại hết).
 * Công đoạn 'grade' (lựa sau ủ): chỉ xử lý exportKg (mặc định toàn bộ), đạt + không đạt + hỏng phải đúng bằng exportKg,
 * phần còn lại (remainderKg) ở lại công đoạn. Không đạt đi ủ lại nếu có lightTo, ngược lại tính vào hao hụt và bỏ.
 * Hỏng (damagedKg) là hư hỏng, loại bỏ, chỉ nhập được ở công đoạn 'grade'.
 */
function evaluateStageResult(stageDef, lot, input) {
  const num = (value) => (value === undefined || value === null || value === '' ? 0 : Number(value));
  const inputKg = round3(Number(input.inputKg));
  const isGrade = stageDef.kind === 'grade';
  // Lựa sau ủ và Ủ lần 1 (hàng tồn) cho xuất một phần; phần chưa xuất ở lại công đoạn.
  const usesExport = isGrade || Boolean(stageDef.partialExport);
  const hasExport = input.exportKg !== undefined && input.exportKg !== null && input.exportKg !== '';
  const exportKg = usesExport && hasExport ? round3(Number(input.exportKg)) : inputKg;
  const passedKg = round3(num(input.passedKg));
  let rejectedHeavyKg = round3(num(input.rejectedHeavyKg));
  const rejectedLightKg = round3(num(input.rejectedLightKg));
  // Số hỏng chỉ nhập ở công đoạn lựa sau ủ; tính là hư hỏng và loại bỏ.
  const damagedKg = round3(num(input.damagedKg));

  if (![inputKg, exportKg, passedKg, rejectedHeavyKg, rejectedLightKg, damagedKg].every(Number.isFinite)
    || passedKg < 0 || rejectedHeavyKg < 0 || rejectedLightKg < 0 || damagedKg < 0) {
    return { error: 'Khối lượng phải là số không âm.' };
  }
  if (damagedKg > 0 && !isGrade) {
    return { error: `${stageDef.name} không nhập số hỏng. Hãy ghi vào hư nặng.` };
  }
  if (usesExport) {
    if (exportKg <= 0) return { error: 'Nhập số lượng xuất lớn hơn 0.' };
    if (exportKg > inputKg + KG_EPSILON) {
      return { error: `Số lượng xuất (${exportKg} kg) vượt khối lượng đang có (${inputKg} kg).` };
    }
  }
  const total = round3(passedKg + rejectedHeavyKg + rejectedLightKg + damagedKg);
  if (total <= 0) return { error: 'Nhập ít nhất một khối lượng lớn hơn 0.' };
  if (total > exportKg + KG_EPSILON) {
    return { error: `Tổng đạt + không đạt + hỏng (${total} kg) vượt khối lượng vào (${exportKg} kg).` };
  }
  if (usesExport && Math.abs(total - exportKg) > KG_EPSILON) {
    return { error: `Tổng đạt + không đạt${isGrade ? ' + hỏng' : ''} (${total} kg) phải bằng số lượng xuất (${exportKg} kg).` };
  }

  const failsViaSoak = (stageDef.lightTo || []).length > 0;
  if (isGrade && failsViaSoak && rejectedHeavyKg > 0) {
    return { error: `Phần không đạt của ${stageDef.name} phải chuyển sang công đoạn ủ kế tiếp.` };
  }

  let lightTarget = null;
  if (rejectedLightKg > 0) {
    const targets = stageDef.lightTo || [];
    if (!targets.length) {
      return { error: `${stageDef.name} không có đường chuyển hư nhẹ. Hãy ghi phần này vào hư nặng.` };
    }
    lightTarget = input.soakTarget || (targets.length === 1 ? targets[0] : null);
    if (!lightTarget) return { error: 'Chọn công đoạn nhận phần hư nhẹ.' };
    if (!targets.includes(lightTarget)) return { error: 'Công đoạn nhận phần hư nhẹ không hợp lệ.' };
    if (stageDef.rework && Number(lot?.reworkCount || 0) >= MAX_REWORK) {
      return { error: `Lô đã làm lại tối đa ${MAX_REWORK} lần. Hãy ghi phần không đạt vào hư nặng.` };
    }
  }

  const outcome = passedKg > 0 ? 'passed' : rejectedLightKg > 0 ? 'failed' : 'rejected';
  // Không đạt ở công đoạn không còn đường ủ lại: tính vào hao hụt và bỏ luôn.
  const discardedKg = isGrade && !failsViaSoak ? rejectedHeavyKg : 0;
  if (discardedKg > 0) rejectedHeavyKg = 0;
  const remainderKg = Math.max(0, round3(inputKg - exportKg));
  return {
    inputKg, exportKg, remainderKg: remainderKg > KG_EPSILON ? remainderKg : 0,
    passedKg, rejectedHeavyKg, rejectedLightKg, damagedKg,
    lossKg: round3(Math.max(0, round3(exportKg - total)) + discardedKg),
    lightTarget, outcome
  };
}

module.exports = {
  MAX_REWORK, INTAKE_STAGE_ID, KG_EPSILON, DEPARTMENTS, PHASES, STAGES, STAGE_ORDER, LEGACY_STAGE_MAP, normalizeStageId,
  resolveDepartmentId, isPrivileged, canOperate, getLotStageId, getLotInputKg, evaluateStageResult, round3
};
