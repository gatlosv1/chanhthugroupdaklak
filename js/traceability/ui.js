// Tiện ích giao diện dùng chung cho các trang truy xuất: toast, kết nối, định dạng, lỗi.

const TOAST_MS = { success: 4000, info: 4000, error: 8000 };

/** Hiện thông báo nổi trong #toastRegion và tự ẩn. type: success | error | info. */
export function showToast(message, type = 'success') {
  const region = document.getElementById('toastRegion');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  region.append(toast);

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

/** Cập nhật nhãn trạng thái kết nối ở góc phải thanh đầu trang. */
export function setConnection(label, offline = false) {
  const element = document.getElementById('connectionStatus');
  if (!element) return;
  element.textContent = label;
  element.classList.toggle('connection--offline', offline);
}

/** Theo dõi mạng; trả về hàm huỷ theo dõi. */
export function watchConnection() {
  const online = () => { setConnection('Đã kết nối'); showToast('Đã có mạng trở lại.', 'info'); };
  const offline = () => setConnection('Đang ngoại tuyến', true);
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  setConnection(navigator.onLine ? 'Đã kết nối' : 'Đang ngoại tuyến', !navigator.onLine);
  return () => {
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
  };
}

/** Chuyển lỗi Firebase/Cloud Function thành thông báo tiếng Việt dễ hiểu. */
export function describeError(error, fallback) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  const message = String(error?.message || '').trim();

  if (!navigator.onLine || code === 'unavailable' || code === 'deadline-exceeded') {
    return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  }
  switch (code) {
    case 'unauthenticated':
      return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    case 'permission-denied':
      return message && message !== 'permission-denied' ? message : 'Bạn không có quyền thực hiện thao tác này.';
    case 'invalid-argument':
    case 'failed-precondition':
    case 'aborted':
    case 'not-found':
      return message || fallback;
    case 'internal':
      return 'Hệ thống gặp lỗi. Thử lại sau hoặc báo quản trị viên.';
    default:
      return message && message !== 'internal' ? message : fallback;
  }
}

export function formatKg(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString('vi-VN', { maximumFractionDigits: 3 })
    : '-';
}

/** Chuyển Firestore Timestamp (hoặc Date/số) sang millisecond; 0 nếu không có. */
export function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function formatDateTime(value) {
  const millis = toMillis(value);
  return millis
    ? new Date(millis).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
    : '-';
}

/** Khoá ngày yyyy-mm-dd theo giờ Việt Nam, dùng để gom số liệu theo ngày. */
export function dayKey(value) {
  const millis = toMillis(value);
  return millis ? new Date(millis).toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
}

/** Tạo phần tử nhanh: el('div', 'class', { textContent }, [children]). */
export function el(tag, className = '', props = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, props);
  node.append(...children);
  return node;
}
