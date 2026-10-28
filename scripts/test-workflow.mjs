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

test('chỉ còn Phân loại xuống xe → Ủ lần 1 → Lựa sau ủ 1 → Gọt vỏ / Ủ lần 2 → Lựa sau ủ 2', () => {
  for (const id of ['WASH_1', 'WASH_2', 'WASH_3', 'SORT_2', 'SORT_3', 'SORT_4', 'SOAK_1_1', 'SOAK_3']) {
    assert.equal(server.STAGES[id], undefined, id);
  }
  const { STAGES } = server;
  assert.equal(STAGES.SORT_1.next, 'SOAK_1');
  assert.deepEqual(STAGES.SORT_1.lightTo, []);
  assert.equal(STAGES.SOAK_1.next, 'SORT_SOAK_1');
  assert.equal(STAGES.SORT_SOAK_1.kind, 'grade');
  assert.equal(STAGES.SORT_SOAK_1.next, 'PEEL');
  assert.deepEqual(STAGES.SORT_SOAK_1.lightTo, ['SOAK_2']);
  assert.equal(STAGES.SOAK_2.next, 'SORT_SOAK_2');
  assert.equal(STAGES.SORT_SOAK_2.kind, 'grade');
  assert.equal(STAGES.SORT_SOAK_2.next, 'PEEL');
  assert.deepEqual(STAGES.SORT_SOAK_2.lightTo, []);
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
  assert.equal(server.STAGES.SORT_1.name, 'Phân loại xuống xe');
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

test('tách đạt + hư nặng, phần dư là hao hụt', () => {
  const r = evaluate(sort1, { passedKg: 80, rejectedHeavyKg: 15 });
  assert.equal(r.outcome, 'passed');
  assert.equal(r.lossKg, 5);
  assert.equal(r.remainderKg, 0);
});

test('tổng vượt khối lượng vào bị từ chối', () => {
  assert.match(evaluate(sort1, { passedKg: 90, rejectedHeavyKg: 11 }).error, /vượt/);
});

test('chấp nhận sai số làm tròn rất nhỏ', () => {
  assert.equal(evaluate(sort1, { passedKg: 33.333, rejectedHeavyKg: 33.333, rejectedLightKg: 0 }).error, undefined);
});

test('không có khối lượng nào hoặc số âm', () => {
  assert.ok(evaluate(sort1, {}).error);
  assert.ok(evaluate(sort1, { passedKg: -1 }).error);
  assert.ok(evaluate(sort1, { passedKg: 'abc' }).error);
});

test('loại hết → rejected', () => {
  assert.equal(evaluate(sort1, { rejectedHeavyKg: 100 }).outcome, 'rejected');
});

test('Phân loại xuống xe không có đường hư nhẹ', () => {
  assert.match(evaluate(sort1, { rejectedLightKg: 10, passedKg: 90 }).error, /không có đường/);
});

const grade1 = server.STAGES.SORT_SOAK_1;
const grade2 = server.STAGES.SORT_SOAK_2;

test('Lựa sau ủ 1: đạt + không đạt phải bằng số lượng xuất', () => {
  const ok = evaluate(grade1, { exportKg: 100, passedKg: 70, rejectedLightKg: 30 });
  assert.equal(ok.outcome, 'passed');
  assert.equal(ok.lightTarget, 'SOAK_2');
  assert.equal(ok.lossKg, 0);
  assert.equal(ok.remainderKg, 0);
  assert.match(evaluate(grade1, { exportKg: 100, passedKg: 70, rejectedLightKg: 20 }).error, /phải bằng/);
  assert.match(evaluate(grade1, { exportKg: 100, passedKg: 80, rejectedLightKg: 30 }).error, /vượt/);
});

test('Lựa sau ủ 1: xuất một phần thì phần còn lại ở lại', () => {
  const r = evaluate(grade1, { exportKg: 40, passedKg: 25, rejectedLightKg: 15 });
  assert.equal(r.remainderKg, 60);
  assert.equal(r.lossKg, 0);
  assert.match(evaluate(grade1, { exportKg: 101, passedKg: 101 }).error, /vượt/);
  assert.match(evaluate(grade1, { exportKg: 0, passedKg: 0 }).error, /lớn hơn 0/);
});

test('Lựa sau ủ 1: không đạt chỉ đi ủ lần 2, không có đường loại bỏ', () => {
  assert.match(evaluate(grade1, { passedKg: 90, rejectedHeavyKg: 10 }).error, /ủ/);
  assert.equal(evaluate(grade1, { rejectedLightKg: 100 }).outcome, 'failed');
});

test('Lựa sau ủ 2: không đạt tính vào hao hụt và bỏ luôn', () => {
  const r = evaluate(grade2, { exportKg: 100, passedKg: 60, rejectedHeavyKg: 40 });
  assert.equal(r.outcome, 'passed');
  assert.equal(r.lossKg, 40);
  assert.equal(r.rejectedHeavyKg, 0);
  assert.equal(r.lightTarget, null);
  assert.equal(evaluate(grade2, { passedKg: 0, rejectedHeavyKg: 100 }).outcome, 'rejected');
  assert.match(evaluate(grade2, { passedKg: 60, rejectedLightKg: 40 }).error, /không có đường/);
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
  assert.equal(canOperate(STAGES.SORT_SOAK_1, { role: 'staff', departmentId: 'PREPROCESS' }), true);
  assert.equal(canOperate(STAGES.SOAK_2, { role: 'staff', departmentId: 'PREPROCESS' }), true);
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

test('lô kẹt ở công đoạn cũ được xem như đang ở công đoạn thay thế', () => {
  assert.deepEqual(client.LEGACY_STAGE_MAP, server.LEGACY_STAGE_MAP);
  for (const target of Object.values(server.LEGACY_STAGE_MAP)) assert.ok(server.STAGES[target], target);
  assert.equal(server.getLotStageId({ currentStage: 'SORT_2', pendingStageId: 'SORT_2' }), 'SORT_SOAK_1');
  assert.equal(client.getLotStageId({ pendingStageId: 'SOAK_1_1' }), 'SOAK_1');
  assert.deepEqual(client.legacyIdsOf('SORT_SOAK_1').sort(), ['SORT_2', 'SORT_3', 'SORT_4']);
  assert.equal(client.stageName('SORT_2'), 'Lựa sau ủ 1');
});

console.log(`\n${passed} test đạt.`);
