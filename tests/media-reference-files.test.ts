// Media files (task card L1): the type table and its header detection,
// protected names, the fixed sampling rule and its hashes; then reading them
// safely (plan 8.4): references, statuses, admission and full hashes, and that
// none of it opens a file that would drop the SQLite locks of an open project.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync,
  symlinkSync, truncateSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {identityOfStats} from '../packages/business/src/app-db/identity.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {
  admitMedia, checkMediaStatus, computeFullSha256, detectMediaType, insideAnyDirectory, isNotDownloaded, isProtectedName, MEDIA_HEADER_BYTES,
  mediaMtimeMs, mediaTypeOfName, NODE_MEDIA_FILE_SYSTEM, referenceForFile, sampleRanges,
} from '../packages/business/src/media-reference/index.ts';
import type {MediaAccess, MediaFileSystem, MediaStatusResult, MediaType} from '../packages/business/src/media-reference/index.ts';
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

// ---------------------------------------------------------------------------
// Reading safely

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const LOCKED = {ok: false, message: 'database is locked', errcode: 5};
const VIDEO_MP4 = type('video', 'video/mp4');
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Another process reading the file read-only with a busy timeout of 0. */
function readInChild(file: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: {...process.env, MODE: 'raw-read', FILE: file}, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}
/** The port with every open recorded. */
function recording(base: MediaFileSystem = NODE_MEDIA_FILE_SYSTEM): {readonly fileSystem: MediaFileSystem; readonly opened: string[]} {
  const opened: string[] = [];
  return {opened, fileSystem: {...base, open: async file => {
    opened.push(file);
    return base.open(file);
  }}};
}
/** Bigint stats with some fields replaced; the prototype keeps isFile() and the like. */
const restat = (stats: BigIntStats, fields: Partial<Record<'dev' | 'mtimeNs', bigint>>): BigIntStats =>
  Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as BigIntStats, stats, fields);
const statusOf = (result: MediaStatusResult): readonly [string, string] => [result.status, result.reason];

interface Layout {
  readonly root: string;
  /** `<root>/Film` with an empty `Film.mioon` as its project file. */
  readonly project: string;
  /** `<root>/素材`, beside the project directory. */
  readonly outside: string;
  readonly opened: string[];
  access(options?: Partial<MediaAccess>): MediaAccess;
}
function layout(t: TestContext, base?: MediaFileSystem): Layout {
  const root = temporary(t), project = path.join(root, 'Film'), outside = path.join(root, '素材'), projectFile = path.join(project, 'Film.mioon');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(projectFile, '');
  const {fileSystem, opened} = recording(base);
  return {root, project, outside, opened, access: options => ({projectDir: project, projectFile, mayReadOutside: () => false, fileSystem, ...options})};
}
/** A file that passes as MP4: an `ftyp` header, then random bytes. */
function writeMp4(file: string, size = 8192): Buffer {
  const content = Buffer.concat([MP4, randomBytes(Math.max(0, size - MP4.length))]).subarray(0, size);
  writeFileSync(file, content);
  return content;
}
function writeByte(file: string, position: number): void {
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, Buffer.from([0x5a]), 0, 1, position);
  } finally {
    closeSync(fd);
  }
}
const LATER = new Date('2030-01-02T03:04:05.678Z');
const EARLIER = new Date('2024-05-06T07:08:09.123Z');

