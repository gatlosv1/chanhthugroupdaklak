import { watchAuthState, loginWithGoogle, getCurrentUser, logout } from './auth.js';
import { db } from './firebase.js';
import { requirePageAccess } from './pageAccess.js';
import { showToast } from './utils.js';
import { setTeamDisplayNameMap, getRowTeam as resolveRowTeam } from './reportTeamDisplay.js';
import { collection, doc, getDoc, getDocs, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const COLLECTIONS = [
  { name: 'production', label: 'Phần trăm BTP' },
  { name: 'nhapLieuSanXuat', label: 'Năng suất sản xuất' },
  { name: 'congTachMui', label: 'Năng xuất tách múi' }
];
const MAX_RANGE_DAYS = 90;

const totalBtpEl = document.getElementById('totalBtp');
const avgProductivityEl = document.getElementById('avgProductivity');
const totalTimeEl = document.getElementById('totalTime');
const totalRowsEl = document.getElementById('totalRows');
const activeGroupsEl = document.getElementById('activeGroups');
const reportTimestampEl = document.getElementById('reportTimestamp');
const dailyTableBody = document.getElementById('dailyTableBody');
const refreshBtn = document.getElementById('refreshBtn');
const fromDateInput = document.getElementById('fromDate');
const toDateInput = document.getElementById('toDate');
const teamFilterEl = document.getElementById('teamFilter');
const processFilterEl = document.getElementById('processFilter');
const sourceFilterEl = document.getElementById('sourceFilter');
const applyReportFiltersBtn = document.getElementById('applyReportFilters');
const exportReportBtn = document.getElementById('exportReportBtn');
const autoReportFromDateInput = document.getElementById('autoReportFromDate');
const autoReportToDateInput = document.getElementById('autoReportToDate');
const autoReportEnabledInput = document.getElementById('autoReportEnabled');
const autoReportSendTimeInput = document.getElementById('autoReportSendTime');
const autoReportOnlyHasDataInput = document.getElementById('autoReportOnlyHasData');
const reportRecipientInput = document.getElementById('reportRecipientInput');
const addReportRecipientBtn = document.getElementById('addReportRecipientBtn');
const reportRecipientList = document.getElementById('reportRecipientList');
const googleSignInBtn = document.getElementById('googleSignInBtn');
const googleSignOutBtn = document.getElementById('googleSignOutBtn');
const googleLoginStatus = document.getElementById('googleLoginStatus');
const sendReportNowBtn = document.getElementById('sendReportNowBtn');
const previewReportBtn = document.getElementById('previewReportBtn');
const saveAutoReportConfigBtn = document.getElementById('saveAutoReportConfigBtn');
const reportPreviewModal = document.getElementById('reportPreviewModal');
const reportPreviewBody = document.getElementById('reportPreviewBody');
const reportPreviewSendBtn = document.getElementById('reportPreviewSendBtn');
const reportPreviewCloseBtn = document.getElementById('reportPreviewCloseBtn');
const reportPreviewCloseFooterBtn = document.getElementById('reportPreviewCloseFooterBtn');

let reportChart;
let processChart;
let teamChart;
let shiftChart;
let allRows = [];
let autoReportRecipients = [];
let autoReportSenderEmail = '';
let autoReportTimer = null;
let lastScheduledSendDate = '';
const GOOGLE_REPORT_SENDER_CLIENT_ID = window.GOOGLE_REPORT_SENDER_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
let googleSenderTokenClient = null;

async function ensureGoogleIdentitySdk() {
  if (window.google?.accounts?.oauth2) {
    return;
  }

  if (document.querySelector('script[data-google-identity-sdk="true"]')) {
    await new Promise((resolve) => {
      const check = () => {
        if (window.google?.accounts?.oauth2) {
          resolve();
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
    return;
  }

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.setAttribute('data-google-identity-sdk', 'true');
    script.onload = resolve;
    script.onerror = () => reject(new Error('Không thể tải Google Identity Services.'));
    document.head.appendChild(script);
  });
}

async function selectGoogleReportSender() {
  if (!GOOGLE_REPORT_SENDER_CLIENT_ID || GOOGLE_REPORT_SENDER_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID')) {
    showToast('Thiếu Google Client ID cho Gmail gửi báo cáo. Cấu hình window.GOOGLE_REPORT_SENDER_CLIENT_ID.', 'error');
    return;
  }

  try {
    await ensureGoogleIdentitySdk();

    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google Identity Services chưa sẵn sàng.');
    }

    if (!googleSenderTokenClient) {
      googleSenderTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_REPORT_SENDER_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
        callback: async (response) => {
          if (response.error) {
            throw new Error(response.error_description || 'Google OAuth2 bị hủy hoặc lỗi xác thực.');
          }

          const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
              Authorization: `Bearer ${response.access_token}`
            }
          });

          if (!userInfoResponse.ok) {
            throw new Error('Không lấy được thông tin Gmail từ Google.');
          }

          const profile = await userInfoResponse.json();
          const email = String(profile.email || '').trim();

          if (!isValidEmail(email)) {
            throw new Error('Google không trả về email hợp lệ để làm Gmail gửi báo cáo.');
          }

          autoReportSenderEmail = email;
          syncGoogleLoginStatus();
          await saveAutoReportConfig({ silent: true });
          showToast(`Đã chọn Gmail gửi báo cáo: ${email}`, 'success');
        }
      });
    }

    googleSenderTokenClient.requestAccessToken({ prompt: 'consent' });
  } catch (error) {
    console.error('[Report] selectGoogleReportSender failed', error);
    showToast(error?.message || 'Không thể chọn Gmail gửi báo cáo.', 'error');
  }
}

function clearGoogleReportSender() {
  autoReportSenderEmail = '';
  syncGoogleLoginStatus();
  saveAutoReportConfig({ silent: true }).catch(() => {});
  showToast('Đã xóa Gmail gửi báo cáo.', 'success');
}

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString('vi-VN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(date);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getWeekStart(date) {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const day = target.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  target.setDate(target.getDate() + diff);
  return target;
}

function getAutoReportDateRange() {
  const toValue = parseDateInput(autoReportToDateInput?.value) || new Date();
  const to = new Date(toValue.getFullYear(), toValue.getMonth(), toValue.getDate());
  const fromValue = parseDateInput(autoReportFromDateInput?.value);
  const from = fromValue ? new Date(fromValue.getFullYear(), fromValue.getMonth(), fromValue.getDate()) : getWeekStart(to);
  return { from: formatDateInput(from), to: formatDateInput(to) };
}

function getReportDateInputValue() {
  return autoReportToDateInput?.value || formatDateInput(new Date());
}

