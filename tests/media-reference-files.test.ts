// Media files (task card L1): the type table and its header detection,
// protected names, the fixed sampling rule and its hashes.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {lstatSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  detectMediaType, isNotDownloaded, isProtectedName, MEDIA_HEADER_BYTES, mediaMtimeMs, mediaTypeOfName, NODE_MEDIA_FILE_SYSTEM, sampleRanges,
} from '../packages/business/src/media-reference/index.ts';
import type {MediaType} from '../packages/business/src/media-reference/index.ts';
import {hashSamples, hashWhole} from '../packages/business/src/media-reference/fingerprint.ts';

const MIB = 1_048_576;
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
function temporary(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-l1-files-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
/** Bytes from strings (Latin-1) and byte lists, padded with zeros to `length`. */
function bytes(parts: readonly (string | readonly number[])[], length = 64): Buffer {
  const joined = Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)));
  return Buffer.concat([joined, Buffer.alloc(Math.max(0, length - joined.length))]);
}
const SIZE = [0x10, 0x00, 0x00, 0x00];
/** MPEG-TS sync bytes every `packet` bytes from `offset`. */
function transportStream(offset: number, packet: number): Buffer {
  const header = Buffer.alloc(MEDIA_HEADER_BYTES);
  for (let at = offset; at < header.length; at += packet) header[at] = 0x47;
  return header;
}
const type = (kind: MediaType['kind'], mimeType: string): MediaType => ({kind, mimeType});
const PNG = bytes([[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]);
const MP4 = bytes([[0, 0, 0, 0x18], 'ftypisom']);
const MEDIA: readonly (readonly [string, Buffer, MediaType])[] = [
  ['a.png', PNG, type('image', 'image/png')],
  ['a.jpg', bytes([[0xff, 0xd8, 0xff, 0xe0]]), type('image', 'image/jpeg')],
  ['a.jpeg', bytes([[0xff, 0xd8, 0xff, 0xe1]]), type('image', 'image/jpeg')],
  ['a.webp', bytes(['RIFF', SIZE, 'WEBPVP8 ']), type('image', 'image/webp')],
  ['a.mp4', MP4, type('video', 'video/mp4')],
  ['a.m4v', bytes([[0, 0, 0, 0x18], 'ftypM4V ']), type('video', 'video/mp4')],
  ['a.m4a', bytes([[0, 0, 0, 0x18], 'ftypM4A ']), type('audio', 'audio/mp4')],
  ['a.mov', bytes([[0, 0, 0, 0x14], 'ftypqt  ']), type('video', 'video/quicktime')],
  ['a.webm', bytes([[0x1a, 0x45, 0xdf, 0xa3, 0x9f]]), type('video', 'video/webm')],
  ['a.mkv', bytes([[0x1a, 0x45, 0xdf, 0xa3, 0xa3]]), type('video', 'video/x-matroska')],
  ['a.avi', bytes(['RIFF', SIZE, 'AVI LIST']), type('video', 'video/x-msvideo')],
  ['a.mts', transportStream(4, 192), type('video', 'video/mp2t')],
  ['a.m2ts', transportStream(0, 188), type('video', 'video/mp2t')],
  ['a.mxf', bytes([[0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01]]), type('video', 'application/mxf')],
  ['a.wav', bytes(['RIFF', SIZE, 'WAVEfmt ']), type('audio', 'audio/wav')],
  ['b.wav', bytes(['RF64', SIZE, 'WAVEds64']), type('audio', 'audio/wav')],
  ['c.wav', bytes(['BW64', SIZE, 'WAVEds64']), type('audio', 'audio/wav')],
  ['a.mp3', bytes(['ID3', [4, 0, 0]]), type('audio', 'audio/mpeg')],
  ['b.mp3', bytes([[0xff, 0xfb, 0x90, 0x64]]), type('audio', 'audio/mpeg')],
  ['a.aac', bytes([[0xff, 0xf1, 0x50, 0x80]]), type('audio', 'audio/aac')],
  ['b.aac', bytes([[0xff, 0xf9, 0x50, 0x80]]), type('audio', 'audio/aac')],
  ['c.aac', bytes(['ID3', [4, 0, 0]]), type('audio', 'audio/aac')],
  ['a.flac', bytes(['fLaC', [0, 0, 0, 0x22]]), type('audio', 'audio/flac')],
  ['a.aif', bytes(['FORM', SIZE, 'AIFFCOMM']), type('audio', 'audio/aiff')],
  ['a.aiff', bytes(['FORM', SIZE, 'AIFCFVER']), type('audio', 'audio/aiff')],
];

// ---------------------------------------------------------------------------
// Types

test('each extension in the table is detected from its own header, in any letter case', () => {
  for (const [name, header, expected] of MEDIA) {
    assert.deepEqual(mediaTypeOfName(name), expected, name);
    assert.deepEqual(detectMediaType(name, header), expected, name);
    assert.deepEqual(detectMediaType(name.toUpperCase(), header), expected, name.toUpperCase());
  }
  // QuickTime files from before `ftyp` start with another atom.
  for (const atom of ['moov', 'mdat', 'free', 'skip', 'wide', 'pnot']) {
    assert.deepEqual(detectMediaType('old.mov', bytes([[0, 0, 0, 8], atom])), type('video', 'video/quicktime'), atom);
  }
  // Both packet sizes of transport streams pass under either extension.
  assert.deepEqual(detectMediaType('a.mts', transportStream(0, 188)), type('video', 'video/mp2t'));
  assert.deepEqual(detectMediaType('a.m2ts', transportStream(4, 192)), type('video', 'video/mp2t'));
});

test('a header of another format, a database, an empty header and other extensions are not media', () => {
  const sqlite = bytes(['SQLite format 3\u0000', [0x10, 0x00, 0x01, 0x01]]);
  for (const [name, header] of [
    ['png.mp4', PNG], ['db.mp4', sqlite], ['db.mov', sqlite], ['db.png', sqlite], ['empty.mp4', Buffer.alloc(0)], ['short.mts', transportStream(0, 188).subarray(0, 300)],
    ['mp4.png', MP4], ['mp4.webm', MP4], ['webp.avi', bytes(['RIFF', SIZE, 'WEBPVP8 '])], ['wave.webp', bytes(['RIFF', SIZE, 'WAVEfmt '])],
    // A bad bitrate index; an MPEG audio frame is no ADTS header.
    ['bad.mp3', bytes([[0xff, 0xfb, 0xf0, 0x64]])], ['mp3.aac', bytes([[0xff, 0xfb, 0x90, 0x64]])],
    ['a.txt', PNG], ['a.heic', bytes([[0, 0, 0, 0x18], 'ftypheic'])], ['a.mioon', sqlite], ['mp4', MP4], ['.mp4', MP4], ['a.', MP4],
  ] as const) {
    assert.equal(detectMediaType(name, header), null, name);
  }
  for (const name of ['a.txt', 'a.heic', 'a.db', 'a.mioon', 'mp4', '.mp4', 'a.']) assert.equal(mediaTypeOfName(name), null, name);
  // Only the first MEDIA_HEADER_BYTES bytes count.
  const late = Buffer.concat([Buffer.alloc(MEDIA_HEADER_BYTES), PNG]);
  assert.equal(detectMediaType('late.png', late), null);
});

test('isProtectedName: dot files, project files and their journals, super-journals', () => {
  for (const name of ['.DS_Store', '._clip.mp4', '.hidden.mp4', '.mioon-store', 'Film.mioon', 'FILM.MIOON', 'Film.mioon-journal', 'FILM.MIOON-JOURNAL',
    'history.db-mj0DA3D190E']) {
    assert.equal(isProtectedName(name), true, name);
  }
  for (const name of ['clip.mp4', 'Film.mioon.mp4', 'mioon.mp4', 'history.db']) assert.equal(isProtectedName(name), false, name);
});

// ---------------------------------------------------------------------------
// The sampling rule

test('sampleRanges: one range up to 1 MiB, then five 64 KiB ranges from the start to the end', () => {
  assert.deepEqual(sampleRanges(0), [{start: 0, length: 0}]);
  assert.deepEqual(sampleRanges(1), [{start: 0, length: 1}]);
  assert.deepEqual(sampleRanges(MIB), [{start: 0, length: MIB}]);
  assert.deepEqual(sampleRanges(MIB + 1).map(range => range.start), [0, 245_760, 491_520, 737_280, 983_041]);
  assert.ok(sampleRanges(MIB + 1).every(range => range.length === 65_536));
  const tib = 2 ** 40;
  assert.deepEqual(sampleRanges(tib).map(range => range.start), [0, 274_877_890_560, 549_755_781_120, 824_633_671_680, 1_099_511_562_240]);
  const last = sampleRanges(Number.MAX_SAFE_INTEGER).at(-1)!;
  assert.equal(last.start + last.length, Number.MAX_SAFE_INTEGER);
  for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sampleRanges(size), TypeError);
});

