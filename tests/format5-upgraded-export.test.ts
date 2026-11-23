import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS} from '@mioon/contracts';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/format5-upgrade.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {readFormat5RenderProjection} from '../packages/business/src/format5-timeline-render.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {startServer} from './helpers/test-server.ts';
import {testEnv} from './helpers/test-env.ts';

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const NOW = '2026-01-02T03:04:05.000Z';
const FFMPEG = process.env.MIOON_FFMPEG_PATH || 'ffmpeg';
function privateTree(root: string): void {
  if (!statSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) {
    const child = path.join(root, entry);
    if (statSync(child).isDirectory()) privateTree(child);
  }
}

/** A released 0.2.0 project copied without its local generation records: five
 * shots each have a provider version with portable publication proof, and the
 * main track keeps five 3-second cuts. Format 4 cannot be written by today's
 * new-project path, so the pinned v0.2.0 release fixture supplies the schema. */
async function upgradedPortableProject() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-upgraded-export-'));
  const prepare = path.join(root, 'prepare'); mkdirSync(prepare, {mode: 0o700});
  const source = prepareFormat5Release(prepare, 'v0.2.0');
  const projectRoot = path.join(root, 'project'); cpSync(source.sample, projectRoot, {recursive: true});
  mkdirSync(path.join(projectRoot, '生成'), {mode: 0o700});
  privateTree(root);
  const generated = path.join(projectRoot, '生成', 'generated.mp4');
  const ffmpeg = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=320x480:rate=30:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', generated], {env: testEnv()});
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString());
  const bytes = readFileSync(generated), videoSha = sha(bytes);
  const paths = releaseProjectPaths(projectRoot);
  privateTree(projectRoot);
  for (const directory of Object.values(paths.location)) chmodSync(directory, 0o700);
  const formats = {project: 4, history: 12, cache: 2} as const;
  const store = openProjectStore({projectFile: paths.projectFile, locate: () => paths.location, format4: {}});
  const projectId = String((store.list('projects')[0] as {id: string}).id);
  const templateShot = store.list('shots')[0] as Record<string, any>;
  const templateNode = store.list('nodes')[0] as Record<string, any> | undefined;
  const templateTimeline = store.list('timelines')[0] as Record<string, any>;
  const mainTrack = templateTimeline.tracks.find((track: Record<string, unknown>) => track.kind === 'video');
  const ids = [] as {shotId: string; versionId: string; assetId: string; clipId: string; path: string}[];
  try {
    for (let index = 0; index < 5; index++) {
      const shotId = index === 0 ? String(templateShot.id) : randomUUID(), versionId = randomUUID(), assetId = randomUUID(), clipId = randomUUID();
      const jobId = randomUUID(), publicationId = randomUUID(), relativePath = `生成/generated-${index}.mp4`;
      const file = path.join(projectRoot, relativePath); copyFileSync(generated, file);
      const fileStat = lstatSync(file, {bigint: true});
      store.put('assets', {id: assetId, projectId, name: `Provider version ${index + 1}`, mimeType: 'video/mp4',
        width: 320, height: 480, duration: 5, sizeBytes: bytes.length, sha256: videoSha, referenceRevision: 1,
        provenance: 'generated', producer: {kind: 'generation', id: jobId}, createdAt: NOW,
        publication: {version: 1, publicationId, projectId, assetId,
          owner: {kind: 'generation', id: jobId, requestId: `request-${jobId}`, inputHash: 'b'.repeat(64)},
          targetKind: 'generated', relativePath, sha256: videoSha, sizeBytes: bytes.length, mimeType: 'video/mp4'},
        reference: {pathForm: 'relative', path: relativePath, volume: null, sizeBytes: bytes.length, mtimeMs: Number(fileStat.mtimeNs / 1000n) / 1000,
          sampledSha256: videoSha, fullSha256: videoSha}});
      const snapshot = {shotId, shotRevision: 1, title: `镜头 ${index + 1}`, prompt: '', referenceAssetIds: [],
        referenceAssets: [], referenceConnections: [], aspectRatio: '9:16', duration: 3, providerId: 'mock', model: 'mock'};
      store.put('versions', {id: versionId, projectId, shotId, assetId, sha256: videoSha, number: 1, jobId,
        createdAt: NOW, snapshot});
      store.put('shots', {...templateShot, id: shotId, title: `镜头 ${index + 1}`, prompt: '', duration: 3,
        orderIndex: index, position: {x: index * 320, y: 0}, referenceAssetIds: [], selectedVersionId: versionId,
        revision: 1, createdAt: NOW, updatedAt: NOW});
      // Reference images stay on the board; these five shots are provider output.
      if (index === 0 && templateNode) store.put('nodes', {...templateNode, id: randomUUID(), label: '成片'});
      ids.push({shotId, versionId, assetId, clipId, path: relativePath});
    }
    const clips = ids.map((item, index) => ({id: item.clipId, trackId: mainTrack.id, assetId: item.assetId,
      name: `镜头 ${index + 1}`, startFrame: index * 90, durationFrames: 90, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 1080, height: 1920}, gain: 1}));
    store.put('timelines', {...templateTimeline, revision: templateTimeline.revision + 1, durationFrames: 450, clips});
    assert.deepEqual({project: Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version),
      history: Number(store.db.prepare('SELECT version FROM main.schema_version').get()?.version),
      cache: Number(store.db.prepare('SELECT version FROM cache.schema_version').get()?.version)}, formats);
    // Portable copy: generation jobs live only in local records and are absent here.
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()?.n), 0);
  } finally {store.close();}
  for (const directory of [root, projectRoot, ...Object.values(paths.location)]) chmodSync(directory, 0o700);
  const upgraded = upgradeProjectFormatTo5({projectFile: paths.projectFile, locate: () => paths.location, approveUpgrade: () => true});
  upgraded.store.close();
  privateTree(root);
  return {root, projectRoot, projectFile: paths.projectFile, projectId, ids};
}

