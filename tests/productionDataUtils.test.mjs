import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionPayload, canPersistProductionRow, getAllRowsForPersistence, normalizeProductionRowForPersistence } from '../js/productionDataUtils.mjs';

test('canPersistProductionRow trims whitespace before validating', () => {
  assert.equal(canPersistProductionRow({ lot: '   ', type: 'RI' }), false);
  assert.equal(canPersistProductionRow({ lot: 'LOT-01', type: '  DO  ' }), true);
});

test('normalizeProductionRowForPersistence trims and preserves values', () => {
  const result = normalizeProductionRowForPersistence({
    lot: '  LOT-01  ',
    type: '  DO  ',
    productionDate: ' 2026-08-05 ',
    warehouse: '  WH1  '
  });

  assert.deepEqual(result, {
    lot: 'LOT-01',
    type: 'DO',
    productionDate: '2026-08-05',
    warehouse: 'WH1'
  });
});

test('buildProductionPayload always includes ownerId for the current user', () => {
  const payload = buildProductionPayload({
    lot: '  LOT-02  ',
    type: 'RI',
    warehouse: '  WH2  '
  }, 'user-123');

  assert.equal(payload.ownerId, 'user-123');
  assert.equal(payload.lot, 'LOT-02');
  assert.equal(payload.type, 'RI');
});

test('getAllRowsForPersistence keeps hidden rows when the table is filtered', () => {
  const allRows = [
    { id: '1', firestoreId: 'f-1', lot: 'LOT-01', type: 'RI' },
    { id: '2', firestoreId: 'f-2', lot: 'LOT-02', type: 'DO' }
  ];
  const visibleRows = [
    { id: '1', firestoreId: 'f-1', lot: 'LOT-01', type: 'RI' }
  ];

  const merged = getAllRowsForPersistence(allRows, visibleRows).map((row) => row.firestoreId);

  assert.deepEqual(merged, ['f-1', 'f-2']);
});
