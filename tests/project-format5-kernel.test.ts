import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {inspectProjectFormatReadOnly} from '../packages/business/src/project-file/connection.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {prepareFormat5Conversion, applyFormat5ConversionInside, readFormat5ConversionInput} from '../packages/business/src/project-file/format5-conversion-store.ts';
import {CACHE_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {classifyHistoryStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {timelineOutputPreset} from '../packages/contracts/src/timeline-output-geometry.ts';
import {format5TimelineHeader} from '../packages/contracts/src/project-format5.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';

/** The format-5 storage shape keeps the header in `timelines.data` and each
 * clip/cue as an exact native row. Assertions compare both projections so the
 * byte-level row contract stays visible. */
function convertStoredTimeline(store: ProjectStore, timeline: Format5Timeline) {
  const header = store.db.prepare('SELECT data FROM project.timelines').get();
  assert.equal(header!.data, JSON.stringify(format5TimelineHeader(timeline)));
  const expectedClips = timeline.clips.map(clip => ({id: clip.id, data: JSON.stringify(clip)})).sort((a, b) => a.id.localeCompare(b.id));
  const expectedCues = (timeline.subtitles?.cues ?? []).map(cue => ({id: cue.id, data: JSON.stringify(cue)})).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(store.db.prepare('SELECT id,data FROM project.timeline_clips ORDER BY id').all().map(row => ({...row})), expectedClips);
  assert.deepEqual(store.db.prepare('SELECT id,data FROM project.timeline_cues ORDER BY id').all().map(row => ({...row})), expectedCues);
}
import type {Format5LegacyTimeline} from '../packages/business/src/project-file/format5-conversion.ts';
import {assertOldReleaseRejectsNewer, releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {FORMAT5_SOURCE_RELEASES, format5ConversionAllocation, format5KernelSnapshot, prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import type {Format5SourceRelease} from './helpers/format5-release-fixture.ts';
import {testEnv} from './helpers/test-env.ts';
import {createServerProject} from './helpers/project-database.ts';
import {publishOutputFixture, markProjectOutputRegistered} from './helpers/project-output-fixture.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {INSPECTION_ROW_LIMITS} from '../packages/business/src/inspection-query.ts';
import {readFormat5JsonRows} from '../packages/business/src/project-file/format5-content.ts';

const releases = Object.keys(FORMAT5_SOURCE_RELEASES) as Format5SourceRelease[];
type Sample = ReturnType<typeof prepareFormat5Release>;
const samples = new Map<Format5SourceRelease, Sample>();
const worker = fileURLToPath(new URL('./fixtures/format5-kernel-crash-worker.ts', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));
let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-kernel-'));
  for (const release of releases) samples.set(release, prepareFormat5Release(scratch, release));
});
after(() => {if (scratch) rmSync(scratch, {recursive: true, force: true});});

const hashFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fixture(release: Format5SourceRelease, label: string) {
  const source = samples.get(release)!, root = path.join(scratch, `${release}-${label}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const open = () => openProjectStore({projectFile: paths.projectFile, locate: () => paths.location,
    ...(source.evidence.formats.project === FORMAT4_PROJECT_SCHEMA_VERSION ? {format4: {}} : {})});
  return {...source, ...paths, root, open};
}
function headerVersions(store: ProjectStore) {
  return {project: store.db.prepare('PRAGMA project.user_version').get()!.user_version,
    history: store.db.prepare('SELECT version FROM main.schema_version').get()!.version,
    cache: store.db.prepare('SELECT version FROM cache.schema_version').get()!.version};
}
const expected = {project: FORMAT5_PROJECT_SCHEMA_VERSION, history: FORMAT5_HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION};
function parsed<T>(value: T): T {return JSON.parse(JSON.stringify(value)) as T;}

test('active edge archive filtering preserves the old SQL projection before JSON identity and size checks', () => {
  const db = new DatabaseSync(':memory:'), projectId = randomUUID(), otherProjectId = randomUUID();
  const archivedShot = randomUUID(), archivedNode = randomUUID(), foreignNode = randomUUID(), liveNode = randomUUID();
  const hiddenShotEdge = randomUUID(), hiddenNodeEdge = randomUUID(), liveEdge = randomUUID(), foreignEdge = randomUUID();
  const at = '2026-01-01T00:00:00.000Z';
  const previous = `SELECT id,data FROM main.edges WHERE archivedAt IS NULL
    AND NOT EXISTS(SELECT 1 FROM main.shots s WHERE s.projectId=edges.projectId AND s.archivedAt IS NOT NULL AND s.id IN (json_extract(edges.data,'$.source'),json_extract(edges.data,'$.target')))
    AND NOT EXISTS(SELECT 1 FROM main.nodes n WHERE n.projectId=edges.projectId AND n.archivedAt IS NOT NULL AND n.id IN (json_extract(edges.data,'$.source'),json_extract(edges.data,'$.target')))
    ORDER BY id`;
  try {
    for (const table of ['shots', 'nodes', 'edges']) db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL,archivedAt TEXT)`);
    // Only native archive identities participate; their retained JSON is not parsed.
    db.prepare('INSERT INTO shots VALUES(?,?,?,?)').run(archivedShot, projectId, '{invalid retained JSON', at);
    db.prepare('INSERT INTO nodes VALUES(?,?,?,?)').run(archivedNode, projectId, '{invalid retained JSON', at);
    db.prepare('INSERT INTO nodes VALUES(?,?,?,?)').run(foreignNode, otherProjectId, '{invalid retained JSON', at);
    const insert = (id: string, source: string, target: string, extra: Record<string, unknown> = {}) => {
      db.prepare('INSERT INTO edges VALUES(?,?,?,NULL)').run(id, projectId, JSON.stringify({id, projectId, source, target, ...extra}));
    };
    insert(hiddenShotEdge, archivedShot, liveNode, {id: randomUUID(), projectId: otherProjectId});
    insert(hiddenNodeEdge, liveNode, archivedNode, {padding: 'x'.repeat(INSPECTION_ROW_LIMITS.edges + 1)});
    insert(liveEdge, liveNode, randomUUID());
    insert(foreignEdge, foreignNode, liveNode);
    db.prepare('INSERT INTO edges VALUES(?,?,?,?)').run(randomUUID(), projectId, '{invalid archived edge JSON', at);
    const projected = db.prepare(previous).all().map(row => row.id);
    assert.deepEqual(projected, [liveEdge, foreignEdge].sort());
    assert.deepEqual(readFormat5JsonRows(db, 'main', 'edges', true).map(row => row.id), projected);
    db.prepare('UPDATE shots SET archivedAt=NULL WHERE id=?').run(archivedShot);
    assert.ok(db.prepare(previous).all().some(row => row.id === hiddenShotEdge));
    assert.throws(() => readFormat5JsonRows(db, 'main', 'edges', true), {code: 'PROJECT_INVALID'},
      'making the hidden mismatched row live restores the existing identity rejection');
    db.prepare('UPDATE shots SET archivedAt=? WHERE id=?').run(at, archivedShot);
    const invalidEdge = randomUUID();
    db.prepare('INSERT INTO edges VALUES(?,?,?,NULL)').run(invalidEdge, projectId, '[]');
    assert.throws(() => readFormat5JsonRows(db, 'main', 'edges', true), {code: 'PROJECT_INVALID'});
    db.prepare('UPDATE edges SET data=? WHERE id=?').run('{malformed', invalidEdge);
    assert.throws(() => db.prepare(previous).all(), /malformed JSON/u);
    assert.throws(() => readFormat5JsonRows(db, 'main', 'edges', true), /malformed JSON/u);
  } finally {db.close();}
});

