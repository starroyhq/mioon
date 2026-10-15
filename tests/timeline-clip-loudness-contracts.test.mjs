import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, operationEffect, schemas, isTimelineClipLoudnessResponse} from '@mioon/contracts';
import {discoverSchema} from '@mioon/client';
import {timelineClipLoudnessResponseSchema} from '@mioon/contracts/timeline-clip-loudness';
import {translate} from '../packages/i18n/src/index.ts';
import {clipLoudnessInput as input, readyClipLoudness, silentClipLoudness, clipLoudnessOperation as operation} from './fixtures/timeline-clip-loudness-fixtures.mjs';

test('strict catalog operation is observation only with no persisted request or scope-changing options', () => {
  assert.deepEqual(parse(operation, input), input); assert.ok(Object.hasOwn(schemas, operation));
  const {notes, ...effect} = operationEffect(operation);
  assert.deepEqual(effect, {readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false,
    fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false});
  assert.match(notes, /No target, candidate, apply authority/);
  const definition = discoverSchema({operation}); assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(definition.inputSchema.required, Object.keys(input)); assert.equal(definition.inputSchema.additionalProperties, false);
});
test('measurement schema preserves fixed algorithm states and exact clip output bounds', () => {
  for (const value of [readyClipLoudness(), silentClipLoudness()]) {
    assert.equal(timelineClipLoudnessResponseSchema.safeParse(value).success, true); assert.equal(isTimelineClipLoudnessResponse(value, input), true);
  }
  for (const mutate of [v => v.identity.startFrame = 17999, v => v.identity.durationFrames++, v => v.identity.durationFrames = 1801, v => v.identity.measurementStartFrame = 1,
    v => v.identity.sourceInFrame = -1, v => v.identity.sourceInFrame = 17999, v => v.identity.sourceInFrame = Infinity, v => v.identity.assetSha256 += '\n',
    v => v.measurement.sampleRate = 44100, v => v.measurement.truePeakLinear = 0, v => v.measurement.integratedLufs = Infinity]) {
    const value = readyClipLoudness(); mutate(value); assert.equal(isTimelineClipLoudnessResponse(value, input), false);
  }
});
test('response guard rejects exotic objects, accessors, cycles, arrays, extra keys and oversized strings', () => {
  let calls = 0; const getter = {get status() {calls++; return 'ready';}};
  const cyclic = readyClipLoudness(); cyclic.extra = cyclic;
  for (const value of [getter, cyclic, new Date(), [], Object.assign(Object.create({}), readyClipLoudness()),
    {...readyClipLoudness(), target: {}}, {...readyClipLoudness(), candidate: {}}, {...readyClipLoudness(), extra: 'x'.repeat(8193)}])
    assert.equal(isTimelineClipLoudnessResponse(value, input), false);
  assert.equal(calls, 0);
});
test('four locale operation discovery text is present and never silently grants application', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    const text = translate(locale, `operation.${operation}`); assert.notEqual(text, `operation.${operation}`); assert.ok(text.length > 40);
    const definition = discoverSchema({operation}); assert.equal(definition.effects.databaseWrite, false); assert.equal(definition.effects.fileWrite, false);
  }
});
