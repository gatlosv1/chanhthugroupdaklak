// Hiển thị lớp phủ loading che toàn màn hình.
export function showLoading() {
  const existingOverlay = document.getElementById('loadingOverlay');
  if (existingOverlay) return;

  const overlay = document.createElement('div');
  overlay.id = 'loadingOverlay';
  overlay.className = 'loading-overlay';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  overlay.appendChild(spinner);
  document.body.appendChild(overlay);
}
// Ẩn lớp phủ loading nếu lớp phủ đang được hiển thị.
export function hideLoading() {
  const overlays = document.querySelectorAll('#loadingOverlay');
  overlays.forEach((overlay) => overlay.remove());
}
// Hiển thị thông báo dạng toast ở góc màn hình.
export function showToast(message, type = 'info') {
  const stack = document.getElementById('toastStack') || createToastStack();
  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.textContent = message;
  stack.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3200);
}
// Tạo vùng chứa các toast nếu chưa tồn tại.
function createToastStack() {
  const stack = document.createElement('div');
  stack.id = 'toastStack';
  stack.className = 'toast-stack';
  document.body.appendChild(stack);
  return stack;
}
// Trả về tên tệp của trang hiện tại trong URL.
export function getCurrentPageName() {
  return window.location.pathname.split('/').pop() || 'index.html';
}



