import {createHash} from 'node:crypto';
import path from 'node:path';
import {setImmediate as yieldIO} from 'node:timers/promises';
import {readPrivateFile} from '@mioon/contracts/private-storage';
import {projectIdSchema} from '../../../contracts/src/project-file.ts';
import {TIMELINE_TIME_MAP_LIMITS} from '../../../contracts/src/timeline-time-map.ts';
import type {TimeMapSourceWindow, TimeMapTimebase} from '../../../contracts/src/timeline-time-map.ts';
import {checkMediaEffect} from '../media-runtime.ts';
import type {ProcessingCache, ProcessingCacheEntry, ProcessingCacheProof} from './cache.ts';
import {REVERSE_PROXY_COVERAGE_VERSION, REVERSE_PROXY_LIMITS, REVERSE_PROXY_PROFILE} from './reverse-profile.ts';

type ClockRange = {readonly fromSample: number; readonly toSample: number};
type ProxyProof = {readonly taskId: string; readonly sha256: string};
type ProxyOptions = {signal?: AbortSignal; beforeEffect?: () => void};

export interface TimelineReverseProxyRequest {
  readonly projectId: string;
  readonly timelineId: string;
  readonly clipId: string;
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly mapHash: string;
  readonly media: 'audio' | 'video';
  readonly sourceFps: TimeMapTimebase;
  readonly sourceWindow: TimeMapSourceWindow;
  readonly pictureWindows: readonly TimeMapSourceWindow[];
  readonly needsAudio: boolean;
  readonly audioWindow: ClockRange | null;
}

export interface TimelineReverseProxyLease {
  readonly proof: ProxyProof;
  readonly video?: {
    readonly file: string;
    readonly firstSourceOrdinal: number;
    readonly frameCount: number;
    readonly storage: 'matroska' | 'raw';
  };
  readonly audio?: {
    readonly file: string;
    readonly clock: ClockRange;
    readonly raw?: {readonly sampleRate: number; readonly channels: number; readonly layout: string};
  };
  verify(): boolean;
  release(): void;
}

export interface TimelineReverseProxyPort {
  lookup(request: TimelineReverseProxyRequest): {readonly taskId: string; readonly readySha256?: string} | null;
  acquire(request: TimelineReverseProxyRequest, proof: ProxyProof, options: ProxyOptions): Promise<TimelineReverseProxyLease | null>;
}

type ResolvedTask = {readonly taskId: string; readonly ready?: {readonly cacheKey: string}};
interface ReverseProxyPortOptions {
  readonly resolveTask: (request: TimelineReverseProxyRequest, taskId?: string) => ResolvedTask | null;
  readonly cache: Pick<ProcessingCache, 'lookupWithClock' | 'acquire'>;
}

type Value = Record<string, unknown>;
type Payload = ProcessingCacheEntry['result']['files'][number];
type Storage = NonNullable<TimelineReverseProxyLease['video']>['storage'];
type PictureCoverage = Pick<TimeMapSourceWindow, 'startFrame' | 'endFrame'>;
type Rational = {numerator: number; denominator: number};
type VideoClock = {
  readonly index: Payload;
  readonly payload: Payload;
  readonly frameCount: number;
  readonly coverage: PictureCoverage;
  readonly sourceTimeBase: Rational;
  readonly firstSourceOrdinal: number;
  readonly sourceZeroPts: bigint;
  readonly endSourcePts: bigint;
};
type ClockEvidence = {
  readonly storage: Storage;
  readonly video?: VideoClock;
  readonly audio?: NonNullable<TimelineReverseProxyLease['audio']>;
};

const outputClockRate = 48_000;
const clockBytes = 64 * 1024;
const indexLineBytes = 160;
const digest = /^[0-9a-f]{64}$/u;
const mapDigest = /^[0-9a-f]{16}$/u;
const tag = /^[A-Za-z0-9_]{1,64}$/u;
const channelLayout = /^[A-Za-z0-9_ .()+-]{1,64}$/u;
const timestamp = /^(?:0|-?[1-9][0-9]{0,15})$/u;

