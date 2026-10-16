// Đồng bộ process_stages (từ functions/workflow.js) và reject_reasons (scripts/traceability-seed.json) lên Firestore.
// process_stages chỉ để tham chiếu/báo cáo; logic xử lý công đoạn nằm trong Cloud Functions.
// Dùng token của Firebase CLI (đã `firebase login`); chỉ ghi/ghi đè đúng các document có trong file seed.
// Chạy: node scripts/seed-traceability.mjs [--dry-run]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { STAGES, STAGE_ORDER } = createRequire(import.meta.url)('../functions/workflow.js');

const PROJECT_ID = 'quanlynlchanhthu';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const dryRun = process.argv.includes('--dry-run');

const seed = JSON.parse(readFileSync(new URL('./traceability-seed.json', import.meta.url), 'utf8'));
const configPath = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
const token = JSON.parse(readFileSync(configPath, 'utf8')).tokens?.access_token;
if (!token) throw new Error('Không tìm thấy token Firebase CLI. Chạy `firebase login` trước.');

const toValue = (value) => {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  return { stringValue: String(value) };
};
const toFields = (data) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toValue(value)]));

function buildStages() {
  return STAGE_ORDER.map((id, index) => {
    const stage = STAGES[id];
    return {
      id,
      data: {
        code: id,
        name: stage.name,
        phase: stage.phase,
        departmentId: stage.departmentId,
        kind: stage.kind,
        sortOrder: (index + 1) * 10,
        allowsRework: stage.rework,
        nextStageIds: stage.next ? [stage.next] : [],
        lightToStageIds: stage.lightTo,
        active: true
      }
    };
  });
}
function buildReasons() {
  return seed.reject_reasons.map((reason) => ({
    id: reason.id,
    data: {
      code: reason.id,
      name: reason.name,
      severity: reason.severity,
      reworkEligible: reason.reworkEligible,
      ...(reason.reworkStageId ? { reworkStageId: reason.reworkStageId } : {}),
      active: true
    }
  }));
}

async function upsert(collection, { id, data }) {
  if (dryRun) return console.log(`[dry-run] ${collection}/${id}`);
  const response = await fetch(`${BASE}/${collection}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  if (!response.ok) throw new Error(`${collection}/${id}: ${response.status} ${await response.text()}`);
  console.log(`ok ${collection}/${id}`);
}

const stages = buildStages();
for (const doc of stages) await upsert('process_stages', doc);
await pruneStale('process_stages', new Set(stages.map((doc) => doc.id)));
/** Xoá các document process_stages không còn trong quy trình hiện tại. */
async function pruneStale(collection, keepIds) {
  const response = await fetch(`${BASE}/${collection}?pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`list ${collection}: ${response.status} ${await response.text()}`);
  const { documents = [] } = await response.json();
  for (const document of documents) {
    const id = document.name.split('/').pop();
    if (keepIds.has(id)) continue;
    if (dryRun) { console.log(`[dry-run] xoá ${collection}/${id}`); continue; }
    const del = await fetch(`https://firestore.googleapis.com/v1/${document.name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!del.ok) throw new Error(`delete ${collection}/${id}: ${del.status}`);
    console.log(`đã xoá ${collection}/${id}`);
  }
}
for (const doc of buildReasons()) await upsert('reject_reasons', doc);
console.log(dryRun ? 'Dry run xong.' : 'Seed hoàn tất.');
