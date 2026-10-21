const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cors = require('cors');
const workflow = require('./workflow');

admin.initializeApp();

const corsHandler = cors({
  origin: true,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

const ZAPIER_SECRET = process.env.ZAPIER_SECRET || 'replace-with-your-secret';
const GMAIL_USER = process.env.GMAIL_USER || 'your-gmail@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS || '';

const transporter = GMAIL_USER && GMAIL_PASS
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
      }
    })
  : null;

function getBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

function normalizeIncomingPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  if (Array.isArray(payload)) {
    return { items: payload };
  }

  return payload;
}

exports.zapierWebhook = functions.region('asia-southeast1').https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, message: 'Method not allowed' });
      return;
    }

    const token = getBearerToken(req);
    if (!token || token !== ZAPIER_SECRET) {
      res.status(401).json({ ok: false, message: 'Unauthorized: invalid or missing Authorization bearer token' });
      return;
    }

    try {
      const payload = normalizeIncomingPayload(req.body || {});
      const docData = {
        source: 'zapier',
        eventType: payload.eventType || payload.type || 'incoming',
        payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        receivedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const docRef = await admin.firestore().collection('zapierInbound').add(docData);

      res.status(200).json({
        ok: true,
        message: 'Zapier payload received and saved to Firestore',
        docId: docRef.id
      });
    } catch (error) {
      console.error('zapierWebhook error:', error);
      res.status(500).json({
        ok: false,
        message: error && error.message ? error.message : 'Lỗi xử lý webhook từ Zapier'
      });
    }
  });
});

exports.sendProductionReport = functions.region('asia-southeast1').https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, message: 'Method not allowed' });
      return;
    }

    try {
      const { recipients, subject, html, reportDate, senderEmail } = req.body || {};
      const senderAddress = typeof senderEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail.trim())
        ? senderEmail.trim()
        : GMAIL_USER;

      if (!Array.isArray(recipients) || recipients.length === 0) {
        res.status(400).json({ ok: false, message: 'Danh sách người nhận không hợp lệ' });
        return;
      }

      const validRecipients = recipients
        .map((item) => String(item).trim())
        .filter((email) => email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));

      if (!validRecipients.length) {
        res.status(400).json({ ok: false, message: 'Không có email hợp lệ trong recipients' });
        return;
      }

      const finalSubject = subject || `[Báo cáo Chanh Thu] ${reportDate || new Date().toISOString()}`;
      const finalHtml = html || '<p>Không có nội dung báo cáo.</p>';

      if (!transporter) {
        res.status(500).json({
          ok: false,
          message: 'Cấu hình Gmail chưa được thiết lập. Vui lòng đặt GMAIL_USER và GMAIL_PASS cho Firebase Function.'
        });
        return;
      }

      const mailOptions = {
        from: `Báo cáo Chanh Thu <${senderAddress}>`,
        to: validRecipients.join(', '),
        subject: finalSubject,
        html: finalHtml,
        replyTo: senderAddress
      };

      await transporter.sendMail(mailOptions);

      res.status(200).json({
        ok: true,
        message: 'Đã gửi email thành công'
      });
    } catch (error) {
      console.error('sendProductionReport error:', error);
      res.status(500).json({
        ok: false,
        message: error && error.message ? error.message : 'Lỗi gửi email'
      });
    }
  });
});

/**
 * Applies an immutable event's material-balance delta to its lot cache.
 * The marker collection makes the update safe if Firestore retries the trigger.
 */
