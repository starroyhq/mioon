import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {
  STATIC_SRGB_JFIF_PROFILE, STATIC_SRGB_JFIF_DECODER_POLICY, STATIC_SRGB_JFIF_LIMITS as LIMITS,
  JpegAdmissionError, inspectStaticSrgbJfif as inspect,
} from '../packages/business/src/timeline-jpeg-admission.ts';
import {
  pillowJfifFixture, pillowRestartJfifFixture, makeJfifFixture as jpeg, jpegSegment as segment, jfifApp0 as app0,
  jpegQuantization as dqt, jpegHuffman as dht, jpegFrame as frame, jpegScan as scan,
  jpegRestartInterval as dri, entropyBytes, jpegFixtureOffsets as offsets,
} from './helpers/timeline-jpeg-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function rejected(bytes, code = 'corrupt_jpeg', options) {
  await assert.rejects(inspect(bytes, options), error => {
    assert.ok(error instanceof JpegAdmissionError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'The image does not satisfy the bounded static sRGB JFIF profile.');
    return true;
  });
}
const changed = (bytes, offset, value) => { const result = Buffer.from(bytes); result[offset] = value; return result; };
const tailOffset = bytes => offsets(bytes).at(-1).end;
const replacing = (bytes, marker, replacement) => {
  const entry = offsets(bytes).find(value => value.marker === marker);
  return Buffer.concat([bytes.subarray(0, entry.offset), replacement, bytes.subarray(entry.end)]);
};

