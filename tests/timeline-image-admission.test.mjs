import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {
  STATIC_SRGB_PNG_PROFILE, STATIC_SRGB_PNG_LIMITS as LIMITS,
  PngAdmissionError, inspectStaticSrgbPng as inspect,
} from '../packages/business/src/timeline-image-admission.ts';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Independent bitwise fixture CRC, not the production native-zlib checksum.
function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, bytes = Buffer.alloc(0)) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(kind, 4, 4, 'ascii');
  bytes.copy(result, 8);
  result.writeUInt32BE(checksum(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
function integers(...values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
}
const srgb = intent => chunk('sRGB', Buffer.from([intent ?? 0]));
const gamma = value => chunk('gAMA', integers(value ?? 45455));
const chroma = (...values) => chunk('cHRM', integers(...(values.length ? values : [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000])));
function header({width = 2, height = 2, depth = 8, colourType = 6, compression = 0, filter = 0, interlace = 0} = {}) {
  return chunk('IHDR', Buffer.concat([integers(width, height), Buffer.from([depth, colourType, compression, filter, interlace])]));
}
function rows(width = 2, height = 2, channels = 4, filters = [0]) {
  const stride = width * channels + 1, bytes = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    bytes[row * stride] = filters[row % filters.length];
    for (let column = 1; column < stride; column++) bytes[row * stride + column] = (row * 71 + column * 43) % 256;
  }
  return bytes;
}
function png(options = {}) {
  const {width = 2, height = 2, colourType = 6, tagged = true, before = [], after = [],
    raw = rows(width, height, colourType === 2 ? 3 : 4),
    compressed = deflateSync(raw), idat = [compressed], tail = Buffer.alloc(0)} = options;
  return Buffer.concat([signature, header(options), ...(tagged ? [srgb()] : []), ...before,
    ...idat.map(data => chunk('IDAT', data)), ...after, chunk('IEND'), tail]);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function rejected(bytes, code = 'corrupt_png', options) {
  await assert.rejects(inspect(bytes, options), error => {
    assert.ok(error instanceof PngAdmissionError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'The image does not satisfy the bounded static sRGB PNG profile.');
    return true;
  });
}

test('tagged RGB8/RGBA8 admit exact immutable full-byte evidence with straight PNG alpha', async () => {
  assert.equal(STATIC_SRGB_PNG_PROFILE, 'png-rgb8-srgb-v1');
  assert.deepEqual(LIMITS, {sourceBytes: 32 * 1024 * 1024, maxEdge: 4096, maxPixels: 2_073_600,
    metadataBytes: 1024 * 1024, chunks: 4096, inflateChunkBytes: 16384});
  assert.ok(Object.isFrozen(LIMITS));
  assert.equal(chunk('IEND').toString('hex'), '0000000049454e44ae426082');
  for (const colourType of [2, 6]) {
    const bytes = png({width: 7, height: 5, colourType}), result = await inspect(bytes);
    assert.deepEqual(result, {profileId: STATIC_SRGB_PNG_PROFILE, sha256: hash(bytes), sourceByteLength: bytes.length,
      width: 7, height: 5, alphaMode: colourType === 6 ? 'straight' : 'opaque', bitDepth: 8, orientation: 1,
      colourTag: 'srgb', status: 'compatible'});
    assert.ok(Object.isFrozen(result));
    assert.throws(() => result.sha256 = 'a'.repeat(64), TypeError);
  }
  const opaqueRgba = await inspect(png({raw: Buffer.from([0, 1, 2, 3, 255, 4, 5, 6, 255, 0, 7, 8, 9, 255, 10, 11, 12, 255])}));
  assert.equal(opaqueRgba.alphaMode, 'straight', 'RGBA channel semantics are not inferred from pixel opacity');
});

test('all rendering intents and canonical optional gamma/chromaticities are admitted in either order', async () => {
  for (const intent of [0, 1, 2, 3]) for (const before of [[], [gamma()], [chroma()], [gamma(), chroma()], [chroma(), gamma()]]) {
    const result = await inspect(png({tagged: false, before: [...before, srgb(intent)]}));
    assert.equal(result.status, 'compatible');
    assert.equal(result.colourTag, 'srgb');
  }
});

test('absent sRGB always needs explicit interpretation, even with canonical gamma/chromaticities', async () => {
  for (const before of [[], [gamma()], [chroma()], [gamma(), chroma()]]) {
    const result = await inspect(png({tagged: false, before}));
    assert.equal(result.status, 'needs_interpretation');
    assert.equal(result.colourTag, 'untagged');
  }
});

test('full-file hash binds valid differing pixels, tagging and compressed encoding, not a decoded surrogate', async () => {
  const raw = rows(), other = Buffer.from(raw); other[2] ^= 0xff;
  const sources = [png({raw}), png({raw: other}), png({raw, tagged: false}), png({raw, compressed: deflateSync(raw, {level: 0})})];
  const results = await Promise.all(sources.map(bytes => inspect(bytes)));
  assert.equal(new Set(results.map(result => result.sha256)).size, 4);
  for (let index = 0; index < sources.length; index++) assert.equal(results[index].sha256, hash(sources[index]));
});

test('consecutive split and empty IDAT chunks may bisect every zlib byte', async () => {
  const compressed = deflateSync(rows());
  const idat = [Buffer.alloc(0), ...Array.from(compressed, byte => Buffer.from([byte])), Buffer.alloc(0)];
  assert.equal((await inspect(png({idat}))).status, 'compatible');
});

test('every legal filter is accepted at scanline boundaries spanning inflate chunks', async () => {
  for (const colourType of [2, 6]) {
    const width = colourType === 2 ? 1365 : 4096, height = 6;
    const result = await inspect(png({width, height, colourType, raw: rows(width, height, colourType === 2 ? 3 : 4, [0, 1, 2, 3, 4])}));
    assert.equal(result.width, width);
    assert.equal(result.height, height);
  }
});

test('supplied methods, accessors, iteration and subclasses cannot change or observe parsing', async () => {
  let calls = 0;
  class HostileBytes extends Uint8Array {
    static get [Symbol.species]() { calls++; throw Error('species executed'); }
  }
  for (const source of [Buffer.from(png()), new HostileBytes(png())]) {
    const expectedHash = hash(source), expectedLength = source.length;
    for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'subarray', 'slice', 'values', 'toString', 'constructor', 'readUInt32BE', Symbol.iterator])
      Object.defineProperty(source, key, {get() { calls++; throw Error('source getter executed'); }});
    const result = await inspect(source);
    assert.equal(result.sha256, expectedHash);
    assert.equal(result.sourceByteLength, expectedLength);
  }
  assert.equal(calls, 0);
  const crossRealm = runInNewContext('Uint8Array.from(bytes)', {bytes: [...png()]});
  assert.equal((await inspect(crossRealm)).sha256, hash(png()));
});

