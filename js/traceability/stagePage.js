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
  query,
  where
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { rejectLot, sendToSoak, updateLotStage } from './api.js';
import { describeError, el, formatKg, setConnection, showToast, watchConnection } from './ui.js';
import {
  DEPARTMENTS, PHASES, STAGES, STAGE_ORDER, canOperate, resolveDepartmentId
} from './workflow.js';
import { createLotSelector } from './components/LotSelector.js';
import { createStageActionForm } from './components/StageActionForm.js';
import { createStageProgress } from './components/StageProgress.js';
import { createHistoryTimeline } from './components/HistoryTimeline.js';

const LIST_LIMIT = 200;
const $ = (id) => document.getElementById(id);

const elements = {
  phase: $('stagePhase'),
  title: $('stageTitle'),
  operator: $('operatorLabel'),
  tabs: $('stageTabs'),
  noAccess: $('noAccessPanel'),
  noAccessMessage: $('noAccessMessage'),
  layout: $('stageLayout'),
  count: $('queueCount'),
  badge: $('stageBadge'),
  selectorMount: $('lotSelectorMount'),
  progressMount: $('stageProgressMount'),
  formMount: $('stageFormMount'),
  historyMount: $('historyMount')
};

const state = {
  stage: null,
  lots: [],
  selectedId: null,
  stopListening: null
};

/* ---------- Component ---------- */
const selector = createLotSelector({ onSelect: (lot) => selectLot(lot.id) });
const progress = createStageProgress();
const history = createHistoryTimeline();
const form = createStageActionForm({
  onSubmit: (payload) => perform(updateLotStage, payload),
  onSendToSoak: (payload) => perform(sendToSoak, payload),
  onReject: (payload) => perform(rejectLot, payload)
});
elements.selectorMount.append(selector.element);
elements.progressMount.append(progress.element);
elements.formMount.append(form.element);
elements.historyMount.append(history.element);

/* ---------- Hiển thị ---------- */
const selectedLot = () => state.lots.find((lot) => lot.id === state.selectedId) || null;

function renderSelection() {
  const lot = selectedLot();
  form.setContext(state.stage, lot);
  progress.render(lot);
  history.render(lot?.history);
  selector.setSelected(lot?.id || null);
}

function selectLot(id) {
  state.selectedId = id;
  renderSelection();
  form.focus();
}

function setNoAccess(message) {
  elements.noAccessMessage.textContent = message;
  elements.noAccess.classList.remove('is-hidden');
  elements.layout.classList.add('is-hidden');
}

/** Hàng chờ của công đoạn: lô còn "waiting" và đang đứng ở công đoạn này. */
function startListening() {
  state.stopListening?.();
  // Chỉ lọc theo một trường để không cần composite index; lọc trạng thái ở client.
  const lotsQuery = query(collection(db, 'lots'), where('pendingStageId', '==', state.stage.id), limit(LIST_LIMIT));
  state.stopListening = onSnapshot(lotsQuery, (snapshot) => {
    setConnection(!snapshot.metadata.fromCache || navigator.onLine ? 'Đã kết nối' : 'Đang ngoại tuyến', !navigator.onLine);
    state.lots = snapshot.docs
      .map((document) => ({ id: document.id, ...document.data() }))
      .filter((lot) => lot.status === 'waiting');
    elements.count.textContent = String(state.lots.length);
    selector.setLots(state.lots);

    if (state.selectedId && !selectedLot()) {
      state.selectedId = null;
      showToast('Lô đang chọn đã được xử lý ở nơi khác.', 'info');
    }
    renderSelection();
  }, (error) => {
    console.error('Queue listener failed:', error);
    setConnection('Mất kết nối', true);
    showToast(describeError(error, 'Không tải được hàng chờ.'), 'error');
  });
}

