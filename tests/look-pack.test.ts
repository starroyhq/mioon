import type {RootFailure} from './helpers/strict-root-error-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {parseCube3D, sampleCube3D, CUBE_3D_LIMITS} from '../packages/business/src/cube-lut.ts';
import {parseLookPackBytes, inspectLookPackBytes, inspectLookPack, isLookPackBytes,
  LOOK_PACK_START, LOOK_PACK_END, LOOK_PACK_LIMITS} from '../packages/business/src/look-pack.ts';
import {lookPackManifestSchema, lookPackInspectionSchema} from '../packages/contracts/src/look-pack.ts';
import {LUT_RESOURCE_LIMITS, LUT_RESOURCE_PROFILE} from '../packages/contracts/src/lut-resources.ts';
import type { BinaryLike } from 'crypto';

const identityRows = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'];
const body = `TITLE "Synthetic identity"\nLUT_3D_SIZE 2\n${identityRows.join('\n')}\n`;
const bytes = (source?: string|undefined) => new TextEncoder().encode(source);
const hash = (source: BinaryLike) => createHash('sha256').update(source).digest('hex');
function manifestFor(source: string|undefined = body) {
  return {schemaVersion: 1, kind: 'look-pack', id: 'mioon.synthetic-identity', version: '1.0.0',
    title: 'Synthetic identity', publisher: {id: 'mioon.synthetic-fixtures', name: 'Synthetic fixtures'},
    provenance: {url: 'https://example.invalid/mioon/identity'},
    license: {identifier: 'LicenseRef-Synthetic-Test', text: 'Original synthetic numeric test data.\nUse, copy and modify without warranty.'},
    asset: {id: 'identity', purpose: 'rec709-sdr-creative', profile: LUT_RESOURCE_PROFILE,
      input: 'rec709-sdr', output: 'rec709-sdr', sha256: hash(source), sizeBytes: bytes(source).length}};
}
function packJson(json: string, source: string|undefined = body, newline: string|undefined = '\n', chunkSize: number|undefined = 248) {
  const chunks = [];
  for (let offset = 0; offset < json.length; offset += chunkSize) chunks.push('# ' + json.slice(offset, offset + chunkSize));
  return `${LOOK_PACK_START}${newline}${chunks.join(newline)}${newline}${LOOK_PACK_END}${newline}${source}`;
}
const pack = (manifest: { schemaVersion: number; kind: string; id: string; version: string; title: string; publisher: { id: string; name: string; }; provenance: { url: string; }; license: { identifier: string; text: string; }; asset: { id: string; purpose: string; profile: string; input: string; output: string; sha256: string; sizeBytes: number; }; }|undefined = manifestFor(), source: string|undefined = body, newline: string|undefined = '\n') => packJson(JSON.stringify(manifest), source, newline);
async function rejects(source: string|Uint8Array<ArrayBufferLike>, code: string) {
  await assert.rejects(parseLookPackBytes(typeof source === 'string' ? bytes(source) : source), error => {
    assert.equal((error as RootFailure).code, code);
    assert.equal((error as RootFailure).message, 'The Look pack does not satisfy the bounded single-Look data profile.');
    assert.equal(Object.hasOwn(error as object, 'source'), false);
    return true;
  });
}

test('single Look verification is metadata-only and leaves exact Cube bytes unchanged', async () => {
  const input = bytes(pack()), original = input.slice();
  const result = await parseLookPackBytes(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.manifest, manifestFor());
  assert.equal(result.sizeBytes, input.length);
  assert.deepEqual(Object.keys(result), ['manifest', 'cubeMetadata', 'sizeBytes', 'bodyIntegrity',
    'provenanceVerification', 'colourCompatibility', 'licenseAcknowledgementRequired']);
  assert.equal(result.bodyIntegrity, 'verified');
  assert.equal(result.provenanceVerification, 'unverified');
  assert.equal(result.colourCompatibility, 'unverified');
  assert.equal(result.licenseAcknowledgementRequired, true);
  assert.deepEqual(result.cubeMetadata, parseCube3D(new TextDecoder().decode(input)).metadata);
  assert.equal(lookPackInspectionSchema.safeParse(result).success, true);
  assert.equal(inspectLookPackBytes, parseLookPackBytes);
  for (const value of [result, result.manifest, result.manifest.publisher, result.manifest.license,
    result.manifest.provenance, result.manifest.asset, result.cubeMetadata]) assert.equal(Object.isFrozen(value), true);
});

