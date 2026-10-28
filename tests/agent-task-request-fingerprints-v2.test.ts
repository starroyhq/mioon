import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTaskRequestFingerprints, readTaskRequestFingerprintFixture,
  FINGERPRINT_PROTOCOLS, FINGERPRINT_SCENARIOS, OFFICIAL_FINGERPRINT_SCENARIOS,
  FINGERPRINT_PRELOAD_SCENARIOS,
} from './helpers/agent-task-request-fingerprints-v2.ts';

test('reviewed raw model requests retain their fingerprints across three protocols and runtime scenarios', {timeout: 120_000}, async () => {
  const actual = await collectTaskRequestFingerprints(), expected = readTaskRequestFingerprintFixture();
  assert.deepEqual(actual, expected.requests,
    'Model request bytes changed. Review the request/scenario differences before running node tests/helpers/agent-task-request-fingerprints-v2.ts --update.');
  for (const protocol of FINGERPRINT_PROTOCOLS) for (const scenario of [...FINGERPRINT_SCENARIOS, ...OFFICIAL_FINGERPRINT_SCENARIOS]) {
    const requests = actual.filter(value => value.protocol === protocol && value.scenario === scenario);
    assert.ok(requests.length > 0, `${protocol}/${scenario} is missing`);
    assert.deepEqual(requests.map(value => value.index), requests.map((_value, index) => index + 1));
    if (FINGERPRINT_PRELOAD_SCENARIOS.some(value => value === scenario)) assert.equal(requests.length, 4);
    if (OFFICIAL_FINGERPRINT_SCENARIOS.some(value => value === scenario)) {
      assert.equal(requests.length, scenario === 'official_single_reply' ? 1 : 4);
    }
  }
});
