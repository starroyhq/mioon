import path from 'node:path';
import { FRAME_LIMITS, FRAME_PROFILE, FRAME_PROFILE_ID } from '@mioon/contracts';
import { mediaConfigurationError } from './media-environment.ts';
import { interruptedMediaError, throwIfMediaAborted } from './media-processes.ts';
import { run, runStreaming } from './media-runtime.ts';
import { parseProbeOutput, withProbePermit } from './media-probe.ts';
import type { ProbeResult, ProbeStream } from './media-probe.ts';
import { sameManagedFile, validateManagedSource, verifiedManagedHash } from './managed-media.ts';
import { validatePng } from './images/png.ts';
import type { PngMetadata } from './images/png.ts';

export const FRAME_DECODE_LIMITS = Object.freeze({
  sourceBytes: FRAME_LIMITS.sourceBytes, duration: FRAME_LIMITS.sourceDuration, sourceEdge: FRAME_LIMITS.sourceMaxEdge,
  sourcePixels: FRAME_LIMITS.sourceMaxPixels, outputEdge: FRAME_LIMITS.resultMaxEdge, outputBytes: FRAME_LIMITS.resultBytes,
  timeBaseDenominator: 1000000000, decodeMs: 120000, attemptMs: 180000,
});
export interface FrameProbePlan {
  readonly streamIndex: number;
  readonly timeBaseNumerator: number;
  readonly timeBaseDenominator: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly sarNumerator: number;
  readonly sarDenominator: number;
}
export interface FrameDecodePlan {
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  readonly probe: FrameProbePlan;
}
export interface FrameProvenance {
  readonly profileId: string;
  readonly selectionRule: string;
  readonly sourceFrame: number;
  readonly fps: number;
  readonly sourceHash: string;
  readonly probe: FrameProbePlan;
}
export interface DecodedManagedFrame {
  readonly bytes: Buffer;
  readonly metadata: PngMetadata;
  readonly provenance: FrameProvenance;
}
export interface DecodeManagedFrameOptions {
  readonly root?: unknown;
  readonly asset?: unknown;
  readonly file?: unknown;
  readonly info?: Record<string, unknown> | null;
  readonly requestedFrame?: unknown;
  readonly signal?: AbortSignal | null;
  readonly beforeSpawn?: (signal: AbortSignal) => unknown;
}
interface FrameFault extends Error { code: string; terminationUnconfirmed?: boolean }

const messages: Readonly<Record<string,string>> = Object.freeze({
  FRAME_PROFILE_UNSUPPORTED: 'This source does not match the supported local frame capture profile.',
  FRAME_NO_FRAME: 'No supported decoded frame exists at or after the requested editing mark.',
  FRAME_OUTPUT_INVALID: 'The local frame decoder did not return one valid PNG image.',
  FRAME_ATTEMPT_TIMEOUT: 'Local frame capture exceeded its time limit.',
  MANAGED_SOURCE_CHANGED: 'The managed media source changed during frame capture.',
});
const fault=(code: string): FrameFault=>Object.assign(new Error(messages[code]??code), { code });
function unsupported(): never {throw fault('FRAME_PROFILE_UNSUPPORTED');}
const object=(value: unknown): value is Record<string, unknown>=>value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteValue=(value: unknown): boolean=>typeof value === 'number' && Number.isFinite(value) ||
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
const zero=(value: unknown): boolean=>finiteValue(value) && Number(value) === 0;
const positiveDuration=(value: unknown): boolean=>finiteValue(value) && Number(value) > 0 && Number(value) <= FRAME_DECODE_LIMITS.duration;
const safeInteger=(value: unknown): number | null=>Number.isSafeInteger(value)?value as number:null;
const stringValue=(value: unknown): string | null=>typeof value==='string'?value:null;
const property=(value: unknown,key: string): unknown=>value!==null&&typeof value==='object'&&key in value?(value as Record<string,unknown>)[key]:undefined;

