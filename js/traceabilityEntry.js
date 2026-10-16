import { db } from './firebase.js';
import { waitForAuth } from './auth.js';
import { ensureUserDocument } from './userService.js';
import { getUserProfile } from './firestore.js';
import { requirePageAccess } from './pageAccess.js';
import { resolveInitialRole, isPrivilegedRole } from './roleUtils.js';
import {
  collection,
  enableIndexedDbPersistence,
  limit,
  onSnapshot,
  orderBy,
  query
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

const FUNCTIONS_REGION = 'asia-southeast1';
const INTAKE_STAGE_ID = 'SORT_1';
const LIST_LIMIT = 200;
const CREATE_TIMEOUT_MS = 30000;
const TOAST_MS = { success: 4000, info: 4000, error: 8000 };
// Khớp với quy tắc kiểm tra ở Cloud Function createIncomingLot.
const LOT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,79}$/;

const createIncomingLot = httpsCallable(getFunctions(undefined, FUNCTIONS_REGION), 'createIncomingLot', {
  timeout: CREATE_TIMEOUT_MS
});
const deleteIncomingLot = httpsCallable(getFunctions(undefined, FUNCTIONS_REGION), 'deleteIncomingLot', {
  timeout: CREATE_TIMEOUT_MS
});

const $ = (id) => document.getElementById(id);

const elements = {
  connection: $('connectionStatus'),
  toastRegion: $('toastRegion'),
  department: $('departmentLabel'),
  operator: $('operatorLabel'),
  noAccessPanel: $('noAccessPanel'),
  noAccessMessage: $('noAccessMessage'),
  createPanel: $('createLotPanel'),
  form: $('createLotForm'),
  submit: $('createLotBtn'),
  reset: $('resetFormBtn'),
  listPanel: $('intakeListPanel'),
  rows: $('intakeRows'),
  count: $('intakeCount'),
  search: $('searchInput'),
  dateFilter: $('dateFilter'),
  clearFilter: $('clearFilterBtn'),
  refresh: $('refreshBtn'),
  emptyState: $('emptyState'),
  emptyTitle: $('emptyTitle'),
  emptyHint: $('emptyHint'),
  actionsHeader: $('actionsHeader')
};

const fields = {
  lotCode: { input: $('newLotCode'), error: $('newLotCodeError') },
  receivedDate: { input: $('newLotDate'), error: $('newLotDateError') },
  vehiclePlate: { input: $('newLotPlate'), error: $('newLotPlateError') },
  productType: { input: $('newLotProduct'), error: $('newLotProductError') },
  origin: { input: $('newLotOrigin'), error: $('newLotOriginError') },
  initialKg: { input: $('newLotKg'), error: $('newLotKgError') },
  note: { input: $('newLotNote'), error: null }
};

const state = {
  lots: [],
  canDelete: false,
  stopListening: null,
  submitting: false
};

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

function resolveDepartmentId(profile) {
  if (profile?.departmentId) return profile.departmentId;
  const department = String(profile?.department || '').trim().toUpperCase();
  if (department.includes('SƠ CHẾ')) return 'PREPROCESS';
  if (department.includes('CHẾ BIẾN')) return 'PROCESSING';
  if (department.includes('CẤP ĐÔNG') || department.includes('ĐÓNG GÓI')) return 'FREEZE_PACK';
  if (department.includes('KHO')) return 'COLD_STORAGE';
  return '';
}

/** Ngày hôm nay theo giờ máy, định dạng yyyy-mm-dd cho input[type=date]. */
function todayValue() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

function formatDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : '-';
}

function formatKg(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? number.toLocaleString('vi-VN', { maximumFractionDigits: 2 })
    : '-';
}

/** Bỏ dấu + chữ thường để tìm kiếm tiếng Việt không phân biệt dấu. */
function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function setHidden(element, hidden) {
  element.classList.toggle('is-hidden', hidden);
}

/* ------------------------------------------------------------------ */
/* Thông báo & trạng thái kết nối                                      */
/* ------------------------------------------------------------------ */

/** Hiện thông báo nổi và tự ẩn sau vài giây. type: success | error | info. */
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);

  const dismiss = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 300);
  };
  const timer = setTimeout(dismiss, TOAST_MS[type] || TOAST_MS.info);
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    dismiss();
  });
}

function setConnection(label, offline = false) {
  elements.connection.textContent = label;
  elements.connection.classList.toggle('connection--offline', offline);
}

