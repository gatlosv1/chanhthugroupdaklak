// Bản sao quy trình cho trình duyệt. Dữ liệu phần STAGES PHẢI khớp functions/workflow.js
// (scripts/test-workflow.mjs sẽ báo lỗi nếu hai bản lệch nhau). Server luôn là nơi quyết định cuối cùng.
export const MAX_REWORK = 2;
export const INTAKE_STAGE_ID = 'SORT_1';
export const KG_EPSILON = 0.0005;

export const DEPARTMENTS = {
  PREPROCESS: 'Sơ chế',
  PROCESSING: 'Chế biến',
  FREEZE_PACK: 'Cấp đông & đóng gói'
};

export const PHASES = {
  A: 'Phân loại hàng hoá',
  B: 'Lấy má / Chế biến',
  C: 'Đóng gói / Đông lạnh'
};

const stage = (id, name, short, phase, departmentId, kind, next, lightTo = [], extra = {}) => ({
  id, name, short, phase, departmentId, kind, next, lightTo, rework: false, lightLabel: 'Hư nhẹ', ...extra
});

export const STAGES = {
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

export const STAGE_ORDER = Object.keys(STAGES);


export const round3 = (value) => Math.round(value * 1000) / 1000;

/** Suy ra bộ phận từ hồ sơ người dùng. */
export function resolveDepartmentId(user) {
  if (user?.departmentId) return user.departmentId;
  const department = String(user?.department || '').trim().toUpperCase();
  if (department.includes('SƠ CHẾ')) return 'PREPROCESS';
  if (department.includes('CHẾ BIẾN')) return 'PROCESSING';
  if (department.includes('CẤP ĐÔNG') || department.includes('ĐÓNG GÓI')) return 'FREEZE_PACK';
  return '';
}

export const isPrivileged = (role) => role === 'admin' || role === 'dev';

/** Admin/dev làm được mọi công đoạn; nhân viên chỉ làm công đoạn thuộc bộ phận của mình. */
export function canOperate(stageDef, { role, departmentId }) {
  return Boolean(stageDef) && (isPrivileged(role) || (Boolean(departmentId) && departmentId === stageDef.departmentId));
}

export const getLotStageId = (lot) => lot?.currentStage || lot?.pendingStageId || null;

export function getLotInputKg(lot) {
  const value = Number(lot?.currentKg ?? lot?.intake?.initialKg);
  return Number.isFinite(value) ? round3(value) : 0;
}

/** Các công đoạn nằm trên đường chính (không tính các bước ủ) để vẽ timeline tiến độ. */
export const PROGRESS_STAGE_IDS = STAGE_ORDER.filter((id) => STAGES[id].kind !== 'soak');

export const stageName = (id) => STAGES[id]?.name || id || '-';