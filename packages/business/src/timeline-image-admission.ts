import {createHash} from 'node:crypto';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {types} from 'node:util';
import {createInflate, crc32} from 'node:zlib';

/** Source admission only, never a change to ordinary image-import budgets.
 * The profile accepts static, non-interlaced RGB8/RGBA8 PNG with square pixels
 * and no orientation metadata. Only sRGB, canonical gAMA and canonical cHRM
 * ancillary chunks are allowed. ALL other chunks are rejected, not stripped:
 * this includes otherwise benign pHYs/text/time, EXIF (even orientation 1),
 * ICC, cICP/HDR/gain maps, APNG, palettes and transparency colour keys.
 */
export const STATIC_SRGB_PNG_PROFILE = 'png-rgb8-srgb-v1';
export const STATIC_SRGB_PNG_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  maxEdge: 4096,
  maxPixels: 2_073_600,
  metadataBytes: 1024 * 1024,
  chunks: 4096,
  inflateChunkBytes: 16 * 1024,
});

export type StaticSrgbPngEvidence = Readonly<{
  profileId: typeof STATIC_SRGB_PNG_PROFILE;
  sha256: string;
  sourceByteLength: number;
  width: number;
  height: number;
  alphaMode: 'opaque' | 'straight';
  bitDepth: 8;
  orientation: 1;
  colourTag: 'srgb' | 'untagged';
  status: 'compatible' | 'needs_interpretation';
}>;
export type PngAdmissionErrorCode = 'invalid_png_input' | 'unsupported_png' | 'corrupt_png' | 'png_budget_exceeded';
export class PngAdmissionError extends Error {
  readonly code: PngAdmissionErrorCode;
  constructor(code: PngAdmissionErrorCode) {
    super('The image does not satisfy the bounded static sRGB PNG profile.');
    this.name = 'PngAdmissionError';
    this.code = code;
  }
}
export interface StaticSrgbPngInspectionOptions {
  readonly signal?: AbortSignal;
  /** Trusted runtime ownership/lifecycle fence, not source-supplied data. */
  readonly beforeEffect?: () => void;
}
const failure = (code: PngAdmissionErrorCode): PngAdmissionError => new PngAdmissionError(code);
const LIMITS = STATIC_SRGB_PNG_LIMITS;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const canonicalChroma = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const copyBytes = Uint8Array.prototype.set;

/** Snapshot via typed-array intrinsics: no source .length, .buffer, iterator,
 * species, methods or accessors run. Reject shared storage to prevent concurrent
 * mutation during the snapshot. All later parsing and hashing use our copy.
 */
function ownedBytes(value: Uint8Array): Uint8Array {
  if (!types.isUint8Array(value) || types.isProxy(value)) throw failure('invalid_png_input');
  const sourceBuffer: unknown = bufferGetter.call(value);
  if (types.isSharedArrayBuffer(sourceBuffer)) throw failure('invalid_png_input');
  const length: number = byteLengthGetter.call(value);
  if (length > LIMITS.sourceBytes) throw failure('png_budget_exceeded');
  const owned = new Uint8Array(length);
  try { copyBytes.call(owned, value); }
  catch { throw failure('invalid_png_input'); }
  return owned;
}
const u32 = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];

interface ParsedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  tagged: boolean;
  compressed: Uint8Array[];
  compressedBytes: number;
}
function parseChunks(bytes: Uint8Array, fence: () => void): ParsedPng {
  if (bytes.length < signature.length || signature.some((value, index) => bytes[index] !== value))
    throw failure('corrupt_png');
  let offset = signature.length, count = 0, metadataBytes = 0;
  let width = 0, height = 0, channels: 3 | 4 = 3, tagged = false;
  let seenHeader = false, seenData = false, seenEnd = false;
  const colours = new Set<string>();
  const compressed: Uint8Array[] = [];
  let compressedBytes = 0;
  while (offset < bytes.length) {
    fence();
    if (++count > LIMITS.chunks) throw failure('png_budget_exceeded');
    if (bytes.length - offset < 12) throw failure('corrupt_png');
    const length = u32(bytes, offset), dataStart = offset + 8;
    if (length > 0x7fffffff || length > bytes.length - offset - 12) throw failure('corrupt_png');
    // Every type byte is an ASCII letter; the PNG reserved bit must be zero.
    for (let index = offset + 4; index < offset + 8; index++) {
      const value = bytes[index];
      if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) throw failure('corrupt_png');
    }
    if ((bytes[offset + 6] & 32) !== 0) throw failure('corrupt_png');
    const kind = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataEnd = dataStart + length;
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== u32(bytes, dataEnd)) throw failure('corrupt_png');
    if (!seenHeader && kind !== 'IHDR') throw failure('corrupt_png');
    if (kind !== 'IDAT') {
      metadataBytes += length + 12;
      if (metadataBytes > LIMITS.metadataBytes) throw failure('png_budget_exceeded');
    }
    if (kind === 'IHDR') {
      if (seenHeader || count !== 1 || length !== 13) throw failure('corrupt_png');
      seenHeader = true;
      width = u32(bytes, dataStart);
      height = u32(bytes, dataStart + 4);
      if (width === 0 || height === 0) throw failure('corrupt_png');
      if (width > LIMITS.maxEdge || height > LIMITS.maxEdge || width * height > LIMITS.maxPixels)
        throw failure('png_budget_exceeded');
      const colourType = bytes[dataStart + 9];
      if (bytes[dataStart + 8] !== 8 || (colourType !== 2 && colourType !== 6) ||
          bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0)
        throw failure('unsupported_png');
      channels = colourType === 6 ? 4 : 3;
    } else if (kind === 'IDAT') {
      seenData = true;
      compressed.push(bytes.subarray(dataStart, dataEnd));
      compressedBytes += length;
    } else if (kind === 'IEND') {
      if (!seenData || compressedBytes === 0 || length !== 0 || dataEnd + 4 !== bytes.length)
        throw failure('corrupt_png');
      seenEnd = true;
    } else if (kind === 'sRGB' || kind === 'gAMA' || kind === 'cHRM') {
      // This also enforces a single consecutive IDAT run: no admitted chunk can
      // appear after IDAT except the final, empty IEND.
      if (seenData || colours.has(kind)) throw failure('corrupt_png');
      colours.add(kind);
      if (kind === 'sRGB') {
        if (length !== 1 || bytes[dataStart] > 3) throw failure('corrupt_png');
        tagged = true;
      } else if (kind === 'gAMA') {
        if (length !== 4) throw failure('corrupt_png');
        if (u32(bytes, dataStart) !== 45455) throw failure('unsupported_png');
      } else {
        if (length !== 32) throw failure('corrupt_png');
        if (canonicalChroma.some((value, index) => u32(bytes, dataStart + 4 * index) !== value))
          throw failure('unsupported_png');
      }
    } else {
      // Do not infer safety from PNG's ancillary or safe-to-copy bits. Unknown
      // colour/gain-map extensions and unknown critical chunks all fail closed.
      throw failure('unsupported_png');
    }
    offset = dataEnd + 4;
  }
  if (!seenHeader || !seenEnd) throw failure('corrupt_png');
  return {width, height, channels, tagged, compressed, compressedBytes};
}

