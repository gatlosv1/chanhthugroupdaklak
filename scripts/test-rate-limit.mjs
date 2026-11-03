// Kiểm tra rate limit / cấm IP-UID với Firestore giả lập trong bộ nhớ.
// Chạy: node scripts/test-rate-limit.mjs  (không cần emulator hay firebase-admin thật)
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ---------- Firestore giả lập ---------- */
const store = new Map(); // "collection/id" -> data
const clone = (value) => structuredClone(value);

const docRef = (path) => ({
  path,
  id: path.split('/')[1],
  async get() { return { exists: store.has(path), id: path.split('/')[1], data: () => clone(store.get(path)) }; },
  async set(data, options) {
    store.set(path, options?.merge ? { ...(store.get(path) || {}), ...clone(data) } : clone(data));
  }
});

let failTransactions = false;
const fakeDb = {
  collection: (name) => ({
    doc: (id) => docRef(`${name}/${id}`),
    where: (field, op, value) => ({
      limit: () => ({
        async get() {
          assert.equal(op, '>');
          const docs = [...store.entries()]
            .filter(([path, data]) => path.startsWith(`${name}/`) && data[field] > value)
            .map(([path, data]) => ({ id: path.split('/')[1], data: () => clone(data) }));
          return { docs, size: docs.length };
        }
      })
    })
  }),
  async getAll(...refs) { return Promise.all(refs.map((ref) => ref.get())); },
  async runTransaction(fn) {
    if (failTransactions) throw new Error('Firestore down');
    const writes = [];
    const result = await fn({ get: (ref) => ref.get(), set: (ref, data) => writes.push(() => ref.set(data)) });
    for (const write of writes) await write();
    return result;
  }
};

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const fakeAdmin = { firestore: () => fakeDb, auth: () => ({ verifyIdToken: async () => { throw new Error('bad token'); } }) };
const fakeFunctions = {
  region: () => ({ https: { onCall: (handler) => handler } }),
  https: { HttpsError },
  logger: { info() {}, warn() {}, error() {} }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin') return fakeAdmin;
  if (request === 'firebase-functions/v1') return fakeFunctions;
  return originalLoad.call(this, request, ...rest);
};
const rl = require('../functions/rateLimit.js');

/* ---------- Tiện ích ---------- */
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const rejects = async (promise, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
};
const callable = (uid, ip = '203.0.113.9') => ({
  auth: uid ? { uid, token: { email: `${uid}@x.vn` } } : undefined,
  rawRequest: { headers: { 'x-forwarded-for': ip } }
});

let count = 0;
const test = async (name, fn) => { await fn(); count += 1; console.log(`ok - ${name}`); };

/* ---------- Hàm thuần ---------- */
await test('getClientIp: lấy IP thật từ x-forwarded-for, bỏ qua phần tử client tự gửi', () => {
  const ip = (headers, extra = {}) => rl.getClientIp({ headers, ...extra });
  assert.equal(ip({ 'x-forwarded-for': '203.0.113.5' }), '203.0.113.5');
  assert.equal(ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.5' }), '203.0.113.5');
  assert.equal(ip({ 'x-forwarded-for': ' 1.1.1.1 , 2.2.2.2 , 203.0.113.5 ' }), '203.0.113.5');
  assert.equal(ip({ 'x-forwarded-for': '203.0.113.5:4432' }), '203.0.113.5');
  assert.equal(ip({ 'x-forwarded-for': '::ffff:203.0.113.5' }), '203.0.113.5');
  assert.equal(ip({ 'x-forwarded-for': '2001:db8::1' }), '2001:db8::1');
  assert.equal(ip({ 'x-forwarded-for': ['9.9.9.9', '203.0.113.5'] }), '203.0.113.5');
  assert.equal(ip({}, { ip: '198.51.100.7' }), '198.51.100.7');
  assert.equal(ip({ 'x-forwarded-for': 'khong-phai-ip' }, { socket: { remoteAddress: '::ffff:198.51.100.8' } }), '198.51.100.8');
  assert.equal(ip({}), '');
  assert.equal(rl.getClientIp(undefined), '');
});

await test('buildIdentity: ưu tiên UID, không có thì dùng IP, không xác định được thì bỏ qua', () => {
  const withBoth = rl.buildIdentity({ uid: 'abc', req: { headers: { 'x-forwarded-for': '1.2.3.4' } } });
  assert.deepEqual([withBoth.type, withBoth.identifier, withBoth.docId], ['uid', 'abc', 'uid_abc']);
  const ipOnly = rl.buildIdentity({ req: { headers: { 'x-forwarded-for': '1.2.3.4' } } });
  assert.deepEqual([ipOnly.type, ipOnly.docId], ['ip', 'ip_1.2.3.4']);
  assert.equal(rl.buildIdentity({ req: { headers: {} } }), null);
  assert.equal(rl.buildIdentity({ uid: 'a/b' }).docId, 'uid_a_b');
});

await test('bảng thời gian cấm: 30 phút, 2 giờ, 6 giờ, 24 giờ, từ lần 5 khoá', () => {
  assert.deepEqual([1, 2, 3, 4].map(rl.banDurationMs), [30 * MIN, 2 * HOUR, 6 * HOUR, 24 * HOUR]);
  assert.equal(rl.banDurationMs(5), null);
  assert.equal(rl.banDurationMs(9), null);
});

await test('formatRemaining', () => {
  assert.equal(rl.formatRemaining(45 * 1000), '45 giây');
  assert.equal(rl.formatRemaining(29 * MIN + 58 * 1000), '29 phút 58 giây');
  assert.equal(rl.formatRemaining(30 * MIN), '30 phút');
  assert.equal(rl.formatRemaining(2 * HOUR), '2 giờ');
  assert.equal(rl.formatRemaining(HOUR + 59 * MIN), '1 giờ 59 phút');
  assert.equal(rl.formatRemaining(10), '1 giây');
});

await test('Ghi: 6 request trong 5 giây được qua, request thứ 7 bị cấm 30 phút', () => {
  let state = null;
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i += 1) {
    const r = rl.evaluateRequest(state, t0 + i * 100, 'write');
    assert.equal(r.allowed, true, `request ${i + 1}`);
    state = r.state;
  }
  assert.equal(state.timestamps.length, 6);
  const blocked = rl.evaluateRequest(state, t0 + 700, 'write');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'violation');
  assert.equal(blocked.banCount, 1);
  assert.equal(blocked.retryAfterMs, 30 * MIN);
  assert.equal(blocked.state.banUntil, t0 + 700 + 30 * MIN);
  assert.equal(blocked.state.bannedAt, t0 + 700);
  assert.equal(blocked.permanent, false);
});

