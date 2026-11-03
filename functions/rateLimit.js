'use strict';

/**
 * Giới hạn tốc độ (rate limit) và tự động cấm cho Cloud Functions.
 *
 * Mỗi request đi qua `withRateLimit` (callable) hoặc `guardHttp` (onRequest) theo đúng các bước:
 *   1. Xác định định danh: UID nếu đã đăng nhập, ngược lại IP.
 *   2. Đang bị cấm → trả HTTP 429 kèm thời gian còn lại.
 *   3. Lấy các timestamp trong 5 giây gần nhất.
 *   4. Thao tác Ghi: >= 6 request, thao tác Đọc: >= 12 request → vi phạm.
 *   5. Vi phạm → banCount + 1, cấm theo bậc thang (30 phút, 2 giờ, 6 giờ, 24 giờ, từ lần 5 khoá đến khi dev mở).
 *   6. Không vi phạm → cho đi tiếp và lưu timestamp của request hiện tại.
 *
 * Dữ liệu lưu ở Firestore collection `rate_limits/{uid_<uid> | ip_<ip>}` (chỉ Admin SDK đọc/ghi được):
 *   type, identifier, timestamps[ms], banCount, bannedAt, banUntil, permanent, lastRequestAt, lastViolation,
 *   unbannedAt, unbannedBy.
 *
 * Lưu ý phạm vi: chỉ chặn được request đi qua Cloud Functions. Các thao tác đọc/ghi Firestore trực tiếp từ
 * trình duyệt không đi qua đây (muốn chặn phải dùng Firestore Security Rules / App Check).
 *
 * Đặt biến môi trường RATE_LIMIT_DISABLED=1 để tắt hẳn (dùng cho test hoặc khẩn cấp).
 */

const net = require('net');
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

const REGION = 'asia-southeast1';
const COLLECTION = 'rate_limits';

const WINDOW_MS = 5000;
const LIMITS = { write: 6, read: 12 };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// Lần vi phạm thứ n (1-based) dùng phần tử n-1; vượt quá danh sách → khoá đến khi dev mở.
const BAN_STEPS_MS = [30 * MINUTE_MS, 2 * HOUR_MS, 6 * HOUR_MS, 24 * HOUR_MS];

// Số proxy tin cậy phía sau ứng dụng. Google Front End thêm IP thật của client vào CUỐI x-forwarded-for,
// nên mặc định lấy phần tử cuối. Các phần tử bên trái có thể do client tự gửi nên không tin.
const TRUSTED_PROXY_HOPS = 1;

// Bộ nhớ đệm ngắn hạn cho các định danh đang bị cấm: tránh đọc Firestore mỗi request khi bị spam.
const BAN_CACHE_TTL_MS = 10 * 1000;
const banCache = new Map();

const MAX_LIST = 500;
const DEV_EMAILS = ['gatlosv1@gmail.com'];

/* ------------------------------------------------------------------ */
/* Hàm thuần: IP, bậc thang cấm, đánh giá request                      */
/* ------------------------------------------------------------------ */

/** Chuẩn hoá một địa chỉ IP (bỏ cổng, bỏ tiền tố ::ffff:). Trả về '' nếu không hợp lệ. */
function normalizeIp(value) {
  let ip = String(value || '').trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort) ip = withPort[1];
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

/** Lấy IP client từ request (xử lý x-forwarded-for). Trả về '' nếu không xác định được. */
function getClientIp(req, hops = TRUSTED_PROXY_HOPS) {
  const header = req?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : String(header || '');
  const chain = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (chain.length) {
    const fromHeader = normalizeIp(chain[Math.max(0, chain.length - Math.max(1, hops))]);
    if (fromHeader) return fromHeader;
  }
  return normalizeIp(req?.ip) || normalizeIp(req?.socket?.remoteAddress) || normalizeIp(req?.connection?.remoteAddress) || '';
}

const safeId = (value) => String(value).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 150);

