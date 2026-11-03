// Kiểm tra luồng updateLotStage / sendToSoak / rejectLot với Firestore giả lập trong bộ nhớ.
// Chạy: node scripts/test-stage-functions.mjs  (không cần cài firebase-admin hay emulator)
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

// Tắt rate limit trong test này: nhiều thao tác liên tiếp của cùng một người sẽ bị cấm.
process.env.RATE_LIMIT_DISABLED = '1';

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
const fakeFunctions = { region: () => ({ https: { onCall: (handler) => handler } }), https: { HttpsError }, logger: { info() {}, warn() {}, error() {} } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin') return fakeAdmin;
  if (request === 'firebase-functions/v1') return fakeFunctions;
  return originalLoad.call(this, request, ...rest);
};
const { updateLotStage, sendToSoak, rejectLot, completeLot } = require('../functions/traceability.js');

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

await test('Lựa sau ủ 1 xuất toàn bộ: đạt đi tiếp, không đạt tách lô con sang Ủ lần 2', async () => {
  newLot('b', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  const out = await updateLotStage({ lotId: 'b', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 70, rejectedLightKg: 30 }, ctx('pre'));
  assert.equal(out.nextStage, 'PEEL');
  assert.equal(out.partial, false);
  assert.equal(lot('b').currentStage, 'PEEL');
  assert.equal(lot('b').currentKg, 70);
  const child = lot(out.child.id);
  assert.equal(child.lotCode, 'LOT-b-U21');
  assert.equal(child.currentStage, 'SOAK_2');
  assert.equal(child.currentKg, 30);
  assert.deepEqual(child.parentLotIds, ['b']);
  assert.equal(child.intake.initialKg, 30);
  assert.equal(child.history[0].action, 'SPLIT_FROM_PARENT');
  assert.equal(lot('b').childCount, 1);
  assert.equal(lot('b').history[0].kgData.exportKg, 100);
});

await test('Lựa sau ủ 1: đạt + không đạt khác số lượng xuất bị từ chối', async () => {
  newLot('b2', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  await rejects(updateLotStage({ lotId: 'b2', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 70, rejectedLightKg: 20 }, ctx('pre')), 'invalid-argument');
  await rejects(updateLotStage({ lotId: 'b2', stageId: 'SORT_SOAK_1', exportKg: 120, passedKg: 120 }, ctx('pre')), 'invalid-argument');
  assert.equal(lot('b2').currentStage, 'SORT_SOAK_1');
});

await test('Lựa sau ủ 1 xuất một phần: lô chính ở lại, phần xuất thành lô con', async () => {
  newLot('b3', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  const out = await updateLotStage({ lotId: 'b3', stageId: 'SORT_SOAK_1', exportKg: 40, passedKg: 25, rejectedLightKg: 15 }, ctx('pre'));
  assert.equal(out.partial, true);
  assert.equal(out.remainderKg, 60);
  assert.equal(out.children.length, 2);
  const main = lot('b3');
  assert.equal(main.currentStage, 'SORT_SOAK_1');
  assert.equal(main.status, 'waiting');
  assert.equal(main.currentKg, 60);
  assert.equal(main.stages.SORT_SOAK_1, undefined);
  const [passedChild, failedChild] = out.children.map((item) => lot(item.id));
  assert.equal(passedChild.currentStage, 'PEEL');
  assert.equal(passedChild.currentKg, 25);
  assert.equal(failedChild.currentStage, 'SOAK_2');
  assert.equal(failedChild.currentKg, 15);
  assert.equal(main.history[0].kgData.remainderKg, 60);
  // Phần còn lại xuất tiếp được.
  const rest = await updateLotStage({ lotId: 'b3', stageId: 'SORT_SOAK_1', exportKg: 60, passedKg: 60 }, ctx('pre'));
  assert.equal(rest.partial, false);
  assert.equal(lot('b3').currentStage, 'PEEL');
});

await test('Lựa sau ủ 2: không đạt vào hao hụt và bỏ luôn, đạt xuống Gọt vỏ', async () => {
  newLot('b4', { currentStage: 'SORT_SOAK_2', pendingStageId: 'SORT_SOAK_2' });
  const before = store.size;
  const out = await updateLotStage({ lotId: 'b4', stageId: 'SORT_SOAK_2', exportKg: 100, passedKg: 60, rejectedHeavyKg: 40 }, ctx('pre'));
  assert.equal(out.nextStage, 'PEEL');
  assert.equal(out.lossKg, 40);
  assert.equal(store.size, before);
  assert.equal(lot('b4').currentKg, 60);
  assert.equal(lot('b4').history[0].kgData.lossKg, 40);
});

await test('Ủ lần 1 xong chuyển cả lô sang Lựa sau ủ 1', async () => {
  newLot('b5', { currentStage: 'SOAK_1', pendingStageId: 'SOAK_1' });
  const out = await updateLotStage({ lotId: 'b5', stageId: 'SOAK_1', passedKg: 100 }, ctx('pre'));
  assert.equal(out.nextStage, 'SORT_SOAK_1');
  assert.equal(lot('b5').currentStage, 'SORT_SOAK_1');
});

await test('Ủ lần 1 hàng tồn: chuyển một phần sang Lựa sau ủ 1, phần còn lại ở lại', async () => {
  newLot('b6', { currentStage: 'SOAK_1', pendingStageId: 'SOAK_1' });
  const out = await updateLotStage({ lotId: 'b6', stageId: 'SOAK_1', exportKg: 30, passedKg: 30 }, ctx('pre'));
  assert.equal(out.partial, true);
  assert.equal(out.remainderKg, 70);
  assert.equal(lot('b6').currentStage, 'SOAK_1');
  assert.equal(lot('b6').currentKg, 70);
  const child = lot(out.child.id);
  assert.equal(child.currentStage, 'SORT_SOAK_1');
  assert.equal(child.currentKg, 30);
  await rejects(updateLotStage({ lotId: 'b6', stageId: 'SOAK_1', exportKg: 80, passedKg: 80 }, ctx('pre')), 'invalid-argument');
  await rejects(updateLotStage({ lotId: 'b6', stageId: 'SOAK_1', exportKg: 40, passedKg: 30 }, ctx('pre')), 'invalid-argument');
  const rest = await updateLotStage({ lotId: 'b6', stageId: 'SOAK_1', exportKg: 70, passedKg: 70 }, ctx('pre'));
  assert.equal(rest.partial, false);
  assert.equal(lot('b6').currentStage, 'SORT_SOAK_1');
});

await test('sendToSoak chuyển cả lô Lựa sau ủ 1 sang Ủ lần 2, không tạo lô con', async () => {
  newLot('c', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  const before = store.size;
  const out = await sendToSoak({ lotId: 'c', stageId: 'SORT_SOAK_1' }, ctx('pre'));
  assert.equal(out.outcome, 'failed');
  assert.equal(lot('c').currentStage, 'SOAK_2');
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
  await rejects(updateLotStage({ lotId: 'h', stageId: 'SORT_SOAK_1', passedKg: 10 }, ctx('pre')), 'failed-precondition');
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

await test('luồng đủ: Phân loại xuống xe → Ủ 1 → Lựa sau ủ 1 → (đạt) Gọt vỏ / (không đạt) Ủ 2 → Lựa sau ủ 2 → Gọt vỏ', async () => {
  newLot('flow');
  await updateLotStage({ lotId: 'flow', stageId: 'SORT_1', passedKg: 100 }, ctx('pre'));
  assert.equal(lot('flow').currentStage, 'SOAK_1');
  await updateLotStage({ lotId: 'flow', stageId: 'SOAK_1', exportKg: 100, passedKg: 100 }, ctx('pre'));
  assert.equal(lot('flow').currentStage, 'SORT_SOAK_1');
  const afterSoak1 = await updateLotStage({ lotId: 'flow', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 60, rejectedLightKg: 40 }, ctx('pre'));
  assert.equal(lot('flow').currentStage, 'PEEL');
  assert.equal(lot('flow').currentKg, 60);
  const soak2 = afterSoak1.child.id;
  assert.equal(lot(soak2).currentStage, 'SOAK_2');
  await updateLotStage({ lotId: soak2, stageId: 'SOAK_2', passedKg: 40 }, ctx('pre'));
  assert.equal(lot(soak2).currentStage, 'SORT_SOAK_2');
  const afterSoak2 = await updateLotStage({ lotId: soak2, stageId: 'SORT_SOAK_2', exportKg: 40, passedKg: 30, rejectedHeavyKg: 10 }, ctx('pre'));
  assert.equal(afterSoak2.lossKg, 10);
  assert.equal(lot(soak2).currentStage, 'PEEL');
  assert.equal(lot(soak2).currentKg, 30);
});

await test('lô đang kẹt ở Phân loại 2 (bản cũ) vẫn xử lý được ở Lựa sau ủ 1', async () => {
  newLot('stuck', { currentStage: 'SORT_2', pendingStageId: 'SORT_2' });
  const out = await updateLotStage({ lotId: 'stuck', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 100 }, ctx('pre'));
  assert.equal(out.nextStage, 'PEEL');
  assert.equal(lot('stuck').currentStage, 'PEEL');
});

await test('Lựa sau ủ: số hỏng tính là hư hỏng, đạt + không đạt + hỏng phải bằng số xuất', async () => {
  newLot('d1', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  await rejects(updateLotStage({ lotId: 'd1', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 60, rejectedLightKg: 30 }, ctx('pre')), 'invalid-argument');
  const before = store.size;
  const out = await updateLotStage({ lotId: 'd1', stageId: 'SORT_SOAK_1', exportKg: 100, passedKg: 60, rejectedLightKg: 30, damagedKg: 10 }, ctx('pre'));
  assert.equal(out.nextStage, 'PEEL');
  assert.equal(lot('d1').currentKg, 60);
  assert.equal(lot(out.child.id).currentKg, 30);
  assert.equal(store.size, before + 1);
  assert.equal(lot('d1').history[0].kgData.damagedKg, 10);
  assert.equal(out.lossKg, 0);
  newLot('d2', { currentStage: 'SORT_SOAK_2', pendingStageId: 'SORT_SOAK_2' });
  const out2 = await updateLotStage({ lotId: 'd2', stageId: 'SORT_SOAK_2', exportKg: 100, passedKg: 50, rejectedHeavyKg: 30, damagedKg: 20 }, ctx('pre'));
  assert.equal(out2.lossKg, 30);
  assert.equal(lot('d2').history[0].kgData.damagedKg, 20);
  assert.equal(lot('d2').currentKg, 50);
});

await test('số hỏng chỉ nhập được ở công đoạn lựa sau ủ', async () => {
  newLot('d3');
  await rejects(updateLotStage({ lotId: 'd3', stageId: 'SORT_1', passedKg: 90, damagedKg: 10 }, ctx('pre')), 'invalid-argument');
});

await test('Hoàn thành lô ở Lựa sau ủ: đóng lô, không tạo lô mới, số còn lại tính hao hụt', async () => {
  newLot('h1', { currentStage: 'SORT_SOAK_1', pendingStageId: 'SORT_SOAK_1' });
  const part = await updateLotStage({ lotId: 'h1', stageId: 'SORT_SOAK_1', exportKg: 40, passedKg: 40 }, ctx('pre'));
  assert.equal(part.remainderKg, 60);
  const before = store.size;
  const out = await completeLot({ lotId: 'h1', stageId: 'SORT_SOAK_1' }, ctx('pre'));
  assert.equal(out.lotCompleted, true);
  assert.equal(out.lossKg, 60);
  assert.equal(store.size, before);
  assert.equal(lot('h1').status, 'completed');
  assert.equal(lot('h1').pendingStageId, null);
  assert.equal(lot('h1').history.at(-1).action, 'COMPLETE_LOT');
  assert.equal(lot('h1').history.at(-1).kgData.lossKg, 60);
  await rejects(completeLot({ lotId: 'h1', stageId: 'SORT_SOAK_1' }, ctx('pre')), 'failed-precondition');
  newLot('h2', { currentStage: 'SOAK_1', pendingStageId: 'SOAK_1' });
  await rejects(completeLot({ lotId: 'h2', stageId: 'SOAK_1' }, ctx('pre')), 'failed-precondition');
  newLot('h3', { currentStage: 'SORT_SOAK_2', pendingStageId: 'SORT_SOAK_2' });
  await rejects(completeLot({ lotId: 'h3', stageId: 'SORT_SOAK_2' }, ctx('proc')), 'permission-denied');
  await completeLot({ lotId: 'h3', stageId: 'SORT_SOAK_2' }, ctx('pre'));
  assert.equal(lot('h3').status, 'completed');
});

console.log(`\n${count} test đạt.`);
