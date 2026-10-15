import {createHash} from 'node:crypto';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
import {types} from 'node:util';

/** A deliberately narrow JPEG source-admission profile, not a pixel decoder.
 * References: https://www.w3.org/Graphics/JPEG/itu-t81.pdf (B, C, F),
 * https://www.w3.org/Graphics/JPEG/jfif.pdf. JFIF identifies YCbCr semantics,
 * NOT sRGB: every admitted source still needs explicit sRGB interpretation.
 * APP1..APP15, JFXX, thumbnails, comments, progressive/lossless/arithmetic JPEG,
 * multiple scans, non-square pixels and all unknown markers fail closed.
 */
export const STATIC_SRGB_JFIF_PROFILE = 'jfif-ycbcr8-srgb-v1';
export const STATIC_SRGB_JFIF_DECODER_POLICY = 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1';
export const STATIC_SRGB_JFIF_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  maxEdge: 4096,
  maxPixels: 2_073_600,
  metadataBytes: 1024 * 1024,
  markers: 4096,
  entropyYieldMcus: 64,
});
export type StaticSrgbJfifEvidence = Readonly<{
  profileId: typeof STATIC_SRGB_JFIF_PROFILE;
  sha256: string;
  sourceByteLength: number;
  width: number;
  height: number;
  alphaMode: 'opaque';
  bitDepth: 8;
  orientation: 1;
  colourTag: 'untagged';
  status: 'needs_interpretation';
  sampling: '444' | '422' | '420';
  decoderPolicy: typeof STATIC_SRGB_JFIF_DECODER_POLICY;
}>;
export type JpegAdmissionErrorCode = 'invalid_jpeg_input' | 'unsupported_jpeg' | 'corrupt_jpeg' | 'jpeg_budget_exceeded';
export class JpegAdmissionError extends Error {
  readonly code: JpegAdmissionErrorCode;
  constructor(code: JpegAdmissionErrorCode) {
    super('The image does not satisfy the bounded static sRGB JFIF profile.');
    this.name = 'JpegAdmissionError';
    this.code = code;
  }
}
export interface StaticSrgbJfifInspectionOptions {
  readonly signal?: AbortSignal;
  /** Trusted runtime ownership/lifecycle fence, never source-supplied data. */
  readonly beforeEffect?: () => void;
}
const fail = (code: JpegAdmissionErrorCode): JpegAdmissionError => new JpegAdmissionError(code);
const LIMITS = STATIC_SRGB_JFIF_LIMITS;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const copyBytes = Uint8Array.prototype.set;
function ownedBytes(value: Uint8Array): Uint8Array {
  if (!types.isUint8Array(value) || types.isProxy(value)) throw fail('invalid_jpeg_input');
  const buffer: unknown = bufferGetter.call(value);
  if (types.isSharedArrayBuffer(buffer)) throw fail('invalid_jpeg_input');
  const length: number = byteLengthGetter.call(value);
  if (length > LIMITS.sourceBytes) throw fail('jpeg_budget_exceeded');
  const owned = new Uint8Array(length);
  try { copyBytes.call(owned, value); }
  catch { throw fail('invalid_jpeg_input'); }
  return owned;
}
const u16 = (bytes: Uint8Array, offset: number): number => bytes[offset] * 256 + bytes[offset + 1];
interface Huffman {
  first: Int32Array;
  count: Uint16Array;
  index: Uint16Array;
  values: Uint8Array;
}
interface Component {id: number; horizontal: number; vertical: number; quantization: number; dc: number; ac: number}
interface ParsedJpeg {
  width: number;
  height: number;
  sampling: StaticSrgbJfifEvidence['sampling'];
  components: Component[];
  dc: Map<number, Huffman>;
  ac: Map<number, Huffman>;
  restartInterval: number;
  entropyOffset: number;
  metadataBytes: number;
}
/** Canonical prefix construction never creates a 2^16 table. Incomplete trees
 * are legal (and required to avoid the all-ones padding code). An undefined
 * entropy path is rejected by the bounded 16-bit symbol reader below.
 */