test('plain Cube remains opt-in, while the reserved marker cannot silently downgrade', async () => {
  assert.equal(isLookPackBytes(bytes(body)), false);
  assert.equal(await inspectLookPack(bytes(body)), null);
  // null is detection only, not ordinary Cube validation.
  assert.equal(await inspectLookPack(bytes('not a Cube')), null);
  await rejects(body, 'LOOK_PACK_MARKER_INVALID');
  assert.equal(isLookPackBytes(bytes(pack())), true);
  assert.deepEqual(await inspectLookPack(bytes(pack())), await parseLookPackBytes(bytes(pack())));
  for (const malformed of [pack().replace('_V1', '_V2'), `# before\n${pack()}`,
    pack().replace(LOOK_PACK_START, `${LOOK_PACK_START} `), `${body}# MIOON_LOOK_PACK_V1\n`]) {
    assert.equal(isLookPackBytes(bytes(malformed)), true);
    await assert.rejects(inspectLookPack(bytes(malformed)), {code: 'LOOK_PACK_MARKER_INVALID'});
  }
});

test('malformed, repeated, missing and trailing markers have no ambiguous interpretation', async () => {
  for (const invalid of [
    pack().replace(LOOK_PACK_END + '\n', ''), pack().replace(LOOK_PACK_END, LOOK_PACK_END + ' '),
    pack().replace(LOOK_PACK_END, LOOK_PACK_START), pack().replace(LOOK_PACK_START, LOOK_PACK_END),
    pack() + `${LOOK_PACK_END}\n`, pack() + `${LOOK_PACK_START}\n`, pack() + pack(),
    pack().replace(LOOK_PACK_END, `# another MIOON_LOOK_PACK value\n${LOOK_PACK_END}`),
    `${LOOK_PACK_START}\n${LOOK_PACK_END}\n${body}`, `${LOOK_PACK_START}\n# {}\n${LOOK_PACK_END}`,
    pack().replace('# {', '{'),
  ]) await rejects(invalid, 'LOOK_PACK_MARKER_INVALID');
});

