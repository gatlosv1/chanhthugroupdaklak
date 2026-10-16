import { getCurrentUser, watchAuthState } from './auth.js';
import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';
import { ensureDefaultSettings, listenToSettings, saveSettingsDocument, SETTING_KEYS } from './settings.js';
import { showToast } from './utils.js';
import { db } from './firebase.js';
import { doc, getDoc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { logActivity } from './activityLog.js';

const congTachMuiCatalogRef = doc(db, 'settings', 'congTachMuiCatalog');
let congTachMuiCatalog = { teams: [], processes: [], types: [], shifts: [] };
const nhapLieuSanXuatCatalogRef = doc(db, 'settings', 'nhapLieuSanXuatCatalog');
let nhapLieuSanXuatCatalog = { processes: [], types: [] };

const forms = {
  [SETTING_KEYS.nhaCungCap]: document.getElementById('nhaCungCapForm'),
  [SETTING_KEYS.vungNguyenLieu]: document.getElementById('vungNguyenLieuForm'),
  [SETTING_KEYS.loaiNguyenLieu]: document.getElementById('loaiNguyenLieuForm'),
  [SETTING_KEYS.loaiSanPham]: document.getElementById('loaiSanPhamForm')
};

const lists = {
  [SETTING_KEYS.nhaCungCap]: document.getElementById('nhaCungCapList'),
  [SETTING_KEYS.vungNguyenLieu]: document.getElementById('vungNguyenLieuList'),
  [SETTING_KEYS.loaiNguyenLieu]: document.getElementById('loaiNguyenLieuList'),
  [SETTING_KEYS.loaiSanPham]: document.getElementById('loaiSanPhamList')
};

let currentRole = 'staff';
let settingsState = {};
let stopSettingsListener = null;
let stopCongTachMuiCatalogListener = null;
let stopNhapLieuSanXuatCatalogListener = null;

// Hiển thị danh sách các mục trong catalog của Năng xuất tách múi trên giao diện.
function renderCongTachMuiCatalog() {
  const teamsList = document.getElementById('congTachMuiTeamsList');
  const processesList = document.getElementById('congTachMuiProcessesList');
  const typesList = document.getElementById('congTachMuiTypesList');
  const shiftsList = document.getElementById('congTachMuiShiftsList');
  if (!teamsList) return;
  const render = (container, values, formatter) => {
    container.replaceChildren(...(values.length ? values.map((value) => { const item = document.createElement('div'); item.className = 'list-group-item'; item.textContent = formatter(value); return item; }) : [Object.assign(document.createElement('div'), { className: 'list-group-item text-muted', textContent: 'Chưa có mục nào.' })]));
  };
  render(teamsList, congTachMuiCatalog.teams, (team) => `${team.id} - ${team.name}`);
  render(processesList, congTachMuiCatalog.processes, (value) => value);
  render(typesList, congTachMuiCatalog.types, (value) => value);
  render(shiftsList, congTachMuiCatalog.shifts, (shift) => `${shift.id} - ${shift.name}`);
}

// Lưu dữ liệu catalog Năng xuất tách múi xuống Firestore và ghi log hoạt động.
async function saveCongTachMuiCatalog() {
  await setDoc(congTachMuiCatalogRef, congTachMuiCatalog, { merge: true });
  logActivity({ action: 'save', page: 'settings', detail: 'Cập nhật danh mục Năng xuất tách múi' });
}

// Thiết lập listener và form để người dùng thêm dữ liệu cho catalog Năng xuất tách múi.
function setupCongTachMuiCatalog() {
  if (stopCongTachMuiCatalogListener) stopCongTachMuiCatalogListener();
  stopCongTachMuiCatalogListener = onSnapshot(congTachMuiCatalogRef, (snapshot) => {
    if (snapshot.exists()) congTachMuiCatalog = { ...congTachMuiCatalog, ...snapshot.data() };
    renderCongTachMuiCatalog();
  });
  document.getElementById('congTachMuiTeamsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const team = { id: String(data.get('id')).trim(), name: String(data.get('name')).trim() };
    if (congTachMuiCatalog.teams.some((item) => item.id === team.id)) { showToast('ID tổ đã tồn tại.', 'error'); return; }
    congTachMuiCatalog.teams.push(team); await saveCongTachMuiCatalog(); event.currentTarget.reset(); showToast('Đã thêm tổ Năng xuất tách múi.', 'success');
  });
  [['congTachMuiProcessesForm', 'processes'], ['congTachMuiTypesForm', 'types']].forEach(([formId, key]) => document.getElementById(formId)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value')).trim();
    if (congTachMuiCatalog[key].includes(value)) { showToast('Mục này đã tồn tại.', 'error'); return; }
    congTachMuiCatalog[key].push(value); await saveCongTachMuiCatalog(); event.currentTarget.reset(); showToast('Đã thêm mục Năng xuất tách múi.', 'success');
  }));
  document.getElementById('congTachMuiShiftsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const shift = { id: String(data.get('id')).trim(), name: String(data.get('name')).trim() };
    if (congTachMuiCatalog.shifts.some((item) => item.id === shift.id)) { showToast('Mã ca đã tồn tại.', 'error'); return; }
    congTachMuiCatalog.shifts.push(shift); await saveCongTachMuiCatalog(); event.currentTarget.reset(); showToast('Đã thêm ca Năng xuất tách múi.', 'success');
  });
  getDoc(congTachMuiCatalogRef).then((snapshot) => { if (!snapshot.exists()) saveCongTachMuiCatalog(); });
}

