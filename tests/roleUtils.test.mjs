import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInitialRole } from '../js/roleUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const pageAccessText = fs.readFileSync(path.join(projectRoot, 'js/pageAccess.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'dashboard.html'), 'utf8');

test('resolveInitialRole prioritizes Firestore role and maps fixed emails correctly', () => {
  assert.equal(resolveInitialRole('admin2@company.com', 'staff'), 'admin');
  assert.equal(resolveInitialRole('gatlosv1@gmail.com', 'staff'), 'dev');
  assert.equal(resolveInitialRole('staff@company.com', 'admin'), 'admin');
  assert.equal(resolveInitialRole('staff@company.com', ''), 'staff');
});

test('default permissions include the label-trang and phieu-can-tay access cards', () => {
  assert.match(pageAccessText, /labelTrang/);
  assert.match(pageAccessText, /phieuCanTay/);
  assert.match(dashboardHtml, /data-page-access="labelTrang"/);
  assert.match(dashboardHtml, /data-page-access="phieuCanTay"/);
  assert.match(dashboardHtml, /value="phieuCanTay"/);
});
