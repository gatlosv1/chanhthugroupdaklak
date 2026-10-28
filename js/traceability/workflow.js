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

/** Các công đoạn đã bị bỏ: lô còn kẹt ở đó được xem như đang ở công đoạn thay thế. */
export const LEGACY_STAGE_MAP = {
  SORT_2: 'SORT_SOAK_1',
  SORT_3: 'SORT_SOAK_1',
  SORT_4: 'SORT_SOAK_1',
  SOAK_1_1: 'SOAK_1',
  SOAK_3: 'SOAK_2'
};
export const normalizeStageId = (id) => LEGACY_STAGE_MAP[id] || id || null;

/** Mã công đoạn cũ cần đọc cùng khi lấy hàng chờ của một công đoạn. */
export const legacyIdsOf = (stageId) => Object.keys(LEGACY_STAGE_MAP).filter((id) => LEGACY_STAGE_MAP[id] === stageId);

export const getLotStageId = (lot) => normalizeStageId(lot?.currentStage || lot?.pendingStageId || null);

export function getLotInputKg(lot) {
  const value = Number(lot?.currentKg ?? lot?.intake?.initialKg);
  return Number.isFinite(value) ? round3(value) : 0;
}

export const stageName = (id) => STAGES[normalizeStageId(id)]?.name || id || '-';