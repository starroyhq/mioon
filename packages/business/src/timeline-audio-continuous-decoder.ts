import path from 'node:path';
import {parseTimelineAudioPreviewProbe} from './timeline-audio-preview-decoder.ts';
import type {TimelineAudioPreviewSourceProbe} from './timeline-audio-preview-decoder.ts';

const BLOCK_BYTES = 60 * 1600 * 8;
const fail = (code: string): Error & {code: string} => Object.assign(new Error('Continuous audio source is unavailable.'), {code});
const seconds = (frames: number): string => (frames / 30).toFixed(9);
const localInput = (file: string, container?: string): string[] => [
  '-protocol_whitelist', 'file,pipe', '-format_whitelist', container ?? 'mov,matroska,mp3,wav',
  ...(container === undefined || container === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
  ...(container ? ['-f', container] : []), '-i', file,
];
interface RunOptions {
  signal: AbortSignal; timeout: number; maxStdoutBytes: number; maxStderrBytes: number;
  beforeSpawn: () => void; beforeEffect: () => void;
}
export interface ContinuousDecoderRuntime {
  run(command: string, args: string[], options: RunOptions): Promise<unknown>;
  runStreamingWithBackpressure(command: string, args: string[], options: RunOptions & {onStdout: (chunk: Buffer) => Promise<void>; onFailure?: (error: unknown) => void}): Promise<unknown>;
  withProbePermit<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  checkMediaEffect(beforeEffect: () => void, signal: AbortSignal): void;
  onAllocation?: (bytes: number) => void;
}
export interface ContinuousDecodeOptions {signal: AbortSignal; beforeEffect: () => void; onDecodedBytes?: (bytes: number) => void}
export interface ContinuousDecodeUnit {
  sourceInFrame: number; frameCount: number; trimStartFrame: number;
}
export interface ContinuousDecodeCursor {
  read(sampleFrames: number): Promise<Buffer>;
  close(): Promise<void>;
  readonly done: Promise<void>;
}
export interface ContinuousDecoder {
  probe(file: string, options: ContinuousDecodeOptions): Promise<TimelineAudioPreviewSourceProbe>;
  open(file: string, source: TimelineAudioPreviewSourceProbe, unit: ContinuousDecodeUnit, options: ContinuousDecodeOptions): ContinuousDecodeCursor;
}

/** A cursor resamples exactly one ORIGINAL composition segment. Its pipe is
 * pulled into <=2-second buffers; awaiting the next read freezes the producer.
 * No independent -ss/resample is introduced at a transport block boundary. */
export function createTimelineAudioContinuousDecoder(runtime: ContinuousDecoderRuntime): ContinuousDecoder {
  const checkFile = (file: string): void => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw fail('MEDIA_INVALID_CONFIGURATION');
  };
  return {
    async probe(file, options) {
      checkFile(file);
      const fence = (): void => runtime.checkMediaEffect(options.beforeEffect, options.signal);
      fence();
      return runtime.withProbePermit(options.signal, async () => {
        fence();
        const raw = await runtime.run('ffprobe', ['-v', 'error', '-show_entries',
          'format=format_name,duration,size:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration',
          '-of', 'json', ...localInput(file)], {signal: options.signal, timeout: 10000,
          maxStdoutBytes: 128 * 1024, maxStderrBytes: 64 * 1024, beforeSpawn: fence, beforeEffect: fence});
        fence(); return parseTimelineAudioPreviewProbe(raw);
      });
    },
    open(file, source, unit, options) {
      checkFile(file);
      if (![unit.sourceInFrame, unit.frameCount, unit.trimStartFrame].every(Number.isSafeInteger) || unit.sourceInFrame < 0 ||
          unit.frameCount < 1 || unit.frameCount > 18000 || unit.trimStartFrame < 0 || unit.trimStartFrame >= unit.frameCount ||
          unit.sourceInFrame + unit.frameCount > Math.floor(source.durationSeconds * 30 + 1e-6)) throw fail('AUDIO_PREVIEW_SOURCE_BOUNDS');
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, options.signal]);
      const originalSamples = unit.frameCount * 1600, trimSamples = unit.trimStartFrame * 1600;
      const expectedBytes = (originalSamples - trimSamples) * 8;
      let emittedBytes = 0, deliveredBytes = 0, ended = false, failure: unknown;
      let pending: {buffer: Buffer; offset: number; resolve: (buffer: Buffer) => void; reject: (error: unknown) => void} | undefined;
      let wake: (() => void) | undefined;
      const fence = (): void => runtime.checkMediaEffect(options.beforeEffect, signal);
      const cancelled = (): void => {
        failure ??= fail('OPERATION_CANCELLED'); pending?.reject(failure); pending = undefined; wake?.(); wake = undefined;
      };
      signal.addEventListener('abort', cancelled, {once: true});
      const waitForDemand = async (): Promise<void> => {
        if (!pending && !signal.aborted) await new Promise<void>(resolve => {wake = resolve;});
        fence();
      };
      const filters = [
        `anullsrc=r=48000:cl=stereo,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[silence]`,
        `[0:${source.streamIndex}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[source]`,
        `[silence][source]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${originalSamples},atrim=start_sample=${trimSamples}:end_sample=${originalSamples},asetpts=N/SR/TB[out]`,
      ];
      const work = runtime.runStreamingWithBackpressure('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-threads', '1', '-filter_complex_threads', '1', '-reinit_filter', '0',
        '-ss', seconds(unit.sourceInFrame), '-t', seconds(unit.frameCount + 1), ...localInput(file, source.container),
        '-filter_complex', filters.join(';'), '-map', '[out]', '-vn', '-sn', '-dn', '-threads', '1',
        '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1',
      ], {signal, timeout: 120000, maxStdoutBytes: expectedBytes, maxStderrBytes: 64 * 1024, beforeSpawn: fence, beforeEffect: fence,
        onFailure(error) {failure = error; controller.abort();},
        async onStdout(chunk) {
          fence();
          if (!Buffer.isBuffer(chunk) || chunk.length > 1024 * 1024 || chunk.buffer.byteLength > 1024 * 1024 ||
              chunk.length > expectedBytes - emittedBytes) throw fail('AUDIO_PREVIEW_INVALID_PCM');
          emittedBytes += chunk.length;
          options.onDecodedBytes?.(chunk.length);
          for (let at = 0; at < chunk.length;) {
            await waitForDemand();
            if (!pending) throw fail('OPERATION_CANCELLED');
            const current = pending, count = Math.min(chunk.length - at, current.buffer.length - current.offset);
            chunk.copy(current.buffer, current.offset, at, at + count); at += count; current.offset += count;
            if (current.offset === current.buffer.length) {
              for (let offset = 0; offset < current.buffer.length; offset += 4) {
                if (offset % 65536 === 0) fence();
                if (!Number.isFinite(current.buffer.readFloatLE(offset))) throw fail('AUDIO_PREVIEW_INVALID_PCM');
              }
              pending = undefined; deliveredBytes += current.buffer.length; current.resolve(current.buffer);
            }
          }
        },
      });
      const done = work.then(result => {
        if (emittedBytes !== expectedBytes || !result || typeof result !== 'object' ||
            !('stdoutBytes' in result) || result.stdoutBytes !== expectedBytes) throw fail('AUDIO_PREVIEW_TRUNCATED_PCM');
      }).catch(error => {failure = error; pending?.reject(error); pending = undefined; throw error;}).finally(() => {
        ended = true; signal.removeEventListener('abort', cancelled); wake?.(); wake = undefined;
      });
      done.catch(() => {});
      return {
        done,
        async read(sampleFrames) {
          fence();
          const bytes = sampleFrames * 8;
          if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 1 || bytes > BLOCK_BYTES || pending || bytes > expectedBytes - deliveredBytes)
            throw fail('MEDIA_INVALID_CONFIGURATION');
          if (failure) throw failure;
          if (ended) throw fail('AUDIO_PREVIEW_TRUNCATED_PCM');
          const buffer = Buffer.allocUnsafe(bytes); runtime.onAllocation?.(bytes);
          const result = new Promise<Buffer>((resolve, reject) => {pending = {buffer, offset: 0, resolve, reject};});
          wake?.(); wake = undefined;
          const pcm = await result;
          if (deliveredBytes === expectedBytes) await done;
          fence(); return pcm;
        },
        async close() {
          controller.abort();
          try {await done;} catch (error) {
            if (error && typeof error === 'object' && 'terminationUnconfirmed' in error && error.terminationUnconfirmed) throw error;
          }
        },
      };
    },
  };
}
