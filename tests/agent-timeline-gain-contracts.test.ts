import type {MutationInput} from './helpers/strict-agent-workspace-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE, AGENT_TIMELINE_GAIN_TOOL,
  AGENT_TIMELINE_GAIN_DEFINITION_VERSION, AGENT_TIMELINE_GAIN_LIMITS,
  isAgentTimelineGainArguments, isAgentTimelineGainSource, isAgentTimelineGainTarget,
  agentTimelineGainTargetFromTimeline, isAgentTimelineGainPublicTarget, agentTimelineGainPublicTarget,
  isAgentTimelineGainReviewTarget, agentTimelineGainReviewTarget, agentTimelineGainModelContext,
  agentTimelineGainDiff, isAgentTimelineGainProposal, createAgentTimelineGainContracts,
  isAgentTimelineMoveArguments, isAgentTimelineMoveTarget, isAgentTimelineMoveProposal,
  isTimelineRecord, hasRequestNotAppliedProof, timelineOutputPreset, schemas,
} from '../packages/contracts/src/index.ts';
import * as leaf from '@mioon/contracts/agent-timeline-gain';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamp = '2026-10-13T00:00:00.000Z';
const clone = <T>(value: T): T => structuredClone(value);
function saved() {
  const tracks = [{id: id(3), name: 'Selected track', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: id(4), name: 'PRIVATE_OTHER_TRACK', kind: 'video', orderIndex: 1, hidden: false, muted: true}];
  const clip = {id: id(5), trackId: id(3), assetId: id(6), name: 'Selected clip', startFrame: 120,
    durationFrames: 60, sourceInFrame: 7, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 0.7,
    versionId: id(7), shotId: id(8), jobId: id(9), fadeInFrames: 5};
  return {id: id(1), projectId: id(2), revision: 4, fps: 30, width: 720, height: 1280, tracks,
    clips: [clip, {...clip, id: id(10), name: 'PRIVATE_OTHER_CLIP', startFrame: 0, durationFrames: 30},
      {...clip, id: id(11), trackId: id(4), name: 'PRIVATE_SECOND_CLIP', startFrame: 300, durationFrames: 120}],
    durationFrames: 420, createdAt: timestamp, updatedAt: timestamp};
}
const source = () => ({id: id(6), sha256: 'a'.repeat(64), mimeType: 'video/mp4', hasAudio: true});
const target = () => agentTimelineGainTargetFromTimeline(saved(), id(5), source());
function proposal(status = 'pending') {
  const selected = target();
  return {id: id(20), projectId: id(2), runId: id(21), runStatus: 'completed', digest: 'b'.repeat(64), status,
    operation: 'timeline.clip.update', target: agentTimelineGainPublicTarget(selected), patch: {gain: 0.4},
    diff: agentTimelineGainDiff(selected, {gain: 0.4}), provenance: {runId: id(21), toolCallId: 'call_gain', toolName: AGENT_TIMELINE_GAIN_TOOL},
    createdAt: timestamp, updatedAt: timestamp,
    ...(!['pending', 'rejected', 'cancelled'].includes(status) ? {approval: {requestId: id(22), approvedAt: timestamp}} : {}),
    ...(status === 'applied' ? {outcome: {status: 'applied', timelineId: id(1), clipId: id(5), revision: 5}} : {}),
    ...(status === 'failed' ? {outcome: {status: 'not_applied', code: 'REVISION_CONFLICT'}} : {})};
}

test('new typed leaf and real barrel expose a closed gain contract without changing public operations', () => {
  assert.equal(AGENT_TIMELINE_GAIN_CONTEXT, 'selected_timeline_clip_gain');
  assert.equal(AGENT_TIMELINE_GAIN_PROVENANCE, 'project_selected_timeline_audio_gain');
  assert.equal(AGENT_TIMELINE_GAIN_TOOL, 'mioon_propose_timeline_clip_gain');
  assert.equal(AGENT_TIMELINE_GAIN_DEFINITION_VERSION, 3);
  assert.deepEqual(AGENT_TIMELINE_GAIN_LIMITS, {minGain: 0, maxGain: 2, targetBytes: 16384, proposalBytes: 16384});
  assert.equal(leaf.isAgentTimelineGainArguments, isAgentTimelineGainArguments);
  assert.equal(leaf.isAgentTimelineGainPublicTarget, isAgentTimelineGainPublicTarget);
  const typed = createAgentTimelineGainContracts({isTimelineRecord, hasRequestNotAppliedProof});
  assert.ok(Object.isFrozen(typed));
  assert.deepEqual(typed.agentTimelineGainTargetFromTimeline(saved(), id(5), source()), target());
  assert.ok(typed.isAgentTimelineGainProposal(proposal('failed')));
  assert.throws(() => createAgentTimelineGainContracts({} as unknown as Parameters<typeof createAgentTimelineGainContracts>[0]), TypeError);
  assert.deepEqual(Object.keys(schemas).filter(key => key.includes('agent') || key.includes('gain') || key.includes('model')).sort(),
    ['agent.authorization.grant', 'agent.authorization.list', 'agent.authorization.revoke']);
  assert.ok(schemas['timeline.clip.update'].safeParse({projectId: id(2), clipId: id(5), expectedRevision: 4, requestId: id(22), patch: {gain: 0.4}}).success);
});