function record(value: unknown): value is Value {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: unknown, keys: readonly string[]): value is Value {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && digest.test(value);
}

function rational(value: unknown): value is Rational {
  return fields(value, ['numerator', 'denominator']) && integer(value.numerator, 1, 1e9) && integer(value.denominator, 1, 1e9);
}

function timebase(value: unknown): value is TimeMapTimebase {
  return fields(value, ['fpsNumerator', 'fpsDenominator']) &&
    integer(value.fpsNumerator, 1, 1e6) && integer(value.fpsDenominator, 1, 1e6);
}

function pictureCoverage(value: unknown): value is PictureCoverage {
  return fields(value, ['startFrame', 'endFrame']) && integer(value.startFrame, 0) &&
    integer(value.endFrame, value.startFrame + 1) &&
    value.endFrame - value.startFrame <= TIMELINE_TIME_MAP_LIMITS.maxSourceFrames;
}

function clockRange(value: unknown): value is ClockRange {
  return fields(value, ['fromSample', 'toSample']) && integer(value.fromSample, 0) && integer(value.toSample, value.fromSample + 1);
}

function sourceWindow(value: unknown): value is TimeMapSourceWindow {
  return fields(value, ['startFrame', 'endFrame', 'frameCount', 'direction', 'outputFromFrame', 'outputToFrame']) &&
    integer(value.startFrame, 0) && integer(value.endFrame, value.startFrame + 1) && value.frameCount === value.endFrame - value.startFrame &&
    value.frameCount <= TIMELINE_TIME_MAP_LIMITS.maxSourceFrames && value.direction === 'reverse' &&
    integer(value.outputFromFrame, 0) && integer(value.outputToFrame, value.outputFromFrame + 1);
}

function requestIsValid(input: TimelineReverseProxyRequest): boolean {
  return [input.projectId, input.timelineId, input.clipId, input.assetId].every(value => projectIdSchema.safeParse(value).success) &&
    sha(input.sourceSha256) && typeof input.mapHash === 'string' && mapDigest.test(input.mapHash) &&
    (input.media === 'video' || input.media === 'audio') && timebase(input.sourceFps) && sourceWindow(input.sourceWindow) &&
    Array.isArray(input.pictureWindows) && input.pictureWindows.length <= TIMELINE_TIME_MAP_LIMITS.maxOutputFrames &&
    input.pictureWindows.every(sourceWindow) && typeof input.needsAudio === 'boolean' &&
    (input.audioWindow === null || input.needsAudio && clockRange(input.audioWindow));
}

function sameWindow(a: TimeMapSourceWindow, b: TimeMapSourceWindow): boolean {
  return a.startFrame === b.startFrame && a.endFrame === b.endFrame && a.frameCount === b.frameCount &&
    a.direction === b.direction && a.outputFromFrame === b.outputFromFrame && a.outputToFrame === b.outputToFrame;
}

function includesPicture(outer: PictureCoverage, inner: PictureCoverage): boolean {
  return outer.startFrame <= inner.startFrame && outer.endFrame >= inner.endFrame;
}

function parseCanonicalJson(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return JSON.stringify(value) === raw ? value : null;
  } catch {return null;}
}