await test('Đọc: 12 request được qua, request thứ 13 vi phạm; ghi chỉ cho 6', () => {
  let state = null;
  for (let i = 0; i < 12; i += 1) {
    const r = rl.evaluateRequest(state, 5000 + i, 'read');
    assert.equal(r.allowed, true, `read ${i + 1}`);
    state = r.state;
  }
  assert.equal(rl.evaluateRequest(state, 6000, 'read').allowed, false);
  assert.equal(rl.evaluateRequest(state, 6000, 'write').allowed, false);
  let writes = null;
  for (let i = 0; i < 7; i += 1) writes = rl.evaluateRequest(writes, 5000 + i, 'read').state;
  assert.equal(rl.evaluateRequest(writes, 6000, 'read').allowed, true); // 7 lần đọc vẫn dưới ngưỡng 12
  assert.equal(rl.evaluateRequest(writes, 6000, 'write').allowed, false); // nhưng thao tác ghi thì đã chạm ngưỡng 6
});

await test('cửa sổ 5 giây trượt: timestamp cũ không tính', () => {
  let state = null;
  for (let i = 0; i < 6; i += 1) state = rl.evaluateRequest(state, 1000 + i, 'write').state;
  const later = rl.evaluateRequest(state, 1000 + 5000 + 5, 'write');
  assert.equal(later.allowed, true);
  assert.equal(later.state.timestamps.length, 1);
});

await test('đang bị cấm: trả thời gian còn lại, hết cấm thì cho qua nhưng giữ banCount', () => {
  const banned = { banCount: 1, banUntil: 100_000 + 30 * MIN, timestamps: [], permanent: false };
  const blocked = rl.evaluateRequest(banned, 100_000 + 10 * MIN, 'read');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'banned');
  assert.equal(blocked.retryAfterMs, 20 * MIN);
  const after = rl.evaluateRequest(banned, 100_000 + 30 * MIN + 1, 'read');
  assert.equal(after.allowed, true);
  assert.equal(after.state.banCount, 1);
});

await test('leo thang qua 5 lần vi phạm: 30 phút → 2 giờ → 6 giờ → 24 giờ → khoá đến khi dev mở', () => {
  let state = null;
  let now = 10_000_000;
  const expected = [30 * MIN, 2 * HOUR, 6 * HOUR, 24 * HOUR, null];
  expected.forEach((duration, index) => {
    for (let i = 0; i < 6; i += 1) state = rl.evaluateRequest(state, now + i, 'write').state;
    const r = rl.evaluateRequest(state, now + 10, 'write');
    assert.equal(r.allowed, false);
    assert.equal(r.banCount, index + 1);
    assert.equal(r.retryAfterMs, duration);
    assert.equal(r.permanent, duration === null);
    state = r.state;
    if (duration !== null) now = state.banUntil + 1;
  });
  assert.equal(state.permanent, true);
  assert.equal(state.banUntil, null);
  const later = rl.evaluateRequest(state, now + 365 * 24 * HOUR, 'read');
  assert.equal(later.allowed, false);
  assert.equal(later.permanent, true);
});

