import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {PROJECT_EXAMPLE_DIRECTORIES, PROJECT_EXAMPLE_MAX_BYTES, PROJECT_EXAMPLE_METADATA_FILES,
  stageProjectExampleResources, verifyProjectExampleResources} from '../packages/business/src/project-example-resources.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {PROJECT_BACKUP_APPLICATION_ID} from '../packages/business/src/project-file/backup.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import type {ProjectTemplateManifest} from '../packages/contracts/src/project-template-manifest.ts';
import {projectExamplesPlugin} from '../apps/web/project-examples-plugin.ts';
import {DatabaseSync} from 'node:sqlite';
import {generateProjectFileExample} from '../scripts/create-project-file-example.ts';
import {assetMediaRecordSchema} from '../packages/contracts/src/asset-media.ts';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'project-example-resources-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), directory = path.join(source, 'timeline-basics');
  fs.mkdirSync(directory, {recursive: true}); fs.mkdirSync(path.join(directory, 'media'));
  const projectFile = path.join(directory, 'timeline-basics.mioon'), projectId = createProjectFile(projectFile);
  const storeLocation = {localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')};
  const store = openProjectStore({projectFile, locate: () => storeLocation});
  store.put('projects', {id: projectId, name: 'Resource fixture', revision: 1}); store.close();
  const media = path.join(directory, 'media/scene.png'), bytes = png({width: 16, height: 16, rgba: false, tagged: false}); fs.writeFileSync(media, bytes);
  const entry = (relative: string) => {const bytes = fs.readFileSync(path.join(directory, relative)); return {path: relative, sizeBytes: bytes.length, sha256: sha(bytes)};};
  const manifest: ProjectTemplateManifest = {templateId: 'timeline-basics', version: 1,
    projectFile: entry('timeline-basics.mioon'), assets: [entry('media/scene.png')]};
  for (const name of PROJECT_EXAMPLE_METADATA_FILES.filter(name => name !== 'manifest.json')) fs.writeFileSync(path.join(directory, name), 'Synthetic Apache-2.0 test provenance.\n');
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest)); save();
  const destination = path.join(root, 'installed');
  return {root, source, directory, projectFile, projectId, storeLocation, media, bytes, manifest, save, destination};
}
const files = (root: string): string[] => fs.readdirSync(root).sort().flatMap(name => {
  const file = path.join(root, name); return fs.lstatSync(file).isDirectory() ? files(file).map(part => name + '/' + part) : [name];
});
const invalid = (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PROJECT_EXAMPLE_RESOURCES_INVALID');

test('fixed built-in catalog verifies ordinary current project, strict manifest, media and retained notices', t => {
  const f = fixture(t), before = files(f.source).map(name => [name, sha(fs.readFileSync(path.join(f.source, name)))]);
  assert.deepEqual(PROJECT_EXAMPLE_DIRECTORIES, ['timeline-basics']); assert.equal(PROJECT_EXAMPLE_MAX_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(verifyProjectExampleResources(f.source), [{directory: f.directory, manifest: f.manifest}]);
  assert.deepEqual(files(f.source).map(name => [name, sha(fs.readFileSync(path.join(f.source, name)))]), before);
  assert.equal(fs.existsSync(path.join(f.directory, 'history.db')), false);
});

test('web and desktop staging preserve the same artifact bytes while creating independent read-only resources', async t => {
  const f = fixture(t), web = path.join(f.root, 'web'); fs.mkdirSync(web);
  const webExamples = path.join(web, 'project-examples'); await stageProjectExampleResources(f.source, webExamples);
  const installed = await stageProjectExampleResources(webExamples, f.destination);
  assert.deepEqual(installed, [{directory: path.join(f.destination, 'timeline-basics'), manifest: f.manifest}]);
  for (const name of files(f.source)) {
    assert.deepEqual(fs.readFileSync(path.join(webExamples, name)), fs.readFileSync(path.join(f.source, name)));
    assert.deepEqual(fs.readFileSync(path.join(f.destination, name)), fs.readFileSync(path.join(f.source, name)));
    assert.notEqual(fs.lstatSync(path.join(f.destination, name)).ino, fs.lstatSync(path.join(webExamples, name)).ino);
    assert.equal(fs.lstatSync(path.join(f.destination, name)).nlink, 1);
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(path.join(f.destination, name)).mode & 0o222, 0);
  }
});

for (const kind of ['empty', 'nonempty', 'symlink'] as const) test(`resource staging never replaces an existing ${kind} destination`, async t => {
  const f = fixture(t);
  if (kind === 'symlink') fs.symlinkSync(f.source, f.destination, 'dir');
  else {fs.mkdirSync(f.destination); if (kind === 'nonempty') fs.writeFileSync(path.join(f.destination, 'keep.txt'), 'user bytes');}
  await assert.rejects(stageProjectExampleResources(f.source, f.destination), {code: 'EEXIST'});
  if (kind === 'nonempty') assert.equal(fs.readFileSync(path.join(f.destination, 'keep.txt'), 'utf8'), 'user bytes');
  assert.equal(fs.lstatSync(f.destination).isSymbolicLink(), kind === 'symlink');
  assert.deepEqual(fs.readFileSync(f.media), f.bytes);
});

for (const damage of ['unknown-root', 'unknown-file', 'empty-extra-directory', 'missing', 'hash', 'size', 'empty-license', 'project-backup', 'non-media', 'oversized', 'bad-manifest'] as const)
  test(`resource verification refuses ${damage} before creating a target`, async t => {
    const f = fixture(t);
    if (damage === 'unknown-root') fs.mkdirSync(path.join(f.source, 'unexpected'));
    if (damage === 'unknown-file') fs.writeFileSync(path.join(f.directory, 'history.db'), 'private records');
    if (damage === 'empty-extra-directory') fs.mkdirSync(path.join(f.directory, 'cache'));
    if (damage === 'missing') fs.unlinkSync(f.media);
    if (damage === 'hash') fs.writeFileSync(f.media, Buffer.alloc(f.bytes.length));
    if (damage === 'size') fs.appendFileSync(f.media, 'x');
    if (damage === 'empty-license') fs.writeFileSync(path.join(f.directory, 'LICENSE'), ' \n');
    if (damage === 'project-backup') {
      const bytes = fs.readFileSync(f.projectFile); bytes.writeUInt32BE(PROJECT_BACKUP_APPLICATION_ID, 68); fs.writeFileSync(f.projectFile, bytes);
      f.manifest.projectFile.sizeBytes = bytes.length; f.manifest.projectFile.sha256 = sha(bytes); f.save();
    }
    if (damage === 'non-media') {
      const bytes = Buffer.alloc(f.bytes.length); fs.writeFileSync(f.media, bytes); f.manifest.assets[0].sha256 = sha(bytes); f.save();
    }
    if (damage === 'oversized') {fs.truncateSync(f.media, PROJECT_EXAMPLE_MAX_BYTES); f.manifest.assets[0].sizeBytes = PROJECT_EXAMPLE_MAX_BYTES; f.save();}
    if (damage === 'bad-manifest') fs.writeFileSync(path.join(f.directory, 'manifest.json'), '{broken');
    await assert.rejects(stageProjectExampleResources(f.source, f.destination)); assert.equal(fs.existsSync(f.destination), false);
    if (damage !== 'project-backup') assert.throws(() => verifyProjectExampleResources(f.source), invalid);
  });

for (const damage of ['root-symlink', 'directory-symlink', 'asset-symlink', 'asset-hardlink', 'manifest-hardlink', 'nul'] as const)
  test(`resource verification refuses ${damage} without opening aliases`, t => {
    const f = fixture(t); let source = f.source;
    if (damage === 'root-symlink') {source = path.join(f.root, 'source-alias'); fs.symlinkSync(f.source, source, 'dir');}
    if (damage === 'directory-symlink') {const original = path.join(f.root, 'original'); fs.renameSync(f.directory, original); fs.symlinkSync(original, f.directory, 'dir');}
    if (damage === 'asset-symlink') {fs.unlinkSync(f.media); fs.symlinkSync(f.projectFile, f.media);}
    if (damage === 'asset-hardlink') fs.linkSync(f.media, path.join(f.root, 'media-alias'));
    if (damage === 'manifest-hardlink') fs.linkSync(path.join(f.directory, 'manifest.json'), path.join(f.root, 'manifest-alias'));
    if (damage === 'nul') source += '\0';
    assert.throws(() => verifyProjectExampleResources(source), invalid);
    assert.equal(fs.existsSync(f.destination), false);
  });

test('live project inode is refused before any hashing descriptor can release its SQLite locks', t => {
  const f = fixture(t), store = openProjectStore({projectFile: f.projectFile, locate: () => f.storeLocation}), open = fs.openSync;
  let attempts = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {if (String(args[0]) === f.projectFile) attempts++; return open(...args);});
  syncBuiltinESMExports();
  try {assert.throws(() => verifyProjectExampleResources(f.source), invalid); assert.equal(attempts, 0); assert.equal(store.db.isOpen, true);}
  finally {t.mock.restoreAll(); syncBuiltinESMExports(); store.close();}
});