test('independent Pillow baseline 444/422/420 fixtures admit full-byte immutable untagged evidence', async () => {
  assert.equal(STATIC_SRGB_JFIF_PROFILE, 'jfif-ycbcr8-srgb-v1');
  assert.equal(STATIC_SRGB_JFIF_DECODER_POLICY, 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1');
  assert.deepEqual(LIMITS, {sourceBytes: 32 * 1024 * 1024, maxEdge: 4096, maxPixels: 2_073_600,
    metadataBytes: 1024 * 1024, markers: 4096, entropyYieldMcus: 64});
  assert.ok(Object.isFrozen(LIMITS));
  for (const sampling of ['444', '422', '420']) {
    const bytes = pillowJfifFixture(sampling), result = await inspect(bytes);
    assert.ok(bytes.includes(Buffer.from([255, 0])), 'independent fixture includes literal stuffed-FF entropy');
    assert.deepEqual(result, {profileId: STATIC_SRGB_JFIF_PROFILE, sha256: hash(bytes), sourceByteLength: bytes.length,
      width: 17, height: 13, alphaMode: 'opaque', bitDepth: 8, orientation: 1,
      colourTag: 'untagged', status: 'needs_interpretation', sampling, decoderPolicy: STATIC_SRGB_JFIF_DECODER_POLICY});
    assert.ok(Object.isFrozen(result));
    assert.throws(() => result.width = 0, TypeError);
  }
});

test('1.01/1.02, square density units and legal marker fill remain untagged, never inferred sRGB', async () => {
  for (const minor of [1, 2]) for (const units of [0, 1, 2]) for (const densityX of [1, 72, 300, 65535]) {
    const result = await inspect(jpeg({minor, units, densityX}));
    assert.equal(result.colourTag, 'untagged'); assert.equal(result.status, 'needs_interpretation');
  }
  const source = jpeg(), result = Buffer.concat([source.subarray(0, 2), Buffer.from([255, 255]), source.subarray(2, -2), Buffer.from([255, 255]), source.subarray(-2)]);
  assert.equal((await inspect(result)).sha256, hash(result));
});

test('independent minimal fixtures consume exact MCU grids including odd edges and maximum source dimensions', async () => {
  for (const sampling of ['444', '422', '420']) for (const [width, height] of [[1, 1], [7, 9], [17, 13], [31, 33], [4096, 1]]) {
    const result = await inspect(jpeg({width, height, sampling}));
    assert.equal(result.width, width); assert.equal(result.height, height); assert.equal(result.sampling, sampling);
  }
  const result = await inspect(jpeg({width: 1920, height: 1080}));
  assert.equal(result.width * result.height, LIMITS.maxPixels);
});

test('non-byte inputs, shared/detached storage and proxies reject without executing caller callbacks', async () => {
  let calls = 0;
  const proxy = new Proxy(jpeg(), {get() { calls++; throw Error('proxy get'); }, getPrototypeOf() { calls++; throw Error('proxy prototype'); }});
  const revoked = Proxy.revocable(jpeg(), {}); revoked.revoke();
  const fake = {get length() { calls++; throw Error('fake'); }, get [Symbol.toStringTag]() { calls++; return 'Uint8Array'; }};
  for (const input of [null, undefined, 'JPEG', [], {}, fake, new ArrayBuffer(8), new DataView(new ArrayBuffer(8)),
    new Uint16Array(8), new Uint8ClampedArray(8), proxy, revoked.proxy, new Uint8Array(new SharedArrayBuffer(8))])
    await rejected(input, 'invalid_jpeg_input');
  const detached = new Uint8Array(8); structuredClone(detached.buffer, {transfer: [detached.buffer]});
  await rejected(detached, 'invalid_jpeg_input');
  assert.equal(calls, 0);
});

test('owned snapshot ignores input accessors, methods, iteration, species and later caller mutations', async () => {
  let calls = 0;
  class Hostile extends Uint8Array { static get [Symbol.species]() { calls++; throw Error('species'); } }
  for (const source of [jpeg(), new Hostile(jpeg())]) {
    const expectedHash = hash(source), expectedLength = source.length;
    for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'subarray', 'slice', 'values', 'toString', 'constructor', 'readUInt16BE', Symbol.iterator])
      Object.defineProperty(source, key, {get() { calls++; throw Error('input getter'); }});
    const result = await inspect(source);
    assert.equal(result.sha256, expectedHash); assert.equal(result.sourceByteLength, expectedLength);
  }
  const crossRealm = runInNewContext('Uint8Array.from(bytes)', {bytes: [...jpeg()]});
  assert.equal((await inspect(crossRealm)).sha256, hash(jpeg()));
  for (const detach of [false, true]) {
    const source = new Uint8Array(pillowJfifFixture()), expected = hash(source), pending = inspect(source);
    if (detach) structuredClone(source.buffer, {transfer: [source.buffer]}); else source.fill(0);
    assert.equal((await pending).sha256, expected);
  }
  assert.equal(calls, 0);
});

test('cancellation before parse and during chunked entropy work preserves exact reasons', async () => {
  const stopped = new AbortController(), reason = new Error('caller cancelled'); stopped.abort(reason);
  await assert.rejects(inspect(jpeg(), {signal: stopped.signal}), error => error === reason);
  const active = new AbortController(), pending = inspect(jpeg({width: 1920, height: 1080}), {signal: active.signal});
  setImmediate(() => active.abort(reason));
  await assert.rejects(pending, error => error === reason);
});

test('trusted lifecycle fences cover headers, entropy and final publication without rewriting thrown values', async () => {
  const source = jpeg({width: 1024, height: 16}); let calls = 0;
  await inspect(source, {beforeEffect() { calls++; }});
  assert.ok(calls > 12);
  for (const failAt of [1, 7, 10, calls]) {
    const reason = new Error('owner changed'); let step = 0;
    await assert.rejects(inspect(source, {beforeEffect() { if (++step === failAt) throw reason; }}), error => error === reason);
  }
  let step = 0;
  await assert.rejects(inspect(source, {beforeEffect() { if (++step === 10) throw undefined; }}), error => error === undefined);
});

