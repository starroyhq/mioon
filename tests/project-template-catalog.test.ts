import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectTemplateCatalog} from '../apps/server/src/project-host/templates.ts';
import type {ProjectTemplateCatalogEntry, ProjectTemplateManifest} from '../apps/server/src/project-host/templates.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {captureClosedProjectSnapshot} from '../packages/business/src/project-file/closed-copy.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {openProjectBackup, publishProjectCopyFile} from '../packages/business/src/project-file/backup.ts';
import {HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {mediaMtimeMs, sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const code = (expected: string, reason?: string) => (error: unknown): boolean => Boolean(error && typeof error === 'object'
  && 'code' in error && error.code === expected && (reason === undefined || 'details' in error && error.details !== null
    && typeof error.details === 'object' && 'reason' in error.details && error.details.reason === reason));
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-template-')), directory = path.join(root, 'template');
  mkdirSync(directory); mkdirSync(path.join(directory, 'media'));
  const bytes = png({width: 16, height: 16, rgba: false, tagged: false}), media = path.join(directory, 'media', 'scene.png');
  writeFileSync(media, bytes);
  const projectFile = path.join(directory, 'example.mioon'), projectId = createProjectFile(projectFile), assetId = randomUUID();
  const location = {localDir: path.join(root, 'source-records'), cacheDir: path.join(root, 'source-cache'), tempDir: path.join(root, 'source-tmp')};
  const reference: MediaReference = {pathForm: 'relative', path: 'media/scene.png', volume: null,
    sizeBytes: bytes.length, mtimeMs: mediaMtimeMs(lstatSync(media, {bigint: true})), sampledSha256: hash(bytes), fullSha256: hash(bytes)};
  const open = () => openProjectStore({projectFile, locate: () => location});
  const store = open();
  store.put('projects', {id: projectId, name: 'Trusted template', revision: 1, description: projectId});
  store.put('assets', {id: assetId, projectId, reference, referenceRevision: 1, sha256: hash(bytes), sizeBytes: bytes.length, name: 'scene.png', mimeType: 'image/png'});
  const sourceStamp = readProjectContentStamp(store.db);
  store.close();
  const manifest: ProjectTemplateManifest = {templateId: 'starter', version: 1,
    projectFile: {path: 'example.mioon', sizeBytes: readFileSync(projectFile).length, sha256: hash(readFileSync(projectFile))},
    assets: [{path: 'media/scene.png', sizeBytes: bytes.length, sha256: hash(bytes)}]};
  const entry: ProjectTemplateCatalogEntry = {directory, manifest};
  const catalog = () => createProjectTemplateCatalog([entry]);
  const stage = (name: string = randomUUID()) => {const value = path.join(root, name); mkdirSync(value); return value;};
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, directory, media, projectFile, projectId, assetId, bytes, manifest, entry, catalog, stage, open, reference, sourceStamp};
}

test('a trusted catalog resolves only its immutable ID/version, not caller paths', t => {
  const f = fixture(t), catalog = f.catalog();
  f.manifest.projectFile.path = 'changed.mioon'; f.manifest.assets.length = 0;
  const {dev, ino, size, mtimeNs, ctimeNs} = lstatSync(f.projectFile, {bigint: true});
  assert.deepEqual(catalog.describe('starter', 1), {templateId: 'starter', version: 1, projectFile: f.projectFile,
    projectId: f.projectId, sourceProjectDir: f.directory, sourceStamp: f.sourceStamp, sourceGeneration: [dev, ino, size, mtimeNs, ctimeNs].join(':')});
  assert.throws(() => catalog.describe(f.projectFile, 1), code('PROJECT_TEMPLATE_NOT_FOUND'));
  assert.throws(() => catalog.describe('starter', 2), code('PROJECT_TEMPLATE_NOT_FOUND'));
  assert.equal(existsSync(path.join(f.directory, 'changed.mioon')), false);
});

