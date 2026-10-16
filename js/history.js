import { getCurrentUser, watchAuthState } from './auth.js';
import { rtdb, db } from './firebase.js';
import { endAt, equalTo, get, limitToLast, onChildAdded, orderByChild, orderByKey, query, ref, remove } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getVietnamDate, logActivity } from './activityLog.js';
import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';
import { showToast } from './utils.js';

const body = document.getElementById('historyBody');
const status = document.getElementById('historyStatus');
const currentDate = document.getElementById('currentDate');
const exportButton = document.getElementById('exportHistoryBtn');
const cleanupButton = document.getElementById('cleanupHistoryBtn');
const oldBanner = document.getElementById('oldLogsBanner');
const exportOldButton = document.getElementById('exportOldHistoryBtn');
const detailPanel = document.getElementById('historyDetail');
const MAX_VISIBLE_LOGS = 500;
let currentRole = 'staff';
let currentDay = '';
let liveLogs = [];
let selectedLogKey = '';
let stopLiveListener = null;
let rolloverTimer = null;

const actionLabel = { add: 'ADD', edit: 'EDIT', delete: 'DELETE', login: 'LOGIN', logout: 'LOGOUT', export: 'EXPORT', import: 'IMPORT', save: 'SAVE', load: 'LOAD' };
const pageLabel = { dashboard: 'Dashboard', production: 'Phần trăm BTP', nhapLieuSanXuat: 'Năng suất sản xuất', report: 'Báo cáo', congTachMui: 'Năng xuất tách múi', settings: 'Settings', profile: 'Profile', history: 'History', label: 'Label', auth: 'Auth' };

function shiftDate(date, amount) { const result = new Date(`${date}T12:00:00`); result.setDate(result.getDate() + amount); return getVietnamDate(result.getTime()); }
function formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); }
function visibleLogList() { return [...liveLogs].sort((left, right) => left.t - right.t).slice(-MAX_VISIBLE_LOGS); }
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDiffValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value, null, 2);
}

function renderDetail(item) {
  if (!detailPanel) return;
  if (!item) {
    detailPanel.innerHTML = '<div class="empty-detail">Chọn một dòng log ở bên trái để xem chi tiết thay đổi.</div>';
    return;
  }

  const diffEntries = item.c && typeof item.c === 'object' ? Object.entries(item.c) : [];
  const diffHtml = diffEntries.length
    ? diffEntries.map(([field, values]) => {
        const beforeText = formatDiffValue(values?.before);
        const afterText = formatDiffValue(values?.after);
        return `
          <div class="diff-row">
            <div class="diff-field">${escapeHtml(field)}</div>
            <div class="diff-column diff-column--before">
              <div class="diff-column-title">Before</div>
              <pre>${escapeHtml(beforeText)}</pre>
            </div>
            <div class="diff-column diff-column--after">
              <div class="diff-column-title">After</div>
              <pre>${escapeHtml(afterText)}</pre>
            </div>
          </div>
        `;
      }).join('')
    : '<div class="empty-detail">Không có dữ liệu diff rõ ràng cho sự kiện này.</div>';

  const payload = {
    time: new Date(item.t).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    user: item.n || item.u || 'Không rõ',
    page: pageLabel[item.p] || item.p || 'Unknown',
    action: actionLabel[item.a] || item.a || 'Unknown',
    detail: item.d || 'Không có mô tả',
    raw: {
      t: item.t,
      u: item.u,
      n: item.n || item.u || 'Không rõ',
      a: item.a,
      p: item.p,
      d: item.d || '',
      c: item.c || null
    }
  };

  detailPanel.innerHTML = `
    <div class="detail-card">
      <div class="detail-title">Event details</div>
      <div class="detail-grid">
        <div class="detail-label">Thời gian</div>
        <div class="detail-value">${escapeHtml(payload.time)}</div>
        <div class="detail-label">Người dùng</div>
        <div class="detail-value">${escapeHtml(payload.user)}</div>
        <div class="detail-label">Trang</div>
        <div class="detail-value">${escapeHtml(payload.page)}</div>
        <div class="detail-label">Hành động</div>
        <div class="detail-value">${escapeHtml(payload.action)}</div>
        <div class="detail-label">Mô tả</div>
        <div class="detail-value">${escapeHtml(payload.detail)}</div>
      </div>
      <div class="diff-panel">
        <div class="diff-panel-title">Diff thay đổi</div>
        ${diffHtml}
      </div>
      <div class="detail-json">${escapeHtml(JSON.stringify(payload.raw, null, 2))}</div>
    </div>
  `;
}

