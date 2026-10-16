import { waitForAuth, watchAuthState } from './auth.js';
import { db } from './firebase.js';
import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';
import { requirePageAccess } from './pageAccess.js';
import { showToast } from './utils.js';
import { logActivity } from './activityLog.js';
import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const COLLECTION = 'congTachMui';
const CATALOG_REF = doc(db, 'settings', 'congTachMuiCatalog');
const fields = ['stt', 'processDisplay', 'productionDate', 'totalBtp', 'totalTime', 'totalProductivity', 'morningBtp', 'morningPeople', 'morningHours', 'morningTime', 'morningProductivity', 'afternoonBtp', 'afternoonPeople', 'afternoonHours', 'afternoonTime', 'afternoonProductivity', 'eveningBtp', 'eveningPeople', 'eveningHours', 'eveningTime', 'eveningProductivity'];
const labels = ['STT', 'Ghi chú', 'Ngày tháng', 'Tổng BTP', 'Tổng Thời gian', 'Tổng Năng suất', 'Ca sáng BTP', 'Ca sáng Số người', 'Ca sáng Số giờ', 'Ca sáng Thời gian', 'Ca sáng Năng suất', 'Ca chiều BTP', 'Ca chiều Số người', 'Ca chiều Số giờ', 'Ca chiều Thời gian', 'Ca chiều Năng suất', 'Ca tối BTP', 'Ca tối Số người', 'Ca tối Số giờ', 'Ca tối Thời gian', 'Ca tối Năng suất'];
const byId = (id) => document.getElementById(id);
const productionDate = byId('productionDate');
const teamSelect = byId('teamSelect');
const note = byId('note');
const activeShift = byId('activeShift');
const shiftPeople = byId('shiftPeople');
const shiftHours = byId('shiftHours');
const shiftBtp = byId('shiftBtp');
const exportBtn = byId('exportBtn');
let table;
let currentUser;
let currentRole = 'staff';
let currentProfile = {};
let catalog = { teams: [{ id: 'dong-goi', name: 'Tổ Đóng gói' }] };
let stopRows;
let manuallySelectedShift = false;
let manuallySelectedDate = false;

function vietnamNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function dateValue(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function productivity(btp, time) { return time > 0 ? Number((btp / time).toFixed(2)) : 0; }
function productivityFormatter(cell) { return number(cell.getValue()).toFixed(2); }
function shiftInfo(date) { const minutes = date.getHours() * 60 + date.getMinutes(); if (minutes >= 420 && minutes < 750) return ['Ca sáng', 'morning']; if (minutes >= 750 && minutes < 1050) return ['Ca chiều', 'afternoon']; if (minutes >= 1080 || minutes < 30) return ['Ca tối', 'evening']; return ['Ngoài ca', 'morning']; }
function calculate(row) {
  const shiftRows = ['morning', 'afternoon', 'evening'];
  shiftRows.forEach((shift) => { row[`${shift}Time`] = number(row[`${shift}People`]) * number(row[`${shift}Hours`]); row[`${shift}Productivity`] = productivity(number(row[`${shift}Btp`]), number(row[`${shift}Time`])); });
  row.totalBtp = shiftRows.reduce((sum, shift) => sum + number(row[`${shift}Btp`]), 0);
  row.totalTime = shiftRows.reduce((sum, shift) => sum + number(row[`${shift}Time`]), 0);
  row.totalProductivity = productivity(row.totalBtp, row.totalTime);
  return row;
}
function processDisplay(row) { return row.note || ''; }
function emptyRow() { const shift = activeShift.value || shiftInfo(vietnamNow())[1]; const row = { id: `${currentUser.uid}-${Date.now()}`, stt: table.getDataCount() + 1, productionDate: productionDate.value, note: note.value.trim(), morningBtp: '', morningPeople: '', morningHours: '', afternoonBtp: '', afternoonPeople: '', afternoonHours: '', eveningBtp: '', eveningPeople: '', eveningHours: '', activeShift: shift }; row[`${shift}Btp`] = shiftBtp.value || ''; row[`${shift}People`] = shiftPeople.value || ''; row[`${shift}Hours`] = shiftHours.value || ''; return calculate(row); }
function renderOptions(select, values, placeholder) { select.replaceChildren(new Option(placeholder, '')); values.forEach((value) => select.appendChild(new Option(value.name || value, value.id || value))); }
function renderCatalog() { renderOptions(teamSelect, catalog.teams, '-- Chọn tổ --'); const allowedTeam = currentRole === 'admin' ? '' : currentProfile.teamId || ''; if (allowedTeam) teamSelect.value = allowedTeam; teamSelect.disabled = currentRole !== 'admin'; const list = byId('catalogList'); if (list) list.textContent = `Tổ: ${catalog.teams.map((team) => `${team.id} - ${team.name}`).join(', ')}`; byId('teamBadge').textContent = teamSelect.options[teamSelect.selectedIndex]?.text || 'Chưa chọn tổ'; }
function initTable() {
  const editableFields = ['morningBtp', 'morningPeople', 'morningHours', 'afternoonBtp', 'afternoonPeople', 'afternoonHours', 'eveningBtp', 'eveningPeople', 'eveningHours'];
  const readonlyFields = ['stt', 'processDisplay', 'productionDate', 'totalBtp', 'totalTime', 'totalProductivity', 'morningTime', 'morningProductivity', 'afternoonTime', 'afternoonProductivity', 'eveningTime', 'eveningProductivity'];
  const column = (field, title, width, options = {}) => ({ title, field, width, ...options, editor: editableFields.includes(field) ? 'number' : false, editable: readonlyFields.includes(field) ? false : () => currentRole === 'admin' || currentRole === 'dev' || Boolean(currentUser), formatter: field.toLowerCase().includes('productivity') ? productivityFormatter : undefined });
  const columns = [
    column('stt', 'STT', 60),
    column('processDisplay', 'Ghi chú', 180),
    column('productionDate', 'Ngày tháng', 95),
    { title: 'Tổng', columns: [column('totalBtp', 'BTP', 90), column('totalTime', 'Thời gian', 90), column('totalProductivity', 'Năng suất', 90)] },
    { title: 'Ca sáng', columns: [column('morningBtp', 'BTP', 90), column('morningPeople', 'Số người', 90), column('morningHours', 'Số giờ', 90), column('morningTime', 'Thời gian', 90), column('morningProductivity', 'Năng suất', 90)] },
    { title: 'Ca chiều', columns: [column('afternoonBtp', 'BTP', 90), column('afternoonPeople', 'Số người', 90), column('afternoonHours', 'Số giờ', 90), column('afternoonTime', 'Thời gian', 90), column('afternoonProductivity', 'Năng suất', 90)] },
    { title: 'Ca tối', columns: [column('eveningBtp', 'BTP', 90), column('eveningPeople', 'Số người', 90), column('eveningHours', 'Số giờ', 90), column('eveningTime', 'Thời gian', 90), column('eveningProductivity', 'Năng suất', 90)] }
  ];
  table = new Tabulator('#congTachMuiTable', { data: [], columns, layout: 'fitData', movableColumns: true, selectable: 1, clipboard: true, history: true, rowHeight: 38, renderComplete: updateSummary });
  table.on('cellEdited', (cell) => { const row = cell.getRow().getData(); calculate(row); cell.getRow().update(row); updateSummary(); });
}
function applyRows(rows) { table.setData(rows.map((row, index) => calculate({ ...row, stt: index + 1, processDisplay: processDisplay(row) }))); updateSummary(); }
function loadRows() { if (stopRows) stopRows(); const selectedTeam = teamSelect.value; const rowsRef = query(collection(db, COLLECTION), orderBy('createdAt', 'asc')); stopRows = onSnapshot(rowsRef, (snapshot) => { const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((row) => row.teamId === selectedTeam || currentRole === 'admin' && (!selectedTeam || row.teamId === selectedTeam)); applyRows(rows); }, (error) => showToast(error.message || 'Không thể tải dữ liệu Năng xuất tách múi.', 'error')); }
async function loadCatalog() { const snapshot = await getDoc(CATALOG_REF); if (snapshot.exists()) catalog = { ...catalog, ...snapshot.data() }; renderCatalog(); }
async function addOfficialRow() {
  if (!productionDate.value) { showToast('Vui lòng chọn ngày tháng.', 'info'); return; }
  if (!activeShift.value) { showToast('Vui lòng chọn ca.', 'info'); return; }
  const selectedTeam = teamSelect.value;
  if (!selectedTeam) { showToast('Vui lòng chọn tổ.', 'info'); return; }

  const existingRow = table.getData().find((row) => row.productionDate === productionDate.value
    && row.teamId === selectedTeam);
  const row = existingRow ? { ...existingRow } : emptyRow();
  const shift = activeShift.value || shiftInfo(vietnamNow())[1];
  row.activeShift = shift;
  row[`${shift}Btp`] = shiftBtp.value || row[`${shift}Btp`] || '';
  row[`${shift}People`] = shiftPeople.value || row[`${shift}People`] || '';
  row[`${shift}Hours`] = shiftHours.value || row[`${shift}Hours`] || '';
  calculate(row);

  const changeMap = existingRow ? Object.fromEntries(
    Object.entries(row).filter(([key, value]) => key !== 'updatedAt' && key !== 'createdAt' && String(existingRow[key] ?? '') !== String(value ?? '')).map(([key, value]) => [key, { before: existingRow[key], after: value }])
  ) : null;

  try {
    await setDoc(doc(db, COLLECTION, row.id), {
      ...row,
      teamId: selectedTeam,
      ownerId: currentUser.uid,
      processDisplay: processDisplay(row),
      createdAt: existingRow?.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    logActivity({
      action: existingRow ? 'edit' : 'add',
      page: 'congTachMui',
      detail: `${existingRow ? 'Cập nhật' : 'Thêm'} dòng ${row.processDisplay || processDisplay(row)}, BTP=${row[`${shift}Btp`] || 0}`,
      changes: existingRow ? changeMap : null
    });
    showToast(existingRow ? 'Đã cập nhật ca vào dòng hiện tại.' : 'Đã thêm dòng chính thức.', 'success');
  } catch (error) {
    showToast(error.message || 'Không thể lưu dòng dữ liệu.', 'error');
  }
}
function updateSummary() { const rows = table ? table.getData() : []; byId('totalBtp').textContent = rows.reduce((sum, row) => sum + number(row.totalBtp), 0).toFixed(2); byId('totalTime').textContent = rows.reduce((sum, row) => sum + number(row.totalTime), 0).toFixed(2); const time = rows.reduce((sum, row) => sum + number(row.totalTime), 0); byId('totalProductivity').textContent = productivity(number(byId('totalBtp').textContent), time) || '0'; byId('draftRows').textContent = rows.length; }
function excelNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
function safeSheetName(name, usedNames) {
  const baseName = String(name || 'Chưa phân loại').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Chưa phân loại';
  let sheetName = baseName;
  let suffix = 2;
  while (usedNames.has(sheetName)) {
    const suffixText = ` (${suffix})`;
    sheetName = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(sheetName);
  return sheetName;
}
function exportRowFormula(field, row) {
  const formulas = {
    totalBtp: `=IFERROR(G${row}+L${row}+Q${row},0)`,
    totalTime: `=IFERROR(J${row}+O${row}+T${row},0)`,
    totalProductivity: `=IFERROR(D${row}/E${row},0)`,
    morningTime: `=H${row}*I${row}`,
    morningProductivity: `=IFERROR(G${row}/J${row},0)`,
    afternoonTime: `=M${row}*N${row}`,
    afternoonProductivity: `=IFERROR(L${row}/O${row},0)`,
    eveningTime: `=R${row}*S${row}`,
    eveningProductivity: `=IFERROR(Q${row}/T${row},0)`
  };
  return formulas[field];
}
function cloneExcelValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneExcelValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneExcelValue(item)]));
}
function copyTemplateSheet(sourceSheet, targetSheet) {
  sourceSheet.eachRow({ includeEmpty: true }, (sourceRow, rowNumber) => {
    const targetRow = targetSheet.getRow(rowNumber);
    targetRow.height = sourceRow.height;
    targetRow.hidden = sourceRow.hidden;
    sourceRow.eachCell({ includeEmpty: true }, (sourceCell, columnNumber) => {
      const targetCell = targetRow.getCell(columnNumber);
      targetCell.value = cloneExcelValue(sourceCell.value);
      targetCell.style = cloneExcelValue(sourceCell.style);
      targetCell.numFmt = sourceCell.numFmt;
      targetCell.protection = cloneExcelValue(sourceCell.protection);
    });
  });
  sourceSheet.columns.forEach((sourceColumn, index) => {
    const targetColumn = targetSheet.getColumn(index + 1);
    targetColumn.width = sourceColumn.width;
    targetColumn.hidden = sourceColumn.hidden;
    targetColumn.outlineLevel = sourceColumn.outlineLevel;
  });
  sourceSheet.model.merges.forEach((merge) => targetSheet.mergeCells(merge));
  targetSheet.views = cloneExcelValue(sourceSheet.views);
  targetSheet.properties = cloneExcelValue(sourceSheet.properties);
  targetSheet.pageSetup = cloneExcelValue(sourceSheet.pageSetup);
  targetSheet.headerFooter = cloneExcelValue(sourceSheet.headerFooter);
}
function setExcelCell(targetSheet, address, value) {
  targetSheet.getCell(address).value = value === '' || value === null || value === undefined ? null : value;
}
function setExcelFormula(targetSheet, address, formula, result) {
  const cell = targetSheet.getCell(address);
  cell.value = { formula: formula.slice(1), result: excelNumber(result) };
  cell.numFmt = '0.00';
}
async function exportExcel() {
  if (!window.ExcelJS) { showToast('Không thể tải thư viện Excel.', 'error'); return; }
  if (exportBtn) exportBtn.disabled = true;
  try {
    const templatePaths = ['./excel/Cong-Tach-Mui-Mau.xlsx', './exel/Cong-Tach-Mui-Mau.xlsx'];
    let response;
    for (const templatePath of templatePaths) {
      const candidate = await fetch(templatePath);
      if (candidate.ok) { response = candidate; break; }
    }
    if (!response) throw new Error('Không tìm thấy file mẫu Excel tại ./excel/Cong-Tach-Mui-Mau.xlsx.');
    const templateBuffer = await response.arrayBuffer();
    const templateWorkbook = new ExcelJS.Workbook();
    await templateWorkbook.xlsx.load(templateBuffer);
    const templateSheet = templateWorkbook.getWorksheet('đóng gói (tên tổ)') || templateWorkbook.worksheets[0];
    if (!templateSheet) throw new Error('File mẫu Excel chưa có worksheet.');

    const snapshot = await getDocs(collection(db, COLLECTION));
    const rowsByTeam = new Map();
    snapshot.docs.forEach((item) => {
      const row = { id: item.id, ...item.data() };
      const teamId = row.teamId || 'unknown';
      if (!rowsByTeam.has(teamId)) rowsByTeam.set(teamId, []);
      rowsByTeam.get(teamId).push(row);
    });
    const teams = [...(catalog.teams || [])];
    const knownTeamIds = new Set(teams.map((team) => team.id));
    rowsByTeam.forEach((teamRows, teamId) => {
      if (!knownTeamIds.has(teamId)) teams.push({ id: teamId, name: teamId });
    });
    if (!teams.length) { showToast('Catalog chưa có tổ để tạo worksheet.', 'info'); return; }
    const formulaFields = new Set(['totalBtp', 'totalTime', 'totalProductivity', 'morningTime', 'morningProductivity', 'afternoonTime', 'afternoonProductivity', 'eveningTime', 'eveningProductivity']);
    const teamNames = new Map((catalog.teams || []).map((team) => [team.id, team.name || team.id]));
    const workbook = new ExcelJS.Workbook();
    workbook.calcProperties = { calcMode: 'auto', fullCalcOnLoad: true, forceFullCalc: true };
    const usedSheetNames = new Set();
    teams.forEach((team) => {
      const teamId = team.id;
      const teamRows = rowsByTeam.get(teamId) || [];
      teamRows.sort((left, right) => String(left.productionDate || '').localeCompare(String(right.productionDate || '')));
      const worksheet = workbook.addWorksheet(safeSheetName(team.name || teamNames.get(teamId) || teamId, usedSheetNames));
      copyTemplateSheet(templateSheet, worksheet);
      teamRows.forEach((sourceRow, index) => {
        const excelRow = index + 3;
        const row = calculate({ ...sourceRow });
        fields.forEach((field, fieldIndex) => {
          const column = String.fromCharCode(65 + fieldIndex);
          const address = `${column}${excelRow}`;
          if (formulaFields.has(field)) {
            setExcelFormula(worksheet, address, exportRowFormula(field, excelRow), row[field]);
          } else {
            const value = row[field] ?? '';
            setExcelCell(worksheet, address, typeof value === 'number' ? excelNumber(value) : String(value));
          }
        });
      });
    });
    const output = await workbook.xlsx.writeBuffer();
    const blob = new Blob([output], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `cong-tach-mui-${dateValue(vietnamNow())}.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
    logActivity({ action: 'export', page: 'congTachMui', detail: `Xuất Excel ${teams.length} sheet` });
  } catch (error) {
    showToast(error.message || 'Không thể xuất dữ liệu Excel.', 'error');
  } finally {
    if (exportBtn) exportBtn.disabled = false;
  }
}
function refreshClock() { const now = vietnamNow(); const [shiftLabel, shift] = shiftInfo(now); const realtimeText = now.toLocaleString('vi-VN'); const clock = byId('realtimeClock'); const topClock = byId('topRealtimeClock'); if (clock) clock.textContent = realtimeText; if (topClock) topClock.textContent = realtimeText; if (!productionDate.value || !manuallySelectedDate) productionDate.value = dateValue(now); if (!manuallySelectedShift) activeShift.value = shift; shiftBtp.setAttribute('placeholder', `BTP ${shiftLabel}`); shiftPeople.setAttribute('placeholder', `Số người ${shiftLabel}`); shiftHours.setAttribute('placeholder', `Số giờ ${shiftLabel}`); }
productionDate.addEventListener('change', () => { manuallySelectedDate = true; });
byId('addRowBtn').addEventListener('click', addOfficialRow);
exportBtn?.addEventListener('click', exportExcel);
byId('deleteRowBtn').addEventListener('click', async () => {
  if (currentRole !== 'admin' && currentRole !== 'dev') { showToast('Chỉ admin/dev mới được xóa dòng.', 'info'); return; }
  const selectedRows = table.getSelectedRows();
  if (!selectedRows.length) { showToast('Vui lòng chọn dòng cần xóa.', 'info'); return; }
  try {
    await Promise.all(selectedRows.map((row) => {
      const rowId = row.getData().id;
      return rowId ? deleteDoc(doc(db, COLLECTION, rowId)) : null;
    }));
    logActivity({ action: 'delete', page: 'congTachMui', detail: `Xóa ${selectedRows.length} dòng Năng xuất tách múi` });
    showToast('Đã xóa dòng khỏi Firebase.', 'success');
  } catch (error) {
    showToast(error.message || 'Không thể xóa dòng khỏi Firebase.', 'error');
  }
});
byId('refreshBtn').addEventListener('click', loadRows);
activeShift.addEventListener('change', () => { manuallySelectedShift = true; });
teamSelect.addEventListener('change', () => { byId('teamBadge').textContent = teamSelect.options[teamSelect.selectedIndex]?.text || 'Chưa chọn tổ'; loadRows(); });
watchAuthState(async (user) => { if (!user) { window.location.href = './login.html'; return; } currentUser = user; const access = await requirePageAccess(user, 'congTachMui'); currentProfile = access.profile || {}; currentRole = access.role; byId('deleteRowBtn').classList.toggle('d-none', currentRole !== 'admin'); await loadCatalog(); initTable(); loadRows(); refreshClock(); setInterval(refreshClock, 1000); });