test('non-byte inputs, proxies, detached views and shared storage reject without source callbacks', async () => {
  let calls = 0;
  const proxy = new Proxy(png(), {get() { calls++; throw Error('proxy get'); }, getPrototypeOf() { calls++; throw Error('proxy prototype'); }});
  const revoked = Proxy.revocable(png(), {}); revoked.revoke();
  const fake = {get length() { calls++; throw Error('fake length'); }, get [Symbol.toStringTag]() { calls++; return 'Uint8Array'; }};
  for (const input of [null, undefined, 'PNG', [], {}, fake, new ArrayBuffer(8), new DataView(new ArrayBuffer(8)),
    new Uint16Array(8), new Uint8ClampedArray(8), proxy, revoked.proxy, new Uint8Array(new SharedArrayBuffer(8))])
    await rejected(input, 'invalid_png_input');
  const detached = new Uint8Array(8); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  await rejected(detached, 'invalid_png_input');
  assert.equal(calls, 0);
});

test('source snapshot stays byte-bound when caller mutates or detaches its input during streaming', async () => {
  for (const detach of [false, true]) {
    const bytes = new Uint8Array(png()), expectedHash = hash(bytes);
    const pending = inspect(bytes);
    if (detach) structuredClone(bytes.buffer, {transfer: [bytes.buffer]}); else bytes.fill(0);
    assert.equal((await pending).sha256, expectedHash);
  }
});