function noOrientation(record: Record<string, unknown>): void {
  if (record.tags !== undefined && (!object(record.tags) || Object.keys(record.tags).some(key => /^(rotate|rotation)$/i.test(key)))) unsupported();
  if (record.side_data_list === undefined) return;
  if (!Array.isArray(record.side_data_list) || record.side_data_list.length > 256) unsupported();
  for (const entry of record.side_data_list as unknown[]) {
    if (!object(entry) || Object.hasOwn(entry, 'rotation') || Object.hasOwn(entry, 'displaymatrix') ||
      /display\s*matrix/i.test(String(entry.side_data_type))) unsupported();
  }
}

/** Capture-only profile. Nothing here changes general editor import/decode rules.
 * The mark N/30 is an editing time, never a source frame index. The threshold is
 * exact integer arithmetic, so decimal formatting cannot skip a CFR boundary.
 */
export function frameDecodePlan(metadata: ProbeResult, { mimeType, requestedFrame }: { mimeType?: unknown; requestedFrame?: unknown } = {}): FrameDecodePlan {
  if (!Number.isSafeInteger(requestedFrame) || (requestedFrame as number) < 0 || (requestedFrame as number) >= FRAME_DECODE_LIMITS.duration * 30) throw mediaConfigurationError();
  const probe = metadata?.probe;
  if (!object(probe) || !Array.isArray(probe.streams) || !probe.streams.length || probe.streams.length > 256) unsupported();
  const expectedContainer = mimeType === 'video/mp4' ? 'mov' : mimeType === 'video/webm' ? 'matroska' : null;
  const format=probe.format;
  if (!object(format)) unsupported();
  if (!expectedContainer || typeof format.format_name !== 'string' || !format.format_name.split(',').includes(expectedContainer)) unsupported();
  if (!zero(format.start_time) || !positiveDuration(format.duration)) unsupported();
  noOrientation(format);
  const indexes = new Set<number>();
  for (const stream of probe.streams) {
    if (!object(stream)) unsupported();
    const index=safeInteger(stream.index);
    if (index===null || index < 0 || index > 255 || indexes.has(index)) unsupported();
    indexes.add(index);
    if (stream.disposition !== undefined) {
      if (!object(stream.disposition)) unsupported();
      const attached=stream.disposition.attached_pic;
      if (attached !== undefined && ![0, 1].includes(attached as number)) unsupported();
    }
  }
  const candidates = probe.streams.filter(stream => stream.codec_type === 'video' && !attachedPicture(stream));
  if (candidates.length !== 1) unsupported();
  const video = candidates[0] as ProbeStream;
  const width=safeInteger(video.width),height=safeInteger(video.height);
  if(width===null||height===null)unsupported();
  const codec=stringValue(video.codec_name);
  if (codec===null||!['h264', 'vp8', 'vp9'].includes(codec) || video.pix_fmt !== 'yuv420p') unsupported();
  // VP8/VP9 bitstreams are progressive-only; their ffprobe field_order may be
  // absent/unknown. H.264 must explicitly report progressive field coding.
  const fieldOrder=video.field_order;
  if (fieldOrder !== 'progressive' && (codec === 'h264' || !(fieldOrder === undefined || fieldOrder === 'unknown'))) unsupported();
  for (const key of ['bits_per_raw_sample', 'bits_per_sample']) {
    const sample=video[key];
    if (sample !== undefined && sample !== 'N/A' && (!finiteValue(sample) || ![0, 8].includes(Number(sample)))) unsupported();
  }
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= FRAME_DECODE_LIMITS.sourceEdge) || width * height > FRAME_DECODE_LIMITS.sourcePixels) unsupported();
  if (!zero(video.start_time) || video.start_pts !== undefined && !zero(video.start_pts)) unsupported();
  if (video.duration !== undefined && video.duration !== 'N/A' && !positiveDuration(video.duration)) unsupported();
  const duration = Math.min(Number(format.duration), video.duration === undefined || video.duration === 'N/A' ? Infinity : Number(video.duration));
  if ((requestedFrame as number) / 30 >= duration) throw fault('FRAME_NO_FRAME');
  const sampleAspectRatio=stringValue(video.sample_aspect_ratio);
  const sar = sampleAspectRatio!==null ? /^(\d{1,10}):(\d{1,10})$/.exec(sampleAspectRatio) : null;
  if (!sar || !Number.isSafeInteger(Number(sar[1])) || Number(sar[1]) <= 0 || Number(sar[1]) > 1000000000 || Number(sar[1]) !== Number(sar[2])) unsupported();
  noOrientation(video);
  const timeBaseText=stringValue(video.time_base);
  const timeBase = timeBaseText!==null ? /^1\/([1-9]\d{0,9})$/.exec(timeBaseText) : null;
  const denominator = timeBase ? Number(timeBase[1]) : NaN;
  if (!Number.isSafeInteger(denominator) || denominator > FRAME_DECODE_LIMITS.timeBaseDenominator) unsupported();
  const requestedFrameNumber=requestedFrame as number;
  const threshold = (BigInt(requestedFrameNumber) * BigInt(denominator) + 29n) / 30n;
  const ratio = Math.min(1, FRAME_DECODE_LIMITS.outputEdge / Math.max(width, height));
  const outputWidth = Math.max(1, Math.round(width * ratio)), outputHeight = Math.max(1, Math.round(height * ratio));
  // select treats NaN as a selected output. Nested ifs, rather than multiplying
  // boolean guards by pts, are essential for absent timestamps to remain false.
  // Compare the *actual filter input* TB with the probed rational before using
  // the integer threshold. The bounded integer PTS values are exactly doubles.
  const select = `if(eq(TB,1/${denominator}),if(isnan(pts),0,if(eq(interlace_type,PROGRESSIVE),between(pts,${threshold},${FRAME_DECODE_LIMITS.duration * denominator}),0)),0)`;
  return {
    width: outputWidth, height: outputHeight,
    filter: `select='${select}',${frameCaptureOutputFilter(outputWidth,outputHeight)}`,
    probe: { streamIndex: safeInteger(video.index) ?? 0, timeBaseNumerator: 1, timeBaseDenominator: denominator,
      width, height, rotation: 0, sarNumerator: 1, sarDenominator: 1 },
  };
}
/** Everything after frame selection: the capture profile's scale and pixel
 * format. Storyboard keyframes share it, so both PNGs come out identically. */
