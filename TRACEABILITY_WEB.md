# Web nhập liệu truy xuất xoài đông lạnh

## Lựa chọn frontend

Dùng **HTML + CSS + ES modules** trên Firebase Hosting, tiếp tục kiến trúc hiện có. Lý do: ứng dụng đang có Firebase Auth, Firestore modules, các trang HTML độc lập và không cần thêm build tool để chạy tại xưởng. Các nút chạm tối thiểu 48 px, font lớn và giao diện một cột trên điện thoại.

Nếu sau này cần nhiều luồng phức tạp hoặc scanner native, có thể chuyển riêng module này sang React/Vite mà không thay đổi collections hoặc Cloud Functions.

## Cấu trúc đề xuất

```text
traceability.html                     # Màn hình nhập liệu chung theo bộ phận
traceability-admin.html               # Dashboard/admin genealogy
css/traceability.css                  # Mobile-first, nút lớn, độ tương phản cao
js/traceability/
  stages.js                            # Stage/departments constants và cache reference data
  offline.js                           # IndexedDB persistence + trạng thái online/offline
  api.js                               # Callable Functions: claimLot, completeStageEvent, createLot
  entry.js                             # Queue, QR/manual lookup, form hoàn tất công đoạn
  admin.js                             # Dashboard realtime, genealogy tree, master data
functions/
  traceability.js                      # Callable workflow functions và event cache trigger
TRACEABILITY.md                       # Schema Lot Genealogy + Event Log nền tảng
```

## Routes và phân quyền bộ phận

Dùng một route nhập liệu duy nhất: `traceability.html`. Không tin `departmentId` trên URL; lấy `departmentId` từ `users/{uid}` sau đăng nhập. `admin` và `dev` chọn department để hỗ trợ vận hành.

| departmentId | Công đoạn phụ trách |
| --- | --- |
| `PREPROCESS` | `SORT_1`-`SORT_4`, `RIPEN_1`-`RIPEN_3`, `RIPEN_REWORK`, `WASH_1`-`WASH_4` |
| `PROCESSING` | `PEEL`, `PEEL_CHECK`, `CHEEK_SLICE`, `CHEEK_CHECK`, `FORM` |
| `FREEZE_PACK` | `FREEZE`, `FREEZER_EXIT`, `METAL_DETECT`, `PE_PA_BAG`, `CARTON_PACK` |
| `COLD_STORAGE` | `COLD_STORAGE_IN`, `TRAY_RECEIPT`, `TRAY_ISSUE` |

Thêm vào `users/{uid}`:

```js
{
  role: 'staff',
  departmentId: 'PREPROCESS',
  permissions: ['view', 'add']
}
```

`process_stages/{stageId}` phải có thêm metadata workflow:

```js
{
  code: 'WASH_2',
  name: 'Rửa 2',
  departmentId: 'PREPROCESS',
  sortOrder: 42,
  allowsRework: false,
  nextStageIds: ['WASH_3'],
  active: true
}
```

## Hàng chờ theo công đoạn

`lots` là cache workflow do Cloud Function quản lý, không phải event log. Thêm các fields có thể thay đổi sau mỗi event:

```js
{
  status: 'waiting',                 // waiting | processing | completed | blocked
  pendingStageId: 'WASH_2',
  pendingDepartmentId: 'PREPROCESS',
  claimedBy: null,
  claimExpiresAt: null,
  updatedAt: Timestamp
}
```

Web nghe realtime:

```js
query(
  collection(db, 'lots'),
  where('pendingDepartmentId', '==', departmentId),
  where('status', '==', 'waiting'),
  orderBy('updatedAt', 'asc'),
  limit(100)
)
```

Không cho web ghi trực tiếp `lots`. Cloud Function `claimLot` dùng transaction đặt lease ngắn; `completeStageEvent` chỉ hoàn tất khi lease thuộc về chính người thao tác. Điều này chặn hai thiết bị cùng nhập một lô/công đoạn.

## Luồng dữ liệu an toàn

