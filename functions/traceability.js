'use strict';

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const workflow = require('./workflow');

const REGION = 'asia-southeast1';
const { HttpsError } = functions.https;

const text = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Lấy thông tin người thao tác; vai trò và bộ phận luôn đọc từ users/{uid}, không tin dữ liệu client. */
async function loadActor(db, context) {
  const snapshot = await db.collection('users').doc(context.auth.uid).get();
  const user = snapshot.exists ? snapshot.data() || {} : {};
  return {
    uid: context.auth.uid,
    name: user.name || context.auth.token.name || '',
    email: context.auth.token.email || '',
    role: context.auth.token.admin === true ? 'admin' : user.role || 'staff',
    departmentId: workflow.resolveDepartmentId(user)
  };
}

/** Bộ khung một bản ghi lịch sử; Timestamp.now() vì serverTimestamp không dùng được trong mảng. */
function historyEntry(actor, fields) {
  const entry = {
    stage: fields.stage,
    action: fields.action,
    fromStatus: fields.fromStatus ?? null,
    toStatus: fields.toStatus ?? null,
    operatorId: actor.uid,
    operatorName: actor.name,
    timestamp: admin.firestore.Timestamp.now()
  };
  if (fields.note) entry.note = fields.note;
  if (fields.kgData) entry.kgData = fields.kgData;
  return entry;
}

/**
 * Lõi xử lý một công đoạn, dùng chung cho updateLotStage / sendToSoak / rejectLot / completeLot.
 * mode: 'update' (nhập tách kg) | 'soak' (chuyển cả lô sang hư nhẹ) | 'reject' (loại cả lô)
 *       | 'complete' (hoàn thành lô ở công đoạn lựa sau ủ, số còn lại tính hao hụt, không tạo lô mới).
 * Chạy trong transaction để hai thiết bị không xử lý cùng một lô cùng lúc.
 */