/* ---------- Thao tác ---------- */
function summarize(result) {
  const next = STAGES[result.nextStage]?.name;
  if (result.completed) return `Lô ${result.lotCode} đã hoàn tất và vào kho đông.`;
  if (result.outcome === 'rejected') return `Đã loại bỏ lô ${result.lotCode}.`;
  const child = result.child ? ` Phần hư nhẹ tách thành lô ${result.child.lotCode} → ${STAGES[result.child.stageId].name}.` : '';
  const loss = result.lossKg > 0 ? ` Hao hụt ${formatKg(result.lossKg)} kg.` : '';
  return `Lô ${result.lotCode} → ${next}.${child}${loss}`;
}

/** Gọi một Cloud Function xử lý công đoạn và cập nhật giao diện; không ném lỗi ra ngoài. */
async function perform(call, payload) {
  if (!navigator.onLine) {
    showToast('Đang ngoại tuyến. Cần có mạng để ghi nhận công đoạn.', 'error');
    return;
  }
  try {
    const result = await call(payload);
    showToast(summarize(result), 'success');
    state.selectedId = null;
    form.reset();
    renderSelection();
  } catch (error) {
    console.error('Stage action failed:', error);
    showToast(describeError(error, 'Không thể ghi nhận công đoạn. Vui lòng thử lại.'), 'error');
  }
}

/* ---------- Tab công đoạn ---------- */
function renderTabs(operableIds, activeId) {
  elements.tabs.replaceChildren();
  Object.entries(PHASES).forEach(([phase, phaseName]) => {
    const ids = operableIds.filter((id) => STAGES[id].phase === phase);
    if (!ids.length) return;
    elements.tabs.append(el('div', 'stage-tabs__group', {}, [
      el('span', 'stage-tabs__label', { textContent: phaseName }),
      el('div', 'stage-tabs__items', {}, ids.map((id) => {
        const link = el('a', 'stage-tab', { href: `?stage=${id}`, textContent: STAGES[id].name });
        if (id === activeId) link.setAttribute('aria-current', 'page');
        return link;
      }))
    ]));
  });
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
  const role = resolveInitialRole(user.email, profile?.role);
  const departmentId = resolveDepartmentId(profile);
  elements.operator.textContent = `${profile?.name || user.email || 'Nhân viên'} · ${DEPARTMENTS[departmentId] || (role === 'staff' ? 'Chưa gán bộ phận' : 'Quản trị')}`;

  try {
    await requirePageAccess(user, 'traceability');
  } catch (error) {
    elements.title.textContent = 'Xử lý công đoạn';
    elements.phase.textContent = '';
    setNoAccess(error?.message || 'Tài khoản chưa được cấp quyền dùng trang này.');
    return;
  }

  document.querySelectorAll('[data-admin-only]').forEach((link) => { link.hidden = !isPrivilegedRole(profile?.role); });

  const operableIds = STAGE_ORDER.filter((id) => canOperate(STAGES[id], { role, departmentId }));
  const requestedId = new URLSearchParams(window.location.search).get('stage');
  const stage = STAGES[requestedId] || STAGES[operableIds[0]];
  if (!stage) {
    elements.title.textContent = 'Xử lý công đoạn';
    elements.phase.textContent = '';
    setNoAccess('Tài khoản chưa được gán bộ phận nên chưa có công đoạn nào để thao tác. Vui lòng liên hệ quản lý.');
    return;
  }

  state.stage = stage;
  elements.title.textContent = stage.name;
  elements.phase.textContent = `${PHASES[stage.phase]} · ${DEPARTMENTS[stage.departmentId]}`;
  elements.badge.textContent = stage.name;
  renderTabs(operableIds, stage.id);

  if (!canOperate(stage, { role, departmentId })) {
    setNoAccess(`Công đoạn ${stage.name} thuộc bộ phận ${DEPARTMENTS[stage.departmentId]}. Bạn không có quyền thao tác.`);
    return;
  }
  elements.layout.classList.remove('is-hidden');
  renderSelection();
  startListening();
}

window.addEventListener('pagehide', () => state.stopListening?.());

initialise().catch((error) => {
  console.error('Initialise failed:', error);
  setConnection('Lỗi khởi tạo', true);
  showToast(describeError(error, 'Không thể khởi tạo màn hình.'), 'error');
});