/** Source ownership uses the real byte publisher and immutable version rows.
 * These metadata-only MP4 fixtures exercise no decoder or remote provider. */
async function generatedVersions(store: ProjectStore, shotId: string) {
  const result: {id: string; assetId: string; jobId: string; sha256: string}[] = [];
  const stamp = '2026-01-03T00:00:00.000Z';
  for (const number of [1, 2]) {
    const current = store.get('shots', shotId); assert.ok(object(current));
    const jobId = randomUUID(), versionId = randomUUID(), assetId = randomUUID(), requestId = randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify({projectId: store.projectId, shotId, number})).digest('hex');
    const publication = await publishOutputFixture(store, {assetId, owner: {kind: 'generation', id: jobId, requestId, inputHash: requestHash},
      bytes: mp4HeaderFixture(`Format-5 source version ${number}; metadata only`), mimeType: 'video/mp4'});
    const snapshot = {shotId, shotRevision: current.revision, title: current.title, prompt: current.prompt,
      referenceAssetIds: [], referenceAssets: [], referenceConnections: [], aspectRatio: '9:16', duration: 4,
      providerId: 'mock', model: 'mock-v1', parameters: {}, capabilities: {}};
    store.tx(() => {
      store.put('jobs', {id: jobId, projectId: store.projectId, shotId, requestId, requestHash, providerId: 'mock', model: 'mock-v1',
        revision: 3, status: 'succeeded', phase: 'complete', progress: 100, snapshot, providerJobId: null, submissionCount: 1,
        error: null, createdAt: stamp, updatedAt: stamp, versionId, assetId, cancelScope: null, retryOfJobId: null});
      store.put('assets', {id: assetId, projectId: store.projectId, name: `Generated version ${number}`, mimeType: 'video/mp4',
        ...publication, width: 1080, height: 1920, duration: 10, hasVideo: true, hasAudio: false,
        producer: {kind: 'generation', id: jobId}, provenance: 'synthetic-mock', url: `/media/${assetId}`, createdAt: stamp});
      store.put('versions', {id: versionId, projectId: store.projectId, shotId, jobId, number, providerId: 'mock', model: 'mock-v1',
        isMock: true, snapshot, assetId, url: `/media/${assetId}`, sha256: publication.sha256, createdAt: stamp});
      store.put('shots', {...current, selectedVersionId: versionId, revision: Number(current.revision) + 1, updatedAt: stamp});
    });
    await markProjectOutputRegistered(store, publication.publication);
    createOwnedMediaGraphReader(store.db, store.projectId).version(versionId);
    result.push({id: versionId, assetId, jobId, sha256: publication.sha256});
  }
  const input = readFormat5ConversionInput(store), timeline = input.timeline!, first = result[0]!;
  store.put('timelines', {...timeline, revision: timeline.revision + 1, updatedAt: stamp,
    clips: [{...timeline.clips[0]!, assetId: first.assetId, shotId, versionId: first.id, jobId: first.jobId,
      name: 'Locked earlier generated version', startFrame: 0, sourceInFrame: 7, durationFrames: 60,
      gain: .6, fadeInFrames: 3, fadeOutFrames: 4}], durationFrames: 60});
  return result;
}