function videoProfile(value: unknown): value is {index: number; frameBytes: number; timeBase: Rational; pixelFormat: string} {
  return fields(value, ['index', 'codec', 'width', 'height', 'pixelFormat', 'frameBytes', 'timeBase', 'sampleAspect',
    'colour', 'threads', 'encoderAllocationBytes']) && integer(value.index, 0, 255) &&
    typeof value.codec === 'string' && tag.test(value.codec) && integer(value.width, 1, REVERSE_PROXY_LIMITS.maxPixels) &&
    integer(value.height, 1, REVERSE_PROXY_LIMITS.maxPixels) && value.width * value.height <= REVERSE_PROXY_LIMITS.maxPixels &&
    typeof value.pixelFormat === 'string' && tag.test(value.pixelFormat) && integer(value.frameBytes, 1, REVERSE_PROXY_LIMITS.intraFrameBytes) &&
    rational(value.timeBase) && rational(value.sampleAspect) && record(value.colour) &&
    Object.entries(value.colour).every(([key, item]) => ['color_range', 'color_space', 'color_transfer', 'color_primaries', 'chroma_location'].includes(key) &&
      typeof item === 'string' && tag.test(item)) && (value.threads === 1 || value.threads === 4) &&
    integer(value.encoderAllocationBytes, 0, REVERSE_PROXY_LIMITS.ffv1PacketAllocation);
}

function audioProfile(value: unknown): value is {index: number; rate: number; channels: number; layout: string} {
  return fields(value, ['index', 'codec', 'rate', 'channels', 'layout', 'firstMediaSample']) && integer(value.index, 0, 255) &&
    typeof value.codec === 'string' && tag.test(value.codec) && integer(value.rate, 8_000, 192_000) &&
    integer(value.channels, 1, 8) && typeof value.layout === 'string' && channelLayout.test(value.layout) &&
    integer(value.firstMediaSample, Number.MIN_SAFE_INTEGER);
}

function readSample(value: unknown): bigint | null {
  return typeof value === 'string' && timestamp.test(value) ? BigInt(value) : null;
}

function rescaleSamples(sample: number, nativeRate: number): number | null {
  const n = BigInt(sample) * BigInt(outputClockRate);
  const d = BigInt(nativeRate);
  if (n % d !== 0n) return null;
  const scaled = Number(n / d);
  return integer(scaled, 0) ? scaled : null;
}

function audioClock(value: unknown, profile: {index: number; rate: number; channels: number; layout: string},
  pictureIndex: number | undefined, pictureClock: VideoClock | undefined, start: unknown, count: number): ClockRange | null {
  if (!fields(value, ['rate', 'layout', 'decodedSha256', 'sourceCoverage', 'sourceZero']) || value.rate !== profile.rate ||
    value.layout !== profile.layout || !sha(value.decodedSha256) || !clockRange(value.sourceCoverage) ||
    !fields(value.sourceZero, ['streamIndex', 'pts', 'timeBase']) || !integer(value.sourceZero.streamIndex, 0, 255) ||
    (pictureIndex !== undefined && value.sourceZero.streamIndex !== pictureIndex) ||
    readSample(value.sourceZero.pts) === null || !rational(value.sourceZero.timeBase) ||
    !integer(start, 0) || count < 1 || !integer(start + count, 1)) return null;
  if (pictureClock && (value.sourceZero.pts !== String(pictureClock.sourceZeroPts) ||
    value.sourceZero.timeBase.numerator !== pictureClock.sourceTimeBase.numerator ||
    value.sourceZero.timeBase.denominator !== pictureClock.sourceTimeBase.denominator)) return null;
  const fromSample = rescaleSamples(start, profile.rate), toSample = rescaleSamples(start + count, profile.rate);
  if (fromSample === null || toSample === null || fromSample >= toSample ||
    fromSample !== value.sourceCoverage.fromSample || toSample !== value.sourceCoverage.toSample) return null;
  return Object.freeze({fromSample, toSample});
}

function payloads(files: unknown, receipt: ProcessingCacheEntry['result']['files']): Map<string, Payload> | null {
  if (!Array.isArray(files) || files.length !== receipt.length - 1) return null;
  const expected = new Map(receipt.filter(file => file.fileName !== 'clock.json').map(file => [file.fileName as string, file]));
  for (const file of files as unknown[]) {
    if (!fields(file, ['fileName', 'bytes', 'sha256']) || typeof file.fileName !== 'string' || !integer(file.bytes, 1) || !sha(file.sha256)) return null;
    const match = expected.get(file.fileName);
    if (!match || match.bytes !== file.bytes || match.sha256 !== file.sha256) return null;
    expected.delete(file.fileName);
  }
  return expected.size === 0 ? new Map(receipt.map(file => [file.fileName, file])) : null;
}

