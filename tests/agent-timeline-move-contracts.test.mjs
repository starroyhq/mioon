import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE,
  isAgentTimelineMoveArguments, isAgentTimelineMoveTarget, agentTimelineMoveTargetFromTimeline,
  isAgentTimelineMovePublicTarget, agentTimelineMovePublicTarget,
  isAgentTimelineMoveReviewTarget, agentTimelineMoveReviewTarget,
  agentTimelineMoveModelContext, agentTimelineMoveDiff, isAgentTimelineMoveProposal,
} from '../packages/contracts/src/index.ts';
import {
  TIMELINE_EDIT_TOOL_DEFINITIONS, TIMELINE_EDIT_TOOL_LIMITS, TIMELINE_EDIT_TOOL_CATALOG_HASH,
  TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, timelineEditToolCapability, timelineEditToolPolicy,
  parseTimelineEditToolArguments, selectedTimelineClipMessage,
} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {EDIT_TOOL_CATALOG_HASH, EDIT_TOOL_DEFINITIONS, editToolPolicy} from '../packages/business/src/agent/edit-tool-policy.ts';

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamp = '2026-10-12T00:00:00.000Z';
const code = expected => error => error.code === expected;
const clone = value => structuredClone(value);
function saved() {
  const tracks = [{id: id(3), name: 'Selected track', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: id(4), name: 'PRIVATE_OTHER_TRACK_NAME', kind: 'video', orderIndex: 1, hidden: false, muted: true}];
  const clip = {id: id(5), trackId: id(3), assetId: id(6), name: 'Selected clip', startFrame: 120,
    durationFrames: 60, sourceInFrame: 7, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 0.7,
    versionId: id(7), shotId: id(8), jobId: id(9), fadeInFrames: 5};
  return {id: id(1), projectId: id(2), revision: 4, fps: 30, width: 720, height: 1280, tracks,
    clips: [clip, {...clip, id: id(10), name: 'PRIVATE_OTHER_CLIP_NAME', startFrame: 0, durationFrames: 30},
      {...clip, id: id(11), trackId: id(4), name: 'PRIVATE_OTHER_TRACK_CLIP', startFrame: 300, durationFrames: 120}],
    durationFrames: 420, createdAt: timestamp, updatedAt: timestamp};
}
const target = () => agentTimelineMoveTargetFromTimeline(saved(), id(5));
function proposal(status = 'pending') {
  const selected = target();
  return {id: id(20), projectId: id(2), runId: id(21), runStatus: 'completed', digest: 'b'.repeat(64), status,
    operation: 'timeline.clip.update', target: agentTimelineMovePublicTarget(selected), patch: {startFrame: 60},
    diff: agentTimelineMoveDiff(selected, {startFrame: 60}), provenance: {runId: id(21), toolCallId: 'call_move', toolName: 'mioon_propose_timeline_clip_move'},
    createdAt: timestamp, updatedAt: timestamp,
    ...(!['pending', 'rejected', 'cancelled'].includes(status) ? {approval: {requestId: id(22), approvedAt: timestamp}} : {}),
    ...(status === 'applied' ? {outcome: {status: 'applied', timelineId: id(1), clipId: id(5), revision: 5}} : {}),
    ...(status === 'failed' ? {outcome: {status: 'not_applied', code: 'REVISION_CONFLICT'}} : {})};
}

