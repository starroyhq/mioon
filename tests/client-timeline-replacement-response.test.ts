import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isTimelineReplacementResponse} from '@mioon/contracts';
import {createClient} from '@mioon/client';

const operation = 'timeline.clip.replaceSource';
const env = {MIOON_TOKEN: 'synthetic-replacement-response-token'};
interface ClipRect {x: number; y: number; width: number; height: number; [key: string]: unknown}
interface TimelineTrack {id: string; name: string; kind: string; orderIndex: number; hidden: unknown; muted: boolean; [key: string]: unknown}
interface TimelineClip {id: string; trackId: string; assetId: string; name: string; startFrame: number; durationFrames: number; sourceInFrame: number; rect: ClipRect; gain: unknown; [key: string]: unknown}
interface ReplacementTimeline {id: string; projectId: string; revision: number; fps: number; width: number; height: number; durationFrames: number; createdAt: string; updatedAt: string | null; tracks: TimelineTrack[]; clips: TimelineClip[]; [key: string]: unknown}
interface ReplacementInput {projectId: string; clipId: string; assetId: string; expectedRevision: number; requestId: string; versionId?: string; [key: string]: unknown}
interface ClientFailure {code?: string; details?: Record<string, unknown>}
const failureOf = (error: unknown): ClientFailure => error as ClientFailure;
const clone = <T>(value: T): T => structuredClone(value);
const response = (value: unknown): Response => ({ok: true, status: 200, json: async () => ({ok: true, data: value})} as unknown as Response);
function fixture({version = false, fades = {}}: {version?: boolean; fades?: Record<string, unknown>} = {}): {input: ReplacementInput; timeline: ReplacementTimeline} {
  const input = {projectId: randomUUID(), clipId: randomUUID(), assetId: randomUUID(), expectedRevision: 7, requestId: randomUUID(), ...(version ? {versionId: randomUUID()} : {})};
  const trackId = randomUUID();
  const timeline: ReplacementTimeline = {id: randomUUID(), projectId: input.projectId, revision: 8, fps: 30, width: 720, height: 1280, durationFrames: 100,
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:01.000Z',
    tracks: [{id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: input.clipId, trackId, assetId: input.assetId, name: 'Fixed source', startFrame: 20, durationFrames: 80, sourceInFrame: 17,
      rect: {x: 100, y: 200, width: 400, height: 600}, gain: 0.5, ...fades, ...(version ? {versionId: input.versionId, shotId: randomUUID()} : {})}]};
  return {input, timeline};
}
function malformed(timeline: ReplacementTimeline, input: ReplacementInput): unknown[] {
  const edit = (callback: (value: ReplacementTimeline) => void): ReplacementTimeline => {const value = clone(timeline); callback(value); return value;};
  return [null, {}, [], 42, 'timeline',
    ...Object.keys(timeline).map(key => edit(value => delete value[key])),
    edit(value => value.id = 'wrong'), edit(value => value.projectId = randomUUID()),
    ...[7, 9, '8', 8.5].map(revision => ({...timeline, revision})),
    edit(value => value.fps = 25), edit(value => value.width = 1080), edit(value => value.durationFrames--),
    edit(value => value.createdAt = 'invalid'), edit(value => value.updatedAt = null),
    edit(value => value.tracks = []), edit(value => value.clips = []), edit(value => value.clips = Array(101).fill(value.clips[0])),
    edit(value => value.tracks.push(clone(value.tracks[0]))), edit(value => value.clips.push(clone(value.clips[0]))),
    edit(value => value.tracks[0].kind = 'caption'), edit(value => value.tracks[0].orderIndex = 12),
    edit(value => value.tracks[0].hidden = 'false'), edit(value => value.tracks[0].name = 'x'.repeat(151)),
    edit(value => value.clips[0].id = randomUUID()), edit(value => value.clips[0].assetId = randomUUID()),
    edit(value => value.clips[0].trackId = randomUUID()), edit(value => value.clips[0].name = 'x'.repeat(201)),
    edit(value => value.clips[0].sourceInFrame = -1), edit(value => value.clips[0].durationFrames = 0),
    edit(value => value.clips[0].startFrame = 20.5), edit(value => value.clips[0].rect.x = 101),
    edit(value => value.clips[0].rect.width = 720), edit(value => value.clips[0].gain = '0.5'),
    edit(value => value.clips[0].fadeInFrames = 81), edit(value => {value.clips[0].fadeInFrames = 40; value.clips[0].fadeOutFrames = 41;}),
    edit(value => value.clips[0].fadeOutFrames = null), edit(value => value.clips[0].jobId = randomUUID()),
    edit(value => value.clips[0].versionId = randomUUID()), edit(value => value.clips[0].shotId = 'wrong'),
    edit(value => value.token = 'unrequested-data'), edit(value => value.clips[0].effects = []),
    edit(value => value.tracks[0].padding = 'x'.repeat(131072)),
    ...(input.versionId ? [edit(value => delete value.clips[0].versionId), edit(value => delete value.clips[0].shotId)] : [edit(value => value.clips[0].shotId = randomUUID())]),
  ];
}

