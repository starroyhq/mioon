import { interruptedMediaError, throwIfMediaAborted } from './media-processes.ts';

// Resource limits, not a codec/product allowlist. 8K in either orientation is
// supported; unusually large stills (>64 Mi pixels) fail before subsequent full
// decode/render. FFprobe itself parses media; this is not a decoder sandbox.
export const MEDIA_PROBE_LIMITS = Object.freeze({ streams: 256, dimension: 16384, pixels: 64 * 1024 * 1024, concurrent: 4 });

export interface MediaProbeError extends Error {
  code: 'MEDIA_INVALID_METADATA' | 'MEDIA_NO_STREAM';
}

/** One FFprobe stream object, kept open so callers can read optional fields. */
export type ProbeStream = Readonly<Record<string, unknown>>;

export interface ProbeOutput {
  streams: ProbeStream[];
  format?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoStreamIndex: number | undefined;
  audioStreamIndex: number | undefined;
  codec: string | undefined;
  probe: ProbeOutput;
}

const invalid = (): MediaProbeError => Object.assign(new Error('Local media metadata is invalid or exceeds resource limits.'), { code: 'MEDIA_INVALID_METADATA' as const });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// FFprobe can report a stream type and dimensions for an unknown codec. Such
// streams cannot be selected for decoding; keep looking for an identified one.
// This is not a decoder allowlist or a guarantee that the entire stream decodes.
const identifiedCodec = (stream: ProbeStream): boolean => typeof stream.codec_name === 'string' && stream.codec_name.length > 0 && stream.codec_name !== 'unknown';
const attachedPicture = (stream: ProbeStream): unknown => object(stream.disposition) ? stream.disposition.attached_pic : undefined;
const numberValue = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const integerValue = (value: unknown): number | undefined => Number.isSafeInteger(value) ? value as number : undefined;

function duration(value: unknown): number {
  // FFprobe omits unavailable durations and some demuxers report N/A.
  if (value === undefined || value === null || value === '' || value === 'N/A') return 0;
  if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) throw invalid();
  return Number(value);
}

export function parseProbeOutput(output: string): ProbeResult {
  let p: unknown;
  try { p = JSON.parse(output); } catch { throw invalid(); }
  if (!object(p) || !Array.isArray(p.streams) || p.streams.length > MEDIA_PROBE_LIMITS.streams || p.format !== undefined && !object(p.format)) throw invalid();
  const streams: ProbeStream[] = [];
  for (const rawStream of p.streams as unknown[]) {
    if (!object(rawStream)) throw invalid();
    const stream = rawStream;
    if (stream.index !== undefined && (!Number.isSafeInteger(stream.index) || numberValue(stream.index) < 0)) throw invalid();
    for (const key of ['width', 'height']) if (stream[key] !== undefined && (!Number.isSafeInteger(stream[key]) || numberValue(stream[key]) < 0 || numberValue(stream[key]) > MEDIA_PROBE_LIMITS.dimension)) throw invalid();
    if (numberValue(stream.width) * numberValue(stream.height) > MEDIA_PROBE_LIMITS.pixels) throw invalid();
    duration(stream.duration);
    streams.push(stream);
  }
  const format = p.format as Record<string, unknown> | undefined;
  const formatDuration = duration(format?.duration);
  const v = streams.find(stream => stream.codec_type === 'video' && identifiedCodec(stream) && !attachedPicture(stream) && stream.width && stream.height);
  const a = streams.find(stream => stream.codec_type === 'audio' && identifiedCodec(stream));
  if (!v && !a) throw Object.assign(new Error('No decodable image/video/audio stream'), { code: 'MEDIA_NO_STREAM' });
  const probe = Object.assign(p, {streams}) as ProbeOutput;
  return { width: numberValue(v?.width), height: numberValue(v?.height), duration: formatDuration || duration(v?.duration) || duration(a?.duration),
    hasVideo: Boolean(v), hasAudio: Boolean(a), videoStreamIndex: integerValue(v?.index), audioStreamIndex: integerValue(a?.index), codec: (v?.codec_name || a?.codec_name) as string | undefined, probe };
}

let running = 0;
interface ProbeWaiter {
  signal?: AbortSignal | null;
  resolve: () => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
const waiting: ProbeWaiter[] = [];
function drain(): void {
  while (running < MEDIA_PROBE_LIMITS.concurrent && waiting.length) {
    const entry = waiting.shift();
    if (!entry) return;
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) { entry.reject(interruptedMediaError()); continue; }
    running += 1; entry.resolve();
  }
}

// Queue instead of rejecting ordinary Promise.all probes (including twelve
// timeline inputs). An aborted queued probe never reserves a slot or spawns.
export async function withProbePermit<T>(signal: AbortSignal | null | undefined, operation: () => T | Promise<T>): Promise<T> {
  throwIfMediaAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const entry: ProbeWaiter = { signal, resolve: () => resolve(), reject, abort: () => {} };
    entry.abort = () => {
      const index = waiting.indexOf(entry);
      if (index < 0) return;
      waiting.splice(index, 1); reject(interruptedMediaError());
    };
    signal?.addEventListener('abort', entry.abort, { once: true });
    waiting.push(entry); drain();
  });
  try { throwIfMediaAborted(signal); return await operation(); }
  finally { running -= 1; drain(); }
}