// Cập nhật ngày giờ thực tế hiển thị trong phần catalog Năng xuất tách múi.
function updateCongTachMuiRealtimeDate() {
  const target = document.getElementById('congTachMuiRealtimeDate');
  if (!target) return;
  target.value = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'full' }).format(new Date());
}

updateCongTachMuiRealtimeDate();
setInterval(updateCongTachMuiRealtimeDate, 1000);

// Hiển thị danh sách các mục trong catalog của Năng suất sản xuất trên giao diện.
function renderNhapLieuSanXuatCatalog() {
  const processesList = document.getElementById('nhapLieuSanXuatProcessesList');
  const typesList = document.getElementById('nhapLieuSanXuatTypesList');
  if (!processesList) return;
  const render = (container, values, formatter) => {
    container.replaceChildren(...(values.length ? values.map((value) => { const item = document.createElement('div'); item.className = 'list-group-item'; item.textContent = formatter(value); return item; }) : [Object.assign(document.createElement('div'), { className: 'list-group-item text-muted', textContent: 'Chưa có mục nào.' })]));
  };
  render(processesList, nhapLieuSanXuatCatalog.processes, (value) => value);
  render(typesList, nhapLieuSanXuatCatalog.types, (value) => value);
}

// Lưu dữ liệu catalog Năng suất sản xuất xuống Firestore và ghi log hoạt động.
async function saveNhapLieuSanXuatCatalog() {
  await setDoc(nhapLieuSanXuatCatalogRef, nhapLieuSanXuatCatalog, { merge: true });
  logActivity({ action: 'save', page: 'settings', detail: 'Cập nhật danh mục Năng suất sản xuất' });
}

