// Kiểm tra luồng updateLotStage / sendToSoak / rejectLot với Firestore giả lập trong bộ nhớ.
// Chạy: node scripts/test-stage-functions.mjs  (không cần cài firebase-admin hay emulator)
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---------- Firestore giả lập ---------- */
const store = new Map(); // "lots/ID" -> data
let autoId = 0;
const Timestamp = { now: () => ({ __ts: Date.now() }) };
const FieldValue = {
  serverTimestamp: () => ({ __serverTs: true }),
  arrayUnion: (...items) => ({ __arrayUnion: items })
};
const clone = (value) => structuredClone(value);

function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  keys.slice(0, -1).forEach((key) => { node[key] = node[key] && typeof node[key] === 'object' ? node[key] : {}; node = node[key]; });
  node[keys.at(-1)] = value;
}

const docRef = (path) => ({
  path,
  id: path.split('/')[1],
  async get() { return { exists: store.has(path), data: () => clone(store.get(path)) }; }
});
const fakeDb = {
  collection: (name) => ({ doc: (id = `auto${++autoId}`) => docRef(`${name}/${id}`) }),
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: (ref) => ref.get(),
      create: (ref, data) => writes.push(() => store.set(ref.path, clone(data))),
      update: (ref, data) => writes.push(() => {
        const doc = store.get(ref.path);
        for (const [key, value] of Object.entries(data)) {
          if (value?.__arrayUnion) setPath(doc, key, [...(doc[key] || []), ...value.__arrayUnion]);
          else setPath(doc, key, value);
        }
      })
    };
    const result = await fn(tx);
    writes.forEach((write) => write());
    return result;
  }
};

/* ---------- Giả lập firebase-admin / firebase-functions ---------- */
class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fakeAdmin = { firestore: Object.assign(() => fakeDb, { Timestamp, FieldValue }) };
const fakeFunctions = { region: () => ({ https: { onCall: (handler) => handler } }), https: { HttpsError } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin') return fakeAdmin;
  if (request === 'firebase-functions/v1') return fakeFunctions;
  return originalLoad.call(this, request, ...rest);
};
const { updateLotStage, sendToSoak, rejectLot } = require('../functions/traceability.js');

/* ---------- Dữ liệu ---------- */
const seedUser = (uid, data) => store.set(`users/${uid}`, data);
seedUser('pre', { name: 'Nhân viên Sơ chế', role: 'staff', departmentId: 'PREPROCESS' });
seedUser('proc', { name: 'Nhân viên Chế biến', role: 'staff', department: 'Chế biến' });
seedUser('boss', { name: 'Quản trị', role: 'admin' });
const ctx = (uid) => ({ auth: { uid, token: { email: `${uid}@x.vn` } } });
const lot = (id) => store.get(`lots/${id}`);
const newLot = (id, extra = {}) => store.set(`lots/${id}`, {
  lotCode: `LOT-${id}`, status: 'waiting', currentStage: 'SORT_1', pendingStageId: 'SORT_1',
  currentKg: 100, intake: { initialKg: 100, productType: 'Xoài keo' }, stages: {}, history: [], ...extra
});
const rejects = async (promise, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
};

let count = 0;
const test = async (name, fn) => { await fn(); count += 1; console.log(`ok - ${name}`); };

await test('đạt toàn bộ → sang công đoạn kế, ghi history và stages', async () => {
  newLot('a');
  const out = await updateLotStage({ lotId: 'a', stageId: 'SORT_1', passedKg: 100 }, ctx('pre'));
  assert.equal(out.nextStage, 'SOAK_1');
  const doc = lot('a');
  assert.equal(doc.currentStage, 'SOAK_1');
  assert.equal(doc.pendingStageId, 'SOAK_1');
  assert.equal(doc.currentKg, 100);
  assert.equal(doc.stages.SORT_1.status, 'passed');
  assert.equal(doc.stages.SOAK_1.status, 'pending');
  assert.equal(doc.history.length, 1);
  assert.equal(doc.history[0].action, 'RECORD_RESULT');
  assert.equal(doc.history[0].operatorName, 'Nhân viên Sơ chế');
});

await test('tách hư nhẹ thành lô con, lô chính đi tiếp với phần đạt', async () => {
  newLot('b');
  const out = await updateLotStage({ lotId: 'b', stageId: 'SORT_1', passedKg: 70, rejectedLightKg: 20, rejectedHeavyKg: 5 }, ctx('pre'));
  assert.equal(lot('b').currentKg, 70);
  assert.equal(out.lossKg, 5);
  const child = lot(out.child.id);
  assert.equal(child.lotCode, 'LOT-b-U111');
  assert.equal(child.currentStage, 'SOAK_1_1');
  assert.equal(child.currentKg, 20);
  assert.deepEqual(child.parentLotIds, ['b']);
  assert.equal(child.intake.initialKg, 20);
  assert.equal(child.history[0].action, 'SPLIT_FROM_PARENT');
  assert.equal(lot('b').childCount, 1);
});

