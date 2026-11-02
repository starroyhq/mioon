// Paths of media references (task card L1): the relative or absolute form,
// volume names, resolution, relinking (12-05) and the folders outside the
// project directory (12-06). Pure functions; Windows drive letters and UNC
// shares through path.win32.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import {
  formatAbsolutePath, insideAnyDirectory, isInsideDirectory, mediaReferenceError, outsideDirectoryGroups, parseAbsolutePath, referencePathFor,
  relinkBases, relinkTarget, resolveReferencePath, volumeNameOf,
} from '../packages/business/src/media-reference/index.ts';
import type {MediaReferenceErrorCode, ReferencePath} from '../packages/business/src/media-reference/index.ts';

const posix = path.posix, win32 = path.win32;
const FINGERPRINT = {sizeBytes: 1024, mtimeMs: 1_700_000_000_000.25, sampledSha256: 'a'.repeat(64), fullSha256: null};
const INVALID_PATH = {code: 'MEDIA_REFERENCE_INVALID', status: 400, details: {reason: 'path'}};
const relative = (value: string): ReferencePath => ({pathForm: 'relative', path: value, volume: null});
const absolute = (value: string, volume: string | null = null): ReferencePath => ({pathForm: 'absolute', path: value, volume});
/** The stored path with a fingerprint passes the contract's schema. */
function stored(actual: ReferencePath, expected: ReferencePath): void {
  assert.deepEqual(actual, expected);
  assert.ok(mediaReferenceSchema.safeParse({...actual, ...FINGERPRINT}).success, actual.path);
}

test('error codes carry their HTTP status and only the details given', () => {
  const statuses: Record<MediaReferenceErrorCode, number> = {
    MEDIA_REFERENCE_INVALID: 400, MEDIA_MISSING: 404, MEDIA_CHANGED: 409, MEDIA_NOT_MEDIA: 415, MEDIA_OUTSIDE_NOT_CONFIRMED: 403,
    MEDIA_CHANGED_DURING_READ: 409, MEDIA_LIST_PATH_INVALID: 400,
  };
  for (const [code, status] of Object.entries(statuses)) {
    const error = mediaReferenceError(code as MediaReferenceErrorCode);
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.deepEqual(error.details, {});
  }
  assert.deepEqual(mediaReferenceError('MEDIA_MISSING', {reason: 'not-found'}).details, {reason: 'not-found'});
});

// ---------------------------------------------------------------------------
// Relative or absolute

test('POSIX: on the project volume a path relative to the project directory, elsewhere the absolute path and its volume name', () => {
  const film = '/Users/me/Movies/Film';
  stored(referencePathFor(film, '/Users/me/Movies/素材/访谈/a.mp4', true, posix), relative('../素材/访谈/a.mp4'));
  stored(referencePathFor(film, '/Users/me/Movies/Film/生成/clip.mp4', true, posix), relative('生成/clip.mp4'));
  stored(referencePathFor(`${film}/`, '/Users/me/Movies/./素材//a.mp4', true, posix), relative('../素材/a.mp4'));
  stored(referencePathFor(film, '/Volumes/素材盘/访谈/a.mp4', false, posix), absolute('/Volumes/素材盘/访谈/a.mp4', '素材盘'));
  stored(referencePathFor(film, '/Users/me/a.mp4', false, posix), absolute('/Users/me/a.mp4'));
});

test('POSIX: a name holding a backslash, the project directory and its parents cannot be stored', () => {
  const film = '/Users/me/Movies/Film';
  assert.throws(() => referencePathFor(film, `${film}/a\\b.mp4`, true, posix), INVALID_PATH);
  assert.throws(() => referencePathFor(film, '/Volumes/素材盘/a\\b.mp4', false, posix), INVALID_PATH);
  assert.throws(() => referencePathFor(film, film, true, posix), INVALID_PATH);
  assert.throws(() => referencePathFor(film, '/Users/me/Movies', true, posix), INVALID_PATH);
  assert.throws(() => referencePathFor(film, 'a.mp4', true, posix), INVALID_PATH);
  assert.throws(() => referencePathFor(film, 'C:\\素材\\a.mp4', false, posix), INVALID_PATH);
  assert.throws(() => referencePathFor('Film', `${film}/a.mp4`, true, posix), INVALID_PATH);
});