for (const release of releases) for (const withHistory of [true, false]) test(`published ${release} with local history=${withHistory} converts atomically and reopens with explicit format 5`, () => {
  const f = fixture(release, withHistory ? 'paired' : 'without-history');
  const pristineSource = hashFile(releaseProjectPaths(f.sample).projectFile), originalBackup = hashFile(f.backupFile);
  if (!withHistory) for (const directory of Object.values(f.location)) rmSync(directory, {recursive: true});
  const store = f.open();
  let after: ReturnType<typeof format5KernelSnapshot>;
  try {
    const before = format5KernelSnapshot(store), prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    assert.equal(prepared.sourceFormat, f.evidence.formats.project);
    assert.equal(hashFile(releaseProjectPaths(f.sample).projectFile), pristineSource);
    const seen: {phase: string; versions: ReturnType<typeof headerVersions>}[] = [];
    store.tx(() => applyFormat5ConversionInside(store, prepared, {onBoundary: phase => seen.push({phase, versions: headerVersions(store)})}));
    assert.deepEqual(headerVersions(store), expected);
    assert.deepEqual(seen.map(item => item.phase), ['after-content', 'after-structure', 'before-version-write', 'after-version-write']);
    for (const step of seen.slice(0, -1)) assert.deepEqual(step.versions, before.versions, 'the old pair remains the only published version until the terminal writes');
    assert.deepEqual(seen.at(-1)!.versions, expected);
    convertStoredTimeline(store, prepared.plan.timeline! as unknown as Format5Timeline);
    assert.equal(store.db.prepare('SELECT baseline FROM project.sequence_sync_state').get()!.baseline, JSON.stringify(prepared.plan.syncState!.baseline));
    assert.deepEqual(format5KernelSnapshot(store).receipts, before.receipts, 'old request acknowledgements and history bodies retain their exact bytes');
    assert.equal(classifyHistoryStamp(store.db, false).state, 'current');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.shot_version_adoptions').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM main.editor_history_entries').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT position FROM main.editor_history_state').get()!.position, 0);
    const originalAsset = before.project.find(item => item.table === 'assets')!.rows.find(item => item.id === f.evidence.clipInput.assetId)!;
    assert.equal(store.db.prepare('SELECT data FROM project.assets WHERE id=?').get(f.evidence.clipInput.assetId)!.data, originalAsset.data,
      'the source media record, including its SHA-256, retains its exact bytes');
    const main = prepared.plan.timeline!.clips.filter(clip => clip.trackId === prepared.plan.timeline!.mainTrack.trackId);
    assert.equal(main.find(clip => clip.id === f.evidence.timeline.clips[0]!.id)!.assetId, f.evidence.clipInput.assetId);
    assert.equal(main.filter(clip => clip.sourceState === 'placeholder').length, 1);
    assert.equal(prepared.plan.summary.compactedGapFrames, 6);
    after = format5KernelSnapshot(store);
  } finally {store.close();}
  assert.equal(inspectProjectFormatReadOnly(f.projectFile, {format5: true}).formatVersion, FORMAT5_PROJECT_SCHEMA_VERSION);
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile, {}), {code: 'PROJECT_FORMAT_NEWER'});
  assertOldReleaseRejectsNewer(f.source, f.projectFile, path.join(f.root, 'old-client.json'));
  const reopened = openProjectStore({projectFile: f.projectFile, locate: () => f.location, format5: true});
  try {
    assert.deepEqual(parsed(format5KernelSnapshot(reopened)), parsed(after!));
    const project = reopened.get('projects', reopened.projectId); assert.ok(object(project));
    reopened.put('projects', {...project, name: 'Writable after upgrade', revision: Number(project.revision) + 1});
    assert.equal(classifyHistoryStamp(reopened.db, false).state, 'current');
  } finally {reopened.close();}
  assert.equal(hashFile(f.backupFile), originalBackup);
  assert.equal(hashFile(releaseProjectPaths(f.sample).projectFile), pristineSource, 'release source bytes are isolated from every conversion');
});

