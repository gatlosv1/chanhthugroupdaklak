import { db as firebaseDb } from './firebase.js';
import { waitForAuth } from './auth.js';
import { getUserProfile } from './firestore.js';
import { resolveInitialRole } from './roleUtils.js';
import { requirePageAccess } from './pageAccess.js';
import { hideLoading, showLoading, showToast } from './utils.js';
import {
    addDoc,
    collection as firestoreCollection,
    deleteDoc,
    doc as firestoreDoc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    where,
    writeBatch
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let currentUser = null;
let currentRole = 'staff';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function requireAdmin() {
    if (currentRole === 'admin' || currentRole === 'dev') return true;
    showToast('Chỉ admin/dev mới được thực hiện thao tác này.', 'error');
    return false;
}

function requireSignedIn() {
    if (currentUser?.uid) return true;
    showToast('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'error');
    return false;
}

class FirestoreDocumentAdapter {
    constructor(reference) {
        this.reference = reference;
    }

    async get() {
        const snapshot = await getDoc(this.reference);
        return { exists: snapshot.exists(), data: () => snapshot.data(), id: snapshot.id };
    }

    set(data, options) {
        return setDoc(this.reference, data, options);
    }

    delete() {
        return deleteDoc(this.reference);
    }
}

class FirestoreQueryAdapter {
    constructor(name, constraints = []) {
        this.name = name;
        this.constraints = constraints;
    }

    get reference() {
        return firestoreCollection(firebaseDb, this.name);
    }

    asQuery() {
        return this.constraints.length ? query(this.reference, ...this.constraints) : this.reference;
    }

    doc(id) {
        const reference = id
            ? firestoreDoc(firebaseDb, this.name, id)
            : firestoreDoc(this.reference);
        return new FirestoreDocumentAdapter(reference);
    }

    add(data) {
        return addDoc(this.reference, data);
    }

    get() {
        return getDocs(this.asQuery());
    }

    orderBy(field, direction = 'asc') {
        return new FirestoreQueryAdapter(this.name, [...this.constraints, orderBy(field, direction)]);
    }

    where(field, operator, value) {
        return new FirestoreQueryAdapter(this.name, [...this.constraints, where(field, operator, value)]);
    }

    limit(count) {
        return new FirestoreQueryAdapter(this.name, [...this.constraints, limit(count)]);
    }

    onSnapshot(callback, onError) {
        return onSnapshot(this.asQuery(), callback, onError);
    }
}

const db = {
    collection(name) {
        return new FirestoreQueryAdapter(name);
    },
    batch() {
        const batch = writeBatch(firebaseDb);
        return {
            set: (reference, data, options) => batch.set(reference.reference, data, options),
            delete: (reference) => batch.delete(reference.reference),
            commit: () => batch.commit()
        };
    }
};

const firebase = {
    firestore: {
        FieldValue: { serverTimestamp }
    }
};

// ==================== PHẦN CHỌN LOT TỪ LỊCH SỬ FIRESTORE ====================
            let historyLots = [];

            /** Tải và sắp xếp danh sách lot từ dữ liệu sản xuất chung. */
            async function loadHistoryLots() {
                try {
                    const snapshot = await getDocs(query(
                        firestoreCollection(firebaseDb, 'production'),
                        orderBy('productionDate', 'desc'),
                        limit(300)
                    ));
                    historyLots = snapshot.docs.map((item) => {
                        const data = item.data();
                        return {
                            id: item.id,
                            ma_lo: data.lot || '',
                            ngay_display: data.productionDate
                                ? String(data.productionDate).split('-').reverse().join('/')
                                : '',
                            bienso: data.vehicle || '',
                            tongkl: data.totalKg || data.kgA || ''
                        };
                    }).filter((item) => item.ma_lo);
                } catch(e) { console.error(e); }
            }

            /** Tải dữ liệu rồi mở cửa sổ chọn lot. */
            function openLotModal() {
                loadHistoryLots().then(() => {
                    renderLotList();
                    document.getElementById('lotModal').style.display = 'flex';
                    document.getElementById('searchLot').value = '';
                    document.getElementById('searchDate').value = '';
                });
            }

            /** Đóng cửa sổ chọn lot. */
            function closeLotModal() {
                document.getElementById('lotModal').style.display = 'none';
            }

            /** Mở danh sách thành phẩm và đưa con trỏ vào ô tìm kiếm. */
            function openProductModal() {
                const modal = document.getElementById('productModal');
                if (!modal) return;
                modal.style.display = 'flex';
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = '';
                    filterGrid();
                    searchInput.focus();
                }
            }

            /** Đóng cửa sổ danh sách thành phẩm. */
            function closeProductModal() {
                const modal = document.getElementById('productModal');
                if (!modal) return;
                modal.style.display = 'none';
            }

            /** Hiển thị danh sách lot đã tải hoặc danh sách đã lọc. */
            function renderLotList(filtered = historyLots) {
                const container = document.getElementById('lotList');
                if (!filtered.length) {
                    const empty = document.createElement('p');
                    empty.className = 'p-8 text-center text-gray-400';
                    empty.textContent = 'Không tìm thấy kết quả';
                    container.replaceChildren(empty);
                    return;
                }

                const rows = filtered.map((item) => {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'block w-full text-left px-4 py-3 hover:bg-indigo-50 border-b cursor-pointer';
                    const lot = document.createElement('div');
                    lot.className = 'font-bold font-mono';
                    lot.textContent = item.ma_lo || '';
                    const details = document.createElement('div');
                    details.className = 'text-gray-600 text-xs';
                    details.textContent = [item.ngay_display, item.bienso, item.tongkl ? `${item.tongkl}kg` : '']
                        .filter(Boolean)
                        .join(' | ');
                    row.append(lot, details);
                    row.addEventListener('click', () => window.selectLot(item.ma_lo || ''));
                    return row;
                });
                container.replaceChildren(...rows);
            }

            /** Lọc lot theo từ khóa và ngày nhập. */
            function filterLotList() {
                const textTerm = document.getElementById('searchLot').value.toLowerCase().trim();
                const dateValue = document.getElementById('searchDate').value;

                const filtered = historyLots.filter(item => {
                    const matchText = !textTerm || item.ma_lo.toLowerCase().includes(textTerm);
                    let matchDate = true;
                    if (dateValue && item.ngay_display) {
                        const [day, month, year] = item.ngay_display.split('/');
                        const itemDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                        matchDate = itemDate === dateValue;
                    }
                    return matchText && matchDate;
                });
                renderLotList(filtered);
            }

            /** Xóa điều kiện ngày và lọc lại danh sách lot. */
            function clearDateFilter() {
                document.getElementById('searchDate').value = '';
                filterLotList();
            }

            /** Áp dụng lot được chọn vào biểu mẫu chính. */
            window.selectLot = function(maLo) {
                document.getElementById('maBTP').value = maLo;
                syncControlsFromLot();
                closeLotModal();
                updatePreview();
            };

            // ==================== PHẦN CHÍNH: FIREBASE VÀ DỮ LIỆU ====================
            let firebaseReady = false;
            let counterRef = null;
            const DEFAULT_DROPDOWNS = {
                ngayDGEditable: true,
                toSanXuat: ["Tèo", "Nguyên", "Ly", "Tuấn", "Lyka"],
                nhaSX: ["009"],
                loaiHang: [
                    { value: "", label: "Không loại/Khác" },
                    { value: "D", label: "Dona (D)" },
                    { value: "R", label: "Ri (R)" }
                ],
                vungNguyenLieu: [
                    { value: "MT", label: "MT - Miền Tây" },
                    { value: "MD", label: "MD - Miền Đông" },
                    { value: "TN", label: "TN - Tây Nguyên" }
                ]
            };
            let currentDropdownSettings = normalizeDropdownSettings(DEFAULT_DROPDOWNS);
            const DROPDOWN_GROUPS = [
                { key: 'toSanXuat', title: 'Tổ/Nhóm', structured: false, valuePlaceholder: 'Tên tổ/nhóm' },
                { key: 'nhaSX', title: 'Nhà sản xuất', structured: false, valuePlaceholder: 'Mã nhà sản xuất' },
                { key: 'loaiHang', title: 'Loại hàng', structured: true, valuePlaceholder: 'Mã (VD: D)', labelPlaceholder: 'Tên hiển thị' },
                { key: 'vungNguyenLieu', title: 'Vùng nguyên liệu', structured: true, valuePlaceholder: 'Mã (VD: MT)', labelPlaceholder: 'Tên hiển thị' }
            ];

            /** Cập nhật thông báo trạng thái kết nối Firebase trên giao diện. */
            function setFirebaseStatus(message, isError = false) {
                const el = document.getElementById('firebaseStatus');
                if (!el) return;
                el.textContent = message;
                el.className = `text-center text-sm mb-6 ${isError ? 'text-red-600' : 'text-gray-600'}`;
            }

            /** Chuẩn hóa cấu hình dropdown và dùng mặc định cho trường thiếu hoặc không hợp lệ. */
            function normalizeDropdownSettings(data = {}) {
                const useArrayOrDefault = (value, fallback) => Array.isArray(value) && value.length
                    ? value
                    : fallback;

                return {
                    ngayDGEditable: data.ngayDGEditable !== false,
                    toSanXuat: useArrayOrDefault(data.toSanXuat, DEFAULT_DROPDOWNS.toSanXuat),
                    nhaSX: useArrayOrDefault(data.nhaSX, DEFAULT_DROPDOWNS.nhaSX),
                    loaiHang: useArrayOrDefault(data.loaiHang, DEFAULT_DROPDOWNS.loaiHang),
                    vungNguyenLieu: useArrayOrDefault(data.vungNguyenLieu, DEFAULT_DROPDOWNS.vungNguyenLieu)
                };
            }

            /** Điền option vào select từ danh sách chuỗi hoặc danh sách value/label. */
            function populateDropdown(selectId, items) {
                const select = document.getElementById(selectId);
                if (!select) return;

                const previousValue = select.value;
                select.replaceChildren();

                items.forEach((item) => {
                    const value = typeof item === 'object' && item !== null ? item.value : item;
                    const label = typeof item === 'object' && item !== null ? item.label : item;
                    if (value === undefined || value === null) return;

                    const option = document.createElement('option');
                    option.value = String(value);
                    option.textContent = String(label ?? value);
                    select.appendChild(option);
                });

                if (Array.from(select.options).some(option => option.value === previousValue)) {
                    select.value = previousValue;
                }
            }

            /** Điền đồng thời bốn dropdown nghiệp vụ. */
            function applyDropdownSettings(settings) {
                const normalized = normalizeDropdownSettings(settings);
                currentDropdownSettings = normalized;
                populateDropdown('toSanXuat', normalized.toSanXuat);
                populateDropdown('nhaSX', normalized.nhaSX);
                populateDropdown('loaiHang', normalized.loaiHang);
                populateDropdown('vungNguyenLieu', normalized.vungNguyenLieu);
                applyNgayDGEditability();
            }

            /** Khóa hoặc mở quyền chỉnh sửa ô Ngày ĐG. */
            function applyNgayDGEditability() {
                const input = document.getElementById('ngayDG');
                if (!input) return;
                input.disabled = !currentDropdownSettings.ngayDGEditable;
                input.classList.toggle('bg-gray-100', !currentDropdownSettings.ngayDGEditable);
                input.classList.toggle('cursor-not-allowed', !currentDropdownSettings.ngayDGEditable);
            }

            /** Yêu cầu mật khẩu rồi mở khu vực quản lý danh mục ngay trên trang. */
            function openDropdownAdmin() {
                if (!requireAdmin()) return;

                renderDropdownAdmin();
                document.getElementById('dropdownAdminModal').style.display = 'flex';
            }

            /** Đóng khu vực quản lý danh mục. */
            function closeDropdownAdmin() {
                document.getElementById('dropdownAdminModal').style.display = 'none';
            }

            /** Dựng các nhóm danh mục và biểu mẫu thêm item tương ứng. */
            function renderDropdownAdmin() {
                const container = document.getElementById('dropdownAdminGroups');
                container.replaceChildren();

                const displaySection = document.createElement('section');
                displaySection.className = 'border rounded-xl bg-white p-4 flex items-center justify-between gap-4';
                displaySection.innerHTML = `
                    <div>
                        <h4 class="font-bold">Ngày ĐG</h4>
                        <p class="text-sm text-gray-500 mt-1">Cho phép chỉnh sửa ngày đóng gói</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" class="sr-only peer" ${currentDropdownSettings.ngayDGEditable ? 'checked' : ''} onchange="toggleNgayDGEditability(this)">
                        <span class="w-11 h-6 bg-gray-300 peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></span>
                    </label>`;
                container.appendChild(displaySection);

                DROPDOWN_GROUPS.forEach((group) => {
                    const section = document.createElement('section');
                    section.className = 'border rounded-xl overflow-hidden bg-white';

                    const heading = document.createElement('h4');
                    heading.className = 'px-4 py-3 bg-gray-100 font-bold';
                    heading.textContent = group.title;
                    section.appendChild(heading);

                    const list = document.createElement('div');
                    list.className = 'divide-y max-h-56 overflow-auto';
                    currentDropdownSettings[group.key].forEach((item, index) => {
                        const row = document.createElement('div');
                        row.className = 'flex items-center justify-between gap-3 px-4 py-2';

                        const text = document.createElement('span');
                        text.className = 'min-w-0 break-words';
                        if (typeof item === 'object' && item !== null) {
                            const itemValue = String(item.value || '').trim();
                            const itemLabel = String(item.label || itemValue).trim();
                            text.textContent = !itemValue || itemLabel.toLowerCase().startsWith(itemValue.toLowerCase())
                                ? itemLabel
                                : `${itemValue} - ${itemLabel}`;
                        } else {
                            text.textContent = String(item);
                        }

                        const removeButton = document.createElement('button');
                        removeButton.type = 'button';
                        removeButton.title = 'Xóa item';
                        removeButton.className = 'shrink-0 w-9 h-9 text-red-600 hover:bg-red-50 rounded-lg';
                        removeButton.innerHTML = '<i class="fas fa-trash"></i>';
                        removeButton.onclick = () => removeDropdownItem(group.key, index);

                        row.append(text, removeButton);
                        list.appendChild(row);
                    });
                    section.appendChild(list);

                    const form = document.createElement('div');
                    form.className = 'flex gap-2 p-3 border-t bg-gray-50';
                    form.innerHTML = group.structured
                        ? `<input data-field="value" class="w-1/3 min-w-0 px-3 py-2 border rounded-lg" placeholder="${group.valuePlaceholder}">
                           <input data-field="label" class="flex-1 min-w-0 px-3 py-2 border rounded-lg" placeholder="${group.labelPlaceholder}">`
                        : `<input data-field="value" class="flex-1 min-w-0 px-3 py-2 border rounded-lg" placeholder="${group.valuePlaceholder}">`;

                    const addButton = document.createElement('button');
                    addButton.type = 'button';
                    addButton.title = 'Thêm item';
                    addButton.className = 'shrink-0 w-10 h-10 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg';
                    addButton.innerHTML = '<i class="fas fa-plus"></i>';
                    addButton.onclick = () => addDropdownItem(group, form);
                    form.appendChild(addButton);
                    section.appendChild(form);
                    container.appendChild(section);
                });
            }

            /** Lưu lựa chọn khóa/mở chỉnh sửa Ngày ĐG và áp dụng ngay. */
            async function toggleNgayDGEditability(checkbox) {
                if (!requireAdmin()) {
                    checkbox.checked = currentDropdownSettings.ngayDGEditable;
                    return;
                }

                const previousValue = currentDropdownSettings.ngayDGEditable;
                currentDropdownSettings.ngayDGEditable = checkbox.checked;
                applyNgayDGEditability();

                try {
                    await saveDropdownSettings();
                } catch (error) {
                    currentDropdownSettings.ngayDGEditable = previousValue;
                    checkbox.checked = previousValue;
                    applyNgayDGEditability();
                    alert('Không thể lưu tùy chọn Ngày ĐG: ' + error.message);
                }
            }

            /** Lưu toàn bộ danh mục lên Firestore và áp dụng ngay vào biểu mẫu chính. */
            async function saveDropdownSettings() {
                if (!requireAdmin()) throw new Error('Không có quyền quản trị danh mục.');
                if (!firebaseReady || !db) throw new Error('Database chưa sẵn sàng.');
                await db.collection('settings').doc('dropdowns').set(currentDropdownSettings);
                applyDropdownSettings(currentDropdownSettings);
            }

            /** Thêm item mới vào một nhóm danh mục. */
            async function addDropdownItem(group, form) {
                const value = String(form.querySelector('[data-field="value"]')?.value || '').trim();
                const label = String(form.querySelector('[data-field="label"]')?.value || '').trim();
                if (!value || (group.structured && !label)) {
                    alert('Vui lòng nhập đủ thông tin item.');
                    return;
                }

                const items = currentDropdownSettings[group.key];
                const isDuplicate = items.some((item) => String(typeof item === 'object' ? item.value : item).toLowerCase() === value.toLowerCase());
                if (isDuplicate) {
                    alert('Item này đã tồn tại.');
                    return;
                }

                items.push(group.structured ? { value, label } : value);
                try {
                    await saveDropdownSettings();
                    renderDropdownAdmin();
                } catch (error) {
                    items.pop();
                    alert('Không thể lưu item: ' + error.message);
                }
            }

            /** Xóa item khỏi một nhóm sau khi xác nhận. */
            async function removeDropdownItem(groupKey, index) {
                const items = currentDropdownSettings[groupKey];
                if (items.length <= 1) {
                    alert('Mỗi danh mục cần giữ lại ít nhất một item.');
                    return;
                }
                if (!confirm('Bạn có chắc muốn xóa item này?')) return;

                const removed = items.splice(index, 1)[0];
                try {
                    await saveDropdownSettings();
                    renderDropdownAdmin();
                } catch (error) {
                    items.splice(index, 0, removed);
                    alert('Không thể xóa item: ' + error.message);
                }
            }

            /** Bảo đảm select có value cần đồng bộ từ mã lot, kể cả khi chưa có trong cấu hình. */
            function ensureSelectHasValue(selectOrId, value, label = value) {
                const select = typeof selectOrId === 'string'
                    ? document.getElementById(selectOrId)
                    : selectOrId;
                if (!select || value === undefined || value === null) return;

                const stringValue = String(value);
                const exists = Array.from(select.options).some(option => option.value === stringValue);
                if (!exists) {
                    const option = document.createElement('option');
                    option.value = stringValue;
                    option.textContent = String(label ?? value);
                    option.dataset.temporary = 'true';
                    select.appendChild(option);
                }
            }

            /** Tải settings/dropdowns, tự tạo document mặc định và luôn có dữ liệu dự phòng. */
            async function loadDropdownSettings() {
                applyDropdownSettings(DEFAULT_DROPDOWNS);
                if (!firebaseReady || !db) return DEFAULT_DROPDOWNS;

                try {
                    const dropdownRef = db.collection('settings').doc('dropdowns');
                    const snapshot = await dropdownRef.get();
                    let settings = DEFAULT_DROPDOWNS;

                    if (snapshot.exists) {
                        settings = normalizeDropdownSettings(snapshot.data());
                    } else if (currentRole === 'admin') {
                        await dropdownRef.set(DEFAULT_DROPDOWNS);
                    }

                    applyDropdownSettings(settings);
                    return settings;
                } catch (error) {
                    console.error('Không tải được cấu hình dropdown:', error);
                    applyDropdownSettings(DEFAULT_DROPDOWNS);
                    setFirebaseStatus(`⚠️ Không tải được dropdown, đang dùng dữ liệu mặc định: ${error.message}`, true);
                    return DEFAULT_DROPDOWNS;
                }
            }

            counterRef = db.collection("settings").doc("stt_counter");
            firebaseReady = Boolean(firebaseDb);

            // Danh sách sản phẩm và lịch sử in
            let products = [];
            let selectedIndex = -1;
            let printHistory = [];
            let selectedHistoryIds = new Set();
            let packagingDateEditedByUser = false;
            let lastLoadedProductKey = '';
            let lastObservedCounterDate = '';
            let productSttLoadTimer = null;
            let isPrinting = false;

            /** Xác thực mật khẩu trước khi thay đổi danh sách thành phẩm. */
            function verifyProductActionPassword() {
                return requireAdmin();
            }

            /** Chuyển giá trị thành số nguyên dương hoặc dùng giá trị mặc định. */
            function toPositiveInt(value, fallback = 1) {
                const num = Number(value);
                return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
            }

            /** Chuyển giá trị thành số nguyên không âm hoặc dùng giá trị mặc định. */
            function toNonNegativeInt(value, fallback = 0) {
                const num = Number(value);
                return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
            }

            /** Trả về ngày tại Việt Nam theo định dạng YYYY-MM-DD. */
            function getVietnamDateKey(date = new Date()) {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }).formatToParts(date);
                const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
                return `${values.year}-${values.month}-${values.day}`;
            }

            /** Tách đầy đủ các thành phần ngày giờ theo múi giờ Việt Nam. */
            function getVietnamDateTimeParts(date = new Date()) {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hourCycle: 'h23'
                }).formatToParts(date);
                const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
                return {
                    year: Number(values.year),
                    month: Number(values.month),
                    day: Number(values.day),
                    hour: Number(values.hour),
                    minute: Number(values.minute),
                    second: Number(values.second)
                };
            }

            /** Cộng số ngày vào chuỗi ngày YYYY-MM-DD mà không phụ thuộc múi giờ máy. */
            function addDaysToDateKey(dateKey, days) {
                const [year, month, day] = String(dateKey).split('-').map(Number);
                const utcDate = new Date(Date.UTC(year, month - 1, day + days));
                return utcDate.toISOString().slice(0, 10);
            }

            /** Xác định ngày đóng gói hiện hành theo giờ Việt Nam. */
            function getPackagingDateKey(date = new Date()) {
                const vnParts = getVietnamDateTimeParts(date);
                const todayKey = `${String(vnParts.year).padStart(4, '0')}-${String(vnParts.month).padStart(2, '0')}-${String(vnParts.day).padStart(2, '0')}`;
                const secondsOfDay = (vnParts.hour * 3600) + (vnParts.minute * 60) + vnParts.second;
                const cutoffSeconds = (23 * 3600) + (59 * 60) + 59;
                return secondsOfDay > cutoffSeconds ? addDaysToDateKey(todayKey, 1) : todayKey;
            }

            /** Đồng bộ ngày đóng gói tự động khi người dùng chưa sửa thủ công. */
            function syncNgayDongGoi() {
                const ngayDGInput = document.getElementById('ngayDG');
                if (!ngayDGInput) return;

                const packagingDate = getPackagingDateKey();
                if (!ngayDGInput.value || !packagingDateEditedByUser) {
                    if (ngayDGInput.value !== packagingDate) {
                        ngayDGInput.value = packagingDate;
                    }
                    updateLotByRules();
                    updatePreview();
                }
            }

            /** Ghi nhận việc sửa ngày đóng gói và cập nhật mã lot, bản xem trước. */
            function handleNgayDongGoiInput() {
                packagingDateEditedByUser = true;
                updateLotByRules();
                updatePreview();
            }

            /** Kiểm tra ngày đóng gói định kỳ để tự chuyển ngày khi cần. */
            function scheduleNgayDongGoiSync() {
                syncNgayDongGoi();

                const currentCounterDate = getVietnamDateKey();
                if (currentCounterDate !== lastObservedCounterDate) {
                    lastObservedCounterDate = currentCounterDate;
                    lastLoadedProductKey = '';
                    loadProductSTT(true);
                }

                window.setTimeout(scheduleNgayDongGoiSync, 1000);
            }

            /** Tạo khóa ổn định đại diện cho thành phẩm hiện tại. */
            function getProductKey() {
                const sku = (document.getElementById('sku').value || '').trim();
                const tenTP = (document.getElementById('tenTP').value || '').trim();
                const raw = sku || tenTP || 'unknown';
                return `p_${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            }

            /** Tạo khóa bộ đếm STT riêng theo ngày và thành phẩm. */
            function getDailyProductCounterKey() {
                const productKey = getProductKey();
                return `${getVietnamDateKey()}__${productKey}`;
            }

            /** Đảm bảo bộ đếm của thành phẩm hiện tại đã được tải. */
            async function ensureCurrentProductCounterLoaded() {
                const counterKey = getDailyProductCounterKey();
                if (!counterKey || counterKey === lastLoadedProductKey) return;
                await loadProductSTT(true);
            }

            /** Trì hoãn việc tải STT để tránh truy vấn liên tục khi người dùng nhập. */
            function scheduleLoadProductSTT() {
                if (isPrinting) return;
                clearTimeout(productSttLoadTimer);
                productSttLoadTimer = setTimeout(() => {
                    loadProductSTT();
                }, 250);
            }

            const FIRST_STT = 1;

            /** Tải STT tiếp theo của thành phẩm trong ngày từ Firestore. */
            async function loadProductSTT(force = false) {
                if (isPrinting) return;
                const productKey = getProductKey();
                const counterKey = getDailyProductCounterKey();
                if (!productKey || !counterKey || (!force && counterKey === lastLoadedProductKey)) return;

                try {
                    const doc = await db.collection("productCounters").doc(counterKey).get();
                    const saved = doc.exists ? doc.data() : null;
                    const nextStart = toPositiveInt(saved ? saved.nextSTT : null, FIRST_STT);
                    document.getElementById('sttDau').value = nextStart;
                    updateSttCuoi();
                    lastLoadedProductKey = counterKey;
                } catch (e) {
                    console.error(e);
                }
            }

            /** Lưu STT tiếp theo và thông tin lần in gần nhất vào Firestore. */
            async function saveProductSTT(nextSTT, sttDau, sttCuoi) {
                if (!requireSignedIn()) throw new Error('Người dùng chưa đăng nhập.');
                const productKey = getProductKey();
                const counterKey = getDailyProductCounterKey();
                if (!productKey || !counterKey) return;

                try {
                    await db.collection("productCounters").doc(counterKey).set({
                        counterKey,
                        counterDate: getVietnamDateKey(),
                        productKey,
                        sku: document.getElementById('sku').value || '',
                        tenTP: document.getElementById('tenTP').value || '',
                        maBTP: document.getElementById('maBTP').value || '',
                        nextSTT: nextSTT,
                        lastSttDau: sttDau,
                        lastSttCuoi: sttCuoi,
                        updatedBy: currentUser.uid,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    lastLoadedProductKey = counterKey;
                } catch (e) {
                    console.error(e);
                }
            }

            // ==================== TẢI DỮ LIỆU SẢN PHẨM TỪ FIREBASE ====================
            /** Theo dõi thay đổi danh sách thành phẩm theo thời gian thực. */
            function loadProductsFromFirebase() {
                if (!firebaseReady || !db) {
                    setFirebaseStatus("⚠️ Chưa kết nối database để tải dữ liệu", true);
                    return;
                }
                db.collection("thanhpham").orderBy("stt").onSnapshot((snapshot) => {
                    products = [];
                    snapshot.forEach((doc) => {
                        products.push({ id: doc.id, ...doc.data() });
                    });
                    populateGrid();
                });
            }

            // ==================== TẢI LỊCH SỬ IN TEM ====================
            /** Theo dõi lịch sử in và cập nhật các chỉ số báo cáo. */
            function loadPrintHistory() {
                if (!firebaseReady || !db) {
                    setFirebaseStatus("⚠️ Chưa kết nối database để tải lịch sử", true);
                    return;
                }
                db.collection("printHistory").orderBy("timestamp", "desc").onSnapshot((snapshot) => {
                    printHistory = [];
                    let total = 0;
                    snapshot.forEach(doc => {
                        const data = doc.data();
                        data.id = doc.id;
                        printHistory.push(data);
                        total += (data.soLuong || 0);
                    });

                    document.getElementById('totalTem').textContent = total.toLocaleString('vi-VN');
                    document.getElementById('lastSTT').textContent = printHistory.length ? printHistory[0].sttCuoi : 0;
                    document.getElementById('temHong').textContent = "0";
                    document.getElementById('lastUpdate').textContent = printHistory.length ?
                        new Date(printHistory[0].timestamp?.toDate() || Date.now()).toLocaleString('vi-VN') : "Chưa có";

                    renderHistoryTable();
                });
            }

            // ==================== HIỂN THỊ BẢNG LỊCH SỬ ====================
            /** Dựng lại bảng lịch sử in từ dữ liệu hiện có. */
            function renderHistoryTable() {
                let html = `
                    <thead class="bg-gray-50 sticky top-0">
                        <tr>
                            <th class="px-4 py-3 text-center w-10"><input type="checkbox" id="headerCheckbox" onchange="toggleAllCheckboxes(this)"></th>
                            <th class="px-4 py-3 text-left">Thời gian</th>
                            <th class="px-4 py-3 text-left">Mã Lot</th>
                            <th class="px-4 py-3 text-left">SKU</th>
                            <th class="px-4 py-3 text-left">Tên TP</th>
                            <th class="px-4 py-3 text-center">Tổ/Nhóm</th>
                            <th class="px-4 py-3 text-center">Số lượng</th>
                            <th class="px-4 py-3 text-center">STT đầu</th>
                            <th class="px-4 py-3 text-center">STT cuối</th>
                            <th class="px-4 py-3 text-right">Quy Cách</th>
                            <th class="px-4 py-3 text-right">Tổng KL (kg)</th>
                        </tr>
                    </thead>
                    <tbody>`;

                printHistory.forEach(item => {
                    const kg = parseFloat(item.quyCach) || 20;
                    const tongKL = (item.soLuong * kg).toFixed(0);
                    const isChecked = selectedHistoryIds.has(item.id);

                    html += `
                        <tr class="border-b hover:bg-gray-50" data-id="${item.id}">
                            <td class="px-4 py-3 text-center">
                                <input type="checkbox" class="history-checkbox"
                                    onchange="toggleHistorySelection('${item.id}', this)"
                                    ${isChecked ? 'checked' : ''}>
                            </td>
                            <td class="px-4 py-3 text-xs">${escapeHtml(new Date(item.timestamp?.toDate() || item.timestamp).toLocaleString('vi-VN'))}</td>
                            <td class="px-4 py-3 font-mono">${escapeHtml(item.maBTP)}</td>
                            <td class="px-4 py-3 font-mono">${escapeHtml(item.sku)}</td>
                            <td class="px-4 py-3">${escapeHtml(item.tenTP)}</td>
                            <td class="px-4 py-3 text-center">${escapeHtml(item.toSanXuat || 'Tèo')}</td>
                            <td class="px-4 py-3 text-center font-semibold">${escapeHtml(item.soLuong || 0)}</td>
                            <td class="px-4 py-3 text-center font-mono">${escapeHtml(item.sttDau || 0)}</td>
                            <td class="px-4 py-3 text-center font-mono">${escapeHtml(item.sttCuoi || 0)}</td>
                            <td class="px-4 py-3 text-right">${escapeHtml(item.quyCach)}</td>
                            <td class="px-4 py-3 text-right font-bold">${escapeHtml(tongKL)} kg</td>
                        </tr>`;
                });
                html += `</tbody>`;
                document.getElementById('historyTable').innerHTML = html;
            }

            /** Thêm hoặc bỏ một bản ghi khỏi tập đang chọn. */
            function toggleHistorySelection(id, checkbox) {
                if (checkbox.checked) {
                    selectedHistoryIds.add(id);
                } else {
                    selectedHistoryIds.delete(id);
                }
            }

            /** Đồng bộ trạng thái chọn của tất cả bản ghi đang hiển thị. */
            function toggleAllCheckboxes(headerCheckbox) {
                const checkboxes = document.querySelectorAll('.history-checkbox');
                checkboxes.forEach(cb => {
                    cb.checked = headerCheckbox.checked;
                    const id = cb.closest('tr').dataset.id;
                    if (headerCheckbox.checked) selectedHistoryIds.add(id);
                    else selectedHistoryIds.delete(id);
                });
            }

            /** Đảo trạng thái của ô chọn tất cả. */
            function toggleSelectAll() {
                const header = document.getElementById('headerCheckbox');
                if (header) {
                    header.checked = !header.checked;
                    toggleAllCheckboxes(header);
                }
            }

            // ==================== IN LẠI TỪ LỊCH SỬ ====================
            /** Nạp một bản ghi lịch sử vào biểu mẫu để in lại. */
            function reprintFromHistory() {
                if (selectedHistoryIds.size === 0) {
                    alert("Vui lòng tích chọn ít nhất một bản ghi để in lại!");
                    return;
                }
                if (selectedHistoryIds.size > 1) {
                    alert("Chỉ hỗ trợ in lại một bản ghi một lúc. Vui lòng chọn duy nhất 1 item.");
                    return;
                }

                const id = Array.from(selectedHistoryIds)[0];
                const item = printHistory.find(p => p.id === id);
                if (!item) {
                    alert("Không tìm thấy dữ liệu!");
                    return;
                }

                switchTab(0);

                document.getElementById('maBTP').value = item.maBTP || '';
                document.getElementById('sku').value = item.sku || '';
                document.getElementById('tenTP').value = item.tenTP || '';
                document.getElementById('quyCach').value = item.quyCach || '20kg';
                document.getElementById('toSanXuat').value = item.toSanXuat || 'Tèo';
                syncControlsFromLot();
                document.getElementById('sttDau').value = Number.isFinite(item.sttDau) ? item.sttDau : 0;
                document.getElementById('soLuongTem').value = item.soLuong || 1;
                updateSttCuoi();
                updatePreview();

                setTimeout(() => {
                    alert(`✅ Đã load thông tin in lại cho STT ${item.sttDau || ''} - ${item.sttCuoi || ''}\nHãy bấm nút "IN LẠI" màu cam để in lại.`);
                }, 400);
            }

            // ==================== XÓA BẢN GHI ĐÃ CHỌN ====================
            /** Xóa các bản ghi lịch sử được chọn bằng một batch Firestore. */
            async function deleteSelectedHistory() {
                if (!requireAdmin()) return;
                if (selectedHistoryIds.size === 0) {
                    alert("Vui lòng tích chọn ít nhất một bản ghi để xóa!");
                    return;
                }
                if (!confirm(`Bạn có chắc muốn xóa ${selectedHistoryIds.size} bản ghi lịch sử?`)) return;

                try {
                    const batch = db.batch();
                    selectedHistoryIds.forEach(id => {
                        batch.delete(db.collection("printHistory").doc(id));
                    });
                    await batch.commit();
                    alert(`✅ Đã xóa ${selectedHistoryIds.size} bản ghi!`);
                    selectedHistoryIds.clear();
                } catch (error) {
                    alert("Lỗi: " + error.message);
                }
            }

            // ==================== XUẤT BÁO CÁO RA EXCEL ====================
            /** Xuất toàn bộ lịch sử in hiện tại thành tệp Excel. */
            function exportReportExcel() {
                if (printHistory.length === 0) return alert("Chưa có dữ liệu!");
                const data = printHistory.map(item => ({
                    "Thời gian": new Date(item.timestamp?.toDate() || item.timestamp).toLocaleString('vi-VN'),
                    "Mã Lot": item.maBTP,
                    "SKU": item.sku,
                    "Tên Thành Phẩm": item.tenTP,
                    "Tổ/Nhóm": item.toSanXuat || 'Tèo',
                    "Số lượng tem": item.soLuong,
                    "Quy Cách": item.quyCach,
                    "Tổng khối lượng (kg)": item.soLuong * (parseFloat(item.quyCach) || 20)
                }));
                const ws = XLSX.utils.json_to_sheet(data);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "BaoCao");
                XLSX.writeFile(wb, `BaoCao_In_${new Date().toISOString().slice(0,10)}.xlsx`);
            }

            // ==================== GHI LỊCH SỬ IN TEM ====================
            /** Ghi thông tin lần in mới vào lịch sử Firestore. */
            async function logPrint() {
                if (!requireSignedIn()) throw new Error('Người dùng chưa đăng nhập.');
                const data = {
                    maBTP: document.getElementById('maBTP').value || '',
                    sku: document.getElementById('sku').value || '',
                    tenTP: document.getElementById('tenTP').value || '',
                    toSanXuat: document.getElementById('toSanXuat').value || 'Tèo',
                    quyCach: document.getElementById('quyCach').value || '20kg',
                    soLuong: parseInt(document.getElementById('soLuongTem').value) || 1,
                    sttDau: toPositiveInt(document.getElementById('sttDau').value, FIRST_STT),
                    sttCuoi: toPositiveInt(document.getElementById('sttCuoi').value, FIRST_STT),
                    productKey: getProductKey(),
                    counterDate: getVietnamDateKey(),
                    createdBy: currentUser.uid,
                    timestamp: firebase.firestore.FieldValue.serverTimestamp()
                };
                await db.collection("printHistory").add(data);
            }

            /** In một tài liệu HTML trong iframe tạm và dọn tài nguyên sau khi hoàn tất. */
            function printHtmlOnce(html, { waitForAfterPrint = false } = {}) {
                return new Promise((resolve, reject) => {
                    const iframe = document.createElement('iframe');
                    iframe.style.position = 'fixed';
                    iframe.style.right = '0';
                    iframe.style.bottom = '0';
                    iframe.style.width = '0';
                    iframe.style.height = '0';
                    iframe.style.border = '0';
                    iframe.setAttribute('aria-hidden', 'true');
                    document.body.appendChild(iframe);

                    const cleanup = () => {
                        if (iframe && iframe.parentNode) {
                            iframe.parentNode.removeChild(iframe);
                        }
                    };

                    const doc = iframe.contentWindow?.document;
                    if (!doc || !iframe.contentWindow) {
                        cleanup();
                        reject(new Error('Không khởi tạo được tài liệu in.'));
                        return;
                    }

                    let done = false;
                    const complete = (result = { status: 'completed' }) => {
                        if (done) return;
                        done = true;
                        cleanup();
                        resolve(result);
                    };

                    const waitForDocumentReady = async () => {
                        const images = Array.from(doc.images || []);
                        const imagePromises = images
                            .filter((img) => !img.complete)
                            .map((img) => new Promise((resolveImage) => {
                                const finish = () => resolveImage();
                                img.addEventListener('load', finish, { once: true });
                                img.addEventListener('error', finish, { once: true });
                            }));

                        if (imagePromises.length) {
                            await Promise.all(imagePromises);
                        }

                        if (doc.fonts && doc.fonts.ready) {
                            try {
                                await Promise.race([
                                    doc.fonts.ready,
                                    new Promise((resolveFontTimeout) => setTimeout(resolveFontTimeout, 1200))
                                ]);
                            } catch (e) {
                                console.error(e);
                            }
                        }

                        await new Promise((rafDone) => requestAnimationFrame(() => requestAnimationFrame(rafDone)));
                    };

                    const handleLoad = async () => {
                        const printWin = iframe.contentWindow;
                        if (!printWin) {
                            cleanup();
                            reject(new Error('Không truy cập được cửa sổ in.'));
                            return;
                        }

                        try {
                            await waitForDocumentReady();
                        } catch (error) {
                            console.error(error);
                        }

                        printWin.onafterprint = () => {
                            complete({ status: 'afterprint' });
                        };

                        setTimeout(() => {
                            try {
                                printWin.focus();
                                printWin.print();
                                if (!waitForAfterPrint) {
                                    complete({ status: 'print-started' });
                                }
                            } catch (error) {
                                cleanup();
                                reject(error);
                            }
                        }, 80);

                        if (waitForAfterPrint) {
                            // Một số trình duyệt hoặc trình điều khiển không phát sự kiện sau khi in.
                            setTimeout(() => complete({ status: 'timeout-fallback' }), 20000);
                        }
                    };

                    iframe.addEventListener('load', handleLoad, { once: true });
                    doc.open();
                    doc.write(html);
                    doc.close();
                });
            }

            // ==================== IN NHÃN THỰC TẾ ====================
            /** Tạo các nhãn, mở hộp thoại in và cập nhật lịch sử sau khi xác nhận thành công. */
            async function printLabels(isReprint = false) {
                if (isPrinting) return;

                clearTimeout(productSttLoadTimer);
                productSttLoadTimer = null;

                await ensureCurrentProductCounterLoaded();

                updateSttCuoi();

                const sttDau = toPositiveInt(document.getElementById('sttDau').value, FIRST_STT);
                const count = toPositiveInt(document.getElementById('soLuongTem').value, 1);
                const sttCuoi = sttDau + count - 1;
                const labelSnapshot = getLabelSnapshotData();

                isPrinting = true;

                const printStyles = `
                    <style>
                        @page { size: 90mm 60mm; margin: 0mm !important; }
                        html, body {
                            width: 90mm;
                            margin: 0 !important;
                            padding: 0 !important;
                            background: #ffffff !important;
                            color: #000000 !important;
                            font-family: Tahoma, Arial, sans-serif;
                            font-weight: 700;
                            letter-spacing: -0.2px;
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        .label {
                            width: 90mm;
                            height: 60mm;
                            display: block;
                            box-sizing: border-box;
                            overflow: hidden;
                            background: #ffffff !important;
                            color: #000000 !important;
                            page-break-after: always;
                        }
                        .label:last-child { page-break-after: auto; }
                        .lbl-inner {
                            padding: 1.2mm 3.5mm 1.8mm 3.5mm;
                            height: 100%;
                            box-sizing: border-box;
                            background: #ffffff !important;
                            color: #000000 !important;
                            font-size: 9.0pt;
                            line-height: 1.15;
                        }
                        .lbl-row { display: flex; justify-content: space-between; margin-bottom: 3px; }
                        .lbl-top { font-size: 7.8pt; font-weight: 700; }
                        .lbl-name { font-size: 12.8pt; font-weight: 800; text-align: center; margin: 4px 0 6px; line-height: 1.05; }
                        .lbl-rule { border: 0; border-top: 1px solid #000; margin: 3px 0 5px; }
                        .lbl-right { text-align: right; }
                        .lbl-index { font-size: 15.8pt; font-weight: 800; }
                        .lbl-region { margin-bottom: 3px; font-weight: 700; }
                        .lbl-date { display: flex; justify-content: space-between; font-size: 9.0pt; margin-top: 5px; }
                    </style>
                `;

                try {
                    const labelHtml = new Array(count);
                    for (let i = 0; i < count; i++) {
                        labelHtml[i] = `<div class="label">${buildLabelHtmlCompact(sttDau + i, labelSnapshot)}</div>`;
                    }

                    const printHtml = `<html><head><title>${isReprint ? 'In Lại' : 'In Nhãn'}</title>${printStyles}</head><body>${labelHtml.join('')}</body></html>`;
                    await printHtmlOnce(printHtml, { waitForAfterPrint: true });

                    if (!isReprint) {
                        const confirmedPrinted = confirm('Máy in đã in thành công chưa?\nChọn OK nếu đã in thành công để ghi lịch sử và tăng STT.\nChọn Cancel nếu máy in lỗi hoặc chưa in để giữ nguyên STT.');
                        if (!confirmedPrinted) {
                            alert('Đã giữ nguyên STT và không ghi lịch sử in vì chưa xác nhận in thành công.');
                            return;
                        }

                        const nextSTT = sttCuoi + 1;
                        document.getElementById('sttDau').value = nextSTT;
                        updateSttCuoi();

                        Promise.allSettled([
                            logPrint(),
                            saveProductSTT(nextSTT, sttDau, sttCuoi)
                        ]).catch((e) => console.error(e));
                    } else {
                        alert(`✅ Đã in lại ${count} tem (KHÔNG ghi log - KHÔNG tăng tổng số lượng)`);
                    }
                } finally {
                    isPrinting = false;
                }
            }

            /** Chụp dữ liệu biểu mẫu tại thời điểm bắt đầu in hoặc xuất PDF. */
            function getLabelSnapshotData() {
                const sku = (document.getElementById('sku').value || '').trim();
                const maBTP = (document.getElementById('maBTP').value || 'LOT').trim();
                const tenTP = (document.getElementById('tenTP').value || 'TP CẤP ĐÔNG SẦU RIÊNG...').trim();
                const toSanXuat = (document.getElementById('toSanXuat').value || 'Tèo').trim();
                const quyCach = (document.getElementById('quyCach').value || '20kg').trim();
                const regionSelect = document.getElementById('vungNguyenLieu');
                const selectedRegionText = regionSelect && regionSelect.selectedOptions[0]
                    ? regionSelect.selectedOptions[0].textContent || ''
                    : '';
                const vungFull = selectedRegionText.includes(' - ')
                    ? selectedRegionText.split(' - ')[1].trim()
                    : (selectedRegionText || 'Miền Tây');
                const ngaySX = document.getElementById('ngaySX').value ? document.getElementById('ngaySX').value.split('-').reverse().join('/') : '22/06/2026';
                const ngayDG = document.getElementById('ngayDG').value ? document.getElementById('ngayDG').value.split('-').reverse().join('/') : ngaySX;
                return { sku, maBTP, tenTP, toSanXuat, quyCach, vungFull, ngaySX, ngayDG };
            }

            /** Chia văn bản thành các dòng vừa với chiều rộng canvas. */
            function wrapTextLines(ctx, text, maxWidth) {
                const words = String(text || '').trim().split(/\s+/).filter(Boolean);
                if (!words.length) return [];

                const lines = [];
                let currentLine = words[0];

                for (let i = 1; i < words.length; i++) {
                    const candidate = `${currentLine} ${words[i]}`;
                    if (ctx.measureText(candidate).width <= maxWidth) {
                        currentLine = candidate;
                    } else {
                        lines.push(currentLine);
                        currentLine = words[i];
                    }
                }

                if (currentLine) lines.push(currentLine);
                return lines;
            }

            /** Co chữ và căn giữa văn bản nhiều dòng trong vùng giới hạn. */
            function drawFittedWrappedCenterText(ctx, text, centerX, boxTop, boxHeight, maxWidth, maxLines, maxFontSize, minFontSize) {
                const safeText = String(text || '').trim();
                if (!safeText) return;

                let chosenSize = minFontSize;
                let chosenLines = [safeText];

                for (let size = maxFontSize; size >= minFontSize; size--) {
                    ctx.font = `800 ${size}px Tahoma, Arial, sans-serif`;
                    const lines = wrapTextLines(ctx, safeText, maxWidth);
                    if (lines.length <= maxLines) {
                        chosenSize = size;
                        chosenLines = lines;
                        break;
                    }
                    if (size === minFontSize) {
                        chosenSize = size;
                        chosenLines = lines.slice(0, maxLines);
                    }
                }

                const lineHeight = Math.round(chosenSize * 1.08);
                const totalHeight = chosenLines.length * lineHeight;
                const startY = boxTop + Math.max(0, Math.floor((boxHeight - totalHeight) / 2));

                ctx.font = `800 ${chosenSize}px Tahoma, Arial, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                for (let i = 0; i < chosenLines.length; i++) {
                    ctx.fillText(chosenLines[i], centerX, startY + i * lineHeight);
                }
            }

            /** Vẽ phần nội dung cố định của nhãn lên canvas độ phân giải cao. */
            function createLabelTemplateCanvas(data) {
                const width = 900;
                const height = 600;
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Không tạo được canvas.');

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 3;
                ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

                ctx.fillStyle = '#000000';
                ctx.textBaseline = 'top';

                ctx.font = '700 24px Tahoma, Arial, sans-serif';
                ctx.textAlign = 'left';
                if (data.sku) ctx.fillText(`Mã SKU: ${data.sku}`, 34, 28);
                ctx.textAlign = 'right';
                ctx.fillText(`Lot: ${data.maBTP}`, 866, 28);

                drawFittedWrappedCenterText(ctx, data.tenTP, width / 2, 48, 150, 790, 3, 44, 30);

                ctx.beginPath();
                ctx.moveTo(28, 196);
                ctx.lineTo(872, 196);
                ctx.lineWidth = 3;
                ctx.stroke();

                ctx.textAlign = 'left';
                ctx.font = '700 24px Tahoma, Arial, sans-serif';
                ctx.fillText('Quy Cách /SPEC', 34, 214);
                ctx.font = '700 32px Tahoma, Arial, sans-serif';
                ctx.fillText(`Thùng/túi: ${data.quyCach}`, 34, 246);

                ctx.textAlign = 'right';
                ctx.font = '700 24px Tahoma, Arial, sans-serif';
                ctx.fillText('KHỐI LƯỢNG /WEIGHT', 866, 214);
                ctx.font = '700 36px Tahoma, Arial, sans-serif';
                ctx.fillText(data.quyCach, 866, 246);

                ctx.textAlign = 'left';
                ctx.font = '700 24px Tahoma, Arial, sans-serif';
                ctx.fillText('TỔ/NHÓM', 34, 304);
                ctx.font = '800 34px Tahoma, Arial, sans-serif';
                ctx.fillText(data.toSanXuat || 'Tèo', 34, 336);

                ctx.textAlign = 'right';
                ctx.font = '700 24px Tahoma, Arial, sans-serif';
                ctx.fillText('STT/INDEX', 866, 304);

                ctx.textAlign = 'left';
                ctx.font = '700 26px Tahoma, Arial, sans-serif';
                ctx.fillText('VÙNG NGUYÊN LIỆU', 34, 404);
                ctx.font = '800 34px Tahoma, Arial, sans-serif';
                ctx.fillText(data.vungFull, 34, 438);

                ctx.font = '700 30px Tahoma, Arial, sans-serif';
                ctx.fillText(`Ngày SX: ${data.ngaySX}`, 34, 530);
                ctx.textAlign = 'right';
                ctx.fillText(`Ngày ĐG: ${data.ngayDG}`, 866, 530);

                return canvas;
            }

            /** Tạo nhanh tệp PDF nhiều trang từ mẫu canvas và STT thay đổi. */
            async function exportPdfFast(JsPDFCtor, filename, sttDau, count) {
                const template = createLabelTemplateCanvas(getLabelSnapshotData());
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = template.width;
                pageCanvas.height = template.height;
                const pageCtx = pageCanvas.getContext('2d');
                if (!pageCtx) throw new Error('Không tạo được canvas trang PDF.');

                const doc = new JsPDFCtor({
                    orientation: 'landscape',
                    unit: 'mm',
                    format: [90, 60],
                    compress: true
                });

                for (let i = 0; i < count; i++) {
                    pageCtx.fillStyle = '#ffffff';
                    pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
                    pageCtx.drawImage(template, 0, 0);

                    pageCtx.fillStyle = '#000000';
                    pageCtx.textAlign = 'right';
                    pageCtx.textBaseline = 'top';
                    pageCtx.font = '800 74px Tahoma, Arial, sans-serif';
                    pageCtx.fillText(String(sttDau + i), 866, 336);

                    const imgData = pageCanvas.toDataURL('image/jpeg', 0.72);
                    if (i > 0) doc.addPage([90, 60], 'landscape');
                    doc.addImage(imgData, 'JPEG', 0, 0, 90, 60, undefined, 'FAST');

                    // Nhường luồng xử lý định kỳ để giao diện không bị treo khi xuất nhiều trang.
                    if ((i + 1) % 10 === 0) {
                        await new Promise((resolve) => setTimeout(resolve, 0));
                    }
                }

                doc.save(filename);
            }

            /** Tải nhãn dưới dạng PDF, ưu tiên jsPDF và dùng html2pdf khi cần. */
            async function downloadPdfLabels() {
                if (isPrinting) {
                    alert('Hệ thống đang xử lý in, vui lòng đợi xong rồi tải PDF.');
                    return;
                }

                const JsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : (window.jsPDF || null);
                const canUseHtml2Pdf = typeof html2pdf !== 'undefined';

                if (!JsPDFCtor && !canUseHtml2Pdf) {
                    alert('Thiếu thư viện xuất PDF. Vui lòng kiểm tra mạng rồi tải lại trang.');
                    return;
                }

                clearTimeout(productSttLoadTimer);
                productSttLoadTimer = null;

                await ensureCurrentProductCounterLoaded();

                updateSttCuoi();

                const sttDau = toPositiveInt(document.getElementById('sttDau').value, FIRST_STT);
                const count = toPositiveInt(document.getElementById('soLuongTem').value, 1);
                const sttCuoi = sttDau + count - 1;
                const lot = (document.getElementById('maBTP').value || 'LOT').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
                const filename = `Nhan_${lot}_${sttDau}-${sttCuoi}.pdf`;

                try {
                    if (JsPDFCtor) {
                        await exportPdfFast(JsPDFCtor, filename, sttDau, count);
                        return;
                    }

                    // Phương án dự phòng chỉ được dùng khi jsPDF không khả dụng.
                    const wrapper = document.createElement('div');
                    wrapper.style.position = 'fixed';
                    wrapper.style.left = '0';
                    wrapper.style.top = '0';
                    wrapper.style.background = '#fff';
                    wrapper.style.opacity = '1';
                    wrapper.style.pointerEvents = 'none';
                    wrapper.style.zIndex = '-1';

                    const exportStyles = document.createElement('style');
                    exportStyles.textContent = `
                        .pdf-label {
                            width: 90mm;
                            height: 60mm;
                            padding: 1.2mm 3.5mm 1.8mm 3.5mm;
                            box-sizing: border-box;
                            font-family: Tahoma, Arial, sans-serif;
                            font-size: 9.0pt;
                            line-height: 1.15;
                            font-weight: 700;
                            letter-spacing: -0.2px;
                            page-break-after: always;
                        }
                        .pdf-label:last-child { page-break-after: auto; }
                    `;
                    wrapper.appendChild(exportStyles);

                    for (let i = 0; i < count; i++) {
                        const label = document.createElement('div');
                        label.className = 'pdf-label';
                        label.innerHTML = buildLabelHtml(sttDau + i);
                        wrapper.appendChild(label);
                    }

                    document.body.appendChild(wrapper);
                    try {
                        await html2pdf().set({
                            margin: 0,
                            filename,
                            image: { type: 'jpeg', quality: 0.75 },
                            html2canvas: { scale: 0.9, useCORS: true, backgroundColor: '#ffffff', logging: false },
                            pagebreak: { mode: ['css', 'legacy'] },
                            jsPDF: { unit: 'mm', format: [90, 60], orientation: 'landscape' }
                        }).from(wrapper).save();
                    } finally {
                        if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
                    }
                } catch (error) {
                    alert('Lỗi khi tạo PDF: ' + (error?.message || error));
                }
            }


            // ==================== IMPORT DỮ LIỆU TỪ EXCEL ====================
            /** Đọc tệp Excel, chuẩn hóa các cột và nhập thành phẩm vào Firestore. */
            async function importExcel(input) {
                if (!requireAdmin()) {
                    input.value = '';
                    return;
                }
                if (!firebaseReady || !db) {
                    alert('Database chưa sẵn sàng. Vui lòng tải lại trang rồi thử lại.');
                    input.value = '';
                    return;
                }
                const file = input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });
                        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });

                        if (!rows.length) {
                            alert('File Excel trống!');
                            return;
                        }

                        const normalizeHeaderKey = (value) => String(value || '')
                            .normalize('NFD')
                            .replace(/[\u0300-\u036f]/g, '')
                            .toLowerCase()
                            .replace(/[^a-z0-9]/g, '');

                        const headerRow = (rows[0] || []).map(normalizeHeaderKey);
                        const sttHeaderIndex = headerRow.findIndex(h => ['stt', 'sothutu'].includes(h));
                        const maSpHeaderIndex = headerRow.findIndex(h => ['masp', 'sku', 'masanpham'].includes(h));
                        const tenTpHeaderIndex = headerRow.findIndex(h => ['tentp', 'tenthanhpham'].includes(h));
                        const loaiHeaderIndex = headerRow.findIndex(h => ['loai', 'loaihang', 'loaithanhpham'].includes(h));

                        const hasHeader = maSpHeaderIndex !== -1 || tenTpHeaderIndex !== -1 || loaiHeaderIndex !== -1;
                        const startRow = hasHeader ? 1 : 0;
                        const sttIndex = sttHeaderIndex !== -1 ? sttHeaderIndex : 0;
                        const defaultMaSpIndex = rows[0] && rows[0].length >= 3 ? 1 : 0;
                        const defaultTenTpIndex = rows[0] && rows[0].length >= 3 ? 2 : 1;
                        const defaultLoaiIndex = rows[0] && rows[0].length >= 4 ? 3 : -1;
                        const maSpIndex = maSpHeaderIndex !== -1 ? maSpHeaderIndex : defaultMaSpIndex;
                        const tenTpIndex = tenTpHeaderIndex !== -1 ? tenTpHeaderIndex : defaultTenTpIndex;
                        const loaiIndex = loaiHeaderIndex !== -1 ? loaiHeaderIndex : defaultLoaiIndex;

                        const newProducts = [];
                        for (let i = startRow; i < rows.length; i++) {
                            const row = rows[i] || [];
                            const maSP = String(row[maSpIndex] || '').trim();
                            const tenTP = String(row[tenTpIndex] || '').trim();
                            const loai = normalizeProductLoai(loaiIndex >= 0 ? row[loaiIndex] : '', tenTP);
                            if (!maSP && !tenTP) continue;

                            newProducts.push({
                                stt: parseInt(row[sttIndex], 10) || (newProducts.length + 1),
                                maSP,
                                tenTP,
                                loai,
                                timestamp: new Date().toISOString()
                            });
                        }

                        if (newProducts.length === 0) return alert("Không tìm thấy dữ liệu!");
                        if (confirm(`Import ${newProducts.length} sản phẩm?`)) {
                            const batch = db.batch();
                            newProducts.forEach((p) => {
                                const ref = db.collection("thanhpham").doc();
                                batch.set(ref, p);
                            });
                            await batch.commit();
                            alert(`✅ Import thành công!`);
                        }
                    } catch (err) {
                        alert("Lỗi: " + err.message);
                    } finally {
                        input.value = '';
                    }
                };
                reader.readAsArrayBuffer(file);
            }

            // ==================== THÊM THÀNH PHẨM TỪ FORM HIỆN TẠI ====================
            /** Thêm thành phẩm đang nhập trên biểu mẫu chính vào danh sách. */
            async function addThanhPhamFromForm() {
                if (!verifyProductActionPassword()) return;

                if (!firebaseReady || !db) {
                    alert('Database chưa sẵn sàng. Vui lòng tải lại trang rồi thử lại.');
                    return;
                }

                const maSP = String(document.getElementById('sku').value || '').trim();
                const tenTP = String(document.getElementById('tenTP').value || '').trim();
                const loai = normalizeProductLoai(document.getElementById('loaiHang')?.value || '', tenTP);

                if (!tenTP) {
                    alert('Vui lòng nhập Tên Thành Phẩm trước khi thêm!');
                    return;
                }

                try {
                    if (maSP) {
                        const existed = await db.collection('thanhpham').where('maSP', '==', maSP).limit(1).get();

                        if (!existed.empty) {
                            const doc = existed.docs[0];
                            await db.collection('thanhpham').doc(doc.id).set({
                                maSP,
                                tenTP,
                                loai,
                                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                            }, { merge: true });
                            alert('✅ Đã cập nhật thành phẩm đã tồn tại trong danh sách!');
                            return;
                        }
                    }

                    const maxStt = products.reduce((max, p) => {
                        const current = parseInt(p.stt, 10) || 0;
                        return current > max ? current : max;
                    }, 0);

                    await db.collection('thanhpham').add({
                        stt: maxStt + 1,
                        maSP,
                        tenTP,
                        loai,
                        timestamp: new Date().toISOString(),
                        createdAt: firebase.firestore.FieldValue.serverTimestamp()
                    });

                    alert('✅ Đã thêm thành phẩm vào danh sách!');
                } catch (error) {
                    alert('Lỗi khi thêm thành phẩm: ' + error.message);
                }
            }

            /** Thêm hoặc cập nhật thành phẩm từ biểu mẫu trong cửa sổ danh sách. */
            async function addThanhPhamManual() {
                if (!requireAdmin()) return;
                if (!firebaseReady || !db) {
                    alert('Database chưa sẵn sàng. Vui lòng tải lại trang rồi thử lại.');
                    return;
                }

                const stt = parseInt(document.getElementById('addStt').value, 10);
                const maSP = String(document.getElementById('addSku').value || '').trim();
                const tenTP = String(document.getElementById('addTenTP').value || '').trim();
                const loaiInput = String(document.getElementById('addLoai').value || '').trim();
                const loai = normalizeProductLoai(loaiInput, tenTP);

                if (!Number.isInteger(stt) || stt <= 0) {
                    alert('Vui lòng nhập STT hợp lệ (> 0)!');
                    return;
                }
                if (!tenTP) {
                    alert('Vui lòng nhập tên TP!');
                    return;
                }

                try {
                    if (maSP) {
                        const existed = await db.collection('thanhpham').where('maSP', '==', maSP).limit(1).get();
                        if (!existed.empty) {
                            const doc = existed.docs[0];
                            await db.collection('thanhpham').doc(doc.id).set({
                                stt,
                                maSP,
                                tenTP,
                                loai,
                                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                            }, { merge: true });
                            alert('✅ SKU đã tồn tại, đã cập nhật STT và Tên TP!');
                        } else {
                            await db.collection('thanhpham').add({
                                stt,
                                maSP,
                                tenTP,
                                loai,
                                timestamp: new Date().toISOString(),
                                createdAt: firebase.firestore.FieldValue.serverTimestamp()
                            });
                            alert('✅ Đã thêm thành phẩm vào danh sách!');
                        }
                    } else {
                        await db.collection('thanhpham').add({
                            stt,
                            maSP,
                            tenTP,
                            loai,
                            timestamp: new Date().toISOString(),
                            createdAt: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        alert('✅ Đã thêm thành phẩm vào danh sách!');
                    }

                    document.getElementById('addSku').value = '';
                    document.getElementById('addTenTP').value = '';
                    document.getElementById('addLoai').value = '';
                    fillNextProductStt();
                } catch (error) {
                    alert('Lỗi khi thêm thành phẩm: ' + error.message);
                }
            }

            // ==================== HIỂN THỊ DANH SÁCH SẢN PHẨM ====================
            /** Tự điền STT tiếp theo dựa trên STT lớn nhất hiện có. */
            function fillNextProductStt() {
                const input = document.getElementById('addStt');
                if (!input) return;

                const maxStt = products.reduce((max, product) => {
                    const stt = parseInt(product.stt, 10) || 0;
                    return Math.max(max, stt);
                }, 0);
                input.value = maxStt + 1;
            }

            /** Dựng bảng thành phẩm và gắn hành vi chọn cho từng dòng. */
            function populateGrid() {
                const tbody = document.getElementById('gridBody');
                const adminTbody = document.getElementById('adminProductBody');
                tbody.innerHTML = '';
                adminTbody.innerHTML = '';
                fillNextProductStt();
                if (products.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="3" class="text-center py-8 text-gray-500">Chưa có dữ liệu.</td></tr>`;
                    adminTbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-gray-500">Chưa có dữ liệu.</td></tr>`;
                    return;
                }
                products.forEach((prod, i) => {
                    const tr = document.createElement('tr');
                    tr.className = 'cursor-pointer border-b hover:bg-gray-50';
                    tr.innerHTML = `<td class="px-4 py-3">${escapeHtml(prod.stt)}</td>
                                    <td class="px-4 py-3 font-mono">${escapeHtml(prod.maSP)}</td>
                                    <td class="px-4 py-3">${escapeHtml(prod.tenTP)}</td>`;
                    tr.onclick = () => selectRow(i, tr);
                    tbody.appendChild(tr);

                    const adminTr = document.createElement('tr');
                    adminTr.className = 'border-b hover:bg-gray-50';
                    adminTr.innerHTML = `<td class="px-4 py-3">${escapeHtml(prod.stt)}</td>
                                         <td class="px-4 py-3 font-mono">${escapeHtml(prod.maSP)}</td>
                                         <td class="px-4 py-3">${escapeHtml(prod.tenTP)}</td>
                                         <td class="px-4 py-3 text-center">
                                             <button onclick="deleteThanhPham('${prod.id || ''}', event)" title="Xóa thành phẩm" class="w-9 h-9 text-red-600 hover:bg-red-50 rounded-lg">
                                                 <i class="fas fa-trash"></i>
                                             </button>
                                         </td>`;
                    adminTbody.appendChild(adminTr);
                });
            }

            /** Xóa một thành phẩm khỏi Firestore trong khu vực quản trị đã mở khóa. */
            async function deleteThanhPham(id, event) {
                event.stopPropagation();
                if (!requireAdmin()) return;

                if (!id) {
                    alert('Không tìm thấy mã bản ghi để xóa!');
                    return;
                }
                if (!firebaseReady || !db) {
                    alert('Database chưa sẵn sàng. Vui lòng tải lại trang rồi thử lại.');
                    return;
                }
                if (!confirm('Bạn có chắc muốn xóa thành phẩm này?')) return;

                try {
                    await db.collection('thanhpham').doc(id).delete();
                    alert('✅ Đã xóa thành phẩm!');
                } catch (error) {
                    alert('Lỗi khi xóa thành phẩm: ' + error.message);
                }
            }

            // ==================== CHỌN DÒNG SẢN PHẨM ====================
            /** Điền thông tin thành phẩm được chọn vào biểu mẫu chính. */
            function applySelectedProduct(p) {
                if (!p) return;

                document.getElementById('sku').value = p.maSP || '';
                document.getElementById('tenTP').value = p.tenTP || '';

                const loaiHang = document.getElementById('loaiHang');
                if (loaiHang) {
                    loaiHang.value = p.loai === 'Ri' ? 'R' : (p.loai === 'Đô' ? 'D' : '');
                    if (loaiHang.value) {
                        handleLotRuleChange();
                        return;
                    }
                }

                updatePreview();
            }

            /** Đánh dấu dòng được chọn, áp dụng dữ liệu và đóng cửa sổ. */
            function selectRow(index, row) {
                document.querySelectorAll('#dataGrid tr').forEach(r => r.classList.remove('selected'));
                row.classList.add('selected');
                selectedIndex = index;
                const p = products[index] || null;
                applySelectedProduct(p);
                closeProductModal();
            }

            // ==================== LOAD DỮ LIỆU TỪ BẢNG ====================
            /** Nạp lại thành phẩm đang chọn từ bảng vào biểu mẫu chính. */
            function loadFromGrid() {
                if (selectedIndex < 0) return;

                const p = products[selectedIndex] || null;
                if (!p) return;

                applySelectedProduct(p);

                closeProductModal();
            }

            // ==================== TÌM KIẾM TRONG DANH SÁCH ====================
            /** Ẩn các dòng thành phẩm không khớp từ khóa tìm kiếm. */
            function filterGrid() {
                const term = document.getElementById('searchInput').value.toLowerCase();
                document.querySelectorAll('#dataGrid tr').forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
                });
            }

            /** Lọc bảng thành phẩm trong khu vực quản trị. */
            function filterAdminProductGrid() {
                const term = document.getElementById('adminProductSearch').value.toLowerCase();
                document.querySelectorAll('#adminProductGrid tbody tr').forEach(row => {
                    row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
                });
            }

            // ==================== ĐỒNG BỘ LOT THEO LOẠI + NHÀ SX + VÙNG ====================
            let isSyncingLotFields = false;

            /** Chuẩn hóa mã loại hàng thành một chữ cái viết hoa. */
            function normalizeLoaiHangCode(value) {
                const code = String(value || '').trim().toUpperCase();
                return /^[A-Z]$/.test(code) ? code : '';
            }

            /** Chuẩn hóa văn bản để so sánh không phân biệt dấu và chữ hoa. */
            function normalizeTextForCompare(value) {
                return String(value || '')
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/đ/g, 'd')
                    .replace(/Đ/g, 'D')
                    .toLowerCase();
            }

            /** Suy ra loại Đô hoặc Ri từ tên thành phẩm. */
            function inferLoaiFromTenTP(tenTP) {
                const normalized = normalizeTextForCompare(tenTP).replace(/[^a-z0-9]/g, '');
                if (normalized.includes('monthong')) return 'Đô';
                if (normalized.includes('ri6') || normalized.includes('sauriengri6')) return 'Ri';
                return '';
            }

            /** Chuẩn hóa tên loại thành phẩm từ dữ liệu nhập hoặc tên sản phẩm. */
            function normalizeProductLoai(loaiValue, tenTP = '') {
                const normalizedLoai = normalizeTextForCompare(loaiValue).replace(/[^a-z0-9]/g, '');

                if (['d', 'do', 'doa', 'dona', 'monthong'].includes(normalizedLoai)) return 'Đô';
                if (['r', 'ri', 'ri6'].includes(normalizedLoai)) return 'Ri';

                return inferLoaiFromTenTP(tenTP);
            }

            /** Chuẩn hóa mã nhà sản xuất thành đúng ba chữ số. */
            function normalizeNhaSXCode(value) {
                const digits = String(value || '').replace(/\D/g, '');
                return digits.padStart(3, '0').slice(-3);
            }

            /** Trả về mã vùng hai chữ cái hợp lệ dùng trong mã lot. */
            function getRegionCodeForLot(regionValue) {
                const code = String(regionValue || 'MT').trim().toUpperCase();
                return /^[A-Z]{2}$/.test(code) ? code : 'MT';
            }

            /** Tạo phần mã ngày đóng gói theo định dạng DDMMY. */
            function getPackagingDateCode(dateValue = null) {
                const dateInputValue = dateValue || document.getElementById('ngayDG')?.value;
                let dateObj = null;

                if (dateInputValue) {
                    const [year, month, day] = String(dateInputValue).split('-').map(Number);
                    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
                        dateObj = new Date(Date.UTC(year, month - 1, day));
                    }
                }

                if (!dateObj) {
                    dateObj = new Date();
                }

                const day = String(dateObj.getUTCDate()).padStart(2, '0');
                const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
                const yearLastDigit = String(dateObj.getUTCFullYear()).slice(-1);
                return `${day}${month}${yearLastDigit}`;
            }

            /** Phân tích mã lot thành loại, nhà sản xuất, vùng và phần đuôi. */
            function parseLotCode(lotValue) {
                const cleaned = String(lotValue || '').trim().toUpperCase();
                const match = cleaned.match(/^([A-Z])(\d{3})([A-Z]{2})(.*)$/);
                if (!match) return null;
                return {
                    loaiCode: match[1],
                    nhaSXCode: match[2],
                    regionCode: match[3],
                    tail: match[4] || ''
                };
            }

            /** Đồng bộ các ô loại hàng, nhà sản xuất và vùng từ mã lot. */
            function syncControlsFromLot() {
                const lotInput = document.getElementById('maBTP');
                const loaiHang = document.getElementById('loaiHang');
                const nhaSX = document.getElementById('nhaSX');
                const regionSelect = document.getElementById('vungNguyenLieu');
                if (!lotInput || !loaiHang || !nhaSX || !regionSelect) return;

                const parsed = parseLotCode(lotInput.value);
                if (!parsed) return;

                isSyncingLotFields = true;
                const loaiCode = normalizeLoaiHangCode(parsed.loaiCode) || parsed.loaiCode;
                ensureSelectHasValue(loaiHang, loaiCode);
                ensureSelectHasValue(nhaSX, parsed.nhaSXCode);
                ensureSelectHasValue(regionSelect, parsed.regionCode);
                loaiHang.value = loaiCode;
                nhaSX.value = parsed.nhaSXCode;
                regionSelect.value = parsed.regionCode;
                isSyncingLotFields = false;
            }

            /** Tạo lại mã lot theo loại hàng, nhà sản xuất, vùng và ngày đóng gói. */
            function updateLotByRules() {
                if (isSyncingLotFields) return;

                const lotInput = document.getElementById('maBTP');
                const loaiHang = document.getElementById('loaiHang');
                const nhaSX = document.getElementById('nhaSX');
                const regionSelect = document.getElementById('vungNguyenLieu');
                if (!lotInput || !loaiHang || !nhaSX || !regionSelect) return;

                const parsed = parseLotCode(lotInput.value);
                const loaiCode = normalizeLoaiHangCode(loaiHang.value);
                if (!loaiCode) {
                    // Sản phẩm không có loại, ví dụ xoài, sẽ giữ nguyên lot người dùng nhập.
                    return;
                }
                const nhaSXCode = normalizeNhaSXCode(nhaSX.value);
                const regionCode = getRegionCodeForLot(regionSelect.value);
                const dateCode = getPackagingDateCode();
                const existingDateCodeMatch = parsed && parsed.tail ? parsed.tail.match(/^(\d{5})(.*)$/) : null;
                const tail = existingDateCodeMatch ? existingDateCodeMatch[2] : (parsed ? parsed.tail : '');

                const nextLot = `${loaiCode}${nhaSXCode}${regionCode}${dateCode}${tail}`;
                if (lotInput.value !== nextLot) {
                    lotInput.value = nextLot;
                }
            }

            /** Xử lý khi người dùng sửa mã lot thủ công. */
            function handleLotInput() {
                if (!isSyncingLotFields) {
                    syncControlsFromLot();
                }
                updatePreview();
            }

            /** Cập nhật mã lot khi loại hàng hoặc quy tắc liên quan thay đổi. */
            function handleLotRuleChange() {
                updateLotByRules();
                updatePreview();
            }

            /** Chuẩn hóa mã nhà sản xuất được chọn rồi cập nhật mã lot. */
            function handleNhaSXInput() {
                const nhaSX = document.getElementById('nhaSX');
                if (!nhaSX) return;

                const normalizedCode = normalizeNhaSXCode(nhaSX.value);
                ensureSelectHasValue(nhaSX, normalizedCode);
                nhaSX.value = normalizedCode;

                handleLotRuleChange();
            }

            /** Cập nhật mã lot và bản xem trước khi đổi vùng nguyên liệu. */
            function handleRegionChange() {
                updateLotByRules();
                updatePreview();
            }

            // ==================== XÁC ĐỊNH VÙNG NGUYÊN LIỆU TỪ LOT ====================
            /** Nhận diện mã vùng nguyên liệu xuất hiện trong chuỗi lot. */
            function getRegionFromLot(lot) {
                if (!lot) return null;
                const upperLot = lot.toUpperCase();
                if (upperLot.includes('TN') || upperLot.includes('TAY NGUYEN') || upperLot.includes('TÂY NGUYÊN')) return 'TN';
                if (upperLot.includes('MD') || upperLot.includes('MIEN DONG')) return 'MD';
                if (upperLot.includes('MT') || upperLot.includes('MIEN TAY')) return 'MT';
                return null;
            }

            /** Tạo HTML đầy đủ dùng cho bản xem trước và phương án PDF dự phòng. */
            function buildLabelHtml(sttValue = '5200', snapshotData = null) {
                const data = snapshotData || getLabelSnapshotData();
                const sku = escapeHtml(data.sku || '');
                const hasSku = sku.length > 0;
                const maBTP = escapeHtml(data.maBTP || 'D009MT15066-02-0K');
                const tenTP = escapeHtml(data.tenTP || 'TP CẤP ĐÔNG SẦU RIÊNG...');
                const toSanXuat = escapeHtml(data.toSanXuat || 'Tèo');
                const quyCach = escapeHtml(data.quyCach || '20kg');
                const vungFull = escapeHtml(data.vungFull || 'Miền Tây');
                const ngaySX = escapeHtml(data.ngaySX || '22/06/2026');
                const ngayDG = escapeHtml(data.ngayDG || ngaySX);
                const safeSttValue = escapeHtml(sttValue);

                return `
                    <div style="font-family: Tahoma, Arial, sans-serif; font-size: 9.0pt; font-weight: 700; line-height: 1.15; padding: 3px 5px; height: 100%; letter-spacing: -0.2px;">
                        <div style="display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 3px; font-size: 7.8pt;">
                            <div>${hasSku ? `Mã SKU: ${sku}` : ''}</div>
                            <div>Lot: ${maBTP}</div>
                        </div>
                        <div style="font-size: 12.8pt; font-weight: 800; text-align: center; margin: 4px 0 6px; line-height: 1.05;">
                            ${tenTP}
                        </div>
                        <hr style="border: 1px solid #000; margin: 3px 0 5px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                            <div><strong>Quy Cách /SPEC</strong><br>Thùng/túi: ${quyCach}</div>
                            <div style="text-align: right;"><strong>KHỐI LƯỢNG /WEIGHT</strong><br>${quyCach}</div>
                        </div>
                        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                            <div><strong>TỔ/NHÓM</strong><br>${toSanXuat}</div>
                            <div style="text-align: right;">
                                <strong>STT/INDEX</strong><br>
                                <span style="font-size: 15.8pt; font-weight: 800;">${safeSttValue}</span>
                            </div>
                        </div>
                        <div style="margin-bottom: 3px; font-weight: 700;"><strong>VÙNG NGUYÊN LIỆU</strong><br>${vungFull}</div>
                        <div style="display: flex; justify-content: space-between; font-size: 9.0pt; margin-top: 5px;">
                            <div>Ngày SX: ${ngaySX}</div>
                            <div>Ngày ĐG: ${ngayDG}</div>
                        </div>
                    </div>
                `;
            }

            /** Tạo HTML gọn dùng riêng cho tài liệu gửi đến máy in. */
            function buildLabelHtmlCompact(sttValue = '5200', snapshotData = null) {
                const data = snapshotData || getLabelSnapshotData();
                const sku = escapeHtml(data.sku || '');
                const hasSku = sku.length > 0;
                const maBTP = escapeHtml(data.maBTP || 'D009MT15066-02-0K');
                const tenTP = escapeHtml(data.tenTP || 'TP CẤP ĐÔNG SẦU RIÊNG...');
                const toSanXuat = escapeHtml(data.toSanXuat || 'Tèo');
                const quyCach = escapeHtml(data.quyCach || '20kg');
                const vungFull = escapeHtml(data.vungFull || 'Miền Tây');
                const ngaySX = escapeHtml(data.ngaySX || '22/06/2026');
                const ngayDG = escapeHtml(data.ngayDG || ngaySX);
                const safeSttValue = escapeHtml(sttValue);

                return `
                    <div class="lbl-inner">
                        <div class="lbl-row lbl-top">
                            <div>${hasSku ? `Mã SKU: ${sku}` : ''}</div>
                            <div>Lot: ${maBTP}</div>
                        </div>
                        <div class="lbl-name">${tenTP}</div>
                        <hr class="lbl-rule">
                        <div class="lbl-row">
                            <div><strong>Quy Cách /SPEC</strong><br>Thùng/túi: ${quyCach}</div>
                            <div class="lbl-right"><strong>KHỐI LƯỢNG /WEIGHT</strong><br>${quyCach}</div>
                        </div>
                        <div class="lbl-row">
                            <div><strong>TỔ/NHÓM</strong><br>${toSanXuat}</div>
                            <div class="lbl-right"><strong>STT/INDEX</strong><br><span class="lbl-index">${safeSttValue}</span></div>
                        </div>
                        <div class="lbl-region"><strong>VÙNG NGUYÊN LIỆU</strong><br>${vungFull}</div>
                        <div class="lbl-date">
                            <div>Ngày SX: ${ngaySX}</div>
                            <div>Ngày ĐG: ${ngayDG}</div>
                        </div>
                    </div>
                `;
            }

            // ==================== CẬP NHẬT XEM TRƯỚC NHÃN ====================
            /** Cập nhật nhãn xem trước và lên lịch tải bộ đếm STT. */
            function updatePreview() {
                const preview = document.getElementById('previewLabel');
                if (preview) {
                    preview.innerHTML = buildLabelHtml();
                }
                scheduleLoadProductSTT();
            }

            // ==================== TÍNH STT CUỐI ====================
            /** Tính STT cuối từ STT đầu và số lượng tem. */
            function updateSttCuoi() {
                const sttDau = toPositiveInt(document.getElementById('sttDau').value, FIRST_STT);
                const soLuong = parseInt(document.getElementById('soLuongTem').value) || 1;
                document.getElementById('sttCuoi').value = sttDau + soLuong - 1;
            }

            // ==================== RESET STT ====================
            /** Xác thực mật khẩu rồi đặt lại STT của thành phẩm hiện tại. */
            async function resetSTT() {
                if (!requireAdmin() || !confirm("Reset STT về 1 cho mã này?")) return;
                document.getElementById('sttDau').value = FIRST_STT;
                document.getElementById('soLuongTem').value = 1;
                await saveProductSTT(FIRST_STT, FIRST_STT, FIRST_STT);
                updateSttCuoi();
                alert("Đã reset STT thành phẩm về 1 thành công!");
            }

            // ==================== CHUYỂN TAB ====================
            /** Chuyển giữa màn hình nhập thông tin và báo cáo sản lượng. */
            function switchTab(tab) {
                document.getElementById('content0').classList.toggle('hidden', tab !== 0);
                document.getElementById('content1').classList.toggle('hidden', tab !== 1);

                document.getElementById('tab0').classList.toggle('border-blue-600', tab === 0);
                document.getElementById('tab0').classList.toggle('text-blue-600', tab === 0);
                document.getElementById('tab1').classList.toggle('border-blue-600', tab === 1);
                document.getElementById('tab1').classList.toggle('text-blue-600', tab === 1);
            }

            // ==================== KHỞI TẠO KHI TRANG MỞ ====================
            async function initializeLabelPage() {
                showLoading();
                try {
                    currentUser = await waitForAuth();
                    if (!currentUser) {
                        window.location.replace('./login.html');
                        return;
                    }

                    const access = await requirePageAccess(currentUser, 'label');
                    const profile = access.profile;
                    currentRole = access.role;
                    document.querySelectorAll('[data-admin-only]').forEach((element) => {
                        element.classList.toggle('hidden', currentRole !== 'admin');
                    });
                    setFirebaseStatus(`Đã kết nối Firebase · ${currentUser.email || ''} · ${currentRole === 'admin' ? 'Admin' : 'Staff'}`);

                    const today = getVietnamDateKey();
                    document.getElementById('ngaySX').value = today;
                    document.getElementById('ngayDG').value = getPackagingDateKey();

                    await loadDropdownSettings();
                    syncControlsFromLot();
                    updateLotByRules();
                    scheduleNgayDongGoiSync();

                    await loadProductSTT(true);
                    loadPrintHistory();
                    loadProductsFromFirebase();
                    updatePreview();
                } catch (error) {
                    console.error(error);
                    setFirebaseStatus(`Không thể khởi tạo trang: ${error.message}`, true);
                    showToast(error.message || 'Không thể tải trang in nhãn.', 'error');
                } finally {
                    hideLoading();
                }
            }

            Object.assign(window, {
                addThanhPhamManual,
                clearDateFilter,
                closeDropdownAdmin,
                closeLotModal,
                closeProductModal,
                deleteSelectedHistory,
                deleteThanhPham,
                downloadPdfLabels,
                exportReportExcel,
                filterAdminProductGrid,
                filterGrid,
                filterLotList,
                handleLotInput,
                handleLotRuleChange,
                handleNgayDongGoiInput,
                handleNhaSXInput,
                handleRegionChange,
                importExcel,
                toggleNgayDGEditability,
                openDropdownAdmin,
                openLotModal,
                openProductModal,
                printLabels,
                reprintFromHistory,
                resetSTT,
                switchTab,
                toggleAllCheckboxes,
                toggleHistorySelection,
                toggleSelectAll,
                updatePreview,
                updateSttCuoi
            });

            window.addEventListener('load', initializeLabelPage, { once: true });