import { interruptedMediaError, throwIfMediaAborted } from './media-processes.ts';

// Resource limits, not a codec/product allowlist. 8K in either orientation is
// supported; unusually large stills (>64 Mi pixels) fail before subsequent full
// decode/render. FFprobe itself parses media; this is not a decoder sandbox.
export const MEDIA_PROBE_LIMITS = Object.freeze({ streams: 256, dimension: 16384, pixels: 64 * 1024 * 1024, concurrent: 4 });
const invalid = () => Object.assign(new Error('Local media metadata is invalid or exceeds resource limits.'), { code: 'MEDIA_INVALID_METADATA' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// FFprobe can report a stream type and dimensions for an unknown codec. Such
// streams cannot be selected for decoding; keep looking for an identified one.
// This is not a decoder allowlist or a guarantee that the entire stream decodes.
const identifiedCodec = stream => typeof stream.codec_name === 'string' && stream.codec_name.length > 0 && stream.codec_name !== 'unknown';

function duration(value) {
  // FFprobe omits unavailable durations and some demuxers report N/A.
  if (value === undefined || value === null || value === '' || value === 'N/A') return 0;
  if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) throw invalid();
  return Number(value);
}

export function parseProbeOutput(output) {
  let p;
  try { p = JSON.parse(output); } catch { throw invalid(); }
  if (!object(p) || !Array.isArray(p.streams) || p.streams.length > MEDIA_PROBE_LIMITS.streams || p.format !== undefined && !object(p.format)) throw invalid();
  for (const stream of p.streams) {
    if (!object(stream)) throw invalid();
    if (stream.index !== undefined && (!Number.isSafeInteger(stream.index) || stream.index < 0)) throw invalid();
    for (const key of ['width', 'height']) if (stream[key] !== undefined && (!Number.isSafeInteger(stream[key]) || stream[key] < 0 || stream[key] > MEDIA_PROBE_LIMITS.dimension)) throw invalid();
    if ((stream.width || 0) * (stream.height || 0) > MEDIA_PROBE_LIMITS.pixels) throw invalid();
    duration(stream.duration);
  }
  const formatDuration = duration(p.format?.duration);
  const v = p.streams.find(stream => stream.codec_type === 'video' && identifiedCodec(stream) && !stream.disposition?.attached_pic && stream.width && stream.height);
  const a = p.streams.find(stream => stream.codec_type === 'audio' && identifiedCodec(stream));
  if (!v && !a) throw Object.assign(new Error('No decodable image/video/audio stream'), { code: 'MEDIA_NO_STREAM' });
  return { width: v?.width || 0, height: v?.height || 0, duration: formatDuration || duration(v?.duration) || duration(a?.duration),
    hasVideo: Boolean(v), hasAudio: Boolean(a), videoStreamIndex: v?.index, audioStreamIndex: a?.index, codec: v?.codec_name || a?.codec_name, probe: p };
}

let running = 0;
const waiting = [];
function drain() {
  while (running < MEDIA_PROBE_LIMITS.concurrent && waiting.length) {
    const entry = waiting.shift();
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) { entry.reject(interruptedMediaError()); continue; }
    running += 1; entry.resolve();
  }
}

// Queue instead of rejecting ordinary Promise.all probes (including twelve
// timeline inputs). An aborted queued probe never reserves a slot or spawns.
export async function withProbePermit(signal, operation) {
  throwIfMediaAborted(signal);
  await new Promise((resolve, reject) => {
    const entry = { signal, resolve, reject };
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