for (const portable of [false, true]) test(`actual generated-version ownership proves locked and selected sources with portable=${portable}`, async () => {
  const f = fixture('v0.2.0', portable ? 'generated-portable-origin' : 'generated-local'), origin = f.open();
  let versions: Awaited<ReturnType<typeof generatedVersions>>;
  try {versions = await generatedVersions(origin, String(f.evidence.shot.id));} finally {origin.close();}
  const target = portable ? path.join(scratch, 'generated-portable-copy') : f.root;
  if (portable) {
    cpSync(f.root, target, {recursive: true, errorOnExist: true, force: false});
    for (const directory of Object.values(releaseProjectPaths(target).location)) rmSync(directory, {recursive: true});
  }
  const paths = releaseProjectPaths(target), store = openProjectStore({projectFile: paths.projectFile, locate: () => paths.location, format4: {}});
  const first = versions![0]!, selected = versions![1]!;
  try {
    const before = readFormat5ConversionInput(store);
    assert.deepEqual(before.provenVersions.map(version => version.versionId).sort(), versions!.map(version => version.id).sort());
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()!.n, portable ? 0 : 2);
    assert.equal(createOwnedMediaGraphReader(store.db, store.projectId).version(first.id).assetId, first.assetId);
    const earlierAsset = store.get('assets', first.assetId); assert.ok(object(earlierAsset) && object(earlierAsset.publication) && object(earlierAsset.publication.owner));
    store.put('assets', {...earlierAsset, publication: {...earlierAsset.publication, owner: {...earlierAsset.publication.owner, id: randomUUID()}}});
    const writes = store.db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.throws(() => prepareFormat5Conversion(store, format5ConversionAllocation()), {code: 'INSPECTION_UNAVAILABLE'});
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, writes, 'invalid publication cannot create conversion receipts or patches');
    store.put('assets', earlierAsset);
    const prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    assert.equal(prepared.plan.summary.lockedClips, 1);
    const clip = prepared.plan.timeline!.clips[0]!;
    assert.deepEqual([clip.assetId, clip.versionId, clip.jobId, clip.sourceInFrame, clip.durationFrames, clip.gain], [first.assetId, first.id, first.jobId, 7, 60, .6]);
    assert.deepEqual(clip.sequenceSource, {kind: 'shot', nodeId: f.evidence.shot.id,
      segmentGroupId: prepared.allocation.segmentGroupIds[0], versionMode: 'locked'});
    store.tx(() => applyFormat5ConversionInside(store, prepared));
    const shot = store.get('shots', String(f.evidence.shot.id)); assert.ok(object(shot));
    assert.equal(shot.selectedVersionId, selected.id);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()!.n, portable ? 0 : 2);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.versions').get()!.n, 2);
  } finally {store.close();}
  const reopened = openProjectStore({projectFile: paths.projectFile, locate: () => paths.location, format5: true});
  try {
    const stored = reopened.get('versions', first.id); assert.ok(object(stored)); assert.equal(stored.sha256, first.sha256);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM main.jobs').get()!.n, portable ? 0 : 2);
  } finally {reopened.close();}
});