// Thiết lập listener và form để người dùng thêm dữ liệu cho catalog Năng suất sản xuất.
function setupNhapLieuSanXuatCatalog() {
  if (stopNhapLieuSanXuatCatalogListener) stopNhapLieuSanXuatCatalogListener();
  stopNhapLieuSanXuatCatalogListener = onSnapshot(nhapLieuSanXuatCatalogRef, (snapshot) => {
    if (snapshot.exists()) nhapLieuSanXuatCatalog = { ...nhapLieuSanXuatCatalog, ...snapshot.data() };
    renderNhapLieuSanXuatCatalog();
  });
  [['nhapLieuSanXuatProcessesForm', 'processes'], ['nhapLieuSanXuatTypesForm', 'types']].forEach(([formId, key]) => document.getElementById(formId)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value')).trim();
    if (nhapLieuSanXuatCatalog[key].includes(value)) { showToast('Mục này đã tồn tại.', 'error'); return; }
    nhapLieuSanXuatCatalog[key].push(value); await saveNhapLieuSanXuatCatalog(); event.currentTarget.reset(); showToast('Đã thêm mục Năng suất sản xuất.', 'success');
  }));
  getDoc(nhapLieuSanXuatCatalogRef).then((snapshot) => { if (!snapshot.exists()) saveNhapLieuSanXuatCatalog(); });
}
// Hiển thị danh sách mục của một nhóm danh mục với nút sửa/xóa.
function renderList(key, items) {
  const container = lists[key];
  if (!container) return;
  if (!items.length) {
    const emptyMessage = document.createElement('div');
    emptyMessage.className = 'text-muted';
    emptyMessage.textContent = 'Chưa có mục nào.';
    container.replaceChildren(emptyMessage);
    return;
  }

  const rows = items.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'list-group-item d-flex justify-content-between align-items-center flex-wrap gap-2';

    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'fw-semibold';
    name.textContent = `${item.ma || '-'} - ${item.ten || '-'}`;
    const position = document.createElement('div');
    position.className = 'small text-muted';
    position.textContent = `#${index + 1}`;
    details.append(name, position);

    const actions = document.createElement('div');
    actions.className = 'd-flex gap-2';
    const editButton = document.createElement('button');
    editButton.className = 'btn btn-outline-primary btn-sm';
    editButton.type = 'button';
    editButton.dataset.action = 'edit';
    editButton.dataset.key = key;
    editButton.dataset.index = index;
    editButton.textContent = 'Sửa';
    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn btn-outline-danger btn-sm';
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete';
    deleteButton.dataset.key = key;
    deleteButton.dataset.index = index;
    deleteButton.textContent = 'Xóa';
    actions.append(editButton, deleteButton);

    row.append(details, actions);
    return row;
  });
  container.replaceChildren(...rows);
}
// Hiển thị lại tất cả các nhóm danh mục đang có trong settingsState.
function renderAll() {
  Object.entries(lists).forEach(([key, container]) => {
    renderList(key, settingsState[key] || []);
  });
}
// Thiết lập trạng thái truy cập theo quyền admin hoặc không admin.
function setAccess(isAdmin) {
  if (!isAdmin) {
    const accessPage = document.createElement('div');
    accessPage.className = 'min-vh-100 d-flex align-items-center justify-content-center bg-light';
    const content = document.createElement('div');
    content.className = 'text-center p-4';
    const title = document.createElement('h2');
    title.className = 'h4 fw-bold mb-2';
    title.textContent = 'Không có quyền truy cập';
    const message = document.createElement('p');
    message.className = 'text-muted mb-3';
    message.textContent = 'Chỉ admin mới được phép quản lý danh mục.';
    const dashboardLink = document.createElement('a');
    dashboardLink.href = './dashboard.html';
    dashboardLink.className = 'btn btn-primary';
    dashboardLink.textContent = 'Quay về Dashboard';
    content.append(title, message, dashboardLink);
    accessPage.appendChild(content);
    document.body.replaceChildren(accessPage);
    return;
  }

  Object.values(forms).forEach((form) => form?.classList.remove('d-none'));
  Object.values(lists).forEach((container) => container?.classList.remove('opacity-50'));
}
// Xử lý khi người dùng submit form thêm mới mục vào danh mục.
async function handleSubmit(key, event) {
  event.preventDefault();
  if (currentRole !== 'admin') {
    showToast('Bạn không có quyền chỉnh sửa danh mục.', 'error');
    return;
  }
  const form = forms[key];
  const data = new FormData(form);
  const ma = String(data.get('ma') || '').trim();
  const ten = String(data.get('ten') || '').trim();
  if (!ma || !ten) {
    showToast('Vui lòng nhập mã và tên.', 'error');
    return;
  }

  const items = [...(settingsState[key] || []), { ma, ten }];
  const saved = await saveSettingsDocument(key, items);
  if (!saved) {
    showToast('Không thể lưu vào Firebase. Vui lòng kiểm tra quyền truy cập.', 'error');
    return;
  }
  form.reset();
  logActivity({ action: 'save', page: 'settings', detail: `Thêm mục danh mục ${key}` });
  showToast('Đã thêm mục mới.', 'success');
}
// Xóa một mục trong danh mục đang chọn nếu người dùng có quyền.
async function handleDelete(key, index) {
  if (currentRole !== 'admin') {
    showToast('Bạn không có quyền chỉnh sửa danh mục.', 'error');
    return;
  }
  const items = [...(settingsState[key] || [])];
  items.splice(index, 1);
  const saved = await saveSettingsDocument(key, items);
  if (!saved) {
    showToast('Không thể lưu vào Firebase. Vui lòng kiểm tra quyền truy cập.', 'error');
    return;
  }
  showToast('Đã xóa mục.', 'success');
  logActivity({ action: 'delete', page: 'settings', detail: `Xóa mục danh mục ${key}` });
}
// Chỉnh sửa mã và tên của một mục trong danh mục đã chọn.
async function handleEdit(key, index) {
  if (currentRole !== 'admin') {
    showToast('Bạn không có quyền chỉnh sửa danh mục.', 'error');
    return;
  }
  const items = [...(settingsState[key] || [])];
  const item = items[index];
  const ma = window.prompt('Nhập mã mới', item?.ma || '');
  if (ma === null) return;
  const ten = window.prompt('Nhập tên mới', item?.ten || '');
  if (ten === null) return;
  items[index] = { ma: ma.trim(), ten: ten.trim() };
  const saved = await saveSettingsDocument(key, items);
  if (!saved) {
    showToast('Không thể lưu vào Firebase. Vui lòng kiểm tra quyền truy cập.', 'error');
    return;
  }
  showToast('Đã cập nhật mục.', 'success');
  logActivity({ action: 'edit', page: 'settings', detail: `Sửa mục danh mục ${key}` });
}
// Khởi tạo luồng chính của trang cài đặt: load dữ liệu, bind form và kiểm tra quyền truy cập.
async function initialize() {
  await ensureDefaultSettings();
  stopSettingsListener = listenToSettings((state) => {
    settingsState = state;
    renderAll();
  });

  Object.entries(forms).forEach(([key, form]) => {
    form?.addEventListener('submit', (event) => handleSubmit(key, event));
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, key, index } = button.dataset;
    if (action === 'delete') handleDelete(key, Number(index));
    if (action === 'edit') handleEdit(key, Number(index));
  });

  watchAuthState(async (user) => {
    if (!user) {
      currentRole = 'staff';
      setAccess(false);
      return;
    }

    const profile = await getUserProfile(user.uid);
    currentRole = resolveInitialRole(user.email, profile?.role);
    const canManageSettings = currentRole === 'admin' || currentRole === 'dev';
    setAccess(canManageSettings);
    if (canManageSettings) setupCongTachMuiCatalog();
    if (canManageSettings) setupNhapLieuSanXuatCatalog();

    if (!user) {
      showToast('Vui lòng đăng nhập để dữ liệu được lưu vào Firebase.', 'info');
    }
  });
}

initialize();