function huffman(bytes: Uint8Array, start: number, end: number, kind: number): {table: Huffman; next: number} {
  if (end - start < 16) throw fail('corrupt_jpeg');
  const first = new Int32Array(17), count = new Uint16Array(17), index = new Uint16Array(17);
  let code = 0, symbols = 0;
  for (let bits = 1; bits <= 16; bits++) {
    const amount = bytes[start + bits - 1];
    first[bits] = code;
    count[bits] = amount;
    index[bits] = symbols;
    // Equality would assign the all-ones code, forbidden by JPEG T.81 C.2.
    if (code + amount >= 2 ** bits) throw fail('corrupt_jpeg');
    symbols += amount;
    code = (code + amount) * 2;
  }
  if (symbols === 0 || symbols > 256 || end - start - 16 < symbols) throw fail('corrupt_jpeg');
  const values = bytes.subarray(start + 16, start + 16 + symbols);
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) throw fail('corrupt_jpeg');
    seen.add(value);
    if (kind === 0 ? value > 11 : ((value & 15) > 10 || ((value & 15) === 0 && value !== 0 && value !== 0xf0)))
      throw fail('corrupt_jpeg');
  }
  return {table: {first, count, index, values}, next: start + 16 + symbols};
}
function parseHeaders(bytes: Uint8Array, fence: () => void): ParsedJpeg {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail('corrupt_jpeg');
  let offset = 2, markerCount = 0, metadataBytes = 0;
  let jfif = false, frame = false, dri = false, width = 0, height = 0, restartInterval = 0;
  let sampling: StaticSrgbJfifEvidence['sampling'] = '444';
  const components: Component[] = [], quantization = new Set<number>();
  const dc = new Map<number, Huffman>(), ac = new Map<number, Huffman>();
  while (offset < bytes.length) {
    fence();
    if (++markerCount > LIMITS.markers) throw fail('jpeg_budget_exceeded');
    const markerStart = offset;
    if (bytes[offset++] !== 0xff) throw fail('corrupt_jpeg');
    // Legal marker fill bytes are bounded by the header budget, including a
    // malformed all-FF input; do not scan megabytes without lifecycle fences.
    while (offset < bytes.length && bytes[offset] === 0xff) {
      if (offset - markerStart + metadataBytes > LIMITS.metadataBytes) throw fail('jpeg_budget_exceeded');
      if ((offset & 4095) === 0) fence();
      offset++;
    }
    if (offset >= bytes.length) throw fail('corrupt_jpeg');
    const marker = bytes[offset++];
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) throw fail('corrupt_jpeg');
    if (markerCount === 1 && marker !== 0xe0) throw fail('unsupported_jpeg');
    if (![0xe0, 0xdb, 0xc4, 0xc0, 0xdd, 0xda].includes(marker)) throw fail('unsupported_jpeg');
    if (bytes.length - offset < 2) throw fail('corrupt_jpeg');
    const length = u16(bytes, offset), start = offset + 2, end = offset + length;
    if (length < 2 || end > bytes.length) throw fail('corrupt_jpeg');
    metadataBytes += end - markerStart;
    if (metadataBytes > LIMITS.metadataBytes) throw fail('jpeg_budget_exceeded');
    if (marker === 0xe0) {
      if (jfif) throw fail('corrupt_jpeg');
      if (length !== 16 || bytes[start] !== 0x4a || bytes[start + 1] !== 0x46 || bytes[start + 2] !== 0x49 ||
          bytes[start + 3] !== 0x46 || bytes[start + 4] !== 0 || bytes[start + 5] !== 1 ||
          (bytes[start + 6] !== 1 && bytes[start + 6] !== 2) || bytes[start + 7] > 2 ||
          bytes[start + 12] !== 0 || bytes[start + 13] !== 0) throw fail('unsupported_jpeg');
      if (u16(bytes, start + 8) === 0 || u16(bytes, start + 8) !== u16(bytes, start + 10)) throw fail('unsupported_jpeg');
      jfif = true;
    } else if (marker === 0xdb) {
      if (start === end) throw fail('corrupt_jpeg');
      let cursor = start;
      while (cursor < end) {
        const selector = bytes[cursor++], id = selector & 15;
        if ((selector >>> 4) !== 0 || id > 3) throw fail('unsupported_jpeg');
        if (quantization.has(id) || end - cursor < 64) throw fail('corrupt_jpeg');
        for (let index = 0; index < 64; index++) if (bytes[cursor + index] === 0) throw fail('corrupt_jpeg');
        cursor += 64;
        quantization.add(id);
      }
    } else if (marker === 0xc4) {
      if (start === end) throw fail('corrupt_jpeg');
      let cursor = start;
      while (cursor < end) {
        const selector = bytes[cursor++], kind = selector >>> 4, id = selector & 15;
        if (kind > 1 || id > 1) throw fail('unsupported_jpeg');
        const destination = kind === 0 ? dc : ac;
        if (destination.has(id)) throw fail('corrupt_jpeg');
        const parsed = huffman(bytes, cursor, end, kind);
        destination.set(id, parsed.table);
        cursor = parsed.next;
      }
    } else if (marker === 0xc0) {
      if (frame) throw fail('corrupt_jpeg');
      if (length !== 17) throw fail('unsupported_jpeg');
      if (bytes[start] !== 8 || bytes[start + 5] !== 3) throw fail('unsupported_jpeg');
      height = u16(bytes, start + 1); width = u16(bytes, start + 3);
      if (width === 0 || height === 0) throw fail('corrupt_jpeg');
      if (width > LIMITS.maxEdge || height > LIMITS.maxEdge || width * height > LIMITS.maxPixels) throw fail('jpeg_budget_exceeded');
      for (let index = 0; index < 3; index++) {
        const cursor = start + 6 + index * 3;
        const id = bytes[cursor], sample = bytes[cursor + 1], table = bytes[cursor + 2];
        if (id !== index + 1 || table > 3 || (index === 0 ? ![0x11, 0x21, 0x22].includes(sample) : sample !== 0x11))
          throw fail('unsupported_jpeg');
        components.push({id, horizontal: sample >>> 4, vertical: sample & 15, quantization: table, dc: 0, ac: 0});
      }
      sampling = components[0].vertical === 2 ? '420' : components[0].horizontal === 2 ? '422' : '444';
      frame = true;
    } else if (marker === 0xdd) {
      if (dri || length !== 4) throw fail('corrupt_jpeg');
      restartInterval = u16(bytes, start);
      dri = true;
    } else {
      if (!jfif || !frame || length !== 12 || bytes[start] !== 3) throw fail('corrupt_jpeg');
      if (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0) throw fail('unsupported_jpeg');
      for (let index = 0; index < 3; index++) {
        const component = components[index], cursor = start + 1 + index * 2, selector = bytes[cursor + 1];
        if (bytes[cursor] !== component.id || (selector >>> 4) > 1 || (selector & 15) > 1) throw fail('unsupported_jpeg');
        component.dc = selector >>> 4; component.ac = selector & 15;
        if (!quantization.has(component.quantization) || !dc.has(component.dc) || !ac.has(component.ac)) throw fail('corrupt_jpeg');
      }
      return {width, height, sampling, components, dc, ac, restartInterval, entropyOffset: end, metadataBytes};
    }
    offset = end;
  }
  throw fail('corrupt_jpeg');
}