test('Windows: one drive letter in either case is one volume; other drives and shares keep absolute paths', () => {
  const film = 'C:\\Users\\me\\Videos\\Mioon\\Film';
  stored(referencePathFor(film, 'C:\\Users\\me\\Videos\\素材\\a.mp4', true, win32), relative('../../素材/a.mp4'));
  stored(referencePathFor('c:\\users\\ME\\Videos\\Mioon\\Film', 'C:\\Users\\me\\Videos\\素材\\a.mp4', true, win32), relative('../../素材/a.mp4'));
  stored(referencePathFor(film, 'C:\\Users\\me\\Videos\\Mioon\\Film\\生成\\clip.mp4', true, win32), relative('生成/clip.mp4'));
  // Even when the caller reports the same device: another letter or share is another root.
  stored(referencePathFor(film, 'D:\\素材\\a.mp4', true, win32), absolute('D:\\素材\\a.mp4'));
  stored(referencePathFor(film, 'd:/素材/a.mp4', false, win32), absolute('D:\\素材\\a.mp4'));
  stored(referencePathFor(film, '\\\\nas\\share\\a.mp4', true, win32), absolute('\\\\nas\\share\\a.mp4', '\\\\nas\\share'));
  const share = '\\\\nas\\share\\Film';
  stored(referencePathFor(share, '\\\\nas\\other\\a.mp4', true, win32), absolute('\\\\nas\\other\\a.mp4', '\\\\nas\\other'));
  stored(referencePathFor(share, '\\\\NAS\\Share\\素材\\a.mp4', true, win32), relative('../素材/a.mp4'));
  stored(referencePathFor(share, 'C:\\素材\\a.mp4', true, win32), absolute('C:\\素材\\a.mp4'));
  assert.throws(() => referencePathFor(film, '/Volumes/素材盘/a.mp4', false, win32), INVALID_PATH);
  assert.throws(() => referencePathFor(film, 'C:\\Users\\clip:1.mp4', true, win32), INVALID_PATH);
});

test('resolveReferencePath resolves relative paths on both platforms and finds nothing for the other platform', () => {
  assert.equal(resolveReferencePath('/Users/me/Movies/Film', {pathForm: 'relative', path: '../素材/访谈/a.mp4'}, posix), '/Users/me/Movies/素材/访谈/a.mp4');
  assert.equal(resolveReferencePath('/Users/me/Movies/Film', {pathForm: 'relative', path: '生成/clip.mp4'}, posix), '/Users/me/Movies/Film/生成/clip.mp4');
  assert.equal(resolveReferencePath('/Film', {pathForm: 'relative', path: '../../../a.mp4'}, posix), '/a.mp4');
  assert.equal(resolveReferencePath('C:\\Users\\me\\Videos\\Mioon\\Film', {pathForm: 'relative', path: '../../素材/a.mp4'}, win32), 'C:\\Users\\me\\Videos\\素材\\a.mp4');
  assert.equal(resolveReferencePath('\\\\nas\\share\\Film', {pathForm: 'relative', path: '../../a.mp4'}, win32), '\\\\nas\\share\\a.mp4');
  assert.equal(resolveReferencePath('C:\\Film', {pathForm: 'absolute', path: 'C:/x/y.mp4'}, win32), 'C:\\x\\y.mp4');
  assert.equal(resolveReferencePath('/Film', {pathForm: 'absolute', path: '/Volumes/素材盘/a.mp4'}, posix), '/Volumes/素材盘/a.mp4');
  assert.equal(resolveReferencePath('/Film', {pathForm: 'absolute', path: 'C:\\素材\\a.mp4'}, posix), null);
  assert.equal(resolveReferencePath('/Film', {pathForm: 'absolute', path: '\\\\nas\\share\\a.mp4'}, posix), null);
  assert.equal(resolveReferencePath('C:\\Film', {pathForm: 'absolute', path: '/Volumes/素材盘/a.mp4'}, win32), null);
  // A name Windows cannot hold: `clip:1.mp4` would name a stream of `clip`.
  assert.equal(resolveReferencePath('C:\\Film', {pathForm: 'relative', path: 'clip:1.mp4'}, win32), null);
  assert.equal(resolveReferencePath('/Film', {pathForm: 'relative', path: 'clip:1.mp4'}, posix), '/Film/clip:1.mp4');
  assert.equal(resolveReferencePath('/Film', {pathForm: 'relative', path: 'a/../b.mp4'}, posix), null);
  assert.equal(resolveReferencePath('Film', {pathForm: 'relative', path: 'a.mp4'}, posix), null);
});