export const frameCaptureOutputFilter=(width: number,height: number): string=>`scale=${width}:${height}:flags=bilinear,setsar=1,format=rgb24`;
function attachedPicture(stream: ProbeStream): unknown {
  const disposition=stream.disposition;
  return object(disposition)?disposition.attached_pic:undefined;
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

/** One bounded, nonpublishing managed-video -> PNG attempt.
 * The caller supplies an owned asset, absolute verified path and stat snapshot,
 * and owns its project/lock/publication fence. beforeSpawn must be synchronous.
 * It receives the exact decoder-created attempt signal registered with child
 * processes, for scoped shutdown/close tracking. The external caller signal is
 * only a cancellation input and cannot substitute for that registered signal.
 * Hash and pathname/descriptor identity checks bracket probe+decode; same-UID
 * mutation can still race the decoder's pathname open. This is not a sandbox.
 * The attempt budget excludes the shared runner's separately bounded reap time.
 */
export async function decodeManagedFrame({ root, asset, file, info, requestedFrame, signal, beforeSpawn }: DecodeManagedFrameOptions = {}): Promise<DecodedManagedFrame> {
  throwIfMediaAborted(signal);
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') ||
    !object(asset) || !info || beforeSpawn !== undefined && typeof beforeSpawn !== 'function' ||
    !Number.isSafeInteger(requestedFrame) || (requestedFrame as number) < 0 || (requestedFrame as number) >= FRAME_DECODE_LIMITS.duration * 30) throw mediaConfigurationError();
  if (!['video/mp4', 'video/webm'].includes(String(asset.mimeType))) unsupported();
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw fault('MANAGED_SOURCE_CHANGED');
  // Hold immutable source identity across awaits even if a caller changes its
  // in-memory row object. The caller separately fences current persisted state.
  const sourceAsset = { relativePath: asset.relativePath, sha256: asset.sha256, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
  const expected = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]])) as unknown as import('./managed-media.ts').ManagedFileIdentity;
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FRAME_DECODE_LIMITS.attemptMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const attemptSignal = controller.signal;
  const frame=requestedFrame as number;
  try {
    const before = await verifiedManagedHash(root, sourceAsset, { signal: attemptSignal, expected, maxBytes: FRAME_DECODE_LIMITS.sourceBytes });
    if (file !== before.file || sourceAsset.sizeBytes !== undefined && sourceAsset.sizeBytes !== before.sizeBytes) throw fault('MANAGED_SOURCE_CHANGED');
    const metadata = await withProbePermit(attemptSignal, async () => {
      if (!sameManagedFile(before.info, validateManagedSource(root, sourceAsset, { maxBytes: FRAME_DECODE_LIMITS.sourceBytes }).info)) throw fault('MANAGED_SOURCE_CHANGED');
      checkGuard(beforeSpawn, attemptSignal);
      const output = await run('ffprobe', ['-v', 'error', '-threads', '1', '-max_pixels', String(FRAME_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'mov,matroska', '-show_format', '-show_streams', '-of', 'json', file], { signal: attemptSignal, timeout: FRAME_DECODE_LIMITS.decodeMs });
      throwIfMediaAborted(attemptSignal);
      return parseProbeOutput(output);
    });
    const plan = frameDecodePlan(metadata, { mimeType: sourceAsset.mimeType, requestedFrame: frame });
    if (!sameManagedFile(before.info, validateManagedSource(root, sourceAsset, { maxBytes: FRAME_DECODE_LIMITS.sourceBytes }).info)) throw fault('MANAGED_SOURCE_CHANGED');
    // A fixed byte buffer also bounds bookkeeping if a hostile executable
    // emits millions of tiny chunks; a chunk array would not have that bound.
    const outputBytes = Buffer.allocUnsafe(FRAME_DECODE_LIMITS.outputBytes);
    let outputOffset = 0;
    checkGuard(beforeSpawn, attemptSignal);
    const result = await runStreaming('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-noautorotate', '-copyts', '-max_pixels', String(FRAME_DECODE_LIMITS.sourcePixels), '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska', '-i', file,
      '-map', `0:${plan.probe.streamIndex}`, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:v:0', '-1', '-map_chapters', '-1',
      '-vf', plan.filter, '-frames:v', '1', '-fps_mode', 'passthrough', '-threads', '1',
      '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2pipe', 'pipe:1',
    ], { signal: attemptSignal, timeout: FRAME_DECODE_LIMITS.decodeMs, maxStdoutBytes: FRAME_DECODE_LIMITS.outputBytes,
      onStdout(chunk: Buffer) { chunk.copy(outputBytes, outputOffset); outputOffset += chunk.length; } });
    throwIfMediaAborted(attemptSignal);
    if (!result.stdoutBytes) throw fault('FRAME_NO_FRAME');
    const bytes = outputBytes.subarray(0, result.stdoutBytes);
    let output: PngMetadata;
    try { output = await validatePng(bytes, { width: plan.width, height: plan.height, opaque: true, signal: attemptSignal }); }
    catch { throwIfMediaAborted(attemptSignal); throw fault('FRAME_OUTPUT_INVALID'); }
    await verifiedManagedHash(root, sourceAsset, { signal: attemptSignal, expected: before.info, maxBytes: FRAME_DECODE_LIMITS.sourceBytes });
    throwIfMediaAborted(attemptSignal);
    return { bytes, metadata: output, provenance: { profileId: FRAME_PROFILE_ID, selectionRule: FRAME_PROFILE.selectionRule,
      sourceFrame: frame, fps: 30, sourceHash: sourceAsset.sha256, probe: plan.probe } };
  } catch (error) {
    if (timedOut) {
      const timeout = fault('FRAME_ATTEMPT_TIMEOUT');
      if (property(error,'terminationUnconfirmed')) timeout.terminationUnconfirmed = true;
      throw timeout;
    }
    // Never hide the shared runner's unconfirmed-child spawn gate, including
    // when cancellation raced a different error.
    if (property(error,'terminationUnconfirmed')) throw error;
    if (attemptSignal.aborted) throw interruptedMediaError();
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