/** Consumes actual Huffman coefficients, not merely marker-looking bytes. Every
 * read is bounded by 16 Huffman bits, 11 amplitude bits, 64 coefficients/block,
 * <=6 blocks/MCU and the capped image's MCU grid. No DCT/pixel plane is allocated.
 */
class EntropyReader {
  readonly bytes: Uint8Array;
  offset: number;
  private current = 0;
  private remaining = 0;
  private metadataBytes: number;
  constructor(bytes: Uint8Array, offset: number, metadataBytes: number) {
    this.bytes = bytes; this.offset = offset; this.metadataBytes = metadataBytes;
  }
  bit(): number {
    if (this.remaining === 0) {
      if (this.offset >= this.bytes.length) throw fail('corrupt_jpeg');
      this.current = this.bytes[this.offset++];
      if (this.current === 0xff) {
        // Only FF00 is a literal FF data byte. A restart/end marker encountered
        // during a coefficient means the preceding entropy segment is truncated.
        if (this.offset >= this.bytes.length || this.bytes[this.offset++] !== 0) throw fail('corrupt_jpeg');
      }
      this.remaining = 8;
    }
    this.remaining--;
    return (this.current >>> this.remaining) & 1;
  }
  amplitude(bits: number): number {
    if (bits === 0) return 0;
    let value = 0;
    for (let index = 0; index < bits; index++) value = value * 2 + this.bit();
    return value < 2 ** (bits - 1) ? value - (2 ** bits - 1) : value;
  }
  symbol(table: Huffman): number {
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      code = code * 2 + this.bit();
      const delta = code - table.first[bits];
      if (delta >= 0 && delta < table.count[bits]) return table.values[table.index[bits] + delta];
    }
    throw fail('corrupt_jpeg');
  }
  boundary(expected: number, fence: () => void): void {
    if (this.remaining !== 0 && (this.current & ((1 << this.remaining) - 1)) !== (1 << this.remaining) - 1)
      throw fail('corrupt_jpeg');
    this.remaining = 0;
    if (this.offset >= this.bytes.length || this.bytes[this.offset++] !== 0xff) throw fail('corrupt_jpeg');
    // Share one metadata budget across headers, every restart/end marker and
    // all marker fill. The source-byte ceiling is an additional outer bound.
    this.metadataBytes += 2;
    if (this.metadataBytes > LIMITS.metadataBytes) throw fail('jpeg_budget_exceeded');
    // Permit standard FF fill before a marker, never FF FF 00 stuffing.
    let fill = 0;
    while (this.offset < this.bytes.length && this.bytes[this.offset] === 0xff) {
      if (++this.metadataBytes > LIMITS.metadataBytes) throw fail('jpeg_budget_exceeded');
      if ((++fill & 4095) === 0) fence();
      this.offset++;
    }
    if (this.offset >= this.bytes.length || this.bytes[this.offset++] !== expected) throw fail('corrupt_jpeg');
  }
}
async function validateEntropy(bytes: Uint8Array, parsed: ParsedJpeg, fence: () => void): Promise<void> {
  const reader = new EntropyReader(bytes, parsed.entropyOffset, parsed.metadataBytes);
  const luma = parsed.components[0];
  const mcuCount = Math.ceil(parsed.width / (8 * luma.horizontal)) * Math.ceil(parsed.height / (8 * luma.vertical));
  const components = parsed.components.map(component => ({blocks: component.horizontal * component.vertical,
    dc: parsed.dc.get(component.dc)!, ac: parsed.ac.get(component.ac)!, predictor: 0}));
  let restart = 0;
  for (let mcu = 0; mcu < mcuCount; mcu++) {
    if (mcu % LIMITS.entropyYieldMcus === 0) {
      // Always yield once, even for a one-MCU image: cancellation can arrive
      // after the owned snapshot without the caller's bytes affecting evidence.
      fence(); await yieldToLoop(); fence();
    }
    for (const component of components) for (let block = 0; block < component.blocks; block++) {
      component.predictor += reader.amplitude(reader.symbol(component.dc));
      // T.81 F.1.1.4: 8-bit input has signed 11-bit quantized coefficients.
      // Category11 describes a DIFFERENCE, not permission for an unbounded
      // accumulated DC. Track each component separately, including Y's blocks.
      if (component.predictor < -1024 || component.predictor > 1023) throw fail('corrupt_jpeg');
      let coefficient = 1;
      while (coefficient < 64) {
        const symbol = reader.symbol(component.ac), run = symbol >>> 4, size = symbol & 15;
        if (size === 0) {
          if (run === 0) break;
          // DHT already limits zero-size symbols to EOB or ZRL.
          coefficient += 16;
          if (coefficient > 64) throw fail('corrupt_jpeg');
        } else {
          coefficient += run;
          if (coefficient >= 64) throw fail('corrupt_jpeg');
          reader.amplitude(size);
          coefficient++;
        }
      }
    }
    if (parsed.restartInterval !== 0 && (mcu + 1) % parsed.restartInterval === 0 && mcu + 1 < mcuCount) {
      reader.boundary(0xd0 + restart, fence);
      restart = (restart + 1) & 7;
      for (const component of components) component.predictor = 0;
    }
  }
  fence();
  reader.boundary(0xd9, fence);
  if (reader.offset !== bytes.length) throw fail('corrupt_jpeg');
}