1. Ở `SORT_1`, gọi `createLot` để tạo lô gốc, sinh `lotCode` duy nhất, QR payload là `lotCode`.
2. Người dùng chọn lô từ hàng chờ hoặc nhập/quét QR. Trang chỉ hiện lô đúng `pendingDepartmentId` và `pendingStageId`.
3. Gọi `claimLot`. Khi thành công, form điền sẵn `inputKg` từ `currentQuantityKg`.
4. Người dùng ghi `acceptedKg`, `rejectedKg`, lý do, ghi chú và có/không rework.
5. Gọi `completeStageEvent` qua Callable Function. Function tạo event, chuyển lot sang công đoạn kế tiếp, tạo lô con cho rework/tách lô, và cập nhật cache/hàng chờ trong transaction.
6. Trigger `onStageEventCreated` cập nhật material balance cache từ `quantityDeltaKg` idempotently.

Với lý do loại có thể đi tiếp, thêm vào `reject_reasons/{reasonId}`:

```js
{
  code: 'BRUISED_LIGHT',
  name: 'Dập nhẹ',
  reworkEligible: true,
  reworkStageId: 'RIPEN_REWORK',
  active: true
}
```

## Rules theo role/department

Client chỉ được đọc `lots`, `stage_events`, `process_stages`, `reject_reasons`. Tất cả create/update/delete cho các collection này là `false`; Admin SDK của Function bypass Rules. Department authorization được kiểm tra trong callable bằng `users/{uid}.departmentId`, vì Rules không bảo vệ được Admin SDK.

```rules
match /lots/{lotId} {
  allow read: if isSignedIn();
  allow write: if false;
}
match /stage_events/{eventId} {
  allow read: if isSignedIn();
  allow write: if false;
}
match /process_stages/{stageId} {
  allow read: if isSignedIn();
  allow write: if false;
}
match /reject_reasons/{reasonId} {
  allow read: if isSignedIn();
  allow write: if false;
}
```

Trong `completeStageEvent`, server bắt buộc kiểm tra:

- `operatorId` lấy từ `context.auth.uid`, không nhận từ client.
- Lot đang `waiting` đúng stage và department.
- `claimedBy` trùng người gọi, lease chưa hết hạn.
- Công đoạn thuộc department của user, trừ `admin`/`dev`.
- `acceptedKg + rejectedKg <= inputKg`.
- `rejectReasonId` hợp lệ; chỉ tạo rework child khi `reworkEligible`.
- Event được tạo mới, tuyệt đối không `update` hoặc `delete`.

## Màn hình nhập liệu mẫu

`js/traceability/entry.js` dưới đây là lõi của một màn hình hoàn chỉnh. Phần UI dùng các element IDs tương ứng trong `traceability.html`.

