import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';
import { db } from './firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let permissionWarningShown = false;

// Danh sách trang mặc định được bật
// Dùng khi chưa có cấu hình riêng
export const DEFAULT_PAGE_ACCESS = {
  dashboard: true,
  profile: true,
  label: true,
  labelTrang: true,
  phieuCanTay: true,
  production: true,
  nhapLieuSanXuat: true,
  report: true,
  congTachMui: true,
  traceability: true,
  settings: true,
  history: true,
  devManager: true
};

const DEFAULT_ROLE_PAGE_PERMISSIONS = {
  dev: ['dashboard', 'profile', 'label', 'labelTrang', 'phieuCanTay', 'production', 'nhapLieuSanXuat', 'report', 'congTachMui', 'traceability', 'settings', 'history', 'devManager'],
  admin: ['dashboard', 'profile', 'label', 'labelTrang', 'phieuCanTay', 'production', 'nhapLieuSanXuat', 'report', 'congTachMui', 'traceability', 'settings', 'history'],
  staff: ['dashboard', 'profile', 'label', 'labelTrang', 'phieuCanTay', 'production', 'nhapLieuSanXuat', 'report', 'congTachMui', 'traceability', 'history']
};

export function getDefaultPagePermissionsForRole(role = 'staff') {
  const normalizedRole = role === 'dev' ? 'dev' : role === 'admin' ? 'admin' : 'staff';
  return [...(DEFAULT_ROLE_PAGE_PERMISSIONS[normalizedRole] || DEFAULT_ROLE_PAGE_PERMISSIONS.staff)];
}

// Lấy cấu hình bật tắt trang từ Firestore
// Nếu lỗi thì trả về cấu hình mặc định
export async function getPageAccessConfig() {
  try {
    const ref = doc(db, 'settings', 'pageAccessControl');
    const snapshot = await getDoc(ref);
    const config = snapshot.exists() ? (snapshot.data() || {}) : {};
    return {
      ...DEFAULT_PAGE_ACCESS,
      ...(config.pages || {})
    };
  } catch (error) {
    console.warn('[PageAccess] fallback to default config', error);
    return { ...DEFAULT_PAGE_ACCESS };
  }
}

// Kiểm tra một trang có đang được bật không
export async function isPageEnabled(pageKey) {
  const config = await getPageAccessConfig();
  return config[pageKey] !== false;
}

// Hiển thị cảnh báo không đủ quyền truy cập
// Chỉ hiện một lần, tránh lặp nhiều bảng
export function showPermissionWarning({
  title = 'Missing or insufficient permissions.',
  buttonText = 'Back to dashboard',
  redirectTo = './dashboard.html'
} = {}) {
  if (permissionWarningShown) return;

  const wrapper = document.querySelector('main');
  if (!wrapper) return;

  const existing = wrapper.querySelector('.permission-warning-panel');
  if (existing) {
    permissionWarningShown = true;
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'permission-warning-panel';
  panel.innerHTML = `
    <div class="permission-warning-title">${title}</div>
    <button class="permission-warning-button" type="button">${buttonText}</button>
  `;

  panel.querySelector('button').addEventListener('click', () => {
    window.location.href = redirectTo;
  });

  wrapper.insertBefore(panel, wrapper.firstChild);
  permissionWarningShown = true;
}

// Kiểm tra quyền vào trang trước khi hiển thị
// Chặn nếu trang bị developer tắt
export async function requirePageAccess(user, pageKey) {
  if (!user) {
    return { profile: {}, role: 'staff' };
  }

  const profile = await getUserProfile(user.uid);
  const role = resolveInitialRole(user.email, profile?.role);
  const config = await getPageAccessConfig();

  if (config[pageKey] === false) {
    showPermissionWarning({ title: 'Trang này đã bị tắt bởi developer.' });
    throw new Error('Trang này đang bị khóa bởi developer.');
  }

  // Admin và dev luôn được vào mọi trang
  if (role === 'dev' || role === 'admin') {
    return { profile, role };
  }

  // Staff chỉ vào được trang có trong danh sách quyền.
  // Nếu profile cũ hoặc chưa có pagePermissions thì dùng quyền mặc định theo vai trò.
  const permissions = Array.isArray(profile?.pagePermissions) && profile.pagePermissions.length
    ? profile.pagePermissions
    : getDefaultPagePermissionsForRole(role);

  if (!permissions.includes(pageKey)) {
    showPermissionWarning();
    throw new Error('Bạn không có quyền truy cập trang này.');
  }

  return { profile, role };
}
