import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {composeProjectRuntime, type ProjectRuntime} from './helpers/test-server.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createAppCompanionDocuments} from '../packages/business/src/companion-scope.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import type {ServiceApplicationPorts} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {readTimelineStorage} from '../packages/business/src/project-file/timeline-storage.ts';
import {validateProjectRetainedRows} from '../packages/business/src/project-retained-validation.ts';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/format5-upgrade.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {FORMAT5_SOURCE_RELEASES, prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import type {Format5SourceRelease} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';

const temporary = (): string => mkdtempSync(path.join(realpathSync(tmpdir()), 'format5-retained-'));
function testApplication(library: ReturnType<typeof openAppLibrary>): ServiceApplicationPorts {
  const configuration = createWorkspaceConfiguration({root: library.dataDir, documents: createAppCompanionDocuments(library)});
  const assertOwner = createProjectServiceApplication(library).assertMutationAllowed;
  return {configuration, outsidePaths: library.outsidePaths, receipts: library.receipts, assertMutationAllowed() {
    assertOwner(); assert.equal(library.db.isOpen, true, 'the real application connection must still own admission');
  }};
}
interface RuntimeFixture {runtime: ProjectRuntime; library: ReturnType<typeof openAppLibrary>; shutdown: AbortController;
  close(): Promise<void>}
async function composeExisting(t: TestContext, store: ReturnType<typeof upgradeProjectFormatTo5>['store'],
  root: string): Promise<RuntimeFixture> {
  mkdirSync(path.join(root, 'cache'), {recursive: true, mode: 0o700});
  mkdirSync(path.join(root, 'tmp'), {recursive: true, mode: 0o700});
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  const shutdown = new AbortController();
  const identity = library.projectFileIdentity(store.projectFile);
  assert.ok(identity);
  library.registry.upsert({projectId: store.projectId, projectFile: store.projectFile, fileIdentity: identity,
    name: 'Format 5 retained', lastOpenedAt: null, summary: null});
  const deletionGate = createProjectDeletionGate({signal: shutdown.signal, subscribeMedia: onMediaProcess,
    busy: () => { throw new Error('project busy'); }});
  const runtime = await composeProjectRuntime({store, shutdown, deletionGate, port: 4318,
    serverPort: () => 4318, listeningPort: () => 4318, comfyModule: 'skip' as const,
    privateMediaDirectories: [library.dataDir, path.join(root, 'cache'), path.join(root, 'tmp')],
    application: library, serviceApplication: testApplication(library)});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    runtime.taskRuntimeV2?.close(); runtime.taskHttpV2?.close();
    await runtime.serviceDrain(); await runtime.editTasks.drain(); await runtime.closeSettings();
    runtime.taskToolsV2?.dispose();
    try {store.close();} finally {library.close();}
  };
  t.after(close);
  return {runtime, library, shutdown, close};
}

/** Release fixtures convert to a format-5 timeline whose main-track clip is a
 * placeholder (no selected version). Opening that project through the real
 * server runtime used to reject the valid placeholder as a legacy clip with
 * `assetId:null`; the retained-row validator must treat it as format 5. */
for (const release of ['v0.1.0', 'v0.2.0'] as const satisfies readonly Format5SourceRelease[]) {
  test(`server runtime opens an upgraded ${release} project with a format-5 placeholder clip`, async t => {
    const root = temporary();
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const prepared = prepareFormat5Release(root, release);
    const projectDir = path.join(root, release);
    cpSync(prepared.sample, projectDir, {recursive: true});
    for (const directory of [projectDir, ...Object.values(releaseProjectPaths(projectDir).location)]) chmodSync(directory, 0o700);
    const paths = releaseProjectPaths(projectDir);
    const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
    assert.equal(Number(upgraded.store.db.prepare('PRAGMA project.user_version').get()?.user_version), FORMAT5_PROJECT_SCHEMA_VERSION);
    const timeline = readTimelineStorage(upgraded.store.db, upgraded.store.projectId);
    assert.ok(timeline?.format5);
    const timelineRecord = timeline.timeline as {clips: {sourceState?: string; assetId?: string | null}[]};
    assert.ok(timelineRecord.clips.some(clip => clip.sourceState === 'placeholder' && clip.assetId === null),
      'the upgrade fixture must keep a placeholder main-track clip');
    assert.doesNotThrow(() => validateProjectRetainedRows(upgraded.store));
    const {runtime} = await composeExisting(t, upgraded.store, root);
    const project = await runtime.serviceCall('project.get', {projectId: upgraded.store.projectId}) as
      {shots: unknown[]; timeline?: {clips: unknown[]}};
    assert.ok(project.shots.length >= 1, 'the upgraded project keeps its shots');
    assert.ok((project.timeline?.clips.length ?? 0) >= 1, 'the upgraded project keeps its main-track clips');
    await runtime.serviceDrain();
  });
}

test('a format-5 project with a placeholder clip can be reopened through the server runtime', async t => {
  const root = temporary();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const prepared = prepareFormat5Release(root, 'v0.2.0');
  const projectDir = path.join(root, 'reopen');
  cpSync(prepared.sample, projectDir, {recursive: true});
  for (const directory of [projectDir, ...Object.values(releaseProjectPaths(projectDir).location)]) chmodSync(directory, 0o700);
  const paths = releaseProjectPaths(projectDir);
  const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
  const first = await composeExisting(t, upgraded.store, root);
  await first.close();
  // A second server assembly on the same file is the real reopen path.
  const reopened = (await import('../packages/business/src/project-file/store.ts')).openProjectStore({projectFile: paths.projectFile,
    locate: () => paths.location});
  const second = await composeExisting(t, reopened, root);
  const project = await second.runtime.serviceCall('project.get', {projectId: reopened.projectId}) as {shots: unknown[]};
  assert.ok(project.shots.length >= 1, 'the reopened project keeps its shots');
});
