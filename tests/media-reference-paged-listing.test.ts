import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MIO_PROJECT_MEDIA_LIMITS, mioProjectMediaListingSchema} from '../packages/contracts/src/mio-project-media.ts';
import {listProjectMediaPage, probeMediaDuration} from '../packages/business/src/media-reference/listing.ts';
import type {ProjectMediaPageOptions} from '../packages/business/src/media-reference/listing.ts';
import {NODE_MEDIA_FILE_SYSTEM} from '../packages/business/src/media-reference/file-system.ts';
import type {MediaFileSystem} from '../packages/business/src/media-reference/file-system.ts';
import type {MediaAccess} from '../packages/business/src/media-reference/access.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VIDEO = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const changed = {code: 'MEDIA_CHANGED_DURING_READ', status: 409};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-paged-listing-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectFile = path.join(root, 'project.mioon'); writeFileSync(projectFile, 'not media');
  const opened: string[] = [];
  const fileSystem: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, async open(file) {
    opened.push(path.basename(file)); return NODE_MEDIA_FILE_SYSTEM.open(file);
  }};
  const access: MediaAccess = {projectDir: root, projectFile, mayReadOutside: () => false, fileSystem};
  const options: ProjectMediaPageOptions = {projectId: PROJECT, probeDuration: async (_file, _signal, {beforeEffect} = {}) => {beforeEffect?.(); return 1.25;}};
  const write = (name: string, bytes: Uint8Array = VIDEO): void => writeFileSync(path.join(root, name), bytes);
  return {root, access, options, opened, write};
}

test('paged discovery keeps folder ordering and probes only returned audio/video entries across opaque continuations', async t => {
  const f = fixture(t); mkdirSync(path.join(f.root, '素材')); mkdirSync(path.join(f.root, 'A'));
  f.write('a.mp4'); f.write('b.mp4'); f.write('c.png', PNG); f.write('d.mp4');
  f.write('.hidden.mp4'); f.write('not-a-video.mp4', Buffer.from('plain text')); f.write('unsupported.mov');
  symlinkSync(path.join(f.root, 'a.mp4'), path.join(f.root, 'link.mp4'));
  const probed: string[] = [];
  const options: ProjectMediaPageOptions = {...f.options, limit: 2, probeDuration: async (file, _signal, {beforeEffect} = {}) => {
    beforeEffect?.(); probed.push(path.basename(file)); return 4.5;
  }};
  const first = await listProjectMediaPage(f.access, '', options);
  assert.deepEqual(first.entries.map(item => item.name), ['A', '素材']); assert.deepEqual([...probed], []); assert.deepEqual([...f.opened], []);
  assert.equal(first.truncated, true); assert.ok(first.nextCursor); assert.ok(!Buffer.from(first.nextCursor, 'base64url').toString().includes(f.root));
  const second = await listProjectMediaPage(f.access, '', {...options, cursor: first.nextCursor});
  assert.deepEqual(second.entries.map(item => [item.name, item.durationSeconds]), [['a.mp4', 4.5], ['b.mp4', 4.5]]);
  assert.deepEqual(probed, ['a.mp4', 'b.mp4']); assert.deepEqual(f.opened, ['a.mp4', 'b.mp4']); assert.ok(second.nextCursor);
  const third = await listProjectMediaPage(f.access, '', {...options, cursor: second.nextCursor});
  assert.deepEqual(third.entries.map(item => item.name), ['c.png', 'd.mp4']); assert.deepEqual(probed, ['a.mp4', 'b.mp4', 'd.mp4']);
  assert.ok(third.nextCursor); // The unexamined .mp4 candidate still needs a header check.
  const last = await listProjectMediaPage(f.access, '', {...options, cursor: third.nextCursor});
  assert.deepEqual([...last.entries], []); assert.equal(last.nextCursor, null); assert.equal(last.truncated, false);
  assert.ok(!f.opened.includes('unsupported.mov')); assert.ok(!JSON.stringify(third).includes(f.root));
});

