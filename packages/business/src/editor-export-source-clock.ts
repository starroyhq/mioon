import {runStreaming} from './media-runtime.ts';
import {withProbePermit} from './media-probe.ts';
import {probe} from './media.ts';
import type {EditorSourceClock} from './editor-export-speed.ts';

export async function readEditorSourceClock(file: string, options: {
  readonly signal?: AbortSignal;
  readonly beforeEffect: () => void;
}): Promise<EditorSourceClock | null> {
  const source = await probe(file, options);
  const selector = source.videoStreamIndex;
  if (selector === undefined) return null;
  const timeBase = source.probe.streams.find(stream => stream.index === selector)?.time_base;
  const rate = typeof timeBase === 'string' ? /^([1-9]\d{0,9})\/([1-9]\d{0,9})$/u.exec(timeBase) : null;
  if (!rate) return null;
  const output: Buffer[] = [];
  await withProbePermit(options.signal, () => runStreaming('ffprobe', [
    '-v', 'error', '-select_streams', String(selector), '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp', '-of', 'json', file,
  ], {...options, maxStdoutBytes: 4 * 1024 * 1024, onStdout: chunk => {output.push(chunk);}}));
  const {frames} = JSON.parse(Buffer.concat(output).toString('utf8')) as {frames?: {best_effort_timestamp?: unknown}[]};
  if (!frames || frames.length < 2 || frames[0]!.best_effort_timestamp !== 0) return null;
  const step = frames[1]!.best_effort_timestamp;
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step <= 0 ||
      !frames.every((frame, index) => frame.best_effort_timestamp === index * step && Number.isSafeInteger(index * step))) return null;
  const numerator = BigInt(rate[2]!);
  const denominator = BigInt(rate[1]!) * BigInt(step);
  let common = numerator, remainder = denominator;
  while (remainder) [common, remainder] = [remainder, common % remainder];
  const fps = Number(numerator / common), fpsDenominator = Number(denominator / common);
  // Use the proved presentation grid, including fractional rates.
  return fps <= 0xffffffff && fpsDenominator <= 0xffffffff
    ? {fps, fpsDenominator, frameCount: frames.length} : null;
}