test('gain arguments retain exact finite multipliers and reject coercion, negative zero or wider patches', () => {
  for (const gain of [0, 0.4, 1, 2, Number.MIN_VALUE, 0.12345678912345678] as const) {
    const value = {gain}; assert.equal(isAgentTimelineGainArguments(value), true);
    assert.ok(Object.is(value.gain, gain)); assert.equal(isAgentTimelineMoveArguments(value), false);
  }
  for (const value of [null, [], {}, {gain: -0}, {gain: -1}, {gain: 2.000000000000001}, {gain: NaN}, {gain: Infinity},
    {gain: -Infinity}, {gain: null}, {gain: '0.4'}, {gain: true}, {gain: undefined}, {gain: [0.4]},
    {gain: 0.4, startFrame: 1}, {gain: 0.4, muted: false}, {gain: 0.4, fadeInFrames: 1},
    {gain: 0.4, assetId: id(6)}, {gain: 0.4, requestId: id(22)}, {gain: 0.4, operation: 'timeline.clip.update'},
    {gain: 0.4, ignored: undefined}, {startFrame: 30}, Object.assign(Object.create({}), {gain: 0.4})] as const)
    assert.equal(isAgentTimelineGainArguments(value), false, String(value));
});

test('source eligibility requires exact saved audio metadata and supported audio/video fingerprint', () => {
  for (const mimeType of ['video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'] as const)
    assert.ok(isAgentTimelineGainSource({...source(), mimeType}));
  for (const value of [{...source(), hasAudio: false}, {...source(), hasAudio: null}, {...source(), hasAudio: 1},
    {id: id(6), sha256: 'a'.repeat(64), mimeType: 'video/mp4'}, {...source(), mimeType: 'image/png'},
    {...source(), mimeType: 'audio/ogg'}, {...source(), sha256: 'A'.repeat(64)}, {...source(), sha256: 'a'.repeat(63)},
    {...source(), relativePath: '/PRIVATE'}, {...source(), projectId: id(2)}] as const) assert.equal(isAgentTimelineGainSource(value), false);
  const audio = saved(); audio.tracks[0].kind = 'audio';
  assert.ok(agentTimelineGainTargetFromTimeline(audio, id(5), {...source(), mimeType: 'audio/wav'}));
  assert.equal(agentTimelineGainTargetFromTimeline(audio, id(5), source()), null);
  assert.equal(agentTimelineGainTargetFromTimeline(saved(), id(5), {...source(), mimeType: 'audio/wav'}), null);
  const hidden = saved(); hidden.tracks[0].hidden = true; hidden.tracks[0].muted = true;
  const selected = agentTimelineGainTargetFromTimeline(hidden, id(5), source());
  assert.ok(selected); assert.equal(agentTimelineGainReviewTarget(selected)!.trackMuted, true);
  assert.equal(agentTimelineGainModelContext(selected)!.track.muted, true);
});