/* ---------- Qua Firestore giả lập + wrapper onCall ---------- */
await test('withRateLimit: UID bị chặn ở request thứ 7 bằng lỗi resource-exhausted (HTTP 429) có thời gian còn lại', async () => {
  const handler = rl.withRateLimit('write', async () => ({ ok: true }));
  for (let i = 0; i < 6; i += 1) assert.deepEqual(await handler({}, callable('u1')), { ok: true });
  await assert.rejects(handler({}, callable('u1')), (error) => {
    assert.equal(error.code, 'resource-exhausted');
    assert.match(error.message, /Tài khoản của bạn/);
    assert.match(error.message, /29 phút|30 phút/);
    assert.equal(error.details.reason, 'RATE_LIMITED');
    assert.equal(error.details.banCount, 1);
    assert.equal(error.details.permanent, false);
    assert.ok(error.details.retryAfterSeconds > 1790 && error.details.retryAfterSeconds <= 1800);
    return true;
  });
  const saved = store.get('rate_limits/uid_u1');
  assert.equal(saved.type, 'uid');
  assert.equal(saved.identifier, 'u1');
  assert.equal(saved.banCount, 1);
  assert.ok(saved.banUntil > Date.now());
  assert.ok(!store.has('rate_limits/ip_203.0.113.9'), 'đã có UID thì không dùng IP');
});

await test('đang bị cấm: vẫn trả 429, không ghi thêm vào Firestore, người khác không bị ảnh hưởng', async () => {
  const handler = rl.withRateLimit('read', async () => ({ ok: true }));
  const before = JSON.stringify(store.get('rate_limits/uid_u1'));
  await rejects(handler({}, callable('u1')), 'resource-exhausted');
  await rejects(handler({}, callable('u1')), 'resource-exhausted');
  assert.equal(JSON.stringify(store.get('rate_limits/uid_u1')), before);
  assert.deepEqual(await handler({}, callable('u2')), { ok: true });
});

await test('chưa đăng nhập: dùng IP, mỗi IP tính riêng', async () => {
  const handler = rl.withRateLimit('write', async () => ({ ok: true }));
  for (let i = 0; i < 6; i += 1) await handler({}, callable(null, '198.51.100.20'));
  await assert.rejects(handler({}, callable(null, '198.51.100.20')), (error) => {
    assert.equal(error.code, 'resource-exhausted');
    assert.match(error.message, /Địa chỉ IP của bạn/);
    return true;
  });
  assert.equal(store.get('rate_limits/ip_198.51.100.20').type, 'ip');
  assert.deepEqual(await handler({}, callable(null, '198.51.100.21')), { ok: true });
});

await test('thao tác Đọc có ngưỡng 12, Ghi có ngưỡng 6', async () => {
  const read = rl.withRateLimit('read', async () => 'r');
  for (let i = 0; i < 12; i += 1) await read({}, callable('reader'));
  await rejects(read({}, callable('reader')), 'resource-exhausted');
});

await test('lỗi Firestore: cho request đi tiếp (không làm sập ứng dụng)', async () => {
  failTransactions = true;
  try {
    const handler = rl.withRateLimit('write', async () => 'ok');
    assert.equal(await handler({}, callable('u-down')), 'ok');
  } finally {
    failTransactions = false;
  }
});

await test('không xác định được người dùng lẫn IP: bỏ qua giới hạn', async () => {
  const handler = rl.withRateLimit('write', async () => 'ok');
  for (let i = 0; i < 10; i += 1) assert.equal(await handler({}, { rawRequest: { headers: {} } }), 'ok');
});

await test('guardHttp: chặn bằng HTTP 429 kèm Retry-After', async () => {
  const headers = {};
  let status = null;
  let body = null;
  const res = { set: (key, value) => { headers[key] = value; }, status(code) { status = code; return this; }, json(payload) { body = payload; return this; } };
  const req = { headers: { 'x-forwarded-for': '192.0.2.50' } };
  for (let i = 0; i < 6; i += 1) assert.equal(await rl.guardHttp('write', req, res), false);
  assert.equal(await rl.guardHttp('write', req, res), true);
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'RATE_LIMITED');
  assert.ok(Number(headers['Retry-After']) > 1790);
  assert.match(body.message, /thử lại sau/);
});

