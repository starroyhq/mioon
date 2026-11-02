import {createHash} from 'node:crypto';
import {mediaReferenceError} from './errors.ts';
import type {MediaFileHandle} from './file-system.ts';
import {MEDIA_HEADER_BYTES} from './media-type.ts';

// Fingerprints of media references (docs/PROJECT-FILE.md, "素材引用"). The
// sampling rule is fixed here once and never changes, since every stored
// `sampledSha256` was computed with it:
// - a file of at most 1 MiB (1 048 576 bytes) is hashed whole: its SHA-256,
//   which then equals the full hash;
// - a larger file is hashed from 5 ranges of 64 KiB (65 536 bytes). Range i
//   (i = 0…4) starts at floor(i × (size − 65 536) / 4), computed with BigInt
//   so sizes beyond 2^53 lose nothing. The 5 ranges, in order, make one
//   SHA-256.
// The ranges cover the start, the end and the middle, so an MP4's `moov` is
// sampled whether it is in front or at the back, and no file costs more than
// 320 KiB of reading, also on a NAS.
//
// `mtimeMs` is computed here only: Number(mtimeNs / 1000n) / 1000, i.e.
// microseconds, and 0 for times before 1970. Node's numeric mtimeMs differs in
// the last digits (…611.7544 against …611.754), so mixing the two would make
// "the modification time did not change" never hold.

export const SAMPLE_WHOLE_FILE_BYTES = 1_048_576;
export const SAMPLE_RANGE_BYTES = 65_536;
export const SAMPLE_RANGE_COUNT = 5;
/** A file at least this large without a single allocated block has not been
 * downloaded: iCloud and File Provider placeholders look like that. */
export const NOT_DOWNLOADED_MIN_BYTES = 4096;
const READ_CHUNK_BYTES = 65_536;

/** The ranges `sampledSha256` hashes, in order. */
export function sampleRanges(sizeBytes: number): readonly {readonly start: number; readonly length: number}[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('Invalid file size');
  if (sizeBytes <= SAMPLE_WHOLE_FILE_BYTES) return [{start: 0, length: sizeBytes}];
  const span = BigInt(sizeBytes - SAMPLE_RANGE_BYTES), last = BigInt(SAMPLE_RANGE_COUNT - 1);
  return Array.from({length: SAMPLE_RANGE_COUNT}, (_, index) => ({start: Number(BigInt(index) * span / last), length: SAMPLE_RANGE_BYTES}));
}

/** The reference's `mtimeMs`: microseconds of the bigint stat, never negative. */
export function mediaMtimeMs(stats: {readonly mtimeNs: bigint}): number {
  const microseconds = stats.mtimeNs / 1000n;
  return microseconds > 0n ? Number(microseconds) / 1000 : 0;
}

export function isNotDownloaded(stats: {readonly size: bigint; readonly blocks: bigint}): boolean {
  return stats.size >= BigInt(NOT_DOWNLOADED_MIN_BYTES) && stats.blocks === 0n;
}

/** Reads exactly `length` bytes from `start`, in chunks of at most 64 KiB,
 * checking `signal` before each. A short read means the file changed. */
export async function readExactly(handle: MediaFileHandle, start: number, length: number, consume: (chunk: Uint8Array) => void,
  signal?: AbortSignal): Promise<void> {
  const buffer = new Uint8Array(Math.min(length, READ_CHUNK_BYTES));
  for (let done = 0; done < length;) {
    signal?.throwIfAborted();
    const wanted = Math.min(buffer.length, length - done);
    const read = await handle.read(wanted === buffer.length ? buffer : buffer.subarray(0, wanted), start + done);
    if (read <= 0) throw mediaReferenceError('MEDIA_CHANGED_DURING_READ');
    consume(buffer.subarray(0, read));
    done += read;
  }
}

/** The first MEDIA_HEADER_BYTES bytes, or the whole file when it is smaller. */
export async function readHeader(handle: MediaFileHandle, sizeBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const header = new Uint8Array(Math.min(MEDIA_HEADER_BYTES, sizeBytes));
  let filled = 0;
  await readExactly(handle, 0, header.length, chunk => {
    header.set(chunk, filled);
    filled += chunk.length;
  }, signal);
  return header;
}

/** `sampledSha256` of a file of `sizeBytes` bytes. */
export async function hashSamples(handle: MediaFileHandle, sizeBytes: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for (const {start, length} of sampleRanges(sizeBytes)) await readExactly(handle, start, length, chunk => hash.update(chunk), signal);
  return hash.digest('hex');
}

/** SHA-256 of the whole file; `onBytes` hears of every chunk read. */
export async function hashWhole(handle: MediaFileHandle, sizeBytes: number,
  {signal, onBytes}: {readonly signal?: AbortSignal; readonly onBytes?: (bytes: number) => void} = {}): Promise<string> {
  const hash = createHash('sha256');
  await readExactly(handle, 0, sizeBytes, chunk => {
    hash.update(chunk);
    onBytes?.(chunk.length);
  }, signal);
  return hash.digest('hex');
}
