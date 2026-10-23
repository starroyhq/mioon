import path from 'node:path';
import {sourceFrameCount} from '@mioon/contracts';
import {FRAME_DECODE_LIMITS, frameDecodePlan} from './frame-decoder.ts';
import type {FrameDecodePlan} from './frame-decoder.ts';
import {mediaConfigurationError, mediaExecutable} from './media-environment.ts';
import {interruptedMediaError, mediaInterrupted, onMediaInterruption, spawnMedia, terminateMediaProcess, throwIfMediaAborted} from './media-processes.ts';
import {checkMediaEffect, MEDIA_PULL_CHUNK_BYTES, MEDIA_RUNTIME_LIMITS, run} from './media-runtime.ts';
import {createStreamingMediaRuntime} from './media-streaming-runtime.ts';
import {parseProbeOutput, withProbePermit} from './media-probe.ts';
import type {ProbeResult} from './media-probe.ts';
import {sameManagedFile, validateManagedSource, verifiedManagedHash} from './managed-media.ts';
import type {ManagedFileIdentity} from './managed-media.ts';
import {createSceneDetector, sceneDetectionOptions, SCENE_DETECTION_LIMITS} from './scene-detection.ts';
import type {SceneDetectionProgress, SceneDetectionResult} from './scene-detection.ts';

const {fps, maxEdge, maxDurationSeconds} = SCENE_DETECTION_LIMITS;
export const SCENE_DECODE_LIMITS = Object.freeze({
  // Frame capture's source limits, so every segment's keyframe can be captured.
  sourceBytes: FRAME_DECODE_LIMITS.sourceBytes, sourcePixels: FRAME_DECODE_LIMITS.sourcePixels,
  // Hashing and probing; then a decode budget of 1.5x real time on top.
  prepareMs: 120000, decodeBaseMs: 120000, decodeMsPerSecond: 1500,
  // No decoded output for this long stops the decoder.
  idleMs: 120000,
  // 0.1 s of container rounding between the probed duration and decoded frames.
  frameTolerance: 3,
  progressFrames: fps,
  outputBytes: ((maxDurationSeconds + 1) * fps) * maxEdge * maxEdge * 3,
});
export interface SceneDecodePlan {
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  readonly streamIndex: number;
  readonly duration: number;
  /** Editing-grid length of the source, as the source range reports it. */
  readonly frameCount: number;
}
export interface SceneDecodeProgress extends SceneDetectionProgress {
  readonly frameCount: number;
}
export interface ManagedSceneDetection extends SceneDetectionResult {
  readonly sourceHash: string;
  readonly analysis: {readonly width: number; readonly height: number; readonly decodedFrames: number};
}
export interface DetectManagedScenesOptions {
  readonly root?: unknown;
  readonly asset?: unknown;
  readonly file?: unknown;
  readonly info?: Record<string, unknown> | null;
  readonly options?: unknown;
  readonly signal?: AbortSignal | null;
  readonly beforeSpawn?: (signal: AbortSignal) => unknown;
  readonly onProgress?: (progress: SceneDecodeProgress) => void;
}
interface SceneFault extends Error {code: string; terminationUnconfirmed?: boolean}

const messages: Readonly<Record<string, string>> = Object.freeze({
  SCENE_PROFILE_UNSUPPORTED: 'This source does not match the supported local scene detection profile.',
  SCENE_DECODE_INCOMPLETE: 'The decoded frames do not cover the source duration.',
  SCENE_ATTEMPT_TIMEOUT: 'Local scene detection exceeded its time limit.',
  MANAGED_SOURCE_CHANGED: 'The managed media source changed during scene detection.',
});
const fault = (code: string): SceneFault => Object.assign(new Error(messages[code] ?? code), {code});
function unsupported(): never {throw fault('SCENE_PROFILE_UNSUPPORTED');}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const property = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;

