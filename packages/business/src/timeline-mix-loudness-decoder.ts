import {volumeEnvelopeField} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import type {TimelineVolumeEnvelopeClip} from '../../contracts/src/timeline-volume-envelope-processing.ts';
import {assertVolumeEnvelopeSource} from './timeline-volume-envelope-source.ts';
import path from 'node:path';
import {timelineCompositionSegments} from '@mioon/contracts/timeline-segments';
import {parseTimelineAudioPreviewProbe} from './timeline-audio-preview-decoder.ts';
import type {TimelineAudioPreviewSourceProbe} from './timeline-audio-preview-decoder.ts';
import {timelineAudioSilenceFilter, timelineClipAudioFilter, timelineMixedAudioFilter} from './timeline-audio-filter-graph.ts';

/** One pass streams at most 230,400,000 bytes. The service admits both real
 * passes together and retains its media permit until actual child settlement. */
export const TIMELINE_MIX_LOUDNESS_DECODE_LIMITS = Object.freeze({
  sampleRate: 48000, channels: 2, samplesPerFrame: 1600, outputFrames: 18000,
  maxSegments: 200, decodeWorkFrames: 36000, pcmBytes: 230400000,
  totalTwoPassDecodeWorkFrames: 72000, totalTwoPassPcmBytes: 460800000,
  timeoutMs: 120000, sourceSeconds: 600, sourceBytes: 512 * 1024 * 1024,
  probeBytes: 128 * 1024, probeTimeoutMs: 10000, stderrBytes: 64 * 1024, checkpointBytes: 64 * 1024,
} as const);
const LIMITS = TIMELINE_MIX_LOUDNESS_DECODE_LIMITS, FRAME_BYTES = 8;
type DecodeError = Error & {code: string; terminationUnconfirmed?: boolean};
const failure = (code: string, message: string): DecodeError => Object.assign(new Error(message), {code});
const configuration = (): DecodeError => failure('MEDIA_INVALID_CONFIGURATION', 'Invalid saved mix decode configuration.');
const invalidPcm = (): DecodeError => failure('TIMELINE_MIX_LOUDNESS_INVALID_PCM', 'The saved mix did not produce complete finite audio frames.');
const mismatch = (): DecodeError => failure('TIMELINE_MIX_LOUDNESS_SAMPLE_COUNT_MISMATCH', 'The saved mix did not produce its exact complete frame count.');
const budget = (): DecodeError => failure('TIMELINE_MIX_LOUDNESS_BUDGET', 'The saved mix exceeded its fixed operation budget.');
const unsupported = (): DecodeError => failure('TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT', 'An audible source does not have the supported local audio format.');
const metadataMismatch = (): DecodeError => failure('TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH', 'A source audio presence does not match its saved metadata.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: number, min: number, max: number): boolean => Number.isSafeInteger(value) && value >= min && value <= max;
const seconds = (frames: number): string => (frames / 30).toFixed(9);

export interface TimelineMixLoudnessTrack {
  readonly id: string; readonly kind: 'video' | 'audio'; readonly orderIndex: number;
  readonly hidden: boolean; readonly muted: boolean;
}
export interface TimelineMixLoudnessClip extends TimelineVolumeEnvelopeClip {
  readonly id: string; readonly trackId: string; readonly assetId: string;
  readonly startFrame: number; readonly durationFrames: number; readonly sourceInFrame: number;
  readonly gain: number; readonly fadeInFrames?: number; readonly fadeOutFrames?: number;
}
export interface TimelineMixLoudnessTimeline {
  readonly fps: 30; readonly durationFrames: number;
  readonly tracks: readonly TimelineMixLoudnessTrack[]; readonly clips: readonly TimelineMixLoudnessClip[];
}
/** Backend-validated managed paths only, never projected from the public DTO.
 * file is ignored by the pure resource planner, permitting pre-I/O admission. */
export interface TimelineMixLoudnessAsset {
  readonly file: string; readonly mimeType: string; readonly duration: number | null;
  readonly hasAudio: boolean; readonly audioStreamIndex?: number;
}
export interface TimelineMixLoudnessDecodePlan {
  readonly sampleFrames: number; readonly pcmBytes: number;
  readonly segmentCount: number; readonly decodeWorkFrames: number;
}
export interface TimelineMixLoudnessDecodedPcm extends TimelineMixLoudnessDecodePlan {
  readonly sampleRate: 48000; readonly channels: 2;
}
export interface TimelineMixLoudnessDecodeOptions {
  readonly signal?: AbortSignal;
  /** Synchronous service-owned full saved revision/file identity/owner fence. */
  readonly beforeEffect: () => void;
  /** The service's one absolute 120-second deadline spans both real passes,
   * hashes, meter work and cleanup. Its signal also cancels queued probes. */
  readonly remainingMs: () => number;
  /** Synchronous borrowed chunks; keep meter state across segment boundaries.
   * Returning a promise is invalid. No chunk or full PCM is retained here. */
  readonly onPcm: (chunk: Buffer) => void;
}
export interface TimelineMixLoudnessRunOptions {
  readonly signal?: AbortSignal; readonly timeout: number;
  readonly maxStdoutBytes: number; readonly maxStderrBytes: number;
  readonly beforeSpawn: () => void; readonly beforeEffect: () => void;
}
export interface TimelineMixLoudnessDecoderRuntime {
  run(command: string, args: string[], options: TimelineMixLoudnessRunOptions): Promise<unknown>;
  runStreaming(command: string, args: string[], options: TimelineMixLoudnessRunOptions & {onStdout: (chunk: Buffer) => void}): Promise<unknown>;
  withProbePermit<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
  checkMediaEffect(beforeEffect: () => void, signal?: AbortSignal): void;
}
export type TimelineMixLoudnessDecoder = (timeline: TimelineMixLoudnessTimeline,
  assets: ReadonlyMap<string, TimelineMixLoudnessAsset>, options: TimelineMixLoudnessDecodeOptions) => Promise<TimelineMixLoudnessDecodedPcm>;
interface Segment {
  readonly beginFrame: number; readonly endFrame: number;
  readonly clips: readonly TimelineMixLoudnessClip[];
}
interface Prepared extends TimelineMixLoudnessDecodePlan {
  readonly segments: readonly Segment[];
  /** Presence must be observed even for saved false video metadata: export
   * obtains hasAudio from the managed source probe, not this stored flag. */
  readonly observedClips: readonly TimelineMixLoudnessClip[];
}

function prepare(timeline: TimelineMixLoudnessTimeline, assets: ReadonlyMap<string, TimelineMixLoudnessAsset>): Prepared {
  if (!object(timeline) || timeline.fps !== 30 || !integer(timeline.durationFrames, 1, LIMITS.outputFrames) ||
      !Array.isArray(timeline.tracks) || timeline.tracks.length < 1 || timeline.tracks.length > 12 ||
      !Array.isArray(timeline.clips) || timeline.clips.length < 1 || timeline.clips.length > 100 || !(assets instanceof Map) || assets.size > 100) throw configuration();
  const savedTracks: readonly TimelineMixLoudnessTrack[] = timeline.tracks;
  const savedClips: readonly TimelineMixLoudnessClip[] = timeline.clips;
  const savedAssets: ReadonlyMap<string, TimelineMixLoudnessAsset> = assets;
  const tracks = new Map<string, TimelineMixLoudnessTrack>();
  for (const track of savedTracks) {
    if (!object(track) || typeof track.id !== 'string' || !track.id || tracks.has(track.id) || !['audio', 'video'].includes(track.kind) ||
        !Number.isSafeInteger(track.orderIndex) || typeof track.hidden !== 'boolean' || typeof track.muted !== 'boolean' || track.kind === 'audio' && track.hidden) throw configuration();
    tracks.set(track.id, track);
  }
  const ids = new Set<string>();
  let finalFrame = 0;
  for (const clip of savedClips) {
    if (!object(clip) || typeof clip.id !== 'string' || !clip.id || ids.has(clip.id) ||
        !tracks.has(clip.trackId) || !assets.has(clip.assetId) ||
        !integer(clip.startFrame, 0, LIMITS.outputFrames - 1) || !integer(clip.durationFrames, 1, LIMITS.outputFrames) ||
        clip.startFrame + clip.durationFrames > timeline.durationFrames || !integer(clip.sourceInFrame, 0, Number.MAX_SAFE_INTEGER - LIMITS.outputFrames) ||
        !Number.isFinite(clip.gain) || clip.gain < 0 || clip.gain > 2 ||
        Object.hasOwn(clip, 'fadeInFrames') && typeof clip.fadeInFrames !== 'number' ||
        Object.hasOwn(clip, 'fadeOutFrames') && typeof clip.fadeOutFrames !== 'number' ||
        !integer(clip.fadeInFrames ?? 0, 0, clip.durationFrames) || !integer(clip.fadeOutFrames ?? 0, 0, clip.durationFrames) ||
        (clip.fadeInFrames ?? 0) + (clip.fadeOutFrames ?? 0) > clip.durationFrames ||
        ['transition', 'transitions', 'effects', 'speed', 'rate', 'opacity', 'blendMode'].some(key => Object.hasOwn(clip, key))) throw configuration();
    volumeEnvelopeField(clip);
    const asset = savedAssets.get(clip.assetId)!;
    if (!object(asset) || typeof asset.mimeType !== 'string' || typeof asset.hasAudio !== 'boolean' ||
        asset.audioStreamIndex !== undefined && !integer(asset.audioStreamIndex, 0, Number.MAX_SAFE_INTEGER)) throw configuration();
    if (clip.volumeEnvelope != null && asset.mimeType.startsWith('image/')) throw configuration();
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType);
    const video = ['video/mp4', 'video/webm'].includes(asset.mimeType);
    const audio = ['audio/wav', 'audio/mpeg', 'audio/mp4'].includes(asset.mimeType);
    if (tracks.get(clip.trackId)!.kind === 'video' ? !image && !video : !audio || !asset.hasAudio && clip.volumeEnvelope == null) throw configuration();
    if (image ? clip.sourceInFrame !== 0 || asset.hasAudio :
      typeof asset.duration !== 'number' || !Number.isFinite(asset.duration) || asset.duration <= 0 ||
      clip.sourceInFrame + clip.durationFrames > Math.floor(asset.duration * 30 + 1e-6)) throw configuration();
    if (!asset.hasAudio && clip.volumeEnvelope == null && ((clip.fadeInFrames ?? 0) > 0 || (clip.fadeOutFrames ?? 0) > 0)) throw configuration();
    ids.add(clip.id); finalFrame = Math.max(finalFrame, clip.startFrame + clip.durationFrames);
  }
  if (finalFrame !== timeline.durationFrames) throw configuration();
  for (const track of tracks.values()) {
    const clips = savedClips.filter(clip => clip.trackId === track.id).sort((a, b) => a.startFrame - b.startFrame);
    for (let index = 1; index < clips.length; index++) if (clips[index]!.startFrame < clips[index - 1]!.startFrame + clips[index - 1]!.durationFrames) throw configuration();
  }
  const segments: Segment[] = [];
  let decodeWorkFrames = 0;
  for (const segment of timelineCompositionSegments(timeline)) {
    const clips = savedClips.filter(clip => clip.startFrame <= segment.beginFrame && clip.startFrame + clip.durationFrames >= segment.endFrame &&
      savedAssets.get(clip.assetId)!.hasAudio && !tracks.get(clip.trackId)!.muted && clip.gain > 0)
      .sort((a, b) => tracks.get(a.trackId)!.orderIndex - tracks.get(b.trackId)!.orderIndex || a.id.localeCompare(b.id))
      .map(clip => Object.freeze({...clip, ...volumeEnvelopeField(clip)}));
    decodeWorkFrames += clips.length * (segment.endFrame - segment.beginFrame + 1);
    if (decodeWorkFrames > LIMITS.decodeWorkFrames) throw budget();
    segments.push(Object.freeze({...segment, clips: Object.freeze(clips)}));
  }
  if (segments.length > LIMITS.maxSegments) throw budget();
  const sampleFrames = timeline.durationFrames * LIMITS.samplesPerFrame;
  const observedClips = savedClips.filter(clip => clip.volumeEnvelope != null || !tracks.get(clip.trackId)!.muted && clip.gain > 0 &&
    !savedAssets.get(clip.assetId)!.mimeType.startsWith('image/')).map(clip => Object.freeze({...clip, ...volumeEnvelopeField(clip)}));
  return Object.freeze({sampleFrames, pcmBytes: sampleFrames * FRAME_BYTES, segmentCount: segments.length, decodeWorkFrames,
    segments: Object.freeze(segments), observedClips: Object.freeze(observedClips)});
}

