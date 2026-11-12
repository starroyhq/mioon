import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectClosedProjectForTrash} from '../packages/business/src/project-file/closed-copy.ts';
import {inspectProjectFormatReadOnly, isProjectFileHeld, recoverProjectFile} from '../packages/business/src/project-file/connection.ts';
import type {Format4Options, Format4UpgradeBoundary, Format4UpgradePreview} from '../packages/business/src/project-file/connection.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {CACHE_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {CANVAS_ARCHIVE_COLUMNS, CANVAS_ARCHIVE_TABLES} from '../packages/business/src/project-file/schema/domains/canvas.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {createTimelineRecoveryBoundary, readTimelineReceipt} from '../packages/business/src/timeline-recovery.ts';
import {assertOldReleaseRejectsNewer, FORMAT4_RELEASES, prepareFormat4Release, readOldReleasePair, releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import type {Format4Release} from './helpers/format4-release-fixture.ts';

const RELEASES = Object.keys(FORMAT4_RELEASES) as Format4Release[];
const CRASH_WORKER = fileURLToPath(new URL('./fixtures/format4-upgrade-crash-worker.ts', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const candidate = {project: FORMAT4_PROJECT_SCHEMA_VERSION, history: FORMAT4_HISTORY_SCHEMA_VERSION, cache: CACHE_SCHEMA_VERSION};
const stable = {project: 3, history: 10, cache: 2};
type Sample = ReturnType<typeof prepareFormat4Release>;
type Observed = Parameters<NonNullable<Format4Options['onUpgradeBoundary']>>[1];
const samples = new Map<Format4Release, Sample>();
let scratch: string;

before(() => {
  scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-format4-'));
  for (const release of RELEASES) samples.set(release, prepareFormat4Release(scratch, release));
});
after(() => {if (scratch) rmSync(scratch, {recursive: true, force: true});});

function fixture(release: Format4Release, label: string) {
  const source = samples.get(release)!;
  const root = path.join(scratch, `${release}-${label}`);
  cpSync(source.sample, root, {recursive: true, errorOnExist: true, force: false});
  const paths = releaseProjectPaths(root);
  for (const directory of [root, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const open = (format4?: Format4Options): ProjectStore => openProjectStore({
    projectFile: paths.projectFile, locate: () => paths.location, ...(format4 === undefined ? {} : {format4}),
  });
  return {...source, ...paths, root, open};
}

type Fixture = ReturnType<typeof fixture>;
const approve = {approveUpgrade: () => true};
const readVersion = (db: DatabaseSync, statement: string): unknown => Object.values(db.prepare(statement).get()!)[0];
const versions = (db: DatabaseSync) => ({
  project: readVersion(db, 'PRAGMA project.user_version'),
  history: readVersion(db, 'SELECT version FROM main.schema_version'),
  cache: readVersion(db, 'SELECT version FROM cache.schema_version'),
});
const files = (f: Fixture) => [f.projectFile, f.historyFile, f.cacheFile, f.backupFile].map(file => readFileSync(file));
const backupRoot = (f: Fixture) => path.join(f.location.localDir, 'format-upgrade-backups');
const archiveColumns = (db: DatabaseSync) => CANVAS_ARCHIVE_TABLES.map(table =>
  db.prepare(`PRAGMA project.table_info(${table})`).all().map(column => column.name));
const canvasTables = (db: DatabaseSync) => db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name LIKE 'canvas_%' ORDER BY name").all().map(row => row.name);
const expectedCanvasTables = ['canvas_history_entries', 'canvas_history_state', 'canvas_requests'];

function fileIdentity(file: string) {
  const info = lstatSync(file, {bigint: true});
  return {dev: String(info.dev), ino: String(info.ino)};
}

function removeLocalRecords(f: Fixture): void {
  for (const directory of Object.values(f.location)) rmSync(directory, {recursive: true});
}

function killUpgrade(f: Fixture, stopAt: Format4UpgradeBoundary): void {
  const marker = path.join(f.root, 'kill-boundary.json');
  const result = spawnSync(process.execPath, [CRASH_WORKER, f.root, stopAt, marker], {
    stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.signal, 'SIGKILL', result.stderr?.replaceAll(REPOSITORY, '<repo>/') || result.error?.message);
  assert.equal(result.status, null);
  const expected = stopAt === 'before-version-write' ? stable : candidate;
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {phase: stopAt, observed: {projectVersion: expected.project, historyVersion: expected.history}});
  const recovery = recoverProjectFile(f.projectFile);
  assert.ok(recovery.state === 'clean' || recovery.state === 'recovered', `Unexpected recovery ${JSON.stringify(recovery)}`);
}

function projectRows(db: DatabaseSync) {
  return ['projects', 'shots', 'nodes', 'edges', 'assets'].map(table => db.prepare(`SELECT id,data FROM project.${table} ORDER BY id`).all());
}

function historyRows(db: DatabaseSync) {
  return ['project_versions', 'project_version_blobs', 'project_version_requests', 'mutation_requests', 'timeline_requests', 'timeline_history']
    .map(table => db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all());
}

function assertUpgradeBackup(f: Fixture, historyPresent: boolean): string {
  const backups = readdirSync(backupRoot(f));
  assert.equal(backups.length, 1);
  const directory = path.join(backupRoot(f), backups[0]!);
  const names = historyPresent ? ['project.mioon', 'history.db'] : ['project.mioon'];
  assert.deepEqual(readdirSync(directory).sort(), [...names, 'manifest.json'].sort());
  const entries = names.map(name => {
    const contents = readFileSync(path.join(directory, name));
    return {name, sizeBytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex')};
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')), {
    version: 1, projectId: f.evidence.projectId, ...f.evidence.stamp, historyPresent,
    projectVersion: stable.project, historyVersion: historyPresent ? stable.history : null, files: entries,
  });
  return directory;
}

function pair(store: ProjectStore) {
  const {contentSequence, contentToken} = readProjectContentStamp(store.db);
  const row = store.db.prepare('SELECT seenContentSequence,seenContentToken FROM main.history_state').get()!;
  assert.equal(row.seenContentSequence, contentSequence);
  assert.equal(row.seenContentToken, contentToken);
  return {contentSequence, contentToken};
}

function state(f: Fixture) {
  const store = f.open();
  try {
    assert.deepEqual(versions(store.db), stable);
    assert.deepEqual(pair(store), f.evidence.stamp);
    assert.deepEqual(canvasTables(store.db), []);
    return {project: projectRows(store.db), history: historyRows(store.db), columns: archiveColumns(store.db),
      manifests: ['project', 'main', 'cache'].map(schema => readSchemaManifest(store.db, schema))};
  } finally {store.close();}
}

function assertCandidate(store: ProjectStore, f: Fixture, previous: ReturnType<typeof state>): void {
  assert.deepEqual(versions(store.db), candidate);
  assert.deepEqual(pair(store), f.evidence.stamp, 'structure-only upgrade preserves the exact content pair');
  assert.deepEqual(projectRows(store.db), previous.project);
  assert.deepEqual(historyRows(store.db), previous.history, 'all retained history and replay rows stay byte-exact');
  const columns = archiveColumns(store.db);
  for (const [index, list] of columns.entries()) {
    const old = previous.columns[index]!;
    assert.deepEqual(list.slice(0, old.length), old);
    assert.deepEqual(list.slice(old.length), [...CANVAS_ARCHIVE_COLUMNS]);
    const table = CANVAS_ARCHIVE_TABLES[index]!;
    const archived = store.db.prepare(`SELECT count(*) n FROM project.${table} WHERE ${CANVAS_ARCHIVE_COLUMNS.map(column => `${column} IS NOT NULL`).join(' OR ')}`).get()!;
    assert.equal(archived.n, 0);
  }
  assert.deepEqual(canvasTables(store.db), expectedCanvasTables);
  assert.deepEqual(readSchemaManifest(store.db, 'cache'), previous.manifests[2]);
  const versionApi = createProjectVersions(store, {assertMutationAllowed() {}});
  const e = f.evidence;
  assert.deepEqual(store.get('nodes', e.node.id), e.node);
  assert.deepEqual(store.get('edges', e.edge.id), e.edge);
  const shotReceipt = store.db.prepare('SELECT response FROM main.mutation_requests WHERE requestId=?').get(e.shotInput.requestId);
  assert.equal(shotReceipt?.response, JSON.stringify(e.shot));
  const timeline = createTimelineRecoveryBoundary(store.db, e.clipInput);
  const receipt = readTimelineReceipt(store.db, e.clipInput, 'timeline.clip.add');
  assert.equal(receipt?.response, JSON.stringify(e.clipAck));
  assert.deepEqual(timeline.replay('timeline.clip.add', receipt.response!), e.clipAck);
  assert.deepEqual(timeline.read(), e.timeline, 'v4 reads the released clip layout and project timeline');
  assert.deepEqual(versionApi.list({projectId: e.projectId}), e.versionList);
  assert.deepEqual(versionApi.save(e.saveInput), e.saved);
  assert.deepEqual(versionApi.restore(e.restoreInput), e.restored);
  assert.ok(versionApi.preview({projectId: e.projectId, versionId: e.saved.version.id}).version.id === e.saved.version.id,
    'the original snapshot can still be decoded and previewed');
  assert.deepEqual(pair(store), e.stamp, 'replayed acknowledgements do not write project content');
}

test('format 4 is opt-in for fresh kernel creation', () => {
  for (const [label, format4, expected] of [['default', undefined, stable], ['candidate', {}, candidate]] as const) {
    const root = path.join(scratch, label);
    mkdirSync(root, {mode: 0o700});
    const {projectFile, location} = releaseProjectPaths(root);
    const store = createProjectStore({projectFile, locate: () => location, ...(format4 === undefined ? {} : {format4})});
    try {assert.deepEqual(versions(store.db), expected);} finally {store.close();}
  }
});

for (const release of RELEASES) {
  test(`${release}: exact released pair requires consent, upgrades together, and reopens with original version receipts`, () => {
    const f = fixture(release, 'approved'), previous = state(f);
    const initial = files(f), previews: Format4UpgradePreview[] = [], boundaries: [Format4UpgradeBoundary, Observed][] = [];
    assert.deepEqual(inspectProjectFormatReadOnly(f.projectFile), {projectId: f.evidence.projectId, ...f.evidence.stamp, formatVersion: stable.project});
    assert.throws(() => f.open({}).close(), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    assert.throws(() => f.open({approveUpgrade: preview => {previews.push(preview); return false;}}).close(), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    assert.deepEqual(files(f), initial);
    assert.equal(existsSync(backupRoot(f)), false);

    const store = f.open({approveUpgrade: preview => {previews.push(preview); return true;}, onUpgradeBoundary: (phase, observed) => boundaries.push([phase, observed])});
    try {assertCandidate(store, f, previous);} finally {store.close();}
    const consent = {projectId: f.evidence.projectId, projectVersion: stable.project, historyVersion: stable.history, ...f.evidence.stamp};
    assert.deepEqual(previews, [consent, consent]);
    assert.deepEqual(boundaries, [
      ['before-version-write', {projectVersion: stable.project, historyVersion: stable.history}],
      ['before-commit', {projectVersion: candidate.project, historyVersion: candidate.history}],
      ['after-commit', {projectVersion: candidate.project, historyVersion: candidate.history}],
    ]);
    const backup = assertUpgradeBackup(f, true);
    assert.deepEqual(readFileSync(path.join(backup, 'project.mioon')), initial[0], 'backup preserves the original SQLite bytes');
    assert.deepEqual(readFileSync(path.join(backup, 'history.db')), initial[1], 'backup preserves history rowids and bytes');
    const backupRestoreRoot = path.join(f.root, 'verified-old-pair');
    mkdirSync(backupRestoreRoot, {mode: 0o700});
    const restoredPaths = releaseProjectPaths(backupRestoreRoot);
    mkdirSync(restoredPaths.location.localDir, {mode: 0o700});
    copyFileSync(path.join(backup, 'project.mioon'), restoredPaths.projectFile);
    copyFileSync(path.join(backup, 'history.db'), restoredPaths.historyFile);
    const e = f.evidence;
    assert.deepEqual(readOldReleasePair(f.source, backupRestoreRoot, path.join(f.root, 'backup-release-reader.json')), {
      projectId: e.projectId, stamp: e.stamp, versions: e.versionList,
      receipts: [{operation: 'project.version.restore', response: JSON.stringify(e.restored)},
        {operation: 'project.version.save', response: JSON.stringify(e.saved)}],
    });
    const reopened = f.open({approveUpgrade: () => assert.fail('A current file does not prompt again')});
    try {assertCandidate(reopened, f, previous);} finally {reopened.close();}
    assert.equal(assertUpgradeBackup(f, true), backup);
    assert.deepEqual(inspectProjectFormatReadOnly(f.projectFile), {projectId: f.evidence.projectId, ...f.evidence.stamp, formatVersion: candidate.project});

    const upgraded = files(f);
    for (const older of RELEASES) {
      assertOldReleaseRejectsNewer(samples.get(older)!.source, f.projectFile, path.join(f.root, `older-${older}.json`));
    }
    assert.deepEqual(files(f), upgraded);
  });

  test(`${release}: a refused backup destination leaves both released databases intact`, () => {
    const f = fixture(release, 'backup-destination');
    const initial = files(f);
    writeFileSync(backupRoot(f), 'Occupied upgrade backup destination', {flag: 'wx'});
    assert.throws(() => f.open(approve).close(), {code: 'PROJECT_FORMAT_BACKUP_FAILED'});
    assert.deepEqual(files(f), initial);
    assert.equal(readFileSync(backupRoot(f), 'utf8'), 'Occupied upgrade backup destination');
    const legacy = f.open();
    try {assert.deepEqual(versions(legacy.db), stable);} finally {legacy.close();}
  });

  test(`${release}: read-only inspection does not touch released bytes or create local records`, () => {
    const f = fixture(release, 'readonly');
    removeLocalRecords(f);
    const before = readFileSync(f.projectFile);
    assert.deepEqual(inspectProjectFormatReadOnly(f.projectFile), {projectId: f.evidence.projectId, ...f.evidence.stamp, formatVersion: stable.project});
    assert.deepEqual(readFileSync(f.projectFile), before);
    for (const directory of Object.values(f.location)) assert.equal(existsSync(directory), false);
  });

  test(`${release}: refusing a history-less upgrade creates no local directory or database`, () => {
    const f = fixture(release, 'declined-missing-records');
    removeLocalRecords(f);
    const before = readFileSync(f.projectFile), previews: Format4UpgradePreview[] = [];
    assert.throws(() => f.open({}).close(), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    assert.throws(() => f.open({approveUpgrade: preview => {previews.push(preview); return false;}}).close(), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    assert.deepEqual(previews, [{projectId: f.evidence.projectId, projectVersion: stable.project, historyVersion: null, ...f.evidence.stamp}]);
    assert.deepEqual(readFileSync(f.projectFile), before);
    for (const directory of Object.values(f.location)) assert.equal(existsSync(directory), false);
  });

  test(`${release}: approval rejects reentrant inspection while keeping both locked identities`, () => {
    const f = fixture(release, 'reentrant-approval'), previous = state(f), initial = files(f);
    const identities = [fileIdentity(f.projectFile), fileIdentity(f.historyFile)];
    let called = false;
    assert.throws(() => f.open({approveUpgrade: () => {
      called = true;
      assert.ok(identities.every(isProjectFileHeld));
      assert.throws(() => inspectProjectFormatReadOnly(f.projectFile), {code: 'PROJECT_LOCKED'});
      assert.ok(identities.every(isProjectFileHeld));
      return false;
    }}).close(), {code: 'PROJECT_FORMAT_UPGRADE_REQUIRED'});
    assert.equal(called, true);
    assert.equal(identities.some(isProjectFileHeld), false);
    assert.deepEqual(files(f), initial);
    assert.equal(inspectProjectFormatReadOnly(f.projectFile).formatVersion, stable.project);
    const reopened = f.open(approve);
    try {assertCandidate(reopened, f, previous);} finally {reopened.close();}
  });

  test(`${release}: no local history receives a fresh paired history without inventing old receipts`, () => {
    const f = fixture(release, 'missing-records');
    rmSync(f.location.localDir, {recursive: true});
    const store = f.open({approveUpgrade: preview => {
      assert.deepEqual(preview, {projectId: f.evidence.projectId, projectVersion: stable.project, historyVersion: null, ...f.evidence.stamp});
      return true;
    }});
    try {
      assert.deepEqual(versions(store.db), candidate);
      assert.deepEqual(pair(store), f.evidence.stamp);
      assert.deepEqual(canvasTables(store.db), expectedCanvasTables);
      assert.deepEqual(createProjectVersions(store).list({projectId: f.evidence.projectId}).versions, []);
    } finally {store.close();}
    assertUpgradeBackup(f, false);
  });

  test(`${release}: SIGKILL before committing a history-less upgrade leaves a readable v3/10 pair`, {skip: process.platform === 'win32'}, () => {
    const f = fixture(release, 'kill-missing-records');
    removeLocalRecords(f);
    const before = readFileSync(f.projectFile);
    killUpgrade(f, 'before-commit');
    assert.deepEqual(readFileSync(f.projectFile), before);
    const closed = inspectClosedProjectForTrash({projectFile: f.projectFile, historyFile: () => f.historyFile});
    const {contentSequence, contentToken} = f.evidence.stamp;
    assert.equal(closed.identity.formatVersion, stable.project);
    assert.deepEqual(closed.history, {formatVersion: stable.history, seenContentSequence: contentSequence,
      seenContentToken: contentToken, hasBlockingMio: false});
    assert.deepEqual(readOldReleasePair(f.source, f.root, path.join(f.root, 'crash-legacy-reader.json')), {
      projectId: f.evidence.projectId, stamp: f.evidence.stamp, versions: {projectId: f.evidence.projectId, versions: [], nextCursor: null}, receipts: [],
    });
    const store = f.open();
    try {
      assert.deepEqual(versions(store.db), stable);
      assert.deepEqual(pair(store), f.evidence.stamp);
      assert.ok(historyRows(store.db).every(rows => rows.length === 0));
      assert.deepEqual(canvasTables(store.db), []);
    } finally {store.close();}
    assertUpgradeBackup(f, false);
  });

  test(`${release}: replacing history with a same-project copy after commit cannot register the new inode`, {skip: process.platform === 'win32'}, () => {
    const f = fixture(release, 'replaced-after-commit'), previous = state(f), original = fileIdentity(f.historyFile);
    const held = path.join(f.root, 'held-history.db');
    const replacementSource = releaseProjectPaths(f.sample).historyFile;
    let replacement: ReturnType<typeof fileIdentity> | undefined;
    assert.throws(() => f.open({...approve, onUpgradeBoundary: phase => {
      if (phase !== 'after-commit') return;
      renameSync(f.historyFile, held);
      copyFileSync(replacementSource, f.historyFile);
      replacement = fileIdentity(f.historyFile);
      assert.notDeepEqual(replacement, original);
    }}).close(), {code: 'PROJECT_INVALID'});
    assert.ok(replacement);
    assert.equal(isProjectFileHeld(replacement), false);
    assert.equal(isProjectFileHeld(original), false);
    assert.equal(inspectProjectFormatReadOnly(f.projectFile).formatVersion, candidate.project);
    assert.deepEqual(readFileSync(f.historyFile), readFileSync(replacementSource));
    assert.throws(() => f.open({}).close(), {code: 'PROJECT_INVALID'});
    renameSync(held, f.historyFile);
    assert.deepEqual(fileIdentity(f.historyFile), original);
    const store = f.open({});
    try {assertCandidate(store, f, previous);} finally {store.close();}
  });

  test(`${release}: forked pair remains diverged and read-only with neither database upgraded`, () => {
    const f = fixture(release, 'fork');
    const raw = new DatabaseSync(f.historyFile);
    try {
      const different = f.evidence.stamp.contentToken === 'f'.repeat(32) ? 'e' : 'f';
      raw.prepare('UPDATE history_state SET seenContentToken=?').run(different.repeat(32));
    } finally {raw.close();}
    const initial = files(f);
    const store = f.open({...approve, onUpgradeBoundary: () => assert.fail('Forked history cannot enter upgrade')});
    try {
      assert.equal(store.historyState, 'diverged');
      assert.equal(store.historyAdmission.reason, 'content-token-different');
      assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only, 1);
      assert.deepEqual(versions(store.db), stable);
      assert.deepEqual(canvasTables(store.db), []);
    } finally {store.close();}
    assert.deepEqual(files(f), initial);
    assert.equal(existsSync(backupRoot(f)), false);
  });

  for (const tamper of ['project-manifest', 'forged-project-version', 'history-manifest', 'history-header'] as const) {
    test(`${release}: ${tamper} is rejected before upgrades or backups`, () => {
      const f = fixture(release, tamper);
      if (tamper === 'history-header') writeFileSync(f.historyFile, Buffer.from('Invalid history header'));
      else {
        const raw = new DatabaseSync(tamper === 'history-manifest' ? f.historyFile : f.projectFile);
        try {
          if (tamper === 'forged-project-version') raw.exec(`PRAGMA user_version=${candidate.project}`);
          else raw.exec('CREATE TABLE counterfeit_manifest(id INTEGER PRIMARY KEY)');
        } finally {raw.close();}
      }
      const initial = files(f);
      assert.throws(() => f.open({...approve, onUpgradeBoundary: () => assert.fail('An unverified manifest cannot enter upgrade')}).close(), {code: 'PROJECT_INVALID'});
      assert.deepEqual(files(f), initial);
      assert.equal(existsSync(backupRoot(f)), false);
    });
  }

  for (const stopAt of ['before-version-write', 'before-commit', 'after-commit'] satisfies Format4UpgradeBoundary[]) {
    test(`${release}: SIGKILL ${stopAt} exposes only the complete old or complete new pair`, {skip: process.platform === 'win32'}, () => {
      const f = fixture(release, stopAt), previous = state(f);
      killUpgrade(f, stopAt);
      if (stopAt === 'after-commit') {
        const reopened = f.open({});
        try {assertCandidate(reopened, f, previous);} finally {reopened.close();}
      } else {
        assert.deepEqual(state(f), previous);
        const retry = f.open(approve);
        try {assertCandidate(retry, f, previous);} finally {retry.close();}
      }
    });
  }
}
