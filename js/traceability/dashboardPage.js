import { db } from '../firebase.js';
import { waitForAuth } from '../auth.js';
import { ensureUserDocument } from '../userService.js';
import { getUserProfile } from '../firestore.js';
import { requirePageAccess } from '../pageAccess.js';
import { resolveInitialRole, isPrivilegedRole } from '../roleUtils.js';
import {
  collection,
  enableIndexedDbPersistence,
  limit,
  onSnapshot,
  orderBy,
  query
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { dayKey, describeError, el, formatKg, setConnection, showToast, watchConnection } from './ui.js';
import { DEPARTMENTS, STAGES, STAGE_ORDER, getLotInputKg, getLotStageId, round3 } from './workflow.js';

const LOT_LIMIT = 500;
const FINAL_STAGE_ID = 'PACK';
const $ = (id) => document.getElementById(id);

const elements = {
  operator: $('operatorLabel'),
  noAccess: $('noAccessPanel'),
  noAccessMessage: $('noAccessMessage'),
  body: $('dashboardBody'),
  total: $('statTotal'),
  waiting: $('statWaiting'),
  kg: $('statKg'),
  completed: $('statCompleted'),
  rejected: $('statRejected'),
  stageRows: $('stageRows'),
  dailyRows: $('dailyRows'),
  dailyHint: $('dailyHint'),
  passedHeader: $('passedHeader'),
  stageFilter: $('stageFilter'),
  rangeFilter: $('rangeFilter')
};

let lots = [];
let stopListening = null;

/* ---------- Tổng hợp ---------- */

/** Đếm lô chờ và tổng kg theo từng công đoạn (chỉ lô còn waiting). */
function summarizeStages(allLots) {
  const rows = Object.fromEntries(STAGE_ORDER.map((id) => [id, { count: 0, kg: 0 }]));
  allLots.filter((lot) => lot.status === 'waiting').forEach((lot) => {
    const row = rows[getLotStageId(lot)];
    if (!row) return;
    row.count += 1;
    row.kg = round3(row.kg + getLotInputKg(lot));
  });
  return rows;
}

/**
 * Gom kg theo ngày từ history. Kg "đạt" cộng dồn qua nhiều công đoạn sẽ bị đếm lặp,
 * nên khi xem tất cả công đoạn chỉ tính thành phẩm sau đóng gói (đạt ở công đoạn cuối).
 */
function summarizeDaily(allLots, stageId, days) {
  const buckets = new Map();
  const cutoff = dayKey(Date.now() - (days - 1) * 86400000);
  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, { intake: 0, passed: 0, heavy: 0, light: 0, loss: 0 });
    return buckets.get(key);
  };

  allLots.forEach((lot) => (lot.history || []).forEach((entry) => {
    const key = dayKey(entry.timestamp);
    if (!key || key < cutoff) return;
    const kg = entry.kgData || {};
    if (entry.action === 'CREATE') {
      if (!stageId) bucket(key).intake += Number(kg.initialKg) || 0;
      return;
    }
    if (!['RECORD_RESULT', 'SEND_TO_SOAK', 'REJECT'].includes(entry.action)) return;
    if (stageId && entry.stage !== stageId) return;
    const row = bucket(key);
    const countsPassed = stageId ? true : entry.stage === FINAL_STAGE_ID;
    if (countsPassed) row.passed += Number(kg.passedKg) || 0;
    row.heavy += Number(kg.rejectedHeavyKg) || 0;
    row.light += Number(kg.rejectedLightKg) || 0;
    row.loss += Number(kg.lossKg) || 0;
  }));
  return [...buckets.entries()].sort(([a], [b]) => b.localeCompare(a));
}

/* ---------- Hiển thị ---------- */
function renderCards() {
  const waiting = lots.filter((lot) => lot.status === 'waiting');
  elements.total.textContent = String(lots.length);
  elements.waiting.textContent = String(waiting.length);
  elements.completed.textContent = String(lots.filter((lot) => lot.status === 'completed').length);
  elements.rejected.textContent = String(lots.filter((lot) => lot.status === 'rejected').length);
  elements.kg.textContent = formatKg(waiting.reduce((sum, lot) => sum + getLotInputKg(lot), 0));
}

