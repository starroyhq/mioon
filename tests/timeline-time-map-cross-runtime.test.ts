import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  CROSS_RUNTIME_FIXTURE_VERSION, buildCrossRuntimePayload, crossRuntimeHash,
} from './helpers/timeline-time-map-vectors.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/timeline-time-map/cross-runtime-v1.json', import.meta.url), 'utf8')) as {
  version: number; profile: string; hash: string; payload: unknown;
};

test('the cross-runtime fixture records the same integer tables and stable hash as Node', () => {
  const payload = buildCrossRuntimePayload();
  assert.equal(CROSS_RUNTIME_FIXTURE_VERSION, fixture.version);
  assert.equal(fixture.profile, 'timeline-time-map-v1');
  const hash = crossRuntimeHash(payload);
  assert.match(hash, /^[0-9a-f]{16}$/u);
  assert.equal(hash, fixture.hash, 'Node table hash changed; regenerate only after reviewing every row');
  assert.deepEqual(payload, fixture.payload, 'Node integer tables changed; this fixture is the Chromium equality gate');
  assert.equal(crossRuntimeHash(buildCrossRuntimePayload()), hash, 'the same inputs must rebuild the same hash');
})

test('the fixture hash covers every table value', () => {
  const payload = buildCrossRuntimePayload();
  const changed = JSON.parse(JSON.stringify(payload)) as {cases: {forward?: number[]}[]};
  const caseWithFrames = changed.cases.find(item => item.forward && item.forward.length > 2);
  assert.ok(caseWithFrames?.forward);
  caseWithFrames.forward[1] = (caseWithFrames.forward[1] ?? 0) + 1;
  assert.notEqual(crossRuntimeHash(changed), fixture.hash);
})