test('signature, truncation, length arithmetic and CRC checks reject malformed chunks', async () => {
  const valid = png();
  for (let length = 0; length < valid.length; length++) await rejected(valid.subarray(0, length));
  for (const offset of [0, 7, 29, 30, 31, 32, valid.indexOf('IDAT') + 4, valid.length - 1]) {
    const bytes = Buffer.from(valid); bytes[offset] ^= 1; await rejected(bytes);
  }
  for (const declaredLength of [0xffffffff, 0x80000000, valid.length, 0x7fffffff]) {
    const bytes = Buffer.from(valid); bytes.writeUInt32BE(declaredLength, 8); await rejected(bytes);
  }
  const invalidType = chunk('ab1D'); await rejected(Buffer.concat([signature, header(), invalidType, chunk('IEND')]));
  await rejected(png({before: [chunk('abcd')]}));
});

test('IHDR/IDAT/IEND order, cardinality and exact final EOF are required', async () => {
  const data = chunk('IDAT', deflateSync(rows()));
  for (const chunks of [[], [srgb(), header(), data, chunk('IEND')], [header(), header(), data, chunk('IEND')],
    [header(), chunk('IEND')], [header(), data], [header(), data, chunk('IEND', Buffer.from([0]))],
    [header(), data, chunk('IEND'), chunk('IEND')], [header(), data, srgb(), data, chunk('IEND')],
    [header(), data, gamma(), chunk('IEND')], [header(), chunk('IDAT'), chunk('IEND')],
    [chunk('IHDR', Buffer.alloc(12)), data, chunk('IEND')], [chunk('IHDR', Buffer.alloc(14)), data, chunk('IEND')]])
    await rejected(Buffer.concat([signature, ...chunks]));
  for (const tail of [Buffer.from([0]), Buffer.from('foreign'), signature]) await rejected(png({tail}));
});

test('only RGB/RGBA depth8, compression0, filter0 and noninterlaced layout are supported', async () => {
  for (const colourType of [0, 1, 3, 4, 5, 7, 255]) await rejected(png({colourType}), 'unsupported_png');
  for (const depth of [0, 1, 2, 4, 16, 32]) await rejected(png({depth}), 'unsupported_png');
  for (const patch of [{compression: 1}, {filter: 1}, {interlace: 1}, {interlace: 2}]) await rejected(png(patch), 'unsupported_png');
});

test('ICC, P3, HDR, gain-map, APNG, EXIF, transparency and all unknown/benign metadata reject, never strip', async () => {
  for (const kind of ['iCCP', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT', 'eXIf', 'tRNS', 'PLTE',
    'bKGD', 'sBIT', 'pHYs', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'sPLT', 'gMAP', 'gmAP', 'caBX', 'vpAg', 'ABCD'])
    await rejected(png({before: [chunk(kind, Buffer.from('untrusted metadata'))]}), 'unsupported_png');
  // Even a complete little-endian EXIF orientation=1 record is not admitted.
  await rejected(png({before: [chunk('eXIf', Buffer.from('49492a0008000000010012010300010000000100000000000000', 'hex'))]}), 'unsupported_png');
  await rejected(png({before: [chroma(31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000)]}), 'unsupported_png');
  for (const value of [0, 1, 45454, 45456, 100000, 0xffffffff])
    for (const tagged of [true, false]) await rejected(png({tagged, before: [gamma(value)]}), 'unsupported_png');
  // An unknown ancillary chunk with a bad CRC is corrupt, not silently ignored.
  const bad = chunk('vpAg'); bad[bad.length - 1] ^= 1;
  await rejected(png({before: [bad]}));
});

test('malformed, duplicate or late colour declarations reject instead of establishing compatibility', async () => {
  for (const before of [[srgb()], [gamma(), gamma()], [chroma(), chroma()], [srgb(4)], [srgb(255)],
    [chunk('sRGB')], [chunk('sRGB', Buffer.from([0, 0]))], [chunk('gAMA', Buffer.alloc(3))], [chunk('cHRM', Buffer.alloc(31))]])
    await rejected(png({before}));
  for (const after of [[srgb()], [gamma()], [chroma()]]) await rejected(png({after}));
});

