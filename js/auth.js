import { auth } from './firebase.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

let authReadyPromise = null;
// Khởi tạo promise chờ Auth sẵn sàng để tái sử dụng trong các hàm khác.
function setAuthReadyPromise(promise) {
  authReadyPromise = promise;
  return promise;
}
// Đợi cho đến khi Firebase Auth sẵn sàng và trả về người dùng hiện tại nếu đã đăng nhập.
export function waitForAuth() {
  if (authReadyPromise) {
    return authReadyPromise;
  }

  const promise = new Promise((resolve, reject) => {
    if (!auth) {
      reject(new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.'));
      return;
    }

    const existingUser = auth.currentUser;
    if (existingUser) {
      resolve(existingUser);
      return;
    }

    try {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        unsubscribe();
        resolve(user);
      }, (error) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });

  return setAuthReadyPromise(promise);
}
// Đăng nhập bằng email và mật khẩu, có thể ghi nhớ phiên đăng nhập.
export async function loginWithEmailPassword(email, password, rememberMe = true) {
  if (!auth) {
    throw new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.');
  }

  await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
  return signInWithEmailAndPassword(auth, email, password);
}
// Đăng nhập ẩn danh bằng Firebase Auth.
export async function loginAnonymously() {
  if (!auth) {
    throw new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.');
  }
  return signInAnonymously(auth);
}
// Đăng nhập bằng tài khoản Google.
export async function loginWithGoogle() {
  if (!auth) {
    throw new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.');
  }

  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (error) {
    const isPopupBlocked = error?.code === 'auth/popup-blocked' || error?.code === 'auth/cancelled-popup-request';

    if (isPopupBlocked) {
      await signInWithRedirect(auth, googleProvider);
      return await getRedirectResult(auth);
    }

    throw error;
  }
}
// Tạo tài khoản mới bằng email và mật khẩu.
export async function signUpWithEmailPassword(email, password) {
  if (!auth) {
    throw new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.');
  }
  return createUserWithEmailAndPassword(auth, email, password);
}
// Gửi email đặt lại mật khẩu cho người dùng.
export async function resetPassword(email) {
  if (!auth) {
    throw new Error('Firebase Auth chưa sẵn sàng. Vui lòng tải lại trang hoặc kiểm tra cấu hình Firebase.');
  }
  return sendPasswordResetEmail(auth, email);
}
// Đăng xuất khỏi Firebase Auth.
export async function logout() {
  if (!auth) {
    return;
  }
  return signOut(auth);
}
// Lắng nghe thay đổi trạng thái đăng nhập của người dùng.
export function watchAuthState(callback) {
  if (!auth) {
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}
// Trả về người dùng hiện tại đang đăng nhập.
export function getCurrentUser() {
  return auth?.currentUser || null;
}
// Trả về UID của người dùng hiện tại.
export function getCurrentUserId() {
  return auth?.currentUser?.uid || null;
}