exports.onStageEventCreated = functions.region('asia-southeast1')
  .firestore.document('stage_events/{eventId}')
  .onCreate(async (snapshot, context) => {
    const event = snapshot.data() || {};
    const lotId = typeof event.lotId === 'string' ? event.lotId.trim() : '';
    const quantityDeltaKg = Number(event.quantityDeltaKg);

    if (!lotId) {
      console.error('stage_events document is missing lotId', context.params.eventId);
      return null;
    }
    if (!Number.isFinite(quantityDeltaKg)) {
      console.error('stage_events document is missing a valid quantityDeltaKg', context.params.eventId);
      return null;
    }

    const db = admin.firestore();
    const lotRef = db.collection('lots').doc(lotId);
    const appliedRef = db.collection('stage_event_cache_applications').doc(context.params.eventId);

    await db.runTransaction(async (transaction) => {
      const [lotSnapshot, appliedSnapshot] = await Promise.all([
        transaction.get(lotRef),
        transaction.get(appliedRef)
      ]);

      if (appliedSnapshot.exists) return;
      if (!lotSnapshot.exists) {
        throw new Error(`Lot ${lotId} does not exist for event ${context.params.eventId}`);
      }

      const currentQuantityKg = Number(lotSnapshot.get('currentQuantityKg') || 0);
      const nextQuantityKg = currentQuantityKg + quantityDeltaKg;
      if (nextQuantityKg < -0.000001) {
        throw new Error(`Event ${context.params.eventId} would make lot ${lotId} quantity negative`);
      }

      transaction.update(lotRef, {
        currentQuantityKg: nextQuantityKg,
        quantityCacheUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastEventId: context.params.eventId,
        lastStageId: event.stageId || null
      });
      transaction.create(appliedRef, {
        eventId: context.params.eventId,
        lotId,
        quantityDeltaKg,
        appliedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return null;
  });

/**
 * Trusted write boundary for append-only production events. Clients cannot
 * write stage_events directly; their authenticated UID becomes operatorId.
 */
exports.recordStageEvent = functions.region('asia-southeast1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Bạn cần đăng nhập để ghi nhận công đoạn.');
  }

  const lotId = typeof data?.lotId === 'string' ? data.lotId.trim() : '';
  const stageId = typeof data?.stageId === 'string' ? data.stageId.trim() : '';
  const rejectReasonId = typeof data?.rejectReasonId === 'string' ? data.rejectReasonId.trim() : null;
  const inputKg = Number(data?.inputKg);
  const acceptedKg = Number(data?.acceptedKg);
  const rejectedKg = Number(data?.rejectedKg);
  const quantityDeltaKg = Number(data?.quantityDeltaKg ?? 0);

  if (!lotId || !stageId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotId và stageId là bắt buộc.');
  }
  if (![inputKg, acceptedKg, rejectedKg, quantityDeltaKg].every(Number.isFinite)
    || inputKg < 0 || acceptedKg < 0 || rejectedKg < 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Khối lượng phải là số hợp lệ không âm.');
  }
  if (acceptedKg + rejectedKg > inputKg + 0.000001) {
    throw new functions.https.HttpsError('invalid-argument', 'Khối lượng đạt và loại không được vượt khối lượng vào.');
  }

  const db = admin.firestore();
  const [lotSnapshot, stageSnapshot, rejectSnapshot, userSnapshot] = await Promise.all([
    db.collection('lots').doc(lotId).get(),
    db.collection('process_stages').doc(stageId).get(),
    rejectReasonId ? db.collection('reject_reasons').doc(rejectReasonId).get() : Promise.resolve(null),
    db.collection('users').doc(context.auth.uid).get()
  ]);

  if (!lotSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', `Không tìm thấy lô ${lotId}.`);
  }
  if (!stageSnapshot.exists) {
    throw new functions.https.HttpsError('failed-precondition', `Công đoạn ${stageId} chưa được cấu hình.`);
  }
  if (rejectReasonId && !rejectSnapshot.exists) {
    throw new functions.https.HttpsError('failed-precondition', `Lý do loại ${rejectReasonId} chưa được cấu hình.`);
  }

  const operator = userSnapshot.exists ? userSnapshot.data() : {};
  const eventRef = db.collection('stage_events').doc();
  await eventRef.create({
    lotId,
    stageId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    inputKg,
    acceptedKg,
    rejectedKg,
    rejectReasonId,
    quantityDeltaKg,
    operatorId: context.auth.uid,
    operatorName: operator.name || context.auth.token.name || '',
    operatorEmail: context.auth.token.email || '',
    rework: Boolean(data?.rework),
    outputLotIds: Array.isArray(data?.outputLotIds)
      ? data.outputLotIds.filter((id) => typeof id === 'string' && id.trim())
      : []
  });

  return { eventId: eventRef.id };
});

/** Creates a new incoming lot at the first sorting stage and appends its creation event. */
exports.createIncomingLot = functions.region('asia-southeast1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Bạn cần đăng nhập để tạo lô.');
  }

  const lotCode = typeof data?.lotCode === 'string' ? data.lotCode.trim().toUpperCase() : '';
  const initialKg = Number(data?.initialKg);
  const stageId = workflow.INTAKE_STAGE_ID; // Lô nhập hàng luôn bắt đầu ở Phân loại 1.
  if (!lotCode || !/^[A-Z0-9][A-Z0-9-]{2,79}$/.test(lotCode)) {
    throw new functions.https.HttpsError('invalid-argument', 'Mã lô chỉ dùng chữ in hoa, số và dấu gạch ngang.');
  }
  if (!Number.isFinite(initialKg) || initialKg <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Khối lượng đầu vào phải lớn hơn 0.');
  }

  const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const intake = {
    receivedDate: text(data?.receivedDate, 10),
    vehiclePlate: text(data?.vehiclePlate, 30).toUpperCase(),
    productType: text(data?.productType),
    origin: text(data?.origin),
    initialKg
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intake.receivedDate)) {
    throw new functions.https.HttpsError('invalid-argument', 'Ngày nhập hàng không hợp lệ.');
  }
  if (!intake.vehiclePlate || !intake.productType || !intake.origin) {
    throw new functions.https.HttpsError('invalid-argument', 'Cần nhập đủ biển số xe, loại hàng và vùng/cửa khẩu nhập hàng.');
  }

  const db = admin.firestore();
  const [userSnapshot, duplicateSnapshot] = await Promise.all([
    db.collection('users').doc(context.auth.uid).get(),
    db.collection('lots').where('lotCode', '==', lotCode).limit(1).get()
  ]);
  if (!duplicateSnapshot.empty) {
    throw new functions.https.HttpsError('already-exists', `Mã lô ${lotCode} đã tồn tại.`);
  }

  const stage = workflow.STAGES[stageId];
  const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
  // Mọi nhân viên đã đăng nhập đều được tạo lô đầu vào.

  const lotRef = db.collection('lots').doc();
  const eventRef = db.collection('stage_events').doc();
  const now = admin.firestore.Timestamp.now();
  const note = typeof data?.note === 'string' ? data.note.trim() : '';
  await db.runTransaction(async (transaction) => {
    transaction.create(lotRef, {
      lotCode,
      parentLotIds: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: context.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'waiting',
      currentStage: stageId,
      pendingStageId: stageId,
      pendingDepartmentId: stage.departmentId,
      currentQuantityKg: 0,
      currentKg: initialKg,
      reworkCount: 0,
      stageEnteredAt: now,
      lastEventId: eventRef.id,
      lastStageId: stageId,
      intake: { ...intake, note },
      stages: { [stageId]: { status: 'pending', departmentId: stage.departmentId, enteredAt: now } },
      history: [{
        stage: stageId,
        action: 'CREATE',
        fromStatus: null,
        toStatus: 'pending',
        operatorId: context.auth.uid,
        operatorName: user.name || context.auth.token.name || '',
        timestamp: now,
        ...(note ? { note } : {}),
        kgData: { initialKg }
      }]
    });
    transaction.create(eventRef, {
      eventType: 'LOT_CREATED',
      lotId: lotRef.id,
      stageId,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      inputKg: initialKg,
      acceptedKg: initialKg,
      rejectedKg: 0,
      rejectReasonId: null,
      quantityDeltaKg: initialKg,
      operatorId: context.auth.uid,
      operatorName: user.name || context.auth.token.name || '',
      operatorEmail: context.auth.token.email || '',
      note,
      intake,
      rework: false,
      outputLotIds: []
    });
  });

  return { lotId: lotRef.id, eventId: eventRef.id, lotCode };
});