/** Streaming decompression retains no decoded pixel plane. It verifies zlib's
 * checksum/end marker, the exact expected scanline byte count, every filter byte
 * and consumption of every compressed byte (no concatenated/trailing streams).
 * Only one bounded inflate chunk plus stream backpressure queues can exceed the
 * expected output before rejection, so a compressed bomb cannot allocate its
 * advertised output. Unfiltering is unnecessary: every 8-bit sample is valid.
 */
async function validateScanlines(parsed: ParsedPng, fence: () => void, signal?: AbortSignal): Promise<void> {
  const stride = parsed.width * parsed.channels + 1, expectedBytes = stride * parsed.height;
  let received = 0, nextFilter = 0, boundaryFailed = false, boundaryFailure: unknown;
  const streamFence = (): void => {
    try { fence(); }
    catch (error) {
      boundaryFailed = true;
      boundaryFailure = error;
      throw error instanceof Error ? error : failure('invalid_png_input');
    }
  };
  function* input(): Generator<Uint8Array> {
    for (const data of parsed.compressed) for (let offset = 0; offset < data.length; offset += LIMITS.inflateChunkBytes) {
      streamFence();
      yield data.subarray(offset, Math.min(data.length, offset + LIMITS.inflateChunkBytes));
    }
  }
  const inflater = createInflate({chunkSize: LIMITS.inflateChunkBytes});
  const validator = new Writable({
    highWaterMark: LIMITS.inflateChunkBytes,
    write(chunk: Buffer, _encoding, callback) {
      try {
        streamFence();
        if (chunk.length > expectedBytes - received) throw failure('png_budget_exceeded');
        const end = received + chunk.length;
        while (nextFilter < end) {
          if (chunk[nextFilter - received] > 4) throw failure('corrupt_png');
          nextFilter += stride;
        }
        received = end;
        callback();
      } catch (error) { callback(error as Error); }
    },
  });
  try {
    await pipeline(Readable.from(input(), {objectMode: false, highWaterMark: LIMITS.inflateChunkBytes}), inflater, validator, {signal});
  } catch (error) {
    if (boundaryFailed) throw boundaryFailure;
    signal?.throwIfAborted();
    if (error instanceof PngAdmissionError) throw error;
    throw failure('corrupt_png');
  }
  fence();
  if (received !== expectedBytes || nextFilter !== expectedBytes || inflater.bytesWritten !== parsed.compressedBytes)
    throw failure('corrupt_png');
}

/** Inspect actual source bytes, not a filename, MIME claim or saved declaration.
 * A valid untagged image still requires explicit user sRGB interpretation by the
 * caller. Conflicting metadata never becomes an overrideable untagged image.
 * Evidence describes only our complete, immutable byte snapshot; callers must
 * revalidate ownership/identity when binding it to an external asset or render.
 * Runtime fence errors and AbortSignal reasons deliberately propagate unchanged.
 */
export async function inspectStaticSrgbPng(bytes: Uint8Array, options: StaticSrgbPngInspectionOptions = {}): Promise<StaticSrgbPngEvidence> {
  const {signal, beforeEffect} = options;
  const fence = (): void => { signal?.throwIfAborted(); beforeEffect?.(); signal?.throwIfAborted(); };
  fence();
  const owned = ownedBytes(bytes);
  const parsed = parseChunks(owned, fence);
  await validateScanlines(parsed, fence, signal);
  fence();
  const sha256 = createHash('sha256').update(owned).digest('hex');
  fence();
  return Object.freeze({
    profileId: STATIC_SRGB_PNG_PROFILE,
    sha256,
    sourceByteLength: owned.length,
    width: parsed.width,
    height: parsed.height,
    alphaMode: parsed.channels === 4 ? 'straight' : 'opaque',
    bitDepth: 8,
    orientation: 1,
    colourTag: parsed.tagged ? 'srgb' : 'untagged',
    status: parsed.tagged ? 'compatible' : 'needs_interpretation',
  });
}