test('two template materializations create independent media, new IDs/tokens and empty execution domains', async t => {
  const f = fixture(t), catalog = f.catalog(), sourceProject = readFileSync(f.projectFile), sourceMedia = readFileSync(f.media);
  const description = catalog.describe('starter', 1), copies: Array<{id: string; token: string; media: string}> = [];
  const captured = await captureClosedProjectSnapshot({projectFile: f.projectFile,
    historyFile: () => path.join(f.root, 'no-template-history.db'), directory: path.join(f.root, 'snapshot')});
  const reader = openProjectBackup(captured.projectFile);
  try {
    for (const name of ['first', 'second']) {
      const directory = f.stage(name), targetDirectory = path.join(f.root, `${name}-public`);
      const prepared = catalog.prepareAssets('starter', 1, {directory, targetDirectory});
      assert.deepEqual(prepared.files, [path.join(directory, 'media', 'scene.png')]);
      const projectFile = path.join(directory, `${name}.mioon`);
      const copied = await copyProjectToNewFile(reader, {projectFile, sourceProjectDir: description.sourceProjectDir, targetProjectDir: targetDirectory,
        referenceTargets: prepared.referenceTargets, clearProcessRevisions: true, projectName: name, publish: publishProjectCopyFile});
      assert.equal(copied.formatVersion, PROJECT_FILE_SCHEMA_VERSION);
      const store = openProjectStore({projectFile, locate: () => ({localDir: path.join(f.root, `${name}-records`), cacheDir: path.join(f.root, `${name}-cache`), tempDir: path.join(f.root, `${name}-tmp`)})});
      try {
        assert.equal(store.historyState, 'fresh');
        assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()!.version, HISTORY_SCHEMA_VERSION);
        for (const table of HISTORY_TABLES.filter(value => !['schema_version', 'history_state', 'mio_storage_counters'].includes(value))) {
          assert.equal(store.db.prepare(`SELECT count(*) n FROM main."${table}"`).get()!.n, 0, table);
        }
        assert.deepEqual({...store.db.prepare('SELECT * FROM main.mio_storage_counters').get()}, {singleton: 1, bytes: 0, rows: 1});
        const project = store.get('projects', copied.projectId) as {id: string; name: string; description: string};
        assert.equal(project.id, copied.projectId); assert.equal(project.name, name); assert.equal(project.description, f.projectId);
        const asset = store.get('assets', f.assetId) as {projectId: string; reference: MediaReference; referenceRevision: number};
        assert.equal(asset.projectId, copied.projectId); assert.equal(asset.referenceRevision, 1);
        assert.equal(asset.reference.pathForm, 'relative'); assert.equal(asset.reference.path, 'media/scene.png');
        assert.equal(asset.reference.fullSha256, hash(f.bytes)); assert.equal(asset.reference.sampledSha256, hash(f.bytes));
        assert.equal(asset.reference.mtimeMs, mediaMtimeMs(lstatSync(prepared.files[0], {bigint: true})));
      } finally {store.close();}
      copies.push({id: copied.projectId, token: copied.contentToken, media: prepared.files[0]});
    }
  } finally {reader.close();}
  assert.notEqual(copies[0].id, copies[1].id); assert.notEqual(copies[0].id, f.projectId); assert.notEqual(copies[0].token, copies[1].token);
  assert.notEqual(lstatSync(copies[0].media).ino, lstatSync(copies[1].media).ino);
  for (const copy of copies) {assert.notEqual(lstatSync(copy.media).ino, lstatSync(f.media).ino); assert.equal(lstatSync(copy.media).nlink, 1);}
  writeFileSync(copies[0].media, 'Only the first instance changes');
  assert.deepEqual(readFileSync(copies[1].media), sourceMedia); assert.deepEqual(readFileSync(f.media), sourceMedia);
  assert.deepEqual(readFileSync(f.projectFile), sourceProject);
});

for (const pathName of ['../escape.png', '/absolute.png', 'media/../scene.png', 'media\\scene.png', '.private/scene.png', 'media/.scene.png', 'cache/scene.png', 'AGENTS.md', 'history.db'])
  test(`template manifest refuses private or traversing asset path ${pathName}`, t => {
    const f = fixture(t); f.manifest.assets[0].path = pathName;
    assert.throws(f.catalog, code('PROJECT_TEMPLATE_INVALID'));
    assert.deepEqual(readdirSync(f.directory).sort(), ['example.mioon', 'media']);
  });

