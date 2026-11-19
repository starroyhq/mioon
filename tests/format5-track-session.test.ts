import assert from 'node:assert/strict';
import test from 'node:test';
import {Format5EditSession, format5CommandErrorMessageKey} from '../apps/web/src/edit-ui/session.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const trackId = '10000000-0000-4000-8000-000000000095';
const envelope = {trackIntent: {side: 'timeline', operation: {kind: 'track-structure',
  edit: {kind: 'update', trackId, patch: {muted: true}}}}} as unknown as SequenceEditEnvelope;
const calls: {operation: string; input: any}[] = [];
const rpc = async (operation: string, input: any): Promise<unknown> => {
  calls.push({operation, input});
  if (operation === 'sequence.preview') return {envelope, planDigest: 'a'.repeat(64), warnings: []};
  return {status: 'applied', actionId: '10000000-0000-4000-8000-000000000096',
    operation: 'timeline.track.update', receipt: {status: 'applied'}};
};

test('the format-5 session previews and commits one track intent without a raw envelope', async () => {
  const session = new Format5EditSession(rpc, () => projectId);
  const result = await session.runTrack({side: 'timeline', operation: {kind: 'track-structure',
    edit: {kind: 'update', trackId, patch: {muted: true}}}});
  assert.equal(result.ok, true);
  assert.equal(calls[0]!.operation, 'sequence.preview');
  assert.deepEqual(calls[0]!.input.trackIntent, {side: 'timeline', operation: {kind: 'track-structure',
    edit: {kind: 'update', trackId, patch: {muted: true}}}});
  assert.equal(calls[1]!.operation, 'sequence.commit');
  assert.deepEqual(calls[1]!.input.envelope, envelope);
  assert.equal(calls[1]!.input.expectedPlanDigest, 'a'.repeat(64));
  assert.equal(format5CommandErrorMessageKey('SEQUENCE_EDIT_TRACK_INVALID'), 'editUi.error.SEQUENCE_EDIT_TRACK_INVALID');
});

test('a refused track preview does not commit and a second click is ignored while in flight', async () => {
  let resolvePreview!: (value: unknown) => void;
  const firstCalls: string[] = [];
  const slowRpc = (operation: string, input: any): Promise<unknown> => {
    firstCalls.push(operation);
    if (operation === 'sequence.preview') return new Promise(resolve => {resolvePreview = resolve;});
    return Promise.resolve({status: 'applied', actionId: '10000000-0000-4000-8000-000000000097',
      operation: 'timeline.track.update', receipt: {status: 'applied'}});
  };
  const session = new Format5EditSession(slowRpc, () => projectId);
  const first = session.runTrack({side: 'timeline', operation: {kind: 'track-structure',
    edit: {kind: 'update', trackId, patch: {muted: true}}}});
  const second = await session.runTrack({side: 'timeline', operation: {kind: 'track-structure',
    edit: {kind: 'update', trackId, patch: {muted: false}}}});
  assert.equal(second.ok, false);
  resolvePreview({ok: false, code: 'SEQUENCE_EDIT_TRACK_INVALID', ids: [trackId]});
  assert.equal((await first).ok, false);
  assert.deepEqual(firstCalls, ['sequence.preview']);
});
