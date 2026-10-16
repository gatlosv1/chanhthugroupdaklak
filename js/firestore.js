import { db } from './firebase.js';
import { getCurrentUser } from './auth.js';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const USERS_COLLECTION = 'users';
// Ghi log các yêu cầu Firestore để thuận tiện khi debug.
function logFirestoreRequest(action, ref) {
  console.log(`[Firestore] ${action}`, ref?.path || ref);
}
// Tạo hoặc cập nhật hồ sơ người dùng trong collection users.
export async function createOrUpdateUserProfile(uid, payload) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    console.warn('[Firestore] createOrUpdateUserProfile skipped: user not authenticated');
    return null;
  }

  const userRef = doc(db, USERS_COLLECTION, uid);
  logFirestoreRequest('setDoc', userRef);
  await setDoc(userRef, {
    ...payload,
    updatedAt: serverTimestamp()
  }, { merge: true });
  return userRef;
}
// Lấy hồ sơ người dùng dựa trên UID.
export async function getUserProfile(uid) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    console.warn('[Firestore] getUserProfile skipped: user not authenticated');
    return null;
  }

  const userRef = doc(db, USERS_COLLECTION, uid);
  logFirestoreRequest('getDoc', userRef);
  try {
    const snapshot = await getDoc(userRef);
    return snapshot.exists() ? snapshot.data() : null;
  } catch (error) {
    console.error('[Firestore] getUserProfile failed', error);
    return null;
  }
}

// Tìm hồ sơ người dùng theo địa chỉ email
// Dùng khi cần tra cứu thay vì biết uid
export async function getUserProfileByEmail(email) {
  if (!email) {
    return null;
  }

  const usersRef = collection(db, USERS_COLLECTION);
  logFirestoreRequest('getDocsByEmail', usersRef);
  try {
    const snapshot = await getDocs(usersRef);
    const match = snapshot.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .find((user) => String(user.email || '').trim().toLowerCase() === String(email).trim().toLowerCase());
    return match || null;
  } catch (error) {
    console.error('[Firestore] getUserProfileByEmail failed', error);
    return null;
  }
}
// Chuẩn hóa vai trò về admin hoặc staff.
export function normalizeUserRole(role = '') {
  const normalizedRole = (role || '').trim().toLowerCase();
  if (normalizedRole === 'dev') return 'dev';
  if (normalizedRole === 'admin') return 'admin';
  return 'staff';
}
// Lấy vai trò của người dùng từ hồ sơ Firestore.
export async function getUserRole(uid) {
  const profile = await getUserProfile(uid);
  return normalizeUserRole(profile?.role);
}
// Cập nhật thông tin hồ sơ người dùng.
export async function updateUserProfile(uid, payload) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    console.warn('[Firestore] updateUserProfile skipped: user not authenticated');
    return null;
  }

  const userRef = doc(db, USERS_COLLECTION, uid);
  logFirestoreRequest('updateDoc', userRef);
  try {
    await updateDoc(userRef, {
      ...payload,
      updatedAt: serverTimestamp()
    });
    return userRef;
  } catch (error) {
    console.error('[Firestore] updateUserProfile failed', error);
    return null;
  }
}
// Trả về reference của collection users.
export async function getUsersCollection() {
  return collection(db, USERS_COLLECTION);
}
// Lấy toàn bộ hồ sơ người dùng để dùng cho dashboard quản lý.
export async function getAllUsersProfiles() {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    console.warn('[Firestore] getAllUsersProfiles skipped: user not authenticated');
    return [];
  }

  const usersRef = collection(db, USERS_COLLECTION);
  logFirestoreRequest('getDocs', usersRef);
  try {
    const snapshot = await getDocs(usersRef);
    return snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
  } catch (error) {
    console.error('[Firestore] getAllUsersProfiles failed', error);
    return [];
  }
}
// Xóa hồ sơ người dùng khỏi Firestore.
export async function deleteUserProfile(uid) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    console.warn('[Firestore] deleteUserProfile skipped: user not authenticated');
    return null;
  }

  const userRef = doc(db, USERS_COLLECTION, uid);
  logFirestoreRequest('deleteDoc', userRef);
  try {
    await deleteDoc(userRef);
    return userRef;
  } catch (error) {
    console.error('[Firestore] deleteUserProfile failed', error);
    return null;
  }
}