test('private projection preserves complete optional clip fields and source metadata without mutation', () => {
  const timeline = saved(), media = source(), original = JSON.stringify(timeline), mediaOriginal = JSON.stringify(media);
  const selected = agentTimelineGainTargetFromTimeline(timeline, id(5), media);
  assert.ok(isAgentTimelineGainTarget(selected, {projectId: id(2)}));
  assert.equal(isAgentTimelineGainTarget(selected, {projectId: id(99)}), false);
  assert.equal(isAgentTimelineMoveTarget(selected), false);
  assert.deepEqual(selected.clip, timeline.clips[0]); assert.deepEqual(selected.track, timeline.tracks[0]);
  assert.deepEqual(selected.source, media); assert.equal(Object.hasOwn(selected.clip, 'fadeOutFrames'), false);
  assert.equal(selected.durationFrames, 420); selected.clip.rect.width = 2; (selected.source as unknown as {sha256: string}).sha256 = 'f'.repeat(64);
  assert.equal(JSON.stringify(timeline), original); assert.equal(JSON.stringify(media), mediaOriginal);
  assert.equal(agentTimelineGainTargetFromTimeline(timeline, id(99), media), null);
  assert.equal(agentTimelineGainTargetFromTimeline(timeline, id(5), {...media, id: id(99)}), null);
  const invalidOther = saved(); (invalidOther.clips[2] as unknown as {sourcePath: unknown}).sourcePath = '/PRIVATE';
  assert.equal(agentTimelineGainTargetFromTimeline(invalidOther, id(5), media), null);
  const invalidDuration = saved(); invalidDuration.durationFrames++;
  assert.equal(agentTimelineGainTargetFromTimeline(invalidDuration, id(5), media), null);
});

test('private target uses canonical clip/track/format validity and exact bounded source fields', () => {
  const modifications = [(value: { clip: { durationFrames: number; }; }) => { value.clip.durationFrames = 0; }, (value: { clip: { sourceInFrame: number; }; }) => { value.clip.sourceInFrame = -1; },
(    value: { clip: { rect: { width: number; }; }; }) => { value.clip.rect.width = 719; }, (value: { clip: { rect: { width: number; }; }; }) => { value.clip.rect.width = 1280; }, (value: { clip: { fadeOutFrames: number; }; }) => { value.clip.fadeOutFrames = 60; },
(    value: { clip: { assetId: string; }; }) => { value.clip.assetId = id(99); }, (value: { clip: { sourcePath: string; }; }) => { value.clip.sourcePath = '/PRIVATE'; }, (value: { clip: { gain: number; }; }) => { value.clip.gain = 3; },
(    value: { track: { hidden: boolean; kind: string; }; }) => { value.track.hidden = true; value.track.kind = 'audio'; }, (value: { track: { kind: string; }; }) => { value.track.kind = 'subtitle'; },
(    value: { track: { id: string; }; }) => { value.track.id = id(99); }, (value: { track: { relativePath: string; }; }) => { value.track.relativePath = '/PRIVATE'; }, (value: { fps: number; }) => { value.fps = 60; },
(    value: { width: number; height: number; }) => { value.width = 1920; value.height = 1080; }, (value: { durationFrames: number; }) => { value.durationFrames = 179; }, (value: { durationFrames: number; }) => { value.durationFrames = 18001; },
(    value: { subtitleText: string; }) => { value.subtitleText = 'PRIVATE'; }, (value: { expectedRevision: number; }) => { value.expectedRevision = Number.MAX_SAFE_INTEGER; },
(    value: { clip: { startFrame: number; }; }) => { value.clip.startFrame = 18000; }, (value: { source: { hasAudio: boolean; }; }) => { value.source.hasAudio = false; }, (value: { source: { hasAudio: unknown; }; }) => { delete value.source.hasAudio; },
(    value: { source: { sha256: string; }; }) => { value.source.sha256 = ''; }, (value: { source: { mimeType: string; }; }) => { value.source.mimeType = 'image/png'; }, (value: { source: { secret: string; }; }) => { value.source.secret = 'x'; },
(    value: { clip: { name: string; }; }) => { value.clip.name = 'x'.repeat(16385); }, (value: { occupiedIntervals: never[]; }) => { value.occupiedIntervals = []; }];
  for (const modify of modifications) { const selected = target(); modify((selected! as unknown as MutationInput<typeof modify>)); assert.equal(isAgentTimelineGainTarget(selected), false, modify.toString()); }
  for (const [width, height] of [[720,1280], [1280,720], [720,720]] as const) {
    const timeline = saved(); Object.assign(timeline, {width,height});
    timeline.clips.forEach(clip => Object.assign(clip.rect, {width,height}));
    const selected = agentTimelineGainTargetFromTimeline(timeline, id(5), source());
    assert.ok(selected); assert.ok(timelineOutputPreset(selected)); assert.ok(isAgentTimelineGainPublicTarget(agentTimelineGainPublicTarget(selected)));
  }
});