test('parseAbsolutePath takes POSIX, drive and UNC paths and refuses device, drive-relative and relative paths', () => {
  assert.deepEqual(parseAbsolutePath('/'), {flavor: 'posix', root: '/', segments: []});
  assert.deepEqual(parseAbsolutePath('/a//b/./c/'), {flavor: 'posix', root: '/', segments: ['a', 'b', 'c']});
  assert.deepEqual(parseAbsolutePath('/a\\b'), {flavor: 'posix', root: '/', segments: ['a\\b']});
  assert.deepEqual(parseAbsolutePath('c:/x\\y'), {flavor: 'win32', root: 'C:\\', segments: ['x', 'y']});
  assert.deepEqual(parseAbsolutePath('\\\\nas\\share'), {flavor: 'win32', root: '\\\\nas\\share', segments: []});
  assert.deepEqual(parseAbsolutePath('\\\\nas\\share\\a\\b.mp4'), {flavor: 'win32', root: '\\\\nas\\share', segments: ['a', 'b.mp4']});
  for (const value of ['\\\\?\\C:\\a', '\\\\.\\PhysicalDrive0', '\\\\nas', '\\\\nas\\', 'C:a.mp4', 'C:', 'a/b', 'a.mp4', '', '/a/../b', '/a\u0000b',
    'C:\\a\\clip:1.mp4']) {
    assert.equal(parseAbsolutePath(value), null, value);
  }
  for (const value of ['/', '/Volumes/素材盘/a.mp4', 'C:\\', 'C:\\x\\y.mp4', '\\\\nas\\share', '\\\\nas\\share\\a.mp4']) {
    assert.equal(formatAbsolutePath(parseAbsolutePath(value)!), value);
  }
});

test('volumeNameOf reads the name of /Volumes/<name> and the share of a UNC path, nothing else', () => {
  assert.equal(volumeNameOf('/Volumes/素材盘/访谈/a.mp4'), '素材盘');
  assert.equal(volumeNameOf('/Volumes/素材盘'), '素材盘');
  assert.equal(volumeNameOf('/Volumes'), null);
  assert.equal(volumeNameOf('/Users/me/a.mp4'), null);
  assert.equal(volumeNameOf('\\\\nas\\share\\a.mp4'), '\\\\nas\\share');
  assert.equal(volumeNameOf('D:\\素材\\a.mp4'), null);
  assert.equal(volumeNameOf(`/Volumes/${'x'.repeat(256)}/a.mp4`), null);
});

// ---------------------------------------------------------------------------
// Inside or outside

