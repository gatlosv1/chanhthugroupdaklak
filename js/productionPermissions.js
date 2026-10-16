// hàm xử lý kiểm tra người dùng đã xác thực.
export function isAuthenticatedUser(user) {
  return Boolean(user?.uid);
}
// Chỉ admin/dev được sửa ngày sản xuất.
export function canEditProductionDate(user, currentRole = 'staff') {
  return isAuthenticatedUser(user) && (currentRole === 'admin' || currentRole === 'dev');
}
// Staff được nhập/sửa dữ liệu dòng sản xuất; chỉ admin/dev được sửa ngày sản xuất và xóa dòng.
export function canEditProductionRows(user, currentRole = 'staff') {
  return isAuthenticatedUser(user) && (currentRole === 'staff' || currentRole === 'admin' || currentRole === 'dev');
}
// hàm kiểm tra quyền xóa dòng sản xuất.
export function canDeleteProductionRows(currentRole = 'staff') {
  return currentRole === 'admin' || currentRole === 'dev';
}




