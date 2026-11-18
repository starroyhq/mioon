import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILD_TIMING_STAGES, hasDesktopTypecheckTiming, measureBuildStage, withDesktopTypecheckTiming} from '../scripts/lib/build-timings.ts';
import type {BuildTimingRecord, BuildTimingStage} from '../scripts/lib/build-timings.ts';

test('build timing returns the original value and records only a fixed stage and numeric outcome', async () => {
  const records: BuildTimingRecord[] = [], value = {output: 'PRIVATE_BUILD_OUTPUT'}, times = [100, 108.6];
  assert.equal(await measureBuildStage('web-bundle', async () => value, {now: () => times.shift()!, report: record => records.push(record)}), value);
  assert.deepEqual(records, [{schema: 1, stage: 'web-bundle', durationMs: 9, result: 'success'}]);
  assert.equal(JSON.stringify(records).includes(value.output), false);
  assert.equal(new Set(BUILD_TIMING_STAGES).size, BUILD_TIMING_STAGES.length);
});

test('nonzero child exits and interruptions keep their original result and record failure', async () => {
  for (const code of [7, 130, 143]) {
    const records: BuildTimingRecord[] = [], value = {code, signal: code === 7 ? null : 'SIGTERM'};
    assert.equal(await measureBuildStage('typecheck-tests-runtime', async () => value, {exitCode: result => result.code, report: record => records.push(record)}), value);
    assert.equal(records.length, 1); assert.equal(records[0]!.result, 'failed'); assert.equal(records[0]!.exitCode, code);
    assert.ok(Number.isInteger(records[0]!.durationMs) && records[0]!.durationMs >= 0);
  }
});

test('thrown build errors retain identity and their details never enter timing evidence', async () => {
  const records: BuildTimingRecord[] = [], error = Object.assign(Error('PRIVATE_BUILD_FAILURE'), {path: 'PRIVATE_BUILD_LOCATION', credential: 'PRIVATE_BUILD_CREDENTIAL'});
  await assert.rejects(measureBuildStage('desktop-main-bundle', async () => {throw error;}, {now: () => 42, report: record => records.push(record)}), value => value === error);
  assert.deepEqual(records, [{schema: 1, stage: 'desktop-main-bundle', durationMs: 0, result: 'failed'}]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BUILD/u);
});

test('unknown timing stages fail before executing work or emitting arbitrary identifiers', async () => {
  let started = false, reported = false;
  await assert.rejects(measureBuildStage('arbitrary-stage' as BuildTimingStage, async () => {started = true;}, {report() {reported = true;}}), /Unknown build timing stage/u);
  assert.equal(started, false); assert.equal(reported, false);
});

test('desktop typecheck timing is an async-local observation scope and does not leak after failure', async () => {
  assert.equal(hasDesktopTypecheckTiming(), false);
  await withDesktopTypecheckTiming(async () => {
    await Promise.resolve();
    assert.equal(hasDesktopTypecheckTiming(), true);
  });
  assert.equal(hasDesktopTypecheckTiming(), false);
  const error = Error('Synthetic scope failure');
  await assert.rejects(withDesktopTypecheckTiming(async () => {assert.equal(hasDesktopTypecheckTiming(), true); throw error;}), value => value === error);
  assert.equal(hasDesktopTypecheckTiming(), false);
});