test('a failed write cleans only the new staging tree and preserves every source byte', async t => {
  const f = fixture(t), write = fs.writeFileSync, before = files(f.source).map(name => [name, sha(fs.readFileSync(path.join(f.source, name)))]);
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).startsWith(f.destination + path.sep) && String(args[0]).endsWith('.mioon')) throw Object.assign(Error('synthetic disk full'), {code: 'ENOSPC'});
    return write(...args);
  }); syncBuiltinESMExports();
  try {await assert.rejects(stageProjectExampleResources(f.source, f.destination), {code: 'ENOSPC'}); assert.equal(fs.existsSync(f.destination), false);}
  finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.deepEqual(files(f.source).map(name => [name, sha(fs.readFileSync(path.join(f.source, name)))]), before);
});

test('Vite closeBundle stages into its resolved artifact output without running a build', async t => {
  const f = fixture(t), output = path.join(f.root, 'web-dist'); fs.mkdirSync(output);
  const plugin = projectExamplesPlugin(f.source);
  assert.equal(plugin.apply, 'build'); assert.equal(plugin.name, 'mioon-project-examples');
  assert.equal(typeof plugin.configResolved, 'function'); assert.equal(typeof plugin.closeBundle, 'function');
  if (typeof plugin.configResolved !== 'function' || typeof plugin.closeBundle !== 'function') throw Error('Expected direct resource hooks');
  await plugin.configResolved.call({} as never, {root: f.root, build: {outDir: 'web-dist'}} as Parameters<typeof plugin.configResolved>[0]);
  await plugin.closeBundle.call({} as never);
  assert.deepEqual(verifyProjectExampleResources(path.join(output, 'project-examples'))[0].manifest, f.manifest);
  assert.equal(fs.existsSync(path.join(output, 'index.html')), false, 'the hook only stages fixed resources, not a second frontend build');
});