/** Frame capture's own profile and limits (frameDecodePlan at the first mark),
 * so detection accepts exactly the sources whose keyframes can be captured.
 * The analysis grid is the editing grid: fps rounds down, so output frame N
 * holds the first source frame at or after N/30, the same rule as frame
 * capture, and a cut at N starts the new shot exactly when a clip starts at N.
 * Analysis frames are area-scaled to at most 256 pixels per edge, never upscaled.
 */
export function sceneDecodePlan(metadata: ProbeResult, {mimeType}: {mimeType?: unknown} = {}): SceneDecodePlan {
  let capture: FrameDecodePlan;
  try {capture = frameDecodePlan(metadata, {mimeType, requestedFrame: 0});}
  catch (error) {
    if (property(error, 'code') === 'FRAME_PROFILE_UNSUPPORTED') unsupported();
    throw error;
  }
  const {streamIndex, width, height} = capture.probe;
  // The same duration frame capture checked: the shorter of container and stream.
  const streamDuration = metadata.probe.streams.find(stream => stream.index === streamIndex)?.duration;
  const duration = Math.min(Number(metadata.probe.format?.duration), streamDuration === undefined || streamDuration === 'N/A' ? Infinity : Number(streamDuration));
  const frameCount = sourceFrameCount(duration);
  if (frameCount === null) unsupported();
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  const outputWidth = Math.max(1, Math.round(width * ratio)), outputHeight = Math.max(1, Math.round(height * ratio));
  return Object.freeze({width: outputWidth, height: outputHeight, streamIndex, duration, frameCount,
    filter: `fps=${fps}:round=down,scale=${outputWidth}:${outputHeight}:flags=area,format=rgb24`});
}

function checkGuard(beforeSpawn: ((signal: AbortSignal) => unknown) | undefined, signal: AbortSignal): void {
  throwIfMediaAborted(signal);
  const result = beforeSpawn?.(signal);
  if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw mediaConfigurationError();
  }
  throwIfMediaAborted(signal);
}

// The awaited pipe lane, with an output ceiling sized for the longest source's
// analysis frames. Its timeout is per-chunk inactivity; the attempt deadline
// below bounds the whole run.
const runSceneStreaming = createStreamingMediaRuntime({
  limits: Object.freeze({timeoutMs: SCENE_DECODE_LIMITS.idleMs, streamingStdoutBytes: SCENE_DECODE_LIMITS.outputBytes, stderrBytes: MEDIA_RUNTIME_LIMITS.stderrBytes}),
  pullChunkBytes: MEDIA_PULL_CHUNK_BYTES, mediaConfigurationError, mediaExecutable, checkMediaEffect, throwIfMediaAborted,
  spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, terminateMediaProcess,
});

/** One bounded, nonpublishing managed-video scene detection attempt.
 * The caller supplies an owned asset, absolute verified path and stat snapshot,
 * and owns persistence and its project/lock fence. beforeSpawn must be
 * synchronous; it receives the attempt signal registered with child processes.
 * Hash and pathname/descriptor identity checks bracket probe and decode, as for
 * frame capture; same-UID mutation can still race the decoder's pathname open.
 * Progress reports at most once per second of source, from inside the decode;
 * a throwing progress callback stops the attempt.
 */
