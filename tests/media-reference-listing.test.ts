// Listing the project directory for Mio (task card L1, plan 10.3): only
// folders and media, each with name, kind, MIME type, size and duration, in an
// open project of the test layout with media made by ffmpeg. Nothing it skips
// is opened, so the project keeps its SQLite locks.
import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../packages/business/src/media.ts';
import {openStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {listProjectMedia, MAX_LIST_SCAN, NODE_MEDIA_FILE_SYSTEM, probeMediaDuration} from '../packages/business/src/media-reference/index.ts';
import type {MediaAccess, MediaFileSystem} from '../packages/business/src/media-reference/index.ts';

const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const CHILD = fileURLToPath(new URL('./helpers/project-file-child.ts', import.meta.url));
const LOCKED = {ok: false, message: 'database is locked', errcode: 5};
const INVALID = (reason: string) => ({code: 'MEDIA_LIST_PATH_INVALID', status: 400, details: {reason}});

/** Another process reading the file read-only with a busy timeout of 0. */
function readInChild(file: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CHILD], {cwd: REPOSITORY, env: {...process.env, MODE: 'raw-read', FILE: file}, encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

interface Fixture {
  /** The project directory of the open store. */
  readonly root: string;
  readonly store: ProjectStore;
  /** Every open of the port, in order. */
  readonly opened: string[];
  readonly access: MediaAccess;
}
let fixture: Fixture;
const cleanups: (() => void)[] = [];

before(async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-l1-listing-'));
  cleanups.push(() => rmSync(root, {recursive: true, force: true}));
  const elsewhere = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-l1-listing-outside-'));
  cleanups.push(() => rmSync(elsewhere, {recursive: true, force: true}));
  // The test layout: project.mioon with its journal, .mioon-store/ and media/.
  const store = openStore(root);
  cleanups.push(() => store.close());
  const file = (...names: string[]): string => path.join(root, ...names);
  const quiet = ['-hide_banner', '-loglevel', 'error'];
  const film = ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  await run('ffmpeg', [...quiet, ...film, file('a.mp4')]);
  await run('ffmpeg', [...quiet, ...film, file('a.mov')]);
  await run('ffmpeg', [...quiet, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-c:a', 'pcm_s16le', file('b.wav')]);
  await run('ffmpeg', [...quiet, '-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', file('c.png')]);
  writeFileSync(file('notes.txt'), 'notes');
  writeFileSync(file('fake.mp4'), 'only text, no video. '.repeat(20));
  writeFileSync(file('.DS_Store'), 'x');
  copyFileSync(file('a.mp4'), file('._a.mp4'));
  copyFileSync(file('a.mp4'), file('.hidden.mp4'));
  linkSync(store.projectFile, file('clip.mp4'));
  symlinkSync(file('a.mp4'), file('link.mp4'));
  writeFileSync(file('cloud.mp4'), '');
  truncateSync(file('cloud.mp4'), 1_048_576);
  mkdirSync(file('生成'));
  copyFileSync(file('c.png'), file('生成', 'still.png'));
  mkdirSync(file('.cache'));
  copyFileSync(file('a.mp4'), file('.cache', 'a.mp4'));
  copyFileSync(file('a.mp4'), path.join(elsewhere, 'e.mp4'));
  symlinkSync(elsewhere, file('outside'));
  symlinkSync(file('生成'), file('alias'));
  symlinkSync(file('.mioon-store'), file('store-alias'));
  const opened: string[] = [];
  const fileSystem: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, open: async target => {
    opened.push(target);
    return NODE_MEDIA_FILE_SYSTEM.open(target);
  }};
  fixture = {root, store, opened, access: {projectDir: store.projectDir, projectFile: store.projectFile, mayReadOutside: () => false, fileSystem}};
});
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

test('the project directory: folders first, then media with type, size and an ffprobe duration; nothing else is opened', async () => {
  const {root, store, opened, access} = fixture;
  opened.length = 0;
  const listing = await listProjectMedia(access);
  const size = (name: string): number => lstatSync(path.join(root, name)).size;
  assert.deepEqual({...listing, entries: listing.entries.map(({durationSeconds: _duration, ...entry}) => entry)}, {directory: '', truncated: false, entries: [
    {name: 'media', kind: 'folder', mimeType: null, sizeBytes: null},
    {name: '生成', kind: 'folder', mimeType: null, sizeBytes: null},
    {name: 'a.mov', kind: 'video', mimeType: 'video/quicktime', sizeBytes: size('a.mov')},
    {name: 'a.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: size('a.mp4')},
    {name: 'b.wav', kind: 'audio', mimeType: 'audio/wav', sizeBytes: size('b.wav')},
    {name: 'c.png', kind: 'image', mimeType: 'image/png', sizeBytes: size('c.png')},
  ]});
  for (const entry of listing.entries) assert.deepEqual(Object.keys(entry), ['name', 'kind', 'mimeType', 'sizeBytes', 'durationSeconds'], entry.name);
  const durations = new Map(listing.entries.map(entry => [entry.name, entry.durationSeconds]));
  for (const name of ['media', '生成', 'c.png']) assert.equal(durations.get(name), null, name);
  for (const [name, seconds] of [['a.mov', 1], ['a.mp4', 1], ['b.wav', 0.5]] as const) {
    const measured = durations.get(name);
    assert.ok(typeof measured === 'number' && Math.abs(measured - seconds) < 0.1, `${name}: ${String(measured)}`);
  }
  // Headers were read of the media files and of fake.mp4 only: never of the
  // project file, its journal, the hard link to it, the placeholder or a dot file.
  assert.deepEqual(opened, ['a.mov', 'a.mp4', 'b.wav', 'c.png', 'fake.mp4'].map(name => path.join(root, name)));
  assert.deepEqual(readInChild(store.projectFile), LOCKED);
});

test('a folder below, a link to one, and the paths that cannot be listed', async () => {
  const {root, access} = fixture;
  let probed = 0;
  const still = {name: 'still.png', kind: 'image', mimeType: 'image/png', sizeBytes: lstatSync(path.join(root, '生成', 'still.png')).size, durationSeconds: null};
  assert.deepEqual(await listProjectMedia(access, '生成', {probeDuration: async () => ++probed}), {directory: '生成', entries: [still], truncated: false});
  assert.equal(probed, 0);
  // A link inside the project to a folder inside it is listed where it leads.
  assert.deepEqual(await listProjectMedia(access, 'alias'), {directory: 'alias', entries: [still], truncated: false});
  for (const directory of ['..', '../x', 'a/../b', '生成/../..', '/abs', 'a\\b', '生成/', './生成', 'C:/x', '.mioon-store', '.mioon-store/local', '.cache',
    'project.mioon-journal', 'project.mioon']) {
    await assert.rejects(listProjectMedia(access, directory), INVALID('path'), directory);
  }
  await assert.rejects(listProjectMedia(access, 'store-alias'), INVALID('path'));
  await assert.rejects(listProjectMedia(access, 'outside'), INVALID('outside'));
  await assert.rejects(listProjectMedia(access, 'gone'), INVALID('missing'));
  await assert.rejects(listProjectMedia(access, '生成/gone'), INVALID('missing'));
  await assert.rejects(listProjectMedia(access, 'a.mp4'), INVALID('not-a-directory'));
  for (const limit of [0, 1.5, MAX_LIST_SCAN + 1]) await assert.rejects(listProjectMedia(access, '', {limit}), TypeError);
});

test('a limit cuts the listing short, a failing probe only drops durations, and a crowded folder is truncated', async () => {
  const {access} = fixture;
  const names = (listing: {readonly entries: readonly {readonly name: string}[]}): string[] => listing.entries.map(entry => entry.name);
  const two = await listProjectMedia(access, '', {limit: 2, probeDuration: async () => null});
  assert.deepEqual([names(two), two.truncated], [['media', '生成'], true]);
  const five = await listProjectMedia(access, '', {limit: 5, probeDuration: async () => null});
  assert.deepEqual([names(five), five.truncated], [['media', '生成', 'a.mov', 'a.mp4', 'b.wav'], true]);
  // Exactly six entries can be listed: the files after them are checked and skipped.
  const six = await listProjectMedia(access, '', {limit: 6, probeDuration: async file => path.basename(file) === 'b.wav' ? 0.5 : Number.NaN});
  assert.deepEqual([six.entries.map(entry => [entry.name, entry.durationSeconds]), six.truncated],
    [[['media', null], ['生成', null], ['a.mov', null], ['a.mp4', null], ['b.wav', 0.5], ['c.png', null]], false]);
  const failing = await listProjectMedia(access, '', {probeDuration: async () => { throw new Error('ffprobe failed'); }});
  assert.deepEqual(failing, {...six, entries: six.entries.map(entry => ({...entry, durationSeconds: null}))});
  let asked = 0;
  const crowded: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, readDirectory: async (_directory, limit) => {
    asked = limit;
    return Array.from({length: limit}, (_, index) => ({name: `${index}.txt`, kind: 'file' as const}));
  }};
  assert.deepEqual(await listProjectMedia({...access, fileSystem: crowded}), {directory: '', entries: [], truncated: true});
  assert.equal(asked, MAX_LIST_SCAN + 1);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(listProjectMedia(access, '', {signal: aborted.signal}), {name: 'AbortError'});
  const during = new AbortController();
  await assert.rejects(listProjectMedia(access, '', {signal: during.signal, probeDuration: async () => {
    during.abort();
    throw new Error('stopped');
  }}), /stopped|aborted/u);
});

test('probeMediaDuration times video and audio with ffprobe and is null where it cannot', async () => {
  const {root} = fixture;
  const seconds = await probeMediaDuration(path.join(root, 'b.wav'));
  assert.ok(typeof seconds === 'number' && Math.abs(seconds - 0.5) < 0.1, String(seconds));
  assert.equal(await probeMediaDuration(path.join(root, 'fake.mp4')), null);
  assert.equal(await probeMediaDuration(path.join(root, 'gone.mp4')), null);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(probeMediaDuration(path.join(root, 'a.mp4'), aborted.signal));
});