/**
 * Chuyển lỗi kỹ thuật thành thông báo dễ hiểu, phân biệt:
 * mạng, quyền, dữ liệu không hợp lệ (từ Cloud Function) và lỗi hệ thống.
 */
function describeError(error, fallback) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  const serverMessage = String(error?.message || '').trim();

  if (!navigator.onLine || code === 'unavailable' || code === 'deadline-exceeded') {
    return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  }
  switch (code) {
    case 'unauthenticated':
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    case 'permission-denied':
      return 'Bạn không có quyền thực hiện thao tác này.';
    case 'already-exists':
    case 'invalid-argument':
    case 'failed-precondition':
      // Cloud Function đã trả sẵn thông báo tiếng Việt cụ thể.
      return serverMessage || fallback;
    case 'internal':
      return 'Hệ thống gặp lỗi hoặc đang bị chặn quyền gọi hàm. Thử lại sau hoặc báo quản trị viên.';
    default:
      return serverMessage && serverMessage !== 'internal' ? serverMessage : fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Form: chuẩn hóa & kiểm tra dữ liệu                                  */
/* ------------------------------------------------------------------ */

function clearFieldError(name) {
  const { input, error } = fields[name];
  input.removeAttribute('aria-invalid');
  if (error) error.textContent = '';
}

function setFieldError(name, message) {
  const { input, error } = fields[name];
  input.setAttribute('aria-invalid', 'true');
  if (error) error.textContent = message;
}

/** Ép chữ hoa khi gõ nhưng giữ nguyên vị trí con trỏ. */
function bindUppercase(input, { stripSpaces = false } = {}) {
  input.addEventListener('input', () => {
    const position = input.selectionStart;
    let value = input.value.toUpperCase();
    if (stripSpaces) value = value.replace(/\s+/g, '');
    if (value !== input.value) {
      const removed = input.value.length - value.length;
      input.value = value;
      input.setSelectionRange(Math.max(0, position - removed), Math.max(0, position - removed));
    }
  });
}

function readFormValues() {
  return {
    lotCode: fields.lotCode.input.value.trim().toUpperCase(),
    receivedDate: fields.receivedDate.input.value,
    vehiclePlate: fields.vehiclePlate.input.value.trim().toUpperCase(),
    productType: fields.productType.input.value.trim(),
    origin: fields.origin.input.value.trim(),
    initialKg: Number(fields.initialKg.input.value),
    note: fields.note.input.value.trim()
  };
}

/** Trả về object { tênTrường: thôngBáoLỗi }; rỗng nếu hợp lệ. */
function validate(values) {
  const errors = {};
  if (!values.lotCode) errors.lotCode = 'Nhập mã lô.';
  else if (!LOT_CODE_PATTERN.test(values.lotCode)) {
    errors.lotCode = 'Mã lô chỉ gồm chữ in hoa, số, dấu gạch ngang; dài 3–80 ký tự.';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.receivedDate)) errors.receivedDate = 'Chọn ngày nhập hàng.';
  else if (values.receivedDate > todayValue()) errors.receivedDate = 'Ngày nhập hàng không được ở tương lai.';

  if (!values.vehiclePlate) errors.vehiclePlate = 'Nhập biển số xe.';
  if (!values.productType) errors.productType = 'Nhập loại hàng.';
  if (!values.origin) errors.origin = 'Nhập vùng hoặc cửa khẩu nhập hàng.';

  if (!fields.initialKg.input.value.trim()) errors.initialKg = 'Nhập khối lượng.';
  else if (!Number.isFinite(values.initialKg) || values.initialKg <= 0) {
    errors.initialKg = 'Khối lượng phải lớn hơn 0.';
  }
  return errors;
}

function resetForm() {
  elements.form.reset();
  Object.keys(fields).forEach(clearFieldError);
  fields.receivedDate.input.value = todayValue();
}