test('catalog refuses duplicate and file/directory collision manifest paths', t => {
  const f = fixture(t); f.manifest.assets.push({...f.manifest.assets[0]});
  assert.throws(f.catalog, code('PROJECT_TEMPLATE_INVALID', 'manifest-paths'));
  f.manifest.assets[1].path = 'media/scene.png/inside.png';
  assert.throws(f.catalog, code('PROJECT_TEMPLATE_INVALID', 'manifest-paths'));
  f.manifest.assets.pop();
  assert.throws(() => createProjectTemplateCatalog([f.entry, f.entry]), code('PROJECT_TEMPLATE_INVALID', 'duplicate-template'));
});

for (const mode of ['missing', 'size', 'hash', 'symlink', 'parent-symlink', 'not-media'] as const)
  test(`template asset ${mode} rejects the whole staging result without altering source or another file`, t => {
    const f = fixture(t), stage = f.stage(), catalog = f.catalog();
    const originalProject = readFileSync(f.projectFile);
    if (mode === 'missing') rmSync(f.media);
    if (mode === 'size') writeFileSync(f.media, 'short');
    if (mode === 'hash') writeFileSync(f.media, Buffer.alloc(f.bytes.length));
    if (mode === 'symlink') {rmSync(f.media); symlinkSync(f.projectFile, f.media);}
    if (mode === 'parent-symlink') {const moved = path.join(f.root, 'other-media'); mkdirSync(moved); writeFileSync(path.join(moved, 'scene.png'), f.bytes); rmSync(path.dirname(f.media), {recursive: true}); symlinkSync(moved, path.dirname(f.media));}
    if (mode === 'not-media') {
      const bytes = Buffer.alloc(f.bytes.length); writeFileSync(f.media, bytes); f.manifest.assets[0].sha256 = hash(bytes);
    }
    const active = mode === 'not-media' ? f.catalog() : catalog;
    assert.throws(() => active.prepareAssets('starter', 1, {directory: stage, targetDirectory: path.join(f.root, 'final')}), code('PROJECT_TEMPLATE_INVALID'));
    assert.deepEqual(readdirSync(stage), []); assert.deepEqual(readFileSync(f.projectFile), originalProject);
    assert.equal(existsSync(path.join(f.root, 'final')), false);
  });

test('template source project hash is checked and held SQLite input is refused before fs reading', t => {
  const f = fixture(t), catalog = f.catalog(), held = f.open();
  try {assert.throws(() => catalog.describe('starter', 1), code('PROJECT_TEMPLATE_INVALID', 'held-file'));}
  finally {held.close();}
  const fileBytes = readFileSync(f.projectFile); fileBytes[fileBytes.length - 1] ^= 1; writeFileSync(f.projectFile, fileBytes);
  assert.throws(() => catalog.describe('starter', 1), code('PROJECT_TEMPLATE_INVALID', 'content-hash'));
});

test('catalog hashing and SQLite identity inspection must belong to one file generation', t => {
  const f = fixture(t), catalog = f.catalog(), original = readFileSync(f.projectFile), lstat = fs.lstatSync;
  let changed = false;
  t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const result = lstat(...args), stack = new Error().stack ?? '';
    // Emulate an external metadata change immediately after the backup
    // reader's final observation. Its own check sees its returned old stat;
    // the catalog must independently bind that inspection to the earlier hash.
    if (!changed && String(args[0]) === f.projectFile && result && stack.includes('openReadOnly') && !stack.includes('checkHeader')) {
      changed = true;
      fs.utimesSync(f.projectFile, result.atime, new Date(Number(result.mtimeMs) + 2000));
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => catalog.describe('starter', 1), code('PROJECT_TEMPLATE_INVALID', 'source-changed'));
    assert.equal(changed, true, 'the external-change seam ran after native SQLite inspection');
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
  assert.deepEqual(readFileSync(f.projectFile), original, 'metadata changed, but the complete template bytes and content pair did not');
  assert.deepEqual(catalog.describe('starter', 1).sourceStamp, f.sourceStamp, 'a new coherent observation remains valid');
});

test('staging collision never overwrites an existing media file', t => {
  const f = fixture(t), directory = f.stage(); mkdirSync(path.join(directory, 'media'));
  const existing = path.join(directory, 'media', 'scene.png'); writeFileSync(existing, 'keep');
  assert.throws(() => f.catalog().prepareAssets('starter', 1, {directory, targetDirectory: path.join(f.root, 'final')}), {code: 'EEXIST'});
  assert.equal(readFileSync(existing, 'utf8'), 'keep'); assert.deepEqual(readdirSync(path.join(directory, 'media')), ['scene.png']);
});

