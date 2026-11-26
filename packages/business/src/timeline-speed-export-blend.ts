import {checkMediaEffect} from './media-runtime.ts';
import type {MediaEffectFence} from './media-runtime.ts';
import {finishMediaInput, runReverseTool, writeMediaInput} from './timeline-processing/reverse-io.ts';

export interface SpeedBlendSample {
  /** Both ordinals are in the decoder's traversal order. */
  readonly from: number;
  readonly to: number;
  readonly weight: number;
}

const chromaDivisors: Readonly<Record<string, readonly [number, number]>> = {
  '410': [4, 4],
  '411': [4, 1],
  '420': [2, 2],
  '422': [2, 1],
  '440': [1, 2],
  '444': [1, 1],
};

/** Byte count of the FFmpeg rawvideo layout, including odd chroma dimensions. */
export function speedBlendFrameBytes(pixelFormat: string, width: number, height: number): number | null {
  const planar = /^yuv(a?)(410|411|420|422|440|444)p$/u.exec(pixelFormat);
  if (!planar) return null;
  const [x, y] = chromaDivisors[planar[2]!]!;
  const luma = width * height;
  return luma * (planar[1] ? 2 : 1) + 2 * Math.ceil(width / x) * Math.ceil(height / y);
}

interface Options {
  readonly samples: readonly SpeedBlendSample[];
  readonly frameBytes: number;
  readonly decodeArgs: (start: number, end: number) => string[];
  readonly encodeArgs: string[];
  readonly timeout: number;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: MediaEffectFence;
  readonly invalid: () => never;
}

/** Retain at most two consecutive decoded frames and one output frame. Each
 * async write applies backpressure to the same owned decoder and encoder. */
export async function renderSpeedBlend(options: Options): Promise<void> {
  const {samples, frameBytes, decodeArgs, encodeArgs, timeout, beforeEffect, invalid} = options;
  const start = samples[0]?.from;
  if (start === undefined || start < 0 || !Number.isSafeInteger(frameBytes) || frameBytes < 1) invalid();
  let end = start;
  for (const [index, sample] of samples.entries()) {
    if (!Number.isSafeInteger(sample.from) || sample.from < start || !Number.isSafeInteger(sample.to) ||
        sample.to < sample.from || sample.to > sample.from + 1 ||
        !Number.isFinite(sample.weight) || sample.weight < 0 || sample.weight > 1 ||
        (index > 0 && sample.from < samples[index - 1]!.from)) invalid();
    end = Math.max(end, sample.to);
  }
  const sourceBytes = (end - start + 1) * frameBytes;
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) invalid();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const media = {signal, ownerSignal: options.signal, beforeEffect: () => checkMediaEffect(beforeEffect, signal)};
  const stop = () => controller.abort();
  await runReverseTool('ffmpeg', encodeArgs, media, {timeoutMs: timeout, onFailure: stop, async stdin(output) {
    let previous = Buffer.allocUnsafe(frameBytes);
    let current = Buffer.allocUnsafe(frameBytes);
    const mixed = Buffer.allocUnsafe(frameBytes);
    let written = 0, ordinal = start, cursor = 0;
    const at = (frame: number): Buffer => frame === ordinal ? current : frame === ordinal - 1 ? previous : invalid();

    await runReverseTool('ffmpeg', decodeArgs(start, end + 1), media, {timeoutMs: timeout, stdoutLimit: sourceBytes,
      async stdout(chunk) {
        let read = 0;
        while (read < chunk.length) {
          const count = Math.min(frameBytes - written, chunk.length - read);
          chunk.copy(current, written, read, read + count);
          read += count;
          written += count;
          if (written !== frameBytes) continue;

          while (cursor < samples.length && samples[cursor]!.to <= ordinal) {
            checkMediaEffect(beforeEffect, signal);
            const {from, to, weight} = samples[cursor++]!;
            const first = at(from);
            if (from === to || weight === 0) await writeMediaInput(output, first);
            else if (weight === 1) await writeMediaInput(output, at(to));
            else {
              const second = at(to);
              for (let byte = 0; byte < frameBytes; byte++) {
                const a = first[byte]!;
                mixed[byte] = Math.round(a + (second[byte]! - a) * weight);
              }
              await writeMediaInput(output, mixed);
            }
          }
          [previous, current] = [current, previous];
          written = 0;
          ordinal++;
        }
      },
    });
    if (cursor !== samples.length || ordinal !== end + 1 || written !== 0) invalid();
    await finishMediaInput(output);
  }});
}
