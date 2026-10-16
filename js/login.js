import { loginWithEmailPassword, resetPassword, signUpWithEmailPassword, watchAuthState } from './auth.js';
import { ensureUserDocument } from './userService.js';
import { hideLoading, showLoading, showToast } from './utils.js';
import { isAdminLikeEmail } from './roleUtils.js';
import { logActivity } from './activityLog.js';
import { shouldAttemptLegacyAccountRecovery } from './loginRecovery.js';
import { getUserProfileByEmail } from './firestore.js';

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const togglePassword = document.getElementById('togglePassword');
const passwordInput = document.getElementById('password');
const forgotPasswordLink = document.getElementById('forgotPasswordLink');
const messageBox = document.getElementById('messageBox');
const emailError = document.getElementById('emailError');
const passwordError = document.getElementById('passwordError');

if (!form || !emailInput || !passwordInput || !togglePassword || !forgotPasswordLink || !messageBox) {
  console.warn('Một số phần tử form đăng nhập không tồn tại.');
}
// Xóa thông báo lỗi trên các trường nhập liệu.
function clearFieldErrors() {
  if (emailError) emailError.textContent = '';
  if (passwordError) passwordError.textContent = '';
}
// Kiểm tra định dạng email.
function validateEmail(email) {
  if (!email) {
    if (emailError) emailError.textContent = 'Vui lòng nhập email.';
    return false;
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    if (emailError) emailError.textContent = 'Email không đúng định dạng.';
    return false;
  }

  return true;
}
// Kiểm tra các trường nhập liệu trước khi đăng nhập.
function validateFields(email, password) {
  clearFieldErrors();

  if (!validateEmail(email)) {
    return false;
  }

  if (!password) {
    if (passwordError) passwordError.textContent = 'Vui lòng nhập mật khẩu.';
    return false;
  }

  if (password.length < 6) {
    if (passwordError) passwordError.textContent = 'Mật khẩu phải có ít nhất 6 ký tự.';
    return false;
  }

  return true;
}
// Nếu người dùng đã đăng nhập thì chuyển thẳng vào dashboard.
watchAuthState((user) => {
  if (user) {
    window.location.href = './dashboard.html';
  }
});

if (emailInput) {
  emailInput.addEventListener('input', clearFieldErrors);
}

if (passwordInput) {
  passwordInput.addEventListener('input', clearFieldErrors);
}
// Xử lý sự kiện đăng nhập bằng email và mật khẩu.
if (form) {
  form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const rememberMe = document.getElementById('rememberMe').checked;
  messageBox.replaceChildren();

  if (!validateFields(email, password)) {
    showToast('Vui lòng kiểm tra lại thông tin nhập.', 'error');
    return;
  }

  showLoading();
  try {
    const credential = await loginWithEmailPassword(email, password, rememberMe);
    await ensureUserDocument();
    logActivity({ action: 'login', page: 'auth', detail: 'Đăng nhập bằng email' });
    showToast(`Đăng nhập thành công. Chào ${credential.user.email}`, 'success');
    window.location.href = './dashboard.html';
  } catch (error) {
    try {
      const profile = await getUserProfileByEmail(email);
      const legacyPassword = profile?.password;
      const isLegacyRecoveryEnabled = shouldAttemptLegacyAccountRecovery(error.code, { password: legacyPassword });

      if (isLegacyRecoveryEnabled && legacyPassword && legacyPassword !== password) {
        try {
          const legacyCredential = await loginWithEmailPassword(email, legacyPassword, rememberMe);
          await ensureUserDocument();
          logActivity({ action: 'login', page: 'auth', detail: 'Đăng nhập bằng password legacy từ hồ sơ user' });
          showToast(`Đăng nhập thành công bằng mật khẩu legacy. Chào ${legacyCredential.user.email}`, 'success');
          window.location.href = './dashboard.html';
          return;
        } catch (legacyError) {
          console.warn('[Login] Legacy password check failed', legacyError);
        }
      }
    } catch (profileError) {
      console.warn('[Login] Could not load user profile for fallback login', profileError);
    }

    if ((error.code === 'auth/user-not-found' || error.code === 'auth/invalid-login-credentials') && isAdminLikeEmail(email) && password) {
      try {
        const credential = await signUpWithEmailPassword(email, password);
        await ensureUserDocument();
        logActivity({ action: 'login', page: 'auth', detail: 'Tạo tài khoản admin và đăng nhập' });
        showToast(`Tạo tài khoản admin thành công. Chào ${credential.user.email}`, 'success');
        window.location.href = './dashboard.html';
        return;
      } catch (createError) {
        showToast(mapError(createError), 'error');
      }
    } else {
      showToast(mapError(error), 'error');
    }
  } finally {
    hideLoading();
  }
});
}
// Chuyển đổi hiển thị hoặc ẩn mật khẩu trên form đăng nhập.
if (togglePassword) {
  togglePassword.addEventListener('click', () => {
  const isPassword = passwordInput.type === 'password';
  passwordInput.type = isPassword ? 'text' : 'password';
  togglePassword.textContent = isPassword ? 'Ẩn' : 'Hiện';
});
}
// Gửi email đặt lại mật khẩu khi người dùng bấm quên mật khẩu.
if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener('click', async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  if (!validateEmail(email)) {
    showToast('Nhập email hợp lệ trước khi gửi liên kết đặt lại mật khẩu.', 'info');
    return;
  }

  showLoading();
  try {
    await resetPassword(email);
    showToast('Email đặt lại mật khẩu đã được gửi. Vui lòng kiểm tra hộp thư.', 'success');
  } catch (error) {
    showToast(mapError(error), 'error');
  } finally {
    hideLoading();
  }
});
}
// Chuyển lỗi từ Firebase sang thông báo thân thiện với người dùng.
function mapError(error) {
  switch (error.code) {
    case 'auth/invalid-email':
      return 'Email không hợp lệ.';
    case 'auth/user-not-found':
      return 'Không tìm thấy người dùng với email này.';
    case 'auth/wrong-password':
      return 'Mật khẩu không đúng.';
    case 'auth/too-many-requests':
      return 'Quá nhiều lần thử. Hãy thử lại sau.';
    case 'auth/network-request-failed':
      return 'Lỗi mạng. Vui lòng kiểm tra kết nối và thử lại.';
    case 'auth/operation-not-allowed':
      return 'Đăng nhập bằng email/mật khẩu chưa được bật cho dự án này.';
    case 'auth/invalid-domain':
      return `Tên miền hiện tại (${window.location.hostname}) chưa được phép trong Firebase Authentication. Hãy thêm ${window.location.hostname} vào Authorized domains trong Firebase console.`;
    case 'auth/invalid-login-credentials':
      return 'Email hoặc mật khẩu không đúng.';
    case 'auth/invalid-password':
      return 'Mật khẩu không hợp lệ. Vui lòng nhập mật khẩu mạnh hơn.';
    case 'auth/email-already-in-use':
      return 'Email này đã được sử dụng.';
    default:
      return error.message || 'Đã xảy ra lỗi. Vui lòng thử lại.';
  }
}




