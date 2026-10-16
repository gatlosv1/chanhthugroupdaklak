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
  SORT_1: stage('SORT_1', 'Phân loại 1', 'P1', 'A', 'PREPROCESS', 'sort', 'SOAK_1', ['SOAK_1_1'], { lightLabel: 'Hư nhẹ → Ủ 1.1' }),
  SOAK_1: stage('SOAK_1', 'Ủ 1', 'U1', 'A', 'PREPROCESS', 'soak', 'SORT_2'),
  SOAK_1_1: stage('SOAK_1_1', 'Ủ 1.1', 'U11', 'A', 'PREPROCESS', 'soak', 'SORT_2'),
  SORT_2: stage('SORT_2', 'Phân loại 2', 'P2', 'A', 'PREPROCESS', 'sort', 'PEEL', ['SOAK_2'], { lightLabel: 'Hư nhẹ → Ủ 2' }),
  SOAK_2: stage('SOAK_2', 'Ủ 2', 'U2', 'A', 'PREPROCESS', 'soak', 'SORT_3'),
  SORT_3: stage('SORT_3', 'Phân loại 3', 'P3', 'A', 'PREPROCESS', 'sort', 'PEEL', ['SOAK_3'], { lightLabel: 'Hư nhẹ → Ủ 3' }),
  SOAK_3: stage('SOAK_3', 'Ủ 3', 'U3', 'A', 'PREPROCESS', 'soak', 'SORT_4'),
  SORT_4: stage('SORT_4', 'Phân loại 4', 'P4', 'A', 'PREPROCESS', 'sort', 'PEEL'),

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

/** Công đoạn hiện tại của lô; lô cũ chỉ có pendingStageId. */
function getLotStageId(lot) {
  return lot?.currentStage || lot?.pendingStageId || null;
}

/** Khối lượng đang có của lô; lô cũ chưa có currentKg thì lấy khối lượng nhập. */
function getLotInputKg(lot) {
  const value = Number(lot?.currentKg ?? lot?.intake?.initialKg);
  return Number.isFinite(value) ? round3(value) : 0;
}

/**
 * Kiểm tra và tính kết quả một công đoạn (hàm thuần, không đụng Firestore).
 * Trả về { error } hoặc { inputKg, passedKg, rejectedHeavyKg, rejectedLightKg, lossKg, lightTarget, outcome }.
 * outcome: passed (có phần đạt) | failed (không đạt nhưng còn phần hư nhẹ đi tiếp) | rejected (loại hết).
 */
function evaluateStageResult(stageDef, lot, input) {
  const num = (value) => (value === undefined || value === null || value === '' ? 0 : Number(value));
  const inputKg = round3(Number(input.inputKg));
  const passedKg = round3(num(input.passedKg));
  const rejectedHeavyKg = round3(num(input.rejectedHeavyKg));
  const rejectedLightKg = round3(num(input.rejectedLightKg));

  if (![inputKg, passedKg, rejectedHeavyKg, rejectedLightKg].every(Number.isFinite)
    || passedKg < 0 || rejectedHeavyKg < 0 || rejectedLightKg < 0) {
    return { error: 'Khối lượng phải là số không âm.' };
  }
  const total = round3(passedKg + rejectedHeavyKg + rejectedLightKg);
  if (total <= 0) return { error: 'Nhập ít nhất một khối lượng lớn hơn 0.' };
  if (total > inputKg + KG_EPSILON) {
    return { error: `Tổng đạt + hư nặng + hư nhẹ (${total} kg) vượt khối lượng vào (${inputKg} kg).` };
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
  return {
    inputKg, passedKg, rejectedHeavyKg, rejectedLightKg,
    lossKg: Math.max(0, round3(inputKg - total)),
    lightTarget, outcome
  };
}

module.exports = {
  MAX_REWORK, INTAKE_STAGE_ID, KG_EPSILON, DEPARTMENTS, PHASES, STAGES, STAGE_ORDER,
  resolveDepartmentId, isPrivileged, canOperate, getLotStageId, getLotInputKg, evaluateStageResult, round3
};