function inspectClock(request: TimelineReverseProxyRequest, {entry, clock}: ProcessingCacheProof): ClockEvidence | null {
  const {result} = entry;
  if (entry.projectId !== request.projectId || result.profileId !== REVERSE_PROXY_PROFILE || result.mapHash !== request.mapHash ||
    clock.length < 2 || clock.length > clockBytes || clock.at(-1) !== 10) return null;
  const info = parseCanonicalJson(clock.toString('utf8', 0, clock.length - 1));
  if (!fields(info, ['profile', 'mapHash', 'sourceSha256', 'sourceWindow', 'sourceClock', 'originUs', 'frameCount',
    'sampleCount', 'sourceSampleStart', 'video', 'audio', 'files']) ||
    info.sourceSha256 !== request.sourceSha256 || info.mapHash !== request.mapHash ||
    !sourceWindow(info.sourceWindow) || !sameWindow(info.sourceWindow, request.sourceWindow) ||
    !timebase(info.sourceClock) || info.sourceClock.fpsNumerator !== request.sourceFps.fpsNumerator ||
    info.sourceClock.fpsDenominator !== request.sourceFps.fpsDenominator || !integer(info.originUs, Number.MIN_SAFE_INTEGER) ||
    !integer(info.frameCount, 0, REVERSE_PROXY_LIMITS.nativeFrames) || info.frameCount !== result.frameCount ||
    !integer(info.sampleCount, 0) || info.sampleCount !== result.sampleCount ||
    !fields(info.profile, ['id', 'coverageVersion', 'buildSha256', 'storage', 'video', 'audio']) ||
    info.profile.id !== REVERSE_PROXY_PROFILE || info.profile.coverageVersion !== REVERSE_PROXY_COVERAGE_VERSION || !sha(info.profile.buildSha256) ||
    (info.profile.storage !== 'matroska' && info.profile.storage !== 'raw')) return null;
  const {profile} = info, storage = profile.storage as Storage;
  const files = payloads(info.files, result.files);
  if (!files) return null;
  const movie = files.get('proxy.mkv');
  const rawVideo = files.get('video.raw');
  const rawAudio = files.get('audio.f32le');
  const index = files.get('frames.jsonl');
  if (storage === 'matroska' ? !movie || rawVideo || rawAudio : movie || !rawVideo) return null;
  const video = videoProfile(profile.video) ? profile.video : null;
  const audio = audioProfile(profile.audio) ? profile.audio : null;
  if ((!video && !audio) || (video === null && profile.video !== null) || (audio === null && profile.audio !== null) ||
    (request.media === 'video') !== Boolean(video) || (storage === 'raw') !== Boolean(video?.pixelFormat.endsWith('f32le'))) return null;
  if (!video && (index || info.video !== null || info.frameCount !== 0 || request.pictureWindows.length > 0) ||
    !audio && (info.audio !== null || info.sampleCount !== 0 || info.sourceSampleStart !== null || request.needsAudio || rawAudio)) return null;

  let picture: VideoClock | undefined;
  if (video) {
    const payload = rawVideo ?? movie;
    const videoEvidence = info.video;
    if (!payload || !index || info.frameCount < 1 || index.bytes < info.frameCount ||
      index.bytes > indexLineBytes * info.frameCount ||
      !fields(videoEvidence, ['index', 'timeBase', 'sourceTimeBase', 'decodedSha256', 'sourceCoverage', 'firstSourceOrdinal', 'sourceZeroPts',
        'endSourcePts']) ||
      videoEvidence.index !== index.fileName || !rational(videoEvidence.timeBase) || videoEvidence.timeBase.numerator !== 1 ||
      videoEvidence.timeBase.denominator !== request.sourceFps.fpsNumerator || !rational(videoEvidence.sourceTimeBase) ||
      videoEvidence.sourceTimeBase.numerator !== video.timeBase.numerator || videoEvidence.sourceTimeBase.denominator !== video.timeBase.denominator ||
      !sha(videoEvidence.decodedSha256) || !pictureCoverage(videoEvidence.sourceCoverage) ||
      !integer(videoEvidence.firstSourceOrdinal, 0, REVERSE_PROXY_LIMITS.nativeFrames - info.frameCount) ||
      !includesPicture(videoEvidence.sourceCoverage, request.sourceWindow) ||
      rawVideo && (BigInt(rawVideo.bytes) !== BigInt(info.frameCount) * BigInt(video.frameBytes) ||
        rawVideo.sha256 !== videoEvidence.decodedSha256)) return null;
    const coverage = videoEvidence.sourceCoverage;
    if (request.pictureWindows.some(window => !includesPicture(coverage, window))) return null;
    const sourceZeroPts = readSample(videoEvidence.sourceZeroPts), endSourcePts = readSample(videoEvidence.endSourcePts);
    if (sourceZeroPts === null || endSourcePts === null) return null;
    const [end, base] = pictureTick(coverage.endFrame, request.sourceFps, videoEvidence.sourceTimeBase, sourceZeroPts);
    if ((endSourcePts + 1n) * base < end) return null;
    picture = {index, payload, frameCount: info.frameCount, coverage, sourceTimeBase: videoEvidence.sourceTimeBase,
      firstSourceOrdinal: videoEvidence.firstSourceOrdinal, sourceZeroPts, endSourcePts};
  }
  let sound: ClockEvidence['audio'];
  if (audio) {
    const audioFile = rawAudio ?? movie;
    const clock = audioClock(info.audio, audio, video?.index, picture, info.sourceSampleStart, info.sampleCount);
    if (!clock || !audioFile || storage === 'raw' && !rawAudio ||
      request.audioWindow && (clock.fromSample > request.audioWindow.fromSample || clock.toSample < request.audioWindow.toSample) ||
      rawAudio && (BigInt(rawAudio.bytes) !== BigInt(info.sampleCount) * BigInt(audio.channels) * 4n ||
        !record(info.audio) || rawAudio.sha256 !== info.audio.decodedSha256)) return null;
    if (request.needsAudio) sound = Object.freeze({file: path.join(entry.directory, audioFile.fileName), clock,
      ...(rawAudio ? {raw: Object.freeze({sampleRate: audio.rate, channels: audio.channels, layout: audio.layout})} : {})});
  }
  return {storage, video: picture, audio: sound};
}