/** Hash/evidence refer only to the immutable full-file snapshot. This verifies
 * syntax and complete baseline entropy, not reconstructed pixels or actual
 * source colour primaries. The caller must obtain explicit sRGB interpretation,
 * use the pinned decoder policy and recheck external asset identity/ownership.
 * Runtime lifecycle errors and abort reasons propagate without being rewritten.
 */
export async function inspectStaticSrgbJfif(bytes: Uint8Array, options: StaticSrgbJfifInspectionOptions = {}): Promise<StaticSrgbJfifEvidence> {
  const {signal, beforeEffect} = options;
  const fence = (): void => { signal?.throwIfAborted(); beforeEffect?.(); signal?.throwIfAborted(); };
  fence();
  const owned = ownedBytes(bytes), parsed = parseHeaders(owned, fence);
  await validateEntropy(owned, parsed, fence);
  fence();
  const sha256 = createHash('sha256').update(owned).digest('hex');
  fence();
  return Object.freeze({profileId: STATIC_SRGB_JFIF_PROFILE, sha256, sourceByteLength: owned.length,
    width: parsed.width, height: parsed.height, alphaMode: 'opaque', bitDepth: 8, orientation: 1,
    colourTag: 'untagged', status: 'needs_interpretation', sampling: parsed.sampling,
    decoderPolicy: STATIC_SRGB_JFIF_DECODER_POLICY});
}
