import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSyncDateInputValue } from '../js/dateInputUtils.js';

test('keeps a manually selected date from being reset to today', () => {
  assert.equal(shouldSyncDateInputValue({
    currentValue: '2026-09-10',
    fallbackValue: '2026-09-12',
    manuallySelected: true
  }), false);
});

test('fills the current date only when the input is empty and not manually controlled', () => {
  assert.equal(shouldSyncDateInputValue({
    currentValue: '',
    fallbackValue: '2026-09-12',
    manuallySelected: false
  }), true);
});

test('does not overwrite an existing date when the user has not manually selected a new one', () => {
  assert.equal(shouldSyncDateInputValue({
    currentValue: '2026-09-10',
    fallbackValue: '2026-09-12',
    manuallySelected: false
  }), false);
});