test('every truncation of a valid minimal file, missing/duplicate EOI, concatenation and trailing data reject', async () => {
  const valid = jpeg();
  for (let length = 0; length < valid.length; length++) await rejected(valid.subarray(0, length));
  for (const tail of [Buffer.from([0]), Buffer.from([255, 0xd9]), Buffer.from('junk'), valid]) await rejected(jpeg({tail}));
  await rejected(changed(valid, 0, 0)); await rejected(changed(valid, 1, 0xd9));
  await rejected(jpeg({before: [Buffer.from([255, 0xd8])]}));
  await rejected(jpeg({before: [Buffer.from([255, 0xd9])]}));
});

test('all external metadata, thumbnails, comments, unknown markers and non-JFIF APP0 fail closed', async () => {
  for (let marker = 0xe1; marker <= 0xef; marker++) await rejected(jpeg({before: [segment(marker, Buffer.from('EXIF ICC MPF XMP Adobe gain map'))]}), 'unsupported_jpeg');
  for (const marker of [0xfe, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xce, 0xcf, 0xdc, 0xde, 0xdf, 0x01, 0x02, 0xf0, 0xfd])
    await rejected(jpeg({before: [segment(marker)]}), 'unsupported_jpeg');
  for (const patch of [{minor: 0}, {minor: 3}, {units: 3}, {densityX: 0}, {densityX: 2, densityY: 1}, {thumbX: 1}, {thumbY: 1}])
    await rejected(jpeg(patch), 'unsupported_jpeg');
  await rejected(jpeg({app0: segment(0xe0, Buffer.from('JFXX\0'))}), 'unsupported_jpeg');
  await rejected(jpeg({app0: changed(app0(), 9, 2)}), 'unsupported_jpeg');
  await rejected(jpeg({app0: Buffer.alloc(0)}), 'unsupported_jpeg');
  await rejected(jpeg({before: [app0()]}));
  const exif = segment(0xe1, Buffer.from('45786966000049492a0008000000010012010300010000000100000000000000', 'hex'));
  await rejected(jpeg({before: [exif]}), 'unsupported_jpeg', {beforeEffect() { /* no metadata override */ }});
});

test('segment lengths, standalone marker misuse and truncated payloads reject', async () => {
  const source = jpeg();
  for (const entry of offsets(source)) for (const length of [0, 1, 65535]) {
    const result = Buffer.from(source); result.writeUInt16BE(length, entry.offset + 2); await rejected(result);
  }
  for (const marker of [0, 0xd0, 0xd7]) await rejected(jpeg({before: [Buffer.from([255, marker])]}));
  await rejected(Buffer.from([255, 0xd8, 255, 255]));
});

test('only exact baseline 8-bit, three YCbCr components, accepted sampling and selectors are admitted', async () => {
  for (const patch of [{depth: 12}, {ids: [0, 1, 2]}, {ids: [1, 1, 3]}, {ids: [2, 1, 3]}, {tables: [4, 0, 0]},
    {samples: [0x12, 0x11, 0x11]}, {samples: [0x31, 0x11, 0x11]}, {samples: [0x22, 0x21, 0x11]}, {samples: [0, 0x11, 0x11]}])
    await rejected(jpeg({frame: frame(patch)}), 'unsupported_jpeg');
  await rejected(jpeg({before: [frame()]}));
  for (const patch of [{ids: [2, 1, 3]}, {ids: [1, 1, 3]}, {selectors: [0x20, 0, 0]}, {selectors: [0x02, 0, 0]},
    {start: 1}, {end: 62}, {approximation: 1}]) await rejected(jpeg({scan: scan(patch)}), 'unsupported_jpeg');
  await rejected(jpeg({scan: segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))}));
  await rejected(jpeg({frame: frame({tables: [1, 0, 0]})}));
  await rejected(jpeg({scan: scan({selectors: [0x11, 0, 0]})}));
});

