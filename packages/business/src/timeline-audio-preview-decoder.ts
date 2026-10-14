import path from 'node:path';

/** The service owns file identity, byte hashes, saved-revision authorization,
 * whole-attempt admission and the response lifetime. This adapter only owns
 * bounded probing/PCM decoding; it never acquires or releases the service slot. */
export const TIMELINE_AUDIO_PREVIEW_DECODE_LIMITS = Object.freeze({
  sampleRate: 48000, channels: 2, samplesPerFrame: 1600, maxFrames: 600,
  sourceSeconds: 600, sourceBytes: 512 * 1024 * 1024, timeoutMs: 120000,
  probeBytes: 128 * 1024, probeTimeoutMs: 10000, stderrBytes: 64 * 1024,
  checkpointBytes: 64 * 1024, decodeWorkFrames: 18000, maxSegments: 200,
});
const LIMITS = TIMELINE_AUDIO_PREVIEW_DECODE_LIMITS;
const FRAME_BYTES = 8;
const FORMAT_WHITELIST = 'mov,matroska,mp3,wav';
const CONTAINERS = new Map([
  ['mov,mp4,m4a,3gp,3g2,mj2', 'mov'], ['matroska,webm', 'matroska'], ['mp3', 'mp3'], ['wav', 'wav'],
]);
type DecodeError = Error & {code: string; terminationUnconfirmed?: boolean};
const failure = (code: string, message: string): DecodeError => Object.assign(new Error(message), {code});
const configuration = (): DecodeError => failure('MEDIA_INVALID_CONFIGURATION', 'Invalid local audio preview configuration.');
const unsupported = (): DecodeError => failure('AUDIO_PREVIEW_UNSUPPORTED_FORMAT', 'This source audio format is not supported for sound audition.');
const invalidPcm = (): DecodeError => failure('AUDIO_PREVIEW_INVALID_PCM', 'The source did not produce finite, complete audio sample frames.');
const truncated = (): DecodeError => failure('AUDIO_PREVIEW_TRUNCATED_PCM', 'The source did not produce the complete requested audio interval.');
const outputLimit = (): DecodeError => failure('MEDIA_OUTPUT_LIMIT', 'Local audio output exceeded its fixed resource limit.');
const budget = (): DecodeError => failure('AUDIO_PREVIEW_BUDGET', 'Sound audition preparation exhausted its operation budget.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface TimelineAudioPreviewDecodeSegment {
  readonly sourceInFrame: number;
  readonly frameCount: number;
  readonly trimStartFrame: number;
  readonly outputFrames: number;
}
export interface TimelineAudioPreviewDecodeRequest {
  readonly sourceInFrame: number;
  readonly frameCount: number;
  readonly segments: readonly TimelineAudioPreviewDecodeSegment[];
}
export interface TimelineAudioPreviewSourceProbe {
  readonly streamIndex: number;
  readonly codecName: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly channelLayout: 'mono' | 'stereo';
  /** PCM WAV commonly omits its layout. This explicit, narrowly scoped rule
   * matches FFmpeg's observed mono/stereo guess, not a browser codec guess. */
  readonly layoutOrigin: 'declared' | 'pcm-wav-channel-count';
  readonly durationSeconds: number;
  readonly audioDurationSeconds: number | null;
  readonly container: string;
  readonly sizeBytes: number;
}
export interface TimelineAudioPreviewDecodedPcm {
  readonly pcm: Buffer;
  readonly sampleRate: 48000;
  readonly channels: 2;
  readonly sampleFrames: number;
  readonly source: TimelineAudioPreviewSourceProbe;
}
export interface TimelineAudioPreviewDecodeOptions {
  readonly signal?: AbortSignal;
  /** Synchronous service-owned revision, file identity, and ownership fence. */
  readonly beforeEffect: () => void;
  /** Milliseconds left in the service's absolute prepare deadline. The service
   * also aborts signal at that deadline, including while waiting for a probe. */
  readonly remainingMs: () => number;
}
export interface TimelineAudioPreviewRunOptions {
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly beforeSpawn: () => void;
  readonly beforeEffect: () => void;
}
export interface TimelineAudioPreviewDecoderRuntime {
  run(command: string, args: string[], options: TimelineAudioPreviewRunOptions): Promise<unknown>;
  runStreaming(command: string, args: string[], options: TimelineAudioPreviewRunOptions & {onStdout: (chunk: Buffer) => void}): Promise<unknown>;
  withProbePermit<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
  checkMediaEffect(beforeEffect: () => void, signal?: AbortSignal): void;
  /** Trusted instrumentation only. Reports the actual sole PCM allocation;
   * returning a response transfers ownership, it does not free these bytes. */
  onPcmAllocation?: (bytes: number) => void;
}
export type TimelineAudioPreviewDecoder = (file: string, request: TimelineAudioPreviewDecodeRequest,
  options: TimelineAudioPreviewDecodeOptions) => Promise<TimelineAudioPreviewDecodedPcm>;