test('referenceForFile records the real location: relative on the project volume, absolute on another device', async t => {
  // The port puts <root>/other-disk on another device, for lstat and fstat alike.
  const base = NODE_MEDIA_FILE_SYSTEM, otherDisk = (file: string): boolean => file.includes(`${path.sep}other-disk${path.sep}`);
  const moved = (stats: BigIntStats): BigIntStats => restat(stats, {dev: stats.dev + 1n});
  const {root, project, outside, opened, access} = layout(t, {
    ...base,
    lstat: async file => {
      const stats = await base.lstat(file);
      return stats !== null && otherDisk(file) ? moved(stats) : stats;
    },
    open: async file => {
      const handle = await base.open(file);
      return otherDisk(file) ? {...handle, stat: async () => moved(await handle.stat())} : handle;
    },
  });
  const allowed = access({mayReadOutside: () => true});
  const beside = path.join(outside, 'a.mp4'), content = writeMp4(beside);
  const media = await referenceForFile(allowed, beside);
  assert.deepEqual(media, {file: beside, type: VIDEO_MP4, reference: {
    pathForm: 'relative', path: '../素材/a.mp4', volume: null, sizeBytes: content.length, mtimeMs: mediaMtimeMs(lstatSync(beside, {bigint: true})),
    sampledSha256: sha256(content), fullSha256: null,
  }});
  assert.ok(mediaReferenceSchema.safeParse(media.reference).success);
  mkdirSync(path.join(project, '生成'));
  const png = path.join(project, '生成', 'a.png');
  writeFileSync(png, Buffer.concat([PNG, randomBytes(100)]));
  const generated = await referenceForFile(access(), png);
  assert.deepEqual([generated.reference.pathForm, generated.reference.path, generated.type], ['relative', '生成/a.png', type('image', 'image/png')]);
  // A file imported through a link is recorded where it really is.
  const link = path.join(project, 'link.mp4');
  symlinkSync(beside, link);
  const linked = await referenceForFile(allowed, link);
  assert.equal(linked.file, beside);
  assert.deepEqual(linked.reference, media.reference);
  mkdirSync(path.join(root, 'other-disk'));
  const far = path.join(root, 'other-disk', 'b.mp4');
  writeMp4(far);
  const remote = await referenceForFile(allowed, far);
  assert.deepEqual([remote.reference.pathForm, remote.reference.path, remote.reference.volume], ['absolute', far, null]);
  assert.deepEqual(opened, [beside, png, beside, far]);
  await assert.rejects(referenceForFile(allowed, 'Film/a.mp4'), TypeError);
});