function renderStages() {
  const summary = summarizeStages(lots);
  const maxCount = Math.max(1, ...Object.values(summary).map((row) => row.count));
  elements.stageRows.replaceChildren(...STAGE_ORDER.map((id) => {
    const stage = STAGES[id];
    const row = summary[id];
    const bar = el('span', 'mini-bar', {}, [el('span', 'mini-bar__fill')]);
    bar.firstChild.style.width = `${(row.count / maxCount) * 100}%`;
    const link = el('a', 'stage-link', { href: `./traceability-stage.html?stage=${id}`, textContent: stage.name });
    return el('tr', row.count ? '' : 'is-muted', {}, [
      el('td', '', {}, [link]),
      el('td', '', { textContent: DEPARTMENTS[stage.departmentId] }),
      el('td', 'num', { textContent: String(row.count) }),
      el('td', 'num', { textContent: row.count ? formatKg(row.kg) : '-' }),
      el('td', '', {}, [bar])
    ]);
  }));
}

function renderDaily() {
  const stageId = elements.stageFilter.value;
  const rows = summarizeDaily(lots, stageId, Number(elements.rangeFilter.value));
  elements.passedHeader.textContent = stageId ? 'Đạt (kg)' : 'Thành phẩm sau đóng gói (kg)';
  elements.dailyHint.textContent = stageId
    ? `Số liệu của công đoạn ${STAGES[stageId].name}, tính từ ${Math.min(lots.length, LOT_LIMIT)} lô gần nhất.`
    : 'Tất cả công đoạn: hư nặng/hư nhẹ/hao hụt cộng dồn mọi công đoạn; "đạt" chỉ tính thành phẩm sau đóng gói để không đếm lặp.';

  if (!rows.length) {
    elements.dailyRows.replaceChildren(el('tr', '', {}, [
      el('td', 'queue-empty', { colSpan: 6, textContent: 'Chưa có số liệu trong khoảng thời gian này.' })
    ]));
    return;
  }
  elements.dailyRows.replaceChildren(...rows.map(([key, row]) => {
    const [year, month, day] = key.split('-');
    const cell = (value, tone = '') => el('td', `num ${tone}`, { textContent: value ? formatKg(round3(value)) : '-' });
    return el('tr', '', {}, [
      el('td', '', { textContent: `${day}/${month}/${year}` }),
      cell(row.intake), cell(row.passed, 'tone-ok'), cell(row.heavy, 'tone-bad'), cell(row.light, 'tone-warn'), cell(row.loss)
    ]);
  }));
}

function renderAll() {
  renderCards();
  renderStages();
  renderDaily();
}

function populateStageFilter() {
  elements.stageFilter.replaceChildren(
    el('option', '', { value: '', textContent: 'Tất cả công đoạn' }),
    ...STAGE_ORDER.map((id) => el('option', '', { value: id, textContent: STAGES[id].name }))
  );
}

/* ---------- Khởi tạo ---------- */
async function initialise() {
  watchConnection();
  try {
    await enableIndexedDbPersistence(db);
  } catch (error) {
    console.warn('Offline persistence is unavailable:', error.code || error);
  }

  const user = await waitForAuth();
  if (!user) {
    window.location.href = './login.html';
    return;
  }
  const profile = (await ensureUserDocument()) || (await getUserProfile(user.uid));
  elements.operator.textContent = profile?.name || user.email || 'Nhân viên';
  try {
    await requirePageAccess(user, 'traceability');
    if (!isPrivilegedRole(resolveInitialRole(user.email, profile?.role))) {
      throw new Error('Chỉ admin mới được xem trang Tổng quan.');
    }
  } catch (error) {
    elements.noAccessMessage.textContent = error?.message || 'Tài khoản chưa được cấp quyền dùng trang này.';
    elements.noAccess.classList.remove('is-hidden');
    return;
  }

  populateStageFilter();
  elements.body.classList.remove('is-hidden');
  elements.stageFilter.addEventListener('change', renderDaily);
  elements.rangeFilter.addEventListener('change', renderDaily);

  const lotsQuery = query(collection(db, 'lots'), orderBy('createdAt', 'desc'), limit(LOT_LIMIT));
  stopListening = onSnapshot(lotsQuery, (snapshot) => {
    setConnection(!snapshot.metadata.fromCache || navigator.onLine ? 'Đã kết nối' : 'Đang ngoại tuyến', !navigator.onLine);
    lots = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
    renderAll();
  }, (error) => {
    console.error('Dashboard listener failed:', error);
    setConnection('Mất kết nối', true);
    showToast(describeError(error, 'Không tải được số liệu.'), 'error');
  });
}

window.addEventListener('pagehide', () => stopListening?.());

initialise().catch((error) => {
  console.error('Initialise failed:', error);
  setConnection('Lỗi khởi tạo', true);
  showToast(describeError(error, 'Không thể khởi tạo màn hình.'), 'error');
});
