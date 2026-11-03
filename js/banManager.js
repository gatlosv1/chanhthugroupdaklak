// Trang quản lý IP / UID bị cấm do rate limit. Chỉ tài khoản dev; mọi quyền được server kiểm tra lại
// trong Cloud Functions listRateLimitBans / unbanRateLimit (kiểm tra ở trình duyệt chỉ để điều hướng).
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import { watchAuthState } from './auth.js';
import app from './firebase.js';
import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';

const functions = getFunctions(app, 'asia-southeast1');
const listBans = httpsCallable(functions, 'listRateLimitBans', { timeout: 30000 });
const unban = httpsCallable(functions, 'unbanRateLimit', { timeout: 30000 });

const $ = (id) => document.getElementById(id);
const elements = {
  user: $('currentUser'),
  denied: $('denied'),
  deniedMessage: $('deniedMessage'),
  panel: $('panel'),
  search: $('searchInput'),
  includeExpired: $('includeExpired'),
  refresh: $('refreshBtn'),
  summary: $('summary'),
  error: $('errorMessage'),
  rows: $('banRows'),
  toasts: $('toastRegion')
};

const state = {
  items: [],
  clockOffset: 0, // serverNow - giờ máy lúc nhận dữ liệu, để đếm ngược không phụ thuộc đồng hồ máy
  truncated: false,
  loading: false
};

const serverNow = () => Date.now() + state.clockOffset;

/* ---------- Tiện ích ---------- */
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function toast(message, type = 'info') {
  const item = node('div', `bm-toast${type === 'error' ? ' bm-toast--error' : ''}`, message);
  elements.toasts.append(item);
  setTimeout(() => item.remove(), 3500);
}

const formatDateTime = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN') : '-');