test('private, public and review targets share six exact native/legacy output pairs without changing saved data', () => {
  const formats = [[1080,1920], [1920,1080], [1080,1080], [720,1280], [1280,720], [720,720]];
  const freeze = <T>(value: T) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  for (const [width, height] of formats) {
    const timeline = saved(); Object.assign(timeline, {width,height});
    timeline.clips.forEach(clip => Object.assign(clip.rect, {width,height}));
    freeze(timeline);
    const original = JSON.stringify(timeline), selected = agentTimelineGainTargetFromTimeline(timeline, id(5), source());
    assert.ok(selected, `${width}x${height}: private target`);
    const publicTarget = freeze(agentTimelineGainPublicTarget(selected)), review = freeze(agentTimelineGainReviewTarget(selected));
    const publicBytes = JSON.stringify(publicTarget), reviewBytes = JSON.stringify(review);
    assert.ok(isAgentTimelineGainTarget(selected));
    assert.ok(isAgentTimelineGainPublicTarget(publicTarget, {projectId: id(2)}));
    assert.ok(isAgentTimelineGainReviewTarget(review, {projectId: id(2)}));
    assert.deepEqual([publicTarget.fps,publicTarget.width,publicTarget.height], [30,width,height]);
    assert.deepEqual([review.fps,review.width,review.height], [30,width,height]);
    assert.equal(JSON.stringify(timeline), original);
    assert.equal(JSON.stringify(publicTarget), publicBytes); assert.equal(JSON.stringify(review), reviewBytes);
  }
  const selected = target(), publicTarget = agentTimelineGainPublicTarget(selected), review = agentTimelineGainReviewTarget(selected);
  const invalid = [
    {width:1080,height:1919}, {width:1079,height:1920}, {width:1919,height:1080}, {width:1920,height:1081},
    {width:720,height:1279}, {width:1279,height:720}, {width:720,height:1080}, {width:1080,height:720},
    {width:1280,height:1080}, {width:1080,height:1280}, {width:1920,height:1920}, {width:2160,height:3840},
    {width:960,height:540}, {width:0,height:0}, {width:1080.5,height:1920}, {width:'1080',height:1920},
    {width:1080,height:'1920'}, {fps:24}, {fps:60}, {fps:29.97}, {fps:'30'},
  ];
  for (const geometry of invalid) {
    const privateValue = freeze({...clone(selected), ...geometry}), publicValue = freeze({...publicTarget, ...geometry}),
      reviewValue = freeze({...review, ...geometry});
    const bytes = [privateValue,publicValue,reviewValue].map(value => JSON.stringify(value));
    assert.equal(isAgentTimelineGainTarget(privateValue), false, JSON.stringify(geometry));
    assert.equal(isAgentTimelineGainPublicTarget(publicValue), false, JSON.stringify(geometry));
    assert.equal(isAgentTimelineGainReviewTarget(reviewValue), false, JSON.stringify(geometry));
    assert.deepEqual([privateValue,publicValue,reviewValue].map(value => JSON.stringify(value)), bytes);
  }
});

test('direct guards never invoke getters and reject hidden, symbol, prototype and non-JSON data', () => {
  let invoked = 0;
  for (const guard of [isAgentTimelineGainArguments, isAgentTimelineGainSource, isAgentTimelineGainTarget,
    isAgentTimelineGainPublicTarget, isAgentTimelineGainReviewTarget, isAgentTimelineGainProposal] as const) {
    const value = {}; Object.defineProperty(value, 'gain', {enumerable: true, get() { invoked++; return 1; }});
    assert.equal(guard(value), false);
  }
  const getter = target(); Object.defineProperty(getter!.clip, 'gain', {enumerable: true, get() { invoked++; return 1; }});
  assert.equal(isAgentTimelineGainTarget(getter), false); assert.equal(invoked, 0);
  const symbol = target(); (symbol!.source as unknown as Record<PropertyKey,unknown>)[Symbol('private')] = true; assert.equal(isAgentTimelineGainTarget(symbol), false);
  const hidden = target(); Object.defineProperty(hidden!.clip, 'private', {value: true}); assert.equal(isAgentTimelineGainTarget(hidden), false);
  const inherited = target(); Object.setPrototypeOf(inherited!.source, {private: true}); assert.equal(isAgentTimelineGainTarget(inherited), false);
  const cycle = target(); (cycle!.clip as unknown as {rect: unknown}).rect = cycle; assert.equal(isAgentTimelineGainTarget(cycle), false);
  const malformed = target(); (malformed!.clip as unknown as {name: string}).name = '\ud800'; assert.equal(isAgentTimelineGainTarget(malformed), false);
  const sparse = saved(); sparse.clips = new Array(1); assert.equal(agentTimelineGainTargetFromTimeline(sparse, id(5), source()), null);
  const extended = saved(); (extended.clips as unknown as {private: unknown}).private = true; assert.equal(agentTimelineGainTargetFromTimeline(extended, id(5), source()), null);
  const throwing = createAgentTimelineGainContracts({isTimelineRecord() { throw Error('bad'); }, hasRequestNotAppliedProof});
  assert.equal(throwing.isAgentTimelineGainTarget(target()), false);
  assert.equal(throwing.agentTimelineGainTargetFromTimeline(saved(), id(5), source()), null);
});

