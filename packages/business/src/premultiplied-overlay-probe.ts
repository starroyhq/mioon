import {mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';

// FFmpeg 8.1 added frame alpha-mode negotiation to `overlay` and tagged decoded
// PNG frames as straight alpha. A staged RGBA8 PNG already holds premultiplied
// bytes, so `overlay=alpha=premultiplied` premultiplied them a second time.
// `setparams=alpha_mode=premultiplied` restores the intended interpretation; it
// exists since the same release and is a graph-parse error on older tools.
// This probe renders one tiny frame through the exact production shape and
// compares the decoded pixel instead of trusting a version string.
export const PREMULTIPLIED_OVERLAY_EXPECTED = Object.freeze([89, 83, 172]);
export const PREMULTIPLIED_OVERLAY_TOLERANCE = 1;
export const PREMULTIPLIED_OVERLAY_ALPHA_MODE_TAG = ',setparams=alpha_mode=premultiplied';
export type PremultipliedOverlayVariant = 'alpha-mode-tag' | 'legacy';

export interface PremultipliedOverlayProbeResult {
  readonly ok: boolean;
  readonly variant: PremultipliedOverlayVariant;
  /** False when the tool has no `setparams.alpha_mode` (FFmpeg < 8.1). */
  readonly filterSupported: boolean;
  readonly expected: readonly number[];
  readonly observed: readonly number[] | null;
}

export type ProbeExecute = (file: string, args: readonly string[], options: {timeout: number}) => Promise<unknown>;
export interface PremultipliedOverlayProbeOptions {
  readonly execute: ProbeExecute;
  readonly temporaryRoot?: string;
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'latin1'), size = Buffer.alloc(4), sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
}
function encodePng(width: number, height: number, channels: 3 | 4, pixel: readonly number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const row = Buffer.alloc(width * channels + 1);
  for (let x = 0; x < width; x += 1) for (let channel = 0; channel < channels; channel += 1) row[1 + x * channels + channel] = pixel[channel]!;
  const rows = Buffer.concat(Array.from({length: height}, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('sRGB', Buffer.from([0])), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND')]);
}
function graph(tagged: boolean): string {
  const overlay = tagged ? 'format=rgba,setparams=alpha_mode=premultiplied' : 'format=rgba';
  return `[0:v]format=rgba[main];[1:v]${overlay}[over];[main][over]overlay=alpha=premultiplied:format=rgb[out]`;
}
async function render(frame: string, ffmpeg: string, execute: ProbeExecute, directory: string): Promise<readonly number[] | null> {
  const output = path.join(directory, 'probe.rgb');
  await rm(output, {force: true});
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_complex_threads', '1',
    '-threads', '1', '-i', path.join(directory, 'main.png'), '-threads', '1', '-i', path.join(directory, 'overlay.png'),
    '-filter_complex', graph(frame === 'tagged'), '-map', '[out]', '-frames:v', '1', '-an', '-threads', '1',
    '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'rawvideo', output];
  await execute(ffmpeg, args, {timeout: 15000});
  const bytes = await readFile(output);
  if (bytes.length !== 12) throw Object.assign(new Error('Premultiplied overlay probe produced an unexpected frame.'), {code: 'PREMULTIPLIED_OVERLAY_PROBE_INVALID'});
  return [bytes[0]!, bytes[1]!, bytes[2]!];
}
const matches = (observed: readonly number[] | null): boolean => observed !== null &&
  observed.length === PREMULTIPLIED_OVERLAY_EXPECTED.length &&
  observed.every((value, index) => Math.abs(value - PREMULTIPLIED_OVERLAY_EXPECTED[index]!) <= PREMULTIPLIED_OVERLAY_TOLERANCE);

/** Renders the reviewed premultiplied-overlay frame with the production graph
 * shape. A tool that lacks the alpha-mode filter keeps the legacy shape; a tool
 * whose legacy shape is still wrong reports `ok: false` instead of silently
 * darkening transparent layers. */
export async function probePremultipliedOverlay(ffmpeg: string, {execute, temporaryRoot = tmpdir()}: PremultipliedOverlayProbeOptions): Promise<PremultipliedOverlayProbeResult> {
  const directory = path.join(await realpath(temporaryRoot), 'mioon-premultiplied-overlay-' + randomUUID());
  await mkdir(directory, {mode: 0o700});
  try {
    await writeFile(path.join(directory, 'main.png'), encodePng(2, 2, 3, [51, 102, 153]), {flag: 'wx', mode: 0o600});
    await writeFile(path.join(directory, 'overlay.png'), encodePng(2, 2, 4, [64, 32, 96, 128]), {flag: 'wx', mode: 0o600});
    try {
      const tagged = await render('tagged', ffmpeg, execute, directory);
      if (!matches(tagged)) throw Object.assign(new Error('Premultiplied overlay probe mismatch.'), {code: 'PREMULTIPLIED_OVERLAY_PROBE_MISMATCH'});
      return Object.freeze({ok: true, variant: 'alpha-mode-tag', filterSupported: true, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: tagged});
    } catch (error) {
      if ((error as {code?: unknown})?.code === 'PREMULTIPLIED_OVERLAY_PROBE_INVALID') throw error;
      // Unknown `alpha_mode` rejects during graph parsing on FFmpeg < 8.1.
    }
    try {
      const legacy = await render('legacy', ffmpeg, execute, directory);
      return Object.freeze({ok: matches(legacy), variant: 'legacy', filterSupported: false, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: legacy});
    } catch {
      return Object.freeze({ok: false, variant: 'legacy', filterSupported: false, expected: PREMULTIPLIED_OVERLAY_EXPECTED, observed: null});
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
