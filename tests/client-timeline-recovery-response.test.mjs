import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TIMELINE_MUTATION_OPERATIONS, isTimelineRecord, isTimelineReplacementResponse, TIMELINE_RESPONSE_BYTES, TIMELINE_REPLACEMENT_RESPONSE_BYTES, isTimelineMutationResponse, isTimelineRenderRecord, hasRequestNotAppliedProof} from '@mioon/contracts';
import {createClient} from '@mioon/client';
import {TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES} from '@mioon/contracts/timeline-loudness-apply';
import {loudnessApplyFixture} from './fixtures/timeline-loudness-apply.mjs';

const env = {MIOON_TOKEN: 'synthetic-timeline-recovery-token'};
const clone = value => structuredClone(value);
const response = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json'}});
const success = value => response({ok: true, data: value});
const rect = () => ({x: 0, y: 0, width: 720, height: 1280});
const loudnessApply = await loudnessApplyFixture();
function fixture(operation, {empty = false, fades = {}} = {}) {
  if (operation === 'timeline.loudness.apply') return {input: clone(loudnessApply.input), value: clone(loudnessApply.response)};
  const input = {projectId: randomUUID(), expectedRevision: 7, requestId: randomUUID()};
  if(operation==='timeline.format.set')empty=true;
  const trackId = randomUUID(), clipId = randomUUID(), assetId = randomUUID();
  const value = {id: randomUUID(), projectId: input.projectId, revision: 8, fps: 30, width: 720, height: 1280,
    tracks: [{id: trackId, name: 'Video 1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: empty ? [] : [{id: clipId, trackId, assetId, name: 'Fixed source', startFrame: 0, durationFrames: 90, sourceInFrame: 0, rect: rect(), gain: 1, ...fades}],
    durationFrames: empty ? 0 : 90, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:01.000Z'};
  switch (operation) {
    case 'timeline.format.set': Object.assign(input,{expectedProjectRevision:3,presetId:'landscape_720'});value.width=1280;value.height=720;break;
    case 'timeline.subtitle.add': Object.assign(input,{text:'字幕 added',startFrame:0,durationFrames:30});value.subtitles={profileId:'bottom_cjk_v1',cues:[{id:randomUUID(),text:input.text,startFrame:0,durationFrames:30}]};break;
    case 'timeline.subtitle.update': Object.assign(input,{cueId:randomUUID(),patch:{text:'字幕 changed'}});value.subtitles={profileId:'bottom_cjk_v1',cues:[{id:input.cueId,text:input.patch.text,startFrame:0,durationFrames:30}]};break;
    case 'timeline.subtitle.remove': input.cueId=randomUUID();value.subtitles={profileId:'bottom_cjk_v1',cues:[]};break;
    case 'timeline.track.add': input.kind = 'video'; break;
    case 'timeline.track.update': Object.assign(input, {trackId, patch: {name: 'Renamed', muted: true}}); Object.assign(value.tracks[0], input.patch); break;
    case 'timeline.clip.add': Object.assign(input, {assetId, trackId, startFrame: 0, durationFrames: 90, ...fades}); break;
    case 'timeline.clip.update': Object.assign(input, {clipId, patch: {name: 'Updated', gain: 0.5, rect: {x: 100, y: 200, width: 400, height: 600}}}); Object.assign(value.clips[0], clone(input.patch)); break;
    case 'timeline.clip.replaceSource': Object.assign(input, {clipId, assetId}); break;
    case 'timeline.clip.remove':
    case 'timeline.clip.rippleRemove': input.clipId = randomUUID(); break;
    case 'timeline.clip.split': {
      Object.assign(input, {clipId, atFrame: 30});
      const left = value.clips[0], right = {...clone(left), id: randomUUID(), startFrame: 30, durationFrames: 60, sourceInFrame: 30};
      left.durationFrames = 30;
      if (Object.hasOwn(left, 'fadeInFrames')) right.fadeInFrames = 0;
      if (Object.hasOwn(left, 'fadeOutFrames')) left.fadeOutFrames = 0;
      value.clips.push(right); break;
    }
    case 'timeline.render': {
      input.purpose = 'export'; value.revision = input.expectedRevision;
      return {input, value: {id: randomUUID(), projectId: input.projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose,
        timelineRevision: input.expectedRevision, snapshot: {timeline: value, assets: [{id: assetId, sha256: 'a'.repeat(64), mimeType: 'video/mp4', duration: 3, width: 720, height: 1280}]},
        status: 'queued', assetId: null, url: null, error: null, createdAt: value.createdAt, updatedAt: value.updatedAt}};
    }
  }
  return {input, value};
}
const frozen = value => {
  if (value && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);}
  return value;
};

test('the strict timeline acknowledgement allowlist covers exactly the seventeen replay-keyed operations', () => {
  assert.deepEqual([...TIMELINE_MUTATION_OPERATIONS].sort(), [
    'timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update', 'timeline.clip.replaceSource',
    'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.clip.split', 'timeline.seed', 'timeline.undo', 'timeline.redo', 'timeline.render', 'timeline.format.set',
    'timeline.subtitle.add', 'timeline.subtitle.update', 'timeline.subtitle.remove',
    'timeline.loudness.apply',
  ].sort());
  assert.ok(Object.isFrozen(TIMELINE_MUTATION_OPERATIONS));
  const {input, value} = fixture('timeline.undo');
  for (const operation of ['timeline.get', 'timeline.format.get', 'timeline.history.get', 'timeline.export.preflight', 'export.create', 'reference.attach']) assert.equal(isTimelineMutationResponse(operation, input, value), false);
});

test('all seventeen complete historical acknowledgements validate without edits, defaults or array sorting', async () => {
  for (const operation of TIMELINE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation), before = clone(value), seen = [];
    frozen(input); frozen(value);
    assert.equal(isTimelineMutationResponse(operation, input, value), true, operation);
    const client = createClient({env, fetchImpl: async (_url, options) => {seen.push(JSON.parse(options.body)); return success(value);}});
    assert.deepEqual(await client.rpc(operation, input), before);
    assert.deepEqual(await client.rpc(operation, input), before);
    assert.deepEqual(seen, [{operation, input}, {operation, input}], 'only explicit replay sends another request');
    assert.deepEqual(value, before);
  }
});

test('timeline acknowledgements reject malformed input identity without interpreting a result as another operation', () => {
  for (const operation of TIMELINE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation);
    const bad = [null, {}, [], {...input, projectId: 'wrong'}, {...input, requestId: 'short'}, {...input, expectedRevision: NaN}, {...input, expectedRevision: 0}, {...input, extra: true}];
    for (const invalid of bad) assert.equal(isTimelineMutationResponse(operation, invalid, value), false, operation);
    for (const key of Object.keys(input).filter(key => !['patch'].includes(key))) {
      const invalid = {...input}; delete invalid[key];
      assert.equal(isTimelineMutationResponse(operation, invalid, value), false, `${operation}:${key}`);
    }
  }
  const {input, value} = fixture('timeline.clip.add');
  for (const key of ['trackId', 'assetId', 'startFrame', 'durationFrames']) assert.equal(isTimelineMutationResponse('timeline.clip.add', {...input, [key]: undefined}, value), false);
});