test('unknown executable, remote-asset and path fields fail closed at every schema boundary', async () => {
  for (const [target, key, value] of [
    ['', 'script', 'alert(1)'], ['', 'install', 'sh ./install.sh'], ['', 'operators', ['lut3d']],
    ['', 'assets', []], ['', 'url', 'https://example.invalid/fetch.cube'], ['', 'path', '../../private'],
    ['publisher', 'script', 'x'], ['provenance', 'fetch', 'https://example.invalid'],
    ['license', 'onAccept', 'run'], ['asset', 'path', '../../escape.cube'],
    ['asset', 'path', '/private/lut.cube'], ['asset', 'url', 'https://example.invalid/lut.cube'],
    ['asset', 'shader', 'void main() {}'], ['asset', 'ffmpeg', 'movie=/etc/passwd'],
    ['asset', 'operator', 'custom'],
  ] as const) {
    const manifest = manifestFor();
    ((target ? (manifest as unknown as Record<string, unknown>)[target] : manifest) as Record<string, unknown>)[key] = value;
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
  for (const id of ['../other', '..', '/absolute', 'C:\\absolute', 'a/b', 'a%2fb', 'a\\b']) {
    const manifest = manifestFor(); manifest.asset.id = id;
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
});

test('only the current single creative Rec.709 SDR contract is admitted', async () => {
  for (const [key, value] of [['purpose', 'technical-transform'], ['profile', 'arbitrary-profile'],
    ['input', 'apple-log'], ['output', 'rec2020-pq'], ['input', 'sRGB'], ['output', null]] as const) {
    const manifest = manifestFor(); (manifest.asset as unknown as Record<string, unknown>)[key] = value;
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
  for (const [key, value] of [['schemaVersion', 2], ['kind', 'connector'], ['version', 'latest'], ['title', '']] as const) {
    const manifest = manifestFor(); (manifest as unknown as Record<string, unknown>)[key] = value;
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/plain,a', 'http://example.invalid/a',
    'https://user:password@example.invalid/', 'https://example.invalid\\evil/', 'https://example.invalid/ space']) {
    const manifest = manifestFor(); manifest.provenance.url = url;
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
});

test('duplicate JSON keys are rejected before overwritten values can be trusted', async () => {
  const valid = JSON.stringify(manifestFor());
  for (const json of [valid.replace('{', '{"id":"shadow",'),
    valid.replace('{', '{"\\u0069d":"shadow",'),
    valid.replace('"publisher":{', '"publisher":{"id":"shadow",'),
    valid.replace('"asset":{', '"asset":{"sha256":"' + '0'.repeat(64) + '",')])
    await rejects(packJson(json), 'LOOK_PACK_DUPLICATE_KEY');
  for (const key of ['__proto__', 'constructor', 'prototype', '\\u005f_proto__'])
    await rejects(packJson(`{"${key}":{},${valid.slice(1)}`), 'LOOK_PACK_MANIFEST_INVALID');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('malformed JSON and non-object values fail deterministically', async () => {
  for (const json of ['{} {}', '[]', 'null', 'true', '{"id":[]}', '{"id":true}', '{"id":null}',
    '{"id":1e999}', '{"id":01}', '{"id":NaN}', '{"id":Infinity}', '{"id":undefined}',
    '{"id":"bad\\x20"}', '{"id":"bad\\uZZZZ"}', '{"id":"unterminated}', '{"id":"x",}',
    '{"id" "x"}', '{"id":}', '{', '{} trailing'])
    await rejects(packJson(json), 'LOOK_PACK_MANIFEST_INVALID');
  for (const escaped of ['\\u0000', '\\u007f', '\\ud800', '\\u4e2d']) {
    const json = JSON.stringify(manifestFor()).replace('Synthetic identity', escaped);
    await rejects(packJson(json), 'LOOK_PACK_MANIFEST_INVALID');
  }
});

test('depth, key, string, manifest, line and whole-file limits precede unbounded parsing', async () => {
  assert.equal(LOOK_PACK_LIMITS.sourceBytes, LUT_RESOURCE_LIMITS.sourceBytes);
  assert.equal(CUBE_3D_LIMITS.lineBytes, 250);
  await rejects(packJson('{"a":{"b":{"c":{}}}}'), 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(packJson(JSON.stringify(Object.fromEntries(Array.from({length: 65}, (_, i) => [`a${i}`, 1])))), 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(packJson('{"a":"' + 'x'.repeat(4097) + '"}'), 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(packJson(' '.repeat(LOOK_PACK_LIMITS.manifestBytes) + '{}'), 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(`${LOOK_PACK_START}\n${'# \n'.repeat(129)}${LOOK_PACK_END}\n${body}`, 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(packJson(JSON.stringify(manifestFor()), body, '\n', 249), 'LOOK_PACK_RESOURCE_LIMIT');
  await rejects(new Uint8Array(LOOK_PACK_LIMITS.sourceBytes + 1), 'LOOK_PACK_RESOURCE_LIMIT');
  assert.throws(() => isLookPackBytes(new Uint8Array(LOOK_PACK_LIMITS.sourceBytes + 1)), {code: 'LOOK_PACK_RESOURCE_LIMIT'});
  // Existing Cube's global non-data limit still applies after pack comments.
  const crowdedBody = '#\n'.repeat(4095) + body;
  await rejects(pack(manifestFor(crowdedBody), crowdedBody), 'LOOK_PACK_CUBE_INVALID');
});

test('metadata text limits are independent of JSON and total file bounds', async () => {
  for (const [target, key, count] of [['', 'title', 121], ['publisher', 'name', 121], ['license', 'text', 2049]] as const) {
    const manifest = manifestFor(); ((target ? (manifest as unknown as Record<string, unknown>)[target] : manifest) as Record<string, unknown>)[key] = 'x'.repeat(count);
    await rejects(pack(manifest), 'LOOK_PACK_MANIFEST_INVALID');
  }
  const allowed = manifestFor(); allowed.license.text = 'x'.repeat(2048); allowed.title = 't'.repeat(120);
  assert.equal((await parseLookPackBytes(bytes(pack(allowed)))).manifest.license.text.length, 2048);
});

test('a valid complete file at exactly the existing 7 MiB cap remains admissible', async () => {
  const rowCount = 65 ** 3, prefix = 'LUT_3D_SIZE 65\n';
  const manifest = manifestFor();
  manifest.asset.sizeBytes = LOOK_PACK_LIMITS.sourceBytes;
  const envelopeBytes = bytes(pack(manifest, '')).length;
  const bodyBytes = LOOK_PACK_LIMITS.sourceBytes - envelopeBytes;
  const padding = bodyBytes - prefix.length - rowCount * '0 0 0\n'.length;
  const each = Math.floor(padding / rowCount), extra = padding % rowCount;
  const largeBody = prefix + Array.from({length: rowCount}, (_, index) =>
    '0 0 0' + ' '.repeat(each + (index < extra ? 1 : 0)) + '\n').join('');
  manifest.asset.sizeBytes = bytes(largeBody).length;
  manifest.asset.sha256 = hash(largeBody);
  const input = bytes(pack(manifest, largeBody));
  assert.equal(input.length, LOOK_PACK_LIMITS.sourceBytes);
  assert.equal((await parseLookPackBytes(input)).cubeMetadata.rowCount, rowCount);
});

test('manifest bounds, deep nesting and duplicate keys fail before JSON.parse', async () => {
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args) => {calls++; return original(...args);};
  try {
    await rejects(packJson(' '.repeat(LOOK_PACK_LIMITS.manifestBytes) + '{}'), 'LOOK_PACK_RESOURCE_LIMIT');
    await rejects(packJson('{"a":{"b":{"c":{}}}}'), 'LOOK_PACK_RESOURCE_LIMIT');
    await rejects(packJson('{"id":"a","\\u0069d":"b"}'), 'LOOK_PACK_DUPLICATE_KEY');
    assert.equal(calls, 0);
  } finally {JSON.parse = original;}
});

test('hash and byte size bind the exact body including spacing and LF versus CRLF', async () => {
  const wrongSize = manifestFor(); wrongSize.asset.sizeBytes++;
  await rejects(pack(wrongSize), 'LOOK_PACK_BODY_MISMATCH');
  const wrongHash = manifestFor(); wrongHash.asset.sha256 = '0'.repeat(64);
  await rejects(pack(wrongHash), 'LOOK_PACK_BODY_MISMATCH');
  await rejects(pack().replace('0 0 0\n', '.0 0 0\n'), 'LOOK_PACK_BODY_MISMATCH');
  await rejects(pack().replace('0 0 0\n', '0 0 1\n'), 'LOOK_PACK_BODY_MISMATCH');
  await rejects(pack() + '# harmless but not hashed\n', 'LOOK_PACK_BODY_MISMATCH');
  const crlf = body.replaceAll('\n', '\r\n');
  await rejects(pack(manifestFor(), crlf), 'LOOK_PACK_BODY_MISMATCH');
  const actual = bytes(pack(manifestFor(crlf), crlf, '\r\n'));
  assert.equal((await parseLookPackBytes(actual)).manifest.asset.sha256, hash(crlf));
  assert.equal((await parseLookPackBytes(bytes(pack(manifestFor(), body, '\r\n')))).manifest.asset.sha256, hash(body));
});

test('valid body hashes cannot bypass complete existing Cube admission', async () => {
  for (const source of [body + 'INCLUDE remote.cube\n', body.replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 66'),
    body.replace('0 0 0', '2 0 0'), body.replace('0 0 0\n', ''), body + '0 0 0\n',
    body + 'LUT_3D_SIZE 2\n', body + '# ' + 'x'.repeat(249) + '\n', body + '# non-ASCII \u00e9\n'])
    await rejects(pack(manifestFor(source), source), 'LOOK_PACK_CUBE_INVALID');
});

test('ASCII, strict UTF-8 and exact delimiters reject BOMs and control characters', async () => {
  const shortLines = packJson(JSON.stringify(manifestFor()), body, '\n', 200);
  for (const source of ['\ufeff' + pack(), shortLines.replace('# {', '# \u00e9{'),
    shortLines.replace('# {', '# \0{'), shortLines.replace('# {', '# \t{'), shortLines.replace('# {', '# \r{')])
    await rejects(source, 'LOOK_PACK_ENCODING_INVALID');
  const invalid = bytes(pack()); invalid[0] = 0xff;
  assert.equal(isLookPackBytes(invalid), true);
  await rejects(invalid, 'LOOK_PACK_ENCODING_INVALID');
});

test('public byte APIs reject arbitrary objects, unsafe views, accessors and proxies without invoking them', async () => {
  let calls = 0;
  const hostile = new Proxy({}, {get() {calls++; throw Error('getter');}, getPrototypeOf() {calls++; throw Error('prototype');}});
  const typedProxy = new Proxy(bytes(pack()), {get() {calls++; throw Error('getter');}});
  for (const input of [null, undefined, {}, hostile, typedProxy, 'file.cube', '/private/file.cube',
    {path: '../../file.cube'}, new URL('https://example.invalid/look.cube'), new DataView(new ArrayBuffer(4)),
    new Uint16Array(10), new ArrayBuffer(10), new Uint8Array(new SharedArrayBuffer(10))]) {
    await assert.rejects(parseLookPackBytes(input as Uint8Array), {code: 'LOOK_PACK_INPUT_INVALID'});
    assert.throws(() => isLookPackBytes(input as Uint8Array), {code: 'LOOK_PACK_INPUT_INVALID'});
  }
  assert.equal(calls, 0);
  const safeView = bytes(pack());
  for (const name of ['byteLength', 'buffer', 'length', 'subarray', 'slice', Symbol.iterator, Symbol.toStringTag])
    Object.defineProperty(safeView, name, {get() {calls++; throw Error('getter');}});
  assert.equal(isLookPackBytes(safeView), true);
  assert.equal((await parseLookPackBytes(safeView)).manifest.id, 'mioon.synthetic-identity');
  assert.equal(calls, 0);
});

test('an asynchronous hash verifies a private byte snapshot, not subsequently mutated caller input', async () => {
  const input = bytes(pack());
  const pending = parseLookPackBytes(input);
  input.fill(0);
  assert.equal((await pending).manifest.id, 'mioon.synthetic-identity');
});

test('synthetic fixtures are valid standalone Cubes with independent nonlinear/identity math', async () => {
  for (const kind of ['identity', 'nonlinear']) {
    const input = await readFile(new URL(`../examples/look-packs/synthetic-${kind}.mioon-look.cube`, import.meta.url));
    const parsed = await parseLookPackBytes(input);
    assert.equal(parsed.manifest.id, `mioon.synthetic-${kind}`);
    assert.equal(parsed.manifest.license.identifier, 'LicenseRef-Mioon-Synthetic-Test');
    assert.equal(parsed.manifest.provenance.url.startsWith('https://example.invalid/'), true);
    const cube = parseCube3D(input.toString('utf8'));
    assert.deepEqual(sampleCube3D(cube, [0.5, 0.5, 0.5]), kind === 'identity' ? [0.5, 0.5, 0.5] : [0.25, 0.4625, 0.475]);
    for (const line of input.toString('utf8').split('\n')) assert.ok(line.length <= 250);
  }
});

test('shared response schemas reject additions and declarations cannot masquerade as verified provenance', async () => {
  const result = await parseLookPackBytes(bytes(pack()));
  assert.equal(lookPackManifestSchema.safeParse({...result.manifest, execute: 'code'}).success, false);
  assert.equal(lookPackInspectionSchema.safeParse({...result, provenanceVerification: 'verified'}).success, false);
  assert.equal(lookPackInspectionSchema.safeParse({...result, colourCompatibility: 'verified'}).success, false);
  assert.equal(lookPackInspectionSchema.safeParse({...result, licenseAcknowledgementRequired: false}).success, false);
  assert.equal(lookPackInspectionSchema.safeParse({...result, bytes: 'payload'}).success, false);
});

test('parser has no file, network, execution, dynamic dependency or storage capability', async () => {
  const source = await readFile(new URL('../packages/business/src/look-pack.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|require|process|Buffer|Deno|eval)\b/u);
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(source, /from ['"](?:node:|https?:)/u);
});

test('parser bundles for a browser without Node APIs or synthetic fixtures', async () => {
  const result = await build({entryPoints: [new URL('../packages/business/src/look-pack.ts', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent'});
  assert.ok(result.outputFiles[0].contents.length > 0);
  for (const path of Object.keys(result.metafile.inputs)) {
    assert.equal(path.startsWith('node:'), false);
    assert.equal(path.includes('examples/look-packs'), false);
  }
  assert.deepEqual((Object.values(result.metafile.outputs).flatMap(output => output.imports) as unknown), []);
});