function formatDisplayDate(dateValue) {
  if (!dateValue) return '';
  const parsed = parseDateInput(dateValue);
  if (!parsed) return dateValue;
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDefaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 6);
  return {
    from: formatDateInput(start),
    to: formatDateInput(end)
  };
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getRowDateValue(row) {
  const directDate = row?.productionDate || row?.date || row?.ngay || row?.createdAt;

  if (!directDate) return null;

  if (directDate instanceof Date && !Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  if (directDate && typeof directDate?.toDate === 'function') {
    const fromTimestamp = directDate.toDate();
    if (!Number.isNaN(fromTimestamp.getTime())) return fromTimestamp;
  }

  if (typeof directDate === 'string') {
    const value = directDate.trim();
    if (!value) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = new Date(`${value}T00:00:00`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      const [day, month, year] = value.split('/').map(Number);
      const parsed = new Date(year, month - 1, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    if (/^\d{2}\/\d{2}\/\d{2}$/.test(value)) {
      const [day, month, yearShort] = value.split('/').map(Number);
      let year = yearShort;
      if (year < 100) {
        year = year >= 50 ? 1900 + year : 2000 + year;
      }
      const parsed = new Date(year, month - 1, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function getRowSourceLabel(row) {
  return row.__source || row.source || 'production';
}

function getRowBtp(row) {
  return numberValue(
    row.totalBtp ??
    row.btp ??
    row.kgA ??
    row.kgB ??
    row.kgC ??
    row.kgCNoSeed ??
    (Number(row.morningBtp || 0) + Number(row.afternoonBtp || 0) + Number(row.eveningBtp || 0))
  );
}

function getRowTime(row) {
  return numberValue(
    row.totalTime ??
    row.thoiGian ??
    row.time ??
    row.hours ??
    ((Number(row.morningTime || 0) + Number(row.afternoonTime || 0) + Number(row.eveningTime || 0)))
  );
}

function getRowTeam(row) {
  return resolveRowTeam(row);
}

function getRowProcess(row) {
  return row.processDisplay || row.processOne || row.processTwo || row.itemType || row.process || row.note || 'Chưa phân loại';
}

function getShiftTotals(row) {
  const morning = numberValue(row.morningBtp ?? row.caSangBtp ?? row.shiftMorningBtp ?? row.shiftBtp);
  const afternoon = numberValue(row.afternoonBtp ?? row.caChieuBtp ?? row.shiftAfternoonBtp ?? 0);
  const evening = numberValue(row.eveningBtp ?? row.caToiBtp ?? row.shiftEveningBtp ?? 0);
  return {
    'Ca sáng': morning,
    'Ca chiều': afternoon,
    'Ca tối': evening
  };
}

function populateSelectOptions(select, values, placeholder) {
  if (!select) return;
  const entries = [...new Set(values.filter(Boolean))];
  select.innerHTML = `<option value="all">${placeholder}</option>`;
  entries.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

async function loadCatalogOptions() {
  const catalogNames = ['congTachMuiCatalog', 'nhapLieuSanXuatCatalog'];
  const teamValues = [];
  const processValues = [];
  const displayTeams = [];

  // Duyệt qua từng danh mục trong Firestore
  // Lấy tên tổ và tên công đoạn
  for (const catalogName of catalogNames) {
    try {
      const snapshot = await getDoc(doc(db, 'settings', catalogName));
      if (!snapshot.exists()) continue;
      const data = snapshot.data() || {};
      if (Array.isArray(data.teams)) {
        data.teams.forEach((team) => {
          const teamId = team?.id || team;
          const teamName = team?.name || teamId;
          if (teamName) teamValues.push(teamName);
          if (teamId) {
            displayTeams.push({ id: teamId, name: teamName });
          }
        });
      }
      if (Array.isArray(data.processes)) {
        data.processes.forEach((process) => processValues.push(process.name || process.id || process));
      }
      if (Array.isArray(data.types)) {
        data.types.forEach((type) => processValues.push(type.name || type.id || type));
      }
    } catch (error) {
      console.warn('[Report] Could not load catalog', catalogName, error);
    }
  }

  setTeamDisplayNameMap(displayTeams);

  const allTeams = teamValues.length ? teamValues : ['Tổ 1', 'Tổ 2', 'Tổ 3'];
  const allProcesses = processValues.length ? processValues : ['Đóng gói', 'Xử lý', 'Phối trộn', 'Bảo quản'];

  populateSelectOptions(teamFilterEl, allTeams, 'Tất cả');
  populateSelectOptions(processFilterEl, allProcesses, 'Tất cả');
}

// Tải toàn bộ dữ liệu từ 3 collection báo cáo
// Gắn thêm nguồn để sau này lọc theo nguồn
async function loadDataset() {
  const snapshots = await Promise.all(COLLECTIONS.map(async ({ name }) => {
    try {
      const snapshot = await getDocs(collection(db, name));
      return snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        __source: name,
        ...docSnap.data()
      }));
    } catch (error) {
      console.warn(`[Report] Could not load ${name}`, error);
      return [];
    }
  }));

  allRows = snapshots.flat();
  return allRows;
}

function getCurrentFilters() {
  return {
    from: fromDateInput?.value || getDefaultDateRange().from,
    to: toDateInput?.value || getDefaultDateRange().to,
    team: teamFilterEl?.value || 'all',
    process: processFilterEl?.value || 'all',
    source: sourceFilterEl?.value || 'all'
  };
}

function validateRange(from, to) {
  const startDate = parseDateInput(from);
  const endDate = parseDateInput(to);
  if (!startDate || !endDate) return { valid: false, message: 'Vui lòng chọn đúng khoảng ngày.' };
  if (startDate > endDate) return { valid: false, message: 'Từ ngày không thể lớn hơn đến ngày.' };
  const diffDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24));
  if (diffDays > MAX_RANGE_DAYS) return { valid: false, message: `Khoảng thời gian tối đa là ${MAX_RANGE_DAYS} ngày.` };
  return { valid: true, diffDays };
}

// Lọc danh sách dữ liệu theo bộ lọc đang chọn
// Kiểm tra ngày, nguồn, tổ và công đoạn
function filterRows(rows, filters) {
  const source = filters.source || 'all';
  const team = (filters.team || 'all').trim();
  const process = (filters.process || 'all').trim();
  const from = parseDateInput(filters.from);
  const to = parseDateInput(filters.to);

  return rows.filter((row) => {
    const rowDate = getRowDateValue(row);
    if (!rowDate) return false;
    const dayKey = formatDateInput(rowDate);
    const dayDate = parseDateInput(dayKey);
    if (!dayDate) return false;
    // Bỏ qua dòng ngoài khoảng ngày đã chọn
    if (from && dayDate < from) return false;
    if (to && dayDate > to) return false;

    // Bỏ qua dòng không đúng nguồn dữ liệu
    if (source !== 'all' && getRowSourceLabel(row) !== source) return false;

    // So khớp tên tổ hoặc id tổ cũ
    if (team !== 'all') {
      const selectedTeam = normalizeKey(team);
      const rowTeam = normalizeKey(getRowTeam(row));
      const rowTeamId = normalizeKey(row?.teamId || row?.team || '');
      if (rowTeam !== selectedTeam && rowTeamId !== selectedTeam) return false;
    }

    // Bỏ qua dòng không đúng công đoạn đã chọn
    if (process !== 'all' && normalizeKey(getRowProcess(row)) !== normalizeKey(process)) return false;

    return true;
  });
}

// Nhóm dữ liệu theo từng ngày trong khoảng lọc
// Tính tổng BTP, thời gian và năng suất
function aggregateByDate(rows) {
  const range = { from: parseDateInput(getCurrentFilters().from), to: parseDateInput(getCurrentFilters().to) };
  const start = range.from || new Date();
  const end = range.to || new Date();

  const bucket = new Map();
  const current = new Date(start);
  while (current <= end) {
    const key = formatDateInput(current);
    bucket.set(key, { label: formatShortDate(current), btp: 0, time: 0, rows: 0, productivity: 0 });
    current.setDate(current.getDate() + 1);
  }

  rows.forEach((row) => {
    const rowDate = getRowDateValue(row);
    if (!rowDate) return;
    const key = formatDateInput(rowDate);
    if (!bucket.has(key)) {
      bucket.set(key, { label: formatShortDate(rowDate), btp: 0, time: 0, rows: 0, productivity: 0 });
    }
    const entry = bucket.get(key);
    const rowBtp = getRowBtp(row);
    const rowTime = getRowTime(row);
    entry.btp += rowBtp;
    entry.time += rowTime;
    entry.rows += 1;
  });

  return [...bucket.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      btp: entry.btp,
      time: entry.time,
      rows: entry.rows,
      productivity: entry.time > 0 ? entry.btp / entry.time : 0
    }))
    .sort((left, right) => (left.key > right.key ? 1 : -1));
}

// Nhóm dữ liệu theo 4 loại BTP chính trong collection production
// Sử dụng để thay thế biểu đồ "Theo công đoạn" bằng tỷ lệ BTP A/B/C/C Không hạt
function aggregateProductionBtpBreakdown(rows) {
  const totals = {
    'BTP A': 0,
    'BTP B': 0,
    'BTP C có hạt': 0,
    'BTP C Không hạt': 0
  };

  rows
    .filter((row) => getRowSourceLabel(row) === 'production')
    .forEach((row) => {
      totals['BTP A'] += numberValue(row.kgA ?? 0);
      totals['BTP B'] += numberValue(row.kgB ?? 0);
      totals['BTP C có hạt'] += numberValue(row.kgC ?? 0);
      totals['BTP C Không hạt'] += numberValue(row.kgCNoSeed ?? 0);
    });

  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return [{ name: 'Không có dữ liệu', value: 1 }];
  }

  return [
    { name: 'BTP A', value: totals['BTP A'] },
    { name: 'BTP B', value: totals['BTP B'] },
    { name: 'BTP C có hạt', value: totals['BTP C có hạt'] },
    { name: 'BTP C Không hạt', value: totals['BTP C Không hạt'] }
  ];
}