```js
import { db } from '../firebase.js';
import { waitForAuth } from '../auth.js';
import { getUserProfile } from '../firestore.js';
import {
  collection, doc, enableIndexedDbPersistence, getDocs, limit, onSnapshot,
  orderBy, query, where
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const queue = document.querySelector('#lotQueue');
const form = document.querySelector('#stageEntryForm');
const lotSearch = document.querySelector('#lotSearch');
const lotCode = document.querySelector('#lotCode');
const inputKg = document.querySelector('#inputKg');
const acceptedKg = document.querySelector('#acceptedKg');
const rejectedKg = document.querySelector('#rejectedKg');
const rejectReason = document.querySelector('#rejectReason');
const note = document.querySelector('#note');
const saveButton = document.querySelector('#saveStageEvent');
const status = document.querySelector('#entryStatus');

let selectedLot = null;
let departmentId = '';
let unsubscribeQueue = () => {};
const functions = getFunctions(undefined, 'asia-southeast1');
const claimLot = httpsCallable(functions, 'claimLot');
const completeStageEvent = httpsCallable(functions, 'completeStageEvent');

try {
  await enableIndexedDbPersistence(db);
} catch (error) {
  // Multiple open tabs can reject persistence. Firestore still works online.
  console.warn('Offline persistence unavailable:', error.code);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? 'status status--error' : 'status';
}

function renderQueue(lots) {
  queue.replaceChildren(...lots.map((lot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lot-card';
    button.innerHTML = `<strong>${lot.lotCode}</strong><span>${lot.pendingStageId} · ${lot.currentQuantityKg || 0} kg</span>`;
    button.addEventListener('click', () => selectLot(lot));
    return button;
  }));
}

async function selectLot(lot) {
  const result = await claimLot({ lotId: lot.id, expectedStageId: lot.pendingStageId });
  selectedLot = { ...lot, ...result.data.lot };
  lotCode.value = selectedLot.lotCode;
  inputKg.value = selectedLot.currentQuantityKg || 0;
  acceptedKg.focus();
  setStatus(`Đã nhận lô ${selectedLot.lotCode}`);
}

function listenQueue() {
  unsubscribeQueue();
  const lotQueue = query(
    collection(db, 'lots'),
    where('pendingDepartmentId', '==', departmentId),
    where('status', '==', 'waiting'),
    orderBy('updatedAt', 'asc'),
    limit(100)
  );
  unsubscribeQueue = onSnapshot(lotQueue, (snapshot) => {
    renderQueue(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => setStatus(error.message, true));
}

lotSearch.addEventListener('change', async () => {
  const code = lotSearch.value.trim().toUpperCase();
  if (!code) return;
  const snapshot = await getDocs(query(collection(db, 'lots'), where('lotCode', '==', code), limit(1)));
  if (snapshot.empty) return setStatus('Không tìm thấy mã lô.', true);
  const lot = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  if (lot.pendingDepartmentId !== departmentId || lot.status !== 'waiting') {
    return setStatus('Lô không chờ xử lý tại bộ phận này.', true);
  }
  await selectLot(lot);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedLot) return setStatus('Chọn hoặc quét một lô trước khi lưu.', true);

  saveButton.disabled = true;
  try {
    const result = await completeStageEvent({
      lotId: selectedLot.id,
      stageId: selectedLot.pendingStageId,
      inputKg: Number(inputKg.value),
      acceptedKg: Number(acceptedKg.value),
      rejectedKg: Number(rejectedKg.value),
      rejectReasonId: rejectReason.value || null,
      note: note.value.trim()
    });
    form.reset();
    selectedLot = null;
    setStatus(`Đã lưu. Event: ${result.data.eventId}`);
  } catch (error) {
    setStatus(error.message || 'Không thể lưu công đoạn.', true);
  } finally {
    saveButton.disabled = false;
  }
});

const user = await waitForAuth();
if (!user) location.href = './login.html';
const profile = await getUserProfile(user.uid);
departmentId = profile?.departmentId || '';
if (!departmentId) setStatus('Tài khoản chưa được phân bộ phận.', true);
else listenQueue();
```

## Dashboard admin

`traceability-admin.html` dùng `onSnapshot` cho `lots` nhóm theo `pendingStageId` và `pendingDepartmentId`; không tính lại toàn bộ events trong mỗi render. Màn truy vết gọi hàm `readLotGenealogy` trong `TRACEABILITY.md`, hiển thị cây cha/con và timeline event. Admin quản lý `process_stages`, `reject_reasons`, `users.departmentId` qua callable Functions hoặc màn quản trị dùng Admin SDK, không ghi client trực tiếp.

## Indexes cần thêm

Ngoài indexes hiện có trong `firestore.indexes.json`, hàng chờ cần:

```json
{
  "collectionGroup": "lots",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "pendingDepartmentId", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "updatedAt", "order": "ASCENDING" }
  ]
}
```

## Lộ trình triển khai

1. Seed `process_stages` và `reject_reasons`; gán `departmentId` cho users.
2. Thêm `claimLot`, `createLot`, `completeStageEvent` Cloud Functions với transaction và kiểm tra department.
3. Tạo `traceability.html`/`entry.js`, bật offline persistence, thử trên một tablet và hai thiết bị tranh chấp cùng lô.
4. Bổ sung `traceability-admin.html` và route/menu dashboard.
5. Deploy rules, indexes, Functions và Hosting; kiểm thử offline/online bằng Firestore Emulator trước khi đưa xưởng sử dụng.