test('closed timeline policy keeps the old shot policy and catalog bytes unchanged', () => {
  const oldBytes = readFileSync(new URL('../packages/business/src/agent/edit-tool-policy.ts', import.meta.url));
  assert.equal(createHash('sha256').update(oldBytes).digest('hex'), '3f70630c33fb000d8a6ab16da8f488ee8fb4dcb8d80e8b02d9aec782b822f661');
  assert.equal(EDIT_TOOL_CATALOG_HASH, createHash('sha256').update(JSON.stringify(EDIT_TOOL_DEFINITIONS)).digest('hex'));
  assert.equal(editToolPolicy(id(2)).context, 'selected_shot_edit');
  assert.equal(editToolPolicy(id(2)).schemaVersion, 1);
  assert.equal(EDIT_TOOL_DEFINITIONS.length, 1);
  assert.equal(EDIT_TOOL_DEFINITIONS[0].name, 'mioon_propose_shot_update');
  assert.equal(AGENT_TIMELINE_MOVE_CONTEXT, 'selected_timeline_clip_move');
  assert.equal(AGENT_TIMELINE_MOVE_PROVENANCE, 'project_selected_timeline_timing');
  const policy = timelineEditToolPolicy(id(2)), capability = timelineEditToolCapability(true);
  assert.equal(policy.catalogHash, TIMELINE_EDIT_TOOL_CATALOG_HASH);
  assert.notEqual(policy.catalogHash, EDIT_TOOL_CATALOG_HASH);
  assert.equal(policy.maxModelRequests, 2); assert.equal(policy.maxToolCalls, 1); assert.equal(policy.maxResultBytes, 8192);
  assert.equal(capability.maxStartFrame, 18000); assert.equal(capability.maxOccupiedIntervals, 99);
  assert.equal(policy.context, AGENT_TIMELINE_MOVE_CONTEXT);
  assert.deepEqual(policy.catalog, TIMELINE_EDIT_TOOL_DEFINITIONS);
  assert.deepEqual(policy.catalog[0].parameters, {type: 'object', properties: {startFrame: {type: 'integer', minimum: 0, maximum: 18000,
    description: 'Proposed start frame at 30fps. The complete fixed-duration clip must fit without same-track overlap.'}}, required: ['startFrame'], additionalProperties: false});
  assert.match(TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, /final answer has no tools/);
  policy.catalog[0].parameters.properties.startFrame.maximum = 90000;
  assert.equal(TIMELINE_EDIT_TOOL_DEFINITIONS[0].parameters.properties.startFrame.maximum, 18000);
});

test('complete argument parser rejects extra fields, duplicate and escaped keys, coercion and oversized input', () => {
  for (const startFrame of [0, 1, 30, 17999, 18000]) {
    const result = parseTimelineEditToolArguments('mioon_propose_timeline_clip_move', JSON.stringify({startFrame}));
    assert.deepEqual(result, {operation: 'timeline.clip.update', arguments: {startFrame}, dispatchArguments: {startFrame}});
  }
  for (const input of ['{}', 'null', '[]', '{"startFrame":null}', '{"startFrame":"30"}', '{"startFrame":true}',
    '{"startFrame":-1}', '{"startFrame":1.5}', '{"startFrame":18001}', '{"startFrame":1e999}',
    '{"startFrame":1,"startFrame":2}', '{"startFrame":1,"start\\u0046rame":2}', '{"startFrame":1,"clipId":"PRIVATE"}',
    '{"startFrame":1,"patch":{"startFrame":2}}', '{"startFrame":1,"operation":"timeline.clip.update"}',
    '{"startFrame":1,"requestId":"PRIVATE"}', '{"startFrame":1,"expectedRevision":4}', '{"startFrame":1,"__proto__":{}}',
    '{"startFrame":', '{"startFrame":[30]}'])
    assert.throws(() => parseTimelineEditToolArguments('mioon_propose_timeline_clip_move', input), code('AGENT_CHAT_PROTOCOL_ERROR'), input);
  assert.throws(() => parseTimelineEditToolArguments('mioon_propose_shot_update', '{"startFrame":30}'), code('AGENT_CHAT_TOOLS_UNSUPPORTED'));
  assert.throws(() => parseTimelineEditToolArguments('mioon_propose_timeline_clip_move', ' '.repeat(TIMELINE_EDIT_TOOL_LIMITS.maxArgumentsBytes + 1)), code('AGENT_CHAT_LIMIT'));
  assert.equal(isAgentTimelineMoveArguments({startFrame: 2, ignored: undefined}), false);
});