test('public review and model projection disclose exactly the selected approved data', () => {
  const selected = target(), publicTarget = agentTimelineGainPublicTarget(selected), review = agentTimelineGainReviewTarget(selected);
  assert.deepEqual(publicTarget, {projectId: id(2), timelineId: id(1), clipId: id(5), trackId: id(3), expectedRevision: 4,
    clipName: 'Selected clip', trackName: 'Selected track', trackKind: 'video', fps: 30, width: 720, height: 1280,
    trackMuted: false, hasAudio: true});
  assert.deepEqual(review, {...publicTarget, gain: 0.7});
  assert.ok(isAgentTimelineGainPublicTarget(publicTarget, {projectId: id(2)}));
  assert.ok(isAgentTimelineGainReviewTarget(review, {projectId: id(2)}));
  assert.equal(isAgentTimelineGainPublicTarget(review), false); assert.equal(isAgentTimelineGainReviewTarget(publicTarget), false);
  for (const invalid of [{...review, gain: '0.7'}, {...review, gain: 3}, {...review, hasAudio: false}, {...review, trackMuted: null},
    {...review, source: source()}, {...review, assetId: id(6)}, {...review, startFrame: 120}] as const) assert.equal(isAgentTimelineGainReviewTarget(invalid), false);
  assert.equal(isAgentTimelineGainReviewTarget(review, {projectId: id(99)}), false);
  const model = agentTimelineGainModelContext(selected), bytes = JSON.stringify(model);
  assert.deepEqual(model, {clip: {name: 'Selected clip', gain: 0.7}, track: {name: 'Selected track', kind: 'video', muted: false}, hasAudio: true, minGain: 0, maxGain: 2});
  for (let index = 1; index <= 11; index++) assert.equal(bytes.includes(id(index)), false);
  for (const secret of ['PRIVATE', 'sha256', 'assetId', 'sourceInFrame', 'versionId', 'shotId', 'jobId', 'rect', 'fadeInFrames', 'durationFrames', 'expectedRevision'] as const)
    assert.equal(bytes.includes(secret), false, secret);
  (model.clip as unknown as {gain: number}).gain = 2; assert.equal(selected!.clip.gain, 0.7);
  assert.equal(agentTimelineGainModelContext({...selected, private: true}), null);
  assert.equal(agentTimelineGainPublicTarget({...selected, private: true}), null);
});

test('one-field exact diff rejects unchanged gain while leaving manual gain contract unchanged', () => {
  const selected = target(), original = JSON.stringify(selected);
  for (const gain of [0, 0.4, 1, 2, 0.12345678912345678, Number.MIN_VALUE] as const)
    assert.deepEqual(agentTimelineGainDiff(selected, {gain}), {before: {gain: 0.7}, after: {gain}});
  assert.equal(agentTimelineGainDiff(selected, {gain: 0.7}), null);
  assert.equal(agentTimelineGainDiff(selected, {gain: -0}), null);
  assert.equal(agentTimelineGainDiff(selected, {gain: 0.4, muted: false}), null);
  assert.equal(agentTimelineGainDiff(selected, {startFrame: 30}), null);
  assert.equal(JSON.stringify(selected), original);
  assert.ok(schemas['timeline.clip.update'].safeParse({projectId: id(2), clipId: id(5), expectedRevision: 4, requestId: id(22), patch: {gain: 0.7}}).success);
  (selected!.clip as unknown as {gain: number}).gain = 0; assert.equal(agentTimelineGainDiff(selected, {gain: 0}), null);
  assert.deepEqual(agentTimelineGainDiff(selected, {gain: 1}), {before: {gain: 0}, after: {gain: 1}});
});