/* ---------- Trang quản lý: chỉ dev ---------- */
store.set('users/dev1', { role: 'dev', name: 'Dev Một', email: 'dev1@x.vn' });
store.set('users/boss', { role: 'admin', name: 'Quản trị' });
store.set('users/u1', { role: 'staff', name: 'Nhân viên A', email: 'a@x.vn' });
const devCtx = { auth: { uid: 'dev1', token: { email: 'dev1@x.vn' } } };

await test('listRateLimitBans: chỉ dev, trả đủ thông tin và thời gian còn lại', async () => {
  await rejects(rl.listRateLimitBans({}, {}), 'unauthenticated');
  await rejects(rl.listRateLimitBans({}, { auth: { uid: 'boss', token: { email: 'boss@x.vn' } } }), 'permission-denied');
  await rejects(rl.listRateLimitBans({}, { auth: { uid: 'u1', token: { email: 'a@x.vn' } } }), 'permission-denied');

  const result = await rl.listRateLimitBans({}, devCtx);
  const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
  assert.ok(byId.uid_u1 && byId['ip_198.51.100.20'] && byId['ip_192.0.2.50']);
  assert.ok(!byId.uid_u2, 'u2 chưa bị cấm');
  const row = byId.uid_u1;
  assert.equal(row.type, 'uid');
  assert.equal(row.identifier, 'u1');
  assert.equal(row.banCount, 1);
  assert.equal(row.active, true);
  assert.equal(row.label, 'Nhân viên A');
  assert.ok(row.bannedAt > 0 && row.banUntil > row.bannedAt);
  assert.ok(row.remainingMs > 29 * MIN && row.remainingMs <= 30 * MIN);
  assert.equal(byId['ip_198.51.100.20'].type, 'ip');
  assert.equal(typeof result.serverNow, 'number');
});

await test('listRateLimitBans: mục hết hạn chỉ hiện khi includeExpired; khoá vĩnh viễn luôn hiện', async () => {
  store.set('rate_limits/ip_10.0.0.1', { type: 'ip', identifier: '10.0.0.1', banCount: 2, bannedAt: 1, banUntil: 2, permanent: false });
  store.set('rate_limits/ip_10.0.0.2', { type: 'ip', identifier: '10.0.0.2', banCount: 5, bannedAt: 5, banUntil: null, permanent: true });
  const active = await rl.listRateLimitBans({}, devCtx);
  assert.ok(!active.items.some((item) => item.id === 'ip_10.0.0.1'));
  const permanent = active.items.find((item) => item.id === 'ip_10.0.0.2');
  assert.equal(permanent.permanent, true);
  assert.equal(permanent.remainingMs, null);
  const all = await rl.listRateLimitBans({ includeExpired: true }, devCtx);
  const expired = all.items.find((item) => item.id === 'ip_10.0.0.1');
  assert.equal(expired.active, false);
});

await test('unbanRateLimit: chỉ dev gỡ cấm, reset banCount + banUntil và người đó dùng lại được', async () => {
  await rejects(rl.unbanRateLimit({ id: 'uid_u1' }, {}), 'unauthenticated');
  await rejects(rl.unbanRateLimit({ id: 'uid_u1' }, { auth: { uid: 'boss', token: {} } }), 'permission-denied');
  await rejects(rl.unbanRateLimit({ id: 'a/b' }, devCtx), 'invalid-argument');
  await rejects(rl.unbanRateLimit({}, devCtx), 'invalid-argument');
  await rejects(rl.unbanRateLimit({ id: 'uid_khong-ton-tai' }, devCtx), 'not-found');
  assert.equal(store.get('rate_limits/uid_u1').banCount, 1, 'chưa dev nào gỡ thì vẫn bị cấm');

  assert.deepEqual(await rl.unbanRateLimit({ id: 'uid_u1' }, devCtx), { ok: true, id: 'uid_u1' });
  const saved = store.get('rate_limits/uid_u1');
  assert.equal(saved.banCount, 0);
  assert.equal(saved.banUntil, null);
  assert.equal(saved.permanent, false);
  assert.equal(saved.unbannedBy, 'dev1');
  const handler = rl.withRateLimit('write', async () => 'ok');
  assert.equal(await handler({}, callable('u1')), 'ok');
  const list = await rl.listRateLimitBans({}, devCtx);
  assert.ok(!list.items.some((item) => item.id === 'uid_u1'));

  await rl.unbanRateLimit({ id: 'ip_10.0.0.2' }, devCtx); // gỡ khoá vĩnh viễn
  assert.equal(store.get('rate_limits/ip_10.0.0.2').permanent, false);
});

await test('email dev cố định vẫn là dev khi hồ sơ chưa có role', async () => {
  const result = await rl.listRateLimitBans({}, { auth: { uid: 'owner', token: { email: 'GatloSV1@gmail.com' } } });
  assert.ok(Array.isArray(result.items));
});

console.log(`\n${count} test đạt.`);
