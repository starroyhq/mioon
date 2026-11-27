import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {TimeMapSourceWindow} from '../packages/contracts/src/timeline-time-map.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {createProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import type {ProcessingCache, ProcessingCacheEntry} from '../packages/business/src/timeline-processing/cache.ts';
import {prepareReverseProxy, renderReverseProxy, REVERSE_PROXY_PROFILE} from '../packages/business/src/timeline-processing/reverse.ts';
import {createTimelineReverseProxyPort} from '../packages/business/src/timeline-processing/reverse-lease.ts';
import type {TimelineReverseProxyRequest} from '../packages/business/src/timeline-processing/reverse-lease.ts';

const sourceFps = {fpsNumerator: 30, fpsDenominator: 1};
const sourceTimeBase = {numerator: 1, denominator: 30_000};
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const allow = () => {};
const window = (startFrame: number, endFrame: number): TimeMapSourceWindow => ({startFrame, endFrame,
  direction: 'reverse', frameCount: endFrame - startFrame, outputFromFrame: 0, outputToFrame: endFrame - startFrame});

async function fixture(t: test.TestContext, limitBytes?: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-reverse-lease-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cache = createProcessingCache(root, {limitBytes, freeBytes: () => 100n * 1024n ** 3n});
  const projectId = randomUUID(), taskId = randomUUID();
  const input: TimelineReverseProxyRequest = {
    projectId, timelineId: randomUUID(), clipId: randomUUID(), assetId: randomUUID(), sourceSha256: hash('source'),
    mapHash: 'ab'.repeat(8), media: 'video', sourceFps, sourceWindow: window(10, 13),
    pictureWindows: [window(9, 14)], needsAudio: true, audioWindow: {fromSample: 14_600, toSample: 23_600},
  };
  const target = {active: true, current: true, cacheKey: hash('cache'), requestId: randomUUID(), request: input};
  const port = createTimelineReverseProxyPort({cache, resolveTask(request, id) {
    if (!target.active || (id === undefined ? !target.current : id !== taskId) ||
      !(['projectId', 'timelineId', 'clipId', 'assetId', 'sourceSha256', 'mapHash', 'media'] as const)
        .every(key => request[key] === target.request[key])) return null;
    return {taskId, ready: {cacheKey: target.cacheKey, requestId: target.requestId}};
  }});
  return {root, cache, input, target, port, taskId};
}

interface SyntheticOptions {
  readonly corruptIndex?: boolean;
  readonly badCoverage?: boolean;
  readonly wrongSource?: boolean;
}

async function publishSynthetic(cache: ProcessingCache, cacheKey: string, request: TimelineReverseProxyRequest,
  {corruptIndex = false, badCoverage = false, wrongSource = false}: SyntheticOptions = {}): Promise<ProcessingCacheEntry> {
  const stage = cache.stage(request.projectId, cacheKey, 200_000, allow);
  try {
    const media = Buffer.from('owned synthetic Matroska payload');
    const index = Buffer.from([12_500, 11_000, 9_000].map((pts, ordinal) =>
      JSON.stringify({ordinal, sourceOrdinal: 235 - ordinal + (corruptIndex && ordinal === 1 ? 1 : 0),
        sourcePts: String(pts), proxyPts: String(ordinal)}) + '\n').join(''));
    const file = async <T extends ProcessingCacheEntry['result']['files'][number]['fileName']>(fileName: T, contents: Buffer) => {
      await writeFile(path.join(stage.directory, fileName), contents, {mode: 0o600, flag: 'wx'});
      return {fileName, bytes: contents.length, sha256: hash(contents)};
    };
    const files = [await file('proxy.mkv', media), await file('frames.jsonl', index)];
    const clock = Buffer.from(JSON.stringify({
      profile: {id: REVERSE_PROXY_PROFILE, coverageVersion: 2, buildSha256: hash('build'), storage: 'matroska',
        video: {index: 0, codec: 'ffv1', width: 16, height: 16, pixelFormat: 'yuv420p', frameBytes: 384,
          timeBase: sourceTimeBase, sampleAspect: {numerator: 1, denominator: 1}, colour: {}, threads: 1, encoderAllocationBytes: 134_217_728},
        audio: {index: 1, codec: 'pcm_f32le', rate: 44_100, channels: 2, layout: 'stereo', firstMediaSample: 0}},
      mapHash: request.mapHash, sourceSha256: wrongSource ? hash('different source') : request.sourceSha256,
      sourceWindow: request.sourceWindow, sourceClock: request.sourceFps, originUs: 0,
      frameCount: 3, sampleCount: 8_820, sourceSampleStart: 13_230,
      video: {index: 'frames.jsonl', timeBase: {numerator: 1, denominator: 30}, sourceTimeBase, decodedSha256: hash('frames'),
        sourceCoverage: {startFrame: 9, endFrame: 14}, firstSourceOrdinal: 233, sourceZeroPts: '0', endSourcePts: '14000'},
      audio: {rate: 44_100, layout: 'stereo', decodedSha256: hash('audio'),
        sourceCoverage: {fromSample: 14_400, toSample: badCoverage ? 24_001 : 24_000},
        sourceZero: {streamIndex: 0, pts: '0', timeBase: sourceTimeBase}},
      files,
    }) + '\n');
    return stage.publish({profileId: REVERSE_PROXY_PROFILE, mapHash: request.mapHash, frameCount: 3,
      sampleCount: 8_820, files: [...files, await file('clock.json', clock)]});
  } finally {stage.discard();}
}