await test('sendToSoak chuyển cả lô, không tạo lô con', async () => {
  newLot('c');
  const before = store.size;
  const out = await sendToSoak({ lotId: 'c', stageId: 'SORT_1' }, ctx('pre'));
  assert.equal(out.outcome, 'failed');
  assert.equal(lot('c').currentStage, 'SOAK_1_1');
  assert.equal(lot('c').history[0].action, 'SEND_TO_SOAK');
  assert.equal(store.size, before);
});

await test('rejectLot cần lý do và đóng lô', async () => {
  newLot('d');
  await rejects(rejectLot({ lotId: 'd', stageId: 'SORT_1', note: '' }, ctx('pre')), 'invalid-argument');
  await rejectLot({ lotId: 'd', stageId: 'SORT_1', note: 'Thối toàn bộ' }, ctx('pre'));
  assert.equal(lot('d').status, 'rejected');
  assert.equal(lot('d').currentKg, 0);
  assert.equal(lot('d').pendingStageId, null);
});

await test('đạt ở khâu Đóng gói cuối → completed', async () => {
  newLot('e', { currentStage: 'PACK', pendingStageId: 'PACK' });
  const out = await updateLotStage({ lotId: 'e', stageId: 'PACK', passedKg: 100 }, ctx('boss'));
  assert.equal(out.completed, true);
  assert.equal(lot('e').status, 'completed');
});

await test('phân quyền: sai bộ phận bị chặn, admin được qua', async () => {
  newLot('f');
  await rejects(updateLotStage({ lotId: 'f', stageId: 'SORT_1', passedKg: 100 }, ctx('proc')), 'permission-denied');
  await updateLotStage({ lotId: 'f', stageId: 'SORT_1', passedKg: 100 }, ctx('boss'));
  newLot('g', { currentStage: 'PEEL', pendingStageId: 'PEEL' });
  await updateLotStage({ lotId: 'g', stageId: 'PEEL', passedKg: 90 }, ctx('proc')); // bộ phận suy ra từ tên "Chế biến"
});

await test('chặn thao tác sai công đoạn, sai trạng thái, chưa đăng nhập, lô không tồn tại', async () => {
  newLot('h');
  await rejects(updateLotStage({ lotId: 'h', stageId: 'SORT_2', passedKg: 10 }, ctx('pre')), 'failed-precondition');
  newLot('i', { status: 'rejected' });
  await rejects(updateLotStage({ lotId: 'i', stageId: 'SORT_1', passedKg: 10 }, ctx('pre')), 'failed-precondition');
  await rejects(updateLotStage({ lotId: 'h', stageId: 'SORT_1', passedKg: 10 }, {}), 'unauthenticated');
  await rejects(updateLotStage({ lotId: 'zzz', stageId: 'SORT_1', passedKg: 10 }, ctx('pre')), 'not-found');
  await rejects(updateLotStage({ lotId: 'h', stageId: 'NOPE', passedKg: 10 }, ctx('pre')), 'invalid-argument');
});

await test('khối lượng không hợp lệ hoặc lô đã đổi khối lượng', async () => {
  newLot('j');
  await rejects(updateLotStage({ lotId: 'j', stageId: 'SORT_1', passedKg: 101 }, ctx('pre')), 'invalid-argument');
  await rejects(updateLotStage({ lotId: 'j', stageId: 'SORT_1', passedKg: 50, expectedInputKg: 90 }, ctx('pre')), 'aborted');
  assert.equal(lot('j').currentStage, 'SORT_1');
});

await test('lô cũ chỉ có pendingStageId + intake.initialKg vẫn xử lý được', async () => {
  store.set('lots/old', { lotCode: 'OLD-1', status: 'waiting', pendingStageId: 'SORT_1', intake: { initialKg: 50 } });
  await updateLotStage({ lotId: 'old', stageId: 'SORT_1', passedKg: 50 }, ctx('pre'));
  assert.equal(lot('old').currentStage, 'SOAK_1');
  assert.equal(lot('old').history.length, 1);
});

await test('Kiểm má: đạt thì sang Định hình, không đạt quay lại Lạng má', async () => {
  newLot('k', { currentStage: 'CHECK_FLESH', pendingStageId: 'CHECK_FLESH' });
  const out = await updateLotStage({ lotId: 'k', stageId: 'CHECK_FLESH', passedKg: 80, rejectedLightKg: 20, soakTarget: 'FLESH' }, ctx('proc'));
  assert.equal(lot('k').currentStage, 'SHAPE');
  assert.equal(lot(out.child.id).currentStage, 'FLESH');
  assert.equal(lot(out.child.id).reworkCount, 1);
  newLot('l', { currentStage: 'CHECK_FLESH', pendingStageId: 'CHECK_FLESH', reworkCount: 2 });
  await rejects(updateLotStage({ lotId: 'l', stageId: 'CHECK_FLESH', passedKg: 80, rejectedLightKg: 20, soakTarget: 'FLESH' }, ctx('proc')), 'invalid-argument');
});

console.log(`\n${count} test đạt.`);