test('private target reuses complete saved clip rules without normalizing any source fields', () => {
  const timeline = saved(), original = JSON.stringify(timeline), selected = agentTimelineMoveTargetFromTimeline(timeline, id(5));
  assert.ok(isAgentTimelineMoveTarget(selected, {projectId: id(2)}));
  assert.equal(isAgentTimelineMoveTarget(selected, {projectId: id(99)}), false);
  assert.deepEqual(selected.clip, timeline.clips[0]);
  assert.deepEqual(selected.track, timeline.tracks[0]);
  assert.equal(selected.remainingTimelineEndFrame, 420); assert.equal(selected.subtitleEndFrame, 0);
  assert.deepEqual(selected.occupiedIntervals, [{startFrame: 0, endFrame: 30}]);
  assert.equal(Object.hasOwn(selected.clip, 'fadeOutFrames'), false);
  assert.equal(JSON.stringify(timeline), original);
  selected.clip.rect.width = 2;
  assert.equal(JSON.stringify(timeline), original);
  assert.equal(agentTimelineMoveTargetFromTimeline(timeline, id(99)), null);
  const corrupt = saved(); corrupt.clips[0].relativePath = '/PRIVATE';
  assert.equal(agentTimelineMoveTargetFromTimeline(corrupt, id(5)), null);
});

test('target rejects malformed clip schema, unsupported output, private extras and inconsistent numeric context', () => {
  const modifications = [
    value => { value.clip.durationFrames = 0; }, value => { value.clip.sourceInFrame = -1; },
    value => { value.clip.rect.width = 719; }, value => { value.clip.rect.width = 1280; },
    value => { value.clip.fadeOutFrames = 60; }, value => { value.clip.assetId = 'asset'; },
    value => { value.clip.sourcePath = '/PRIVATE'; }, value => { value.clip.sha256 = 'f'.repeat(64); },
    value => { value.track.hidden = true; value.track.kind = 'audio'; }, value => { value.track.kind = 'subtitle'; },
    value => { value.track.id = id(99); }, value => { value.track.relativePath = '/PRIVATE'; },
    value => { value.fps = 60; }, value => { value.width = 1920; value.height = 1080; },
    value => { value.durationFrames = 419; }, value => { value.remainingTimelineEndFrame = 18001; },
    value => { value.subtitleEndFrame = 421; }, value => { value.subtitleText = 'PRIVATE'; },
    value => { value.expectedRevision = Number.MAX_SAFE_INTEGER; }, value => { value.clip.startFrame = 18000; },
    value => { value.occupiedIntervals = [{startFrame: 119, endFrame: 121}]; },
    value => { value.occupiedIntervals = [{startFrame: 0, endFrame: 30}, {startFrame: 0, endFrame: 30}]; },
    value => { value.occupiedIntervals = [{startFrame: 30, endFrame: 60}, {startFrame: 0, endFrame: 30}]; },
    value => { value.occupiedIntervals[0].clipId = id(10); }, value => { value.occupiedIntervals[0].endFrame = 421; },
    value => { value.occupiedIntervals = Array.from({length: 100}, (_, n) => ({startFrame: n, endFrame: n + 1})); },
  ];
  for (const modify of modifications) { const value = target(); modify(value); assert.equal(isAgentTimelineMoveTarget(value), false, modify.toString()); }
});