/** Deletes an incoming lot (admin/dev only) together with its creation event. */
exports.deleteIncomingLot = functions.region('asia-southeast1').https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Bạn cần đăng nhập để xoá lô.');
  }
  const lotId = typeof data?.lotId === 'string' ? data.lotId.trim() : '';
  if (!lotId || lotId.includes('/')) {
    throw new functions.https.HttpsError('invalid-argument', 'Thiếu mã lô cần xoá.');
  }

  const db = admin.firestore();
  const userSnapshot = await db.collection('users').doc(context.auth.uid).get();
  const role = userSnapshot.exists ? userSnapshot.data()?.role : '';
  if (context.auth.token.admin !== true && role !== 'admin' && role !== 'dev') {
    throw new functions.https.HttpsError('permission-denied', 'Chỉ admin hoặc dev mới được xoá lô.');
  }

  const lotRef = db.collection('lots').doc(lotId);
  const [lotSnapshot, eventsSnapshot, childrenSnapshot] = await Promise.all([
    lotRef.get(),
    db.collection('stage_events').where('lotId', '==', lotId).get(),
    db.collection('lots').where('parentLotIds', 'array-contains', lotId).limit(1).get()
  ]);
  if (!lotSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'Không tìm thấy lô cần xoá (có thể đã bị xoá).');
  }
  // Lô đã đi qua công đoạn khác hoặc đã sinh lô con chỉ xoá khi người dùng đã xác nhận (force).
  const lotData = lotSnapshot.data() || {};
  const hasProcessing = eventsSnapshot.docs.some((doc) => doc.data().eventType !== 'LOT_CREATED')
    || (lotData.history || []).some((entry) => entry.action !== 'CREATE' && entry.action !== 'SPLIT_FROM_PARENT')
    || !childrenSnapshot.empty;
  if (hasProcessing && data?.force !== true) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Dữ liệu này đã được đưa đi phân loại. Bạn có chắc chắn muốn xóa?',
      { reason: 'LOT_PROCESSED' }
    );
  }

  const batch = db.batch();
  eventsSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(lotRef);
  await batch.commit();
  functions.logger.info('Incoming lot deleted', {
    lotId, lotCode: lotSnapshot.data()?.lotCode, processed: hasProcessing, by: context.auth.uid
  });

  return { lotId, lotCode: lotSnapshot.data()?.lotCode || '' };
});

// Các hàm xử lý công đoạn: updateLotStage, sendToSoak, rejectLot.
Object.assign(exports, require('./traceability'));
