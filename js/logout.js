import { logout } from './auth.js';
import { hideLoading, showLoading, showToast } from './utils.js';
import { logActivity } from './activityLog.js';

const logoutLinks = document.querySelectorAll('[data-action="logout"]');
// Gắn sự kiện đăng xuất cho các liên kết có thuộc tính data-action="logout".
logoutLinks.forEach((link) => {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    showLoading();

    try {
      logActivity({ action: 'logout', page: 'auth', detail: 'Đăng xuất khỏi hệ thống' });
      await logout();
      showToast('Đã đăng xuất.', 'info');
      window.location.href = './login.html';
    } catch (error) {
      showToast(error.message || 'Không thể đăng xuất.', 'error');
    } finally {
      hideLoading();
    }
  });
});