test('format acknowledgements alone accept explicit timeline absence and bind the selected preset',()=>{
  const {input,value}=fixture('timeline.format.set');input.expectedRevision=0;value.revision=1;
  assert.equal(isTimelineMutationResponse('timeline.format.set',input,value),true);
  for(const change of [{expectedProjectRevision:0},{presetId:'portrait_720'},{presetId:'custom'}, {expectedRevision:-1}])
    assert.equal(isTimelineMutationResponse('timeline.format.set',{...input,...change},value),false);
  assert.equal(isTimelineMutationResponse('timeline.format.set',input,{...value,clips:[{}]}),false);
});

test('empty timelines are valid for track edits, removals, undo and redo, while replacement, seed and render require content', () => {
  for (const operation of ['timeline.track.add', 'timeline.track.update', 'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.undo', 'timeline.redo', 'timeline.format.set']) {
    const {input, value} = fixture(operation, {empty: true});
    assert.equal(isTimelineRecord(value, {projectId: input.projectId}), true);
    assert.equal(isTimelineMutationResponse(operation, input, value), true, operation);
    value.durationFrames = 1; assert.equal(isTimelineMutationResponse(operation, input, value), false);
  }
  for (const operation of ['timeline.clip.replaceSource', 'timeline.seed', 'timeline.render']) {
    const {input, value} = fixture(operation, {empty: true});
    assert.equal(isTimelineMutationResponse(operation, input, value), false);
  }
});