test('replacement acknowledgement accepts legacy omitted fades, explicit zeros and exact optional provenance without normalization', () => {
  for (const version of [false, true]) for (const fades of [{}, {fadeInFrames: 0}, {fadeOutFrames: 0}, {fadeInFrames: 10, fadeOutFrames: 15}]) {
    const {input, timeline} = fixture({version, fades}), before = clone(timeline);
    assert.equal(isTimelineReplacementResponse(timeline, input), true);
    assert.deepEqual(timeline, before);
    // A neighbor may carry old explicit provenance independently of this edit.
    const neighbor = {...clone(timeline.clips[0]), id: randomUUID(), assetId: randomUUID(), startFrame: 120, durationFrames: 30, versionId: randomUUID(), shotId: randomUUID(), jobId: randomUUID()};
    timeline.clips.unshift(neighbor); timeline.durationFrames = 150;
    const order = timeline.clips.map(clip => clip.id);
    assert.equal(isTimelineReplacementResponse(timeline, input), true);
    assert.deepEqual(timeline.clips.map(clip => clip.id), order, 'validation never sorts or mutates caller arrays');
  }
});

test('replacement acknowledgement rejects malformed, mismatched or excessive full timelines and false provenance', () => {
  for (const version of [false, true]) {
    const {input, timeline} = fixture({version});
    for (const invalid of malformed(timeline, input)) assert.equal(isTimelineReplacementResponse(invalid, input), false, JSON.stringify(invalid)?.slice(0, 350));
    for (const invalidInput of [null, {}, {...input, expectedRevision: NaN}, {...input, expectedRevision: Number.MAX_SAFE_INTEGER}, {...input, versionId: null}]) assert.equal(isTimelineReplacementResponse(timeline, invalidInput), false);
    const overlap = clone(timeline); overlap.clips.push({...overlap.clips[0], id: randomUUID(), startFrame: 30}); overlap.durationFrames = 110;
    assert.equal(isTimelineReplacementResponse(overlap, input), false);
  }
});

test('shared client retains exact replacement recovery identity on malformed valid-JSON success and never retries', async () => {
  for (const version of [false, true]) {
    const {input, timeline} = fixture({version});
    for (const invalid of malformed(timeline, input)) {
      const seen: unknown[] = [], client = createClient({env, fetchImpl: (async (_url: string, options: {body?: string}) => {seen.push(JSON.parse(options.body!)); return response(invalid);}) as unknown as typeof fetch});
      await assert.rejects(client.rpc(operation, input), (error: unknown) => {
        const failure = failureOf(error);
        assert.equal(failure.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(failure.details?.operation, operation);
        assert.equal(failure.details?.requestId, input.requestId); assert.equal(failure.details?.submissionMayHaveSucceeded, true);
        assert.match(failure.details?.recovery as string, /exact original input/); return true;
      });
      assert.deepEqual(seen, [{operation, input}]);
    }
  }
});

test('shared client accepts historical exact replacement and legacy edit acknowledgements after explicit replay', async () => {
  for (const version of [false, true]) {
    const {input, timeline} = fixture({version}), seen: unknown[] = [];
    const client = createClient({env, fetchImpl: (async (_url: string, options: {body?: string}) => {seen.push(JSON.parse(options.body!)); return response(timeline);}) as unknown as typeof fetch});
    assert.deepEqual(await client.rpc(operation, input), timeline);
    assert.deepEqual(await client.rpc(operation, input), timeline);
    assert.deepEqual(seen, [{operation, input}, {operation, input}]);
  }
  const {input, timeline} = fixture(); timeline.clips[0].name = 'Legacy edit';
  const legacy = createClient({env, fetchImpl: (async () => response(timeline)) as unknown as typeof fetch});
  const {assetId, ...fields} = input;
  assert.deepEqual(await legacy.rpc('timeline.clip.update', {...fields, patch: {name: 'Legacy edit'}}), timeline);
});