test('reverse lease binds the exact digest and native ordinal, pins media, and rechecks each use', async t => {
  const limit = 250_000;
  const {cache, input, target, port, taskId} = await fixture(t, limit);
  const entry = await publishSynthetic(cache, target.cacheKey, input);
  const ready = port.lookup(input);
  assert.equal(ready?.taskId, taskId);
  assert.ok(ready.readySha256);
  const proof = {taskId, sha256: ready.readySha256};
  const rawEvidence = cache.lookupWithClock(input.projectId, target.cacheKey, REVERSE_PROXY_PROFILE);
  assert.ok(rawEvidence);
  assert.notEqual(proof.sha256, rawEvidence.digest);
  assert.equal(await port.acquire(input, {taskId, sha256: rawEvidence.digest}, {}), null);
  assert.equal(await port.acquire(input, {...proof, taskId: randomUUID()}, {}), null);
  assert.equal(await port.acquire(input, {...proof, sha256: hash('wrong receipt')}, {}), null);
  assert.equal(port.lookup({...input, projectId: randomUUID()}), null);
  assert.equal(port.lookup({...input, sourceSha256: hash('different source')}), null);
  assert.deepEqual(port.lookup({...input, pictureWindows: [window(8, 14)]}), {taskId});
  assert.deepEqual(port.lookup({...input, audioWindow: {fromSample: 14_399, toSample: 24_000}}), {taskId});
  assert.deepEqual(port.lookup({...input, audioWindow: {fromSample: 14_400, toSample: 24_001}}), {taskId});
  const lease = await port.acquire(input, proof, {});
  assert.ok(lease);
  t.after(() => lease.release());
  assert.deepEqual(lease.proof, proof);
  assert.deepEqual(lease.video, {file: path.join(entry.directory, 'proxy.mkv'), firstSourceOrdinal: 233, frameCount: 3, storage: 'matroska'});
  assert.deepEqual(lease.audio?.clock, {fromSample: 14_400, toSample: 24_000});
  assert.equal(lease.verify(), true);
  assert.deepEqual(cache.clear(input.projectId, allow), {freedBytes: 0});
  assert.throws(() => cache.stage(input.projectId, hash('cannot evict lease'), limit, allow), {code: 'CACHE_LIMIT'});

  // An export that already froze the exact task can still open its lease when
  // the project edit no longer advertises that demand as a fresh lookup.
  target.current = false;
  assert.equal(port.lookup(input), null);
  assert.equal(lease.verify(), true);
  const frozen = await port.acquire(input, proof, {});
  assert.ok(frozen);
  frozen.release();
  target.requestId = randomUUID();
  assert.equal(lease.verify(), false, 'a replacement attempt cannot reuse the old credential');
  assert.equal(await port.acquire(input, proof, {}), null);
  target.active = false;
  assert.equal(lease.verify(), false);
  lease.release();
  lease.release();
  assert.equal(lease.verify(), false);
  assert.deepEqual(cache.clear(input.projectId, allow), {freedBytes: entry.usedBytes});
});