test('mediaMtimeMs keeps microseconds of the bigint stat, which is not Node\'s numeric mtimeMs', () => {
  assert.equal(mediaMtimeMs({mtimeNs: 1_700_000_000_611_754_400n}), 1_700_000_000_611.754);
  assert.notEqual(mediaMtimeMs({mtimeNs: 1_700_000_000_611_754_400n}), 1_700_000_000_611.7544);
  assert.equal(mediaMtimeMs({mtimeNs: 1_000n}), 0.001);
  assert.equal(mediaMtimeMs({mtimeNs: 999n}), 0);
  assert.equal(mediaMtimeMs({mtimeNs: -5_000_000n}), 0);
});

test('isNotDownloaded: at least 4 KiB without a single block, as a sparse file is', t => {
  const root = temporary(t);
  const sparse = path.join(root, 'sparse.mp4'), written = path.join(root, 'written.mp4');
  writeFileSync(sparse, '');
  truncateSync(sparse, MIB);
  writeFileSync(written, randomBytes(8192));
  assert.equal(isNotDownloaded(lstatSync(sparse, {bigint: true})), true);
  assert.equal(isNotDownloaded(lstatSync(written, {bigint: true})), false);
  assert.equal(isNotDownloaded({size: 100n, blocks: 0n}), false);
  assert.equal(isNotDownloaded({size: 4095n, blocks: 0n}), false);
  assert.equal(isNotDownloaded({size: 4096n, blocks: 0n}), true);
});