test('cursor binding and directory changes are revalidated, with strict relative paths and bounded limits', async t => {
  const f = fixture(t); f.write('a.mp4'); f.write('b.mp4'); mkdirSync(path.join(f.root, '子目录'));
  const first = await listProjectMediaPage(f.access, '', {...f.options, limit: 1}); assert.ok(first.nextCursor);
  for (const options of [{...f.options, projectId: OTHER}, {...f.options, scopeVersion: 'different'}]) {
    await assert.rejects(listProjectMediaPage(f.access, '', {...options, cursor: first.nextCursor}), {code: 'MEDIA_LIST_PATH_INVALID'});
  }
  await assert.rejects(listProjectMediaPage(f.access, '子目录', {...f.options, cursor: first.nextCursor}), {code: 'MEDIA_LIST_PATH_INVALID'});
  for (const cursor of ['bad', first.nextCursor + '=', 'x'.repeat(2049)]) {
    await assert.rejects(listProjectMediaPage(f.access, '', {...f.options, cursor}), {code: 'MEDIA_LIST_PATH_INVALID'});
  }
  for (const directory of ['/absolute', '..', 'a/../b', 'a\\b', '.hidden', 'a//b', 'NUL', 'a\u0001', 'bad\ud800', 'x:stream']) {
    await assert.rejects(listProjectMediaPage(f.access, directory, f.options), {code: 'MEDIA_LIST_PATH_INVALID'}, directory);
  }
  for (const limit of [0, 101, 1.5]) await assert.rejects(listProjectMediaPage(f.access, '', {...f.options, limit}), TypeError);
  f.write('unrelated.txt', Buffer.from('new entry'));
  await assert.rejects(listProjectMediaPage(f.access, '', {...f.options, cursor: first.nextCursor}), changed);
});

test('directory aliases remain inside the real visible project boundary and folders are not recursively opened', async t => {
  const f = fixture(t); const outside = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-paged-outside-'));
  t.after(() => rmSync(outside, {recursive: true, force: true}));
  mkdirSync(path.join(f.root, 'inside')); f.write('inside/a.png', PNG);
  mkdirSync(path.join(f.root, '.private')); f.write('.private/a.mp4');
  symlinkSync(path.join(f.root, 'inside'), path.join(f.root, 'alias'));
  symlinkSync(outside, path.join(f.root, 'external'));
  symlinkSync(path.join(f.root, '.private'), path.join(f.root, 'hidden-alias'));
  assert.deepEqual((await listProjectMediaPage(f.access, 'alias', f.options)).entries.map(item => item.name), ['a.png']);
  await assert.rejects(listProjectMediaPage({...f.access, mayReadOutside: () => true}, 'external', f.options), {code: 'MEDIA_LIST_PATH_INVALID', details: {reason: 'outside'}});
  await assert.rejects(listProjectMediaPage(f.access, 'hidden-alias', f.options), {code: 'MEDIA_LIST_PATH_INVALID', details: {reason: 'path'}});
  f.opened.length = 0;
  assert.deepEqual((await listProjectMediaPage(f.access, '', f.options)).entries.map(item => item.name), ['inside']); assert.deepEqual([...f.opened], []);
});

test('publication filtering and held identities run before opening, and trusted registered duration avoids another probe', async t => {
  const f = fixture(t); f.write('held.mp4'); f.write('partial.mp4'); f.write('registered.mp4'); f.write('unknown.mp4');
  const held = lstatSync(path.join(f.root, 'held.mp4'), {bigint: true}); let probed = 0, checked = 0;
  const result = await listProjectMediaPage({...f.access, isHeld: identity => {
    checked++; return identity.dev === String(held.dev) && identity.ino === String(held.ino);
  }}, '', {...f.options,
    isExcluded: file => file.endsWith('/partial.mp4'),
    registeredDuration: file => file.endsWith('/registered.mp4') ? {durationSeconds: 9.75} : undefined,
    probeDuration: async () => {probed++; throw new Error('probe failed');},
  });
  assert.deepEqual(result.entries.map(item => [item.name, item.durationSeconds]), [['registered.mp4', 9.75], ['unknown.mp4', null]]);
  assert.deepEqual(f.opened, ['registered.mp4', 'unknown.mp4']); assert.equal(probed, 1); assert.ok(checked > 2);
});