test('reverse lease refuses incorrect clock or index evidence and releases its pin after rejection', async t => {
  const {cache, input, target, port, taskId} = await fixture(t);
  for (const defect of ['wrongSource', 'badCoverage', 'corruptIndex'] as const) {
    target.cacheKey = hash(defect);
    const entry = await publishSynthetic(cache, target.cacheKey, input, {[defect]: true});
    const advertised = port.lookup(input);
    const evidence = cache.lookupWithClock(input.projectId, target.cacheKey, REVERSE_PROXY_PROFILE);
    assert.ok(evidence);
    if (defect === 'corruptIndex') {
      assert.equal(advertised?.taskId, taskId);
      assert.ok(advertised.readySha256);
      assert.notEqual(advertised.readySha256, evidence.digest);
      assert.equal(await port.acquire(input, {taskId, sha256: advertised.readySha256}, {}), null);
    } else {
      assert.deepEqual(advertised, {taskId});
    }
    assert.equal(await port.acquire(input, {taskId, sha256: evidence.digest}, {}), null);
    assert.deepEqual(cache.clear(input.projectId, allow), {freedBytes: entry.usedBytes});
  }

  target.cacheKey = hash('tamper payload');
  const entry = await publishSynthetic(cache, target.cacheKey, input);
  const ready = port.lookup(input);
  assert.ok(ready?.readySha256);
  const proof = {taskId, sha256: ready.readySha256};
  const lease = await port.acquire(input, proof, {});
  assert.ok(lease);
  t.after(() => lease.release());
  assert.ok(lease.video);
  const media = await readFile(lease.video.file);
  media[0] = media[0]! ^ 1;
  await writeFile(lease.video.file, media);
  assert.equal(lease.verify(), false);
  assert.equal(await port.acquire(input, proof, {}), null);
  lease.release();
  assert.deepEqual(cache.clear(input.projectId, allow), {freedBytes: entry.usedBytes});
});

test('published FFV1 and native 44.1 kHz PCM satisfy the reverse lease and exact export clock', {timeout: 60_000}, async t => {
  const {cache, root, input, target, port, taskId} = await fixture(t);
  const source = path.join(root, 'source.mov');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=32x24:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=44100:duration=1',
    '-c:v', 'libx264', '-threads:v', '1', '-pix_fmt', 'yuv420p', '-video_track_timescale', '30000',
    '-c:a', 'pcm_f32le', '-f', 'mov', source], {timeout: 15_000});
  const request = {...input, sourceSha256: hash(await readFile(source))};
  target.request = request;
  const frozen = {sourcePath: source, sourceSha256: request.sourceSha256, media: request.media, sourceFps, sourceWindow: request.sourceWindow,
    pictureWindow: request.pictureWindows[0]!, mapHash: request.mapHash, audioWindow: request.audioWindow!};
  const options = {signal: new AbortController().signal, beforeEffect: allow};
  const prepared = await prepareReverseProxy(frozen, options);
  const stage = cache.stage(input.projectId, target.cacheKey, prepared.reservationBytes, allow);
  try {stage.publish(await renderReverseProxy(frozen, prepared, {...options, stagingDirectory: stage.directory}));}
  finally {stage.discard();}
  const ready = port.lookup(request);
  assert.ok(ready?.readySha256);
  const lease = await port.acquire(request, {taskId, sha256: ready.readySha256}, {});
  assert.ok(lease);
  t.after(() => lease.release());
  assert.equal(lease.video?.storage, 'matroska');
  assert.equal(lease.video?.firstSourceOrdinal, 9);
  assert.equal(lease.video?.frameCount, 5);
  assert.deepEqual(lease.audio?.clock, {fromSample: 14_560, toSample: 23_680});
  assert.equal(lease.verify(), true);
  lease.release();

  // An audio-track use of the same video asset retains its picture origin
  // while its lease supplies only the reversed PCM.
  const audioRequest = {...request, media: 'audio' as const, pictureWindows: []};
  const audioOnly = {sourcePath: source, sourceSha256: request.sourceSha256, media: audioRequest.media, sourceFps,
    sourceWindow: request.sourceWindow, mapHash: request.mapHash, audioWindow: request.audioWindow!};
  target.request = audioRequest;
  target.cacheKey = hash('audio cache');
  const audioPrepared = await prepareReverseProxy(audioOnly, options);
  const audioStage = cache.stage(input.projectId, target.cacheKey, audioPrepared.reservationBytes, allow);
  try {audioStage.publish(await renderReverseProxy(audioOnly, audioPrepared, {...options, stagingDirectory: audioStage.directory}));}
  finally {audioStage.discard();}
  const audioReady = port.lookup(audioRequest);
  assert.ok(audioReady?.readySha256);
  const audioLease = await port.acquire(audioRequest, {taskId, sha256: audioReady.readySha256}, {});
  assert.ok(audioLease);
  t.after(() => audioLease.release());
  assert.equal(audioLease.video, undefined);
  assert.deepEqual(audioLease.audio?.clock, {fromSample: 14_560, toSample: 23_680});
  assert.equal(audioLease.verify(), true);
});
