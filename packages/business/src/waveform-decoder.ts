import path from 'node:path';
import { mediaConfigurationError } from './media-environment.ts';
import { throwIfMediaAborted } from './media-processes.ts';
import { runStreaming } from './media-runtime.ts';

export const WAVEFORM_DECODE_LIMITS = Object.freeze({
  sampleRate: 48000, framesPerBin: 480, maxDuration: 600, maxBins: 60000,
  timeoutMs: 120000, durationToleranceSeconds: 0.1,
});
const invalidPcm = () => Object.assign(new Error('Local audio could not be decoded into a complete waveform.'), { code: 'WAVEFORM_INVALID_PCM' });
const durationMismatch = () => Object.assign(new Error('Decoded audio duration does not match the source.'), { code: 'WAVEFORM_DURATION_MISMATCH' });
const outputLimit = () => Object.assign(new Error('Local media tool exceeded its output limit.'), { code: 'MEDIA_OUTPUT_LIMIT' });

function validateFormat(channels, duration) {
  if ((channels !== 1 && channels !== 2) || !Number.isFinite(duration) || duration <= 0 || duration > WAVEFORM_DECODE_LIMITS.maxDuration) throw mediaConfigurationError();
}

/** Incremental f32le reduction; retained PCM is at most one sample frame.
 * Each 10 ms bin is the absolute maximum across every input channel. There is
 * no downmix, so opposite-phase stereo samples cannot cancel each other out.
 */
export function createWaveformAccumulator({ channels, duration } = {}) {
  validateFormat(channels, duration);
  const { sampleRate, framesPerBin, maxDuration, maxBins, durationToleranceSeconds } = WAVEFORM_DECODE_LIMITS;
  const frameBytes = channels * 4, maxFrames = maxDuration * sampleRate;
  const peaks = new Uint16Array(maxBins), residual = Buffer.allocUnsafe(frameBytes);
  let residualBytes = 0, sampleFrames = 0, binFrames = 0, binPeak = 0, binCount = 0, clipped = false, finished = false, failure;
  const flushBin = () => {
    if (binCount >= maxBins) throw outputLimit();
    peaks[binCount++] = Math.round(Math.min(1, binPeak) * 65535);
    binFrames = 0; binPeak = 0;
  };
  const consumeFrame = (chunk, offset) => {
    if (sampleFrames >= maxFrames) throw outputLimit();
    for (let channel = 0; channel < channels; channel++) {
      const sample = chunk.readFloatLE(offset + channel * 4);
      if (!Number.isFinite(sample)) throw invalidPcm();
      const amplitude = Math.abs(sample);
      if (amplitude > 1) clipped = true;
      if (amplitude > binPeak) binPeak = amplitude;
    }
    sampleFrames++; binFrames++;
    if (binFrames === framesPerBin) flushBin();
  };
  return {
    write(chunk) {
      if (failure) throw failure;
      if (finished || !Buffer.isBuffer(chunk)) throw invalidPcm();
      try {
        // Count the carried partial frame as well. Even one extra byte beyond
        // 600 seconds is an error, rather than a successful truncated decode.
        if (chunk.length > (maxFrames - sampleFrames) * frameBytes - residualBytes) throw outputLimit();
        let offset = 0;
        if (residualBytes) {
          const count = Math.min(frameBytes - residualBytes, chunk.length);
          chunk.copy(residual, residualBytes, 0, count);
          residualBytes += count; offset += count;
          if (residualBytes === frameBytes) { consumeFrame(residual, 0); residualBytes = 0; }
        }
        while (offset + frameBytes <= chunk.length) { consumeFrame(chunk, offset); offset += frameBytes; }
        if (offset < chunk.length) {
          residualBytes = chunk.length - offset;
          chunk.copy(residual, 0, offset);
        }
      } catch (error) { failure = error; throw error; }
    },
    finish() {
      if (failure) throw failure;
      if (finished || residualBytes || !sampleFrames) throw invalidPcm();
      // The 100 ms tolerance accommodates container rounding, resampling and
      // codec priming/padding. Larger disagreement is rejected, not normalized
      // or padded into success. The separate 600 s byte/frame cap is absolute.
      if (Math.abs(sampleFrames - Math.round(duration * sampleRate)) > Math.ceil(durationToleranceSeconds * sampleRate)) throw durationMismatch();
      if (binFrames) flushBin();
      finished = true;
      return { peaks: peaks.slice(0, binCount), clipped, sampleFrames };
    },
  };
}

/** Decode an already-probed local mono/stereo source, selecting first audio.
 * The caller owns source validation/cache identity. Input paths are resolved
 * locally. Protocol and container allowlists prevent network input and reject
 * reference containers such as concat/HLS that could open other local files.
 * No duration/output truncation flag is used.
 */
export async function decodeWaveform(file, { signal, channels, duration } = {}) {
  throwIfMediaAborted(signal);
  if (typeof file !== 'string' || !file || file.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(file) && !path.isAbsolute(file)) throw mediaConfigurationError();
  const accumulator = createWaveformAccumulator({ channels, duration });
  let decodeFailure;
  try {
    await runStreaming('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,mp3,wav', '-i', path.resolve(file),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '1',
      '-ac', String(channels), '-ar', String(WAVEFORM_DECODE_LIMITS.sampleRate),
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
    ], {
      signal, timeout: WAVEFORM_DECODE_LIMITS.timeoutMs,
      maxStdoutBytes: WAVEFORM_DECODE_LIMITS.maxDuration * WAVEFORM_DECODE_LIMITS.sampleRate * channels * 4,
      onStdout(chunk) {
        try { accumulator.write(chunk); }
        catch (error) { decodeFailure = error; throw error; }
      },
    });
  } catch (error) {
    if (!decodeFailure) throw error;
    if (error.terminationUnconfirmed) decodeFailure.terminationUnconfirmed = true;
    throw decodeFailure;
  }
  throwIfMediaAborted(signal);
  return accumulator.finish();
}
