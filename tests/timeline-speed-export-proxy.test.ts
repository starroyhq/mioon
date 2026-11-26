import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import test from 'node:test';
import {spawnMedia, type ManagedMediaChild} from '../packages/business/src/media-processes.ts';
import type {TimelineRecord} from '../packages/business/src/timeline-inputs.ts';
import {timelineSpeedExportLayout} from '../packages/business/src/timeline-speed-export-admission.ts';
import {
  assertTimelineReverseProxyBindings, freezeTimelineReverseProxies, withTimelineReverseProxy,
  type TimelineReverseProxyLease, type TimelineReverseProxyPort, type TimelineReverseProxyRequest,
} from '../packages/business/src/timeline-speed-export-proxy.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {timelineSpeedExportSnapshotFields} from '../packages/contracts/src/timeline-speed-export.ts';
import {
  compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, trimTimeMap, type TimeMapSpeedRate,
} from '../packages/contracts/src/timeline-time-map.ts';

const proof = {taskId: randomUUID(), sha256: 'c'.repeat(64)};
const sourceFps = {fpsNumerator: 30, fpsDenominator: 1};
const sourceRange = {
  start: {kind: 'rational', numerator: '12', denominator: '1'},
  end: {kind: 'rational', numerator: '24', denominator: '1'},
} as const;
const timestamp = '2026-01-01T00:00:00.000Z';

function fixture({rate = {numerator: 3, denominator: 2}, trimmed = false}: {rate?: TimeMapSpeedRate; trimmed?: boolean} = {}) {
  const asset = {id: randomUUID(), mimeType: 'video/mp4', duration: 2, sha256: 'a'.repeat(64), hasAudio: true};
  const trackId = randomUUID();
  const basis = {profile: 'timeline-speed-v1', sourceFps, outputFps: sourceFps, sourceRange,
    speed: {kind: 'constant', rate}} as const;
  const compiled = compileTimeMap(basis);
  assert.ok(compiled.ok);
  const full = initialTimeMap(compiled.value, 'reverse');
  const selection = trimTimeMap(full, trimmed ? 1 : 0, full.durationFrames - Number(trimmed));
  assert.ok(selection.ok);
  const plan = selection.value;
  const timing: ClipTiming = {profile: 'timeline-speed-v1', basis, pitchShift: false, interpolation: 'off',
    view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction: 'reverse'},
    outputWindow: plan.outputWindow};
  const clip = {id: randomUUID(), trackId, assetId: asset.id, startFrame: 0, durationFrames: plan.durationFrames, sourceInFrame: 12,
    rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1};
  const projection = projectTimeMapToCurrentClipFields(clip, plan);
  assert.ok(projection.ok);
  const incoming = {...clip, id: randomUUID(), startFrame: plan.durationFrames, sourceInFrame: 30,
    transitionIn: {profileId: CLIP_TRANSITION_PROFILE, kind: 'dissolve', durationFrames: 4}};
  const timeline: TimelineRecord = {id: randomUUID(), projectId: randomUUID(), revision: 1, fps: 30, width: 720, height: 720,
    tracks: [{id: trackId, kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{...clip, ...projection.value, timing}, incoming], durationFrames: plan.durationFrames * 2,
    createdAt: timestamp, updatedAt: timestamp};
  const assets = new Map([[asset.id, asset]]);
  const snapshot = {timeline, ...timelineSpeedExportSnapshotFields(timeline)};
  const layout = timelineSpeedExportLayout(snapshot, assets);
  assert.ok(layout);
  const item = layout.clips[0];
  assert.ok(item);
  return {asset, assets, snapshot, layout, item,
    frozen: {...snapshot, ...timelineSpeedExportSnapshotFields(timeline, new Map([[item.clipId, proof]]))}};
}

function readyLease(verify: () => boolean, release: () => void): TimelineReverseProxyLease {
  return {proof, verify, release,
    video: {file: 'private/proxy.mkv', firstSourceOrdinal: 8, frameCount: 16, storage: 'matroska'},
    audio: {file: 'private/proxy.mkv', clock: {fromSample: 19200, toSample: 38400}}};
}

function port(lookup: TimelineReverseProxyPort['lookup'],
  acquire: TimelineReverseProxyPort['acquire'] = async () => assert.fail('a lookup cannot open the private proxy')): TimelineReverseProxyPort {
  return {lookup, acquire};
}

function notReady(clipId: string, taskId?: string) {
  return {code: 'SPEED_PROCESSING_NOT_READY', details: {clipId, ...(taskId ? {taskId} : {})}};
}

test('reverse admission preserves the actual pending task ID and omits IDs for unknown demands', () => {
  const {snapshot, layout, assets, item} = fixture();
  const freeze = (resolver?: TimelineReverseProxyPort) => freezeTimelineReverseProxies(snapshot, layout, assets, resolver);
  assert.throws(() => freeze(port(() => ({taskId: proof.taskId}))), notReady(item.clipId, proof.taskId));
  assert.throws(() => freeze(port(() => ({taskId: proof.taskId, readySha256: 'invalid'}))), notReady(item.clipId, proof.taskId));
  assert.throws(() => freeze(port(() => ({taskId: 'invalid', readySha256: proof.sha256}))), notReady(item.clipId));
  assert.throws(() => freeze(port(() => null)), notReady(item.clipId));
  assert.throws(() => freeze(), notReady(item.clipId));
});

