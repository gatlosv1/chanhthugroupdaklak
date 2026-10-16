import test from 'node:test';
import assert from 'node:assert/strict';
import { setTeamDisplayNameMap, resolveTeamDisplayName, getRowTeam } from '../js/reportTeamDisplay.js';

test('resolveTeamDisplayName prefers a mapped team name over raw IDs', () => {
  setTeamDisplayNameMap([{ id: 'TJ1', name: 'Tổ 1' }]);
  assert.equal(resolveTeamDisplayName('TJ1'), 'Tổ 1');
  assert.equal(resolveTeamDisplayName('Tổ 1'), 'Tổ 1');
});

test('getRowTeam prefers teamName before teamId', () => {
  setTeamDisplayNameMap([{ id: 'ID-A', name: 'Tổ A' }, { id: 'ID-B', name: 'Tổ B' }]);
  assert.equal(getRowTeam({ teamName: 'Tổ A', teamId: 'ID-A' }), 'Tổ A');
  assert.equal(getRowTeam({ team: 'Tổ B', teamId: 'ID-B' }), 'Tổ B');
  assert.equal(getRowTeam({ teamId: 'ID-C' }), 'ID-C');
});
