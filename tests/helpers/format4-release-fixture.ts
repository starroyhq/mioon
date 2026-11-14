import {testEnv} from './test-env.ts';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {ContentStamp} from '../../packages/contracts/src/project-file.ts';
import type {ProjectVersionListResponse, ProjectVersionRestoreInput, ProjectVersionRestoreResponse,
  ProjectVersionSaveInput, ProjectVersionSaveResponse} from '../../packages/contracts/src/project-version-operations.ts';
import type {TimelineRecord} from '../../packages/business/src/timeline-inputs.ts';

export const FORMAT4_RELEASES = {
  'v0.1.0': 'ea4583632cb938ee540c34081925bdb5dd1b4dac',
  'v0.1.1': 'deba8db999a9be03bce9e4b6ff74dbce29e15d9d',
} as const;
export type Format4Release = keyof typeof FORMAT4_RELEASES;
const repository = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('../fixtures/format4-release-worker.mjs', import.meta.url));

type SeedRecord = Record<string, unknown> & {id: string; projectId: string};
interface ReleaseEvidence {
  projectId: string;
  formats: {project: number; history: number; cache: number};
  stamp: ContentStamp;
  shot: SeedRecord;
  node: SeedRecord;
  edge: SeedRecord;
  shotInput: {projectId: string; requestId: string; title: string; duration: number};
  clipInput: {projectId: string; requestId: string; expectedRevision: number; trackId: string; assetId: string;
    startFrame: number; durationFrames: number; rect: {x: number; y: number; width: number; height: number}};
  clipAck: TimelineRecord;
  saveInput: ProjectVersionSaveInput;
  saved: ProjectVersionSaveResponse;
  restoreInput: ProjectVersionRestoreInput;
  restored: ProjectVersionRestoreResponse;
  timeline: TimelineRecord;
  versionList: ProjectVersionListResponse;
}

export function releaseProjectPaths(root: string) {
  const localDir = path.join(root, 'records');
  const cacheDir = path.join(root, 'cache');
  return {
    projectFile: path.join(root, 'project.mioon'), historyFile: path.join(localDir, 'history.db'), cacheFile: path.join(cacheDir, 'cache.db'),
    backupFile: path.join(root, 'release-backup.mioon'),
    location: {localDir, cacheDir, tempDir: path.join(root, 'temp')},
  };
}

function runRelease(archiveRoot: string, args: string[]): void {
  const result = spawnSync(process.execPath, [path.join(archiveRoot, 'fixture-runner.mjs'), ...args], {
      env: testEnv(),
    cwd: archiveRoot, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000,
  });
  const diagnostic = (result.stderr ?? '').replaceAll(repository, '<repo>/');
  assert.equal(result.status, 0, diagnostic || result.error?.message || `Release fixture worker exited with ${String(result.signal)}`);
}

/** Recreates the sample using the pinned release's actual write path. The test
 * checkout's contracts sources are never imported by either release process.
 * Only the same locked external dependency is reused from the installed tree. */
export function prepareFormat4Release(root: string, release: Format4Release) {
  const directory = path.join(root, release), source = path.join(directory, 'source'), archive = path.join(directory, 'source.tar');
  const sourceSha = FORMAT4_RELEASES[release];
  const ref = execFileSync('git', ['-C', repository, 'rev-parse', `refs/tags/${release}^{commit}`], {encoding: 'utf8'}).trim();
  assert.equal(ref, sourceSha, 'Release tag points to its reviewed commit');
  mkdirSync(directory, {mode: 0o700});
  mkdirSync(source, {mode: 0o700});
  execFileSync('git', ['-C', repository, 'archive', '--format=tar', '--output', archive, sourceSha, '--',
    'package.json', 'packages/business/package.json', 'packages/business/src', 'packages/contracts/package.json', 'packages/contracts/src',
    'apps/server/src/project-host/project-initialization.ts']);
  execFileSync('tar', ['-xf', archive, '-C', source]);
  rmSync(archive);

  const contracts = path.join(source, 'packages/contracts');
  const zod = realpathSync(path.join(repository, 'packages/contracts/node_modules/zod'));
  const releasePackage = JSON.parse(readFileSync(path.join(contracts, 'package.json'), 'utf8')) as {dependencies: {zod: string}};
  const dependency = JSON.parse(readFileSync(path.join(zod, 'package.json'), 'utf8')) as {version: string};
  assert.equal(dependency.version, releasePackage.dependencies.zod, 'Installed zod matches the pinned release requirement');
  mkdirSync(path.join(contracts, 'node_modules'));
  symlinkSync(zod, path.join(contracts, 'node_modules/zod'), 'junction');
  const workspace = path.join(source, 'node_modules/@mioon');
  mkdirSync(workspace, {recursive: true});
  symlinkSync(contracts, path.join(workspace, 'contracts'), 'junction');
  copyFileSync(worker, path.join(source, 'fixture-runner.mjs'));

  const sample = path.join(directory, 'sample'), evidenceFile = path.join(directory, 'release-evidence.json');
  runRelease(source, ['seed', sample, evidenceFile]);
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as ReleaseEvidence;
  return {release, sourceSha, source, sample, evidence};
}

export function assertOldReleaseRejectsNewer(source: string, projectFile: string, evidenceFile: string): void {
  runRelease(source, ['read-newer', projectFile, evidenceFile]);
  assert.deepEqual(JSON.parse(readFileSync(evidenceFile, 'utf8')), {readOnly: 'PROJECT_FORMAT_NEWER', writable: 'PROJECT_FORMAT_NEWER', located: false});
}

export function readOldReleasePair(source: string, root: string, evidenceFile: string): unknown {
  runRelease(source, ['read-pair', root, evidenceFile]);
  return JSON.parse(readFileSync(evidenceFile, 'utf8')) as unknown;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output || Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 and give a new fixture output directory');
  const root = path.resolve(output);
  mkdirSync(root, {mode: 0o700});
  for (const release of Object.keys(FORMAT4_RELEASES) as Format4Release[]) {
    const sample = prepareFormat4Release(root, release);
    process.stdout.write(`${sample.release} ${sample.sourceSha} ${JSON.stringify(sample.evidence.formats)}\n`);
  }
}
