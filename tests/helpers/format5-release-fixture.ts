import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {Format5ConversionAllocation} from '../../packages/business/src/project-file/format5-conversion.ts';
import {readProjectContentStamp} from '../../packages/business/src/project-file/content-stamp.ts';
import {readSchemaManifest} from '../../packages/business/src/project-file/schema/manifest-check.ts';
import {prepareFormat4Release, FORMAT4_RELEASES} from './format4-release-fixture.ts';
import {testEnv} from './test-env.ts';

export const FORMAT5_SOURCE_RELEASES = {
  ...FORMAT4_RELEASES,
  'v0.2.0': 'b60554c2ed81646c3ed12b77a1bd86f2c2c23d3c',
} as const;
export type Format5SourceRelease = keyof typeof FORMAT5_SOURCE_RELEASES;
const repository = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('../fixtures/format4-release-worker.mjs', import.meta.url));
type ReleaseEvidence = ReturnType<typeof prepareFormat4Release>['evidence'];

export function format5ConversionAllocation(): Format5ConversionAllocation {
  return {sequenceRootId: randomUUID(), createdAt: '2026-01-03T00:00:00.000Z',
    nodeIds: Array.from({length: 32}, () => randomUUID()), clipIds: Array.from({length: 32}, () => randomUUID()),
    segmentGroupIds: Array.from({length: 32}, () => randomUUID()), edgeIds: Array.from({length: 64}, () => randomUUID()),
    anchorConflictPolicy: 'reject'};
}

export function format5KernelSnapshot(store: ProjectStore) {
  const {db} = store;
  const scalar = (statement: string) => Object.values(db.prepare(statement).get()!)[0];
  const content = readProjectContentStamp(db);
  return {
    versions: {project: scalar('PRAGMA project.user_version'), history: scalar('SELECT version FROM main.schema_version'), cache: scalar('SELECT version FROM cache.schema_version')},
    content, historyState: {...db.prepare('SELECT * FROM main.history_state').get()},
    manifests: {project: readSchemaManifest(db, 'project'), history: readSchemaManifest(db, 'main'), cache: readSchemaManifest(db, 'cache')},
    targetRevisions: db.prepare('SELECT * FROM project.agent_task_target_revisions_v2 ORDER BY kind,targetId').all(),
    project: ['projects', 'shots', 'nodes', 'edges', 'assets', 'versions', 'timelines', 'subject_bindings']
      .map(table => ({table, rows: db.prepare(`SELECT * FROM project.${table} ORDER BY id`).all()})),
    receipts: ['mutation_requests', 'timeline_requests', 'project_version_requests', 'timeline_history']
      .map(table => ({table, rows: db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()})),
  };
}

/** The fixture invokes each pinned producer's real kernel and service code.
 * The published app's v4 opt-in is supplied to the 0.2.0 kernel explicitly. */
export function prepareFormat5Release(root: string, release: Format5SourceRelease) {
  if (release !== 'v0.2.0') return prepareFormat4Release(root, release);
  const sourceSha = FORMAT5_SOURCE_RELEASES[release];
  const ref = execFileSync('git', ['-C', repository, 'rev-parse', `refs/tags/${release}^{commit}`], {encoding: 'utf8'}).trim();
  assert.equal(ref, sourceSha, 'The published tag must retain its reviewed source identity');
  const directory = path.join(root, release), source = path.join(directory, 'source'), archive = path.join(directory, 'source.tar');
  mkdirSync(directory, {mode: 0o700}); mkdirSync(source, {mode: 0o700});
  execFileSync('git', ['-C', repository, 'archive', '--format=tar', '--output', archive, sourceSha, '--',
    'package.json', 'packages/business/package.json', 'packages/business/src', 'packages/contracts/package.json', 'packages/contracts/src',
    'packages/i18n/package.json', 'packages/i18n/src', 'apps/server/src/project-host/project-initialization.ts']);
  execFileSync('tar', ['-xf', archive, '-C', source]); rmSync(archive);
  const contracts = path.join(source, 'packages/contracts'), zod = realpathSync(path.join(repository, 'packages/contracts/node_modules/zod'));
  const releasePackage = JSON.parse(readFileSync(path.join(contracts, 'package.json'), 'utf8')) as {dependencies: {zod: string}};
  const dependency = JSON.parse(readFileSync(path.join(zod, 'package.json'), 'utf8')) as {version: string};
  assert.equal(dependency.version, releasePackage.dependencies.zod, 'The dependency must match the pinned release');
  mkdirSync(path.join(contracts, 'node_modules')); symlinkSync(zod, path.join(contracts, 'node_modules/zod'), 'junction');
  const workspace = path.join(source, 'node_modules/@mioon'); mkdirSync(workspace, {recursive: true}); symlinkSync(contracts, path.join(workspace, 'contracts'), 'junction');
  let fixture = readFileSync(worker, 'utf8');
  const replacements = [
    ["import {SCHEMA_MANIFEST} from './packages/business/src/project-file/schema/manifest.ts';", "import {SCHEMA_MANIFEST} from './packages/business/src/project-file/schema/manifest.ts';\nimport {projectManifestForVersion,historyManifestForVersion} from './packages/business/src/project-file/schema/format-manifests.ts';\nconst profile={format4:{}};"],
    ['createProjectStore({projectFile:', 'createProjectStore({...profile,projectFile:'],
    ['openProjectStore({projectFile:', 'openProjectStore({...profile,projectFile:'],
    ['openProjectStore({projectFile,', 'openProjectStore({...profile,projectFile,'],
    ['inspectProjectFileReadOnly(target)', 'inspectProjectFileReadOnly(target,profile.format4)'],
    ['inspectProjectFileReadOnly(projectFile)', 'inspectProjectFileReadOnly(projectFile,profile.format4)'],
    ['import {readSchemaManifest}', 'import {readSchemaManifest,compareManifest}'],
    ['assert.deepEqual(readSchemaManifest(store.db, schema), SCHEMA_MANIFEST[name].entries);',
      "assert.deepEqual(compareManifest(readSchemaManifest(store.db,schema),(name==='project'?projectManifestForVersion(4):name==='history'?historyManifestForVersion(12):SCHEMA_MANIFEST.cache).entries),{missing:[],unexpected:[],changed:[]});"],
    ['assert.deepEqual(formats, {project: 3, history: 10, cache: 2})', 'assert.deepEqual(formats, {project: 4, history: 12, cache: 2})'],
  ] as const;
  for (const [before, after] of replacements) {
    assert.ok(fixture.includes(before), `The isolated fixture must still contain ${before}`);
    fixture = fixture.replaceAll(before, after);
  }
  writeFileSync(path.join(source, 'fixture-runner.mjs'), fixture);
  const sample = path.join(directory, 'sample'), evidenceFile = path.join(directory, 'release-evidence.json');
  const result = spawnSync(process.execPath, [path.join(source, 'fixture-runner.mjs'), 'seed', sample, evidenceFile], {
    cwd: source, env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr.replaceAll(repository, '<repo>/') || result.error?.message || String(result.signal));
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as ReleaseEvidence;
  assert.deepEqual(evidence.formats, {project: 4, history: 12, cache: 2});
  return {release, sourceSha, source, sample, evidence};
}