// Tính trung bình BTP theo tuần của từng kho trong collection production
function aggregateWarehouseWeeklyAverage(rows) {
  const weekTotals = new Map();

  rows.forEach((row) => {
    const rowDate = getRowDateValue(row);
    if (!rowDate) return;

    const warehouse = String(row?.warehouse || row?.kho || 'Chưa phân loại').trim() || 'Chưa phân loại';
    const current = new Date(rowDate);
    const day = current.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const weekStart = new Date(current);
    weekStart.setDate(current.getDate() + diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekKey = `${formatDateInput(weekStart)}|${warehouse}`;
    const warehouseMap = weekTotals.get(warehouse) || new Map();
    const totalThisWeek = warehouseMap.get(weekKey) || 0;
    warehouseMap.set(weekKey, totalThisWeek + getRowBtp(row));
    weekTotals.set(warehouse, warehouseMap);
  });

  const warehouseAverages = [...weekTotals.entries()].map(([warehouse, byWeek]) => {
    const weeklyTotals = [...byWeek.values()];
    const average = weeklyTotals.length ? weeklyTotals.reduce((sum, value) => sum + value, 0) / weeklyTotals.length : 0;
    return { name: warehouse, value: average };
  });

  const visible = warehouseAverages.filter((entry) => entry.value > 0).sort((left, right) => right.value - left.value);
  return visible.length ? visible : [{ name: 'Không có dữ liệu', value: 1 }];
}

// Tính BTP theo kho theo đúng logic nghiệp vụ:
// 1) Gom dữ liệu theo kho và ngày.
// 2) Với từng ngày, tính %A, %B, %C hạt, %C không hạt dựa trên tổng kg của ngày đó.
// 3) Sau đó lấy trung bình các % theo số ngày có dữ liệu.
// 4) value = tổng BTP trung bình hàng ngày của kho.
// 5) Sắp xếp theo % của từng loại, ưu tiên loại có % cao nhất trước.
function aggregateWarehouseAverageRanked(rows) {
  const warehouseDailyTotals = new Map();

  rows.forEach((row) => {
    const rowDate = getRowDateValue(row);
    if (!rowDate) return;

    const warehouse = String(row?.warehouse || row?.kho || 'Chưa phân loại').trim() || 'Chưa phân loại';
    const dayKey = formatDateInput(rowDate);
    const warehouseMap = warehouseDailyTotals.get(warehouse) || new Map();
    const current = warehouseMap.get(dayKey) || {
      kgA: 0,
      kgB: 0,
      kgC: 0,
      kgCNoSeed: 0,
      total: 0
    };

    current.kgA += numberValue(row?.kgA ?? row?.a ?? 0);
    current.kgB += numberValue(row?.kgB ?? row?.b ?? 0);
    current.kgC += numberValue(row?.kgC ?? row?.c ?? 0);
    current.kgCNoSeed += numberValue(row?.kgCNoSeed ?? row?.cNoSeed ?? 0);
    current.total = current.kgA + current.kgB + current.kgC + current.kgCNoSeed;

    warehouseMap.set(dayKey, current);
    warehouseDailyTotals.set(warehouse, warehouseMap);
  });

  const warehouseSummaries = [...warehouseDailyTotals.entries()].map(([name, dayMap]) => {
    const dailyEntries = [...dayMap.values()];
    const dayCount = dailyEntries.length;

    if (!dayCount) {
      return {
        name,
        value: 0,
        percentA: 0,
        percentB: 0,
        percentC: 0,
        percentCNoSeed: 0,
        dayCount: 0
      };
    }

    const dailyPercentA = dailyEntries.map((day) => (day.total > 0 ? (day.kgA / day.total) * 100 : 0));
    const dailyPercentB = dailyEntries.map((day) => (day.total > 0 ? (day.kgB / day.total) * 100 : 0));
    const dailyPercentC = dailyEntries.map((day) => (day.total > 0 ? (day.kgC / day.total) * 100 : 0));
    const dailyPercentCNoSeed = dailyEntries.map((day) => (day.total > 0 ? (day.kgCNoSeed / day.total) * 100 : 0));

    const averageDailyTotal = dailyEntries.reduce((sum, day) => sum + day.total, 0) / dayCount;
    const percentA = dailyPercentA.reduce((sum, value) => sum + value, 0) / dayCount;
    const percentB = dailyPercentB.reduce((sum, value) => sum + value, 0) / dayCount;
    const percentC = dailyPercentC.reduce((sum, value) => sum + value, 0) / dayCount;
    const percentCNoSeed = dailyPercentCNoSeed.reduce((sum, value) => sum + value, 0) / dayCount;

    return {
      name,
      value: averageDailyTotal,
      percentA,
      percentB,
      percentC,
      percentCNoSeed,
      dayCount
    };
  });

  return warehouseSummaries
    .filter((entry) => entry.value > 0)
    .sort((left, right) => {
      if (right.percentA !== left.percentA) return right.percentA - left.percentA;
      if (right.percentB !== left.percentB) return right.percentB - left.percentB;
      return right.value - left.value;
    });
}

// Tính tổng BTP theo từng công đoạn
// Dùng để vẽ biểu đồ cột theo công đoạn theo ngày đang lọc
function aggregateByProcess(rows) {
  const totals = new Map();

  rows.forEach((row) => {
    const processName = String(getRowProcess(row) || 'Chưa phân loại').trim() || 'Chưa phân loại';
    const current = totals.get(processName) || 0;
    totals.set(processName, current + getRowBtp(row));
  });

  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

// Tạo dữ liệu biểu đồ đường theo từng tổ
// Chỉ lấy dữ liệu tách múi trong khoảng ngày đã chọn
function buildTeamTrendChartData(rows, filters) {
  const start = parseDateInput(filters.from) || new Date();
  const end = parseDateInput(filters.to) || new Date();
  const labels = [];
  const current = new Date(start);
  while (current <= end) {
    labels.push({ key: formatDateInput(current), label: formatShortDate(current) });
    current.setDate(current.getDate() + 1);
  }

  const teamMap = new Map();
  rows.forEach((row) => {
    const date = getRowDateValue(row);
    if (!date) return;
    const rowDateKey = formatDateInput(date);
    if (date < start || date > end) return;
    const teamName = getRowTeam(row) || 'Chưa phân nhóm';
    const teamKey = String(teamName);
    if (!teamMap.has(teamKey)) {
      teamMap.set(teamKey, new Map());
    }
    const value = getRowProductivityValue(row);
    const bucket = teamMap.get(teamKey);
    bucket.set(rowDateKey, (bucket.get(rowDateKey) || 0) + value);
  });

  const catalogTeams = Array.from(teamFilterEl?.options || [])
    .map((option) => String(option.value || '').trim())
    .filter((value) => value && value !== 'all');

  const datasets = catalogTeams.map((teamName, index) => {
    const values = teamMap.get(teamName) || new Map();
    return {
      label: teamName,
      data: labels.map((day) => {
        const v = values.get(day.key);
        return v === undefined || v === null ? null : v;
      }),
      borderColor: TEAM_COLORS[index % TEAM_COLORS.length],
      backgroundColor: TEAM_COLORS[index % TEAM_COLORS.length],
      borderWidth: 2,
      tension: 0,
      spanGaps: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 4),
      pointHoverRadius: (ctx) => (ctx.raw == null ? 0 : 5),
      fill: false
    };
  });

  return { labels: labels.map((day) => day.label), datasets };
}

// Tạo dữ liệu biểu đồ đường theo từng công đoạn trong khoảng ngày đã chọn
// Mỗi đường = 1 công đoạn, các ngày không có dữ liệu sẽ để null để đường bị ngắt
function buildProcessTrendChartData(rows, filters) {
  const start = parseDateInput(filters.from) || new Date();
  const end = parseDateInput(filters.to) || new Date();
  const labels = [];
  let current = new Date(start);

  while (current <= end) {
    labels.push({ key: formatDateInput(current), label: formatShortDate(current) });
    current.setDate(current.getDate() + 1);
  }

  const processMap = new Map();

  rows.forEach((row) => {
    const date = getRowDateValue(row);
    if (!date) return;

    const rowDateKey = formatDateInput(date);
    if (date < start || date > end) return;

    const processName = getRowProcess(row) || 'Chưa phân loại';
    if (!processMap.has(processName)) {
      processMap.set(processName, new Map());
    }

    const bucket = processMap.get(processName);
    const value = getRowProductivityValue(row);
    bucket.set(rowDateKey, (bucket.get(rowDateKey) || 0) + value);
  });

  const palette = ['#1267d6', '#1da76e', '#f57c1f', '#6f42c1', '#ef4444', '#0ea5e9', '#14b8a6', '#f59e0b', '#22c55e', '#ec4899'];

  return {
    labels: labels.map((day) => day.label),
    datasets: Array.from(processMap.keys()).map((processName, index) => {
      const values = processMap.get(processName) || new Map();
      return {
        label: processName,
        data: labels.map((day) => {
          const value = values.get(day.key);
          return value === undefined || value === null ? null : value;
        }),
        borderColor: palette[index % palette.length],
        backgroundColor: palette[index % palette.length],
        borderWidth: 2,
        tension: 0,
        spanGaps: true,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 4),
        pointHoverRadius: (ctx) => (ctx.raw == null ? 0 : 5),
        fill: false
      };
    })
  };
}