test('strict data guard does not invoke getters or accept symbols, sparse arrays, prototypes or cycles', () => {
  let invoked = 0;
  const getter = target(); Object.defineProperty(getter.clip, 'gain', {enumerable: true, get() { invoked++; return 1; }});
  assert.equal(isAgentTimelineMoveTarget(getter), false); assert.equal(invoked, 0);
  const symbol = target(); symbol.clip[Symbol('private')] = 1; assert.equal(isAgentTimelineMoveTarget(symbol), false);
  const hidden = target(); Object.defineProperty(hidden.clip, 'private', {value: true}); assert.equal(isAgentTimelineMoveTarget(hidden), false);
  const sparse = target(); sparse.occupiedIntervals = new Array(1); assert.equal(isAgentTimelineMoveTarget(sparse), false);
  const extended = target(); extended.occupiedIntervals.private = true; assert.equal(isAgentTimelineMoveTarget(extended), false);
  const inherited = target(); Object.setPrototypeOf(inherited.clip, {private: true}); assert.equal(isAgentTimelineMoveTarget(inherited), false);
  const cyclic = target(); cyclic.clip.rect = cyclic; assert.equal(isAgentTimelineMoveTarget(cyclic), false);
});

test('public projections are detached, exact and retain timing without media identity', () => {
  const value = target(), publicTarget = agentTimelineMovePublicTarget(value), review = agentTimelineMoveReviewTarget(value);
  assert.ok(isAgentTimelineMovePublicTarget(publicTarget, {projectId: id(2)}));
  assert.ok(isAgentTimelineMoveReviewTarget(review, {projectId: id(2)}));
  assert.equal(isAgentTimelineMovePublicTarget(review), false);
  assert.equal(isAgentTimelineMoveReviewTarget({...review, assetId: id(6)}), false);
  assert.equal(isAgentTimelineMoveReviewTarget({...review, endFrame: 181}), false);
  assert.equal(isAgentTimelineMoveReviewTarget({...review, timelineDurationFrames: 100}), false);
  assert.equal(isAgentTimelineMoveReviewTarget({...review, occupiedIntervals: [{startFrame: 150, endFrame: 170}]}), false);
  assert.equal(review.startFrame, 120); assert.equal(review.endFrame, 180); assert.equal(review.timelineDurationFrames, 420);
  for (const mediaId of [id(6), id(7), id(8), id(9)]) assert.equal(JSON.stringify(review).includes(mediaId), false);
  review.occupiedIntervals[0].endFrame = 1; assert.equal(value.occupiedIntervals[0].endFrame, 30);
  assert.equal(agentTimelineMovePublicTarget({...value, private: true}), null);
});

test('outbound model projection includes only approved selected human names and numeric timing', () => {
  const value = target(), model = agentTimelineMoveModelContext(value), message = selectedTimelineClipMessage('Move earlier.', value);
  assert.deepEqual(model, {clip: {name: 'Selected clip', startFrame: 120, durationFrames: 60, endFrame: 180},
    track: {name: 'Selected track', kind: 'video'}, fps: 30, occupiedIntervals: [{startFrame: 0, endFrame: 30}], maxEndFrame: 18000});
  assert.deepEqual(JSON.parse(message), {kind: 'untrusted_selected_timeline_clip', saved: model, userRequest: 'Move earlier.'});
  for (let index = 1; index <= 11; index++) assert.equal(message.includes(id(index)), false);
  for (const forbidden of ['PRIVATE', 'assetId', 'versionId', 'shotId', 'jobId', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames',
    'sha256', 'path', 'remainingTimelineEndFrame', 'subtitleEndFrame', 'timelineDurationFrames', 'expectedRevision']) assert.equal(message.includes(forbidden), false, forbidden);
  model.occupiedIntervals[0].endFrame = 1; assert.equal(value.occupiedIntervals[0].endFrame, 30);
  assert.throws(() => selectedTimelineClipMessage('x'.repeat(32 * 1024), value), code('AGENT_CHAT_LIMIT'));
  assert.throws(() => selectedTimelineClipMessage('Move.', {...value, source: 'PRIVATE'}), code('AGENT_CHAT_VALIDATION'));
});

