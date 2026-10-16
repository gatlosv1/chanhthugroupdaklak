// Lớp gọi Cloud Functions xử lý công đoạn (region asia-southeast1).
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const CALL_TIMEOUT_MS = 30000;
const functions = getFunctions(undefined, 'asia-southeast1');
const callable = (name) => {
  const call = httpsCallable(functions, name, { timeout: CALL_TIMEOUT_MS });
  return async (payload) => (await call(payload)).data;
};

/** Ghi kết quả công đoạn (đạt / hư nhẹ / hư nặng). */
export const updateLotStage = callable('updateLotStage');
/** Chuyển cả lô sang công đoạn ủ / làm lại. */
export const sendToSoak = callable('sendToSoak');
/** Loại bỏ cả lô (cần lý do). */
export const rejectLot = callable('rejectLot');
