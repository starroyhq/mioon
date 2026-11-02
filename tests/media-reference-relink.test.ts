// Relinking missing media (task card L1, plan 10.1, 12-05) and the folders
// outside the project directory (plan 8.4, 12-06), in temporary folders.
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mediaReferenceSchema, outsideProjectLocationSchema} from '../packages/contracts/src/media-reference.ts';
import type {MediaReference, OutsideProjectLocation} from '../packages/contracts/src/media-reference.ts';
import {
  MAX_RELINK_ASSETS, NODE_MEDIA_FILE_SYSTEM, outsideProjectLocations, referenceForFile, relinkMedia,
} from '../packages/business/src/media-reference/index.ts';
import type {MediaAccess, MediaAsset, MediaFileSystem} from '../packages/business/src/media-reference/index.ts';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(52)]);
const EARLIER = new Date('2024-05-06T07:08:09.123Z'), LATER = new Date('2030-01-02T03:04:05.678Z');

/** A file that passes as MP4, with random content and an earlier modification time. */
function writeMp4(file: string, size = 8192): void {
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, Buffer.concat([MP4, randomBytes(size - MP4.length)]));
  utimesSync(file, EARLIER, EARLIER);
}
interface Layout {
  readonly root: string;
  /** `<root>/project` with an empty `Film.mioon` as its project file. */
  readonly project: string;
  readonly opened: string[];
  /** Outside files may be read unless `mayReadOutside` says otherwise. */
  access(options?: Partial<MediaAccess>): MediaAccess;
}
function layout(t: TestContext): Layout {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-l1-relink-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const project = path.join(root, 'project'), projectFile = path.join(project, 'Film.mioon');
  mkdirSync(project);
  writeFileSync(projectFile, '');
  const opened: string[] = [];
  const fileSystem: MediaFileSystem = {...NODE_MEDIA_FILE_SYSTEM, open: async file => {
    opened.push(file);
    return NODE_MEDIA_FILE_SYSTEM.open(file);
  }};
  return {root, project, opened, access: options => ({projectDir: project, projectFile, mayReadOutside: () => true, fileSystem, ...options})};
}
const asset = async (access: MediaAccess, id: string, file: string): Promise<MediaAsset> => ({id, reference: (await referenceForFile(access, file)).reference});

test('12-05: the new place of one missing file relinks the others with the same structure, checked by fingerprint', async t => {
  const {root, project, opened, access} = layout(t);
  const shot = (disk: string, day: string, name: string): string => path.join(root, 'disk', disk, '拍摄', day, name);
  for (const name of ['scene-c.mp4', 'scene-f.mp4', 'scene-g.mp4']) writeMp4(shot('素材盘', '0912', name));
  writeMp4(shot('素材盘', '0913', 'scene-h.mp4'));
  writeMp4(path.join(project, '生成', 'clip.mp4'));
  const assets = [
    await asset(access(), 'c', shot('素材盘', '0912', 'scene-c.mp4')),
    await asset(access(), 'f', shot('素材盘', '0912', 'scene-f.mp4')),
    await asset(access(), 'g', shot('素材盘', '0912', 'scene-g.mp4')),
    await asset(access(), 'h', shot('素材盘', '0913', 'scene-h.mp4')),
    await asset(access(), 'clip', path.join(project, '生成', 'clip.mp4')),
  ];
  assert.equal(assets[0].reference.path, '../disk/素材盘/拍摄/0912/scene-c.mp4');
  // The disk was copied to a backup: scene-g has other content of the same
  // size and a new time, scene-h did not make it.
  renameSync(path.join(root, 'disk', '素材盘'), path.join(root, 'disk', '素材盘-备份'));
  writeMp4(shot('素材盘-备份', '0912', 'scene-g.mp4'));
  utimesSync(shot('素材盘-备份', '0912', 'scene-g.mp4'), LATER, LATER);
  rmSync(shot('素材盘-备份', '0913', 'scene-h.mp4'));
  opened.length = 0;
  const result = await relinkMedia(access(), assets, {assetId: 'c', file: shot('素材盘-备份', '0912', 'scene-c.mp4')});
  const moved = (name: string, reference: MediaReference): MediaReference => ({...reference, path: `../disk/素材盘-备份/拍摄/0912/${name}`});
  assert.deepEqual(result, {
    chosen: {assetId: 'c', file: shot('素材盘-备份', '0912', 'scene-c.mp4'), reference: moved('scene-c.mp4', assets[0].reference), matches: true},
    found: [{assetId: 'f', file: shot('素材盘-备份', '0912', 'scene-f.mp4'), reference: moved('scene-f.mp4', assets[1].reference)}],
    mismatched: [{assetId: 'g', file: shot('素材盘-备份', '0912', 'scene-g.mp4')}],
    unverified: [],
  });
  for (const media of [result.chosen, ...result.found]) assert.ok(mediaReferenceSchema.safeParse(media.reference).success, media.assetId);
  // The chosen file is read and scene-g's samples are compared; scene-f matches by its stats alone.
  assert.deepEqual(opened, [shot('素材盘-备份', '0912', 'scene-c.mp4'), shot('素材盘-备份', '0912', 'scene-g.mp4')]);
});