test('a real generated source owned by an archived shot becomes fixed media without reviving its owner', async () => {
  const f = fixture('v0.2.0', 'generated-archived'), store = f.open();
  let archived: unknown;
  try {
    const versions = await generatedVersions(store, String(f.evidence.shot.id)), first = versions[0]!;
    store.tx(() => store.db.prepare("UPDATE project.shots SET archivedAt=?,archiveBatchId=?,archiveReason='user-delete' WHERE id=?")
      .run('2026-01-04T00:00:00.000Z', randomUUID(), String(f.evidence.shot.id)));
    archived = store.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id));
    const input = readFormat5ConversionInput(store);
    assert.deepEqual(input.provenVersions.map(version => version.versionId), [first.id]);
    const prepared = prepareFormat5Conversion(store, format5ConversionAllocation()), clip = prepared.plan.timeline!.clips[0]!;
    assert.equal(clip.sequenceSource!.kind, 'media');
    assert.deepEqual([clip.assetId, clip.versionId, clip.jobId, clip.sourceInFrame, clip.durationFrames], [first.assetId, first.id, first.jobId, 7, 60]);
    assert.equal(prepared.plan.summary.mediaCards, 1);
    store.tx(() => applyFormat5ConversionInside(store, prepared));
    assert.deepEqual(store.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id)), archived);
  } finally {store.close();}
  const reopened = openProjectStore({projectFile: f.projectFile, locate: () => f.location, format5: true});
  try {assert.deepEqual(reopened.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id)), archived);}
  finally {reopened.close();}
});

test('opt-in preserves a chosen empty geometry and a completely empty kernel can upgrade without invented content', () => {
  for (const hasProject of [false, true]) {
    const root = path.join(scratch, `empty-${hasProject}`); mkdirSync(root, {mode: 0o700});
    const paths = releaseProjectPaths(root), store = createProjectStore({projectFile: paths.projectFile, locate: () => paths.location, format4: {}});
    try {
      const preset = timelineOutputPreset('landscape_4_3_720')!;
      const value = newTimelineRecord(store.projectId, preset, () => '2026-01-01T00:00:00.000Z');
      const {subtitles: _subtitles, ...template} = value;
      const emptyTimeline: Format5LegacyTimeline = {...template, tracks: value.tracks.map(track => ({...track})), clips: []};
      if (hasProject) store.tx(() => {
        store.put('projects', {id: store.projectId, name: 'Empty geometry', revision: 1, createdAt: value.createdAt, updatedAt: value.updatedAt});
        store.put('nodes', {id: randomUUID(), projectId: store.projectId, type: 'video', assetId: null,
          label: 'Unassigned media card', text: '', position: {x: 0, y: 0}, revision: 1, createdAt: value.createdAt});
      });
      const prepared = prepareFormat5Conversion(store, format5ConversionAllocation(), hasProject ? {emptyTimeline} : {});
      store.tx(() => applyFormat5ConversionInside(store, prepared));
      assert.deepEqual(headerVersions(store), expected);
      if (hasProject) {
        assert.equal(prepared.plan.timeline!.width, preset.width); assert.equal(prepared.plan.timeline!.height, preset.height);
        assert.equal(prepared.plan.timeline!.clips.length, 0);
        assert.ok(prepared.plan.nodes.some(node => node.type === 'video' && node.assetId === null));
      } else {
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.nodes').get()!.n, 0);
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.timelines').get()!.n, 0);
      }
    } finally {store.close();}
  }
  const root = path.join(scratch, 'default-profile'); mkdirSync(root, {mode: 0o700});
  const paths = releaseProjectPaths(root), store = createProjectStore({projectFile: paths.projectFile, locate: () => paths.location});
  try {assert.equal(headerVersions(store).project, PROJECT_FILE_SCHEMA_VERSION);} finally {store.close();}
  const application = createServerProject(path.join(scratch, 'application-default'), {name: 'Application default'});
  try {assert.equal(headerVersions(application.store).project, FORMAT4_PROJECT_SCHEMA_VERSION);} finally {application.store.close();}
});

