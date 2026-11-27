import { getCurrentUser, waitForAuth } from './auth.js';
import { requirePageAccess } from './pageAccess.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const STORAGE_KEY = document.body.dataset.storageKey;
const CREATE_TIMEOUT_MS = 30000;
const LOT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,79}$/;
const createIncomingLot = httpsCallable(getFunctions(undefined, 'asia-southeast1'), 'createIncomingLot', {
  timeout: CREATE_TIMEOUT_MS
});

const elements = {
  save: document.getElementById('saveBtn'),
  product: document.getElementById('traceabilityProduct'),
  origin: document.getElementById('traceabilityOrigin'),
  lotCode: document.getElementById('traceabilityLotCode'),
  lotId: document.getElementById('traceabilityLotId'),
  linkedAt: document.getElementById('traceabilityLinkedAt'),
  status: document.getElementById('traceabilitySyncStatus')
};

let submitting = false;

function setStatus(message, type = 'info') {
  elements.status.textContent = message;
  elements.status.className = `mt-3 text-sm ${
    type === 'success' ? 'text-emerald-700' : type === 'error' ? 'text-red-700' : 'text-slate-600'
  }`;
}

function readSavedWeighing() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('Chưa có phiếu cân đã lưu.');
  return JSON.parse(raw);
}

function getTotalKg(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return rows.reduce((total, row) => {
    if (!Array.isArray(row.weights)) throw new Error('Dữ liệu khối lượng trong phiếu cân không hợp lệ.');
    return total + row.weights.reduce((rowTotal, weight) => {
      const value = Number(weight);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('Dữ liệu khối lượng trong phiếu cân không hợp lệ.');
      }
      return rowTotal + value;
    }, 0);
  }, 0);
}

function createLotCode(receivedDate) {
  const datePart = receivedDate.replace(/-/g, '');
  const uniquePart = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  return `XM-${datePart}-${uniquePart}`;
}

function todayValue() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function persistWeighing(payload) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

async function syncSavedWeighing() {
  const user = getCurrentUser() || await waitForAuth();
  if (!user) {
    setStatus('Đăng nhập để tạo lô đầu vào trong Truy xuất xoài đông lạnh.', 'error');
    return;
  }
  try {
    await requirePageAccess(user, 'traceability');
  } catch (error) {
    console.error('Traceability access check failed:', error);
    setStatus(error?.message || 'Tài khoản không có quyền Truy xuất xoài đông lạnh.', 'error');
    return;
  }

  let payload;
  try {
    payload = readSavedWeighing();
  } catch (error) {
    console.error('Could not read saved mango weighing:', error);
    setStatus(error.message || 'Không đọc được phiếu cân đã lưu.', 'error');
    return;
  }

  if (payload.traceabilityLotId) {
    setStatus(`Phiếu này đã liên kết với lô ${payload.traceabilityLotCode}. Không tạo lô trùng.`, 'success');
    return;
  }

  const receivedDate = String(payload.dateTime || '').slice(0, 10);
  const vehiclePlate = String(payload.plateNumber || '').trim().toUpperCase();
  const productType = elements.product.value.trim();
  const origin = elements.origin.value.trim();
  let initialKg;
  try {
    initialKg = getTotalKg(payload.rows);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) {
    setStatus('Ngày cân không hợp lệ. Kiểm tra ngày trên phiếu cân.', 'error');
    return;
  }
  if (receivedDate > todayValue()) {
    setStatus('Ngày cân không được ở tương lai.', 'error');
    return;
  }
  if (!vehiclePlate) {
    setStatus('Nhập biển số xe trên phiếu cân trước khi tạo lô.', 'error');
    return;
  }
  if (!productType || !origin) {
    setStatus('Nhập loại xoài và vùng / cửa khẩu nhập hàng trước khi tạo lô.', 'error');
    return;
  }
  if (initialKg <= 0) {
    setStatus('Tổng khối lượng đã cân phải lớn hơn 0.', 'error');
    return;
  }

  const lotCode = payload.traceabilityLotCode || createLotCode(receivedDate);
  if (!LOT_CODE_PATTERN.test(lotCode)) {
    setStatus('Mã lô truy xuất không hợp lệ.', 'error');
    return;
  }

  payload.traceabilityLotCode = lotCode;
  elements.lotCode.value = lotCode;
  try {
    persistWeighing(payload);
  } catch (error) {
    console.error('Could not save generated traceability lot code:', error);
    setStatus('Không lưu được mã lô truy xuất trên thiết bị. Kiểm tra dung lượng trình duyệt rồi thử lại.', 'error');
    return;
  }

  setStatus(`Đang tạo lô ${lotCode} với tổng cân ${initialKg.toLocaleString('vi-VN')} kg...`);
  try {
    const result = await createIncomingLot({
      lotCode,
      receivedDate,
      vehiclePlate,
      productType,
      origin,
      initialKg,
      note: 'Tạo từ phiếu Cân xoài xuống xe',
      stageId: 'SORT_1'
    });
    const lotId = result.data?.lotId;
    if (!lotId) throw new Error('Máy chủ không trả về mã lô truy xuất.');

    payload.traceabilityLotId = lotId;
    payload.traceabilityLinkedAt = new Date().toISOString();
    elements.lotId.value = lotId;
    elements.linkedAt.value = payload.traceabilityLinkedAt;
    persistWeighing(payload);
    setStatus(`Đã tạo lô ${result.data.lotCode || lotCode} (${initialKg.toLocaleString('vi-VN')} kg) và đưa vào Phân loại xuống xe.`, 'success');
  } catch (error) {
    console.error('Could not create traceability lot from saved weighing:', error);
    const message = String(error?.message || '');
    setStatus(message || 'Không tạo được lô truy xuất. Số cân vẫn đã lưu trên trang này; thử lại sau khi kiểm tra kết nối.', 'error');
  }
}

async function initialise() {
  try {
    const user = getCurrentUser() || await waitForAuth();
    if (!user) {
      setStatus('Cần đăng nhập và có quyền Truy xuất xoài đông lạnh để tạo lô.', 'error');
      return;
    }
    await requirePageAccess(user, 'traceability');
    if (elements.lotId.value) {
      setStatus(`Phiếu này đã liên kết với lô ${elements.lotCode.value}.`, 'success');
    } else {
      setStatus('Sẵn sàng tạo lô đầu vào khi lưu phiếu cân.');
    }
  } catch (error) {
    console.error('Could not initialise mango traceability link:', error);
    setStatus(error?.message || 'Không thể xác nhận quyền Truy xuất xoài đông lạnh.', 'error');
  }
}

document.addEventListener('weighing-saved', () => {
  if (submitting) return;
  submitting = true;
  elements.save.disabled = true;
  syncSavedWeighing().catch((error) => {
    console.error('Mango weighing sync failed:', error);
    setStatus('Có lỗi khi gửi số cân sang Truy xuất xoài đông lạnh. Kiểm tra kết nối rồi thử lại.', 'error');
  }).finally(() => {
    submitting = false;
    elements.save.disabled = false;
  });
});

initialise();