test('isInsideDirectory compares whole names, NFC-normalized, without case on Windows, and never across roots', () => {
  assert.equal(isInsideDirectory('/a/Film', '/a/Film/x.mp4', posix), true);
  assert.equal(isInsideDirectory('/a/Film', '/a/Film', posix), true);
  assert.equal(isInsideDirectory('/a/Film', '/a/Film2/x.mp4', posix), false);
  assert.equal(isInsideDirectory('/a/Film', '/a/x.mp4', posix), false);
  assert.equal(isInsideDirectory('/a/Film', '/a/film/x.mp4', posix), false);
  const nfc = 'Caf\u00e9', nfd = 'Cafe\u0301';
  assert.equal(isInsideDirectory(`/a/${nfc}`, `/a/${nfd}/x.mp4`, posix), true);
  assert.equal(isInsideDirectory(`/a/${nfd}`, `/a/${nfc}/x.mp4`, posix), true);
  assert.equal(isInsideDirectory('C:\\Users\\Me\\Film', 'c:\\users\\me\\FILM\\x.mp4', win32), true);
  assert.equal(isInsideDirectory('C:\\Film', 'C:\\Film2\\x.mp4', win32), false);
  assert.equal(isInsideDirectory('C:\\Film', 'D:\\Film\\x.mp4', win32), false);
  assert.equal(isInsideDirectory('\\\\nas\\share', '\\\\nas\\other\\x.mp4', win32), false);
  assert.equal(isInsideDirectory('\\\\nas\\share', '\\\\NAS\\SHARE\\x.mp4', win32), true);
  assert.equal(isInsideDirectory('C:\\Film', '/Film/x.mp4', win32), false);
  assert.equal(isInsideDirectory('/Film', 'C:\\Film\\x.mp4', posix), false);
  const confirmed = insideAnyDirectory(['/Volumes/素材盘/访谈', '/Users/me/Downloads', 'C:\\素材'], posix);
  assert.equal(confirmed('/Volumes/素材盘/访谈/0912/a.mp4'), true);
  assert.equal(confirmed('/Users/me/Downloads/a.mp4'), true);
  assert.equal(confirmed('/Volumes/素材盘/a.mp4'), false);
  assert.equal(confirmed('C:\\素材\\a.mp4'), false);
  assert.equal(insideAnyDirectory([], posix)('/a.mp4'), false);
});

// ---------------------------------------------------------------------------
// Relinking (12-05)

test('relinkBases drops the common tail of both folders: the 12-05 example, a renamed file and one folder', () => {
  const bases = relinkBases('/Volumes/素材盘/拍摄/0912/scene-c.mp4', '/Volumes/素材盘-备份/拍摄/0912/scene-c.mp4')!;
  assert.equal(formatAbsolutePath(bases.from), '/Volumes/素材盘');
  assert.equal(formatAbsolutePath(bases.to), '/Volumes/素材盘-备份');
  assert.equal(relinkTarget(bases, '/Volumes/素材盘/拍摄/0912/scene-f.mp4'), '/Volumes/素材盘-备份/拍摄/0912/scene-f.mp4');
  assert.equal(relinkTarget(bases, '/Volumes/素材盘/拍摄/0913/scene-h.mp4'), '/Volumes/素材盘-备份/拍摄/0913/scene-h.mp4');
  assert.equal(relinkTarget(bases, '/Volumes/素材盘/a.mp4'), '/Volumes/素材盘-备份/a.mp4');
  assert.equal(relinkTarget(bases, '/Volumes/素材盘'), null);
  assert.equal(relinkTarget(bases, '/Volumes/素材盘2/拍摄/a.mp4'), null);
  assert.equal(relinkTarget(bases, '/Users/me/a.mp4'), null);
  assert.equal(relinkTarget(bases, 'D:\\素材盘\\a.mp4'), null);
  // The chosen file was renamed as well: its folder still maps.
  const renamed = relinkBases('/Volumes/素材盘/拍摄/0912/scene-c.mp4', '/Volumes/备份/素材/拍摄/0912/C 镜头.mp4')!;
  assert.equal(formatAbsolutePath(renamed.from), '/Volumes/素材盘');
  assert.equal(formatAbsolutePath(renamed.to), '/Volumes/备份/素材');
  assert.equal(relinkTarget(renamed, '/Volumes/素材盘/拍摄/0913/h.mp4'), '/Volumes/备份/素材/拍摄/0913/h.mp4');
  // The same folder: every path maps onto itself.
  const same = relinkBases('/Volumes/素材盘/拍摄/a.mp4', '/Volumes/素材盘/拍摄/b.mp4')!;
  assert.equal(formatAbsolutePath(same.from), '/');
  assert.equal(relinkTarget(same, '/Volumes/素材盘/拍摄/c.mp4'), '/Volumes/素材盘/拍摄/c.mp4');
  assert.equal(relinkBases('relative/a.mp4', '/a.mp4'), null);
  assert.equal(relinkBases('/', '/a.mp4'), null);
});