test('the offline generator stores canonical imported-media metadata without null dimension or duration sentinels', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'project-example-metadata-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const output = path.join(root, 'timeline-basics'); await generateProjectFileExample(output);
  const db = new DatabaseSync(path.join(output, 'timeline-basics.mioon'), {readOnly: true});
  try {
    const assets = db.prepare('SELECT data FROM assets ORDER BY id').all().map(row => JSON.parse(String(row.data)) as Record<string, unknown>);
    assert.deepEqual(assets.map(asset => ({mimeType: asset.mimeType, width: asset.width, height: asset.height, duration: asset.duration,
      hasVideo: asset.hasVideo, hasAudio: asset.hasAudio})), [
      {mimeType: 'video/mp4', width: 720, height: 1280, duration: 4, hasVideo: true, hasAudio: false},
      {mimeType: 'video/mp4', width: 720, height: 1280, duration: 5, hasVideo: true, hasAudio: true},
      {mimeType: 'image/png', width: 360, height: 480, duration: 0, hasVideo: true, hasAudio: false},
      {mimeType: 'audio/wav', width: 0, height: 0, duration: 10, hasVideo: false, hasAudio: true},
    ]);
    for (const asset of assets) assert.ok(assetMediaRecordSchema.safeParse(asset).success, String(asset.name));
  } finally {db.close();}
});