test('zero dimensions, edge/pixel caps and source/metadata/chunk budgets fail before unbounded decode', async () => {
  const tinyRaw = rows();
  for (const dimensions of [{width: 0}, {height: 0}]) await rejected(png({...dimensions, raw: tinyRaw}));
  for (const dimensions of [{width: 4097}, {height: 4097}, {width: 4096, height: 4096}, {width: 0xffffffff}, {height: 0xffffffff}])
    await rejected(png({...dimensions, raw: tinyRaw}), 'png_budget_exceeded');
  await rejected(new Uint8Array(LIMITS.sourceBytes + 1), 'png_budget_exceeded');
  await rejected(png({before: [chunk('tEXt', Buffer.alloc(LIMITS.metadataBytes))]}), 'png_budget_exceeded');
  const idat = [deflateSync(tinyRaw), ...Array.from({length: LIMITS.chunks - 4}, () => Buffer.alloc(0))];
  assert.equal((await inspect(png({idat}))).status, 'compatible', 'exact chunk count limit');
  await rejected(png({idat: [...idat, Buffer.alloc(0)]}), 'png_budget_exceeded');
});

test('a real image at the exact decimal pixel limit validates using bounded streaming output', async () => {
  const width = 1920, height = 1080, raw = Buffer.alloc((width * 3 + 1) * height);
  const result = await inspect(png({width, height, colourType: 2, raw}));
  assert.equal(result.width * result.height, LIMITS.maxPixels);
});

test('zlib corruption, truncation, dictionaries, concatenated streams and trailing compressed bytes reject', async () => {
  const raw = rows(), compressed = deflateSync(raw);
  for (let length = 0; length < compressed.length; length++) await rejected(png({compressed: compressed.subarray(0, length)}));
  for (const offset of [0, 1, compressed.length - 1]) {
    const corrupt = Buffer.from(compressed); corrupt[offset] ^= 1; await rejected(png({compressed: corrupt}));
  }
  for (const tail of [Buffer.from([0]), Buffer.from('junk'), deflateSync(rows())])
    await rejected(png({compressed: Buffer.concat([compressed, tail])}));
  await rejected(png({compressed: deflateSync(raw, {dictionary: Buffer.from('dictionary')})}));
});

test('exact decoded length and legal per-row filters are verified without allocating bomb output', async () => {
  await rejected(png({raw: rows().subarray(0, -1)}));
  await rejected(png({raw: Buffer.concat([rows(), Buffer.from([0])])}), 'png_budget_exceeded');
  // Tiny declared dimensions cannot be used to make the inflater retain megabytes.
  await rejected(png({raw: Buffer.alloc(4 * 1024 * 1024)}), 'png_budget_exceeded');
  for (const row of [0, 1, 4]) {
    const raw = rows(4096, 5, 4); raw[row * (4096 * 4 + 1)] = 5;
    await rejected(png({width: 4096, height: 5, raw}));
  }
});

test('cancellation propagates the exact abort reason before input and during streaming', async () => {
  const controller = new AbortController(), reason = new Error('caller cancelled'); controller.abort(reason);
  await assert.rejects(inspect(png(), {signal: controller.signal}), error => error === reason);
  const active = new AbortController(), pending = inspect(png({width: 4096, height: 10}), {signal: active.signal});
  active.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('runtime fences cover streaming and final publication, and preserve ownership failures exactly', async () => {
  const bytes = png({width: 4096, height: 5});
  let calls = 0;
  await inspect(bytes, {beforeEffect() { calls++; }});
  assert.ok(calls > 12, 'output is validated/fenced incrementally, not buffered in one allocation');
  for (const failAt of [1, 7, calls]) {
    let step = 0; const reason = Object.assign(new Error('owner changed'), {code: 'OWNER_CHANGED'});
    await assert.rejects(inspect(bytes, {beforeEffect() { if (++step === failAt) throw reason; }}), error => error === reason);
  }
  let step = 0;
  await assert.rejects(inspect(bytes, {beforeEffect() { if (++step === 7) throw undefined; }}), error => error === undefined);
});