test('an archived shot and its hidden first-frame edge survive conversion and a fresh reopen', () => {
  const f = fixture('v0.2.0', 'archive'), store = f.open(), sourceNode = randomUUID(), referenceEdge = randomUUID(), batch = randomUUID();
  let archived: unknown;
  try {
    store.tx(() => {
      const shot = store.get('shots', String(f.evidence.shot.id)); assert.ok(object(shot));
      store.put('shots', {...shot, referenceAssetIds: [f.evidence.clipInput.assetId], revision: Number(shot.revision) + 1});
      store.put('nodes', {id: sourceNode, projectId: store.projectId, type: 'image', assetId: f.evidence.clipInput.assetId, label: 'First frame', text: '',
        position: {x: 0, y: 0}, revision: 1, createdAt: '2026-01-01T00:00:00.000Z'});
      store.put('edges', {id: referenceEdge, projectId: store.projectId, source: sourceNode, target: shot.id, kind: 'reference', role: 'first_frame',
        sourceAssetId: f.evidence.clipInput.assetId, createdAt: '2026-01-01T00:00:00.000Z'});
      store.db.prepare("UPDATE project.shots SET archivedAt=?,archiveBatchId=?,archiveReason='user-delete' WHERE id=?")
        .run('2026-01-02T00:00:00.000Z', batch, String(shot.id));
    });
    archived = store.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id));
    const prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    store.tx(() => applyFormat5ConversionInside(store, prepared));
    assert.deepEqual(store.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id)), archived);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.edges WHERE id=?').get(referenceEdge)!.n, 1);
    assert.equal(prepared.plan.timeline!.clips.some(clip => clip.sequenceSource?.kind === 'shot'), false);
  } finally {store.close();}
  const reopened = openProjectStore({projectFile: f.projectFile, locate: () => f.location, format5: true});
  try {assert.deepEqual(reopened.db.prepare('SELECT * FROM project.shots WHERE id=?').get(String(f.evidence.shot.id)), archived);}
  finally {reopened.close();}
});