test('only whitelist files are materialized; private records, trust and unrelated media stay in the template', t => {
  const f = fixture(t), directory = f.stage();
  for (const name of ['AGENTS.md', 'history.db', '.secret', 'unlisted.png']) writeFileSync(path.join(f.directory, name), f.bytes);
  mkdirSync(path.join(f.directory, 'cache')); writeFileSync(path.join(f.directory, 'cache', 'cached.png'), f.bytes);
  const prepared = f.catalog().prepareAssets('starter', 1, {directory, targetDirectory: path.join(f.root, 'final')});
  assert.deepEqual(prepared.files, [path.join(directory, 'media', 'scene.png')]);
  assert.deepEqual(readdirSync(directory), ['media']); assert.deepEqual(readdirSync(path.join(directory, 'media')), ['scene.png']);
  for (const name of ['AGENTS.md', 'history.db', '.secret', 'unlisted.png']) assert.deepEqual(readFileSync(path.join(f.directory, name)), f.bytes);
  assert.deepEqual(readFileSync(path.join(f.directory, 'cache', 'cached.png')), f.bytes);
});

test('large copied material uses the existing five-range fingerprint while checking its whole-file manifest hash', t => {
  const f = fixture(t), directory = f.stage(), bytes = Buffer.alloc(1_200_000);
  f.bytes.copy(bytes); for (let index = f.bytes.length; index < bytes.length; index++) bytes[index] = index % 251;
  writeFileSync(f.media, bytes); f.manifest.assets[0].sizeBytes = bytes.length; f.manifest.assets[0].sha256 = hash(bytes);
  const expectedSamples = createHash('sha256');
  for (const range of sampleRanges(bytes.length)) expectedSamples.update(bytes.subarray(range.start, range.start + range.length));
  const prepared = f.catalog().prepareAssets('starter', 1, {directory, targetDirectory: path.join(f.root, 'final')});
  const reference = prepared.referenceTargets.get(f.media); assert.ok(reference);
  assert.equal(reference.sizeBytes, bytes.length); assert.equal(reference.fullSha256, hash(bytes));
  assert.equal(reference.sampledSha256, expectedSamples.digest('hex')); assert.notEqual(reference.sampledSha256, reference.fullSha256);
  assert.deepEqual(readFileSync(prepared.files[0]), bytes); assert.notEqual(lstatSync(prepared.files[0]).ino, lstatSync(f.media).ino);
});

test('owner abort during template copy removes only this preparation and leaves no final directory', t => {
  const f = fixture(t), directory = f.stage(), failed = Error('owner stopped'); let checks = 0;
  assert.throws(() => f.catalog().prepareAssets('starter', 1, {directory, targetDirectory: path.join(f.root, 'final'),
    assertMutationAllowed() {if (++checks >= 2) throw failed;}}), error => error === failed);
  assert.deepEqual(readdirSync(directory), []); assert.equal(existsSync(path.join(f.root, 'final')), false);
  assert.deepEqual(readFileSync(f.media), f.bytes);
});

for (const issue of ['unlisted', 'stale-fingerprint'] as const)
  test(`copy builder rejects ${issue} template reference and publishes no project`, async t => {
    const f = fixture(t), stage = f.stage(), prepared = f.catalog().prepareAssets('starter', 1, {directory: stage, targetDirectory: path.join(f.root, 'final')});
    const mapping = new Map(prepared.referenceTargets);
    if (issue === 'unlisted') mapping.clear();
    else mapping.set(f.media, {...mapping.get(f.media)!, sampledSha256: 'f'.repeat(64)});
    const captured = await captureClosedProjectSnapshot({projectFile: f.projectFile, historyFile: () => path.join(f.root, 'no-history'), directory: path.join(f.root, 'snapshot')});
    const reader = openProjectBackup(captured.projectFile), projectFile = path.join(stage, 'instance.mioon');
    try {await assert.rejects(copyProjectToNewFile(reader, {projectFile, sourceProjectDir: f.directory, referenceTargets: mapping, publish: publishProjectCopyFile}), code('PROJECT_TEMPLATE_INVALID', 'asset-reference'));}
    finally {reader.close();}
    assert.equal(existsSync(projectFile), false); assert.deepEqual(readFileSync(f.media), f.bytes);
  });