/** Virtual media shares ordinary file stats, but every filesystem operation,
 * including the synchronous spawn fence, stays on the trusted port. */
function virtualMedia(f: ReturnType<typeof fixture>, names: string[]) {
  f.write('.virtual-source.mp4'); const info = lstatSync(path.join(f.root, '.virtual-source.mp4'), {bigint: true});
  const files = new Set(names.map(name => path.join(f.root, name))); let bytesRead = 0;
  const fileSystem: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM,
    lstatSync: file => files.has(file) ? info : NODE_MEDIA_FILE_SYSTEM.lstatSync!(file),
    realpathSync: file => files.has(file) ? file : NODE_MEDIA_FILE_SYSTEM.realpathSync!(file),
    lstat: async file => files.has(file) ? info : NODE_MEDIA_FILE_SYSTEM.lstat(file),
    realpath: async file => files.has(file) ? file : NODE_MEDIA_FILE_SYSTEM.realpath(file),
    readDirectory: async (_directory, limit) => names.slice(0, limit).map(name => ({name, kind: 'file' as const})),
    async open(file) {
      assert.ok(files.has(file)); f.opened.push(path.basename(file));
      return {stat: async () => info, read: async (buffer, position) => {
        const bytes = VIDEO.subarray(position, position + buffer.length); buffer.set(bytes); bytesRead += bytes.length; return bytes.length;
      }, close: async () => {}};
    },
  };
  return {fileSystem, bytesRead: () => bytesRead};
}

test('16 KiB budget is decided before header/probe work, including maximum JSON numbers and continuation overhead', async t => {
  const f = fixture(t); const names = Array.from({length: 15}, (_, i) => '素材'.repeat(300) + String(i).padStart(2, '0') + '.mp4');
  const virtual = virtualMedia(f, names); const access = {...f.access, fileSystem: virtual.fileSystem};
  const probed: string[] = []; const options = {...f.options, limit: 100, probeDuration: async (file: string) => {probed.push(path.basename(file)); return Number.MAX_VALUE;}};
  const first = await listProjectMediaPage(access, '', options);
  assert.ok(first.entries.length > 0 && first.entries.length < names.length); assert.ok(first.nextCursor); assert.equal(first.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= MIO_PROJECT_MEDIA_LIMITS.resultBytes); mioProjectMediaListingSchema.parse(first);
  assert.deepEqual(probed, first.entries.map(item => item.name)); assert.deepEqual(f.opened, probed);
  assert.equal(virtual.bytesRead(), first.entries.length * VIDEO.length);
  const second = await listProjectMediaPage(access, '', {...options, cursor: first.nextCursor});
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= MIO_PROJECT_MEDIA_LIMITS.resultBytes);
  assert.deepEqual([...first.entries, ...second.entries].map(item => item.name), names);
  assert.equal(second.nextCursor, null);
});

test('enumeration asks for at most 5001 entries and reports a scan cutoff without inventing a continuation', async t => {
  const f = fixture(t); let asked = 0;
  const fileSystem: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, async readDirectory(_directory, limit) {
    asked = limit; return Array.from({length: limit}, (_, i) => ({name: `${i}.txt`, kind: 'file' as const}));
  }};
  assert.deepEqual(await listProjectMediaPage({...f.access, fileSystem}, '', f.options), {directory: '', entries: [], nextCursor: null, truncated: true});
  assert.equal(asked, 5001); assert.deepEqual([...f.opened], []);
  const {lstatSync: _stat, realpathSync: _realpath, ...withoutSync} = fileSystem;
  await assert.rejects(listProjectMediaPage({...f.access, fileSystem: withoutSync}, '', f.options), /synchronous filesystem admission/u);
});