test('a copied 0.2.0 bundled example converts through the kernel and stays writable with unchanged media hashes', () => {
  // This covers the copied destination. K5b owns the host's example-start bridge.
  const relative = 'examples/project-file-v1/timeline-basics', origin = path.join(scratch, 'bundled-example-source');
  mkdirSync(origin, {mode: 0o700});
  const archive = path.join(scratch, 'bundled-example.tar');
  execFileSync('git', ['-C', repository, 'archive', '--format=tar', '--output', archive, FORMAT5_SOURCE_RELEASES['v0.2.0'], '--', relative]);
  execFileSync('tar', ['-xf', archive, '-C', origin]); rmSync(archive);
  const source = path.join(origin, relative), destination = path.join(scratch, 'bundled-example-copy');
  const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8')) as {
    projectFile: {path: string; sizeBytes: number; sha256: string}; assets: {path: string; sizeBytes: number; sha256: string}[];
  };
  const resources = ['LICENSE', 'README.md', 'SOURCE.md', 'manifest.json', manifest.projectFile.path, ...manifest.assets.map(asset => asset.path)];
  const sourceHashes = resources.map(file => [file, hashFile(path.join(source, file))]);
  const repositoryProject = path.join(repository, relative, manifest.projectFile.path), repositoryManifest = path.join(repository, relative, 'manifest.json');
  const repositoryHashes = [hashFile(repositoryProject), hashFile(repositoryManifest)];
  assert.equal(hashFile(path.join(source, manifest.projectFile.path)), manifest.projectFile.sha256);
  for (const asset of manifest.assets) assert.equal(hashFile(path.join(source, asset.path)), asset.sha256);
  cpSync(source, destination, {recursive: true, errorOnExist: true, force: false});
  const projectFile = path.join(destination, manifest.projectFile.path), {location} = releaseProjectPaths(destination);
  const store = openProjectStore({projectFile, locate: () => location});
  let projectId: string, originalAssets: unknown;
  try {
    projectId = store.projectId;
    assert.equal(headerVersions(store).project, PROJECT_FILE_SCHEMA_VERSION);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()!.n, 0);
    originalAssets = store.db.prepare('SELECT id,data FROM project.assets ORDER BY id').all();
    const prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    store.tx(() => applyFormat5ConversionInside(store, prepared));
    assert.deepEqual(headerVersions(store), expected);
    assert.equal(prepared.plan.timeline!.clips.filter(clip => clip.trackId === prepared.plan.timeline!.mainTrack.trackId).length, 2);
  } finally {store.close();}
  const reopened = openProjectStore({projectFile, locate: () => location, format5: true});
  try {
    assert.equal(reopened.projectId, projectId!);
    const project = reopened.get('projects', reopened.projectId); assert.ok(object(project));
    reopened.put('projects', {...project, name: 'Writable converted example', revision: Number(project.revision) + 1});
    assert.equal(classifyHistoryStamp(reopened.db, false).state, 'current');
    const assets = reopened.db.prepare('SELECT id,data FROM project.assets ORDER BY id').all();
    assert.deepEqual(assets, originalAssets);
    assert.equal(assets.length, manifest.assets.length);
    for (const row of assets) {
      const asset = JSON.parse(String(row.data)) as {sha256: string; relativePath?: string; reference?: {pathForm: string; path: string}};
      const mediaPath = asset.reference?.pathForm === 'relative' ? asset.reference.path : asset.relativePath;
      assert.ok(mediaPath);
      const entry = manifest.assets.find(item => item.path === mediaPath); assert.ok(entry);
      assert.equal(asset.sha256, entry.sha256);
      assert.equal(hashFile(path.join(destination, mediaPath)), entry.sha256);
    }
  } finally {reopened.close();}
  assert.deepEqual(resources.map(file => [file, hashFile(path.join(source, file))]), sourceHashes, 'all original release resources retain their bytes');
  assert.equal(hashFile(path.join(destination, 'manifest.json')), hashFile(path.join(source, 'manifest.json')));
  assert.deepEqual([hashFile(repositoryProject), hashFile(repositoryManifest)], repositoryHashes);
});

test('stale content and an unexpected source schema refuse before conversion writes', () => {
  const f = fixture('v0.2.0', 'stale'), store = f.open();
  try {
    const prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    const project = store.get('projects', store.projectId); assert.ok(object(project));
    store.put('projects', {...project, name: 'Changed after preview', revision: Number(project.revision) + 1});
    const current = format5KernelSnapshot(store);
    assert.throws(() => store.tx(() => applyFormat5ConversionInside(store, prepared)), {code: 'FORMAT5_CONVERSION_STALE'});
    assert.deepEqual(format5KernelSnapshot(store), current);
    store.db.exec('CREATE TABLE project.unreviewed_format5_source(value TEXT)');
    const invalid = hashFile(f.projectFile);
    assert.throws(() => prepareFormat5Conversion(store, format5ConversionAllocation()), {code: 'FORMAT5_CONVERSION_INVALID'});
    assert.equal(hashFile(f.projectFile), invalid);
    assert.deepEqual(headerVersions(store), f.evidence.formats);
  } finally {store.close();}
});