test('dimension and source/header budgets reject before image allocation or entropy processing', async () => {
  for (const patch of [{width: 0}, {height: 0}]) await rejected(jpeg({frame: frame(patch)}));
  for (const patch of [{width: 4097}, {height: 4097}, {width: 65535}, {width: 4096, height: 4096}, {width: 1921, height: 1080}])
    await rejected(jpeg({frame: frame(patch)}), 'jpeg_budget_exceeded');
  await rejected(new Uint8Array(LIMITS.sourceBytes + 1), 'jpeg_budget_exceeded');
  await rejected(Buffer.concat([Buffer.from([255, 0xd8]), Buffer.alloc(LIMITS.metadataBytes + 2, 255), jpeg().subarray(2)]), 'jpeg_budget_exceeded');
});

test('quantization tables must be nonzero 8-bit, complete, unique and actually referenced', async () => {
  await rejected(jpeg({dqt: dqt({value: 0})}));
  await rejected(jpeg({dqt: dqt({precision: 1})}), 'unsupported_jpeg');
  await rejected(jpeg({dqt: dqt({id: 4})}), 'unsupported_jpeg');
  await rejected(jpeg({dqt: segment(0xdb)}));
  await rejected(jpeg({dqt: segment(0xdb, Buffer.from([0, ...Array(63).fill(1)]))}));
  await rejected(jpeg({before: [dqt()]}));
  await rejected(jpeg({dqt: Buffer.alloc(0)}));
  const quant = Buffer.concat([dqt({id: 0}).subarray(4), dqt({id: 3}).subarray(4)]);
  assert.equal((await inspect(jpeg({dqt: segment(0xdb, quant), frame: frame({tables: [3, 0, 3]})}))).width, 8);
});

test('valid incomplete Huffman tables and maximum 16-bit codes are supported', async () => {
  assert.equal((await inspect(jpeg())).width, 8, 'one-symbol trees are intentionally incomplete');
  const counts = [...Array(15).fill(0), 1];
  const result = await inspect(jpeg({dc: dht({counts}), ac: dht({kind: 1, counts}), entropy: Buffer.alloc(12)}));
  assert.equal(result.width, 8);
  const combined = segment(0xc4, Buffer.concat([dht().subarray(4), dht({kind: 1}).subarray(4)]));
  assert.equal((await inspect(jpeg({dc: combined, ac: Buffer.alloc(0)}))).width, 8);
});

test('oversubscribed/all-ones/empty/duplicate/invalid-symbol Huffman tables and absent entropy paths reject', async () => {
  for (const patch of [
    {counts: [3, ...Array(15).fill(0)], values: [0, 1, 2]},
    {counts: [2, ...Array(15).fill(0)], values: [0, 1]},
    {counts: [1, 2, ...Array(14).fill(0)], values: [0, 1, 2]},
    {counts: Array(16).fill(0), values: []},
    {counts: [0, 2, ...Array(14).fill(0)], values: [0, 0]},
    {counts: [0, 2, ...Array(14).fill(0)], values: [0]},
    {values: [12]}, {values: [255]},
  ]) await rejected(jpeg({dc: dht(patch)}));
  for (const values of [[0x10], [0x20], [0x0b], [0xfb]]) await rejected(jpeg({ac: dht({kind: 1, values})}));
  for (const patch of [{kind: 2}, {id: 2}, {id: 15}]) await rejected(jpeg({dc: dht(patch)}), 'unsupported_jpeg');
  await rejected(jpeg({before: [dht()]}));
  await rejected(jpeg({dc: segment(0xc4)}));
  await rejected(jpeg({dc: segment(0xc4, Buffer.alloc(16))}));
  await rejected(jpeg({entropy: Buffer.from([0xff, 0, 0xff, 0])}), 'corrupt_jpeg', undefined);
});

