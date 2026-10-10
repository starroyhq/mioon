import {createHash} from 'node:crypto';
import {createInflate, deflate} from 'node:zlib';
import {Readable} from 'node:stream';
import {promisify} from 'node:util';
import {setImmediate as yieldTurn} from 'node:timers/promises';

// This is a bounded, deliberately narrow PNG profile, not a general media decoder.
// PNG structure/filter rules: https://www.w3.org/TR/png-3/ (reviewed 2026-10-10).
export const IMAGE_PNG_LIMITS = Object.freeze({maxBytes: 30 * 1024 * 1024, maxPixels: 1024 * 1024, maxEdge: 1024, maxChunks: 4096, maxMetadataBytes: 1024 * 1024});
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const invalid = (code = 'IMAGE_PNG_INVALID') => Object.assign(new Error(code === 'IMAGE_CANCELLED' ? 'Image validation cancelled.' : 'Image bytes do not match the supported PNG profile.'), {code, dispatched: false, outcomeUnknown: false});
function checkAbort(signal) { if (signal?.aborted) throw invalid('IMAGE_CANCELLED'); }
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8);
  return result;
}
function validDimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= IMAGE_PNG_LIMITS.maxEdge && height <= IMAGE_PNG_LIMITS.maxEdge && width * height <= IMAGE_PNG_LIMITS.maxPixels;
}
function keywordEnd(data) {
  const end = data.indexOf(0);
  if (end < 1 || end > 79) throw invalid();
  const keyword = data.subarray(0, end);
  if (keyword[0] === 32 || keyword.at(-1) === 32 || keyword.some((byte, index) => !((byte >= 32 && byte <= 126) || byte >= 161) || (byte === 32 && keyword[index - 1] === 32))) throw invalid();
  return end;
}
function validateAncillary(type, data, {colorType, beforeData, beforePalette, seen}) {
  const single = ['cHRM', 'gAMA', 'sRGB', 'sBIT', 'pHYs', 'bKGD', 'tIME', 'caBX'];
  if (single.includes(type) && seen.has(type)) throw invalid();
  if (['cHRM', 'gAMA', 'sRGB', 'sBIT'].includes(type) && (!beforeData || !beforePalette)) throw invalid();
  if (['pHYs', 'bKGD'].includes(type) && !beforeData) throw invalid();
  switch (type) {
    case 'cHRM': if (data.length !== 32) throw invalid(); break;
    case 'gAMA': if (data.length !== 4 || data.readUInt32BE() === 0) throw invalid(); break;
    case 'sRGB': if (data.length !== 1 || data[0] > 3) throw invalid(); break;
    case 'sBIT': if (data.length !== (colorType === 6 ? 4 : 3) || data.some(byte => byte < 1 || byte > 8)) throw invalid(); break;
    case 'pHYs': if (data.length !== 9 || data[8] > 1) throw invalid(); break;
    case 'bKGD': if (data.length !== 6 || [0, 2, 4].some(offset => data.readUInt16BE(offset) > 255)) throw invalid(); break;
    case 'tIME': if (data.length !== 7 || data[2] < 1 || data[2] > 12 || data[3] < 1 || data[3] > 31 || data[4] > 23 || data[5] > 59 || data[6] > 60) throw invalid(); break;
    case 'tEXt': {
      const end = keywordEnd(data);
      if (data.subarray(end + 1).includes(0)) throw invalid();
      break;
    }
    case 'iTXt': {
      const end = keywordEnd(data);
      // Compressed text is deliberately unsupported: no second decompression path.
      if (end + 5 > data.length || data[end + 1] !== 0 || data[end + 2] !== 0) throw invalid('IMAGE_PNG_UNSUPPORTED');
      const languageEnd = data.indexOf(0, end + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
      if (languageEnd < 0 || translatedEnd < 0 || !/^[A-Za-z0-9-]*$/.test(data.toString('ascii', end + 3, languageEnd)) || data.subarray(end + 3, languageEnd).some(byte => byte > 127)) throw invalid();
      try {
        const decoder = new TextDecoder('utf-8', {fatal: true});
        decoder.decode(data.subarray(languageEnd + 1, translatedEnd));
        decoder.decode(data.subarray(translatedEnd + 1));
      } catch { throw invalid(); }
      if (data.subarray(translatedEnd + 1).includes(0)) throw invalid();
      break;
    }
    // Bounded provenance is retained as uninterpreted bytes, never parsed/executed.
    case 'caBX': if (!data.length) throw invalid(); break;
    default: throw invalid('IMAGE_PNG_UNSUPPORTED');
  }
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** Validate every compressed scanline without retaining a decoded image. At most
 * two rows plus one 16 KiB inflate chunk are live. The compressed input must be
 * exactly one complete zlib stream (no ignored tail, concatenation or truncation). */
async function validateScanlines(idat, width, height, channels, {signal, requireOpaque}) {
  const stride = width * channels, expected = (stride + 1) * height;
  let current = Buffer.alloc(stride), previous = Buffer.alloc(stride), position = 0, rows = 0, outputBytes = 0, filter = 0;
  const inflater = createInflate({chunkSize: 16 * 1024});
  const source = Readable.from(idat);
  const abort = () => { source.destroy(invalid('IMAGE_CANCELLED')); inflater.destroy(invalid('IMAGE_CANCELLED')); };
  source.on('error', error => inflater.destroy(error));
  signal?.addEventListener('abort', abort, {once: true});
  try {
    checkAbort(signal); source.pipe(inflater);
    for await (const bytes of inflater) {
      checkAbort(signal);
      outputBytes += bytes.length;
      if (outputBytes > expected) throw invalid('IMAGE_PNG_TOO_LARGE');
      for (const value of bytes) {
        if (position === 0) { filter = value; if (filter > 4) throw invalid(); position = 1; continue; }
        const column = position - 1, left = column >= channels ? current[column - channels] : 0, up = previous[column], upperLeft = column >= channels ? previous[column - channels] : 0;
        const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
        const pixel = (value + predictor) & 255;
        current[column] = pixel;
        if (requireOpaque && channels === 4 && column % 4 === 3 && pixel !== 255) throw invalid('IMAGE_PNG_UNSUPPORTED');
        if (++position === stride + 1) { rows++; position = 0; [current, previous] = [previous, current]; }
      }
    }
    if (outputBytes !== expected || position !== 0 || rows !== height || inflater.bytesWritten !== idat.reduce((sum, item) => sum + item.length, 0)) throw invalid();
  } catch (error) {
    if (signal?.aborted) throw invalid('IMAGE_CANCELLED');
    if (['IMAGE_PNG_INVALID', 'IMAGE_PNG_UNSUPPORTED', 'IMAGE_PNG_TOO_LARGE'].includes(error?.code)) throw error;
    throw invalid();
  } finally { signal?.removeEventListener('abort', abort); source.destroy(); inflater.destroy(); }
}
export async function validatePng(bytes, {width = 1024, height = 1024, signal, opaque = true} = {}) {
  checkAbort(signal);
  if (!validDimensions(width, height) || !Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > IMAGE_PNG_LIMITS.maxBytes || !bytes.subarray(0, 8).equals(signature)) throw invalid();
  const idat = [], seen = new Set();
  let offset = 8, count = 0, colorType, dataStarted = false, dataEnded = false, ended = false, metadataBytes = 0;
  while (offset < bytes.length) {
    checkAbort(signal);
    if (++count > IMAGE_PNG_LIMITS.maxChunks || bytes.length - offset < 12) throw invalid();
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12) throw invalid();
    const nameBytes = bytes.subarray(offset + 4, offset + 8), type = nameBytes.toString('ascii');
    if (nameBytes.some(byte => !((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) || nameBytes[2] >= 97) throw invalid();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw invalid();
    if (count === 1 && type !== 'IHDR') throw invalid();
    if (type === 'IHDR') {
      if (count !== 1 || length !== 13 || data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) throw invalid();
      colorType = data[9];
      if (data[8] !== 8 || ![2, 6].includes(colorType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw invalid('IMAGE_PNG_UNSUPPORTED');
    } else if (type === 'PLTE') {
      if (seen.has(type) || dataStarted || seen.has('bKGD') || !length || length % 3 || length > 768) throw invalid();
    } else if (type === 'IDAT') {
      if (dataEnded) throw invalid();
      dataStarted = true; idat.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || !dataStarted || offset + 12 !== bytes.length) throw invalid();
      ended = true;
    } else {
      if (nameBytes[0] < 97 || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw invalid('IMAGE_PNG_UNSUPPORTED');
      metadataBytes += length;
      if (metadataBytes > IMAGE_PNG_LIMITS.maxMetadataBytes) throw invalid('IMAGE_PNG_TOO_LARGE');
      validateAncillary(type, data, {colorType, beforeData: !dataStarted, beforePalette: !seen.has('PLTE'), seen});
    }
    if (dataStarted && type !== 'IDAT') dataEnded = true;
    seen.add(type); offset += length + 12;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length) throw invalid();
  await validateScanlines(idat, width, height, colorType === 6 ? 4 : 3, {signal, requireOpaque: opaque});
  checkAbort(signal);
  return {mimeType: 'image/png', width, height, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}

const deflateAsync = promisify(deflate);
const letters = {M: ['10001','11011','10101','10101','10001','10001','10001'], O: ['01110','10001','10001','10001','10001','10001','01110'], C: ['01111','10000','10000','10000','10000','10000','01111'], K: ['10001','10010','10100','11000','10100','10010','10001']};
/** An unmistakable, static synthetic test card. No prompt or provider data is
 * used to draw it; this is never described as a model depiction of the prompt. */
export async function renderMockImagePng({signal} = {}) {
  checkAbort(signal);
  const width = 1024, height = 1024, stride = width * 3 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    if (y % 32 === 0) { await yieldTurn(); checkAbort(signal); }
    for (let x = 0; x < width; x++) {
      let color = [20, 29, 48];
      if (x % 64 < 2 || y % 64 < 2) color = [32, 44, 66];
      if (x >= 112 && x < 912 && y >= 112 && y < 912) color = [35, 54, 81];
      if (x >= 144 && x < 880 && y >= 144 && y < 552) color = [93, 165, 205];
      if ((x - 704) ** 2 + (y - 258) ** 2 < 64 ** 2) color = [253, 205, 103];
      if (x >= 144 && x < 880 && y < 552 && y > 350 + Math.abs(x - 365) * 0.36) color = [37, 88, 113];
      if (x >= 144 && x < 880 && y < 552 && y > 417 + Math.abs(x - 666) * 0.31) color = [23, 64, 86];
      const tx = Math.floor((x - 236) / 24), ty = Math.floor((y - 656) / 24);
      if (tx >= 0 && tx < 23 && ty >= 0 && ty < 7) {
        const letter = 'MOCK'[Math.floor(tx / 6)], column = tx % 6;
        if (column < 5 && letters[letter]?.[ty][column] === '1') color = [242, 202, 118];
      }
      const at = y * stride + 1 + x * 3; raw[at] = color[0]; raw[at + 1] = color[1]; raw[at + 2] = color[2];
    }
  }
  const compressed = await deflateAsync(raw, {level: 6}); checkAbort(signal);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}