function renderLogs() {
  const logs = visibleLogList();
  body.replaceChildren(...(logs.length ? logs.map((item) => {
    const key = item.__key || `${item.t}-${item.u}-${item.a}-${item.p}`;
    const line = document.createElement('div');
    line.className = 'log-line' + (selectedLogKey && key === selectedLogKey ? ' is-selected' : '');
    line.dataset.logKey = key;
    [formatTime(item.t), item.n || item.u, pageLabel[item.p] || item.p || '-', actionLabel[item.a] || item.a || '-', item.d || ''].forEach((value, index) => {
      const part = document.createElement('span');
      part.className = ['log-time', 'log-user', 'log-page', 'log-action', 'log-detail'][index];
      part.textContent = value;
      line.appendChild(part);
    });
    line.addEventListener('click', () => {
      selectedLogKey = key;
      renderLogs();
      const selected = logs.find((entry) => (entry.__key || `${entry.t}-${entry.u}-${entry.a}-${entry.p}`) === key) || null;
      renderDetail(selected);
    });
    return line;
  }) : [Object.assign(document.createElement('div'), { className: 'text-secondary p-3', textContent: 'Chưa có log trong ngày.' })]));
  body.scrollTop = body.scrollHeight;
  status.textContent = `LIVE  ${logs.length}/${MAX_VISIBLE_LOGS}`;

  if (logs.length && !selectedLogKey) {
    selectedLogKey = logs[logs.length - 1].__key || `${logs[logs.length - 1].t}-${logs[logs.length - 1].u}-${logs[logs.length - 1].a}-${logs[logs.length - 1].p}`;
    renderDetail(logs[logs.length - 1]);
  } else if (logs.length) {
    const selected = logs.find((item) => (item.__key || `${item.t}-${item.u}-${item.a}-${item.p}`) === selectedLogKey) || logs[logs.length - 1];
    renderDetail(selected);
  } else {
    renderDetail(null);
  }
}
function downloadCsv(logs, filename) { const rows = [['Timestamp', 'User', 'Page', 'Action', 'Detail'], ...logs.map((item) => [new Date(item.t).toISOString(), item.n || item.u, item.p || '', item.a || '', item.d || ''])]; const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }
function readDay(date) { const dayRef = ref(rtdb, `logs/${date}`); const dayQuery = currentRole === 'admin' || currentRole === 'dev' ? query(dayRef, orderByChild('t'), limitToLast(MAX_VISIBLE_LOGS)) : query(dayRef, orderByChild('u'), equalTo(getCurrentUser()?.uid || ''), limitToLast(MAX_VISIBLE_LOGS)); return get(dayQuery); }
function watchCurrentDay(date) {
  if (stopLiveListener) stopLiveListener();
  currentDay = date;
  currentDate.textContent = date;
  const dayRef = ref(rtdb, `logs/${date}`);
  const liveQuery = currentRole === 'admin' || currentRole === 'dev' ? query(dayRef, orderByChild('t'), limitToLast(MAX_VISIBLE_LOGS)) : query(dayRef, orderByChild('u'), equalTo(getCurrentUser()?.uid || ''), limitToLast(MAX_VISIBLE_LOGS));
  liveLogs = [];
  selectedLogKey = '';
  stopLiveListener = onChildAdded(liveQuery, (snapshot) => {
    const nextLog = { ...(snapshot.val() || {}), __key: snapshot.key };
    liveLogs.push(nextLog);
    liveLogs = visibleLogList();
    renderLogs();
  }, () => { status.textContent = 'OFFLINE / lỗi kết nối'; });
}
async function archiveYesterday() {
  if ((currentRole !== 'admin' && currentRole !== 'dev') || !rtdb || !db) return;
  const yesterday = shiftDate(getVietnamDate(), -1);
  const archiveRef = doc(db, 'activityLogArchive', yesterday);
  if ((await getDoc(archiveRef)).exists()) return;
  const snapshot = await get(ref(rtdb, `logs/${yesterday}`));
  const logs = snapshot.val() || {};
  if (!Object.keys(logs).length) return;
  await setDoc(archiveRef, { date: yesterday, archivedAt: Date.now(), logs });
}
async function checkOldLogs() {
  if (currentRole !== 'admin' && currentRole !== 'dev') return;
  const cutoff = shiftDate(getVietnamDate(), -7);
  const snapshot = await get(query(ref(rtdb, 'logs'), orderByKey(), endAt(cutoff), limitToLast(1))).catch(() => null);
  const hasOld = snapshot?.exists() || false;
  oldBanner.classList.toggle('d-none', !hasOld);
  cleanupButton.classList.toggle('d-none', !hasOld);
}
async function cleanupOldLogs() {
  if (currentRole !== 'admin' && currentRole !== 'dev') return;
  const cutoff = shiftDate(getVietnamDate(), -7);
  const snapshot = await get(query(ref(rtdb, 'logs'), orderByKey(), endAt(cutoff))).catch(() => null);
  const oldDates = Object.keys(snapshot?.val() || {});
  await Promise.all(oldDates.map((date) => remove(ref(rtdb, `logs/${date}`))));
  oldBanner.classList.add('d-none'); cleanupButton.classList.add('d-none');
  logActivity({ action: 'delete', page: 'auth', detail: `Xóa ${oldDates.length} ngày log cũ` });
  showToast('Đã xóa log cũ hơn 7 ngày.', 'success');
}
async function exportOldLogs() { if (currentRole !== 'admin' && currentRole !== 'dev') return; const cutoff = shiftDate(getVietnamDate(), -1); const snapshot = await get(query(ref(rtdb, 'logs'), orderByKey(), endAt(cutoff))).catch(() => null); const logs = Object.values(snapshot?.val() || {}).flatMap((day) => Object.values(day || {})); downloadCsv(logs, `activity-log-old-${getVietnamDate()}.csv`); }
function bindEvents() { exportButton.addEventListener('click', () => { downloadCsv(visibleLogList(), `activity-log-${currentDay}.csv`); logActivity({ action: 'export', page: 'auth', detail: `Xuất ${liveLogs.length} log realtime` }); }); cleanupButton.addEventListener('click', cleanupOldLogs); exportOldButton?.addEventListener('click', exportOldLogs); }
async function init() { bindEvents(); watchAuthState(async (user) => { if (!user) { window.location.href = './login.html'; return; } const profile = await getUserProfile(user.uid); currentRole = resolveInitialRole(user.email, profile?.role); if (!rtdb) { status.textContent = 'RTDB chưa cấu hình'; return; } watchCurrentDay(getVietnamDate()); await archiveYesterday().catch(() => {}); await checkOldLogs(); if (rolloverTimer) clearInterval(rolloverTimer); rolloverTimer = setInterval(async () => { const today = getVietnamDate(); if (today !== currentDay) { await archiveYesterday().catch(() => {}); watchCurrentDay(today); } }, 60000); }); }
init();
