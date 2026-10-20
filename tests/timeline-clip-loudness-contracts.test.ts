import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, operationEffect, schemas, isTimelineClipLoudnessResponse} from '@mioon/contracts';
import {discoverSchema} from '@mioon/client';
import {timelineClipLoudnessResponseSchema} from '@mioon/contracts/timeline-clip-loudness';
import {translate} from '../packages/i18n/src/index.ts';
import {clipLoudnessInput as input, readyClipLoudness, silentClipLoudness, clipLoudnessOperation as operation} from './fixtures/timeline-clip-loudness-fixtures.ts';
interface MutableClipLoudness {[key: string]: unknown; identity: {startFrame: number; durationFrames: number; measurementStartFrame: number; sourceInFrame: number; assetSha256: string; [key: string]: unknown}; measurement: {sampleRate: number; truePeakLinear: number; integratedLufs: number; [key: string]: unknown}}
interface SchemaView {requiresRequestId?: boolean; inputSchema: {required: string[]; additionalProperties: unknown}; effects: {databaseWrite?: boolean; fileWrite?: boolean}}

test('strict catalog operation is observation only with no persisted request or scope-changing options', () => {
  assert.deepEqual(parse(operation, input), input); assert.ok(Object.hasOwn(schemas, operation));
  const {notes, ...effect} = operationEffect(operation);
  assert.deepEqual(effect, {readOnly: true, idempotent: true, destructive: false, openWorld: false, databaseWrite: false,
    fileWrite: false, externalIO: false, localProcess: true, paidGeneration: false});
  assert.match(notes as string, /no implicit target or apply authority/);
  const definition = discoverSchema({operation}) as unknown as SchemaView; assert.equal(definition.requiresRequestId, false);
  assert.deepEqual(definition.inputSchema.required, Object.keys(input)); assert.equal(definition.inputSchema.additionalProperties, false);
});
test('measurement schema preserves fixed algorithm states and exact clip output bounds', () => {
  for (const value of [readyClipLoudness(), silentClipLoudness()]) {
    assert.equal(timelineClipLoudnessResponseSchema.safeParse(value).success, true); assert.equal(isTimelineClipLoudnessResponse(value, input), true);
  }
  const mutators: Array<(v: MutableClipLoudness)=>void> = [v => v.identity.startFrame = 17999, v => v.identity.durationFrames++, v => v.identity.durationFrames = 1801, v => v.identity.measurementStartFrame = 1,
    v => v.identity.sourceInFrame = -1, v => v.identity.sourceInFrame = 17999, v => v.identity.sourceInFrame = Infinity, v => v.identity.assetSha256 += '\n',
    v => v.measurement.sampleRate = 44100, v => v.measurement.truePeakLinear = 0, v => v.measurement.integratedLufs = Infinity];
  for (const mutate of mutators) {
    const value = readyClipLoudness() as unknown as MutableClipLoudness; mutate(value); assert.equal(isTimelineClipLoudnessResponse(value, input), false);
  }
});
test('response guard rejects exotic objects, accessors, cycles, arrays, extra keys and oversized strings', () => {
  let calls = 0; const getter = {get status() {calls++; return 'ready';}};
  const cyclic = readyClipLoudness() as unknown as Record<string, unknown>; cyclic.extra = cyclic;
  for (const value of [getter, cyclic, new Date(), [], Object.assign(Object.create({}), readyClipLoudness()),
    {...readyClipLoudness(), target: {}}, {...readyClipLoudness(), candidate: {}}, {...readyClipLoudness(), extra: 'x'.repeat(8193)}])
    assert.equal(isTimelineClipLoudnessResponse(value, input), false);
  assert.equal(calls, 0);
});
test('four locale operation discovery text is present and never silently grants application', () => {
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    const text = translate(locale as never, `operation.${operation}`); assert.notEqual(text, `operation.${operation}`); assert.ok(text.length > 40);
    const definition = discoverSchema({operation}) as unknown as SchemaView; assert.equal(definition.effects.databaseWrite, false); assert.equal(definition.effects.fileWrite, false);
  }
});

test('explicit targets bind measured candidates without granting mutation authority', async () => {
  const {matchInput, matchedClipLoudness} = await import('./fixtures/clip-loudness-match-fixtures.ts');
  assert.deepEqual(parse(operation, matchInput), matchInput);
  const report = matchedClipLoudness();
  assert.equal(isTimelineClipLoudnessResponse(report, matchInput), true);
  assert.equal(isTimelineClipLoudnessResponse(report, input), false);
  assert.equal(isTimelineClipLoudnessResponse(report, {...matchInput, target: {...matchInput.target, integratedLufs: -24}}), false);
  assert.equal(parse(operation, matchInput).target?.truePeakCeilingDbtp, -1);
  for (const mutate of [(v: typeof report) => {v.candidate.afterGain = 2;},
    (v: typeof report) => {v.candidate.measuredPcmBytes--;},
    (v: typeof report) => {v.candidate.meetsTarget = false;},
    (v: typeof report) => {v.candidate.meetsTruePeak = false;},
    (v: typeof report) => {v.candidate.measurement.sampleFrames--;},
    (v: typeof report) => {v.candidate.requiredGainDb++;}]) {
    const value = matchedClipLoudness(); mutate(value); assert.equal(isTimelineClipLoudnessResponse(value, matchInput), false);
  }
  for (const target of [undefined, {}, {integratedLufs: -61, truePeakCeilingDbtp: -1},
    {integratedLufs: -14, truePeakCeilingDbtp: 1}, {...matchInput.target, gain: 1}])
    assert.throws(() => parse(operation, {...input, target}));
});