function setSubmitting(submitting) {
  state.submitting = submitting;
  elements.submit.disabled = submitting;
  elements.reset.disabled = submitting;
  elements.submit.classList.toggle('is-loading', submitting);
  elements.submit.querySelector('.btn-label').textContent = submitting
    ? 'Đang tạo lô...'
    : 'Tạo lô và đưa vào Phân loại 1';
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;

  const values = readFormValues();
  const errors = validate(values);
  Object.keys(fields).forEach(clearFieldError);
  const invalidNames = Object.keys(errors);
  if (invalidNames.length) {
    invalidNames.forEach((name) => setFieldError(name, errors[name]));
    fields[invalidNames[0]].input.focus();
    showToast('Vui lòng kiểm tra lại các trường được đánh dấu.', 'error');
    return;
  }
  // Cloud Function không xếp hàng khi offline nên chặn sớm để người dùng biết.
  if (!navigator.onLine) {
    showToast('Đang ngoại tuyến. Cần có mạng để tạo lô mới.', 'error');
    return;
  }

  setSubmitting(true);
  try {
    const result = await createIncomingLot({ ...values, stageId: INTAKE_STAGE_ID });
    const lotCode = result.data?.lotCode || values.lotCode;
    resetForm();
    fields.lotCode.input.focus();
    showToast(`Đã tạo lô ${lotCode} và đưa vào hàng chờ Phân loại 1.`, 'success');
  } catch (error) {
    console.error('createIncomingLot failed:', error);
    const message = describeError(error, 'Không thể tạo lô. Vui lòng thử lại.');
    // Mã lô trùng là lỗi của riêng trường mã lô, đánh dấu để người dùng sửa nhanh.
    if (String(error?.code || '').endsWith('already-exists')) {
      setFieldError('lotCode', message);
      fields.lotCode.input.focus();
    }
    showToast(message, 'error');
  } finally {
    setSubmitting(false);
  }
}

/* ------------------------------------------------------------------ */
/* Danh sách lô nhập                                                   */
/* ------------------------------------------------------------------ */

function getFilteredLots() {
  const keyword = normalizeText(elements.search.value.trim());
  const date = elements.dateFilter.value;
  return state.lots.filter((lot) => {
    const intake = lot.intake || {};
    if (date && intake.receivedDate !== date) return false;
    if (!keyword) return true;
    const haystack = normalizeText([lot.lotCode, intake.vehiclePlate, intake.productType, intake.origin].join(' '));
    return haystack.includes(keyword);
  });
}

function renderList() {
  const lots = getFilteredLots();
  const hasFilter = Boolean(elements.search.value.trim() || elements.dateFilter.value);
  elements.count.textContent = hasFilter ? `${lots.length}/${state.lots.length}` : String(state.lots.length);
  elements.rows.replaceChildren();

  const isEmpty = lots.length === 0;
  setHidden(elements.emptyState, !isEmpty);
  elements.rows.closest('.table-wrap').classList.toggle('is-hidden', isEmpty);
  if (isEmpty) {
    elements.emptyTitle.textContent = hasFilter ? 'Không có lô phù hợp' : 'Chưa có lô nhập hàng nào';
    elements.emptyHint.textContent = hasFilter
      ? 'Thử đổi từ khóa hoặc bấm "Xóa lọc".'
      : 'Các lô bạn tạo sẽ xuất hiện tại đây ngay lập tức.';
    return;
  }

  const fragment = document.createDocumentFragment();
  lots.forEach((lot, index) => {
    const intake = lot.intake || {};
    const row = document.createElement('tr');
    [
      [index + 1],
      [lot.lotCode || lot.id],
      [formatDate(intake.receivedDate)],
      [intake.vehiclePlate || '-'],
      [intake.productType || '-'],
      [intake.origin || '-'],
      [formatKg(intake.initialKg), 'num']
    ].forEach(([text, className]) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (className) cell.className = className;
      row.append(cell);
    });
    if (state.canDelete) {
      const cell = document.createElement('td');
      cell.className = 'col-actions';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger-action';
      button.textContent = 'Xoá';
      button.setAttribute('aria-label', `Xoá lô ${lot.lotCode || lot.id}`);
      button.addEventListener('click', () => handleDelete(lot, button));
      cell.append(button);
      row.append(cell);
    }
    fragment.append(row);
  });
  elements.rows.append(fragment);
}

/** Xoá một lô (chỉ admin/dev). Danh sách tự cập nhật nhờ onSnapshot. */
async function handleDelete(lot, button) {
  const lotCode = lot.lotCode || lot.id;
  if (!navigator.onLine) {
    showToast('Đang ngoại tuyến. Cần có mạng để xoá lô.', 'error');
    return;
  }
  if (!window.confirm(`Xoá lô ${lotCode}?\nThao tác này không thể hoàn tác.`)) return;

  button.disabled = true;
  button.textContent = 'Đang xoá...';
  try {
    await deleteIncomingLot({ lotId: lot.id });
    showToast(`Đã xoá lô ${lotCode}.`, 'success');
  } catch (error) {
    console.error('deleteIncomingLot failed:', error);
    showToast(describeError(error, 'Không thể xoá lô. Vui lòng thử lại.'), 'error');
    button.disabled = false;
    button.textContent = 'Xoá';
  }
}