test('sampled hashes: a small file is hashed whole, a large one from the five ranges; hashWhole is its SHA-256', async t => {
  const root = temporary(t);
  for (const size of [1000, MIB]) {
    const file = path.join(root, `${size}.bin`), content = randomBytes(size);
    writeFileSync(file, content);
    const handle = await NODE_MEDIA_FILE_SYSTEM.open(file);
    try {
      assert.equal(await hashSamples(handle, size), sha256(content));
      assert.equal(await hashWhole(handle, size), sha256(content));
    } finally {
      await handle.close();
    }
  }
  const size = 3 * MIB, content = randomBytes(size), file = path.join(root, 'large.bin');
  writeFileSync(file, content);
  const expected = createHash('sha256');
  for (let index = 0; index < 5; index++) {
    const start = Math.floor(index * (size - 65_536) / 4);
    expected.update(content.subarray(start, start + 65_536));
  }
  const handle = await NODE_MEDIA_FILE_SYSTEM.open(file);
  t.after(() => handle.close());
  assert.equal(await hashSamples(handle, size), expected.digest('hex'));
  let counted = 0;
  assert.equal(await hashWhole(handle, size, {onBytes: bytes => { counted += bytes; }}), sha256(content));
  assert.equal(counted, size);
  // A file shorter than its recorded size changed while it was read.
  await assert.rejects(hashSamples(handle, size + 1), {code: 'MEDIA_CHANGED_DURING_READ'});
  // Aborted between two chunks.
  const controller = new AbortController();
  await assert.rejects(hashWhole(handle, size, {signal: controller.signal, onBytes: () => controller.abort()}), {name: 'AbortError'});
});