test('timeline shape rejects malformed complete records across every mutation and preserves exact recovery identity', async () => {
  for (const operation of TIMELINE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation);
    const edit = callback => {const result = clone(value); callback(operation === 'timeline.render' ? result.snapshot.timeline : operation === 'timeline.loudness.apply' ? result.timeline : result); return result;};
    const bad = [null, [], {}, 4, 'timeline',
      ...(operation === 'timeline.loudness.apply' ? [clone(value.timeline), {...clone(value), projectId: input.projectId}] : []),
      edit(v => delete v.id), edit(v => v.id = 'bad'), edit(v => v.projectId = randomUUID()), edit(v => v.revision++),
      edit(v => v.fps = 24), edit(v => v.durationFrames++), edit(v => v.updatedAt = 'invalid'),
      edit(v => v.tracks = []), edit(v => v.tracks.push(clone(v.tracks[0]))),
      edit(v => v.extra = true), edit(v => v.tracks[0].name = 'x'.repeat(151)),
      ...(operation==='timeline.format.set' ? [
        edit(v => v.width=720), // Supported square dimensions still mismatch this request.
        edit(v => v.clips=null), edit(v => v.clips=[{}]),
        edit(v => {v.clips=[{id:randomUUID(),trackId:v.tracks[0].id,assetId:randomUUID(),name:'Unexpected content',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:v.width,height:v.height},gain:1}];v.durationFrames=30;}),
      ] : [
        edit(v => v.clips.push(clone(v.clips[0]))), edit(v => v.clips[0].trackId = randomUUID()),
        edit(v => v.clips[0].rect.x = 1), edit(v => v.clips[0].gain = '1'),
        edit(v => v.clips[0].fadeInFrames = 18000), edit(v => v.clips[0].jobId = 'wrong'),
        edit(v => v.clips = Array(101).fill(v.clips[0])),
      ])];
    for (const invalid of bad) {
      assert.equal(isTimelineMutationResponse(operation, input, invalid), false, operation);
      let calls = 0;
      const client = createClient({env, fetchImpl: async () => {calls++; return success(invalid);}});
      await assert.rejects(client.rpc(operation, input), error => {
        assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(error.details.operation, operation);
        assert.equal(error.details.requestId, input.requestId); assert.equal(error.details.submissionMayHaveSucceeded, true);
        assert.match(error.details.recovery, /exact original input.*same requestId/); return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('each mutation binds the caller-verifiable track, clip or source intent', () => {
  const changes = [
    ['timeline.loudness.apply', v => v.operation='timeline.clip.update'],
    ['timeline.loudness.apply', v => v.requestId=randomUUID()],
    ['timeline.loudness.apply', v => v.application.candidateDigest='timeline-loudness-candidate-v1:'+ 'f'.repeat(64)],
    ['timeline.loudness.apply', v => v.application.snapshotSha256='f'.repeat(64)],
    ['timeline.loudness.apply', v => v.application.beforeRevision++],
    ['timeline.loudness.apply', v => v.application.afterRevision++],
    ['timeline.loudness.apply', v => v.application.target.integratedLufs--],
    ['timeline.loudness.apply', v => v.timeline.clips[0].gain=1],
    ['timeline.format.set', v => v.width=720],
    ['timeline.subtitle.add', v => v.subtitles.cues[0].text='Wrong'],
    ['timeline.subtitle.add', v => v.subtitles.cues[0].startFrame=1],
    ['timeline.subtitle.update', v => v.subtitles.cues[0].id=randomUUID()],
    ['timeline.subtitle.update', v => v.subtitles.cues[0].text='Wrong'],
    ['timeline.subtitle.remove', (v,i) => v.subtitles.cues.push({id:i.cueId,text:'Retained',startFrame:0,durationFrames:30})],
    ['timeline.track.add', v => v.tracks[0].name = 'Unrelated name'],
    ['timeline.track.add', v => v.tracks[0].muted = true],
    ['timeline.track.update', v => v.tracks[0].id = randomUUID()],
    ['timeline.track.update', v => v.tracks[0].muted = false],
    ['timeline.clip.add', v => v.clips[0].assetId = randomUUID()],
    ['timeline.clip.add', v => v.clips[0].startFrame = 1],
    ['timeline.clip.add', v => v.clips[0].sourceInFrame = 1],
    ['timeline.clip.add', v => v.clips[0].fadeInFrames = 0],
    ['timeline.clip.add', v => v.clips[0].versionId = randomUUID()],
    ['timeline.clip.update', v => v.clips[0].id = randomUUID()],
    ['timeline.clip.update', v => v.clips[0].name = 'Ignored patch'],
    ['timeline.clip.update', v => v.clips[0].rect.width = 200],
    ['timeline.clip.replaceSource', v => v.clips[0].assetId = randomUUID()],
    ['timeline.clip.remove', (v, i) => v.clips[0].id = i.clipId],
    ['timeline.clip.rippleRemove', (v, i) => v.clips[0].id = i.clipId],
    ['timeline.clip.split', v => v.clips[0].durationFrames--],
    ['timeline.clip.split', v => v.clips[1].sourceInFrame++],
    ['timeline.clip.split', v => v.clips[1].assetId = randomUUID()],
    ['timeline.clip.split', v => v.clips[1].name = 'Unrelated right clip'],
  ];
  for (const [operation, change] of changes) {
    const {input, value} = fixture(operation); change(value, input);
    assert.equal(isTimelineMutationResponse(operation, input, value), false, operation);
  }
});

test('omitted fades and explicit zeros survive clip add/split validation unchanged', () => {
  for (const operation of ['timeline.clip.add', 'timeline.clip.split']) for (const fades of [{}, {fadeInFrames: 0}, {fadeOutFrames: 0}, {fadeInFrames: 10, fadeOutFrames: 10}]) {
    const {input, value} = fixture(operation, {fades}), before = clone(value);
    assert.equal(isTimelineMutationResponse(operation, input, value), true);
    assert.deepEqual(value, before);
    assert.equal(Object.hasOwn(value.clips[0], 'fadeInFrames'), Object.hasOwn(fades, 'fadeInFrames'));
  }
});

test('render recovery validates progressed statuses, fixed snapshot and optional legacy source fields', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed']) for (const optional of [{}, {hasAudio: null}, {hasAudio: true, relativePath: 'media/source.mp4'}]) {
    const {input, value} = fixture('timeline.render'); value.status = status;
    Object.assign(value.snapshot.assets[0], optional);
    if (status === 'failed') value.error = {code: 'EXPORT_FAILED', message: 'Synthetic failure', retryable: true};
    if (status === 'succeeded') {value.assetId = randomUUID(); value.url = `/media/${value.assetId}`;}
    const before = clone(value); frozen(value);
    assert.equal(isTimelineRenderRecord(value, input), true);
    assert.equal(isTimelineMutationResponse('timeline.render', input, value), true, 'legacy terminal receipts remain acknowledgements');
    assert.deepEqual(value, before);
    assert.equal(isTimelineRenderRecord(value, {...input, exportId: value.id, timelineId: value.snapshot.timeline.id}), true);
    assert.equal(isTimelineRenderRecord(value, {...input, exportId: randomUUID()}), false);
    assert.equal(isTimelineRenderRecord(value, {...input, timelineId: randomUUID()}), false);
  }
});

test('render acknowledgements reject wrong purpose, request, snapshot, source links, outputs and known-state violations', () => {
  const edits = [v => v.id = 'bad', v => v.projectId = randomUUID(), v => v.requestId = randomUUID(), v => v.mode = 'storyboard',
    v => v.purpose = 'preview', v => v.timelineRevision++, v => v.status = 'cancelled', v => v.status = 'invented',
    v => v.snapshot = {clips: []}, v => v.snapshot.timeline.projectId = randomUUID(), v => v.snapshot.timeline.revision++,
    v => v.snapshot.assets = [], v => v.snapshot.assets.push(clone(v.snapshot.assets[0])),
    v => v.snapshot.assets[0].id = randomUUID(), v => v.snapshot.assets[0].sha256 = 'hash',
    v => v.snapshot.assets[0].mimeType = 'audio/wav', v => v.snapshot.assets[0].duration = 1,
    v => v.snapshot.assets[0].width = null, v => v.snapshot.assets[0].hasAudio = 'true',
    v => v.snapshot.assets[0].relativePath = 0, v => v.snapshot.assets[0].extra = true,
    v => v.assetId = randomUUID(), v => v.url = 'https://example.invalid/source', v => v.error = 'failed',
    v => v.status = 'succeeded', v => v.status = 'failed',
  ];
  for (const edit of edits) {
    const {input, value} = fixture('timeline.render'); edit(value);
    assert.equal(isTimelineRenderRecord(value, input), false);
  }
});

test('frozen sources retain valid omitted dimensions and image duration without accepting invalid metadata', () => {
  const {input, value} = fixture('timeline.render');
  delete value.snapshot.assets[0].width; delete value.snapshot.assets[0].height;
  assert.equal(isTimelineRenderRecord(value, input), true);
  value.snapshot.assets[0].mimeType = 'image/png'; delete value.snapshot.assets[0].duration;
  assert.equal(isTimelineRenderRecord(value, input), true);
  value.snapshot.timeline.clips[0].sourceInFrame = 1;
  assert.equal(isTimelineRenderRecord(value, input), false);
});

test('proof validation requires exact identity and a known transaction rejection, never just a 4xx', () => {
  const operation = 'timeline.clip.update', {input} = fixture(operation);
  const error = {code: 'REVISION_CONFLICT', status: 409, details: {mutationOutcome: 'not_applied', requestId: input.requestId}};
  assert.equal(hasRequestNotAppliedProof(error, input, {operation}), true);
  assert.equal(hasRequestNotAppliedProof({...error, status: undefined, definitive: true}, input, {operation}), true);
  for (const code of ['UNAUTHORIZED', 'ORIGIN_REJECTED', 'NOT_FOUND', 'CROSS_PROJECT_REFERENCE', 'INVALID_VERSION', 'IDEMPOTENCY_CONFLICT', 'BACKEND_PROTOCOL_ERROR', 'INTERNAL_ERROR'])
    assert.equal(hasRequestNotAppliedProof({...error, code}, input, {operation}), false, code);
  for (const status of [200, 401, 403, 500, undefined]) assert.equal(hasRequestNotAppliedProof({...error, status}, input, {operation}), false);
  for (const details of [{}, {...error.details, requestId: randomUUID()}, {...error.details, operation: 'timeline.undo'}, {...error.details, projectId: randomUUID()}])
    assert.equal(hasRequestNotAppliedProof({...error, details}, input, {operation}), false);
  assert.equal(hasRequestNotAppliedProof({...error, details: {...error.details, operation, projectId: input.projectId}}, input, {operation}), true);
});

test('shared client keeps ambiguous timeline and reference errors bound to the original key without retry or forged proof', async () => {
  const calls = [];
  const timeline = fixture('timeline.clip.update').input;
  const cases = [
    ['timeline.clip.update', timeline],
    ['reference.attach', {projectId: randomUUID(), sourceNodeId: randomUUID(), targetShotId: randomUUID(), expectedSourceRevision: 1, expectedShotRevision: 1, requestId: randomUUID(), role: 'first_frame'}],
    ['reference.detach', {projectId: randomUUID(), edgeId: randomUUID(), expectedShotRevision: 1, requestId: randomUUID()}],
  ];
  for (const [operation, input] of cases) for (const [status, code, details] of [
    [400, 'INVALID_CLIP_TYPE', {}], [401, 'UNAUTHORIZED', {}], [403, 'ORIGIN_REJECTED', {}], [404, 'NOT_FOUND', {}],
    [409, 'IDEMPOTENCY_CONFLICT', {mutationOutcome: 'not_applied', requestId: input.requestId}],
    [409, 'REVISION_CONFLICT', {mutationOutcome: 'not_applied', requestId: 'wrong-request-id'}],
    [409, 'REVISION_CONFLICT', {mutationOutcome: 'not_applied', requestId: input.requestId, operation: 'unrelated.operation'}],
    [500, 'REVISION_CONFLICT', {mutationOutcome: 'not_applied', requestId: input.requestId}],
  ]) {
    const client = createClient({env, fetchImpl: async (_url, options) => {calls.push(JSON.parse(options.body)); return response({ok: false, error: {code, message: 'Synthetic rejection', details}}, status);}});
    const before = calls.length;
    await assert.rejects(client.rpc(operation, input), error => {
      assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.details.operation, operation);
      assert.equal(error.details.requestId, input.requestId); assert.equal(error.details.submissionMayHaveSucceeded, true);
      assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), false); assert.match(error.details.recovery, /exact original input/); return true;
    });
    assert.deepEqual(calls.slice(before), [{operation, input}]);
  }
});