/** Bước 1: UID nếu đã đăng nhập, ngược lại IP. Trả về null nếu không xác định được (bỏ qua giới hạn). */
function buildIdentity({ uid, req }) {
  if (uid) return { type: 'uid', identifier: String(uid), docId: `uid_${safeId(uid)}` };
  const ip = getClientIp(req);
  return ip ? { type: 'ip', identifier: ip, docId: `ip_${safeId(ip)}` } : null;
}

/** Thời gian cấm (ms) cho lần vi phạm thứ `banCount`; null = khoá đến khi dev mở. */
function banDurationMs(banCount) {
  return banCount >= 1 && banCount <= BAN_STEPS_MS.length ? BAN_STEPS_MS[banCount - 1] : null;
}

/** "29 phút 58 giây", "1 giờ 59 phút", "45 giây". */
function formatRemaining(ms) {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} giờ${minutes ? ` ${minutes} phút` : ''}`;
  if (minutes > 0) return `${minutes} phút${seconds ? ` ${seconds} giây` : ''}`;
  return `${seconds} giây`;
}

/**
 * Bước 2-6 trên một trạng thái đã đọc từ Firestore (hàm thuần, dễ test).
 * Trả về { allowed, reason, permanent, retryAfterMs, banCount, state }.
 * reason: 'banned' (đang bị cấm) | 'violation' (vừa vi phạm). `state` là trạng thái cần ghi lại.
 */
function evaluateRequest(state, now, kind) {
  const current = state || {};
  const banCount = Number(current.banCount) || 0;

  if (current.permanent) {
    return { allowed: false, reason: 'banned', permanent: true, retryAfterMs: null, banCount, state: current };
  }
  if (Number(current.banUntil) > now) {
    return { allowed: false, reason: 'banned', permanent: false, retryAfterMs: Number(current.banUntil) - now, banCount, state: current };
  }

  const recent = (Array.isArray(current.timestamps) ? current.timestamps : [])
    .filter((time) => Number.isFinite(time) && now - time < WINDOW_MS);
  const limit = LIMITS[kind] ?? LIMITS.write;

  if (recent.length >= limit) {
    const nextCount = banCount + 1;
    const duration = banDurationMs(nextCount);
    const permanent = duration === null;
    return {
      allowed: false,
      reason: 'violation',
      permanent,
      retryAfterMs: permanent ? null : duration,
      banCount: nextCount,
      state: {
        ...current,
        timestamps: [],
        banCount: nextCount,
        bannedAt: now,
        banUntil: permanent ? null : now + duration,
        permanent,
        lastViolation: { kind, requestCount: recent.length, at: now }
      }
    };
  }

  return {
    allowed: true,
    state: { ...current, timestamps: [...recent, now], lastRequestAt: now }
  };
}

/* ------------------------------------------------------------------ */
/* Firestore                                                           */
/* ------------------------------------------------------------------ */

/** Kiểm tra + ghi nhận một request trong transaction. */
async function checkRateLimit(db, identity, kind, now = Date.now()) {
  const cached = banCache.get(identity.docId);
  if (cached && cached.expiresAt > now) {
    return {
      allowed: false,
      reason: 'banned',
      permanent: cached.permanent,
      retryAfterMs: cached.permanent ? null : Math.max(0, cached.banUntil - now),
      banCount: cached.banCount
    };
  }

  const ref = db.collection(COLLECTION).doc(identity.docId);
  let outcome;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    outcome = evaluateRequest(snapshot.exists ? snapshot.data() : null, now, kind);
    // Đang bị cấm thì không ghi gì thêm để request spam không tốn lượt ghi.
    if (outcome.reason === 'banned') return;
    transaction.set(ref, {
      ...outcome.state,
      type: identity.type,
      identifier: identity.identifier,
      updatedAt: now
    });
  });

  if (!outcome.allowed) {
    const banUntil = outcome.state.banUntil ?? null;
    banCache.set(identity.docId, {
      permanent: outcome.permanent,
      banUntil,
      banCount: outcome.banCount,
      expiresAt: outcome.permanent ? now + BAN_CACHE_TTL_MS : Math.min(now + BAN_CACHE_TTL_MS, banUntil)
    });
    if (outcome.reason === 'violation') {
      functions.logger.warn('Rate limit violation: identity banned', {
        type: identity.type, identifier: identity.identifier, kind,
        banCount: outcome.banCount, permanent: outcome.permanent, retryAfterMs: outcome.retryAfterMs
      });
    }
  }
  return outcome;
}

/**
 * Áp dụng giới hạn cho một request. Trả về null nếu được đi tiếp,
 * hoặc { message, details } (HTTP 429) nếu bị chặn. Lỗi hạ tầng → cho đi tiếp để không làm sập ứng dụng.
 */
async function enforceRateLimit(kind, { uid, req }) {
  if (process.env.RATE_LIMIT_DISABLED === '1') return null;
  const identity = buildIdentity({ uid, req });
  if (!identity) return null;

  let outcome;
  try {
    outcome = await checkRateLimit(admin.firestore(), identity, kind);
  } catch (error) {
    functions.logger.error('Rate limit check failed, request allowed', {
      type: identity.type, identifier: identity.identifier, error: String(error?.message || error)
    });
    return null;
  }
  if (outcome.allowed) return null;

  const retryAfterSeconds = outcome.permanent ? null : Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
  const target = identity.type === 'uid' ? 'Tài khoản của bạn' : 'Địa chỉ IP của bạn';
  const message = outcome.permanent
    ? `${target} đã bị khoá tạm thời do thao tác quá nhanh nhiều lần. Vui lòng liên hệ quản trị viên (dev) để mở khoá.`
    : `${target} bị tạm khoá do thao tác quá nhanh. Vui lòng thử lại sau ${formatRemaining(outcome.retryAfterMs)}.`;
  return {
    message,
    details: {
      reason: 'RATE_LIMITED',
      retryAfterSeconds,
      banUntil: outcome.state?.banUntil ?? (outcome.permanent ? null : Date.now() + outcome.retryAfterMs),
      permanent: outcome.permanent,
      banCount: outcome.banCount
    }
  };
}

/** Bọc một handler onCall. kind: 'write' (ghi, giới hạn 6/5 giây) hoặc 'read' (đọc, giới hạn 12/5 giây). */
function withRateLimit(kind, handler) {
  return async (data, context) => {
    const blocked = await enforceRateLimit(kind, { uid: context.auth?.uid, req: context.rawRequest });
    if (blocked) throw new functions.https.HttpsError('resource-exhausted', blocked.message, blocked.details);
    return handler(data, context);
  };
}

/** Với endpoint onRequest: UID lấy từ ID token Firebase (nếu có), ngược lại dùng IP. */
async function optionalUid(req) {
  const token = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return undefined;
  try {
    return (await admin.auth().verifyIdToken(token)).uid;
  } catch (error) {
    return undefined;
  }
}

/** Dùng cho onRequest: trả true nếu request bị chặn (đã gửi HTTP 429), false nếu được đi tiếp. */
async function guardHttp(kind, req, res) {
  if (process.env.RATE_LIMIT_DISABLED === '1') return false;
  const blocked = await enforceRateLimit(kind, { uid: await optionalUid(req), req });
  if (!blocked) return false;
  if (blocked.details.retryAfterSeconds) res.set('Retry-After', String(blocked.details.retryAfterSeconds));
  res.status(429).json({ ok: false, message: blocked.message, ...blocked.details });
  return true;
}

/* ------------------------------------------------------------------ */
/* Trang quản lý: chỉ dev                                              */
/* ------------------------------------------------------------------ */

/** Chỉ tài khoản role dev (users/{uid}.role) hoặc email dev cố định mới qua được. */
async function assertDev(db, context, message) {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Bạn cần đăng nhập.');
  const snapshot = await db.collection('users').doc(context.auth.uid).get();
  const role = snapshot.exists ? String(snapshot.data()?.role || '').trim().toLowerCase() : '';
  const email = String(context.auth.token?.email || '').trim().toLowerCase();
  if (role !== 'dev' && !DEV_EMAILS.includes(email)) {
    throw new functions.https.HttpsError('permission-denied', message);
  }
}

function toBanRow(id, data, now) {
  const permanent = data.permanent === true;
  const banUntil = permanent ? null : Number(data.banUntil) || null;
  const active = permanent || (banUntil !== null && banUntil > now);
  return {
    id,
    type: data.type === 'uid' ? 'uid' : 'ip',
    identifier: String(data.identifier || ''),
    banCount: Number(data.banCount) || 0,
    bannedAt: Number(data.bannedAt) || null,
    banUntil,
    permanent,
    active,
    remainingMs: active && !permanent ? banUntil - now : null
  };
}

/** Danh sách IP/UID bị cấm (dev). data.includeExpired = true để lấy cả các mục đã hết hạn. */
const listRateLimitBans = functions.region(REGION).https.onCall(async (data, context) => {
  const db = admin.firestore();
  await assertDev(db, context, 'Chỉ tài khoản dev mới xem được danh sách IP bị cấm.');

  const snapshot = await db.collection(COLLECTION).where('banCount', '>', 0).limit(MAX_LIST).get();
  const now = Date.now();
  const includeExpired = data?.includeExpired === true;
  const items = snapshot.docs
    .map((doc) => toBanRow(doc.id, doc.data() || {}, now))
    .filter((row) => includeExpired || row.active)
    .sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));

  // Gắn tên/email để dev nhận ra UID là ai.
  const uidRows = items.filter((row) => row.type === 'uid');
  if (uidRows.length) {
    try {
      const users = await db.getAll(...uidRows.map((row) => db.collection('users').doc(row.identifier)));
      users.forEach((user, index) => {
        const profile = user.exists ? user.data() || {} : {};
        uidRows[index].label = String(profile.name || profile.email || '').slice(0, 120);
        uidRows[index].email = String(profile.email || '').slice(0, 120);
      });
    } catch (error) {
      functions.logger.warn('Could not load user labels for ban list', { error: String(error?.message || error) });
    }
  }

  return { serverNow: now, items, truncated: snapshot.size >= MAX_LIST };
});

/** Gỡ cấm (dev): reset banCount + banUntil của một định danh. data.id = id document trả về từ danh sách. */
const unbanRateLimit = functions.region(REGION).https.onCall(async (data, context) => {
  const db = admin.firestore();
  await assertDev(db, context, 'Chỉ tài khoản dev mới được gỡ cấm.');

  const id = typeof data?.id === 'string' ? data.id.trim() : '';
  if (!/^(uid|ip)_[A-Za-z0-9._:-]{1,150}$/.test(id)) {
    throw new functions.https.HttpsError('invalid-argument', 'Mã IP/UID cần gỡ cấm không hợp lệ.');
  }
  const ref = db.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'Không tìm thấy mục này (có thể đã được gỡ).');
  }

  await ref.set({
    banCount: 0,
    banUntil: null,
    bannedAt: null,
    permanent: false,
    timestamps: [],
    unbannedAt: Date.now(),
    unbannedBy: context.auth.uid
  }, { merge: true });
  banCache.delete(id);
  functions.logger.info('Rate limit ban removed', { id, by: context.auth.uid });
  return { ok: true, id };
});

module.exports = {
  // Cloud Functions
  listRateLimitBans, unbanRateLimit,
  // Dùng trong index.js / traceability.js
  withRateLimit, guardHttp,
  // Dùng cho test
  getClientIp, normalizeIp, buildIdentity, banDurationMs, formatRemaining, evaluateRequest, checkRateLimit,
  enforceRateLimit, banCache,
  WINDOW_MS, LIMITS, BAN_STEPS_MS, COLLECTION
};