test('directory replacement during enumeration and cancellation during a header read invalidate the entire page', async t => {
  const f = fixture(t); mkdirSync(path.join(f.root, 'sub')); f.write('sub/a.mp4');
  const replaced: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, async readDirectory(directory, limit) {
    const entries = await NODE_MEDIA_FILE_SYSTEM.readDirectory(directory, limit);
    renameSync(directory, path.join(f.root, 'old')); mkdirSync(directory); return entries;
  }};
  await assert.rejects(listProjectMediaPage({...f.access, fileSystem: replaced}, 'sub', f.options), changed);
  f.write('a.mp4'); const controller = new AbortController(); let closed = 0;
  const cancelled: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, async open(file) {
    const handle = await NODE_MEDIA_FILE_SYSTEM.open(file);
    return {...handle, async read(bytes, position) {const result = await handle.read(bytes, position); controller.abort(); return result;},
      async close() {closed++; await handle.close();}};
  }};
  await assert.rejects(listProjectMediaPage({...f.access, fileSystem: cancelled}, '', {...f.options, signal: controller.signal}), {name: 'AbortError'});
  assert.equal(closed, 1);
});

test('a target changed before child-process admission fails rather than becoming a null duration', async t => {
  const f = fixture(t); f.write('a.mp4');
  await assert.rejects(listProjectMediaPage(f.access, '', {...f.options, probeDuration: async (file, _signal, {beforeEffect} = {}) => {
    writeFileSync(file, Buffer.concat([VIDEO, Buffer.from('changed')])); beforeEffect?.(); return 3;
  }}), changed);
  const denied = new Error('host owner revoked');
  await assert.rejects(probeMediaDuration(path.join(f.root, 'a.mp4'), undefined, {beforeEffect: () => {throw denied;}}), error => error === denied);
});

for (const at of ['owner', 'publication'] as const) test(`the final ${at} callback cannot admit a newly held target to the filesystem open`, async t => {
  const f = fixture(t); f.write('a.mp4');
  const identity = lstatSync(path.join(f.root, 'a.mp4'), {bigint: true});
  let held = false, checked = 0, exclusions = 0, opened = 0;
  const access: MediaAccess = {...f.access,
    isHeld: value => {if (value.dev !== String(identity.dev) || value.ino !== String(identity.ino)) return false; checked++; return held;},
    fileSystem: {...NODE_MEDIA_FILE_SYSTEM, async open(file) {opened++; return NODE_MEDIA_FILE_SYSTEM.open(file);}},
  };
  await assert.rejects(listProjectMediaPage(access, '', {...f.options,
    beforeEffect: () => {if (at === 'owner' && checked >= 3) held = true;},
    isExcluded: () => {if (at === 'publication' && ++exclusions === 3) held = true; return false;},
  }), changed);
  assert.equal(held, true); assert.equal(opened, 0);
});

test('owner failure is preserved and all already-started page probes settle before discovery rejects', async t => {
  const f = fixture(t); for (let i = 0; i < 4; i++) f.write(`${i}.mp4`);
  const denied = new Error('exact owner closed'); let revoked = false, completed = 0;
  await assert.rejects(listProjectMediaPage(f.access, '', {...f.options,
    beforeEffect: () => {if (revoked) throw denied;},
    probeDuration: async (_file, _signal, {beforeEffect} = {}) => {
      await new Promise<void>(resolve => setTimeout(resolve, 5)); completed++; revoked = true; beforeEffect?.(); return 2;
    },
  }), error => error === denied);
  assert.equal(completed, 4);
});