/** Hủy listener hiện tại (nếu có) để không bị rò rỉ hoặc nhân đôi. */
function stopListening() {
  if (state.stopListening) {
    state.stopListening();
    state.stopListening = null;
  }
}

function startListening() {
  stopListening();
  setRefreshing(true);
  const lotsQuery = query(collection(db, 'lots'), orderBy('createdAt', 'desc'), limit(LIST_LIMIT));
  state.stopListening = onSnapshot(
    lotsQuery,
    { includeMetadataChanges: true },
    (snapshot) => {
      // Dữ liệu từ cache khi máy offline nghĩa là chưa đồng bộ được với máy chủ.
      if (snapshot.metadata.fromCache && !navigator.onLine) setConnection('Đang ngoại tuyến', true);
      else setConnection('Đã kết nối');
      state.lots = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
      renderList();
      setRefreshing(false);
    },
    (error) => {
      console.error('Lots listener failed:', error);
      setConnection('Mất kết nối', true);
      setRefreshing(false);
      showToast(describeError(error, 'Không tải được danh sách nhập hàng.'), 'error');
    }
  );
}

function setRefreshing(refreshing) {
  elements.refresh.disabled = refreshing;
  elements.refresh.textContent = refreshing ? 'Đang tải...' : 'Làm mới';
}

function clearFilters() {
  elements.search.value = '';
  elements.dateFilter.value = '';
  renderList();
}

/* ------------------------------------------------------------------ */
/* Khởi tạo                                                            */
/* ------------------------------------------------------------------ */

function showNoAccess(message) {
  elements.noAccessMessage.textContent = message;
  setHidden(elements.noAccessPanel, false);
  setHidden(elements.createPanel, true);
  setHidden(elements.listPanel, true);
}

async function initialise() {
  try {
    await enableIndexedDbPersistence(db);
  } catch (error) {
    // Nhiều tab hoặc trình duyệt không hỗ trợ: vẫn chạy bình thường, chỉ mất chế độ offline.
    console.warn('Offline persistence is unavailable:', error.code || error);
  }

  const user = await waitForAuth();
  if (!user) {
    window.location.href = './login.html';
    return;
  }

  const profile = (await ensureUserDocument()) || (await getUserProfile(user.uid));
  const role = profile?.role || 'staff';
  const departmentId = resolveDepartmentId(profile);
  elements.operator.textContent = profile?.name || user.email || 'Nhân viên';
  elements.department.textContent = departmentId || (['admin', 'dev'].includes(role) ? 'Quản trị' : profile?.department || 'Chưa gán bộ phận');
  setConnection(navigator.onLine ? 'Đã kết nối' : 'Đang ngoại tuyến', !navigator.onLine);

  try {
    await requirePageAccess(user, 'traceability');
  } catch (error) {
    showNoAccess(error?.message || 'Tài khoản của bạn chưa được cấp quyền dùng trang này. Vui lòng liên hệ quản lý.');
    return;
  }
  setHidden(elements.createPanel, false);
  setHidden(elements.listPanel, false);
  state.canDelete = isPrivilegedRole(resolveInitialRole(user.email, profile?.role));
  setHidden(elements.actionsHeader, !state.canDelete);
  fields.receivedDate.input.value = todayValue();
  startListening();
}

/* ------------------------------------------------------------------ */
/* Sự kiện                                                             */
/* ------------------------------------------------------------------ */

bindUppercase(fields.lotCode.input, { stripSpaces: true });
bindUppercase(fields.vehiclePlate.input);
Object.keys(fields).forEach((name) => {
  fields[name].input.addEventListener('input', () => clearFieldError(name));
});

elements.form.addEventListener('submit', handleSubmit);
elements.reset.addEventListener('click', resetForm);
elements.refresh.addEventListener('click', startListening);
elements.clearFilter.addEventListener('click', clearFilters);
elements.search.addEventListener('input', renderList);
elements.dateFilter.addEventListener('input', renderList);

window.addEventListener('online', () => {
  setConnection('Đã kết nối');
  showToast('Đã có mạng trở lại.', 'info');
});
window.addEventListener('offline', () => setConnection('Đang ngoại tuyến', true));
window.addEventListener('pagehide', stopListening);

initialise().catch((error) => {
  console.error('Initialise failed:', error);
  setConnection('Lỗi khởi tạo', true);
  showToast(describeError(error, 'Không thể khởi tạo màn hình.'), 'error');
});