async function commitStageResult(data, context, mode) {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'Bạn cần đăng nhập để thao tác công đoạn.');
  }
  const lotId = text(data?.lotId, 200);
  const stageId = text(data?.stageId, 50);
  const note = text(data?.note);
  const stageDef = workflow.STAGES[stageId];
  if (!lotId || lotId.includes('/')) throw new HttpsError('invalid-argument', 'Thiếu mã lô.');
  if (!stageDef) throw new HttpsError('invalid-argument', `Công đoạn ${stageId || '(trống)'} không tồn tại.`);
  if (mode === 'reject' && note.length < 3) {
    throw new HttpsError('invalid-argument', 'Nhập lý do loại bỏ (tối thiểu 3 ký tự).');
  }
  if (mode === 'complete' && stageDef.kind !== 'grade') {
    throw new HttpsError('failed-precondition', 'Chỉ hoàn thành lô được ở công đoạn Lựa sau ủ.');
  }

  const db = admin.firestore();
  const actor = await loadActor(db, context);
  if (!workflow.canOperate(stageDef, actor)) {
    throw new HttpsError('permission-denied',
      `Công đoạn ${stageDef.name} thuộc bộ phận ${workflow.DEPARTMENTS[stageDef.departmentId]}. Bạn không có quyền thao tác.`);
  }

  const lotRef = db.collection('lots').doc(lotId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lotRef);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Không tìm thấy lô (có thể đã bị xoá).');
    const lot = snapshot.data() || {};

    if (lot.status !== 'waiting') {
      throw new HttpsError('failed-precondition', 'Lô không ở trạng thái chờ xử lý (đã hoàn tất hoặc bị loại).');
    }
    const currentStageId = workflow.getLotStageId(lot);
    if (currentStageId !== stageId) {
      throw new HttpsError('failed-precondition', `Lô đang ở công đoạn ${currentStageId || '-'}, không phải ${stageId}. Hãy tải lại danh sách.`);
    }

    const inputKg = workflow.getLotInputKg(lot);
    const expectedKg = data?.expectedInputKg;
    if (expectedKg !== undefined && expectedKg !== null && Math.abs(Number(expectedKg) - inputKg) > workflow.KG_EPSILON) {
      throw new HttpsError('aborted', 'Khối lượng của lô vừa thay đổi. Hãy tải lại rồi nhập lại.');
    }

    if (mode === 'complete') {
      const now = admin.firestore.Timestamp.now();
      const kgData = { inputKg, passedKg: 0, rejectedHeavyKg: 0, rejectedLightKg: 0, lossKg: inputKg, completed: true };
      transaction.update(lotRef, {
        [`stages.${stageId}`]: {
          status: 'passed',
          operatorId: actor.uid,
          operatorName: actor.name,
          departmentId: stageDef.departmentId,
          startedAt: lot.stageEnteredAt || lot.createdAt || now,
          finishedAt: now,
          result: { ...kgData, note }
        },
        status: 'completed',
        pendingStageId: null,
        pendingDepartmentId: null,
        currentKg: 0,
        completedAt: now,
        lastStageId: stageId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        history: admin.firestore.FieldValue.arrayUnion(historyEntry(actor, {
          stage: stageId,
          action: 'COMPLETE_LOT',
          fromStatus: 'pending',
          toStatus: 'passed',
          note,
          kgData
        }))
      });
      return {
        lotId, lotCode: lot.lotCode || '', outcome: 'passed', nextStage: null, completed: false,
        lotCompleted: true, lossKg: inputKg, partial: false, remainderKg: 0, child: null, children: []
      };
    }

    const requested = mode === 'soak'
      ? { passedKg: 0, rejectedHeavyKg: 0, rejectedLightKg: inputKg, soakTarget: text(data?.soakTarget, 50) }
      : mode === 'reject'
        ? { passedKg: 0, rejectedHeavyKg: inputKg, rejectedLightKg: 0 }
        : {
          passedKg: data?.passedKg,
          rejectedHeavyKg: data?.rejectedHeavyKg,
          rejectedLightKg: data?.rejectedLightKg,
          damagedKg: data?.damagedKg,
          exportKg: data?.exportKg,
          soakTarget: text(data?.soakTarget, 50)
        };
    const result = workflow.evaluateStageResult(stageDef, lot, { ...requested, inputKg });
    if (result.error) throw new HttpsError('invalid-argument', result.error);

    const now = admin.firestore.Timestamp.now();
    const serverNow = admin.firestore.FieldValue.serverTimestamp();
    const usesExport = stageDef.kind === 'grade' || Boolean(stageDef.partialExport);
    // Xuất một phần: lô chính ở lại công đoạn với phần còn lại, phần xuất ra thành lô con.
    const partial = result.remainderKg > 0;
    const kgData = {
      inputKg: result.inputKg,
      ...(usesExport ? { exportKg: result.exportKg } : {}),
      ...(partial ? { remainderKg: result.remainderKg } : {}),
      passedKg: result.passedKg,
      rejectedHeavyKg: result.rejectedHeavyKg,
      rejectedLightKg: result.rejectedLightKg,
      ...(result.damagedKg > 0 ? { damagedKg: result.damagedKg } : {}),
      lossKg: result.lossKg
    };
    const stageRecord = {
      status: result.outcome,
      operatorId: actor.uid,
      operatorName: actor.name,
      departmentId: stageDef.departmentId,
      startedAt: lot.stageEnteredAt || lot.createdAt || now,
      finishedAt: now,
      result: {
        ...kgData,
        ...(result.lightTarget ? { soakTarget: result.lightTarget } : {}),
        note
      }
    };
    const pendingStage = (id) => ({
      status: 'pending',
      departmentId: workflow.STAGES[id].departmentId,
      enteredAt: now
    });
    // Đưa lô (hoặc lô con) vào hàng chờ của một công đoạn.
    const enterStage = (id, kg, reworkCount) => ({
      currentStage: id,
      pendingStageId: id,
      pendingDepartmentId: workflow.STAGES[id].departmentId,
      status: 'waiting',
      currentKg: kg,
      stageEnteredAt: now,
      reworkCount
    });

    const reworkCount = Number(lot.reworkCount || 0);
    const nextReworkCount = stageDef.rework && result.lightTarget ? reworkCount + 1 : reworkCount;
    const action = mode === 'soak' ? 'SEND_TO_SOAK' : mode === 'reject' ? 'REJECT' : 'RECORD_RESULT';
    const update = {
      lastStageId: stageId,
      updatedAt: serverNow
    };
    if (!partial) update[`stages.${stageId}`] = stageRecord;
    const entries = [];
    let nextStage = null;
    let child = null;
    let childCount = Number(lot.childCount || 0);

    const createChild = (targetId, kg, childReworkCount, kgInfo) => {
      childCount += 1;
      const childRef = db.collection('lots').doc();
      const childCode = `${lot.lotCode}-${workflow.STAGES[targetId].short}${childCount}`;
      transaction.create(childRef, {
        lotCode: childCode,
        parentLotIds: [lotId],
        createdAt: serverNow,
        createdBy: actor.uid,
        updatedAt: serverNow,
        intake: { ...(lot.intake || {}), initialKg: kg },
        lastStageId: stageId,
        stages: { [targetId]: pendingStage(targetId) },
        ...enterStage(targetId, kg, childReworkCount),
        history: [historyEntry(actor, {
          stage: stageId,
          action: 'SPLIT_FROM_PARENT',
          fromStatus: null,
          toStatus: 'pending',
          note,
          kgData: { parentLotId: lotId, parentLotCode: lot.lotCode, lightKg: kg, ...kgInfo }
        })]
      });
      update.childCount = childCount;
      return { id: childRef.id, lotCode: childCode, stageId: targetId };
    };
    const children = [];

    if (partial) {
      // Lô chính vẫn đứng ở công đoạn này (status 'waiting') với phần chưa xuất.
      Object.assign(update, { currentKg: result.remainderKg });
      if (result.passedKg > 0) children.push(createChild(stageDef.next, result.passedKg, reworkCount, { passedKg: result.passedKg }));
      if (result.rejectedLightKg > 0) children.push(createChild(result.lightTarget, result.rejectedLightKg, nextReworkCount, {}));
      child = children[0] || null;
    } else if (result.outcome === 'passed') {
      if (stageDef.next) {
        nextStage = stageDef.next;
        Object.assign(update, enterStage(nextStage, result.passedKg, reworkCount), { [`stages.${nextStage}`]: pendingStage(nextStage) });
      } else {
        Object.assign(update, {
          status: 'completed', pendingStageId: null, pendingDepartmentId: null,
          currentKg: result.passedKg, completedAt: now
        });
      }
      // Phần hư nhẹ tách thành lô con để lô chính vẫn đi tiếp.
      if (result.rejectedLightKg > 0) {
        child = createChild(result.lightTarget, result.rejectedLightKg, nextReworkCount, {});
      }
    } else if (result.outcome === 'failed') {
      // Không có phần đạt: cả phần hư nhẹ còn lại đi tiếp ngay trong lô này.
      nextStage = result.lightTarget;
      Object.assign(update, enterStage(nextStage, result.rejectedLightKg, nextReworkCount), { [`stages.${nextStage}`]: pendingStage(nextStage) });
    } else {
      Object.assign(update, {
        status: 'rejected', pendingStageId: null, pendingDepartmentId: null, currentKg: 0, rejectedAt: now
      });
    }

    entries.push(historyEntry(actor, {
      stage: stageId,
      action,
      fromStatus: 'pending',
      toStatus: partial ? 'pending' : result.outcome,
      note,
      kgData: {
        ...kgData,
        ...(nextStage ? { nextStage } : {}),
        ...(child ? { childLotId: child.id, childLotCode: child.lotCode, childStage: child.stageId } : {}),
        ...(partial ? { children: children.map((item) => ({ lotId: item.id, lotCode: item.lotCode, stage: item.stageId })) } : {}),
        ...(!stageDef.next && result.outcome === 'passed' ? { completed: true } : {})
      }
    }));
    update.history = admin.firestore.FieldValue.arrayUnion(...entries);
    transaction.update(lotRef, update);

    return {
      lotId,
      lotCode: lot.lotCode || '',
      outcome: result.outcome,
      nextStage,
      completed: !partial && !stageDef.next && result.outcome === 'passed',
      lossKg: result.lossKg,
      partial,
      remainderKg: result.remainderKg,
      child,
      children
    };
  });
}

/** Ghi kết quả một công đoạn: đạt đi tiếp, hư nhẹ tách ủ/làm lại, hư nặng loại bỏ. */
exports.updateLotStage = functions.region(REGION).https.onCall((data, context) => commitStageResult(data, context, 'update'));

/** Chuyển toàn bộ khối lượng hiện có của lô sang công đoạn ủ / làm lại. */
exports.sendToSoak = functions.region(REGION).https.onCall((data, context) => commitStageResult(data, context, 'soak'));

/** Loại bỏ toàn bộ lô (bắt buộc ghi lý do). */
exports.rejectLot = functions.region(REGION).https.onCall((data, context) => commitStageResult(data, context, 'reject'));

/** Hoàn thành lô ở công đoạn Lựa sau ủ: đóng lô, số kg còn lại tính hao hụt, không tạo lô mới. */
exports.completeLot = functions.region(REGION).https.onCall((data, context) => commitStageResult(data, context, 'complete'));
