// Danh sách email cố định gán quyền dev
const DEV_EMAILS = ['gatlosv1@gmail.com'];
// Danh sách email cố định gán quyền admin
const ADMIN_EMAILS = ['admin@company.com', 'admin2@company.com', 'admin@example.com'];

// Chuẩn hóa chuỗi vai trò về 3 loại
// dev, admin hoặc staff
export function normalizeUserRole(role = '') {
  const normalizedRole = (role || '').trim().toLowerCase();
  if (normalizedRole === 'dev') return 'dev';
  if (normalizedRole === 'admin') return 'admin';
  return 'staff';
}

// Kiểm tra email có thuộc nhóm dev không
// So khớp danh sách cố định hoặc chứa chữ dev
export function isDevLikeEmail(email = '') {
  const normalizedEmail = (email || '').trim().toLowerCase();
  return DEV_EMAILS.includes(normalizedEmail) || normalizedEmail.startsWith('dev') || normalizedEmail.includes('dev');
}

// Kiểm tra email có thuộc nhóm admin không
// So khớp danh sách cố định hoặc chứa chữ admin
export function isAdminLikeEmail(email = '') {
  const normalizedEmail = (email || '').trim().toLowerCase();
  return (
    ADMIN_EMAILS.includes(normalizedEmail) ||
    normalizedEmail.startsWith('admin') ||
    normalizedEmail.includes('admin')
  );
}

// Kiểm tra vai trò có phải quyền cao không
// Admin và dev được xem là quyền cao
export function isPrivilegedRole(role = '') {
  const normalizedRole = normalizeUserRole(role);
  return normalizedRole === 'admin' || normalizedRole === 'dev';
}

// Xác định vai trò ban đầu của người dùng
// Ưu tiên email cố định trước vai trò lưu sẵn
export function resolveInitialRole(email, existingRole = '') {
  const normalizedExistingRole = normalizeUserRole(existingRole);
  const fixedDevEmail = isDevLikeEmail(email);
  const fixedAdminEmail = isAdminLikeEmail(email);

  // Email dev cố định luôn được ưu tiên cao nhất
  if (fixedDevEmail || normalizedExistingRole === 'dev') {
    return 'dev';
  }

  // Sau đó mới xét đến email admin cố định
  if (fixedAdminEmail || normalizedExistingRole === 'admin') {
    return 'admin';
  }

  // Nếu không khớp gì thì mặc định là staff
  if (normalizedExistingRole === 'staff') {
    return 'staff';
  }

  return 'staff';
}



