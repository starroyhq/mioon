import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createProjectBackup, copyProjectBackup, inspectProjectFormatReadOnly, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {openProjectStore as openStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {previewFormat5Upgrade, previewSequenceFormatUpgrade, upgradeProjectFormatTo5, upgradeProjectSequenceFormat} from '../packages/business/src/project-file/format5-upgrade.ts';
import {createFormat4UpgradeBackup, readFormat4BackupManifest, verifyFormat4Backup} from '../packages/business/src/project-file/format4-backup.ts';
import {restoreFormat4Backup} from '../packages/business/src/project-file/format4-restore.ts';
import {copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import type {CopyProjectOptions} from '../packages/business/src/project-file/copy.ts';
import {inspectCopiedProjectFile} from '../packages/business/src/project-file/backup.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import {sequenceEditReceiptSchema} from '../packages/contracts/src/sequence-edit.ts';
import {sequencePreviewFailureResponseSchema, sequencePreviewResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {sequenceHistoryViewResponseSchema} from '../packages/contracts/src/sequence-editing.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {captureProjectDocumentInside, decodeSupportedProjectDocument} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {applyRestorePlanInside} from '../packages/business/src/project-versions/restore.ts';
import {collectProject} from '../packages/business/src/project-package/document.ts';
import {FORMAT5_SOURCE_RELEASES, format5KernelSnapshot, prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import type {Format5SourceRelease} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';

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

test('a PNG retained as a format 4 shot version splits at source frame zero after the native upgrade', () => {
  const f = released('v0.2.0');
  const legacy = openStore({projectFile: f.projectFile, locate: () => f.location, format4: {}});
  const {projectId} = legacy;
  const versionId = randomUUID(), jobId = randomUUID();
  try {
    const shot = (legacy.list('shots') as {id: string; title: string; createdAt: string}[])[0]!;
    const timeline = legacy.list('timelines')[0];
    assert.ok(isTimelineRecord(timeline, {projectId}));
    const original = timeline.clips[0]!;
    const asset = legacy.get('assets', original.assetId) as {id: string; mimeType: string; sha256: string};
    assert.equal(asset.mimeType, 'image/png');
    const snapshot = {projectId, shotId: shot.id, title: shot.title,
      referenceAssetIds: [], referenceAssets: [], referenceConnections: []};
    legacy.tx(() => {
      // A retained shot can own a still version even though today's generation
      // path produces video. Use the release fixture's real PNG and locator.
      legacy.put('jobs', {id: jobId, projectId, shotId: shot.id, requestId: randomUUID(), status: 'succeeded',
        versionId, assetId: asset.id, snapshot});
      legacy.put('versions', {id: versionId, projectId, shotId: shot.id, jobId, number: 1,
        assetId: asset.id, sha256: asset.sha256, snapshot, createdAt: shot.createdAt});
      legacy.put('shots', {...shot, duration: 3, selectedVersionId: versionId});
      legacy.put('timelines', {...timeline, durationFrames: 90, revision: timeline.revision + 1,
        clips: [{...original, startFrame: 0, durationFrames: 90, sourceInFrame: 0, shotId: shot.id, versionId, jobId}]});
    });
    assert.equal(createOwnedMediaGraphReader(legacy.db, projectId).version(versionId, shot.id, asset.id).id, versionId);
  } finally {legacy.close();}

  const preview = previewFor(f);
  assert.equal(preview.projectVersion, 4);
  const {store} = upgradeProjectFormatTo5({projectFile: f.projectFile, locate: () => f.location,
    approveUpgrade: value => value.contentToken === preview.contentToken});
  try {
    assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, FORMAT5_PROJECT_SCHEMA_VERSION);
    const read = () => readFormat5TimelineRecord(store.db, 'project')!;
    const before = read();
    const clip = before.clips.find(item => item.versionId === versionId);
    assert.ok(clip);
    assert.equal(clip.sequenceSource?.kind, 'shot');
    assert.equal(clip.trackId, before.mainTrack.trackId);
    assert.deepEqual([clip.startFrame, clip.durationFrames, clip.sourceInFrame], [0, 90, 0]);

    const edit = createFormat5SequenceEditService(store);
    const history = () => sequenceHistoryViewResponseSchema.parse(edit.history({projectId}));
    const cursor = history();
    const rightClipId = randomUUID();
    const draft = sequencePreviewResponseSchema.parse(edit.preview({projectId, requestId: randomUUID(),
      intents: [sequenceSyncIntent({kind: 'clip-split', clipId: clip.id, offsetFrames: 45, rightClipId})]}));
    assert.deepEqual(read(), before);
    assert.deepEqual(history(), cursor);

    const input = {projectId, envelope: draft.envelope, expectedPlanDigest: draft.planDigest};
    const receipt = sequenceEditReceiptSchema.parse(edit.commit(input));
    assert.equal(receipt.status, 'applied');
    const afterSplit = read();
    const pieces = afterSplit.clips.filter(item => item.versionId === versionId);
    assert.deepEqual(pieces.map(item => [item.id, item.startFrame, item.durationFrames, item.sourceInFrame]),
      [[clip.id, 0, 45, 0], [rightClipId, 45, 45, 0]]);
    assert.ok(pieces.every(item => item.assetId === clip.assetId && item.trackId === clip.trackId &&
      item.jobId === jobId && item.sequenceSource?.kind === 'shot' &&
      item.sequenceSource.segmentGroupId === clip.sequenceSource?.segmentGroupId));
    const applied = history();
    assert.equal(applied.position, cursor.position + 1);
    const travel = (direction: 'undo' | 'redo') => {
      const {position, revision} = history();
      const ack = sequenceEditReceiptSchema.parse(edit[direction]({projectId, requestId: randomUUID(),
        actionId: receipt.actionId, expected: {position, revision}}));
      assert.equal(ack.status, 'applied');
    };
    travel('undo');
    assert.deepEqual(read().clips, before.clips);
    const undone = history();
    assert.equal(undone.position, cursor.position);
    assert.deepEqual(edit.commit(input), receipt);
    assert.deepEqual(read().clips, before.clips);
    assert.deepEqual(history(), undone);
    travel('redo');
    assert.deepEqual(read().clips, afterSplit.clips);
    assert.equal(history().position, applied.position);

    const afterRedo = read(), afterRedoHistory = history();
    const nonzeroTrim = sequencePreviewFailureResponseSchema.parse(edit.preview({projectId, requestId: randomUUID(),
      intents: [sequenceSyncIntent({kind: 'clip-trim', clipId: clip.id, durationFrames: 44, sourceInFrame: 1})]}));
    assert.equal(nonzeroTrim.code, 'SOURCE_BOUNDS');
    assert.deepEqual(read(), afterRedo);
    assert.deepEqual(history(), afterRedoHistory);

    const paste = sequencePreviewResponseSchema.parse(edit.preview({projectId, requestId: randomUUID(),
      intents: [sequenceSyncIntent({kind: 'paste-clip', clipId: rightClipId, startFrame: 90})]}));
    const pastedReceipt = sequenceEditReceiptSchema.parse(edit.commit({projectId, envelope: paste.envelope,
      expectedPlanDigest: paste.planDigest}));
    assert.equal(pastedReceipt.status, 'applied');
    const afterPaste = read();
    const pasted = afterPaste.clips.find(item => item.startFrame === 90);
    assert.ok(pasted?.sequenceSource?.kind === 'shot');
    assert.notEqual(pasted.sequenceSource.nodeId, clip.sequenceSource?.nodeId);
    assert.deepEqual([pasted.trackId, pasted.assetId, pasted.versionId, pasted.jobId, pasted.durationFrames, pasted.sourceInFrame],
      [clip.trackId, clip.assetId, versionId, jobId, 45, 0]);
    assert.deepEqual(afterPaste.clips.filter(item => item.id !== pasted.id), afterRedo.clips);
    assert.equal(store.db.prepare('SELECT versionId FROM project.shot_version_adoptions WHERE shotId=?')
      .get(pasted.sequenceSource.nodeId)?.versionId, versionId);
  } finally {store.close();}
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

test('format 6 uses the exact format 5 schema, preserves every timeline byte, and refuses a modified format 5', () => {
  const f = released('v0.2.0'), options = {projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true};
  const {store: legacy} = upgradeProjectFormatTo5(options);
  const initial = format5KernelSnapshot(legacy);
  const previous = legacy.tx(() => captureProjectDocumentInside(legacy));
  legacy.close();
  const preview = previewSequenceFormatUpgrade(FORMAT6_PROJECT_SCHEMA_VERSION, f.projectFile, undefined, f.historyFile)!;
  assert.equal(preview.projectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  assert.equal(preview.targetProjectVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  assert.equal(preview.historyVersion, FORMAT5_HISTORY_SCHEMA_VERSION);
  assert.equal(preview.targetHistoryVersion, preview.historyVersion);
  assert.throws(() => upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION, {...options, approveUpgrade: () => false}),
    {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
  for (const fault of ['before-backup', 'before-version-write', 'after-version-write', 'before-commit'] as const) {
    const failure = Object.assign(new Error('Synthetic storage failure'), {code: 'SQLITE_IOERR'});
    assert.throws(() => upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION, {...options,
      onUpgradeBoundary: phase => {if (phase === fault) throw failure;}}), error => error === failure);
    assert.equal(inspectProjectFormatReadOnly(f.projectFile).formatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  }
  const unknown = path.join(f.root, 'unknown-format5.mioon');
  cpSync(f.projectFile, unknown);
  const changedSchema = new DatabaseSync(unknown);
  try {changedSchema.exec('CREATE TABLE unknown_field(id INTEGER PRIMARY KEY)');} finally {changedSchema.close();}
  assert.throws(() => previewSequenceFormatUpgrade(FORMAT6_PROJECT_SCHEMA_VERSION, unknown), {code: 'PROJECT_INVALID'});
  const {store, backupId} = upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION, options);
  try {
    const after = format5KernelSnapshot(store);
    assert.deepEqual(after, {...initial, versions: {...initial.versions, project: FORMAT6_PROJECT_SCHEMA_VERSION}});
    assert.deepEqual(decodeSupportedProjectDocument(previous, FORMAT6_PROJECT_SCHEMA_VERSION).tables, previous.tables);
    assert.ok(backupId);
    const backupRoot = path.join(f.location.localDir, 'format-upgrade-backups');
    const manifest = readFormat4BackupManifest(backupRoot, backupId);
    assert.equal(manifest.projectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    assert.equal(manifest.historyVersion, FORMAT5_HISTORY_SCHEMA_VERSION);
    verifyFormat4Backup(path.join(backupRoot, backupId), manifest);
  } finally {store.close();}
  assert.throws(() => openProjectStore({projectFile: f.projectFile,
    locate: () => assert.fail('a newer format must fail before local records are used')}), {
    code: 'PROJECT_FORMAT_NEWER', details: {database: 'project', reason: 'format-newer',
      formatVersion: FORMAT6_PROJECT_SCHEMA_VERSION, supportedFormatVersion: FORMAT5_PROJECT_SCHEMA_VERSION},
  });
  if (process.platform !== 'win32') {
    const current = inspectProjectFormatReadOnly(f.projectFile, {allowFormat6: true});
    const restored = restoreFormat4Backup({projectFile: f.projectFile, location: f.location, projectId: current.projectId,
      allowFormat6: true, backupId: backupId!, expected: current});
    assert.equal(restored.projectVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
    const oldStore = openProjectStore({projectFile: f.projectFile, locate: () => f.location});
    try { assert.deepEqual(format5KernelSnapshot(oldStore), initial); } finally { oldStore.close(); }
  }
});

test('the released project formats each upgrade through format 5 with one atomic format-6 confirmation and backup', () => {
  for (const release of releases) {
    const f = released(release), phases: number[] = [];
    const {store, backupId} = upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION, {
      projectFile: f.projectFile, locate: () => f.location, approveUpgrade: preview => {
        assert.equal(preview.projectVersion, sourceVersions.get(release));
        assert.equal(preview.targetProjectVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
        return true;
      }, onUpgradeBoundary: (phase, observed) => {
        if (phase === 'after-version-write') phases.push(observed.projectVersion);
      },
    });
    try {
      assert.deepEqual(phases, [FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION]);
      const timeline = readFormat5TimelineRecord(store.db, 'project')!;
      assert.ok(timeline.clips.length);
      assert.ok(timeline.clips.every(clip => !Object.hasOwn(clip, 'timing')));
    } finally {store.close();}
    assert.deepEqual(readdirSync(path.join(f.location.localDir, 'format-upgrade-backups')), [backupId]);
  }
});

test('named versions, native backups, and project copies preserve format-6 timing', async () => {
  const f = released('v0.2.0');
  const {store} = upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION,
    {projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true});
  try {
    const timeline = readFormat5TimelineRecord(store.db, 'project')!;
    const clip = timeline.clips.find(value => value.sequenceSource?.kind === 'media' && value.sourceState === 'ready')!;
    assert.ok(clip);
    const asset = store.get('assets', clip.assetId!) as {id: string; sha256: string; sizeBytes: number; reference: MediaReference};
    assert.ok(clip.sequenceSource?.kind === 'media');
    const node = store.get('nodes', clip.sequenceSource.nodeId) as {id: string};
    const timing = {profile: 'timeline-freeze-v1' as const, sourceFrame: clip.sourceInFrame,
      sourceVersionId: null, sourceSha256: asset.sha256};
    // The lifecycle test uses synthetic ready video metadata; it never decodes media.
    const timedTimeline: Format5Timeline = {...timeline, clips: timeline.clips.map(value =>
      value.id === clip.id ? {...value, muted: true, sourceSpanFrames: 1, timing} : value)};
    store.tx(() => {
      store.put('assets', {...asset, mimeType: 'video/mp4', duration: 4, sha256: null,
        reference: {...asset.reference, fullSha256: null}, publication: {
          version: 1, publicationId: randomUUID(), projectId: store.projectId, assetId: asset.id,
          owner: {kind: 'import', id: randomUUID(), requestId: randomUUID(), inputHash: asset.sha256},
          targetKind: 'assets', relativePath: '素材/sample.mp4', sha256: asset.sha256,
          sizeBytes: asset.sizeBytes, mimeType: 'video/mp4',
        }});
      store.put('nodes', {...node, type: 'video'});
      store.put('timelines', timedTimeline);
    });
    const saved = store.tx(() => captureProjectDocumentInside(store));
    store.put('timelines', {...timedTimeline, clips: timedTimeline.clips.map(value =>
      value.id === clip.id ? {...value, name: 'Temporarily renamed'} : value)});
    store.tx(() => {
      const current = captureProjectDocumentInside(store);
      const boundary = Number(store.db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()!.n);
      const plan = buildRestorePlan(store, saved, current, boundary, new Date().toISOString());
      applyRestorePlanInside(store, plan, {requestId: randomUUID(), now: new Date().toISOString()});
    });
    assert.deepEqual(readFormat5TimelineRecord(store.db, 'project')!.clips.find(value => value.id === clip.id), timedTimeline.clips.find(value => value.id === clip.id));
    const backupFile = path.join(f.root, 'timed-backup.mioon');
    assert.equal((await createProjectBackup(store, backupFile)).formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
    for (const role of ['copy', 'restore']) {
      const projectFile = path.join(f.root, role + '.mioon');
      const request: CopyProjectOptions = {projectFile, sourceProjectDir: f.root, targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION};
      const result = role === 'copy' ? await copyProjectToNewFile(store, request) : await copyProjectBackup({...request, backupFile});
      assert.equal(result.formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
      const target = openProjectStore({projectFile, allowFormat6: true, locate: () => ({
        localDir: path.join(f.root, role + '-records'), cacheDir: path.join(f.root, role + '-cache'), tempDir: path.join(f.root, role + '-temp'),
      })});
      try {
        assert.notEqual(target.projectId, store.projectId);
        assert.deepEqual(readFormat5TimelineRecord(target.db, 'project')!.clips.find(value => value.id === clip.id)?.timing, timing);
      } finally {target.close();}
    }
  } finally {store.close();}
});
