import {validatePng} from './png.ts';
import {IMAGE_EDIT_SOURCE_BOUNDS} from '../../../contracts/src/image-edit-profiles.ts';

// PNG sources keep the strict, fully decoded profile (opaque 8-bit RGB/RGBA).
// JPEG and WebP bytes are sent to the provider unchanged, so only their
// container is checked: one well-formed frame header whose size matches the
// managed asset, an intact end, and no alpha or animation. This refuses
// truncated, mislabeled, transparent or animated files without adding a
// second pixel decoder. References: ITU-T T.81 annex B (JPEG markers) and
// RFC 9649 sections 2.5-2.7 (WebP RIFF, VP8, VP8L, VP8X).
export interface ImageEditSourceBytesOptions {mimeType: unknown; width: number; height: number; signal?: AbortSignal}
const invalid = (): Error => Object.assign(new Error('Image bytes do not match the supported edit source profile.'), {code: 'IMAGE_SOURCE_INVALID', dispatched: false, outcomeUnknown: false});
// Baseline, extended sequential and progressive Huffman frames only.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);
const JPEG_UNSUPPORTED_FRAMES = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Buffer): {width: number; height: number} {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid();
  let offset = 2, segments = 0, size: {width: number; height: number} | null = null;
  for (;;) {
    if (++segments > 4096 || offset + 4 > bytes.length || bytes[offset] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff && offset < bytes.length - 1) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if (JPEG_UNSUPPORTED_FRAMES.has(marker)) throw invalid();
    if (JPEG_FRAMES.has(marker)) {
      if (size || length < 8 || bytes[offset + 2] !== 8) throw invalid();
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5), components = bytes[offset + 7]!;
      if (!height || !width || ![1, 3].includes(components) || length !== 8 + components * 3) throw invalid();
      size = {width, height};
    }
    // Entropy-coded data follows the first scan header; the intact EOI was checked above.
    if (marker === 0xda) { if (!size) throw invalid(); return size; }
    offset += length;
  }
}
function webpSize(bytes: Buffer): {width: number; height: number} {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  const kind = bytes.toString('ascii', 12, 16), length = bytes.readUInt32LE(16), data = bytes.subarray(20, 20 + length);
  if (data.length !== length) throw invalid();
  if (kind === 'VP8 ') {
    // Key frame (bit 0 clear), then the 9d 01 2a start code and 14-bit sizes.
    if (length < 10 || (data[0]! & 1) !== 0 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw invalid();
    return {width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff};
  }
  if (kind === 'VP8L') {
    if (length < 5 || data[0] !== 0x2f) throw invalid();
    const bits = data.readUInt32LE(1);
    // alpha_is_used (bit 28) and a non-zero version (bits 29-31) fail closed.
    if (bits >>> 28) throw invalid();
    return {width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1};
  }
  if (kind === 'VP8X') {
    // Alpha (0x10) or animation (0x02) flags are not an opaque still image.
    if (length < 10 || (data[0]! & 0x12) !== 0) throw invalid();
    return {width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1};
  }
  throw invalid();
}

export async function validateImageEditSourceBytes(bytes: unknown, {mimeType, width, height, signal}: ImageEditSourceBytesOptions): Promise<void> {
  if (signal?.aborted) throw Object.assign(new Error('Image validation cancelled.'), {code: 'IMAGE_CANCELLED', dispatched: false, outcomeUnknown: false});
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMAGE_EDIT_SOURCE_BOUNDS.maxBytes) throw invalid();
  if (mimeType === 'image/png') { await validatePng(bytes, {width, height, opaque: true, signal}); return; }
  const size = mimeType === 'image/jpeg' ? jpegSize(bytes) : mimeType === 'image/webp' ? webpSize(bytes) : null;
  if (!size || size.width !== width || size.height !== height) throw invalid();
}
