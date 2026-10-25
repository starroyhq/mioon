import path from 'node:path';
import {FRAME_LIMITS, FRAME_PROFILE_ID, FRAME_SELECTION_RULE} from '@mioon/contracts';
import {FRAME_DECODE_LIMITS, frameCaptureOutputFilter, frameDecodePlan} from './frame-decoder.ts';
import type {FrameProbePlan} from './frame-decoder.ts';
import {mediaConfigurationError} from './media-environment.ts';
import {interruptedMediaError, throwIfMediaAborted} from './media-processes.ts';
import {run, runStreaming} from './media-runtime.ts';
import {parseProbeOutput, withProbePermit} from './media-probe.ts';
import {sameManagedFile, validateManagedSource, verifiedManagedHash} from './managed-media.ts';
import type {ManagedFileIdentity} from './managed-media.ts';

export const SCENE_KEYFRAME_DECODE_LIMITS = Object.freeze({
  sourceBytes: FRAME_DECODE_LIMITS.sourceBytes, sourcePixels: FRAME_DECODE_LIMITS.sourcePixels, outputBytes: FRAME_LIMITS.resultBytes,
  // Hashing and both probes; then a decode budget of 1.5x real time on top.
  prepareMs: 120000, decodeBaseMs: 120000, decodeMsPerSecond: 1500,
  // Packet timestamps of the longest source at a high frame rate.
  packets: FRAME_LIMITS.sourceDuration * 240, packetListBytes: 4 * 1024 * 1024,
  frames: 100,
});
export interface SceneKeyframe {
  /** Output order: distinct source frames by presentation time. */
  readonly index: number;
  /** Positions in the requested marks this one frame answers. */
  readonly marks: readonly number[];
  readonly bytes: Buffer;
}
export interface DecodedSceneKeyframes {
  readonly profileId: typeof FRAME_PROFILE_ID;
  readonly selectionRule: typeof FRAME_SELECTION_RULE;
  readonly sourceHash: string;
  readonly width: number;
  readonly height: number;
  readonly probe: FrameProbePlan;
  /** For each requested mark, the output frame that holds it. */
  readonly frameOf: readonly number[];
}
export interface DecodeSceneKeyframesOptions {
  readonly root?: unknown;
  readonly asset?: unknown;
  readonly file?: unknown;
  readonly info?: Record<string, unknown> | null;
  /** Strictly increasing 30 fps editing marks. */
  readonly marks?: readonly number[];
  readonly signal?: AbortSignal | null;
  readonly beforeSpawn?: (signal: AbortSignal) => unknown;
  /** Synchronous; called once per output frame, in order, as it arrives. */
  readonly onFrame?: (frame: SceneKeyframe) => void;
}
interface KeyframeFault extends Error {code: string; terminationUnconfirmed?: boolean}

const messages: Readonly<Record<string, string>> = Object.freeze({
  FRAME_PROFILE_UNSUPPORTED: 'This source does not match the supported local frame capture profile.',
  FRAME_NO_FRAME: 'No supported decoded frame exists at or after a requested editing mark.',
  FRAME_OUTPUT_INVALID: 'The local frame decoder did not return the requested PNG images.',
  FRAME_ATTEMPT_TIMEOUT: 'Local keyframe capture exceeded its time limit.',
  MANAGED_SOURCE_CHANGED: 'The managed media source changed during keyframe capture.',
});
const fault = (code: string): KeyframeFault => Object.assign(new Error(messages[code] ?? code), {code});
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const property = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Splits ffmpeg's image2pipe PNG stream at each IEND chunk. Every image is
 * bounded by the frame profile's byte limit; the caller validates content. */
export function createPngStreamSplitter(maxBytes: number, onImage: (bytes: Buffer) => void): {write(chunk: Buffer): void; finish(): void} {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let length = 0, scanned = 0;
  function drain(): void {
    for (;;) {
      if (length < PNG_SIGNATURE.length) return;
      if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw fault('FRAME_OUTPUT_INVALID');
      scanned = Math.max(scanned, PNG_SIGNATURE.length);
      let complete = -1;
      while (scanned + 8 <= length) {
        const size = buffer.readUInt32BE(scanned), end = scanned + 12 + size;
        if (size > maxBytes || end > maxBytes) throw fault('FRAME_OUTPUT_INVALID');
        if (end > length) break;
        const type = buffer.toString('latin1', scanned + 4, scanned + 8);
        scanned = end;
        if (type === 'IEND') {complete = end; break;}
      }
      if (complete < 0) return;
      onImage(Buffer.from(buffer.subarray(0, complete)));
      buffer.copy(buffer, 0, complete, length);
      length -= complete; scanned = 0;
    }
  }
  return {
    write(chunk: Buffer): void {
      let offset = 0;
      while (offset < chunk.length) {
        const room = maxBytes - length;
        if (room <= 0) throw fault('FRAME_OUTPUT_INVALID');
        const take = Math.min(room, chunk.length - offset);
        chunk.copy(buffer, length, offset, offset + take);
        length += take; offset += take;
        drain();
      }
    },
    finish(): void {if (length) throw fault('FRAME_OUTPUT_INVALID');},
  };
}

