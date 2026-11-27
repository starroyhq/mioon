import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {run} from '../packages/business/src/media-runtime.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createClient} from '../packages/client/src/index.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {parseTimelinePreviewMediaQuery, timelinePreviewMediaPath} from '../packages/contracts/src/timeline-preview-media.ts';
import type {PreviewMedia} from '../packages/contracts/src/timeline-preview-media.ts';
import type {SpeedProcessingItem, SpeedSetting} from '../packages/contracts/src/timeline-speed.ts';
import {instantiateSpeedPreset} from '../packages/contracts/src/timeline-time-map.ts';
import {startServer} from './helpers/test-server.ts';

test('the authenticated project host serves only the verified proxy for a live curve', {timeout: 90_000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-preview-host-'));
  const token = 'synthetic-timeline-preview-host-token';
  const gate = process.env.MIOON_FORMAT6_DEV;
  process.env.MIOON_FORMAT6_DEV = '1';
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {await server?.close();} finally {
      if (gate === undefined) delete process.env.MIOON_FORMAT6_DEV;
      else process.env.MIOON_FORMAT6_DEV = gate;
      await rm(root, {recursive: true, force: true});
    }
  });
  server = await startServer({dataDir: path.join(root, 'app'), port: 0, token,
    localDraftChannel: 'development', projectFormatForTest: undefined});
  const baseUrl = server.url;
  const client = createClient({env: {MIOON_BASE_URL: baseUrl, MIOON_TOKEN: token}});
  const {id: projectId} = await client.rpc<{id: string}>('project.create', {name: 'Preview source'});

  const source = path.join(root, 'source.mp4');
  const sourceFrames = 24;
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=1280x720:rate=30',
    '-frames:v', String(sourceFrames), '-an', '-c:v', 'libx264', '-threads:v', '1', '-pix_fmt', 'yuv420p', source]);
  const sourceBytes = await readFile(source);
  const {id: assetId} = await client.rpc<{id: string}>('asset.import', {projectId, name: 'source.mp4',
    mimeType: 'video/mp4', dataBase64: sourceBytes.toString('base64')});
  const edit = async (operation: string, input: Record<string, unknown>) => {
    const {envelope, planDigest} = await client.rpc<{envelope: unknown; planDigest: string}>(operation, {projectId, ...input});
    const receipt = await client.rpc<{status: string}>('sequence.action.commit', {projectId, envelope, expectedPlanDigest: planDigest});
    assert.equal(receipt.status, 'applied');
  };
  await edit('sequence.board.edit', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  await edit('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
  const readProject = () => client.rpc<{projectFormatVersion: number; timeline: {
    clips: {id: string; assetId: string; durationFrames: number}[];
  }}>('project.get', {projectId});
  const project = await readProject();
  assert.equal(project.projectFormatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  const clip = project.timeline.clips.find(candidate => candidate.assetId === assetId);
  assert.ok(clip);
  assert.equal(clip.durationFrames, sourceFrames);
  const clipId = clip.id;
  const curve = instantiateSpeedPreset('slowMiddle', 0, sourceFrames);
  assert.ok(curve.ok, JSON.stringify(curve));
  const setSpeed = (speed: SpeedSetting['speed']) =>
    edit('sequence.timeline.edit', {kind: 'clip-speed', clipId, setting: {speed, direction: 'forward', pitchShift: false, interpolation: 'off'}});
  await setSpeed(curve.value);

  let previewTask: SpeedProcessingItem | undefined;
  const deadline = Date.now() + 10_000;
  do {
    const list = await client.rpc<{items: SpeedProcessingItem[]}>('timeline.processing.list', {projectId});
    previewTask = list.items.find(item => item.kind === 'preview' && item.clipId === clipId);
    if (!previewTask) await delay(25);
  } while (!previewTask && Date.now() < deadline);
  assert.ok(previewTask);
  const {taskId} = previewTask;
  const done = await client.rpc<{item: SpeedProcessingItem; timedOut: boolean}>('timeline.processing.wait',
    {projectId, taskId, timeoutMs: 45_000});
  assert.equal(done.timedOut, false);
  assert.equal(done.item.status, 'ready', JSON.stringify(done));
  const preview = await client.rpc<PreviewMedia>('timeline.preview.media', {projectId, clipId});
  assert.ok(preview.mode === 'proxy' && preview.status === 'ready', JSON.stringify(preview));
  assert.equal(preview.durationFrames, (await readProject()).timeline.clips.find(candidate => candidate.id === clipId)?.durationFrames);
  assert.notEqual(preview.durationFrames, sourceFrames);
  const url = new URL(preview.url, baseUrl);
  assert.equal(url.pathname, projectMediaPath(projectId, assetId));
  const locator = parseTimelinePreviewMediaQuery(url.searchParams);
  assert.ok(locator);
  assert.equal(locator.clipId, clipId);
  assert.equal(locator.taskId, taskId);

  const auth = {authorization: `Bearer ${token}`};
  for (const method of ['GET', 'HEAD']) {
    const unauthorized = await fetch(url, {method});
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
  }
  const head = await fetch(url, {method: 'HEAD', headers: auth});
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('cache-control'), 'private, no-store');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const full = await fetch(url, {headers: auth});
  assert.equal(full.status, 200);
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.equal(bytes.length, Number(head.headers.get('content-length')));
  assert.notDeepEqual(bytes, sourceBytes);
  const proxy = path.join(root, 'downloaded-preview.mp4');
  await writeFile(proxy, bytes);
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames', '-of', 'json', proxy]);
  assert.deepEqual(JSON.parse(probe).streams, [
    {codec_name: 'h264', width: 960, height: 540, nb_read_frames: String(preview.durationFrames)},
  ]);
  for (const method of ['GET', 'HEAD']) {
    const partial = await fetch(url, {method, headers: {...auth, range: 'bytes=2-7'}});
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-7/${bytes.length}`);
    assert.equal(partial.headers.get('content-length'), '6');
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), method === 'GET' ? bytes.subarray(2, 8) : Buffer.alloc(0));
  }

  const unavailable = async (address: string) => {
    const response = await fetch(new URL(address, baseUrl), {headers: auth});
    assert.equal(response.status, 404);
    const body = await response.json() as {error: {code: string}};
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.doesNotMatch(JSON.stringify(body), /preview\.mp4|cache|sha256/u);
  };
  const identity = {projectId, assetId, ...locator};
  const {id: otherProjectId} = await client.rpc<{id: string}>('project.create', {name: 'Other project'});
  for (const address of [timelinePreviewMediaPath({...identity, projectId: otherProjectId}),
    timelinePreviewMediaPath({...identity, assetId: randomUUID()}),
    timelinePreviewMediaPath({...identity, clipId: randomUUID()}),
    timelinePreviewMediaPath({...identity, taskId: randomUUID()}),
    timelinePreviewMediaPath({...identity, digest: (locator.digest[0] === '0' ? '1' : '0') + locator.digest.slice(1)}),
    preview.url + '&taskId=' + taskId, preview.url + '&preview=1']) {
    await unavailable(address);
  }
  await setSpeed({kind: 'constant', rate: {numerator: 1, denominator: 1}});
  assert.deepEqual(await client.rpc('timeline.preview.media', {projectId, clipId}),
    {mode: 'native', rate: {numerator: 1, denominator: 1}});
  await unavailable(preview.url);
  const original = await fetch(new URL(projectMediaPath(projectId, assetId), baseUrl), {headers: auth});
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), sourceBytes);
});