test('shared client accepts exact backend no-application proof and preserves unrelated error policy', async () => {
  const operation = 'timeline.clip.update', {input} = fixture(operation);
  const proof = {mutationOutcome: 'not_applied', requestId: input.requestId};
  const client = createClient({env, fetchImpl: async () => response({ok: false, error: {code: 'REVISION_CONFLICT', message: 'Changed', details: proof}}, 409)});
  await assert.rejects(client.rpc(operation, input), error => {
    assert.equal(error.details.submissionMayHaveSucceeded, false); assert.equal(error.details.mutationOutcome, 'not_applied');
    assert.equal(error.details.requestId, input.requestId); assert.equal(Object.hasOwn(error.details, 'recovery'), false); return true;
  });
  await assert.rejects(client.rpc('shot.create', {projectId: input.projectId, title: 'Unrelated', requestId: input.requestId}), error => {
    assert.deepEqual(error.details, proof); return true;
  });
});


test('maximum escaped legacy names and subtitle cues fit the unified bounded acknowledgement', async () => {
  assert.equal(TIMELINE_RESPONSE_BYTES, 256 * 1024);
  assert.equal(TIMELINE_REPLACEMENT_RESPONSE_BYTES, TIMELINE_RESPONSE_BYTES);
  assert.equal(TIMELINE_LOUDNESS_APPLY_RESPONSE_BYTES, 320 * 1024, 'Only the apply envelope receives the larger cap');
  const {input, value} = fixture('timeline.undo');
  value.tracks = Array.from({length: 12}, (_, index) => ({id: randomUUID(), name: '\u0001'.repeat(150), kind: 'video', orderIndex: index, hidden: false, muted: false}));
  value.clips = Array.from({length: 100}, (_, index) => ({id: randomUUID(), trackId: value.tracks[index % 12].id, assetId: randomUUID(),
    name: '\u0000'.repeat(200), startFrame: index * 3, durationFrames: 3, sourceInFrame: Number.MAX_SAFE_INTEGER - 18000,
    rect: {x: 100, y: 200, width: 400, height: 600}, gain: 1.2345678901234567, fadeInFrames: 1, fadeOutFrames: 2,
    versionId: randomUUID(), shotId: randomUUID(), jobId: randomUUID()}));
  value.durationFrames = 300;
  value.subtitles = {profileId:'bottom_cjk_v1',cues:Array.from({length:100},(_,index)=>({id:randomUUID(),text:'字'.repeat(20)+'\n'+'幕'.repeat(20),startFrame:index*3,durationFrames:3}))};
  const target = value.clips[0];
  for (const key of ['versionId', 'shotId', 'jobId']) delete target[key];
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(bytes > 128 * 1024, `Escaped fixture exceeds the old cap: ${bytes}`);
  assert.ok(bytes < TIMELINE_RESPONSE_BYTES, `Complete schema-bounded shape fits the generic cap: ${bytes}`);
  const before = clone(value); frozen(value);
  assert.equal(isTimelineRecord(value, {projectId: input.projectId}), true);
  assert.equal(isTimelineMutationResponse('timeline.undo', input, value), true);
  assert.equal(isTimelineMutationResponse('timeline.redo', input, value), true);
  const replacement = {...input, clipId: target.id, assetId: target.assetId};
  assert.equal(isTimelineReplacementResponse(value, replacement), true);
  assert.equal(isTimelineMutationResponse('timeline.clip.replaceSource', replacement, value), true);
  let calls = 0;
  const client = createClient({env, fetchImpl: async () => {calls++; return success(value);}});
  assert.deepEqual(await client.rpc('timeline.undo', input), before);
  assert.equal(calls, 1);
  assert.deepEqual(value, before, 'Validation does not sanitize or rewrite the legacy response');
});