function optionalDuration(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 'N/A') return null;
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'string' &&
      (value.length > 40 || !/^\d+(?:\.\d+)?$/u.test(value))) throw unsupported();
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) throw unsupported();
  if (duration > LIMITS.sourceSeconds) throw failure('AUDIO_PREVIEW_SOURCE_LIMIT', 'The source exceeds the sound audition resource limit.');
  return duration;
}

/** Same first identified audio selection as parseProbeOutput: an unknown
 * codec is skipped, an unsupported first identified stream is never skipped in
 * favor of a later stream. The exact selected index must be present and unique.
 * Container and layout admission deliberately remain narrower than rendering. */
export function parseTimelineAudioPreviewProbe(output: unknown): TimelineAudioPreviewSourceProbe {
  if (typeof output !== 'string' || Buffer.byteLength(output) > LIMITS.probeBytes) throw unsupported();
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw unsupported(); }
  if (!object(parsed) || !Array.isArray(parsed.streams) || !parsed.streams.length || parsed.streams.length > 256 ||
      !object(parsed.format) || typeof parsed.format.format_name !== 'string' || !CONTAINERS.has(parsed.format.format_name)) throw unsupported();
  const container = CONTAINERS.get(parsed.format.format_name)!;
  const indexes = new Set<number>();
  let audio: Record<string, unknown> | undefined;
  for (const stream of parsed.streams) {
    if (!object(stream)) throw unsupported();
    if (stream.index !== undefined) {
      if (typeof stream.index !== 'number' || !Number.isSafeInteger(stream.index) || stream.index < 0 || indexes.has(stream.index)) throw unsupported();
      indexes.add(stream.index);
    }
    optionalDuration(stream.duration);
    if (!audio && stream.codec_type === 'audio' && typeof stream.codec_name === 'string' && stream.codec_name.length > 0 && stream.codec_name !== 'unknown') audio = stream;
  }
  if (!audio || typeof audio.index !== 'number' || !Number.isSafeInteger(audio.index) || audio.index < 0 ||
      typeof audio.codec_name !== 'string' || audio.codec_name.length > 128 || !/^[a-zA-Z0-9_]+$/u.test(audio.codec_name) ||
      typeof audio.sample_rate !== 'string' || !/^\d{1,6}$/u.test(audio.sample_rate) ||
      !Number.isSafeInteger(Number(audio.sample_rate)) || Number(audio.sample_rate) < 1 ||
      (audio.channels !== 1 && audio.channels !== 2)) throw unsupported();
  const channelLayout = audio.channels === 1 ? 'mono' : 'stereo';
  const inferred = audio.channel_layout === undefined && container === 'wav' && audio.codec_name.startsWith('pcm_');
  if (!inferred && audio.channel_layout !== channelLayout) throw unsupported();
  const durationSeconds = optionalDuration(parsed.format.duration);
  if (durationSeconds === null || durationSeconds <= 0 || typeof parsed.format.size !== 'string' || !/^\d{1,16}$/u.test(parsed.format.size)) throw unsupported();
  const sizeBytes = Number(parsed.format.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw unsupported();
  if (sizeBytes > LIMITS.sourceBytes) throw failure('AUDIO_PREVIEW_SOURCE_LIMIT', 'The source exceeds the sound audition resource limit.');
  return Object.freeze({streamIndex: audio.index, codecName: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels,
    channelLayout, layoutOrigin: inferred ? 'pcm-wav-channel-count' : 'declared', durationSeconds,
    audioDurationSeconds: optionalDuration(audio.duration), container, sizeBytes});
}