function pictureTick(frame: number, fps: TimeMapTimebase, tick: Rational, sourceZeroPts: bigint): [bigint, bigint] {
  const denominator = BigInt(fps.fpsNumerator) * BigInt(tick.numerator);
  return [sourceZeroPts * denominator + BigInt(frame) * BigInt(fps.fpsDenominator) * BigInt(tick.denominator), denominator];
}

/** The index owns native presentation ordinals. A project-clock frame number
 * cannot substitute for that ordinal when the source is VFR. */
async function validateIndex(directory: string, video: VideoClock, fps: TimeMapTimebase,
  current: () => boolean): Promise<boolean> {
  let bytes: Buffer;
  try {
    const raw = readPrivateFile(path.join(directory, video.index.fileName), {root: directory, maxBytes: video.index.bytes, private: true});
    if (!Buffer.isBuffer(raw) || raw.length !== video.index.bytes ||
      createHash('sha256').update(raw).digest('hex') !== video.index.sha256) return false;
    bytes = raw;
  } catch {return false;}
  const [start, d] = pictureTick(video.coverage.startFrame, fps, video.sourceTimeBase, video.sourceZeroPts);
  const [end] = pictureTick(video.coverage.endFrame, fps, video.sourceTimeBase, video.sourceZeroPts);
  let offset = 0, lastPts: bigint | null = null;
  const highestOrdinal = video.firstSourceOrdinal + video.frameCount - 1;
  for (let ordinal = 0; ordinal < video.frameCount; ordinal++) {
    if (ordinal !== 0 && ordinal % 4096 === 0) {
      await yieldIO();
      if (!current()) return false;
    }
    const newline = bytes.indexOf(10, offset);
    if (newline < 0 || newline - offset > indexLineBytes - 1) return false;
    const frame = parseCanonicalJson(bytes.toString('utf8', offset, newline));
    if (!fields(frame, ['ordinal', 'sourceOrdinal', 'sourcePts', 'proxyPts']) || frame.ordinal !== ordinal ||
      frame.sourceOrdinal !== highestOrdinal - ordinal ||
      frame.proxyPts !== String(BigInt(ordinal) * BigInt(fps.fpsDenominator))) return false;
    const sourcePts = readSample(frame.sourcePts);
    if (sourcePts === null || sourcePts <= -(1n << 50n) || sourcePts >= 1n << 50n) return false;
    if (lastPts === null ? sourcePts * d >= end || sourcePts >= video.endSourcePts : sourcePts >= lastPts) return false;
    lastPts = sourcePts;
    offset = newline + 1;
  }
  // Producer admission allows one source tick for quantised stream start.
  return offset === bytes.length && lastPts !== null && lastPts * d <= start + d &&
    (video.firstSourceOrdinal === 0 ? lastPts === video.sourceZeroPts : lastPts > video.sourceZeroPts);
}

