// Kiểm tra logic quy trình: node scripts/test-workflow.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = require('../functions/workflow.js');
const client = await import('../js/traceability/workflow.js');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

test('bản trình duyệt khớp bản server', () => {
  assert.deepEqual(client.STAGES, server.STAGES);
  assert.deepEqual(client.DEPARTMENTS, server.DEPARTMENTS);
  assert.deepEqual(client.PHASES, server.PHASES);
  assert.equal(client.MAX_REWORK, server.MAX_REWORK);
});

test('mọi công đoạn trỏ tới công đoạn tồn tại và đi tới PACK', () => {
  for (const stage of Object.values(server.STAGES)) {
    if (stage.next) assert.ok(server.STAGES[stage.next], `${stage.id} → ${stage.next}`);
    stage.lightTo.forEach((id) => assert.ok(server.STAGES[id], `${stage.id} lightTo ${id}`));
    assert.ok(server.DEPARTMENTS[stage.departmentId], `${stage.id} bộ phận`);
  }
  let id = server.INTAKE_STAGE_ID;
  const seen = new Set();
  while (server.STAGES[id].next) {
    assert.ok(!seen.has(id), `vòng lặp tại ${id}`);
    seen.add(id);
    id = server.STAGES[id].next;
  }
  assert.equal(id, 'PACK');
});

test('bỏ Rửa 1-3 và chuyển Phân loại 2-4 thẳng sang Gọt vỏ', () => {
  for (const id of ['WASH_1', 'WASH_2', 'WASH_3']) {
    assert.equal(server.STAGES[id], undefined);
  }
  for (const id of ['SORT_2', 'SORT_3', 'SORT_4']) {
    assert.equal(server.STAGES[id].next, 'PEEL');
  }
});

test('bỏ Rửa 3-5, Kiểm má trước Định hình', () => {
  for (const id of ['WASH_3', 'WASH_4', 'WASH_5']) {
    assert.equal(server.STAGES[id], undefined);
  }
  assert.equal(server.STAGES.PEEL.next, 'FLESH');
  assert.equal(server.STAGES.FLESH.next, 'CHECK_FLESH');
  assert.equal(server.STAGES.CHECK_FLESH.next, 'SHAPE');
  assert.deepEqual(server.STAGES.CHECK_FLESH.lightTo, ['FLESH']);
  assert.equal(server.STAGES.SHAPE.next, 'PACK');
  assert.equal(server.STAGES.WASH_6, undefined);
});

test('bỏ Cấp đông, Rà kim loại và Vô kho đông; Định hình chuyển thẳng sang Đóng gói', () => {
  for (const id of ['FREEZE', 'METAL_DETECT', 'COLD_STORAGE']) {
    assert.equal(server.STAGES[id], undefined);
  }
  assert.equal(server.STAGES.PACK.next, null);
});

test('nhãn phụ phẩm trong phiếu thao tác theo từng công đoạn', () => {
  assert.equal(server.STAGES.SORT_1.name, 'Phân loại 1');
  assert.equal(server.STAGES.PEEL.byproductLabel, 'Vỏ');
  assert.equal(server.STAGES.FLESH.byproductLabel, 'Hạt');
  assert.equal(server.STAGES.SHAPE.byproductLabel, 'Vụn');
});

const sort1 = server.STAGES.SORT_1;
const evaluate = (stage, input, lot = {}) => server.evaluateStageResult(stage, lot, { inputKg: 100, ...input });

test('đạt toàn bộ', () => {
  const r = evaluate(sort1, { passedKg: 100 });
  assert.equal(r.outcome, 'passed');
  assert.equal(r.lossKg, 0);
});

test('tách đạt + hư nhẹ + hư nặng, phần dư là hao hụt', () => {
  const r = evaluate(sort1, { passedKg: 80, rejectedLightKg: 10, rejectedHeavyKg: 5 });
  assert.equal(r.outcome, 'passed');
  assert.equal(r.lightTarget, 'SOAK_1_1');
  assert.equal(r.lossKg, 5);
});