test('AC ZRL/EOB and exact coefficient endpoints are consumed, never merely scanned for EOI', async () => {
  const counts = [1, 1, 1, ...Array(13).fill(0)], ac = dht({kind: 1, counts, values: [0xe1, 0xf0, 0]});
  // DC0 (0), run14+size1 (0 + 1), then three ZRL (10): ends exactly at coefficient64.
  const block = '0' + '01' + '101010';
  assert.equal((await inspect(jpeg({ac, entropy: entropyBytes(block.repeat(3))}))).width, 8);
  // Starting coefficient1 plus four ZRL exceeds coefficient64.
  await rejected(jpeg({ac, entropy: entropyBytes('0' + '10101010')}));
  // Four run14 nonzeros consume coefficients15,30,45,60; another exceeds63.
  await rejected(jpeg({ac, entropy: entropyBytes('0' + '01'.repeat(5))}));
  const amplitude = dht({values: [11]});
  await rejected(jpeg({dc: amplitude, entropy: Buffer.from([0])}));
});

test('entropy truncation, extra full bytes and non-one padding reject even with a syntactically present EOI', async () => {
  const source = pillowJfifFixture(), start = tailOffset(source), entropy = source.subarray(start, -2);
  for (let size = 0; size < entropy.length; size++) await rejected(Buffer.concat([source.subarray(0, start), entropy.subarray(0, size), source.subarray(-2)]));
  const minimal = jpeg();
  assert.equal(minimal.at(-3), 3, 'six zero code bits and two one padding bits');
  for (const byte of [0, 1, 2]) await rejected(changed(minimal, minimal.length - 3, byte));
  for (const extra of [Buffer.from([0]), Buffer.from([255, 0]), Buffer.from('extra')])
    await rejected(Buffer.concat([minimal.subarray(0, -2), extra, minimal.subarray(-2)]));
  const alteredGrid = replacing(source, 0xc0, frame({width: 1, height: 1, sampling: '420', tables: [0, 1, 1]}));
  await rejected(alteredGrid);
});

test('literal FF requires exactly one stuffed zero, and markers cannot appear inside Huffman coefficients', async () => {
  const source = pillowJfifFixture('444'), start = tailOffset(source), stuffed = source.indexOf(Buffer.from([255, 0]), start);
  assert.ok(stuffed > start);
  await rejected(Buffer.concat([source.subarray(0, stuffed + 1), source.subarray(stuffed + 2)]));
  await rejected(Buffer.concat([source.subarray(0, stuffed), Buffer.from([255]), source.subarray(stuffed)]));
  for (const marker of [0xd0, 0xd9, 0xda, 0xe1]) await rejected(changed(source, stuffed + 1, marker));
});

test('restart intervals consume exact MCU boundaries, reset sequence wraps and reject missing/extra/reordered markers', async () => {
  for (const sampling of ['444', '422', '420']) for (const restartInterval of [1, 2, 3, 7, 65535]) {
    const source = jpeg({width: 257, height: 17, sampling, restartInterval});
    assert.equal((await inspect(source)).sampling, sampling);
  }
  const source = jpeg({width: 256, height: 16, restartInterval: 1}), start = tailOffset(source);
  const restart = source.indexOf(Buffer.from([255, 0xd0]), start);
  await rejected(changed(source, restart + 1, 0xd1));
  await rejected(Buffer.concat([source.subarray(0, restart), source.subarray(restart + 2)]));
  await rejected(Buffer.concat([source.subarray(0, -2), Buffer.from([255, 0xd0]), source.subarray(-2)]));
  await rejected(changed(source, restart - 1, 0));
  const interval = offsets(source).find(value => value.marker === 0xdd);
  await rejected(changed(source, interval.payload + 1, 2));
  await rejected(replacing(source, 0xdd, Buffer.alloc(0)));
  await rejected(replacing(source, 0xdd, dri(0)));
  await rejected(jpeg({before: [dri(1)], restartInterval: 1}));
  await rejected(jpeg({before: [segment(0xdd, Buffer.alloc(1))]}));
  assert.equal((await inspect(jpeg({before: [dri(0)]}))).width, 8);
});


