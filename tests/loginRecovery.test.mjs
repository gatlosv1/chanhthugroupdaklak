import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAttemptLegacyAccountRecovery } from '../js/loginRecovery.js';

test('recovery is attempted when a legacy profile has a password and the auth error matches', () => {
  assert.equal(
    shouldAttemptLegacyAccountRecovery('auth/invalid-login-credentials', {
      email: 'staff@company.com',
      password: 'LegacyPass@123'
    }),
    true
  );
});

test('recovery is skipped when legacy profile has no password', () => {
  assert.equal(
    shouldAttemptLegacyAccountRecovery('auth/user-not-found', {
      email: 'staff@company.com',
      password: ''
    }),
    false
  );
});

test('recovery is skipped for unrelated auth errors', () => {
  assert.equal(
    shouldAttemptLegacyAccountRecovery('auth/network-request-failed', {
      email: 'staff@company.com',
      password: 'LegacyPass@123'
    }),
    false
  );
});