// Bảng màu riêng cho từng tổ trên biểu đồ
const TEAM_COLORS = ['#1267d6', '#1da76e', '#f57c1f', '#6f42c1', '#ef4444', '#14b8a6', '#f59e0b', '#8b5cf6', '#0ea5e9', '#22c55e'];

// Lấy giá trị năng xuất ưu tiên từ một dòng
// Ưu tiên totalProductivity, sau đó mới đến totalBtp nếu không có giá trị năng suất
function getRowProductivityValue(row) {
  if (row?.totalProductivity !== undefined && row?.totalProductivity !== null && row?.totalProductivity !== '') {
    return numberValue(row.totalProductivity);
  }
  if (row?.totalBtp !== undefined && row?.totalBtp !== null && row?.totalBtp !== '') {
    const totalTime = numberValue(row?.totalTime ?? 0);
    if (totalTime > 0) {
      return numberValue(row.totalBtp / totalTime);
    }
    return numberValue(row.totalBtp);
  }
  return numberValue(row?.btp ?? row?.kgA ?? row?.kgB ?? row?.kgC ?? row?.kgCNoSeed ?? 0);
}

// Tính và hiển thị các chỉ số KPI tổng quan
// Dựa trên dữ liệu đã lọc
function renderMetrics(rows) {
  let totalBtp = 0;
  let totalTime = 0;
  let totalRows = 0;
  const groups = new Set();

  rows.forEach((row) => {
    totalBtp += getRowBtp(row);
    totalTime += getRowTime(row);
    totalRows += 1;
    groups.add(getRowTeam(row));
  });

  totalBtpEl.textContent = formatNumber(totalBtp, 2);
  avgProductivityEl.textContent = totalTime > 0 ? formatNumber(totalBtp / totalTime, 2) : '0.00';
  totalTimeEl.textContent = formatNumber(totalTime, 2);
  totalRowsEl.textContent = formatNumber(totalRows, 0);
  activeGroupsEl.textContent = formatNumber(groups.size, 0);
}

// Hiển thị bảng chi tiết dữ liệu theo ngày
function renderDailyTable(dailyData) {
  if (!dailyTableBody) return;

  if (!dailyData.length) {
    dailyTableBody.innerHTML = '<tr><td colspan="5" class="text-muted">Không có dữ liệu trong khoảng lọc hiện tại.</td></tr>';
    return;
  }

  dailyTableBody.innerHTML = dailyData
    .map((day) => `
      <tr>
        <td>${day.label}</td>
        <td>${formatNumber(day.btp, 2)}</td>
        <td>${formatNumber(day.time, 2)}</td>
        <td>${formatNumber(day.productivity, 2)}</td>
        <td>${formatNumber(day.rows, 0)}</td>
      </tr>
    `)
    .join('');
}

// Hủy biểu đồ cũ trước khi vẽ biểu đồ mới
function destroyChart(chart) {
  if (chart) chart.destroy();
}

// Vẽ lại toàn bộ 4 biểu đồ của trang báo cáo
// Dữ liệu truyền vào đã được lọc sẵn
function drawCharts(dailyData, processData, teamData, shiftData, teamTrendData = null, processTrendData = null) {
  const trendCtx = document.getElementById('trendChart');
  const processCtx = document.getElementById('processChart');
  const teamCtx = document.getElementById('teamChart');
  const shiftCtx = document.getElementById('shiftChart');

  destroyChart(reportChart);
  destroyChart(processChart);
  destroyChart(teamChart);
  destroyChart(shiftChart);

  if (trendCtx) {
    const trendLabels = teamTrendData?.labels || dailyData.map((entry) => entry.label);
    const trendDatasets = teamTrendData?.datasets && teamTrendData.datasets.length
      ? teamTrendData.datasets
      : [
          {
            label: 'BTP',
            data: dailyData.map((entry) => entry.btp),
            borderColor: '#1267d6',
            backgroundColor: 'rgba(18, 103, 214, 0.12)',
            tension: 0,
            fill: true,
            spanGaps: true,
            pointRadius: (ctx) => (ctx.raw == null ? 0 : 4),
            pointHoverRadius: (ctx) => (ctx.raw == null ? 0 : 5)
          }
        ];

    reportChart = new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: trendLabels,
        datasets: trendDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (items) => {
                const index = items[0]?.dataIndex ?? 0;
                return `Ngày: ${trendLabels[index] || ''}`;
              },
              label: (context) => {
                const teamName = context.dataset.label || 'Tổ';
                const value = context.parsed.y ?? 0;
                return `${teamName} - ${formatNumber(value, 2)}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Năng xuất' }
          },
          x: {
            title: { display: true, text: 'Ngày' }
          }
        }
      }
    });
  }

  if (processCtx) {
    const chartLabels = processData.map((entry) => entry.name);
    const chartValues = processData.map((entry) => entry.value);
    const chartColors = ['#1267d6', '#1da76e', '#f57c1f', '#6f42c1', '#ef4444', '#0ea5e9', '#14b8a6', '#f59e0b'];

    const isEmpty = !chartValues.length;

    processChart = new Chart(processCtx, {
      type: 'doughnut',
      data: {
        labels: isEmpty ? ['Không có dữ liệu'] : chartLabels,
        datasets: [{
          label: 'BTP',
          data: isEmpty ? [1] : chartValues,
          backgroundColor: isEmpty ? ['#1267d6'] : chartLabels.map((_, index) => chartColors[index % chartColors.length])
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '45%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              generateLabels: (chart) => {
                const dataset = chart.data.datasets[0];
                if (isEmpty) {
                  return [{ text: 'Không có dữ liệu', fillStyle: '#1267d6', strokeStyle: '#1267d6', lineWidth: 0, hidden: false, index: 0 }];
                }
                return chart.data.labels.map((label, index) => ({
                  text: label,
                  fillStyle: dataset.backgroundColor[index] || '#1267d6',
                  strokeStyle: dataset.backgroundColor[index] || '#1267d6',
                  lineWidth: 0,
                  hidden: false,
                  index
                }));
              }
            }
          },
          tooltip: {
            callbacks: {
              label: (context) => isEmpty ? 'Không có dữ liệu' : `${context.label}: ${formatNumber(context.parsed, 2)}`
            }
          }
        }
      }
    });
  }

  if (teamCtx) {
    const teamLabels = teamData.map((entry) => entry.name);
    const chartHeight = Math.max(280, teamLabels.length * 38 + 40);
    const teamChartInner = teamCtx.closest('.team-chart-inner');

    if (teamChartInner) {
      teamChartInner.style.height = `${chartHeight}px`;
      teamChartInner.style.minHeight = `${chartHeight}px`;
    }

    if (teamCtx) {
      teamCtx.style.height = `${chartHeight}px`;
    }

    teamChart = new Chart(teamCtx, {
      type: 'bar',
      data: {
        labels: teamLabels,
        datasets: [
          {
            label: 'BTP A',
            data: teamData.map((entry) => Number(entry.percentA || 0)),
            backgroundColor: '#1D4ED8',
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 24,
            maxBarThickness: 32,
            stack: 'quality'
          },
          {
            label: 'BTP B',
            data: teamData.map((entry) => Number(entry.percentB || 0)),
            backgroundColor: '#14B8A6',
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 24,
            maxBarThickness: 32,
            stack: 'quality'
          },
          {
            label: 'BTP C có hạt',
            data: teamData.map((entry) => Number(entry.percentC || 0)),
            backgroundColor: '#F97316',
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 24,
            maxBarThickness: 32,
            stack: 'quality'
          },
          {
            label: 'BTP C không hạt',
            data: teamData.map((entry) => Number(entry.percentCNoSeed || 0)),
            backgroundColor: '#C4B5FD',
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            barThickness: 24,
            maxBarThickness: 32,
            stack: 'quality'
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        elements: {
          bar: {
            borderRadius: 4,
            borderSkipped: false
          }
        },
        datasets: {
          bar: {
            categoryPercentage: 0.75,
            barPercentage: 0.9
          }
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (items) => items[0]?.label || '',
              label: (context) => `${context.dataset.label}: ${formatNumber(context.parsed.x || 0, 1)}%`,
              afterLabel: (context) => {
                const item = teamData[context.dataIndex] || {};
                return [
                  `Tổng: ${formatNumber((Number(item.percentA || 0) + Number(item.percentB || 0) + Number(item.percentC || 0) + Number(item.percentCNoSeed || 0)), 1)}%`,
                  `A: ${formatNumber(item.percentA || 0, 1)}%`,
                  `B: ${formatNumber(item.percentB || 0, 1)}%`,
                  `C hạt: ${formatNumber(item.percentC || 0, 1)}%`,
                  `C không hạt: ${formatNumber(item.percentCNoSeed || 0, 1)}%`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            stacked: true,
            min: 0,
            max: 100,
            title: { display: true, text: '% BTP' },
            ticks: {
              callback: (value) => `${value}%`
            }
          },
          y: {
            stacked: true,
            title: { display: true, text: 'Kho' },
            ticks: {
              autoSkip: false
            }
          }
        }
      }
    });
  }

  // Biểu đồ "Theo công đoạn" chuyển sang line chart
  // Mỗi dataset là 1 công đoạn; các ngày không có dữ liệu được để null để đường tự ngắt
  if (shiftCtx) {
    const chartLabels = processTrendData?.labels || shiftData.map((entry) => entry.name);
    const chartDatasets = processTrendData?.datasets && processTrendData.datasets.length
      ? processTrendData.datasets
      : [
          {
            label: 'Công đoạn',
            data: shiftData.map((entry) => entry.value),
            borderColor: '#1267d6',
            backgroundColor: 'rgba(18, 103, 214, 0.15)',
            tension: 0,
            borderWidth: 2,
            spanGaps: true,
            pointRadius: (ctx) => (ctx.raw == null ? 0 : 4),
            pointHoverRadius: (ctx) => (ctx.raw == null ? 0 : 5),
            fill: false
          }
        ];

    shiftChart = new Chart(shiftCtx, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: chartDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (items) => {
                const index = items[0]?.dataIndex ?? 0;
                return `Ngày: ${chartLabels[index] || ''}`;
              },
              label: (context) => {
                const processName = context.dataset.label || 'Công đoạn';
                const value = context.parsed.y ?? 0;
                return `${processName}: ${formatNumber(value, 2)}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Năng suất' }
          },
          x: {
            title: { display: true, text: 'Ngày' }
          }
        }
      }
    });
  }
}

