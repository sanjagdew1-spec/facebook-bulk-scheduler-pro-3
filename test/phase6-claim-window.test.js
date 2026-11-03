import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE6_PREPARE_LEAD_MS, phase6ClaimCutoff } from '../phase6-worker-bridge.js';

test('Phase 6 claim window opens exactly 15 seconds before the scheduled publish time', () => {
  const now = '2030-01-01T11:10:45.000Z';
  assert.equal(PHASE6_PREPARE_LEAD_MS, 15000);
  assert.equal(phase6ClaimCutoff(now), '2030-01-01T11:11:00.000Z');
});

test('Phase 6 claim cutoff preserves millisecond precision and does not mutate the supplied timestamp', () => {
  const now = '2030-01-01T11:10:45.250Z';
  assert.equal(phase6ClaimCutoff(now), '2030-01-01T11:11:00.250Z');
  assert.equal(now, '2030-01-01T11:10:45.250Z');
});
