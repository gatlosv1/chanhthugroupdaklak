import { db } from './firebase.js';
import { waitForAuth } from './auth.js';
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const SETTINGS_COLLECTION = 'settings';
// Định nghĩa các nhóm cài đặt dùng chung cho các trang cần danh mục và tùy chọn.
export const SETTING_KEYS = {
  nhaCungCap: 'nhaCungCap',
  vungNguyenLieu: 'vungNguyenLieu',
  loaiNguyenLieu: 'loaiNguyenLieu',
  loaiSanPham: 'loaiSanPham'
};
// Giá trị mặc định ban đầu cho từng nhóm cài đặt, nhằm giữ UI luôn có dữ liệu khi Firestore chưa được khởi tạo.
const DEFAULT_SETTINGS = {
  [SETTING_KEYS.nhaCungCap]: [
    { ma: '001', ten: 'Công ty A' },
    { ma: '002', ten: 'Công ty B' },
    { ma: '009', ten: 'CTBT' }
  ],
  [SETTING_KEYS.vungNguyenLieu]: [
    { ma: 'DN', ten: 'Đắk Nông' },
    { ma: 'DL', ten: 'Đắk Lắk' }
  ],
  [SETTING_KEYS.loaiNguyenLieu]: [
    { ma: 'M', ten: 'Múi' },
    { ma: 'TA', ten: 'Trái' },
    { ma: 'K', ten: 'Kem' }
  ],
  [SETTING_KEYS.loaiSanPham]: [
    { ma: 'RI', ten: 'RI' },
    { ma: 'DO', ten: 'DO' }
  ]
};
// Chuẩn hóa danh sách mục cài đặt để dữ liệu luôn có cấu trúc nhất quán trước khi được dùng trong UI hoặc lưu xuống Firestore.
function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ma: String(item.ma ?? '').trim(),
      ten: String(item.ten ?? '').trim()
    }))
    .filter((item) => item.ma || item.ten);
}
// Tạo tham chiếu đến tài liệu cài đặt tương ứng trong Firestore dựa trên tên nhóm.
function buildDocRef(key) {
  return doc(db, SETTINGS_COLLECTION, key);
}
// Thông báo cho các thành phần khác biết rằng danh mục đã thay đổi, để UI có thể cập nhật mà không cần tải lại toàn bộ trang.
function notifySettingsChanged(key = null) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem('catalog-sync', JSON.stringify({ key, ts: Date.now() }));
  } catch (error) {
    console.warn('[Settings] localStorage sync notification failed', error);
  }

  window.dispatchEvent(new CustomEvent('catalog-updated', { detail: { key } }));
}
// Tạo trạng thái cài đặt ban đầu từ các giá trị mặc định để UI luôn có dữ liệu sẵn khi chưa có bản ghi nào trong Firestore.
function getDefaultSettingsState() {
  return Object.fromEntries(
    Object.values(SETTING_KEYS).map((key) => [key, normalizeItems(DEFAULT_SETTINGS[key])])
  );
}
// Chuẩn hóa trạng thái cài đặt hiện có bằng cách thay thế dữ liệu không hợp lệ bằng giá trị mặc định.
function normalizeSettingsState(state = {}) {
  return Object.fromEntries(
    Object.values(SETTING_KEYS).map((key) => [key, normalizeItems(state?.[key] ?? DEFAULT_SETTINGS[key])])
  );
}
// Đảm bảo mỗi nhóm cài đặt đều tồn tại trong Firestore; nếu chưa có, tạo bản ghi mặc định để tránh lỗi khi mở trang.
export async function ensureDefaultSettings() {
  const authUser = await waitForAuth();
  if (!authUser) {
    console.warn('[Settings] skipped default setup because no authenticated user is available');
    return getDefaultSettingsState();
  }

  const keys = Object.values(SETTING_KEYS);
  for (const key of keys) {
    const ref = buildDocRef(key);
    try {
      console.log('[Firestore] getDoc', ref.path);
      const snapshot = await getDoc(ref);
      if (!snapshot.exists()) {
        const defaultItems = normalizeItems(DEFAULT_SETTINGS[key]);
        console.log('[Firestore] setDoc', ref.path);
        await setDoc(ref, { danhSach: defaultItems }, { merge: true });
        notifySettingsChanged(key);
      }
    } catch (error) {
      console.warn(`[Settings] fallback used for ${ref.path}`, error);
      try {
        await setDoc(ref, { danhSach: normalizeItems(DEFAULT_SETTINGS[key]) }, { merge: true });
      } catch (createError) {
        console.warn(`[Settings] create fallback failed for ${ref.path}`, createError);
      }
    }
  }

  return getDefaultSettingsState();
}
// Lắng nghe thay đổi dữ liệu cài đặt trong Firestore và cập nhật trạng thái cho các thành phần đang dùng danh mục.
export function listenToSettings(callback) {
  const keys = Object.values(SETTING_KEYS);
  const unsubscribes = [];
  const state = getDefaultSettingsState();

  callback(normalizeSettingsState(state));

  keys.forEach((key) => {
    const ref = buildDocRef(key);
    const unsubscribe = onSnapshot(ref, (snapshot) => {
      const rawItems = snapshot.exists() ? snapshot.data()?.danhSach : null;
      state[key] = normalizeItems(rawItems ?? DEFAULT_SETTINGS[key]);
      callback(normalizeSettingsState(state));
    }, (error) => {
      console.error('[Firestore] onSnapshot failed', error);
      state[key] = normalizeItems(DEFAULT_SETTINGS[key]);
      callback(normalizeSettingsState(state));
    });
    unsubscribes.push(unsubscribe);
  });

  return () => {
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}
// Trả về danh sách mục cho một nhóm cài đặt cụ thể; nếu chưa có dữ liệu từ Firestore thì dùng giá trị mặc định.
export function getSettingOptions(settingsState, key) {
  return Array.isArray(settingsState?.[key]) ? settingsState[key] : normalizeItems(DEFAULT_SETTINGS[key]);
}
// Trả về chuỗi hiển thị thân thiện cho một mã cài đặt, ví dụ "001 - Công ty A".
export function getSettingDisplayValue(settingsState, key, value) {
  const match = getSettingOptions(settingsState, key).find((item) => item.ma === String(value));
  return match ? `${match.ma} - ${match.ten}` : value;
}
// Lưu danh sách mục của một nhóm cài đặt lên Firestore khi người dùng chỉnh sửa danh mục.
export async function saveSettingsDocument(key, items) {
  const authUser = await waitForAuth();
  if (!authUser) {
    console.warn('[Settings] skipped save because no authenticated user is available');
    return false;
  }

  const ref = buildDocRef(key);
  try {
    console.log('[Firestore] setDoc', ref.path);
    await setDoc(ref, {
      danhSach: normalizeItems(items)
    }, { merge: true });
    notifySettingsChanged(key);
    return true;
  } catch (error) {
    console.error('[Settings] saveSettingsDocument failed', error);
    return false;
  }
}