export function createTimelineReverseProxyPort({resolveTask, cache}: ReverseProxyPortOptions): TimelineReverseProxyPort {
  return {
    lookup(request) {
      if (!requestIsValid(request)) return null;
      const task = resolveTask(request);
      if (!task || !projectIdSchema.safeParse(task.taskId).success) return null;
      const cacheKey = task.ready?.cacheKey;
      if (!sha(cacheKey)) return {taskId: task.taskId};
      const proof = cache.lookupWithClock(request.projectId, cacheKey, REVERSE_PROXY_PROFILE);
      return proof && sha(proof.digest) && inspectClock(request, proof)
        ? {taskId: task.taskId, readySha256: proof.digest} : {taskId: task.taskId};
    },
    async acquire(request, proof, options) {
      if (!requestIsValid(request) || !projectIdSchema.safeParse(proof.taskId).success || !sha(proof.sha256)) return null;
      checkMediaEffect(options.beforeEffect, options.signal);
      const task = resolveTask(request, proof.taskId);
      const cacheKey = task?.ready?.cacheKey;
      if (task?.taskId !== proof.taskId || !sha(cacheKey)) return null;
      const held = await cache.acquire(request.projectId, cacheKey, REVERSE_PROXY_PROFILE, {...options, expectedDigest: proof.sha256});
      if (!held) return null;
      let keep = false, released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        held.release();
      };
      const current = (): boolean => {
        if (released || held.digest !== proof.sha256) return false;
        checkMediaEffect(options.beforeEffect, options.signal);
        const live = resolveTask(request, proof.taskId);
        if (live?.taskId !== proof.taskId || live.ready?.cacheKey !== cacheKey) return false;
        try {held.verify();} catch {return false;}
        return true;
      };
      try {
        if (!current()) return null;
        const clock = inspectClock(request, held);
        if (!clock) return null;
        let video: TimelineReverseProxyLease['video'];
        if (clock.video) {
          if (!await validateIndex(held.entry.directory, clock.video, request.sourceFps, current)) return null;
          video = Object.freeze({file: path.join(held.entry.directory, clock.video.payload.fileName), firstSourceOrdinal: clock.video.firstSourceOrdinal,
            frameCount: clock.video.frameCount, storage: clock.storage});
        }
        if (!current()) return null;
        keep = true;
        return Object.freeze({proof: Object.freeze({taskId: proof.taskId, sha256: proof.sha256}), video, audio: clock.audio,
          verify() {try {return current();} catch {return false;}}, release});
      } finally {if (!keep) release();}
    },
  };
}