test('each transactional injection restores the exact old pair, receipts and manifest', () => {
  const f = fixture('v0.2.0', 'rollback'), store = f.open();
  try {
    const before = format5KernelSnapshot(store), prepared = prepareFormat5Conversion(store, format5ConversionAllocation());
    for (const code of ['ENOSPC', 'SQLITE_IOERR']) for (const boundary of ['after-content', 'after-structure', 'before-version-write', 'after-version-write'] as const) {
      const failure = Object.assign(new Error('Synthetic storage failure'), {code});
      assert.throws(() => store.tx(() => applyFormat5ConversionInside(store, prepared, {onBoundary: phase => {if (phase === boundary) throw failure;}})), error => error === failure);
      assert.equal(store.db.isTransaction, false);
      assert.deepEqual(format5KernelSnapshot(store), before);
    }
  } finally {store.close();}
});

for (const release of ['v0.1.0', 'v0.2.0'] as const) for (const boundary of ['after-content', 'after-structure', 'before-version-write', 'after-version-write', 'after-commit'] as const)
  test(`SIGKILL ${release} at ${boundary} recovers one complete pair in a new process`, () => {
    const f = fixture(release, `kill-${boundary}`), store = f.open();
    let before: ReturnType<typeof format5KernelSnapshot>;
    try {before = format5KernelSnapshot(store);} finally {store.close();}
    const marker = path.join(f.root, 'boundary.json');
    const killed = spawnSync(process.execPath, [worker, 'convert', f.root, String(f.evidence.formats.project), boundary, marker],
      {env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000});
    assert.equal(killed.signal, 'SIGKILL', killed.stderr.replaceAll(repository, '<repo>/') || killed.error?.message);
    assert.equal(killed.status, null);
    const observed = JSON.parse(readFileSync(marker, 'utf8')) as {phase: string; observed: {project: number; history: number}; plan: {timeline: unknown}};
    assert.equal(observed.phase, boundary);
    assert.deepEqual(observed.observed, boundary === 'after-version-write' || boundary === 'after-commit'
      ? {project: expected.project, history: expected.history} : {project: f.evidence.formats.project, history: f.evidence.formats.history});
    const evidenceFile = path.join(f.root, 'recovered.json');
    const recovered = spawnSync(process.execPath, [worker, 'observe', f.root, String(f.evidence.formats.project), boundary, evidenceFile],
      {env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000});
    assert.equal(recovered.status, 0, recovered.stderr.replaceAll(repository, '<repo>/') || recovered.error?.message);
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as {snapshot: ReturnType<typeof format5KernelSnapshot>};
    if (boundary !== 'after-commit') assert.deepEqual(evidence.snapshot, parsed(before!));
    else {
      assert.deepEqual(evidence.snapshot.versions, expected);
      assert.deepEqual(evidence.snapshot.receipts, parsed(before!).receipts);
      const timelines = evidence.snapshot.project.find(item => item.table === 'timelines')!.rows;
      assert.equal(timelines.length, 1);
      const plan = observed.plan.timeline as {clips: {id: string}[]; subtitles?: {cues: {id: string}[]}};
      assert.deepEqual(JSON.parse(String(timelines[0]!.data)), format5TimelineHeader(plan as never));
      const clipRows = evidence.snapshot.project.find(item => item.table === 'timeline_clips')!.rows;
      const cueRows = evidence.snapshot.project.find(item => item.table === 'timeline_cues')!.rows;
      assert.deepEqual(clipRows.map(row => ({id: row.id, data: String(row.data)})).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        plan.clips.map(clip => ({id: clip.id, data: JSON.stringify(clip)})).sort((a, b) => a.id.localeCompare(b.id)));
      assert.deepEqual(cueRows.map(row => ({id: row.id, data: String(row.data)})).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        (plan.subtitles?.cues ?? []).map(cue => ({id: cue.id, data: JSON.stringify(cue)})).sort((a, b) => a.id.localeCompare(b.id)));
      assert.equal(evidence.snapshot.historyState.seenContentSequence, evidence.snapshot.content.contentSequence);
      assert.equal(evidence.snapshot.historyState.seenContentToken, evidence.snapshot.content.contentToken);
    }
  });