/** For each editing mark N, frame capture's threshold ceil(N * den / 30) and
 * then the first presented packet timestamp at or after it. Marks between the
 * same two source frames resolve to the same timestamp. */
export function keyframeTargets(marks: readonly number[], denominator: number, packetPts: readonly number[]): {targets: number[]; frameOf: number[]} {
  const presented = [...new Set(packetPts)].sort((a, b) => a - b), targets: number[] = [], frameOf: number[] = [];
  let cursor = 0;
  for (const mark of marks) {
    const threshold = Number((BigInt(mark) * BigInt(denominator) + 29n) / 30n);
    while (cursor < presented.length && presented[cursor]! < threshold) cursor++;
    const pts = presented[cursor];
    if (pts === undefined) throw fault('FRAME_NO_FRAME');
    if (targets.at(-1) !== pts) targets.push(pts);
    frameOf.push(targets.length - 1);
  }
  return {targets, frameOf};
}

function parsePacketList(output: string): number[] {
  const values: number[] = [];
  for (const line of output.split('\n')) {
    const text = line.trim().replace(/,+$/u, '');
    if (!text || text === 'N/A') continue;
    // Leading packets of an edit list may sit before zero; no mark selects them.
    if (!/^-?\d{1,16}$/u.test(text)) throw fault('FRAME_PROFILE_UNSUPPORTED');
    const value = Number(text);
    if (!Number.isSafeInteger(value) || values.length >= SCENE_KEYFRAME_DECODE_LIMITS.packets) throw fault('FRAME_PROFILE_UNSUPPORTED');
    values.push(value);
  }
  return values;
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

/** One bounded, nonpublishing managed-video -> keyframe PNGs attempt: frame
 * capture's profile, rule and output size, for several marks in one decode.
 * Packet timestamps are listed first, so every mark names one exact source
 * frame and the decode selects precisely those frames; nothing is seeked.
 * Hash and identity checks bracket both probes and the decode, as for frame
 * capture. beforeSpawn must be synchronous and receives the attempt signal
 * registered with child processes. PNG content is validated by the caller.
 */
export async function decodeSceneKeyframes({root, asset, file, info, marks, signal, beforeSpawn, onFrame}: DecodeSceneKeyframesOptions = {}): Promise<DecodedSceneKeyframes> {
  throwIfMediaAborted(signal);
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') ||
    !object(asset) || !info || beforeSpawn !== undefined && typeof beforeSpawn !== 'function' || typeof onFrame !== 'function' ||
    !Array.isArray(marks) || !marks.length || marks.length > SCENE_KEYFRAME_DECODE_LIMITS.frames ||
    marks.some((mark, index) => !Number.isSafeInteger(mark) || mark < 0 || mark >= FRAME_DECODE_LIMITS.duration * 30 || index > 0 && mark <= marks[index - 1]!)) throw mediaConfigurationError();
  if (!['video/mp4', 'video/webm'].includes(String(asset.mimeType))) throw fault('FRAME_PROFILE_UNSUPPORTED');
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw fault('MANAGED_SOURCE_CHANGED');
  const sourceAsset = {relativePath: asset.relativePath, sha256: asset.sha256, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes};
  const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]])) as unknown as ManagedFileIdentity;
  const controller = new AbortController(), abort = (): void => controller.abort();
  let timedOut = false;
  const deadline = (ms: number): ReturnType<typeof setTimeout> => setTimeout(() => {timedOut = true; controller.abort();}, ms);
  let timer = deadline(SCENE_KEYFRAME_DECODE_LIMITS.prepareMs);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const attemptSignal = controller.signal, maxBytes = SCENE_KEYFRAME_DECODE_LIMITS.sourceBytes;
  try {
    const before = await verifiedManagedHash(root, sourceAsset, {signal: attemptSignal, expected, maxBytes});
    if (file !== before.file || sourceAsset.sizeBytes !== undefined && sourceAsset.sizeBytes !== before.sizeBytes) throw fault('MANAGED_SOURCE_CHANGED');
    const same = (): void => {if (!sameManagedFile(before.info, validateManagedSource(root, sourceAsset, {maxBytes}).info)) throw fault('MANAGED_SOURCE_CHANGED');};
    const probeArgs = ['-v', 'error', '-threads', '1', '-max_pixels', String(SCENE_KEYFRAME_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska'];
    const {metadata, packets} = await withProbePermit(attemptSignal, async () => {
      same(); checkGuard(beforeSpawn, attemptSignal);
      const probed = parseProbeOutput(await run('ffprobe', [...probeArgs, '-show_format', '-show_streams', '-of', 'json', file], {signal: attemptSignal, timeout: SCENE_KEYFRAME_DECODE_LIMITS.prepareMs}));
      throwIfMediaAborted(attemptSignal);
      // The profile check also names the one video stream to list.
      const stream = frameDecodePlan(probed, {mimeType: sourceAsset.mimeType, requestedFrame: marks.at(-1)}).probe.streamIndex;
      same(); checkGuard(beforeSpawn, attemptSignal);
      const listed = await run('ffprobe', [...probeArgs, '-select_streams', String(stream), '-show_entries', 'packet=pts', '-of', 'csv=p=0', file],
        {signal: attemptSignal, timeout: SCENE_KEYFRAME_DECODE_LIMITS.prepareMs, maxStdoutBytes: SCENE_KEYFRAME_DECODE_LIMITS.packetListBytes});
      throwIfMediaAborted(attemptSignal);
      return {metadata: probed, packets: parsePacketList(listed)};
    });
    const plan = frameDecodePlan(metadata, {mimeType: sourceAsset.mimeType, requestedFrame: marks.at(-1)});
    const denominator = plan.probe.timeBaseDenominator, {targets, frameOf} = keyframeTargets(marks, denominator, packets);
    const duration = Number(metadata.probe.format?.duration);
    clearTimeout(timer);
    const decodeMs = SCENE_KEYFRAME_DECODE_LIMITS.decodeBaseMs + Math.ceil(duration * SCENE_KEYFRAME_DECODE_LIMITS.decodeMsPerSecond);
    timer = deadline(SCENE_KEYFRAME_DECODE_LIMITS.prepareMs + decodeMs);
    same();
    // The capture filter's guards: the probed time base, a present timestamp and
    // progressive coding, then exact presented timestamps instead of a threshold.
    const select = `if(eq(TB,1/${denominator}),if(isnan(pts),0,if(eq(interlace_type,PROGRESSIVE),gt(${targets.map(pts => `eq(pts,${pts})`).join('+')},0),0)),0)`;
    const owners = targets.map((_, index) => marks.flatMap((_mark, position) => frameOf[position] === index ? [position] : []));
    let delivered = 0;
    const splitter = createPngStreamSplitter(SCENE_KEYFRAME_DECODE_LIMITS.outputBytes, bytes => {
      if (delivered >= targets.length) throw fault('FRAME_OUTPUT_INVALID');
      onFrame({index: delivered, marks: owners[delivered]!, bytes});delivered++;
    });
    checkGuard(beforeSpawn, attemptSignal);
    await runStreaming('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-noautorotate', '-copyts', '-max_pixels', String(SCENE_KEYFRAME_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska', '-i', file,
      '-map', `0:${plan.probe.streamIndex}`, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:v:0', '-1', '-map_chapters', '-1',
      '-vf', `select='${select}',${frameCaptureOutputFilter(plan.width, plan.height)}`, '-frames:v', String(targets.length), '-fps_mode', 'passthrough', '-threads', '1',
      '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2pipe', 'pipe:1',
    ], {signal: attemptSignal, timeout: decodeMs, maxStdoutBytes: targets.length * SCENE_KEYFRAME_DECODE_LIMITS.outputBytes,
      onStdout(chunk: Buffer): void {splitter.write(chunk);}});
    throwIfMediaAborted(attemptSignal);
    splitter.finish();
    if (delivered !== targets.length) throw fault(delivered ? 'FRAME_OUTPUT_INVALID' : 'FRAME_NO_FRAME');
    await verifiedManagedHash(root, sourceAsset, {signal: attemptSignal, expected: before.info, maxBytes});
    throwIfMediaAborted(attemptSignal);
    return Object.freeze({profileId: FRAME_PROFILE_ID, selectionRule: FRAME_SELECTION_RULE, sourceHash: sourceAsset.sha256,
      width: plan.width, height: plan.height, probe: plan.probe, frameOf: Object.freeze([...frameOf])});
  } catch (error) {
    if (timedOut) {
      const timeout = fault('FRAME_ATTEMPT_TIMEOUT');
      if (property(error, 'terminationUnconfirmed')) timeout.terminationUnconfirmed = true;
      throw timeout;
    }
    // Never hide the shared runner's unconfirmed-child spawn gate.
    if (property(error, 'terminationUnconfirmed')) throw error;
    if (attemptSignal.aborted) throw interruptedMediaError();
    throw error;
  } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
}