test('a path stored on Windows maps onto a Mac without case, in its own folder and a sibling one', () => {
  const bases = relinkBases('D:\\素材\\拍摄\\0912\\c.mp4', '/Volumes/素材/拍摄/0912/c.mp4')!;
  assert.deepEqual(bases.from, {flavor: 'win32', root: 'D:\\', segments: []});
  assert.equal(formatAbsolutePath(bases.to), '/Volumes');
  assert.equal(relinkTarget(bases, 'D:\\素材\\拍摄\\0912\\f.mp4'), '/Volumes/素材/拍摄/0912/f.mp4');
  assert.equal(relinkTarget(bases, 'd:\\素材\\拍摄\\0913\\h.mp4'), '/Volumes/素材/拍摄/0913/h.mp4');
  assert.equal(relinkTarget(bases, 'E:\\素材\\拍摄\\0912\\f.mp4'), null);
  assert.equal(relinkTarget(bases, '/Volumes/素材/拍摄/0912/f.mp4'), null);
  const folded = relinkBases('D:\\Footage\\Day1\\c.mp4', '/Volumes/footage/day1/c.mp4')!;
  assert.equal(formatAbsolutePath(folded.from), 'D:\\');
  assert.equal(formatAbsolutePath(folded.to), '/Volumes');
  assert.equal(relinkTarget(folded, 'D:\\Footage\\Day2\\x.mp4'), '/Volumes/Footage/Day2/x.mp4');
  // Back onto a drive: a Mac name Windows cannot hold maps nowhere.
  const back = relinkBases('/Volumes/素材/a.mp4', 'D:\\素材\\a.mp4')!;
  assert.equal(relinkTarget(back, '/Volumes/素材/b.mp4'), 'D:\\素材\\b.mp4');
  assert.equal(relinkTarget(back, '/Volumes/素材/clip:1.mp4'), null);
});

// ---------------------------------------------------------------------------
// Folders outside the project directory (12-06)

test('outsideDirectoryGroups counts nested folders with the outer one and keeps siblings apart, on both platforms', () => {
  assert.deepEqual(outsideDirectoryGroups([
    '/Users/me/素材/访谈/0912/a.mp4',
    '/Users/me/素材/访谈/0912/b.mp4',
    '/Users/me/素材/访谈/0912/sub/c.mp4',
    '/Users/me/素材/访谈/0913/d.mp4',
    '/Volumes/素材盘/e.mp4',
    '\\\\nas\\share\\g.mp4',
    '\\\\NAS\\Share\\h.mp4',
    '\\\\nas\\share\\x\\i.mp4',
    'D:\\素材\\v.mp4',
    'd:\\素材\\w.mp4',
    'relative/x.mp4',
  ]), [
    {directory: '/Users/me/素材/访谈/0912', count: 3},
    {directory: '/Users/me/素材/访谈/0913', count: 1},
    {directory: '/Volumes/素材盘', count: 1},
    {directory: 'D:\\素材', count: 2},
    {directory: '\\\\nas\\share', count: 3},
  ]);
  // A file at the root makes the root a folder, and every folder is inside it.
  assert.deepEqual(outsideDirectoryGroups(['/f.mp4']), [{directory: '/', count: 1}]);
  assert.deepEqual(outsideDirectoryGroups(['/f.mp4', '/Volumes/素材盘/e.mp4']), [{directory: '/', count: 2}]);
  assert.deepEqual(outsideDirectoryGroups(['C:\\f.mp4']), [{directory: 'C:\\', count: 1}]);
  assert.deepEqual(outsideDirectoryGroups([]), []);
});
