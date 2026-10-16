import { watchAuthState, getCurrentUser, waitForAuth } from './auth.js';
import { getUserProfile, updateUserProfile } from './firestore.js';
import { uploadAvatar } from './storage.js';
import { hideLoading, showLoading, showToast } from './utils.js';

const form = document.getElementById('profileForm');
const avatarInput = document.getElementById('avatarFile');
const profileNameInput = document.getElementById('profileName');
const profileDepartmentInput = document.getElementById('profileDepartment');
const profileEmailInput = document.getElementById('profileEmail');
const profileRoleInput = document.getElementById('profileRole');
const profileAvatarPreview = document.getElementById('profileAvatarPreview');
const profileDisplayName = document.getElementById('profileDisplayName');
const profileDisplayEmail = document.getElementById('profileDisplayEmail');

let currentAvatarUrl = '';
// Khi trạng thái xác thực thay đổi, tải hồ sơ người dùng hiện tại.
watchAuthState(async (user) => {
  if (!user) {
    window.location.href = './login.html';
    return;
  }

  showLoading();
  try {
    await waitForAuth();
    const profile = await getUserProfile(user.uid);
    renderProfile(user, profile || {});
  } catch (error) {
    showToast(error.message || 'Không thể tải hồ sơ.', 'error');
  } finally {
    hideLoading();
  }
});
// Lưu thông tin hồ sơ khi người dùng bấm cập nhật.
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) return;

  showLoading();
  try {
    await waitForAuth();
    await updateUserProfile(user.uid, {
      name: profileNameInput.value.trim(),
      department: profileDepartmentInput.value.trim(),
      avatar: currentAvatarUrl || ''
    });
    showToast('Cập nhật hồ sơ thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Không thể lưu hồ sơ.', 'error');
  } finally {
    hideLoading();
  }
});
// Tải ảnh avatar mới lên Firebase Storage.
avatarInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const user = getCurrentUser();
  if (!file || !user) return;

  showLoading();
  try {
    currentAvatarUrl = await uploadAvatar(user.uid, file);
    profileAvatarPreview.textContent = '✓';
    showToast('Tải avatar thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Không thể tải avatar.', 'error');
  } finally {
    hideLoading();
  }
});
// Hiển thị thông tin hồ sơ trên giao diện profile.
function renderProfile(user, profile) {
  const name = profile?.name || user.displayName || 'Nhân viên';
  const department = profile?.department || 'Chưa phân phòng';
  const role = profile?.role || 'staff';
  currentAvatarUrl = profile?.avatar || '';

  profileNameInput.value = name;
  profileDepartmentInput.value = department;
  profileEmailInput.value = user.email || '';
  profileRoleInput.value = role === 'admin' ? 'Admin' : 'Staff';
  profileDisplayName.textContent = name;
  profileDisplayEmail.textContent = user.email || '';
  profileAvatarPreview.textContent = name.charAt(0).toUpperCase();
}