test('independent optimized Pillow JPEG verifies real restart framing with modulo-eight wrap', async () => {
  const source = pillowRestartJfifFixture(), result = await inspect(source);
  assert.equal(result.width, 65); assert.equal(result.height, 33); assert.equal(result.sampling, '420');
  const first = source.indexOf(Buffer.from([255, 0xd0]), tailOffset(source));
  const repeated = source.indexOf(Buffer.from([255, 0xd0]), first + 2);
  assert.ok(repeated > first);
  await rejected(changed(source, repeated + 1, 0xd1));
});


const dcAllCategories = dht({counts: [0, 0, 0, 12, ...Array(12).fill(0)], values: Array.from({length: 12}, (_, index) => index)});
function encodeDcDifferences(differences) {
  return differences.map(difference => {
    const size = difference === 0 ? 0 : Math.floor(Math.log2(Math.abs(difference))) + 1;
    const magnitude = difference < 0 ? difference + 2 ** size - 1 : difference;
    return size.toString(2).padStart(4, '0') + (size ? magnitude.toString(2).padStart(size, '0') : '') + '0';
  }).join('');
}
test('DC predictors stay signed 11-bit per component while valid ±2047 differences remain accepted', async () => {
  // Three MCUs: Y/Cb/Cr independently move between both legal DC endpoints.
  const valid = [1023, -1024, 0, -2047, 2047, 1, 2047, -2047, -2];
  assert.equal((await inspect(jpeg({width: 24, dc: dcAllCategories, entropy: entropyBytes(encodeDcDifferences(valid))}))).width, 24);
  assert.equal((await inspect(jpeg({dc: dcAllCategories, entropy: entropyBytes(encodeDcDifferences([1023, 1023, 1023]))}))).width, 8);
  for (const differences of [[1023, 0, 0, 1, 0, 0], [-1024, 0, 0, -1, 0, 0], [2047, 0, 0, 0, 0, 0], [-2047, 0, 0, 0, 0, 0]])
    await rejected(jpeg({width: 16, dc: dcAllCategories, entropy: entropyBytes(encodeDcDifferences(differences))}));
  // In 420, all four Y blocks share the same predictor, not one per block.
  await rejected(jpeg({sampling: '420', dc: dcAllCategories, entropy: entropyBytes(encodeDcDifferences([500, 500, 24, 0, 0, 0]))}));
});

test('all component DC predictors reset at each verified restart interval', async () => {
  for (const value of [1023, -1024]) {
    const oneMcu = entropyBytes(encodeDcDifferences([value, value, value]));
    const entropy = Buffer.concat([oneMcu, Buffer.from([255, 0xd0]), oneMcu]);
    assert.equal((await inspect(jpeg({width: 16, restartInterval: 1, dc: dcAllCategories, entropy}))).width, 16);
  }
});

test('marker fill shares one cumulative metadata budget across headers and restart/end boundaries', async () => {
  const source = jpeg({width: 16, restartInterval: 1}), restart = source.indexOf(Buffer.from([255, 0xd0]), tailOffset(source));
  const metadataWithoutFill = tailOffset(source) - 2 + 4; // Header bytes after SOI, RST0, EOI.
  const exact = Buffer.concat([source.subarray(0, -2), Buffer.alloc(LIMITS.metadataBytes - metadataWithoutFill, 255), source.subarray(-2)]);
  assert.equal((await inspect(exact)).width, 16);
  await rejected(Buffer.concat([exact.subarray(0, -2), Buffer.from([255]), exact.subarray(-2)]), 'jpeg_budget_exceeded');
  const distributed = Buffer.concat([source.subarray(0, restart), Buffer.alloc(600_000, 255),
    source.subarray(restart, -2), Buffer.alloc(600_000, 255), source.subarray(-2)]);
  await rejected(distributed, 'jpeg_budget_exceeded');
});