test('referenceForFile refuses before opening what may not be read, and after the header what is not media', async t => {
  const {root, project, outside, opened, access} = layout(t);
  const beside = path.join(outside, 'a.mp4');
  writeMp4(beside);
  await assert.rejects(referenceForFile(access(), beside), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  writeFileSync(path.join(project, 'notes.txt'), 'notes');
  await assert.rejects(referenceForFile(access(), path.join(project, 'notes.txt')), {code: 'MEDIA_NOT_MEDIA', details: {reason: 'extension'}});
  mkdirSync(path.join(project, 'x.mp4'));
  await assert.rejects(referenceForFile(access(), path.join(project, 'x.mp4')), {code: 'MEDIA_NOT_MEDIA', details: {reason: 'not-a-file'}});
  if (process.platform !== 'win32' && spawnSync('which', ['mkfifo'], {encoding: 'utf8'}).status === 0) {
    // Never opened, so nothing waits for a writer.
    const fifo = path.join(project, 'pipe.mp4');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    await assert.rejects(referenceForFile(access(), fifo), {code: 'MEDIA_NOT_MEDIA', details: {reason: 'not-a-file'}});
  }
  const sparse = path.join(project, 'cloud.mp4');
  writeFileSync(sparse, '');
  truncateSync(sparse, MIB);
  await assert.rejects(referenceForFile(access(), sparse), {code: 'MEDIA_MISSING', details: {reason: 'not-downloaded'}});
  await assert.rejects(referenceForFile(access(), path.join(project, 'gone.mp4')), {code: 'MEDIA_MISSING', details: {reason: 'not-found'}});
  await assert.rejects(referenceForFile(access({projectDir: path.join(root, 'gone')}), beside), {code: 'MEDIA_MISSING', details: {reason: 'project-directory'}});
  assert.deepEqual(opened, []);
  const fake = path.join(project, 'fake.mp4');
  writeFileSync(fake, 'x'.repeat(5000));
  await assert.rejects(referenceForFile(access(), fake), {code: 'MEDIA_NOT_MEDIA', details: {reason: 'content'}});
  assert.deepEqual(opened, [fake]);
});

test('checkMediaStatus gives every reason, and opens a file only when its modification time alone changed', async t => {
  const {project, opened, access} = layout(t);
  const file = (name: string): string => path.join(project, name);
  const names = ['touched', 'longer', 'content', 'unsampled', 'deleted', 'sparse', 'folder', 'text'];
  const references = new Map<string, MediaReference>();
  for (const name of names) {
    writeMp4(file(`${name}.mp4`), 2 * MIB);
    utimesSync(file(`${name}.mp4`), EARLIER, EARLIER);
    references.set(name, (await computeFullSha256(access(), (await referenceForFile(access(), file(`${name}.mp4`))).reference)).reference);
  }
  const status = (name: string, reference = references.get(name)!): Promise<MediaStatusResult> => checkMediaStatus(access(), reference);
  opened.length = 0;
  assert.deepEqual(await status('touched'), {status: 'online', reason: 'same-stats', file: file('touched.mp4'), outside: false, readable: true,
    reference: references.get('touched')});
  assert.deepEqual(opened, []);
  // Only the modification time: the samples match, the new time is kept and the full hash dropped.
  utimesSync(file('touched.mp4'), LATER, LATER);
  const touched = await status('touched');
  assert.deepEqual(statusOf(touched), ['online', 'same-content']);
  assert.deepEqual(touched.reference, {...references.get('touched'), mtimeMs: mediaMtimeMs(lstatSync(file('touched.mp4'), {bigint: true})), fullSha256: null});
  assert.notEqual(touched.reference.mtimeMs, references.get('touched')!.mtimeMs);
  appendFileSync(file('longer.mp4'), 'x');
  assert.deepEqual(statusOf(await status('longer')), ['changed', 'size']);
  // One byte in the third range, and a new modification time.
  writeByte(file('content.mp4'), sampleRanges(2 * MIB)[2].start + 10);
  utimesSync(file('content.mp4'), LATER, LATER);
  assert.deepEqual(statusOf(await status('content')), ['changed', 'content']);
  // One byte outside the samples with the old modification time put back: still
  // online by its stats, until the full hash is compared.
  writeByte(file('unsampled.mp4'), 100_000);
  utimesSync(file('unsampled.mp4'), EARLIER, EARLIER);
  assert.deepEqual(statusOf(await status('unsampled')), ['online', 'same-stats']);
  rmSync(file('deleted.mp4'));
  assert.deepEqual(await status('deleted'), {status: 'missing', reason: 'not-found', file: null, outside: false, readable: false,
    reference: references.get('deleted')});
  rmSync(file('sparse.mp4'));
  writeFileSync(file('sparse.mp4'), '');
  truncateSync(file('sparse.mp4'), 2 * MIB);
  assert.deepEqual(statusOf(await status('sparse')), ['missing', 'not-downloaded']);
  rmSync(file('folder.mp4'));
  mkdirSync(file('folder.mp4'));
  assert.deepEqual(statusOf(await status('folder')), ['missing', 'not-a-file']);
  writeFileSync(file('text.mp4'), 'x'.repeat(2 * MIB));
  assert.deepEqual(statusOf(await status('text')), ['changed', 'not-media']);
  assert.deepEqual(opened, [file('touched.mp4'), file('content.mp4'), file('text.mp4')]);
  await assert.rejects(computeFullSha256(access(), references.get('unsampled')!), {code: 'MEDIA_CHANGED', details: {reason: 'content'}});
  if (process.platform !== 'win32') {
    const windows = await checkMediaStatus(access(), {...references.get('touched')!, pathForm: 'absolute', path: 'C:\\素材\\a.mp4'});
    assert.deepEqual([...statusOf(windows), windows.file, windows.outside, windows.readable], ['missing', 'other-platform', null, true, false]);
  }
  await assert.rejects(checkMediaStatus(access(), {...references.get('touched')!, sizeBytes: -1}), {code: 'MEDIA_REFERENCE_INVALID', details: {reason: 'schema'}});
});

test('checkMediaStatus reports no-access when a folder on the way may not be entered', {skip: process.platform === 'win32' || asRoot}, async t => {
  const {project, access} = layout(t);
  const locked = path.join(project, 'locked'), file = path.join(locked, 'a.mp4');
  mkdirSync(locked);
  writeMp4(file);
  const {reference} = await referenceForFile(access(), file);
  // Entered again before the temporary folder is removed.
  chmodSync(locked, 0o000);
  try {
    assert.deepEqual(statusOf(await checkMediaStatus(access(), reference)), ['missing', 'no-access']);
    await assert.rejects(admitMedia(access(), reference), {code: 'MEDIA_MISSING', details: {reason: 'no-access'}});
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('outside the project directory only lstat is used until the folder is confirmed', async t => {
  const {outside, opened, access} = layout(t);
  const file = path.join(outside, 'a.mp4');
  writeMp4(file);
  const {reference} = await referenceForFile(access({mayReadOutside: () => true}), file);
  opened.length = 0;
  assert.deepEqual(await checkMediaStatus(access(), reference), {status: 'online', reason: 'same-stats', file, outside: true, readable: false, reference});
  utimesSync(file, LATER, LATER);
  const unverified = await checkMediaStatus(access(), reference);
  assert.deepEqual([...statusOf(unverified), unverified.readable], ['changed', 'unverified', false]);
  assert.deepEqual(opened, []);
  const confirmed = await checkMediaStatus(access({mayReadOutside: insideAnyDirectory([outside])}), reference);
  assert.deepEqual([...statusOf(confirmed), confirmed.readable], ['online', 'same-content', true]);
  assert.deepEqual(opened, [file]);
});

test('admitMedia admits an online file that may be read; computeFullSha256 hashes it whole and compares a recorded hash', async t => {
  const {project, outside, access} = layout(t);
  const file = path.join(project, 'a.mp4'), content = writeMp4(file, 3 * MIB);
  const {reference} = await referenceForFile(access(), file);
  assert.deepEqual(await admitMedia(access(), reference), {file, type: VIDEO_MP4, reference});
  let counted = 0;
  const full = await computeFullSha256(access(), reference, {onBytes: bytes => { counted += bytes; }});
  assert.deepEqual(full, {sha256: sha256(content), reference: {...reference, fullSha256: sha256(content)}});
  assert.equal(counted, content.length);
  assert.deepEqual(await computeFullSha256(access(), full.reference), full);
  await assert.rejects(computeFullSha256(access(), {...reference, fullSha256: 'f'.repeat(64)}), {code: 'MEDIA_CHANGED', details: {reason: 'content'}});
  const controller = new AbortController();
  await assert.rejects(computeFullSha256(access(), reference, {signal: controller.signal, onBytes: () => controller.abort()}), {name: 'AbortError'});
  // The three refusals.
  await assert.rejects(admitMedia(access(), {...reference, path: 'gone.mp4'}), {code: 'MEDIA_MISSING', details: {reason: 'not-found'}});
  const beside = path.join(outside, 'b.mp4');
  writeMp4(beside);
  const unconfirmed = (await referenceForFile(access({mayReadOutside: () => true}), beside)).reference;
  await assert.rejects(admitMedia(access(), unconfirmed), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  await assert.rejects(computeFullSha256(access(), unconfirmed), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  await assert.rejects(admitMedia(access(), {...reference, sizeBytes: reference.sizeBytes + 1}), {code: 'MEDIA_CHANGED', details: {reason: 'size'}});
  // The same size and time but another header: found when it is opened.
  const fake = path.join(project, 'fake.mp4');
  writeFileSync(fake, 'x'.repeat(5000));
  utimesSync(fake, EARLIER, EARLIER);
  const info = lstatSync(fake, {bigint: true});
  await assert.rejects(admitMedia(access(), {...reference, path: 'fake.mp4', sizeBytes: 5000, mtimeMs: mediaMtimeMs(info)}),
    {code: 'MEDIA_NOT_MEDIA', details: {reason: 'content'}});
});

test('a file that changes while it is read is MEDIA_CHANGED_DURING_READ', async t => {
  // Every descriptor's second fstat reports another modification time.
  const base = NODE_MEDIA_FILE_SYSTEM;
  const changing: MediaFileSystem = {...base, open: async file => {
    const handle = await base.open(file);
    let calls = 0;
    return {...handle, stat: async () => {
      const stats = await handle.stat();
      return ++calls >= 2 ? restat(stats, {mtimeNs: stats.mtimeNs + 1n}) : stats;
    }};
  }};
  const {project, access} = layout(t);
  const file = path.join(project, 'a.mp4');
  writeMp4(file);
  const {reference} = await referenceForFile(access(), file);
  await assert.rejects(referenceForFile(access({fileSystem: changing}), file), {code: 'MEDIA_CHANGED_DURING_READ'});
  await assert.rejects(computeFullSha256(access({fileSystem: changing}), reference), {code: 'MEDIA_CHANGED_DURING_READ'});
});

test('an open project keeps its locks: its file, its journal, links to them, super-journals and the test store are never opened', async t => {
  const root = temporary(t);
  const store = openStore(root);
  t.after(() => store.close());
  const journal = `${store.projectFile}-journal`;
  assert.ok(existsSync(journal));
  linkSync(store.projectFile, path.join(root, 'clip.mp4'));
  linkSync(journal, path.join(root, 'journal.mp4'));
  symlinkSync(store.projectFile, path.join(root, 'link.mp4'));
  writeFileSync(path.join(root, 'history.db-mj0DA3D190E'), 'x');
  writeFileSync(path.join(root, 'Other.mioon'), 'x');
  const {fileSystem, opened} = recording();
  const access: MediaAccess = {projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: () => false, fileSystem};
  const fingerprint = {volume: null, sizeBytes: 0, mtimeMs: 0, sampledSha256: 'a'.repeat(64), fullSha256: null};
  for (const name of ['clip.mp4', 'journal.mp4', 'link.mp4', 'history.db-mj0DA3D190E', 'Other.mioon', 'project.mioon', '.mioon-store/local/history.db']) {
    const reference: MediaReference = {pathForm: 'relative', path: name, ...fingerprint};
    assert.deepEqual(statusOf(await checkMediaStatus(access, reference)), ['changed', 'not-media'], name);
    await assert.rejects(admitMedia(access, reference), {code: 'MEDIA_CHANGED', details: {reason: 'not-media'}}, name);
    await assert.rejects(computeFullSha256(access, reference), {code: 'MEDIA_CHANGED', details: {reason: 'not-media'}}, name);
    await assert.rejects(referenceForFile(access, path.join(root, ...name.split('/'))), {code: 'MEDIA_NOT_MEDIA'}, name);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(readInChild(store.projectFile), LOCKED);
  // The control: reading the file with fs in this process drops SQLite's POSIX
  // lock, and the other process can read it.
  if (process.platform !== 'win32') {
    readFileSync(store.projectFile);
    assert.deepEqual(readInChild(store.projectFile), {ok: true});
  }
});

test('a file isHeld names is never opened', async t => {
  const {project, opened, access} = layout(t);
  const file = path.join(project, 'x.mp4');
  writeMp4(file);
  const held = identityOfStats(lstatSync(file, {bigint: true}))!;
  const holding = access({isHeld: identity => identity.dev === held.dev && identity.ino === held.ino});
  await assert.rejects(referenceForFile(holding, file), {code: 'MEDIA_NOT_MEDIA', details: {reason: 'protected'}});
  const {reference} = await referenceForFile(access(), file);
  opened.length = 0;
  assert.deepEqual(statusOf(await checkMediaStatus(holding, reference)), ['changed', 'not-media']);
  await assert.rejects(admitMedia(holding, reference), {code: 'MEDIA_CHANGED', details: {reason: 'not-media'}});
  assert.deepEqual(opened, []);
});