test('reverse lookup carries full source identity and a separate transition window; freezing retains only the proof', () => {
  const {snapshot, layout, asset, assets, item} = fixture();
  const requests: TimelineReverseProxyRequest[] = [];
  const resolver = port(request => {
    requests.push(request);
    // Internal fixture metadata must never be copied into a saved export.
    return {taskId: proof.taskId, readySha256: proof.sha256, file: 'private/proxy.mkv'};
  });
  // The displayed reverse sequence ends at 13, while the clip motion continues to 12.
  const visibleWindow = {startFrame: 13, endFrame: 24, frameCount: 11, direction: 'reverse',
    outputFromFrame: 0, outputToFrame: 8};
  const bindings = freezeTimelineReverseProxies(snapshot, layout, assets, resolver);
  assert.deepEqual(requests, [{projectId: snapshot.timeline.projectId, timelineId: snapshot.timeline.id, clipId: item.clipId,
    assetId: asset.id, sourceSha256: asset.sha256, mapHash: item.mapHash, media: 'video', sourceFps,
    sourceWindow: visibleWindow,
    pictureWindows: [visibleWindow, {startFrame: 10, endFrame: 12, frameCount: 2, direction: 'reverse',
      outputFromFrame: 0, outputToFrame: 2}], needsAudio: true,
    audioWindow: {fromSample: 19200, toSample: 38400}}]);
  assert.deepEqual(timelineSpeedExportSnapshotFields(snapshot.timeline, bindings), {
    speedExport: {profileId: 'timeline-speed-export-v1', clips: [{clipId: item.clipId, mapHash: item.mapHash, proxy: proof}]},
  });
});

test('a trimmed pitch-preserving reverse export asks for the entire audio view', () => {
  const {snapshot, layout, assets, item} = fixture({rate: {numerator: 2, denominator: 1}, trimmed: true});
  const resolver = port(request => {
    assert.deepEqual(request.audioWindow, {fromSample: 19200, toSample: 38400});
    assert.ok(request.sourceWindow.startFrame > 12);
    assert.ok(request.sourceWindow.endFrame < 24);
    return {taskId: proof.taskId, readySha256: proof.sha256};
  });
  assert.deepEqual(freezeTimelineReverseProxies(snapshot, layout, assets, resolver), new Map([[item.clipId, proof]]));
});

test('sound-only video on an audio track requests the same audio proxy as the processing task', () => {
  const {snapshot, assets, item} = fixture();
  const timeline: TimelineRecord = {...snapshot.timeline,
    tracks: snapshot.timeline.tracks.map(track => ({...track, kind: 'audio'})),
    clips: [{...item.clip, soundOnly: true}], durationFrames: item.plan.durationFrames};
  const audioSnapshot = {...snapshot, timeline};
  const layout = timelineSpeedExportLayout(audioSnapshot, assets);
  assert.ok(layout);
  const resolver = port(request => {
    assert.equal(request.media, 'audio');
    assert.deepEqual(request.pictureWindows, []);
    assert.deepEqual(request.audioWindow, {fromSample: 19200, toSample: 38400});
    return {taskId: proof.taskId, readySha256: proof.sha256};
  });
  assert.deepEqual(freezeTimelineReverseProxies(audioSnapshot, layout, assets, resolver), new Map([[item.clipId, proof]]));
});

test('reverse coverage outside the export range does not require a task', () => {
  const {snapshot, assets} = fixture();
  const selected = {...snapshot, exportRange: {startFrame: 10, endFrame: 16}};
  const layout = timelineSpeedExportLayout(selected, assets);
  assert.ok(layout);
  assert.deepEqual(freezeTimelineReverseProxies(selected, layout, assets, port(() => assert.fail('unused clip'))), new Map());
});

test('reverse worker opens by the frozen proof and holds the lease across consumption', async () => {
  const {snapshot, frozen, item, layout, asset} = fixture();
  const calls: string[] = [];
  const lease = readyLease(() => {calls.push('verify'); return true;}, () => {calls.push('release');});
  const {signal} = new AbortController();
  const resolver = port(() => assert.fail('worker must not resolve a new task'), async (request, expected, options) => {
    calls.push('acquire');
    assert.equal(request.clipId, item.clipId);
    assert.equal(request.sourceSha256, asset.sha256);
    assert.deepEqual(expected, proof);
    assert.equal(options.signal, signal);
    return lease;
  });
  assert.throws(() => assertTimelineReverseProxyBindings(snapshot, layout, resolver), notReady(item.clipId));
  assert.throws(() => assertTimelineReverseProxyBindings(frozen, layout), notReady(item.clipId, proof.taskId));
  assert.doesNotThrow(() => assertTimelineReverseProxyBindings(frozen, layout, resolver));
  const value = await withTimelineReverseProxy(frozen, item, asset, resolver, {signal}, async (current, fence) => {
    assert.equal(current, lease);
    assert.ok(fence);
    fence();
    calls.push('consume');
    return 12;
  });
  assert.equal(value, 12);
  assert.deepEqual(calls, ['acquire', 'verify', 'verify', 'consume', 'verify', 'release']);
});