/** "29 phút 58 giây", "1 giờ 59 phút", "45 giây". */
function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} giờ${minutes ? ` ${minutes} phút` : ''}${seconds ? ` ${seconds} giây` : ''}`;
  if (minutes > 0) return `${minutes} phút${seconds ? ` ${seconds} giây` : ''}`;
  return `${seconds} giây`;
}

const isActive = (item) => item.permanent || (item.banUntil !== null && item.banUntil > serverNow());

function describe(error, fallback) {
  const code = String(error?.code || '').replace(/^functions\//, '');
  if (!navigator.onLine || code === 'unavailable') return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  if (code === 'unauthenticated') return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  if (code === 'internal') return 'Hệ thống gặp lỗi. Thử lại sau.';
  return String(error?.message || '').trim() || fallback;
}

function showDenied(message) {
  elements.deniedMessage.textContent = message;
  elements.denied.classList.remove('is-hidden');
  elements.panel.classList.add('is-hidden');
}

/* ---------- Hiển thị ---------- */
function matches(item, keyword) {
  if (!keyword) return true;
  return [item.identifier, item.label, item.email].some((value) => String(value || '').toLowerCase().includes(keyword));
}

function remainingCell(item) {
  const cell = node('td');
  const label = node('span', 'bm-remaining');
  label.dataset.id = item.id;
  cell.append(label);
  setRemaining(label, item);
  return cell;
}

function setRemaining(label, item) {
  label.className = 'bm-remaining';
  if (item.permanent) {
    label.className = 'bm-badge bm-badge--lock';
    label.textContent = 'Khoá đến khi dev gỡ';
  } else if (isActive(item)) {
    label.textContent = formatRemaining(item.banUntil - serverNow());
  } else {
    label.className = 'bm-badge bm-badge--done';
    label.textContent = 'Đã hết hạn';
  }
}

function render() {
  const keyword = elements.search.value.trim().toLowerCase();
  const showExpired = elements.includeExpired.checked;
  const visible = state.items.filter((item) => (showExpired || isActive(item)) && matches(item, keyword));
  const activeCount = state.items.filter(isActive).length;

  elements.summary.textContent = `${activeCount} IP / UID đang bị cấm`
    + (keyword || showExpired ? ` · Hiển thị ${visible.length} mục` : '')
    + (state.truncated ? ' · Danh sách bị giới hạn ở 500 mục đầu tiên.' : '');

  if (!visible.length) {
    const cell = node('td', 'bm-empty', keyword ? 'Không có kết quả phù hợp.' : 'Hiện không có IP / UID nào bị cấm.');
    cell.colSpan = 7;
    const emptyRow = node('tr');
    emptyRow.append(cell);
    elements.rows.replaceChildren(emptyRow);
    return;
  }

  elements.rows.replaceChildren(...visible.map((item) => {
    const row = node('tr', isActive(item) ? '' : 'is-expired');

    const type = node('td');
    type.append(node('span', `bm-badge bm-badge--${item.type}`, item.type === 'uid' ? 'UID' : 'IP'));

    const identity = node('td', 'bm-id', item.identifier);
    const who = item.label || item.email;
    if (who) identity.append(node('small', '', who));

    const count = node('td', 'num');
    count.append(node('span', 'bm-badge bm-badge--count', `${item.banCount} lần`));

    const until = node('td', '', item.permanent ? 'Không giới hạn' : formatDateTime(item.banUntil));

    const action = node('td');
    const button = node('button', 'bm-btn bm-btn--danger', 'Gỡ cấm');
    button.type = 'button';
    button.dataset.unban = item.id;
    action.append(button);

    row.append(type, identity, count, node('td', '', formatDateTime(item.bannedAt)), until, remainingCell(item), action);
    return row;
  }));
}

/** Mỗi giây chỉ cập nhật ô đếm ngược; vẽ lại cả bảng khi có mục vừa hết hạn và đang ẩn mục hết hạn. */
function tick() {
  if (!state.items.length) return;
  let needsRender = false;
  elements.rows.querySelectorAll('[data-id]').forEach((label) => {
    const item = state.items.find((entry) => entry.id === label.dataset.id);
    if (!item) return;
    const wasActive = label.classList.contains('bm-remaining');
    setRemaining(label, item);
    if (wasActive && !isActive(item) && !elements.includeExpired.checked) needsRender = true;
  });
  if (needsRender) render();
}

/* ---------- Dữ liệu ---------- */
async function load() {
  if (state.loading) return;
  state.loading = true;
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Đang tải...';
  elements.error.classList.add('is-hidden');
  try {
    const result = (await listBans({ includeExpired: elements.includeExpired.checked })).data;
    state.items = Array.isArray(result.items) ? result.items : [];
    state.clockOffset = Number(result.serverNow) - Date.now();
    state.truncated = Boolean(result.truncated);
    render();
  } catch (error) {
    console.error('listRateLimitBans failed:', error);
    const code = String(error?.code || '').replace(/^functions\//, '');
    if (code === 'permission-denied') {
      showDenied(describe(error, 'Chỉ tài khoản dev mới được dùng trang này.'));
    } else {
      elements.error.textContent = describe(error, 'Không tải được danh sách. Vui lòng thử lại.');
      elements.error.classList.remove('is-hidden');
      elements.summary.textContent = '';
    }
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Làm mới';
  }
}

async function handleUnban(button) {
  const item = state.items.find((entry) => entry.id === button.dataset.unban);
  if (!item) return;
  const name = `${item.type === 'uid' ? 'UID' : 'IP'} ${item.identifier}`;
  if (!window.confirm(`Gỡ cấm ${name}?\nSố lần bị cấm sẽ được đặt lại về 0.`)) return;

  button.disabled = true;
  try {
    await unban({ id: item.id });
    toast(`Đã gỡ cấm ${name}.`);
    await load();
  } catch (error) {
    console.error('unbanRateLimit failed:', error);
    button.disabled = false;
    toast(describe(error, 'Không thể gỡ cấm. Vui lòng thử lại.'), 'error');
  }
}

/* ---------- Sự kiện ---------- */
elements.search.addEventListener('input', render);
elements.includeExpired.addEventListener('change', load);
elements.refresh.addEventListener('click', load);
elements.rows.addEventListener('click', (event) => {
  const button = event.target.closest('[data-unban]');
  if (button) handleUnban(button);
});
setInterval(tick, 1000);

watchAuthState(async (user) => {
  if (!user) {
    window.location.href = './login.html';
    return;
  }
  const profile = await getUserProfile(user.uid);
  if (resolveInitialRole(user.email, profile?.role) !== 'dev') {
    window.location.href = './dashboard.html';
    return;
  }
  elements.user.textContent = profile?.name || user.email || 'Developer';
  elements.panel.classList.remove('is-hidden');
  load();
});
