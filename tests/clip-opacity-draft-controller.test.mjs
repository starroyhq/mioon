import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipDraftController, clipDraftRaw} from '../apps/web/src/clip-draft-state.ts';
import {createOpacityCandidateClipDraftClient} from '../apps/web/src/clip-draft-client.ts';
import {rawOpacityEnvelopeFields, validateRawOpacityEnvelope} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {opacityCandidateTimelineProjection} from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.mjs';

const id = n => `a3000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const key = {projectId: id(1), timelineId: id(2), clipId: id(3)}, source = {assetId: id(5), assetSha256: 'b'.repeat(64)};
const base = {name: 'Saved clip', trackId: id(4), startFrame: 0, durationFrames: 120, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1};
const opacity = () => ({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '0', opacity: '.25'}, {frame: '120', opacity: '1'}]});
const volume = () => ({profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: '0', multiplier: '1'}]});
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
function harness(t, {saved = {}, editable = true, putGate} = {}) {
  const context = {...key, scope: 'synthetic-owner', restored: false, connected: true, visible: true, busy: false,
    volumeEnvelopeEditable: true, opacityEnvelopeEditable: editable, timelineRevision: 7, source, saved: {...base, ...saved}};
  let row = {supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(6), key, revision: 0, targetStatus: 'matching', draft: null};
  const calls = [];
  const client = createOpacityCandidateClipDraftClient(async (_url, options) => {
    const input = options.body ? JSON.parse(options.body) : null;calls.push([options.method, input]);
    if (options.method !== 'GET') {
      if (options.method === 'PUT' && putGate) await putGate.promise;
      assert.equal(input.expectedRevision, row.revision);
      row = {...row, revision: row.revision + 1, draft: options.method === 'DELETE' ? null : {baseRevision: input.baseRevision, source: input.source, raw: input.raw, updatedAt: stamp}};
    }
    return new Response(JSON.stringify({ok: true, data: row}));
  });
  const controller = createClipDraftController({context, client, delay: 60000, validateTimeline(value, projectId) {
    const projected = opacityCandidateTimelineProjection(value, projectId);
    return projected !== null && isTimelineRecord(projected, {projectId});
  }});
  t.after(() => controller.dispose());
  const result = patch => {
    const fields = validateRawOpacityEnvelope(context.saved, base.durationFrames);
    assert.equal(fields.valid, true);
    const clip = {id: key.clipId, assetId: source.assetId, ...base, ...fields.fields, ...patch};
    return {id: key.timelineId, projectId: key.projectId, revision: 8, fps: 30, width: 720, height: 1280,
      tracks: [{id: base.trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [clip], durationFrames: clip.startFrame + clip.durationFrames, createdAt: stamp, updatedAt: stamp};
  };
  return {controller, context, calls, result, row: () => structuredClone(row)};
}

test('volume and opacity composition share one owner and reject each other’s tokens without clearing close protection', async t => {
  const {controller: c, context, calls} = harness(t);await c.load();
  const v = c.beginVolumeComposition(c.capture());assert.ok(v);assert.equal(c.getPendingEnvelopeKind(), 'volume');
  assert.equal(c.beginOpacityComposition(c.capture()), null);
  assert.equal(c.updateOpacityComposition(v, {pending: true}), false);
  assert.equal(c.editOpacityEnvelope(opacity(), v), false);assert.equal(c.endOpacityComposition(v), false);
  assert.equal(c.hasPendingComposition(), true);assert.equal(c.getPendingEnvelopeKind(), 'volume');assert.equal(await c.flushForClose(), false);
  assert.equal(c.endVolumeComposition(v), true);assert.equal(c.getPendingEnvelopeKind(), null);
  const o = c.beginOpacityComposition(c.capture());assert.ok(o);assert.equal(c.getPendingEnvelopeKind(), 'opacity');
  assert.equal(c.beginVolumeComposition(c.capture()), null);
  assert.equal(c.updateVolumeComposition(o, {pending: true}), false);
  assert.equal(c.editVolumeEnvelope(volume(), o), false);assert.equal(c.endVolumeComposition(o), false);
  assert.equal(c.endOpacityComposition(v), false);assert.equal(c.hasPendingComposition(), true);assert.equal(c.getPendingEnvelopeKind(), 'opacity');
  assert.equal(c.getEditorCloseSnapshot().inflight, true);assert.equal(c.canAbandon(), false);
  assert.equal(await c.save(() => assert.fail('IME cannot execute Save')), null);assert.equal(await c.flushForClose(), false);
  c.setContext({...context, connected: false, opacityEnvelopeEditable: false});
  assert.equal(c.editOpacityEnvelope(opacity(), o), true, 'the original owner may settle text after capability loss');
  assert.equal(c.endOpacityComposition(o), true);assert.equal(c.hasPendingComposition(), false);assert.equal(c.getPendingEnvelopeKind(), null);
  assert.deepEqual(c.getState().raw.opacityEnvelope, opacity());assert.equal(c.hasUnsaved(), true);
  assert.equal(await c.flushForClose(), false);assert.deepEqual(calls.map(value => value[0]), ['GET']);
});

for (const expected of ['absent', null, 'curve']) test(`unchanged opacity ${String(expected)} is omitted from patch but exact presence remains mandatory in ACK`, async t => {
  const saved = expected === 'absent' ? {} : {opacityEnvelope: expected === null ? null : opacity()};
  const {controller: c, calls, result} = harness(t, {saved, editable: false});await c.load();assert.equal(c.edit('name', 'Name only'), true);
  let patch;
  const out = await c.save(async (_id, sent) => {
    patch = sent;const response = result(sent);
    if (expected === 'absent') response.clips[0].opacityEnvelope = null;else delete response.clips[0].opacityEnvelope;
    return response;
  });
  assert.equal(out, null);assert.equal(Object.hasOwn(patch, 'opacityEnvelope'), false);
  assert.equal(c.getState().dirty, true);assert.equal(c.getState().raw.name, 'Name only');
  assert.equal(calls.filter(value => value[0] === 'DELETE').length, 0);
});

for (const value of ['curve', null]) test(`exact acknowledged ${String(value)} opacity survives local draft clearing`, async t => {
  const {controller: c, calls, result} = harness(t);await c.load();
  assert.equal(c.editOpacityEnvelope(value === null ? null : opacity(), c.capture()), true);
  let sent;
  const saved = await c.save(async (_id, patch, _base, options) => {sent = patch;assert.equal(options.canExecute(), true);return result(patch);});
  assert.ok(saved);assert.equal(Object.hasOwn(sent, 'opacityEnvelope'), true);
  assert.equal(c.getState().dirty, false);assert.equal(calls.filter(value => value[0] === 'DELETE').length, 1);
  assert.deepEqual(c.getState().raw, {...clipDraftRaw(saved.clips[0]), ...rawOpacityEnvelopeFields(saved.clips[0])});
});

test('a late exact opacity ACK cannot clear later form input or the persisted draft owner', async t => {
  const {controller: c, calls, result} = harness(t), gate = deferred(), entered = deferred();await c.load();
  c.editOpacityEnvelope(opacity(), c.capture());let original;
  const saving = c.save(async (_id, patch) => {original = patch;entered.resolve();return gate.promise;});
  await entered.promise;assert.equal(c.edit('name', 'Newer input'), true);gate.resolve(result(original));await saving;
  assert.equal(c.getState().dirty, true);assert.equal(c.getState().raw.name, 'Newer input');
  assert.deepEqual(c.getState().raw.opacityEnvelope, opacity());assert.equal(calls.filter(value => value[0] === 'DELETE').length, 0);
});

test('opacity capability loss while draft flush is pending cancels business dispatch without dropping raw input', async t => {
  const putGate = deferred(), {controller: c, context, row} = harness(t, {putGate});await c.load();
  c.editOpacityEnvelope(opacity(), c.capture());const saving = c.save(() => assert.fail('lost capability must prevent dispatch'));
  await turn();c.setContext({...context, opacityEnvelopeEditable: false});putGate.resolve();
  assert.equal(await saving, null);assert.deepEqual(c.getState().raw.opacityEnvelope, opacity());
  assert.deepEqual(row().draft.raw.opacityEnvelope, opacity());assert.equal(c.getState().dirty, true);
});

test('opacity capability loss revokes a prepared save’s canExecute guard', async t => {
  const {controller: c, context, calls} = harness(t), gate = deferred(), entered = deferred();await c.load();
  c.editOpacityEnvelope(opacity(), c.capture());let guard;
  const saving = c.save(async (_id, _patch, _base, options) => {guard = options.canExecute;entered.resolve();await gate.promise;return null;});
  await entered.promise;assert.equal(guard(), true);c.setContext({...context, opacityEnvelopeEditable: false});assert.equal(guard(), false);
  gate.resolve();assert.equal(await saving, null);assert.equal(c.getState().dirty, true);
  assert.equal(calls.filter(value => value[0] === 'DELETE').length, 0);
});