test('reverse worker declines stale proofs, missing streams and invalid ownership and releases returned leases', async t => {
  const {frozen, item, asset} = fixture();
  const variants: [string, (lease: TimelineReverseProxyLease) => TimelineReverseProxyLease | null][] = [
    ['different task', lease => ({...lease, proof: {...proof, taskId: randomUUID()}})],
    ['different digest', lease => ({...lease, proof: {...proof, sha256: 'd'.repeat(64)}})],
    ['missing video', lease => ({...lease, video: undefined})],
    ['missing audio', lease => ({...lease, audio: undefined})],
    ['audio covers only picture frames', lease => ({
      ...lease, audio: {file: 'private/proxy.mkv', clock: {fromSample: 20800, toSample: 38400}},
    })],
    ['invalid ownership', lease => ({...lease, verify: () => false})],
    ['evicted', () => null],
  ];
  for (const [name, change] of variants) await t.test(name, async () => {
    let releases = 0;
    const lease = change(readyLease(() => true, () => {releases++;}));
    await assert.rejects(withTimelineReverseProxy(frozen, item, asset, port(() => null, async () => lease), {},
      async () => assert.fail('invalid proxy reached consumption')), notReady(item.clipId, proof.taskId));
    assert.equal(releases, lease ? 1 : 0);
  });
});

test('reverse worker rechecks after consumption and releases when cancellation arrives during acquisition', async t => {
  const {frozen, item, asset} = fixture();
  await t.test('ownership lost after consuming', async () => {
    let valid = true, releases = 0;
    const lease = readyLease(() => valid, () => {releases++;});
    await assert.rejects(withTimelineReverseProxy(frozen, item, asset, port(() => null, async () => lease), {},
      async () => {valid = false; return 'unpublishable';}), notReady(item.clipId, proof.taskId));
    assert.equal(releases, 1);
  });
  await t.test('cancel after acquisition begins', async () => {
    const controller = new AbortController();
    let releases = 0;
    const lease = readyLease(() => assert.fail('cancelled lease must not be used'), () => {releases++;});
    const resolver = port(() => null, async () => {
      controller.abort();
      return lease;
    });
    await assert.rejects(withTimelineReverseProxy(frozen, item, asset, resolver, {signal: controller.signal},
      async () => assert.fail('cancelled acquisition reached consumption')), {code: 'MEDIA_CANCELLED'});
    assert.equal(releases, 1);
  });
});

test('a decoded reverse stream with insufficient coverage is a retryable processing dependency', async t => {
  const {frozen, item, asset} = fixture();
  for (const details of [{reason: 'REVERSE_PROXY_COVERAGE'}, {audioReason: 'REVERSE_PCM_WINDOW'}]) {
    await t.test(Object.values(details)[0]!, async () => {
      let releases = 0;
      const lease = readyLease(() => true, () => {releases++;});
      const invalid = Object.assign(new Error('The proxy stream is incomplete'), {code: 'SPEED_MAPPING_INVALID', details});
      await assert.rejects(withTimelineReverseProxy(frozen, item, asset, port(() => null, async () => lease), {},
        async () => {throw invalid;}), notReady(item.clipId, proof.taskId));
      assert.equal(releases, 1);
    });
  }
});

test('an unconfirmed reader keeps the reverse proxy pinned until the owned process closes', async t => {
  const {frozen, item, asset} = fixture();
  const controller = new AbortController(), released = Promise.withResolvers<void>();
  const reader: {child?: ManagedMediaChild} = {};
  let releases = 0;
  t.after(() => controller.abort());
  const lease = readyLease(() => true, () => {releases++; released.resolve();});
  const error = Object.assign(new Error('The owned reader has not closed'), {terminationUnconfirmed: true});
  await assert.rejects(withTimelineReverseProxy(frozen, item, asset, port(() => null, async () => lease),
    {signal: controller.signal}, async () => {
      // Remain open until the test lets the exact owned child close.
      reader.child = spawnMedia(process.execPath, ['-e', "process.on('message', () => process.exit(0)); process.send('ready');"],
        {stdio: ['ignore', 'ignore', 'ignore', 'ipc']}, {signal: controller.signal});
      await once(reader.child, 'message');
      throw error;
    }), error);
  assert.equal(releases, 0);
  const {child} = reader;
  assert.ok(child?.connected);
  const closed = once(child, 'close');
  child.send('close');
  await closed;
  await released.promise;
  assert.equal(releases, 1);
});