test('diff is same-track non-ripple with immutable duration, and rejects noop, overlap, endpoints and subtitle shrink', () => {
  const value = target(), original = JSON.stringify(value);
  assert.deepEqual(agentTimelineMoveDiff(value, {startFrame: 30}), {before: {startFrame: 120, endFrame: 180, durationFrames: 60, timelineDurationFrames: 420},
    after: {startFrame: 30, endFrame: 90, durationFrames: 60, timelineDurationFrames: 420}});
  assert.equal(agentTimelineMoveDiff(value, {startFrame: 120}), null);
  assert.equal(agentTimelineMoveDiff(value, {startFrame: 29}), null);
  assert.equal(agentTimelineMoveDiff(value, {startFrame: 17941}), null);
  assert.equal(agentTimelineMoveDiff(value, {startFrame: 60, durationFrames: 1}), null);
  assert.equal(agentTimelineMoveDiff(value, {startFrame: 17940}).after.endFrame, 18000);
  const last = target(); last.remainingTimelineEndFrame = 30; last.durationFrames = 180; last.subtitleEndFrame = 100;
  assert.ok(isAgentTimelineMoveTarget(last));
  assert.equal(agentTimelineMoveDiff(last, {startFrame: 30}), null);
  assert.equal(agentTimelineMoveDiff(last, {startFrame: 40}).after.timelineDurationFrames, 100);
  last.subtitleEndFrame = 0;
  assert.equal(agentTimelineMoveDiff(last, {startFrame: 30}).after.timelineDurationFrames, 90);
  assert.equal(agentTimelineMoveDiff(last, {startFrame: 600}).after.timelineDurationFrames, 660);
  assert.equal(JSON.stringify(value), original);
});

test('public proposal union guards all statuses, exact immutable diff and request-bound compact outcomes', () => {
  for (const status of ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled']) {
    const value = proposal(status), before = JSON.stringify(value);
    assert.ok(isAgentTimelineMoveProposal(value, {projectId: id(2)}), status);
    assert.equal(JSON.stringify(value), before);
  }
  assert.equal(isAgentTimelineMoveProposal(proposal(), {projectId: id(99)}), false);
  const modifications = [value => { value.operation = 'shot.update'; }, value => { value.target.assetId = id(6); },
    value => { value.patch.trackId = id(4); }, value => { value.diff.after.durationFrames = 1; },
    value => { value.diff.after.endFrame++; }, value => { value.diff.after.startFrame++; },
    value => { value.patch.startFrame = 120; value.diff.after = clone(value.diff.before); },
    value => { value.diff.after.timelineDurationFrames = 419; }, value => { value.provenance.toolName = 'mioon_propose_shot_update'; },
    value => { value.provenance.toolCallId = 'call bad'; }, value => { value.target.expectedRevision = Number.MAX_SAFE_INTEGER; },
    value => { value.approval = {requestId: id(22), approvedAt: timestamp}; }, value => { value.sourcePath = '/PRIVATE'; },
    value => { value.outcome = {status: 'applied', timelineId: id(1), clipId: id(5), revision: 5}; }];
  for (const modify of modifications) { const value = proposal(); modify(value); assert.equal(isAgentTimelineMoveProposal(value), false, modify.toString()); }
  const running = proposal('approved'); running.runStatus = 'running'; assert.equal(isAgentTimelineMoveProposal(running), false);
  for (const key of ['timelineId', 'clipId']) { const value = proposal('applied'); value.outcome[key] = id(99); assert.equal(isAgentTimelineMoveProposal(value), false); }
  const revision = proposal('applied'); revision.outcome.revision = 6; assert.equal(isAgentTimelineMoveProposal(revision), false);
  for (const reason of ['NOT_FOUND', 'UNAUTHORIZED', 'NETWORK', 'PRIVATE', 'AGENT_EDIT_CONFLICT']) {
    const value = proposal('failed'); value.outcome.code = reason; assert.equal(isAgentTimelineMoveProposal(value), false, reason);
  }
});