test('tổng vượt khối lượng vào bị từ chối', () => {
  assert.match(evaluate(sort1, { passedKg: 90, rejectedHeavyKg: 11 }).error, /vượt/);
});

test('chấp nhận sai số làm tròn rất nhỏ', () => {
  assert.equal(evaluate(sort1, { passedKg: 33.333, rejectedHeavyKg: 33.333, rejectedLightKg: 33.334 }).error, undefined);
});

test('không có khối lượng nào hoặc số âm', () => {
  assert.ok(evaluate(sort1, {}).error);
  assert.ok(evaluate(sort1, { passedKg: -1 }).error);
  assert.ok(evaluate(sort1, { passedKg: 'abc' }).error);
});

test('chỉ hư nhẹ → failed, lô chuyển sang ủ', () => {
  const r = evaluate(sort1, { rejectedLightKg: 100 });
  assert.equal(r.outcome, 'failed');
});

test('loại hết → rejected', () => {
  assert.equal(evaluate(sort1, { rejectedHeavyKg: 100 }).outcome, 'rejected');
});

test('SORT_4 không có đường hư nhẹ', () => {
  assert.match(evaluate(server.STAGES.SORT_4, { rejectedLightKg: 10, passedKg: 90 }).error, /không có đường/);
});

test('Kiểm má cần chọn nơi làm lại và bị giới hạn số lần', () => {
  const check = server.STAGES.CHECK_FLESH;
  assert.equal(evaluate(check, { passedKg: 90, rejectedLightKg: 10 }).lightTarget, 'FLESH');
  assert.equal(evaluate(check, { passedKg: 90, rejectedLightKg: 10, soakTarget: 'FLESH' }).lightTarget, 'FLESH');
  assert.match(evaluate(check, { passedKg: 90, rejectedLightKg: 10, soakTarget: 'SHAPE' }).error, /không hợp lệ/);
  assert.match(
    evaluate(check, { passedKg: 90, rejectedLightKg: 10, soakTarget: 'FLESH' }, { reworkCount: server.MAX_REWORK }).error,
    /tối đa/
  );
});

test('phân quyền theo bộ phận và vai trò', () => {
  const { canOperate, STAGES } = server;
  assert.equal(canOperate(STAGES.SORT_2, { role: 'staff', departmentId: 'PREPROCESS' }), true);
  assert.equal(canOperate(STAGES.SOAK_3, { role: 'staff', departmentId: 'PREPROCESS' }), true);
  assert.equal(canOperate(STAGES.PEEL, { role: 'staff', departmentId: 'PREPROCESS' }), false);
  assert.equal(canOperate(STAGES.FLESH, { role: 'staff', departmentId: 'PROCESSING' }), true);
  assert.equal(canOperate(STAGES.FREEZE, { role: 'staff', departmentId: 'PROCESSING' }), false);
  assert.equal(canOperate(STAGES.PACK, { role: 'staff', departmentId: 'FREEZE_PACK' }), true);
  assert.equal(canOperate(STAGES.PACK, { role: 'staff', departmentId: '' }), false);
  assert.equal(canOperate(STAGES.PACK, { role: 'admin', departmentId: '' }), true);
  assert.equal(canOperate(STAGES.PEEL, { role: 'dev', departmentId: '' }), true);
});

test('lô cũ chỉ có pendingStageId vẫn đọc được', () => {
  assert.equal(server.getLotStageId({ pendingStageId: 'SORT_1' }), 'SORT_1');
  assert.equal(server.getLotInputKg({ intake: { initialKg: 120.5 } }), 120.5);
  assert.equal(server.getLotInputKg({ currentKg: 80, intake: { initialKg: 120.5 } }), 80);
});

console.log(`\n${passed} test đạt.`);
