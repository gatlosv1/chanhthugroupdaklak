import test from 'node:test';
import assert from 'node:assert/strict';
import { canEditProductionDate, canEditProductionRows, canDeleteProductionRows } from '../js/productionPermissions.js';

test('staff can enter production rows but cannot edit production date or delete rows', () => {
  const user = { uid: 'u-1' };

  assert.equal(canEditProductionRows(user, 'staff'), true);
  assert.equal(canEditProductionDate(user, 'staff'), false);
  assert.equal(canDeleteProductionRows('staff'), false);

  assert.equal(canEditProductionRows(user, 'admin'), true);
  assert.equal(canEditProductionDate(user, 'admin'), true);
  assert.equal(canDeleteProductionRows('admin'), true);
});