test('relinking without reading: matching stats suffice, a new time alone is unverified, and the chosen file must be readable', async t => {
  const {root, opened, access} = layout(t);
  const file = (folder: string, name: string): string => path.join(root, folder, 'day', name);
  for (const name of ['c.mp4', 'f.mp4', 't.mp4']) writeMp4(file('A', name));
  const assets = [
    await asset(access(), 'c', file('A', 'c.mp4')), await asset(access(), 'f', file('A', 'f.mp4')), await asset(access(), 't', file('A', 't.mp4')),
  ];
  renameSync(path.join(root, 'A'), path.join(root, 'B'));
  utimesSync(file('B', 't.mp4'), LATER, LATER);
  const chosen = {assetId: 'c', file: file('B', 'c.mp4')};
  opened.length = 0;
  const result = await relinkMedia(access({mayReadOutside: candidate => candidate === chosen.file}), assets, chosen);
  assert.equal(result.chosen.matches, true);
  assert.deepEqual(result.found.map(media => [media.assetId, media.reference.path]), [['f', '../B/day/f.mp4']]);
  assert.deepEqual(result.unverified, [{assetId: 't', file: file('B', 't.mp4')}]);
  assert.deepEqual(result.mismatched, []);
  assert.deepEqual(opened, [chosen.file]);
  await assert.rejects(relinkMedia(access({mayReadOutside: () => false}), assets, chosen), {code: 'MEDIA_OUTSIDE_NOT_CONFIRMED'});
  // Another file chosen: it does not match and keeps its own fingerprint; the
  // folders still map, and t is read now that it may be.
  writeMp4(file('B', 'other.mp4'), 4000);
  const other = await relinkMedia(access(), assets, {assetId: 'c', file: file('B', 'other.mp4')});
  assert.equal(other.chosen.matches, false);
  assert.deepEqual(other.chosen.reference, (await referenceForFile(access(), file('B', 'other.mp4'))).reference);
  assert.deepEqual(other.found.map(media => [media.assetId, media.reference.mtimeMs === assets[2].reference.mtimeMs]), [['f', true], ['t', false]]);
  assert.equal(other.found[1].reference.fullSha256, null);
  await assert.rejects(relinkMedia(access(), assets, {assetId: 'x', file: chosen.file}), {code: 'MEDIA_REFERENCE_INVALID', details: {reason: 'asset'}});
  await assert.rejects(relinkMedia(access(), Array.from({length: MAX_RELINK_ASSETS + 1}, () => assets[0]), chosen),
    {code: 'MEDIA_REFERENCE_INVALID', details: {reason: 'asset'}});
  await assert.rejects(relinkMedia(access(), assets, {assetId: 'c', file: 'B/day/c.mp4'}), TypeError);
});

test('12-06: the folders outside the project directory, where the files really are, nested folders counted with the outer one', async t => {
  const {root, project, access} = layout(t);
  const interview = path.join(root, '素材', '访谈', '0912');
  for (const file of [path.join(interview, 'a.mp4'), path.join(interview, 'b.mp4'), path.join(interview, 'sub', 'c.mp4'), path.join(root, 'other', 'd.mp4'),
    path.join(root, 'elsewhere', 'real.mp4'), path.join(project, '生成', 'x.mp4')]) {
    writeMp4(file);
  }
  symlinkSync(path.join(root, 'elsewhere', 'real.mp4'), path.join(project, 'link.mp4'));
  const assets: MediaAsset[] = [
    await asset(access(), 'a', path.join(interview, 'a.mp4')),
    await asset(access(), 'b', path.join(interview, 'b.mp4')),
    await asset(access(), 'c', path.join(interview, 'sub', 'c.mp4')),
    await asset(access(), 'd', path.join(root, 'other', 'd.mp4')),
    await asset(access(), 'x', path.join(project, '生成', 'x.mp4')),
  ];
  // A link inside the project pointing out of it, a folder that is gone, and a path from Windows.
  const fingerprint = assets[0].reference;
  assets.push({id: 'link', reference: {...fingerprint, path: 'link.mp4'}}, {id: 'gone', reference: {...fingerprint, path: '../gone/e.mp4'}});
  if (process.platform !== 'win32') assets.push({id: 'windows', reference: {...fingerprint, pathForm: 'absolute', path: 'D:\\素材\\v.mp4'}});
  const locations = await outsideProjectLocations(access({mayReadOutside: () => false}), assets);
  const expected: OutsideProjectLocation[] = [
    {directory: path.join(root, 'elsewhere'), volume: null, assetCount: 1, available: true},
    {directory: path.join(root, 'gone'), volume: null, assetCount: 1, available: false},
    {directory: path.join(root, 'other'), volume: null, assetCount: 1, available: true},
    {directory: interview, volume: null, assetCount: 3, available: true},
  ];
  if (process.platform !== 'win32') expected.push({directory: 'D:\\素材', volume: null, assetCount: 1, available: false});
  assert.deepEqual(locations, expected);
  for (const location of locations) assert.ok(outsideProjectLocationSchema.safeParse(location).success, location.directory);
});