// Xuất dữ liệu đang lọc ra file CSV
// Dùng để tải về máy người dùng
function exportCsv(rows) {
  const header = ['Ngày', 'Nguồn', 'Tổ', 'Công đoạn', 'BTP', 'Thời gian', 'Năng suất'];
  const entries = rows.map((row) => [
    formatDateInput(getRowDateValue(row) || new Date()),
    getRowSourceLabel(row),
    getRowTeam(row),
    getRowProcess(row),
    getRowBtp(row),
    getRowTime(row),
    getRowTime(row) > 0 ? getRowBtp(row) / getRowTime(row) : 0
  ]);

  const csv = [header, ...entries]
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'report-filtered.csv';
  link.click();
  URL.revokeObjectURL(url);
}

// Hàm chính: lọc dữ liệu và vẽ lại toàn bộ báo cáo
// Kiểm tra khoảng ngày trước khi xử lý
async function renderCurrentReport() {
  const filters = getCurrentFilters();
  const validation = validateRange(filters.from, filters.to);
  if (!validation.valid) {
    showToast(validation.message, 'error');
    return;
  }

  const filteredRows = filterRows(allRows, filters);
  const productionRows = filterRows(allRows.filter((row) => getRowSourceLabel(row) === 'production'), filters);
  const nhapLieuRows = filterRows(allRows.filter((row) => getRowSourceLabel(row) === 'nhapLieuSanXuat'), filters);
  const congTachMuiRows = filterRows(allRows.filter((row) => getRowSourceLabel(row) === 'congTachMui'), filters);
  const dailyData = aggregateByDate(filteredRows);
  const processData = aggregateProductionBtpBreakdown(productionRows);
  const teamData = aggregateWarehouseAverageRanked(productionRows);
  const shiftData = aggregateByProcess(filteredRows);
  const processTrendData = buildProcessTrendChartData(nhapLieuRows, filters);
  const teamTrendData = buildTeamTrendChartData(congTachMuiRows, filters);

  renderMetrics(filteredRows);
  renderDailyTable(dailyData);
  drawCharts(dailyData, processData, teamData, shiftData, teamTrendData, processTrendData);

  if (reportTimestampEl) {
    const now = new Date();
    reportTimestampEl.textContent = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(now);
  }
}

function getVietnamTime(date = new Date()) {
  return new Date(date.getTime() + (7 * 60 * 60 * 1000));
}