async function fixture(t: test.TestContext) {
  const project = await upgradedPortableProject();
  t.after(() => rmSync(project.root, {recursive: true, force: true}));
  return project;
}

test('a portable upgraded format-5 clip validates its frozen version without a local job', async (t) => {
  const project = await fixture(t);
  const store = openProjectStore({projectFile: project.projectFile, locate: () => releaseProjectPaths(project.projectRoot).location});
  try {
    const projection = readFormat5RenderProjection(store);
    assert.ok(projection);
    assert.equal(projection.legacy.clips.length, 5);
    assert.equal(projection.legacy.durationFrames, 450);
    const graph = createOwnedMediaGraphReader(store.db, store.projectId);
    for (const clip of projection.legacy.clips) graph.clipSource(clip as never);
  } finally {store.close();}
});

test('an upgraded portable project exports and preview-renders to a real file', {timeout: 180000}, async (t) => {
  const project = await fixture(t);
  const dataDir = path.join(project.root, 'app'), projectsDir = path.join(project.root, 'projects');
  mkdirSync(dataDir, {mode: 0o700}); mkdirSync(projectsDir, {mode: 0o700});
  const server = await startServer({dataDir, projectsDir, port: 0, token: 'upgraded-export-synthetic-token',
    projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION});
  t.after(() => server.close());
  const windowId = randomUUID();
  const opened = await server.projectEntries.openPath({projectFile: project.projectFile, windowId});
  assert.equal(opened.project.projectId, project.projectId);
  async function rpc<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${server.url}/api/projects/${project.projectId}/rpc`, {method: 'POST',
      headers: {authorization: `Bearer ${server.token}`, 'content-type': 'application/json'},
      body: JSON.stringify({operation, input}), signal: AbortSignal.timeout(30000)});
    const body = await response.json() as {ok: boolean; data: T; error?: unknown};
    assert.equal(body.ok, true, JSON.stringify(body.error));
    return body.data;
  }
  const state = await rpc<{timeline: {id: string; revision: number}}>('project.get', {projectId: project.projectId});
  const revision = state.timeline.revision;
  const render = async (purpose: 'preview' | 'export', input: Record<string, unknown>) => {
    const request = {projectId: project.projectId, requestId: randomUUID(), expectedRevision: revision, purpose, ...input};
    const receipt = await rpc<{id: string}>('timeline.render', request);
    for (let deadline = Date.now() + 90000; Date.now() < deadline;) {
      const record = await rpc<{status: string; assetId: string | null; error?: {code?: string}}>('export.get', {exportId: receipt.id});
      if (['succeeded', 'failed'].includes(record.status)) return record;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.fail('the upgraded export did not settle');
  };
  const preview = await render('preview', {});
  assert.equal(preview.status, 'succeeded', JSON.stringify(preview.error));
  const exportSettings = TIMELINE_EXPORT_DEFAULT_SETTINGS;
  const checked = await rpc<{status: string; snapshotHash?: string}>('timeline.export.preflight',
    {projectId: project.projectId, expectedRevision: revision, exportSettings});
  assert.ok(['ready', 'incomplete'].includes(checked.status), JSON.stringify(checked));
  const exported = await render('export', {exportSettings});
  assert.equal(exported.status, 'succeeded', JSON.stringify(exported.error));
  assert.ok(exported.assetId);
  const response = await fetch(`${server.url}/api/projects/${project.projectId}/media/${exported.assetId}`,
    {headers: {authorization: `Bearer ${server.token}`}, signal: AbortSignal.timeout(30000)});
  assert.equal(response.status, 200);
  const output = Buffer.from(await response.arrayBuffer());
  const outputFile = path.join(project.root, 'upgraded-export.mp4'); writeFileSync(outputFile, output);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', outputFile], {encoding: 'utf8', env: testEnv()});
  assert.equal(probe.status, 0, probe.stderr);
  const info = JSON.parse(probe.stdout) as {streams: {codec_type?: string; codec_name?: string; nb_read_frames?: string}[]; format: {duration: string}};
  const video = info.streams.find(stream => stream.codec_type === 'video')!;
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.nb_read_frames, '450');
  assert.ok(Math.abs(Number(info.format.duration) - 15) < 0.1, info.format.duration);
  assert.ok(output.length > 0);

  // A bounded render refusal before the queue transaction must become a durable
  // not-applied intent with its reason, never an intent that stays pending.
  const local = async <T = unknown>(route: string, method: 'GET' | 'POST', input?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}/api/projects/${project.projectId}/local-delivery${route}`,
      {method, headers: {authorization: `Bearer ${server.token}`, 'content-type': 'application/json'},
       ...(input === undefined ? {} : {body: JSON.stringify(input)}), signal: AbortSignal.timeout(30000)});
    const body = await response.json() as {ok: boolean; data: T; error?: {code?: string}};
    assert.equal(body.ok, true, JSON.stringify(body.error));
    return body.data;
  };
  type Envelope = {supported: true; workspaceScope: string; instanceId: string;
    intentRevision: number; intent: {intentId: string} | null};
  const envelope = await local<Envelope>('?projectId=' + project.projectId, 'GET');
  const intentId = randomUUID();
  const invalidInput = {projectId: project.projectId, expectedRevision: revision, requestId: randomUUID(),
    purpose: 'export', exportRange: {startFrame: 0, endFrame: 18000}};
  const prepared = await local<Envelope>('/prepare', 'POST', {workspaceScope: envelope.workspaceScope,
    instanceId: envelope.instanceId, projectId: project.projectId, expectedIntentRevision: 0,
    expectedIntentId: null, intentId, timelineId: state.timeline.id, baseRevision: revision, draft: null,
    input: invalidInput});
  assert.equal(prepared.intent?.intentId, intentId);
  const executed = await local<{envelope: Envelope & {intent: {outcome: {status: string; code?: string}}}}>(
    '/execute', 'POST', {workspaceScope: envelope.workspaceScope, instanceId: envelope.instanceId,
      projectId: project.projectId, intentId, expectedIntentRevision: 1});
  assert.equal(executed.envelope.intent.outcome.status, 'not_applied', JSON.stringify(executed));
  assert.match(executed.envelope.intent.outcome.code ?? '', /^[A-Z][A-Z0-9_]{1,90}$/u);

  server.projectEntries.release({windowId});
});
