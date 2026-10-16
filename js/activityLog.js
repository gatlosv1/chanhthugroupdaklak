import { getCurrentUser, waitForAuth } from './auth.js';
import { rtdb } from './firebase.js';
import { push, ref, set } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js';

// Giới hạn độ dài mô tả log
const MAX_DETAIL_LENGTH = 120;
// Danh sách hành động hợp lệ
const VALID_ACTIONS = new Set(['add', 'edit', 'delete', 'login', 'logout', 'export', 'import', 'save', 'load']);
// Danh sách trang hợp lệ
const VALID_PAGES = new Set(['congTachMui', 'production', 'nhapLieuSanXuat', 'report', 'settings', 'auth', 'dashboard', 'profile', 'history', 'label']);

// Chuyển timestamp sang ngày giờ Việt Nam
function vietnamDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

// Ghi lại một hành động của người dùng
// Lưu vào Realtime Database theo ngày
export function logActivity({ action, page, detail = '', changes = null }) {
  const user = getCurrentUser();
  if (!user || !rtdb || !VALID_ACTIONS.has(action) || !VALID_PAGES.has(page)) return;

  const now = Date.now();
  const dateParts = vietnamDate(now);
  const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const description = String(detail).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
  const logRef = push(ref(rtdb, `logs/${date}`));
  const payload = {
    t: now,
    u: user.uid,
    n: String(user.displayName || user.email || 'Người dùng').slice(0, 80),
    a: action,
    p: page,
    d: description,
    c: changes && typeof changes === 'object' && Object.keys(changes).length ? changes : null
  };

  void set(logRef, payload).catch(() => {});
}

// Lấy chuỗi ngày hiện tại theo giờ Việt Nam
export function getVietnamDate(timestamp = Date.now()) {
  const parts = vietnamDate(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Ghi log khi người dùng tải một trang
export function logPageLoad(page) {
  return waitForAuth().then((user) => {
    if (!user) return;
    logActivity({ action: 'load', page, detail: 'Tải trang' });
  }).catch(() => {});
}

// Ánh xạ tên file trang sang mã trang
const pageByPath = {
  'dashboard.html': 'dashboard',
  'production.html': 'production',
  'nhap-lieu-san-xuat.html': 'nhapLieuSanXuat',
  'report.html': 'report',
  'cong-tach-mui.html': 'congTachMui',
  'settings.html': 'settings',
  'profile.html': 'profile',
  'history.html': 'history',
  'label.html': 'label'
};
// Tự động ghi log khi trang hiện tại tải xong
const currentPage = pageByPath[window.location.pathname.split('/').pop()];
if (currentPage) void logPageLoad(currentPage);