function getReportDateWithVietnamTime(date = new Date()) {
  const vietnamDate = getVietnamTime(date);
  const year = vietnamDate.getFullYear();
  const month = String(vietnamDate.getMonth() + 1).padStart(2, '0');
  const day = String(vietnamDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getSelectedAutoReportCharts() {
  return Array.from(document.querySelectorAll('#autoReportSection input[type="checkbox"]'))
    .filter((input) => input.checked && input.value)
    .map((input) => input.value);
}

function syncGoogleLoginStatus() {
  const userEmail = autoReportSenderEmail || '';

  if (googleLoginStatus) {
    googleLoginStatus.textContent = userEmail
      ? `Gmail gửi báo cáo hiện tại: ${userEmail}`
      : 'Chưa chọn Gmail gửi báo cáo';
  }

  if (googleSignInBtn) {
    googleSignInBtn.textContent = userEmail ? 'Đổi Gmail gửi báo cáo' : 'Chọn Gmail gửi báo cáo';
  }

  if (googleSignOutBtn) {
    googleSignOutBtn.textContent = 'Xóa Gmail gửi báo cáo';
    googleSignOutBtn.hidden = !userEmail;
  }
}

async function persistAutoReportRecipients({ silent = true } = {}) {
  const ref = doc(db, 'settings', 'autoReportConfig');
  const payload = {
    recipients: autoReportRecipients,
    updatedAt: new Date(),
    updatedBy: 'report-page'
  };

  try {
    await setDoc(ref, payload, { merge: true });
    if (!silent) showToast('Đã lưu danh sách email nhận báo cáo.', 'success');
  } catch (error) {
    console.error('[Report] persistAutoReportRecipients failed', error);
    if (!silent) showToast('Không thể lưu danh sách email nhận báo cáo.', 'error');
  }
}

function renderRecipientList() {
  if (!reportRecipientList) return;
  reportRecipientList.innerHTML = '';

  if (!autoReportRecipients.length) {
    const empty = document.createElement('span');
    empty.className = 'text-muted small';
    empty.textContent = 'Chưa có email nào.';
    reportRecipientList.appendChild(empty);
    return;
  }

  autoReportRecipients.forEach((email, index) => {
    const chip = document.createElement('span');
    chip.className = 'badge rounded-pill bg-light text-dark border d-inline-flex align-items-center gap-2 px-3 py-2';
    chip.innerHTML = `${email} <button type="button" class="btn-close btn-close-sm" data-index="${index}" aria-label="Xóa"></button>`;
    chip.querySelector('button').addEventListener('click', async () => {
      autoReportRecipients.splice(index, 1);
      renderRecipientList();
      await persistAutoReportRecipients({ silent: true });
    });
    reportRecipientList.appendChild(chip);
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || '').trim());
}

async function addReportRecipient() {
  const email = (reportRecipientInput?.value || '').trim();
  if (!email) {
    showToast('Vui lòng nhập email.', 'error');
    return;
  }
  if (!isValidEmail(email)) {
    showToast('Email không hợp lệ.', 'error');
    return;
  }
  if (autoReportRecipients.includes(email)) {
    showToast('Email này đã có trong danh sách.', 'warning');
    return;
  }

  autoReportRecipients.push(email);
  renderRecipientList();
  await persistAutoReportRecipients({ silent: true });
  if (reportRecipientInput) reportRecipientInput.value = '';
  if (reportRecipientInput) reportRecipientInput.focus();
}

async function loadAutoReportConfig() {
  try {
    const ref = doc(db, 'settings', 'autoReportConfig');
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      autoReportConfigDefaults();
      return;
    }

    const data = snapshot.data() || {};
    autoReportRecipients = Array.isArray(data.recipients) ? data.recipients.filter(Boolean) : [];
    autoReportSenderEmail = typeof data.senderEmail === 'string' ? data.senderEmail.trim() : '';
    if (autoReportEnabledInput) autoReportEnabledInput.checked = Boolean(data.enabled);
    if (autoReportSendTimeInput) autoReportSendTimeInput.value = data.sendTime || '18:00';
    if (autoReportOnlyHasDataInput) autoReportOnlyHasDataInput.checked = data.onlyHasData !== false;
    syncGoogleLoginStatus();
    if (autoReportFromDateInput) autoReportFromDateInput.value = data.fromDate || getAutoReportDateRange().from;
    if (autoReportToDateInput) autoReportToDateInput.value = data.toDate || getAutoReportDateRange().to;
    lastScheduledSendDate = data.lastSentDate || '';

    const selectedCharts = Array.isArray(data.selectedCharts) && data.selectedCharts.length
      ? data.selectedCharts
      : ['kpi', 'trend', 'btpBreakdown', 'team', 'shift', 'dailyTable'];

    document.querySelectorAll('#autoReportSection input[type="checkbox"]').forEach((input) => {
      input.checked = selectedCharts.includes(input.value);
    });
  } catch (error) {
    console.warn('[Report] Could not load auto report config', error);
    autoReportConfigDefaults();
  }
  renderRecipientList();
}

function autoReportConfigDefaults() {
  autoReportRecipients = [];
  autoReportSenderEmail = getCurrentUser()?.email || '';
  const defaultRange = getAutoReportDateRange();
  if (autoReportFromDateInput) autoReportFromDateInput.value = defaultRange.from;
  if (autoReportToDateInput) autoReportToDateInput.value = defaultRange.to;
  if (autoReportEnabledInput) autoReportEnabledInput.checked = true;
  if (autoReportSendTimeInput) autoReportSendTimeInput.value = '18:00';
  if (autoReportOnlyHasDataInput) autoReportOnlyHasDataInput.checked = true;
  lastScheduledSendDate = '';

  document.querySelectorAll('#autoReportSection input[type="checkbox"]').forEach((input) => {
    input.checked = ['kpi', 'trend', 'btpBreakdown', 'team', 'shift', 'dailyTable'].includes(input.value);
  });
  renderRecipientList();
}

async function saveAutoReportConfig({ silent = false } = {}) {
  const ref = doc(db, 'settings', 'autoReportConfig');
  const payload = {
    enabled: Boolean(autoReportEnabledInput?.checked),
    sendTime: autoReportSendTimeInput?.value || '18:00',
    onlyHasData: Boolean(autoReportOnlyHasDataInput?.checked),
    fromDate: autoReportFromDateInput?.value || getAutoReportDateRange().from,
    toDate: autoReportToDateInput?.value || getAutoReportDateRange().to,
    selectedCharts: getSelectedAutoReportCharts(),
    recipients: autoReportRecipients,
    senderEmail: autoReportSenderEmail || '',
    lastSentDate: lastScheduledSendDate,
    updatedAt: new Date(),
    updatedBy: 'report-page'
  };

  try {
    await setDoc(ref, payload, { merge: true });
    if (!silent) showToast('Đã lưu cấu hình báo cáo tự động.', 'success');
  } catch (error) {
    console.error('[Report] saveAutoReportConfig failed', error);
    if (!silent) showToast('Không thể lưu cấu hình báo cáo tự động.', 'error');
  }
}

function getChartBase64(chartInstance) {
  if (!chartInstance || typeof chartInstance.toBase64Image !== 'function') return '';
  return chartInstance.toBase64Image('image/png', 1).replace(/^data:image\/png;base64,/, '');
}

function collectSelectedChartImages(selectedCharts) {
  const chartList = Array.isArray(selectedCharts) ? selectedCharts : getSelectedAutoReportCharts();
  return {
    trend: chartList.includes('trend') ? getChartBase64(reportChart) : '',
    btpBreakdown: chartList.includes('btpBreakdown') ? getChartBase64(processChart) : '',
    team: chartList.includes('team') ? getChartBase64(teamChart) : '',
    shift: chartList.includes('shift') ? getChartBase64(shiftChart) : ''
  };
}

function buildReportEmailHtml(reportData, selectedCharts, reportDateOrRange, chartsBase64 = null) {
  const data = reportData || {};
  const chartList = Array.isArray(selectedCharts) && selectedCharts.length ? selectedCharts : ['kpi', 'trend', 'btpBreakdown', 'team', 'shift', 'dailyTable'];
  const chartImages = chartsBase64 || collectSelectedChartImages(chartList);
  const range = reportDateOrRange && typeof reportDateOrRange === 'object' ? reportDateOrRange : null;
  const fromDate = range?.from || data.from || getAutoReportDateRange().from;
  const toDate = range?.to || data.to || getAutoReportDateRange().to;
  const titleText = fromDate && toDate && fromDate !== toDate
    ? `BÁO CÁO SẢN XUẤT TỪ ${formatDisplayDate(fromDate)} ĐẾN ${formatDisplayDate(toDate)}`
    : `BÁO CÁO SẢN XUẤT NGÀY ${formatDisplayDate(fromDate || toDate || getReportDateInputValue())}`;
  const reportDateLabel = fromDate && toDate && fromDate !== toDate
    ? `${formatDisplayDate(fromDate)} - ${formatDisplayDate(toDate)}`
    : formatDisplayDate(fromDate || toDate || getReportDateInputValue());

  const formatNumber = (value) => Number(value || 0).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatPercent = (value) => `${Number(value || 0).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

  const summaryItems = [];
  if (chartList.includes('kpi')) summaryItems.push('<li>KPI tổng quan: Tổng BTP, Năng suất TB, Tổng thời gian, Số dòng, Số tổ.</li>');
  if (chartList.includes('trend')) summaryItems.push('<li>Biểu đồ xu hướng theo ngày / theo tổ.</li>');
  if (chartList.includes('btpBreakdown')) summaryItems.push('<li>Bảng tổng hợp BTP A / B / C / C Không hạt.</li>');
  if (chartList.includes('team')) summaryItems.push('<li>Tóm tắt theo Tổ.</li>');
  if (chartList.includes('shift')) summaryItems.push('<li>Tóm tắt theo Ca / công đoạn.</li>');
  if (chartList.includes('dailyTable')) summaryItems.push('<li>Bảng chi tiết theo ngày.</li>');

  const total = Number(data.totalBtp || 0);
  const breakdownRows = (data.btpBreakdown || []).map((item) => {
    const percent = total > 0 ? (Number(item.value || 0) / total) * 100 : 0;
    return `
      <tr class="report-email-row">
        <td>${item.name}</td>
        <td class="text-right">${formatNumber(item.value)}</td>
        <td class="text-right">${formatPercent(percent)}</td>
      </tr>
    `;
  }).join('');

  const teamRows = (data.teamData || []).map((item) => `
    <tr class="report-email-row">
      <td>${item.name}</td>
      <td class="text-right">${formatNumber(item.value)}</td>
    </tr>
  `).join('');

  const shiftRows = (data.shiftData || []).map((item) => `
    <tr class="report-email-row">
      <td>${item.name}</td>
      <td class="text-right">${formatNumber(item.value)}</td>
    </tr>
  `).join('');

  const dailyRows = (data.dailyData || []).map((day) => `
    <tr class="report-email-row">
      <td>${day.label}</td>
      <td class="text-right">${formatNumber(day.btp)}</td>
      <td class="text-right">${formatNumber(day.time)}</td>
      <td class="text-right">${Number(day.rows || 0).toLocaleString('vi-VN')}</td>
    </tr>
  `).join('');

  const companyLogo = 'images/321516476_449770387367145_728949342124126507_n.jpg';
  const chartMarkup = [];
  if (chartList.includes('trend') && chartImages.trend) {
    chartMarkup.push(`<div class="report-email-chart"><div class="report-email-chart-title">Biểu đồ xu hướng</div><img class="report-email-chart-image" src="data:image/png;base64,${chartImages.trend}" /></div>`);
  }
  if (chartList.includes('btpBreakdown') && chartImages.btpBreakdown) {
    chartMarkup.push(`<div class="report-email-chart"><div class="report-email-chart-title">Theo loại BTP</div><img class="report-email-chart-image" src="data:image/png;base64,${chartImages.btpBreakdown}" /></div>`);
  }
  if (chartList.includes('team') && chartImages.team) {
    chartMarkup.push(`<div class="report-email-chart"><div class="report-email-chart-title">Theo Tổ</div><img class="report-email-chart-image" src="data:image/png;base64,${chartImages.team}" /></div>`);
  }
  if (chartList.includes('shift') && chartImages.shift) {
    chartMarkup.push(`<div class="report-email-chart"><div class="report-email-chart-title">Theo Ca / Công đoạn</div><img class="report-email-chart-image" src="data:image/png;base64,${chartImages.shift}" /></div>`);
  }

  return `
    <div class="report-email">
      <div class="report-email-shell">
        <table class="report-email-table" role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="report-email-header">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td style="width:90px; vertical-align:middle; text-align:left;">
                    <img class="report-email-logo" src="${companyLogo}" alt="Logo Chanh Thu" />
                  </td>
                  <td class="report-email-brand">
                    <div class="report-email-brand-title">CÔNG TY CỔ PHẦN TẬP ĐOÀN XUẤT - NHẬP KHẨU TRÁI CÂY CHANH THU</div>
                    <div class="report-email-brand-subtitle">thôn Nam Kỳ, xã Cưor Đăng, tỉnh Đắk Lắk</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="report-email-title-cell">
              <div class="report-email-title">${titleText}</div>
            </td>
          </tr>
          <tr>
            <td class="report-email-detail-cell">
              <table class="report-email-detail-table" role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="report-email-detail-label">Ngày báo cáo</td>
                  <td class="report-email-detail-value">${reportDateLabel}</td>
                </tr>
                <tr>
                  <td class="report-email-detail-label">Người gửi</td>
                  <td class="report-email-detail-value">Hệ thống Quản lý Nguyên liệu – Chanh Thu</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="report-email-stat-grid">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; border-spacing:0;">
                <tr>
                  <td class="report-email-stat-card">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="report-email-stat-inner">
                      <tr><td class="report-email-stat-label">Tổng BTP</td></tr>
                      <tr><td class="report-email-stat-value">${formatNumber(data.totalBtp)} kg</td></tr>
                    </table>
                  </td>
                  <td class="report-email-stat-card">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="report-email-stat-inner report-email-stat-inner--green">
                      <tr><td class="report-email-stat-label">Năng suất TB</td></tr>
                      <tr><td class="report-email-stat-value">${formatNumber(data.totalTime > 0 ? data.totalBtp / data.totalTime : 0)}</td></tr>
                    </table>
                  </td>
                  <td class="report-email-stat-card">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="report-email-stat-inner report-email-stat-inner--amber">
                      <tr><td class="report-email-stat-label">Tổng thời gian</td></tr>
                      <tr><td class="report-email-stat-value">${formatNumber(data.totalTime)}</td></tr>
                    </table>
                  </td>
                  <td class="report-email-stat-card report-email-stat-card--last">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="report-email-stat-inner report-email-stat-inner--purple">
                      <tr><td class="report-email-stat-label">Số dòng</td></tr>
                      <tr><td class="report-email-stat-value">${Number(data.totalRows || 0).toLocaleString('vi-VN')}</td></tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="report-email-section">
              <div class="report-email-section-title">Bảng tổng hợp BTP A / B / C / C Không hạt</div>
              <table class="report-email-data-table" role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <thead>
                  <tr>
                    <th>Loại</th>
                    <th class="text-right">Kg</th>
                    <th class="text-right">%</th>
                  </tr>
                </thead>
                <tbody>${breakdownRows || '<tr class="report-email-row"><td colspan="3" class="report-email-empty">Không có dữ liệu</td></tr>'}</tbody>
              </table>
            </td>
          </tr>

          ${chartList.includes('team') ? `
          <tr>
            <td class="report-email-section">
              <div class="report-email-section-title">Tóm tắt theo Tổ</div>
              <table class="report-email-data-table report-email-data-table--plain" role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <thead>
                  <tr>
                    <th>Tổ</th>
                    <th class="text-right">BTP</th>
                  </tr>
                </thead>
                <tbody>${teamRows || '<tr class="report-email-row"><td colspan="2" class="report-email-empty">Không có dữ liệu</td></tr>'}</tbody>
              </table>
            </td>
          </tr>` : ''}

          ${chartList.includes('shift') ? `
          <tr>
            <td class="report-email-section">
              <div class="report-email-section-title">Tóm tắt theo Ca / Công đoạn</div>
              <table class="report-email-data-table report-email-data-table--plain" role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <thead>
                  <tr>
                    <th>Ca / Công đoạn</th>
                    <th class="text-right">BTP</th>
                  </tr>
                </thead>
                <tbody>${shiftRows || '<tr class="report-email-row"><td colspan="2" class="report-email-empty">Không có dữ liệu</td></tr>'}</tbody>
              </table>
            </td>
          </tr>` : ''}

          ${chartList.includes('dailyTable') ? `
          <tr>
            <td class="report-email-section">
              <div class="report-email-section-title">Bảng chi tiết theo ngày</div>
              <table class="report-email-data-table report-email-data-table--plain" role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <thead>
                  <tr>
                    <th>Ngày</th>
                    <th class="text-right">BTP</th>
                    <th class="text-right">Thời gian</th>
                    <th class="text-right">Số dòng</th>
                  </tr>
                </thead>
                <tbody>${dailyRows || '<tr class="report-email-row"><td colspan="4" class="report-email-empty">Không có dữ liệu</td></tr>'}</tbody>
              </table>
            </td>
          </tr>` : ''}

          ${chartMarkup.length ? `
          <tr>
            <td class="report-email-content-section">
              ${chartMarkup.join('')}
            </td>
          </tr>` : ''}

          <tr>
            <td class="report-email-content-section">
              <div class="report-email-summary-title">Nội dung đã chọn</div>
              <ul class="report-email-summary-list">${summaryItems.join('') || '<li>Không có nội dung nào được chọn.</li>'}</ul>
            </td>
          </tr>

          <tr>
            <td class="report-email-footer">
              Email được gửi tự động từ hệ thống Quản lý Nguyên liệu – Chanh Thu<br />
              Vui lòng không trả lời email này.
            </td>
          </tr>
        </table>
      </div>
    </div>
  `;
}

async function sendReportEmail({ reportDate, recipients, selectedCharts, filters = getCurrentFilters(), html }) {
  const summary = buildReportData(
    filters?.from || getAutoReportDateRange().from,
    filters?.to || getAutoReportDateRange().to,
    filters
  );

  if (!autoReportSenderEmail || !isValidEmail(autoReportSenderEmail)) {
    throw new Error('Vui lòng chọn Gmail để gửi báo cáo.');
  }

  const payload = {
    reportDate,
    recipients,
    selectedCharts,
    filters,
    html: html || '',
    senderEmail: autoReportSenderEmail,
    subject: `[Báo cáo sản xuất] ${reportDate} – Tổng BTP: ${formatNumber(summary.totalBtp, 2)} kg`
  };

  const response = await fetch('https://asia-southeast1-quanlynlchanhthu.cloudfunctions.net/sendProductionReport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Gửi báo cáo thất bại.');
  }

  return response.json();
}

function buildReportData(from, to, filters = getCurrentFilters()) {
  const fromDate = parseDateInput(from) || parseDateInput(getAutoReportDateRange().from);
  const toDate = parseDateInput(to) || parseDateInput(getAutoReportDateRange().to);
  const rows = filterRows(allRows, { ...filters, from: formatDateInput(fromDate), to: formatDateInput(toDate) });
  const productionRows = rows.filter((row) => getRowSourceLabel(row) === 'production');
  const dailyData = aggregateByDate(rows);
  const btpBreakdown = aggregateProductionBtpBreakdown(productionRows);
  const totalBtp = rows.reduce((sum, row) => sum + getRowBtp(row), 0);
  const totalTime = rows.reduce((sum, row) => sum + getRowTime(row), 0);
  const teamData = aggregateByTeam(rows);
  const shiftData = aggregateByProcess(rows);

  return {
    from: formatDateInput(fromDate),
    to: formatDateInput(toDate),
    totalBtp,
    totalTime,
    totalRows: rows.length,
    activeGroups: new Set(rows.map((row) => getRowTeam(row))).size,
    dailyData,
    btpBreakdown,
    teamData,
    shiftData,
    selectedCharts: getSelectedAutoReportCharts()
  };
}

async function sendReportNow() {
  const range = getAutoReportDateRange();
  const recipients = autoReportRecipients;
  const selectedCharts = getSelectedAutoReportCharts();

  if (!recipients.length) {
    showToast('Vui lòng thêm ít nhất 1 email nhận báo cáo.', 'error');
    return;
  }

  const fromDate = parseDateInput(range.from);
  const toDate = parseDateInput(range.to);
  if (!fromDate || !toDate) {
    showToast('Khoảng ngày không hợp lệ.', 'error');
    return;
  }
  if (fromDate > toDate) {
    showToast('Từ ngày không thể lớn hơn Đến ngày.', 'error');
    return;
  }

  try {
    const diffDays = Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
    if (diffDays > MAX_RANGE_DAYS) {
      showToast(`Khoảng thời gian tối đa là ${MAX_RANGE_DAYS} ngày.`, 'error');
      return;
    }

    const filters = getCurrentFilters();
    const data = buildReportData(range.from, range.to, { ...filters, from: range.from, to: range.to });
    const chartsBase64 = collectSelectedChartImages(selectedCharts);
    const html = buildReportEmailHtml(data, selectedCharts, { from: range.from, to: range.to }, chartsBase64);

    if (autoReportOnlyHasDataInput?.checked && !(data.totalRows > 0)) {
      showToast('Không có dữ liệu trong khoảng thời gian đã chọn. Báo cáo không được gửi.', 'warning');
      return;
    }

    await sendReportEmail({
      reportDate: `${range.from} → ${range.to}`,
      recipients,
      selectedCharts,
      filters: { ...filters, from: range.from, to: range.to },
      html
    });

    await setDoc(doc(db, 'reportEmailsLog', `${Date.now()}`), {
      fromDate: range.from,
      toDate: range.to,
      recipients,
      status: 'sent',
      sentAt: new Date(),
      selectedCharts,
      htmlPreview: html.slice(0, 300),
      note: 'Email sent via Firebase Function'
    }, { merge: true });

    showToast('Đã gửi báo cáo thành công.', 'success');

    if (reportPreviewModal) reportPreviewModal.style.display = 'none';
  } catch (error) {
    console.error('[Report] send scheduled report failed', error);
    const message = error?.message || 'Gửi báo cáo thất bại. Vui lòng kiểm tra cấu hình.';
    showToast(message, 'error');
  }
}

async function handleSendReportNow() {
  return sendReportNow();
}

function openReportPreview() {
  const range = getAutoReportDateRange();
  const fromDate = parseDateInput(range.from);
  const toDate = parseDateInput(range.to);
  if (!fromDate || !toDate) {
    showToast('Khoảng ngày không hợp lệ.', 'error');
    return;
  }
  if (fromDate > toDate) {
    showToast('Từ ngày không thể lớn hơn Đến ngày.', 'error');
    return;
  }

  const diffDays = Math.round((toDate - fromDate) / (1000 * 60 * 60 * 24));
  if (diffDays > MAX_RANGE_DAYS) {
    showToast(`Khoảng thời gian tối đa là ${MAX_RANGE_DAYS} ngày.`, 'error');
    return;
  }

  const selectedCharts = getSelectedAutoReportCharts();
  const filters = getCurrentFilters();
  const data = buildReportData(range.from, range.to, { ...filters, from: range.from, to: range.to });
  const html = buildReportEmailHtml(data, selectedCharts, { from: range.from, to: range.to }, collectSelectedChartImages(selectedCharts));

  if (reportPreviewBody) reportPreviewBody.innerHTML = html;
  if (reportPreviewModal) {
    reportPreviewModal.style.display = 'block';
    reportPreviewModal.setAttribute('aria-hidden', 'false');
  }
}

function closeReportPreview() {
  if (reportPreviewModal) {
    reportPreviewModal.style.display = 'none';
    reportPreviewModal.setAttribute('aria-hidden', 'true');
  }
}

function tryAutoSendReportAtSchedule() {
  const configEnabled = Boolean(autoReportEnabledInput?.checked);
  if (!configEnabled) return;

  const sendTime = autoReportSendTimeInput?.value || '18:00';
  if (sendTime !== '18:00') return;

  const now = getVietnamTime(new Date());
  const hour = now.getHours();
  const minute = now.getMinutes();
  const seconds = now.getSeconds();
  const todayKey = getReportDateWithVietnamTime(now);

  if (hour !== 18 || minute !== 0 || seconds >= 5) return;
  if (lastScheduledSendDate === todayKey) return;

  const recipients = autoReportRecipients;
  if (!recipients.length) return;

  const reportDate = todayKey;
  const filters = getCurrentFilters();
  const data = buildReportData(reportDate, { ...filters, from: reportDate, to: reportDate });
  if (autoReportOnlyHasDataInput?.checked && !(data.totalRows > 0)) return;

  lastScheduledSendDate = todayKey;
  saveAutoReportConfig({ silent: true }).catch(() => {});
  handleSendReportNow().catch(() => {});
}

function startAutoReportScheduler() {
  if (autoReportTimer) {
    clearInterval(autoReportTimer);
  }

  autoReportTimer = setInterval(() => {
    tryAutoSendReportAtSchedule();
  }, 30000);
}

async function initializeAutoReportSection() {
  const defaultRange = getAutoReportDateRange();
  if (autoReportFromDateInput) autoReportFromDateInput.value = defaultRange.from;
  if (autoReportToDateInput) autoReportToDateInput.value = defaultRange.to;

  if (addReportRecipientBtn) {
    addReportRecipientBtn.addEventListener('click', (event) => {
      event.preventDefault();
      addReportRecipient();
    });
  }

  if (reportRecipientInput) {
    reportRecipientInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addReportRecipient();
      }
    };
    reportRecipientInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addReportRecipient();
      }
    });
  }

  if (googleSignInBtn) {
    googleSignInBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      await selectGoogleReportSender();
    });
  }

  if (googleSignOutBtn) {
    googleSignOutBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      clearGoogleReportSender();
    });
  }

  syncGoogleLoginStatus();

  if (sendReportNowBtn) {
    sendReportNowBtn.addEventListener('click', (event) => {
      event.preventDefault();
      handleSendReportNow();
    });
  }

  if (previewReportBtn) {
    previewReportBtn.addEventListener('click', (event) => {
      event.preventDefault();
      openReportPreview();
    });
  }

  if (reportPreviewCloseBtn) {
    reportPreviewCloseBtn.addEventListener('click', closeReportPreview);
  }
  if (reportPreviewCloseFooterBtn) {
    reportPreviewCloseFooterBtn.addEventListener('click', closeReportPreview);
  }
  if (reportPreviewSendBtn) {
    reportPreviewSendBtn.addEventListener('click', async () => {
      closeReportPreview();
      await sendReportNow();
    });
  }

  if (reportPreviewModal) {
    reportPreviewModal.addEventListener('click', (event) => {
      if (event.target === reportPreviewModal) closeReportPreview();
    });
  }

  if (saveAutoReportConfigBtn) {
    saveAutoReportConfigBtn.addEventListener('click', (event) => {
      event.preventDefault();
      saveAutoReportConfig();
    });
  }

  await loadAutoReportConfig();
  renderRecipientList();
  startAutoReportScheduler();
}

// Khởi tạo trang báo cáo khi mới tải
// Đặt khoảng ngày mặc định rồi tải dữ liệu
async function initializeReport() {
  const defaultRange = getDefaultDateRange();
  fromDateInput.value = defaultRange.from;
  toDateInput.value = defaultRange.to;
  await loadCatalogOptions();
  await loadDataset();
  await renderCurrentReport();
  await initializeAutoReportSection();
}

applyReportFiltersBtn?.addEventListener('click', async (event) => {
  event.preventDefault();
  await renderCurrentReport();
});

exportReportBtn?.addEventListener('click', async () => {
  const filters = getCurrentFilters();
  const validation = validateRange(filters.from, filters.to);
  if (!validation.valid) {
    showToast(validation.message, 'error');
    return;
  }
  exportCsv(filterRows(allRows, filters));
  showToast('Đã xuất dữ liệu báo cáo đang lọc.', 'success');
});

refreshBtn?.addEventListener('click', async () => {
  await loadDataset();
  await renderCurrentReport();
});

watchAuthState(async (user) => {
  if (!user) {
    window.location.href = './login.html';
    return;
  }

  try {
    const accessData = await requirePageAccess(user, 'report');
    const autoSection = document.getElementById('autoReportSection');
    const isPrivileged = accessData?.role === 'admin' || accessData?.role === 'dev';
    if (autoSection) autoSection.hidden = !isPrivileged;
    await initializeReport();
  } catch (error) {
    console.error('[Report] Access error', error);
  }
});
