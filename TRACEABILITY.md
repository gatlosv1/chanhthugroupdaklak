# Truy xuất nguồn gốc xoài đông lạnh

## Nguyên tắc

- `stage_events` là append-only. Client chỉ đọc; chỉ Cloud Functions (Admin SDK) được tạo event.
- `lots` giữ quan hệ phả hệ và cache số dư. Client không ghi trực tiếp.
- Mọi lô luôn có `parentLotIds` là mảng, kể cả chỉ một lô cha. Có thể lưu thêm `parentLotId` để hiển thị nhanh lô cha chính.
- `currentQuantityKg` là cache material balance, được tạo từ tổng `quantityDeltaKg`, không phải tổng `acceptedKg`. Điều này tránh đếm lặp lại khi cùng một lô đi qua nhiều công đoạn.

## Collections

### `process_stages/{stageId}`

Reference data nhỏ, client cache được.

```js
{
  code: 'WASH_CHLORINE',
  name: 'Rửa Clorin',
  sortOrder: 30,
  allowsRework: false,
  active: true
}
```

Các stage đề xuất: `CLASSIFY`, `RIPEN`, `WASH`, `WASH_CHLORINE`, `PEEL`, `CHEEK_SLICE`, `FORM`, `FREEZE`, `METAL_DETECT`, `PACK`, `COLD_STORAGE`. Một công đoạn có thể lặp lại; event ghi thêm `sequence` hoặc `rework: true`, không tạo lại reference stage.

### `reject_reasons/{reasonId}`

```js
{ code: 'BRUISED_LIGHT', name: 'Dập nhẹ', severity: 'minor', active: true }
```

Các lý do gợi ý: `BRUISED_LIGHT`, `BRUISED_HEAVY`, `FRAGMENT`, `SEED`, `SPOILAGE`, `FOREIGN_MATERIAL`.

### `lots/{lotId}`

```js
{
  lotCode: 'XM-20260927-001',
  parentLotId: 'optional-primary-parent-id',
  parentLotIds: ['parent-a', 'parent-b'],
  createdAt: Timestamp,
  status: 'active',
  currentQuantityKg: 0,
  quantityCacheUpdatedAt: Timestamp,
  lastEventId: 'stage-event-id',
  lastStageId: 'FREEZE'
}
```

Tách lô: tạo mỗi lô con với `parentLotIds: [sourceLotId]`. Gộp lô: tạo lô mới với `parentLotIds` chứa toàn bộ lô nguồn. Event của lô nguồn có delta âm; event khởi tạo của lô con/gộp có delta dương.

### `stage_events/{eventId}`

```js
{
  lotId: 'lot-id',
  stageId: 'WASH_CHLORINE',
  timestamp: Timestamp,
  inputKg: 500,
  acceptedKg: 470,
  rejectedKg: 30,
  rejectReasonId: 'BRUISED_LIGHT',
  quantityDeltaKg: 0,
  operatorId: 'firebase-auth-uid',
  operatorName: 'Nguyen Van A',
  operatorEmail: 'operator@example.com',
  rework: false,
  outputLotIds: []
}
```

`quantityDeltaKg` là thay đổi tồn kho của chính `lotId`: nhận nguyên liệu/lô mới `+kg`, dùng hoặc tách từ lô nguồn `-kg`, công đoạn chỉ đánh giá cùng lô là `0` trừ khi có thay đổi thực tế. Cloud Function `onStageEventCreated` cập nhật cache và ghi marker ở `stage_event_cache_applications/{eventId}` để retry không cộng hai lần.

## Ghi event qua Cloud Function

Không dùng `addDoc` trực tiếp ở client. Gọi callable `recordStageEvent`; hàm gắn UID người dùng vào event, xác thực lot/stage/reject reason, sau đó trigger cache chạy tự động.

```js
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const recordStageEvent = httpsCallable(getFunctions(undefined, 'asia-southeast1'), 'recordStageEvent');
const result = await recordStageEvent({
  lotId: 'lot-id',
  stageId: 'WASH_CHLORINE',
  inputKg: 500,
  acceptedKg: 470,
  rejectedKg: 30,
  rejectReasonId: 'BRUISED_LIGHT',
  quantityDeltaKg: 0,
  rework: false
});
console.log(result.data.eventId);
```

## Đọc số lượng còn lại

Cách nhanh, dùng cache do Cloud Function quản lý:

```js
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const lot = await getDoc(doc(db, 'lots', lotId));
const currentQuantityKg = lot.data().currentQuantityKg || 0;
```

Cách kiểm toán, dùng aggregation của Firestore:

```js
import { collection, getAggregateFromServer, query, sum, where } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const eventQuery = query(collection(db, 'stage_events'), where('lotId', '==', lotId));
const aggregate = await getAggregateFromServer(eventQuery, { quantity: sum('quantityDeltaKg') });
const currentQuantityKg = aggregate.data().quantity || 0;
```

## Lấy phả hệ và lịch sử

Ví dụ Admin SDK dưới đây trả về lô gốc, toàn bộ tổ tiên và toàn bộ lô con/nhánh, mỗi lô kèm event theo thời gian.

```js
async function readLotGenealogy(db, initialLotId) {
  const lots = new Map();
  const events = new Map();
  const visited = {
    ancestors: new Set(),
    descendants: new Set()
  };

  async function visit(lotId, direction) {
    if (visited[direction].has(lotId)) return;
    visited[direction].add(lotId);

    const lotSnapshot = await db.collection('lots').doc(lotId).get();
    if (!lotSnapshot.exists) return;
    const lot = { id: lotSnapshot.id, ...lotSnapshot.data() };
    lots.set(lotId, lot);

    const eventSnapshot = await db.collection('stage_events')
      .where('lotId', '==', lotId)
      .orderBy('timestamp', 'asc')
      .get();
    events.set(lotId, eventSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));

    const relatedLotIds = direction === 'ancestors'
      ? (lot.parentLotIds || [])
      : (await db.collection('lots')
        .where('parentLotIds', 'array-contains', lotId)
        .orderBy('createdAt', 'asc')
        .get()).docs.map((doc) => doc.id);

    await Promise.all(relatedLotIds.map((id) => visit(id, direction)));
  }

  await visit(initialLotId, 'ancestors');
  await visit(initialLotId, 'descendants');
  return { lots: [...lots.values()], events: Object.fromEntries(events) };
}
```

## Deploy

```powershell
firebase deploy --only firestore:rules,firestore:indexes,functions:onStageEventCreated,functions:recordStageEvent,functions:createIncomingLot
```