export async function detectManagedScenes({root, asset, file, info, options, signal, beforeSpawn, onProgress}: DetectManagedScenesOptions = {}): Promise<ManagedSceneDetection> {
  throwIfMediaAborted(signal);
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') ||
    !object(asset) || !info || beforeSpawn !== undefined && typeof beforeSpawn !== 'function' || onProgress !== undefined && typeof onProgress !== 'function') throw mediaConfigurationError();
  const settings = sceneDetectionOptions(options);
  if (!['video/mp4', 'video/webm'].includes(String(asset.mimeType))) unsupported();
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw fault('MANAGED_SOURCE_CHANGED');
  const sourceAsset = {relativePath: asset.relativePath, sha256: asset.sha256, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes};
  const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]])) as unknown as ManagedFileIdentity;
  const controller = new AbortController(), abort = (): void => controller.abort();
  let timedOut = false;
  const deadline = (ms: number): ReturnType<typeof setTimeout> => setTimeout(() => {timedOut = true; controller.abort();}, ms);
  let timer = deadline(SCENE_DECODE_LIMITS.prepareMs);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const attemptSignal = controller.signal, maxBytes = SCENE_DECODE_LIMITS.sourceBytes;
  try {
    const before = await verifiedManagedHash(root, sourceAsset, {signal: attemptSignal, expected, maxBytes});
    if (file !== before.file || sourceAsset.sizeBytes !== undefined && sourceAsset.sizeBytes !== before.sizeBytes) throw fault('MANAGED_SOURCE_CHANGED');
    const metadata = await withProbePermit(attemptSignal, async () => {
      if (!sameManagedFile(before.info, validateManagedSource(root, sourceAsset, {maxBytes}).info)) throw fault('MANAGED_SOURCE_CHANGED');
      checkGuard(beforeSpawn, attemptSignal);
      const output = await run('ffprobe', ['-v', 'error', '-threads', '1', '-max_pixels', String(SCENE_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'mov,matroska', '-show_format', '-show_streams', '-of', 'json', file], {signal: attemptSignal, timeout: SCENE_DECODE_LIMITS.idleMs});
      throwIfMediaAborted(attemptSignal);
      return parseProbeOutput(output);
    });
    const plan = sceneDecodePlan(metadata, {mimeType: sourceAsset.mimeType});
    clearTimeout(timer);
    timer = deadline(SCENE_DECODE_LIMITS.prepareMs + SCENE_DECODE_LIMITS.decodeBaseMs + Math.ceil(plan.duration * SCENE_DECODE_LIMITS.decodeMsPerSecond));
    if (!sameManagedFile(before.info, validateManagedSource(root, sourceAsset, {maxBytes}).info)) throw fault('MANAGED_SOURCE_CHANGED');
    const maxFrames = plan.frameCount + SCENE_DECODE_LIMITS.frameTolerance;
    const detector = createSceneDetector({width: plan.width, height: plan.height, options: settings, maxFrames});
    let reported = 0;
    checkGuard(beforeSpawn, attemptSignal);
    await runSceneStreaming('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-noautorotate', '-max_pixels', String(SCENE_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska', '-i', file,
      '-map', `0:${plan.streamIndex}`, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', plan.filter, '-fps_mode', 'passthrough', '-threads', '1',
      '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], {signal: attemptSignal, timeout: SCENE_DECODE_LIMITS.idleMs, maxStdoutBytes: maxFrames * detector.frameBytes,
      onStdout(chunk: Buffer): void {
        detector.write(chunk);
        if (!onProgress || detector.frames - reported < SCENE_DECODE_LIMITS.progressFrames) return;
        reported = detector.frames;
        onProgress(Object.freeze({...detector.progress(), frameCount: plan.frameCount}));
      }});
    throwIfMediaAborted(attemptSignal);
    const decodedFrames = detector.frames;
    if (Math.abs(decodedFrames - plan.frameCount) > SCENE_DECODE_LIMITS.frameTolerance) throw fault('SCENE_DECODE_INCOMPLETE');
    const result = detector.finish(plan.frameCount);
    await verifiedManagedHash(root, sourceAsset, {signal: attemptSignal, expected: before.info, maxBytes});
    throwIfMediaAborted(attemptSignal);
    return Object.freeze({...result, sourceHash: sourceAsset.sha256, analysis: Object.freeze({width: plan.width, height: plan.height, decodedFrames})});
  } catch (error) {
    if (timedOut) {
      const timeout = fault('SCENE_ATTEMPT_TIMEOUT');
      if (property(error, 'terminationUnconfirmed')) timeout.terminationUnconfirmed = true;
      throw timeout;
    }
    // Never hide the shared runner's unconfirmed-child spawn gate.
    if (property(error, 'terminationUnconfirmed')) throw error;
    if (attemptSignal.aborted) throw interruptedMediaError();
    throw error;
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
}
