// Copied to the root of an isolated git archive before execution. Every
// producer and reader import then resolves to the pinned release's source.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ensureProjectRow} from './apps/server/src/project-host/project-initialization.ts';
import {createLocalMutationServices} from './packages/business/src/local-mutations.ts';
import {createTimelineServices} from './packages/business/src/timeline.ts';
import {createProjectBackup} from './packages/business/src/project-file/backup.ts';
import {inspectProjectFileReadOnly} from './packages/business/src/project-file/connection.ts';
import {createProjectStore, openProjectStore} from './packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from './packages/business/src/project-file/content-stamp.ts';
import {readSchemaManifest} from './packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from './packages/business/src/project-file/schema/manifest.ts';
import {canonicalJson} from './packages/business/src/project-versions/document.ts';
import {createProjectVersions} from './packages/business/src/project-versions/service.ts';
import {createReferenceServices} from './packages/business/src/references.ts';

const [mode, target, evidenceFile] = process.argv.slice(2);
const locate = root => () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')});
const sha = value => createHash('sha256').update(value).digest('hex');

if (mode === 'read-newer') {
  // This verifies the actual release code, not a copy of its version check.
  assert.throws(() => inspectProjectFileReadOnly(target), {code: 'PROJECT_FORMAT_NEWER'});
  let located = false;
  assert.throws(() => openProjectStore({projectFile: target, locate: () => {
    located = true;
    assert.fail('A newer file must be rejected before local records are located');
  }}), {code: 'PROJECT_FORMAT_NEWER'});
  assert.equal(located, false);
  writeFileSync(evidenceFile, JSON.stringify({readOnly: 'PROJECT_FORMAT_NEWER', writable: 'PROJECT_FORMAT_NEWER', located}));
} else if (mode === 'read-pair') {
  const projectFile = path.join(target, 'project.mioon');
  const identity = inspectProjectFileReadOnly(projectFile);
  const store = openProjectStore({projectFile, locate: locate(target)});
  try {
    assert.equal(store.historyState, 'current');
    assert.equal(store.projectId, identity.projectId);
    const versions = createProjectVersions(store).list({projectId: store.projectId});
    const receipts = store.db.prepare('SELECT operation,response FROM main.project_version_requests ORDER BY operation').all();
    writeFileSync(evidenceFile, JSON.stringify({projectId: store.projectId, stamp: readProjectContentStamp(store.db), versions, receipts}));
  } finally {store.close();}
} else if (mode === 'seed') {
  const root = target;
  mkdirSync(root, {mode: 0o700});
  const store = createProjectStore({projectFile: path.join(root, 'project.mioon'), locate: locate(root)});
  const {projectId} = store;
  const now = () => '2026-01-02T03:04:05.000Z';
  const check = (record, expected) => assert.equal(record.revision, expected);
  try {
    ensureProjectRow(store, {name: 'Format 4 release fixture', timelinePresetId: 'portrait_1080', now: () => new Date(now())});
    const references = createReferenceServices(store, {check, hash: value => sha(canonicalJson(value)), now});
    const local = createLocalMutationServices(store, {check, canonical: canonicalJson, now, references});
    const shotInput = {projectId, requestId: randomUUID(), title: 'Release shot', duration: 2};
    const shot = local.handlers['shot.create'](shotInput);
    const node = local.handlers['node.create']({projectId, requestId: randomUUID(), type: 'text', label: 'Release note'});
    const edge = store.put('edges', {id: randomUUID(), projectId, source: node.id, target: shot.id, kind: 'decor', createdAt: now()});

    // A synthetic PNG in a project-relative locator. No media tool, provider,
    // account or real workspace is involved in the release data fixture.
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAwsAAAAASUVORK5CYII=', 'base64');
    const assetId = randomUUID(), source = 'media/release-fixture.png', hash = sha(bytes);
    mkdirSync(path.join(root, 'media'));
    writeFileSync(path.join(root, source), bytes);
    store.put('assets', {id: assetId, projectId, name: 'Release fixture', mimeType: 'image/png', width: 1, height: 1,
      duration: null, sizeBytes: bytes.length, sha256: hash, referenceRevision: 1,
      reference: {pathForm: 'relative', path: source, volume: null, sizeBytes: bytes.length, mtimeMs: 0, sampledSha256: hash, fullSha256: hash}});
    const timeline = createTimelineServices(store, {
      required: (table, id) => assert.ok(store.get(table, id)), check, hash: value => sha(canonicalJson(value)), now,
      exportAdmission: {render: () => assert.fail('The fixture does not export')},
    }).handlers;
    const initial = timeline['timeline.get']({projectId});
    const clipInput = {projectId, requestId: randomUUID(), expectedRevision: initial.revision,
      trackId: initial.tracks[0].id, assetId, startFrame: 6, durationFrames: 30, rect: {x: 100, y: 120, width: 540, height: 640}};
    const clipAck = timeline['timeline.clip.add'](clipInput);

    const versions = createProjectVersions(store, {assertMutationAllowed() {}});
    const saveInput = {projectId, requestId: randomUUID(), name: 'Release checkpoint'};
    const saved = versions.save(saveInput);
    local.handlers['shot.update']({projectId, shotId: shot.id, requestId: randomUUID(), expectedRevision: shot.revision, patch: {title: 'Moved since checkpoint'}});
    const preview = versions.preview({projectId, versionId: saved.version.id});
    assert.ok(preview.totalChanges > 0);
    const restoreInput = {projectId, versionId: saved.version.id, requestId: randomUUID(), expectedContentSequence: preview.contentSequence,
      expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest};
    const restored = versions.restore(restoreInput);

    for (const [schema, name] of [['project', 'project'], ['main', 'history'], ['cache', 'cache']]) {
      assert.deepEqual(readSchemaManifest(store.db, schema), SCHEMA_MANIFEST[name].entries);
    }
    const formats = {
      project: store.db.prepare('PRAGMA project.user_version').get().user_version,
      history: store.db.prepare('SELECT version FROM main.schema_version').get().version,
      cache: store.db.prepare('SELECT version FROM cache.schema_version').get().version,
    };
    assert.deepEqual(formats, {project: 3, history: 10, cache: 2});
    const stamp = readProjectContentStamp(store.db);
    assert.deepEqual({...store.db.prepare('SELECT seenContentSequence,seenContentToken FROM main.history_state').get()},
      {seenContentSequence: stamp.contentSequence, seenContentToken: stamp.contentToken});
    const backup = await createProjectBackup(store, path.join(root, 'release-backup.mioon'));
    assert.equal(backup.formatVersion, formats.project);
    const evidence = {projectId, formats, stamp, shot, node, edge, shotInput, clipInput, clipAck, saveInput, saved, restoreInput, restored,
      timeline: timeline['timeline.get']({projectId}), versionList: versions.list({projectId})};
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    store.close();
  }
} else {
  throw new Error('Unknown release fixture mode');
}
