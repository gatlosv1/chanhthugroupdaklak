// Chuyển hướng trang ban đầu tới trang mục tiêu nếu có data-redirect.
document.addEventListener('DOMContentLoaded', () => {
  const allowedRedirects = new Map([
    ['login.html', './login.html'],
    ['dashboard.html', './dashboard.html'],
    ['production.html', './production.html'],
    ['report.html', './report.html'],
    ['profile.html', './profile.html'],
    ['settings.html', './settings.html']
  ]);
  const target = document.querySelector('[data-redirect]');
  const requestedRedirect = target?.getAttribute('data-redirect')?.replace(/^\.\//, '');
  const safeRedirect = allowedRedirects.get(requestedRedirect);
  if (safeRedirect) {
    window.location.replace(safeRedirect);
  }
});