function validateRequest(request: TimelineAudioPreviewDecodeRequest): TimelineAudioPreviewDecodeRequest {
  if (!object(request) || Object.keys(request).length !== 3 || !Object.hasOwn(request, 'sourceInFrame') || !Object.hasOwn(request, 'frameCount') || !Object.hasOwn(request, 'segments') ||
      !Number.isSafeInteger(request.sourceInFrame) || request.sourceInFrame < 0 ||
      !Number.isSafeInteger(request.frameCount) || request.frameCount < 1 || request.frameCount > LIMITS.maxFrames ||
      request.sourceInFrame + request.frameCount > LIMITS.sourceSeconds * 30 ||
      !Array.isArray(request.segments) || request.segments.length < 1 || request.segments.length > LIMITS.maxSegments) throw configuration();
  let outputFrames = 0, originalEnd = 0, workFrames = 0;
  const segments: TimelineAudioPreviewDecodeSegment[] = [];
  for (const segment of request.segments) {
    if (!object(segment) || Object.keys(segment).length !== 4 ||
        !['sourceInFrame', 'frameCount', 'trimStartFrame', 'outputFrames'].every(key => Object.hasOwn(segment, key) && typeof segment[key] === 'number' && Number.isSafeInteger(segment[key])) ||
        typeof segment.sourceInFrame !== 'number' || typeof segment.frameCount !== 'number' || typeof segment.trimStartFrame !== 'number' || typeof segment.outputFrames !== 'number' ||
        segment.sourceInFrame < originalEnd || segment.frameCount < 1 || segment.frameCount > LIMITS.sourceSeconds * 30 ||
        segment.sourceInFrame + segment.frameCount > LIMITS.sourceSeconds * 30 || segment.trimStartFrame < 0 || segment.outputFrames < 1 ||
        segment.trimStartFrame + segment.outputFrames > segment.frameCount ||
        segment.sourceInFrame + segment.trimStartFrame !== request.sourceInFrame + outputFrames) throw configuration();
    workFrames += segment.frameCount + 1;
    if (workFrames > LIMITS.decodeWorkFrames) throw budget();
    outputFrames += segment.outputFrames;
    if (outputFrames > request.frameCount) throw configuration();
    originalEnd = segment.sourceInFrame + segment.frameCount;
    segments.push(Object.freeze({sourceInFrame: segment.sourceInFrame, frameCount: segment.frameCount,
      trimStartFrame: segment.trimStartFrame, outputFrames: segment.outputFrames}));
  }
  if (outputFrames !== request.frameCount) throw configuration();
  return Object.freeze({sourceInFrame: request.sourceInFrame, frameCount: request.frameCount, segments: Object.freeze(segments)});
}
const seconds = (frames: number): string => (frames / 30).toFixed(9);
const localInputArgs = (file: string, container?: string): string[] => [
  '-protocol_whitelist', 'file,pipe', '-format_whitelist', container ?? FORMAT_WHITELIST,
  // MOV references stay disabled even when its actual container was discovered
  // without trusting the extension/MIME supplied by an import or browser.
  ...(container === undefined || container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
  ...(container ? ['-f', container] : []), '-i', file,
];

/** Fixed decoder lane, before clip gain/fades. Each original global export
 * segment is sought and resampled independently, then trimmed to its selected
 * output. A selected window must not restart AAC/resampling at its own edge.
 * The fixed silence-first mixer matches export when embedded audio ends early.
 * One source probe and one <=7.68 MB final allocation serve all sequential
 * segments. Chunks are copied directly to final offsets and never retained.
 * No alternate filter, stream, codec, destination or path comes from the request. */
export function createTimelineAudioPreviewDecoder(runtime: TimelineAudioPreviewDecoderRuntime): TimelineAudioPreviewDecoder {
  return async function decodeTimelineAudioPreview(file, request, options) {
    if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file) ||
        !options || typeof options.beforeEffect !== 'function' || typeof options.remainingMs !== 'function') throw configuration();
    const {sourceInFrame, frameCount, segments} = validateRequest(request), sampleFrames = frameCount * LIMITS.samplesPerFrame, expectedBytes = sampleFrames * FRAME_BYTES;
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
    const runOptions = (bytes: number, cap: number = LIMITS.timeoutMs): TimelineAudioPreviewRunOptions => ({signal: options.signal,
      timeout: Math.min(cap, remaining()), maxStdoutBytes: bytes, maxStderrBytes: LIMITS.stderrBytes, beforeSpawn: fence, beforeEffect: fence});
    try {
      fence();
      const source = await runtime.withProbePermit(options.signal, async () => {
        fence();
        const raw = await runtime.run('ffprobe', ['-v', 'error', '-show_entries',
          'format=format_name,duration,size:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration',
          '-of', 'json', ...localInputArgs(file)], runOptions(LIMITS.probeBytes, LIMITS.probeTimeoutMs));
        fence();
        return parseTimelineAudioPreviewProbe(raw);
      });
      fence();
      // Match sourceFrameCount's whole-frame rule, allowing arithmetic noise
      // only. A short audio stream inside a longer video remains admissible.
      if (sourceInFrame + frameCount > Math.floor(source.durationSeconds * 30 + 1e-6) ||
          segments.some(segment => segment.sourceInFrame + segment.frameCount > Math.floor(source.durationSeconds * 30 + 1e-6)))
        throw failure('AUDIO_PREVIEW_SOURCE_BOUNDS', 'The requested interval exceeds the available source duration.');
      const pcm = Buffer.allocUnsafe(expectedBytes);
      runtime.onPcmAllocation?.(pcm.byteLength);
      fence();
      let bytesSeen = 0, checkedBytes = 0;
      for (const segment of segments) {
        fence();
        const originalSamples = segment.frameCount * LIMITS.samplesPerFrame;
        const trimStart = segment.trimStartFrame * LIMITS.samplesPerFrame;
        const partSamples = segment.outputFrames * LIMITS.samplesPerFrame, partBytes = partSamples * FRAME_BYTES;
        const partOffset = bytesSeen;
        const filters = [
          `anullsrc=r=48000:cl=stereo,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[silence]`,
          `[0:${source.streamIndex}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[source]`,
          `[silence][source]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${originalSamples},atrim=start_sample=${trimStart}:end_sample=${trimStart + partSamples},asetpts=N/SR/TB[out]`,
        ];
        const decoded = await runtime.runStreaming('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-filter_complex_threads', '1', '-reinit_filter', '0',
          '-ss', seconds(segment.sourceInFrame), '-t', seconds(segment.frameCount + 1), ...localInputArgs(file, source.container),
          '-filter_complex', filters.join(';'), '-map', '[out]', '-vn', '-sn', '-dn', '-threads', '1',
          '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1',
        ], {...runOptions(partBytes), onStdout(chunk: Buffer): void {
          try {
            fence();
            if (!Buffer.isBuffer(chunk)) throw invalidPcm();
            if (chunk.length > partBytes - (bytesSeen - partOffset) || chunk.length > expectedBytes - bytesSeen) throw outputLimit();
            for (let offset = 0; offset < chunk.length; offset += LIMITS.checkpointBytes) {
              if (offset) fence();
              const end = Math.min(chunk.length, offset + LIMITS.checkpointBytes);
              chunk.copy(pcm, bytesSeen, offset, end);
              bytesSeen += end - offset;
              while (checkedBytes + 4 <= bytesSeen) {
                if (!Number.isFinite(pcm.readFloatLE(checkedBytes))) throw invalidPcm();
                checkedBytes += 4;
              }
            }
          } catch (error) {callbackFailure ??= error; throw error;}
        }});
        fence();
        const partSeen = bytesSeen - partOffset;
        if (!object(decoded) || decoded.stdoutBytes !== partSeen || partSeen % FRAME_BYTES) throw invalidPcm();
        if (partSeen !== partBytes) throw truncated();
        fence();
      }
      if (bytesSeen !== expectedBytes) throw truncated();
      fence();
      return Object.freeze({pcm, sampleRate: 48000, channels: 2, sampleFrames, source});
    } catch (error) {
      if (!callbackFailure) throw error;
      if (object(error) && error.terminationUnconfirmed === true && object(callbackFailure)) callbackFailure.terminationUnconfirmed = true;
      throw callbackFailure;
    }
  };
}