/** No probe, path read, process, meter or PCM allocation in resource admission. */
export function planTimelineMixLoudnessDecode(timeline: TimelineMixLoudnessTimeline,
  assets: ReadonlyMap<string, TimelineMixLoudnessAsset>): TimelineMixLoudnessDecodePlan {
  const {segments: _segments, observedClips: _observedClips, ...plan} = prepare(timeline, assets);
  return Object.freeze(plan);
}

interface ObservedSource {readonly audio: TimelineAudioPreviewSourceProbe | null; readonly durationSeconds: number}
/** Match the renderer's first identified audio presence before trusting the
 * saved flag. Audio still uses the unchanged, narrower audition admission.
 * A genuinely silent video needs bounded, valid local video metadata instead
 * of fabricating an audio stream solely to pass that audio-only parser. */
function parseObservedSource(raw: unknown, asset: TimelineMixLoudnessAsset): ObservedSource {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.probeBytes) throw unsupported();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unsupported(); }
  if (!object(value) || !Array.isArray(value.streams) || value.streams.length < 1 || value.streams.length > 256 ||
      !value.streams.every(object) || !object(value.format) || typeof value.format.format_name !== 'string' ||
      !['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'mp3', 'wav'].includes(value.format.format_name)) throw unsupported();
  const identified = (stream: Record<string, unknown>): boolean => typeof stream.codec_name === 'string' && stream.codec_name.length > 0 && stream.codec_name !== 'unknown';
  const hasAudio = value.streams.some(stream => stream.codec_type === 'audio' && identified(stream));
  if (hasAudio !== asset.hasAudio) throw metadataMismatch();
  if (hasAudio) {
    let audio: TimelineAudioPreviewSourceProbe;
    try { audio = parseTimelineAudioPreviewProbe(raw); } catch { throw unsupported(); }
    if (audio.audioDurationSeconds === 0 || asset.audioStreamIndex !== undefined && asset.audioStreamIndex !== audio.streamIndex) throw unsupported();
    return Object.freeze({audio, durationSeconds: audio.durationSeconds});
  }
  if (!asset.mimeType.startsWith('video/') || !['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'].includes(value.format.format_name)) throw unsupported();
  if (asset.audioStreamIndex !== undefined) throw metadataMismatch();
  const duration = (input: unknown): number | null => {
    if (input === undefined || input === null || input === '' || input === 'N/A') return null;
    if (typeof input !== 'string' && typeof input !== 'number' || typeof input === 'string' &&
        (input.length > 40 || !/^\d+(?:\.\d+)?$/u.test(input))) throw unsupported();
    const result = Number(input);
    if (!Number.isFinite(result) || result < 0 || result > LIMITS.sourceSeconds) throw unsupported();
    return result;
  };
  const indexes = new Set<number>();
  let hasVideo = false;
  for (const stream of value.streams) {
    if (stream.index !== undefined) {
      if (typeof stream.index !== 'number' || !Number.isSafeInteger(stream.index) || stream.index < 0 || indexes.has(stream.index)) throw unsupported();
      indexes.add(stream.index);
    }
    duration(stream.duration);
    for (const key of ['width', 'height']) if (stream[key] !== undefined &&
      (typeof stream[key] !== 'number' || !Number.isSafeInteger(stream[key]) || stream[key] < 0 || stream[key] > 16384)) throw unsupported();
    const width = typeof stream.width === 'number' ? stream.width : 0, height = typeof stream.height === 'number' ? stream.height : 0;
    if (width * height > 64 * 1024 * 1024 || stream.disposition !== undefined && !object(stream.disposition)) throw unsupported();
    if (stream.codec_type === 'video' && identified(stream) && width > 0 && height > 0 &&
        !(object(stream.disposition) && stream.disposition.attached_pic)) hasVideo = true;
  }
  const durationSeconds = duration(value.format.duration), size = value.format.size;
  if (!hasVideo || durationSeconds === null || durationSeconds <= 0 || typeof size !== 'string' || !/^\d{1,16}$/u.test(size) ||
      !Number.isSafeInteger(Number(size)) || Number(size) < 1 || Number(size) > LIMITS.sourceBytes) throw unsupported();
  return Object.freeze({audio: null, durationSeconds});
}

const localInputArgs = (file: string, container?: string): string[] => [
  '-protocol_whitelist', 'file,pipe', '-format_whitelist', container ?? 'mov,matroska,mp3,wav',
  ...(container === undefined || container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
  ...(container ? ['-f', container] : []), '-i', file,
];

/** Exact full float-v2 audio lane, one original global segment at a time.
 * Visual-only, zero-gain and muted edges still reseek every audible source.
 * Actual finite clip gains/fades use the shared export strings, without a
 * normalization, limiter, cached original, output asset or video encoding. */
export function createTimelineMixLoudnessDecoder(runtime: TimelineMixLoudnessDecoderRuntime): TimelineMixLoudnessDecoder {
  return async (timeline, assets, options) => {
    if (!options || typeof options.beforeEffect !== 'function' || typeof options.remainingMs !== 'function' || typeof options.onPcm !== 'function') throw configuration();
    const prepared = prepare(timeline, assets);
    const sourceAssets = new Map<string, TimelineMixLoudnessAsset>();
    for (const clip of prepared.observedClips) {
      const asset = assets.get(clip.assetId)!;
      if (typeof asset.file !== 'string' || !path.isAbsolute(asset.file) || asset.file.includes('\0')) throw configuration();
      sourceAssets.set(clip.assetId, Object.freeze({...asset}));
    }
    let callbackFailure: unknown;
    const remaining = (): number => {
      const value = options.remainingMs();
      if (!Number.isFinite(value) || value > LIMITS.timeoutMs) throw configuration();
      if (value < 1) throw budget();
      return Math.floor(value);
    };
    const fence = (): void => {
      try { runtime.checkMediaEffect(options.beforeEffect, options.signal); remaining(); }
      catch (error) { callbackFailure ??= error; throw error; }
    };
    const runOptions = (bytes: number, cap: number = LIMITS.timeoutMs): TimelineMixLoudnessRunOptions => ({signal: options.signal,
      timeout: Math.min(cap, remaining()), maxStdoutBytes: bytes, maxStderrBytes: LIMITS.stderrBytes, beforeSpawn: fence, beforeEffect: fence});
    try {
      fence();
      const sources = new Map<string, TimelineAudioPreviewSourceProbe>();
      for (const [assetId, asset] of sourceAssets) {
        fence();
        const source = await runtime.withProbePermit(options.signal, async () => {
          fence();
          const raw = await runtime.run('ffprobe', ['-v', 'error', '-show_entries',
            'format=format_name,duration,size:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration,width,height:stream_disposition=attached_pic',
            '-of', 'json', ...localInputArgs(asset.file)], runOptions(LIMITS.probeBytes, LIMITS.probeTimeoutMs));
          fence();
          return parseObservedSource(raw, asset);
        });
        fence();
        if (prepared.observedClips.some(clip => clip.assetId === assetId &&
          clip.sourceInFrame + clip.durationFrames > Math.floor(source.durationSeconds * 30 + 1e-6)))
          throw failure('TIMELINE_MIX_LOUDNESS_SOURCE_BOUNDS', 'A potentially audible saved interval exceeds its verified source duration.');
        for (const clip of prepared.observedClips) if (clip.assetId === assetId)
          assertVolumeEnvelopeSource(clip, {mimeType: asset.mimeType, audio: source.audio});
        if (source.audio) sources.set(assetId, source.audio);
      }
      let bytesSeen = 0;
      const residual = Buffer.allocUnsafe(FRAME_BYTES);
      for (const segment of prepared.segments) {
        fence();
        const frames = segment.endFrame - segment.beginFrame, samples = frames * LIMITS.samplesPerFrame, partBytes = samples * FRAME_BYTES;
        let partSeen = 0, residualBytes = 0;
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-filter_complex_threads', '1'];
        const filters = [timelineAudioSilenceFilter(samples)], sounds = ['silence'];
        for (const [input, clip] of segment.clips.entries()) {
          const source = sources.get(clip.assetId)!, asset = sourceAssets.get(clip.assetId)!;
          args.push('-threads', '1', '-reinit_filter', '0', '-ss', seconds(clip.sourceInFrame + segment.beginFrame - clip.startFrame),
            '-t', seconds(frames + 1), ...localInputArgs(asset.file, source.container));
          filters.push(timelineClipAudioFilter(clip, segment.beginFrame, samples, input, source.streamIndex)); sounds.push(`a${input}`);
        }
        filters.push(timelineMixedAudioFilter(sounds, samples));
        args.push('-filter_complex', filters.join(';'), '-map', '[outa]', '-vn', '-sn', '-dn', '-threads', '1',
          '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1');
        const scalarFrames = (chunk: Buffer, at: number): void => {
          if (!Number.isFinite(chunk.readFloatLE(at)) || !Number.isFinite(chunk.readFloatLE(at + 4))) throw invalidPcm();
        };
        const decoded = await runtime.runStreaming('ffmpeg', args, {...runOptions(partBytes), onStdout(chunk: Buffer): void {
          try {
            fence();
            if (!Buffer.isBuffer(chunk)) throw invalidPcm();
            if (chunk.length > partBytes - partSeen || chunk.length > prepared.pcmBytes - bytesSeen) throw mismatch();
            for (let start = 0; start < chunk.length; start += LIMITS.checkpointBytes) {
              if (start) fence();
              const block = chunk.subarray(start, start + LIMITS.checkpointBytes);
              let at = 0;
              if (residualBytes) {
                const take = Math.min(FRAME_BYTES - residualBytes, block.length);
                block.copy(residual, residualBytes, 0, take); residualBytes += take; at += take;
                if (residualBytes === FRAME_BYTES) { scalarFrames(residual, 0); residualBytes = 0; }
              }
              while (at + FRAME_BYTES <= block.length) { scalarFrames(block, at); at += FRAME_BYTES; }
              if (at < block.length) { residualBytes = block.length - at; block.copy(residual, 0, at); }
              const result: unknown = options.onPcm(block);
              if (object(result) && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw configuration(); }
              partSeen += block.length; bytesSeen += block.length;
            }
          } catch (error) { callbackFailure ??= error; throw error; }
        }});
        fence();
        if (!object(decoded) || decoded.stdoutBytes !== partSeen || residualBytes || partSeen % FRAME_BYTES) throw invalidPcm();
        if (partSeen !== partBytes) throw mismatch();
      }
      fence();
      if (bytesSeen !== prepared.pcmBytes) throw mismatch();
      return Object.freeze({sampleRate: 48000, channels: 2, sampleFrames: prepared.sampleFrames, pcmBytes: bytesSeen,
        segmentCount: prepared.segmentCount, decodeWorkFrames: prepared.decodeWorkFrames});
    } catch (error) {
      if (!callbackFailure) throw error;
      if (object(error) && error.terminationUnconfirmed === true && object(callbackFailure)) callbackFailure.terminationUnconfirmed = true;
      throw callbackFailure;
    }
  };
}