test('strict public proposal union distinguishes gain provenance and every approval/outcome status', () => {
  for (const status of ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'] as const) {
    const value = proposal(status), original = JSON.stringify(value);
    assert.ok(isAgentTimelineGainProposal(value, {projectId: id(2)}), status);
    assert.equal(isAgentTimelineMoveProposal(value), false); assert.equal(JSON.stringify(value), original);
  }
  assert.equal(isAgentTimelineGainProposal(proposal(), {projectId: id(99)}), false);
  const modifications = [(value: { operation: string; }) => { value.operation = 'shot.update'; }, (value: { projectId: string; }) => { value.projectId = id(99); },
(    value: { target: { assetId: string; }; }) => { value.target.assetId = id(6); }, (value: { target: { hasAudio: boolean; }; }) => { value.target.hasAudio = false; }, (value: { target: { trackMuted: unknown; }; }) => { delete value.target.trackMuted; },
(    value: { patch: { startFrame: number; }; }) => { value.patch.startFrame = 30; }, (value: { patch: { gain: number; }; }) => { value.patch.gain = -0; }, (value: { patch: { gain: string; }; }) => { value.patch.gain = '0.4'; },
(    value: { diff: { after: { gain: number; }; }; }) => { value.diff.after.gain = 0.5; }, (value: { diff: { before: { startFrame: number; }; }; }) => { value.diff.before.startFrame = 120; },
(    value: { patch: { gain: number; }; diff: { after: { gain: number; }; }; }) => { value.patch.gain = 0.7; value.diff.after.gain = 0.7; }, (value: { provenance: { toolName: string; }; }) => { value.provenance.toolName = 'mioon_propose_timeline_clip_move'; },
(    value: { provenance: { toolName: string; }; }) => { value.provenance.toolName = 'mioon_propose_shot_update'; }, (value: { provenance: { runId: string; }; }) => { value.provenance.runId = id(99); },
(    value: { provenance: { toolCallId: string; }; }) => { value.provenance.toolCallId = 'call bad'; }, (value: { target: { expectedRevision: number; }; }) => { value.target.expectedRevision = Number.MAX_SAFE_INTEGER; },
(    value: { approval: { requestId: string; approvedAt: string; }; }) => { value.approval = {requestId: id(22), approvedAt: timestamp}; }, (value: { sourcePath: string; }) => { value.sourcePath = '/PRIVATE'; },
(    value: { outcome: { status: string; timelineId: string; clipId: string; revision: number; }; }) => { value.outcome = {status: 'applied', timelineId: id(1), clipId: id(5), revision: 5}; }];
  for (const modify of modifications) { const value = proposal(); modify((value! as unknown as MutationInput<typeof modify>)); assert.equal(isAgentTimelineGainProposal(value), false, modify.toString()); }
  const running = proposal('approved'); running.runStatus = 'running'; assert.equal(isAgentTimelineGainProposal(running), false);
  for (const key of ['timelineId', 'clipId'] as const) { const value = proposal('applied'); ((value.outcome! as unknown as Record<PropertyKey,unknown>))[key] = id(99); assert.equal(isAgentTimelineGainProposal(value), false); }
  const revision = proposal('applied'); (revision.outcome! as unknown as {revision: number}).revision = 6; assert.equal(isAgentTimelineGainProposal(revision), false);
  for (const reason of ['NOT_FOUND', 'UNAUTHORIZED', 'NETWORK', 'PRIVATE', 'AGENT_EDIT_CONFLICT'] as const) {
    const value = proposal('failed'); value.outcome!.code = reason; assert.equal(isAgentTimelineGainProposal(value), false, reason);
  }
  for (const status of ['approved', 'dispatching', 'unknown', 'applied', 'failed'] as const) {
    const value = proposal(status); delete value.approval; assert.equal(isAgentTimelineGainProposal(value), false);
  }
});

test('gain additions preserve exact legacy move contract and shot/move policy module bytes', () => {
  const expected = {
    '../packages/contracts/src/agent-timeline-move.ts': 'dc310eab7c6db5c17018980c6cc9cc74076c630dc2858bdaadf4413870724477',
    '../packages/business/src/agent/timeline-edit-tool-policy.ts': '47f82bbf738b680fc823fd194add6189ed1636b44794c150e7475b11a8c7af68',
    '../packages/business/src/agent/edit-tool-policy.ts': '43cc2f69e58cd2c5b1cac3ecbb56e39d12d73f7e7bfc0ab49c1580c956faf3a4',
  };
  for (const [path, hash] of Object.entries(expected))
    assert.equal(createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex'), hash, path);
});
