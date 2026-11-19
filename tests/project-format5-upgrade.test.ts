import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectProjectFormatReadOnly, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {openProjectStore as openStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {previewFormat5Upgrade, upgradeProjectFormatTo5} from '../packages/business/src/project-file/format5-upgrade.ts';
import {createFormat4UpgradeBackup, readFormat4BackupManifest, verifyFormat4Backup} from '../packages/business/src/project-file/format4-backup.ts';
import {restoreFormat4Backup} from '../packages/business/src/project-file/format4-restore.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {applyRestorePlanInside} from '../packages/business/src/project-versions/restore.ts';
import {collectProject} from '../packages/business/src/project-package/document.ts';
import {FORMAT5_SOURCE_RELEASES, prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import type {Format5SourceRelease} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';

const releases = ['v0.1.1', 'v0.2.0'] as const;
const sourceVersions = new Map<Format5SourceRelease, 3 | 4>([['v0.1.1', 3], ['v0.2.0', 4]]);
let scratch: string;
before(() => {scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-upgrade-'));});
after(() => {rmSync(scratch, {recursive: true, force: true});});

let serial = 0;
function released(release: Format5SourceRelease) {
  const base = path.join(scratch, `prepare-${serial++}`);
  mkdirSync(base, {mode: 0o700});
  const source = prepareFormat5Release(base, release);
  const root = path.join(scratch, `${release}-${serial++}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  for (const directory of [root, ...Object.values(releaseProjectPaths(root).location)]) chmodSync(directory, 0o700);
  const paths = releaseProjectPaths(root);
  return {root, ...paths};
}

test('released format 3 and 4 projects confirm, back up once and convert to format 5 atomically', () => {
  for (const release of releases) {
    const f = released(release);
    const source = sourceVersions.get(release)!;
    const preview = previewFormat5Upgrade(f.projectFile, undefined, f.historyFile);
    assert.ok(preview);
    assert.equal(preview.projectVersion, source);
    assert.equal(preview.targetProjectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.equal(preview.targetHistoryVersion, FORMAT5_HISTORY_SCHEMA_VERSION);
    assert.equal(typeof preview.contentSequence, 'number');
    assert.match(preview.contentToken, /^[0-9a-f]{32}$/u);
    // Without the trusted confirmation nothing is written, including no backup.
    assert.throws(() => upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => false}),
      {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED', status: 409});
    assert.equal(inspectProjectFormatReadOnly(f.projectFile).formatVersion, source);
    const phases: string[] = [];
    const result = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location,
      approveUpgrade: value => value.contentToken === preview.contentToken && value.projectVersion === source,
      onUpgradeBoundary: phase => phases.push(phase)});
    try {
      assert.deepEqual(phases, ['before-backup', 'after-backup', 'before-conversion', 'after-content', 'after-structure',
        'before-version-write', 'after-version-write', 'before-commit', 'after-commit']);
      assert.ok(result.backupId);
      const backupDir = path.join(f.location.localDir, 'format-upgrade-backups', result.backupId);
      const manifest = readFormat4BackupManifest(path.join(f.location.localDir, 'format-upgrade-backups'), result.backupId);
      assert.equal(manifest.projectId, preview.projectId);
      assert.equal(manifest.projectVersion, source);
      assert.equal(manifest.historyPresent, true);
      verifyFormat4Backup(backupDir, manifest);
      assert.equal(result.store.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);
      assert.equal(result.store.db.prepare('SELECT version FROM main.schema_version').get()?.version, FORMAT5_HISTORY_SCHEMA_VERSION);
      // The converted project captures a named-version document with the new
      // native tables and stays writable inside the same kernel.
      let document: ReturnType<typeof captureProjectDocumentInside> | undefined;
      result.store.tx(() => {document = captureProjectDocumentInside(result.store);});
      assert.equal(document!.projectFormatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
      for (const table of ['shot_version_adoptions', 'sequence_sync_state', 'timeline_clips', 'timeline_cues'] as const) {
        assert.ok(Object.hasOwn(document!.tables, table), table);
      }
    } finally {result.store.close();}
    const reopened = openProjectStore({projectFile: f.projectFile, locate: () => f.location});
    try {assert.equal(reopened.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);}
    finally {reopened.close();}
    assert.deepEqual(readdirSync(path.join(f.location.localDir, 'format-upgrade-backups')), [result.backupId]);
  }
});

test('storage failures at every upgrade boundary leave the original pair untouched', () => {
  const injectable = ['before-backup', 'after-backup', 'before-conversion', 'after-content', 'after-structure',
    'before-version-write', 'after-version-write', 'before-commit'] as const;
  for (const code of ['ENOSPC', 'SQLITE_IOERR']) {
    const f = released('v0.2.0');
    for (const boundary of injectable) {
      const failure = Object.assign(new Error('Synthetic storage failure'), {code});
      assert.throws(() => upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location,
        approveUpgrade: () => true, onUpgradeBoundary: phase => {if (phase === boundary) throw failure;}}),
        error => error === failure, `${code} at ${boundary}`);
      // The source files, format header and content stamp are exactly the ones
      // the confirmation previewed; a new process opens the old format again.
      const identity = inspectProjectFormatReadOnly(f.projectFile);
      assert.equal(identity.formatVersion, 4);
      assert.equal(identity.contentSequence, previewFor(f).contentSequence);
      const store = openStore({projectFile: f.projectFile, locate: () => f.location, format4: {}});
      try {assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, 4);}
      finally {store.close();}
    }
  }
  // A kill after the commit leaves a complete format-5 pair; the caller can
  // reopen it without any recovery decision and the backup still verifies.
  const f = released('v0.2.0');
  const failure = Object.assign(new Error('Synthetic storage failure'), {code: 'SQLITE_IOERR'});
  assert.throws(() => upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location,
    approveUpgrade: () => true, onUpgradeBoundary: phase => {if (phase === 'after-commit') throw failure;}}), error => error === failure);
  const reopened = openProjectStore({projectFile: f.projectFile, locate: () => f.location});
  try {assert.equal(reopened.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);}
  finally {reopened.close();}
});
function previewFor(f: ReturnType<typeof released>) {return previewFormat5Upgrade(f.projectFile, undefined, f.historyFile)!;}

test('the original-format backup restores the pre-upgrade pair and the project can upgrade again', () => {
  const f = released('v0.2.0');
  const sourcePreview = previewFor(f);
  const result = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true});
  result.store.close();
  const backupRoot = path.join(f.location.localDir, 'format-upgrade-backups');
  const manifest = readFormat4BackupManifest(backupRoot, result.backupId!);
  const current = inspectProjectFormatReadOnly(f.projectFile);
  const restored = restoreFormat4Backup({projectFile: f.projectFile, location: f.location, projectId: current.projectId,
    backupId: result.backupId!, expected: current});
  assert.equal(restored.projectVersion, 4);
  assert.equal(restored.historyVersion, manifest.historyVersion);
  const legacy = inspectProjectFormatReadOnly(f.projectFile, {});
  assert.equal(legacy.formatVersion, 4);
  assert.equal(legacy.contentSequence, sourcePreview.contentSequence);
  assert.equal(legacy.contentToken, sourcePreview.contentToken);
  // The pair is exactly the one the backup describes and upgrades again.
  const again = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true});
  try {assert.equal(again.store.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);}
  finally {again.store.close();}
});

test('released 0.1.x and 0.2.0 projects upgrade with a confirmation, edit and undo, and leave an independently readable backup', () => {
  for (const release of releases) {
    const f = released(release), source = sourceVersions.get(release)!, preview = previewFor(f);
    assert.equal(preview.projectVersion, source);
    assert.equal(preview.targetProjectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.equal(preview.targetHistoryVersion, FORMAT5_HISTORY_SCHEMA_VERSION);
    assert.throws(() => upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location}),
      {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    const result = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location, approveUpgrade: value => {
      assert.deepEqual(value, preview); return true;
    }});
    try {
      assert.equal(Number(result.store.db.prepare('PRAGMA project.user_version').get()?.user_version), FORMAT5_PROJECT_SCHEMA_VERSION);
      const timeline = readFormat5TimelineRecord(result.store.db, 'project');
      assert.ok(timeline && timeline.clips.length > 0);
      const clip = timeline.clips.find(value => value.durationFrames > 2);
      assert.ok(clip);
      const edit = createFormat5SequenceEditService(result.store);
      const left = edit.preview({projectId: result.store.projectId, requestId: randomUUID(),
        intents: [sequenceSyncIntent({kind: 'clip-split', clipId: clip.id,
          offsetFrames: Math.floor(clip.durationFrames / 2), rightClipId: randomUUID()})]}) as {
            envelope: unknown; planDigest: string};
      const committed = edit.commit({projectId: result.store.projectId, envelope: left.envelope,
        expectedPlanDigest: left.planDigest}) as {status: string; actionId: string};
      assert.equal(committed.status, 'applied');
      const afterSplit = readFormat5TimelineRecord(result.store.db, 'project')!;
      assert.equal(afterSplit.clips.length, timeline.clips.length + 1);
      const history = edit.history({projectId: result.store.projectId}) as {position: number; revision: number};
      const undone = edit.undo({projectId: result.store.projectId, requestId: randomUUID(), actionId: committed.actionId,
        expected: {position: history.position, revision: history.revision}}) as {status: string};
      assert.equal(undone.status, 'applied');
      assert.equal(readFormat5TimelineRecord(result.store.db, 'project')!.clips.length, timeline.clips.length);
    } finally {result.store.close();}
    assert.ok(result.backupId);
    const backupRoot = path.join(f.location.localDir, 'format-upgrade-backups'), entries = readdirSync(backupRoot);
    assert.equal(entries.length, 1);
    const manifest = readFormat4BackupManifest(backupRoot, result.backupId!);
    assert.equal(manifest.projectVersion, source);
    verifyFormat4Backup(path.join(backupRoot, result.backupId!), manifest);
    // The original-format backup is a complete pair that still opens on its own.
    const standalone = path.join(scratch, `standalone-${release}-${serial++}.mioon`);
    assert.equal(inspectCopiedProjectFile(path.join(backupRoot, result.backupId!, 'project.mioon')).formatVersion, source);
    cpSync(path.join(backupRoot, result.backupId!, 'project.mioon'), standalone); chmodSync(standalone, 0o600);
    const store = openProjectStore({projectFile: standalone, locate: () => ({localDir: path.join(scratch, `standalone-${release}-local`),
      cacheDir: path.join(scratch, `standalone-${release}-cache`), tempDir: path.join(scratch, `standalone-${release}-tmp`)}),
      ...(source === 4 ? {format4: {}} : {})});
    try {assert.equal((store.get('projects', preview.projectId) as {id: string}).id, preview.projectId);}
    finally {store.close();}
  }
});

test('a format 5 project copies to a new file with its native rows and named versions restore clips', async () => {
  const f = released('v0.2.0');
  const {store} = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true});
  let documentBefore: ReturnType<typeof captureProjectDocumentInside> | undefined;
  try {
    // In-place named version: save a snapshot, rename the first clip, then
    // restore through the reviewed plan and compare the native rows.
    store.tx(() => {
      documentBefore = captureProjectDocumentInside(store);
      const timeline = (store.list('timelines') as {clips: {id: string; name: string}[]; tracks: {name: string}[]; subtitles?: unknown}[])[0]!;
      const clips = timeline.clips.map((clip, index) => index === 0 ? {...clip, name: 'Restored clip name'} : clip);
      store.put('timelines', {...timeline, clips});
    });
    store.tx(() => {
      const current = captureProjectDocumentInside(store);
      const boundary = Number(store.db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()!.n);
      const plan = buildRestorePlan(store, documentBefore!, current, boundary, new Date().toISOString());
      assert.ok(plan.changes.some(change => change.table === 'timeline_clips'));
      applyRestorePlanInside(store, plan, {requestId: randomUUID(), now: new Date().toISOString()});
    });
    const expected = (documentBefore!.tables.timeline_clips ?? []).map(row => JSON.parse(String(row.data))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const restored = (store.list('timelines') as {clips: unknown[]}[])[0]!.clips.map(clip => ({...clip as Record<string, unknown>})).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(restored, expected);
    // Same-format copy preserves the aggregate under a fresh project identity;
    // the copy gets its own local records directory so both can be open at once.
    const target = path.join(f.root, 'copied-project.mioon');
    const clipCount = store.db.prepare('SELECT count(*) n FROM project.timeline_clips').get()!.n;
    const header = store.db.prepare('SELECT data FROM project.timelines').get()?.data;
    const copy = await copyProjectToNewFile(store, {projectFile: target, sourceProjectDir: f.root,
      targetProjectDir: path.dirname(target), targetFormat: FORMAT5_PROJECT_SCHEMA_VERSION, projectId: randomUUID()});
    assert.equal(copy.formatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.notEqual(copy.projectId, store.projectId);
    const copiedLocation = {localDir: path.join(f.root, 'copied-records'), cacheDir: path.join(f.root, 'copied-cache'), tempDir: path.join(f.root, 'copied-temp')};
    const copied = openProjectStore({projectFile: target, locate: () => copiedLocation});
    try {
      assert.equal(copied.projectId, copy.projectId);
      assert.equal(copied.db.prepare('SELECT count(*) n FROM project.timeline_clips').get()!.n, clipCount);
      const copiedHeader = JSON.parse(String(copied.db.prepare('SELECT data FROM project.timelines').get()?.data)) as {projectId: string};
      const sourceHeader = JSON.parse(String(header)) as {projectId: string};
      assert.equal(copiedHeader.projectId, copy.projectId);
      assert.deepEqual({...copiedHeader, projectId: sourceHeader.projectId}, sourceHeader);
    } finally {copied.close();}
    // The portable package still refuses format 5 with the released error; the
    // format-1 document cannot express ordered edges, anchors or native rows.
    assert.throws(() => collectProject(store, store.projectId, {media: 'used', includeExports: false}),
      {code: 'PROJECT_PACKAGE_NEWER_FORMAT',
        details: {projectFormatVersion: FORMAT5_PROJECT_SCHEMA_VERSION, supportedProjectFormatVersion: PROJECT_FILE_SCHEMA_VERSION}});
  } finally {store.close();}
});

// Keeps the released fixture table honest in one place.
test('format 5 source releases pin real published commit identities', () => {
  assert.deepEqual(Object.keys(FORMAT5_SOURCE_RELEASES).sort(), ['v0.1.0', 'v0.1.1', 'v0.2.0']);
  for (const [release, sha] of Object.entries(FORMAT5_SOURCE_RELEASES)) assert.match(sha, /^[0-9a-f]{40}$/u, release);
});
