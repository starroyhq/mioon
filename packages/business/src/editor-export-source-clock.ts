import {runStreaming} from './media-runtime.ts';
import {withProbePermit} from './media-probe.ts';
import {probe} from './media.ts';
import type {EditorSourceClock} from './editor-export-speed.ts';

interface EditorSourcePicture {
  readonly clock: EditorSourceClock | null;
  readonly pictureFrames: number;
}

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export async function readEditorSourceClock(file: string, projectFps: number, options: {
  readonly signal?: AbortSignal;
  readonly beforeEffect: () => void;
}): Promise<EditorSourcePicture | null> {
  const source = await probe(file, options);
  const selector = source.videoStreamIndex;
  if (selector === undefined) return null;
  const stream = source.probe.streams.find(stream => stream.index === selector);
  const timeBase = stream?.time_base;
  const rate = typeof timeBase === 'string' ? /^([1-9]\d{0,9})\/([1-9]\d{0,9})$/u.exec(timeBase) : null;
  if (!rate) return null;
  const output: Buffer[] = [];
  await withProbePermit(options.signal, () => runStreaming('ffprobe', [
    '-v', 'error', '-select_streams', String(selector), '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp,duration,pkt_duration', '-of', 'json', file,
  ], {...options, maxStdoutBytes: 4 * 1024 * 1024, onStdout: chunk => {output.push(chunk);}}));
  const {frames} = JSON.parse(Buffer.concat(output).toString('utf8')) as {
    frames?: {best_effort_timestamp?: unknown; duration?: unknown; pkt_duration?: unknown}[];
  };
  if (!frames?.length || frames[0]!.best_effort_timestamp !== 0) return null;
  const last = frames.at(-1)!;
  const lastTimestamp = last.best_effort_timestamp;
  if (typeof lastTimestamp !== 'number' || !Number.isSafeInteger(lastTimestamp) || !frames.every((frame, index) => index === 0 ||
    typeof frame.best_effort_timestamp === 'number' && Number.isSafeInteger(frame.best_effort_timestamp) &&
    frame.best_effort_timestamp > Number(frames[index - 1]!.best_effort_timestamp))) return null;
  const step = frames[1]?.best_effort_timestamp;
  const grid = positiveInteger(step) && frames.every((frame, index) =>
    frame.best_effort_timestamp === index * step && Number.isSafeInteger(index * step)) ? step : null;
  const lastDuration = positiveInteger(last.duration) ? last.duration : positiveInteger(last.pkt_duration) ? last.pkt_duration : grid ?? 0;
  // Container duration may describe a longer audio stream. Bound picture
  // coverage by decoded presentation and, when known, the video stream end.
  const end = BigInt(lastTimestamp) + BigInt(lastDuration);
  const streamDuration = stream?.duration_ts;
  const cappedEnd = positiveInteger(streamDuration) && BigInt(streamDuration) < end ? BigInt(streamDuration) : end;
  const numerator = BigInt(rate[2]!), tickDuration = BigInt(rate[1]!);
  const pictureFrames = Number(cappedEnd * BigInt(projectFps) * tickDuration / numerator);
  if (!Number.isSafeInteger(pictureFrames) || pictureFrames < 0) return null;
  if (grid === null) return {clock: null, pictureFrames};
  const denominator = tickDuration * BigInt(grid);
  let common = numerator, remainder = denominator;
  while (remainder) [common, remainder] = [remainder, common % remainder];
  const fps = Number(numerator / common), fpsDenominator = Number(denominator / common);
  // Use the proved presentation grid, including fractional rates.
  const clock = fps <= 0xffffffff && fpsDenominator <= 0xffffffff
    ? {fps, fpsDenominator, frameCount: frames.length} : null;
  return {clock, pictureFrames};
}

export function editorExportHasOriginalPicture(clip: {sourceInFrame: number; durationFrames: number},
  asset: {sourcePictureFrames?: number; durationFrames: number; isStill?: boolean}, audioOnly: boolean): boolean {
  const duration = audioOnly ? asset.durationFrames : asset.sourcePictureFrames ?? asset.durationFrames;
  return asset.isStill === true || clip.sourceInFrame + clip.durationFrames <= duration;
}
