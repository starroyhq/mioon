import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {mediaExecutable} from '../packages/business/src/media-environment.ts';
import {originalVideoFrameRate, parseProbeOutput} from '../packages/business/src/media-probe.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {projectAssetImportAssetDigest} from '../packages/business/src/referenced-asset-project-import.ts';
import {assetMediaDtoSchema, assetMediaPrepareResponseSchema, type AssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {testEnv} from './helpers/test-env.ts';
import {startServer} from './helpers/test-server.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const clockGate = 'MIOON_FORMAT6_DEV';
const token = 'synthetic-format-six-source-rate-token';

test('source rate uses the selected video average and preserves unknown without a guessed fallback', () => {
  const video = {index: 1, codec_type: 'video', codec_name: 'h264', width: 64, height: 64, r_frame_rate: '60/1'};
  const cover = {...video, index: 0, disposition: {attached_pic: 1}, avg_frame_rate: '24/1'};
  const secondVideo = {...video, index: 2, avg_frame_rate: '25/1'};
  for (const avg_frame_rate of [undefined, '0/0', '0/1', '1/0', 'N/A', '24', '-25/1', '2147483648/1']) {
    const metadata = parseProbeOutput(JSON.stringify({streams: [cover, {...video, avg_frame_rate}, secondVideo]}));
    assert.equal(metadata.videoStreamIndex, 1);
    assert.equal(originalVideoFrameRate(metadata), null, String(avg_frame_rate));
  }
  const exactRate = parseProbeOutput(JSON.stringify({streams: [cover, {...video, avg_frame_rate: '24000/1001'}, secondVideo]}));
  assert.deepEqual(originalVideoFrameRate(exactRate), {numerator: 24000, denominator: 1001, nearestInteger: 24});
});

test('real format 6 RPCs carry exact source video rates and project reads have an explicit unknown', {timeout: 60_000}, async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-source-frame-rate-'));
  const priorGate = process.env[clockGate];
  process.env[clockGate] = '1';
  t.after(() => {
    if (priorGate === undefined) delete process.env[clockGate];
    else process.env[clockGate] = priorGate;
    rmSync(root, {recursive: true, force: true});
  });

  const dataDir = path.join(root, 'application');
  const options = {dataDir, port: 0, token, localDraftChannel: 'development' as const};
  let server = await startServer({...options, projectFormatForTest: undefined});
  try {
    const project = await server.projectEntries.create({name: 'Source rates', timelineFps: 30});
    const rpc = async (projectId: string, operation: string, input: Record<string, unknown> = {}) => {
      const response = await fetch(server.url + projectRpcPath(projectId), {method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({operation, input: {projectId, ...input}})});
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify({operation, result}));
      return result.data;
    };
    const rateCases = [[24, 1, 24], [25, 1, 25], [60, 1, 60], [24000, 1001, 24], [30000, 1001, 30]] as const;
    const videos: {asset: AssetMediaDto; input: Record<string, unknown>}[] = [];
    const probeAverage = (file: string): string => {
      const original = JSON.parse(execFileSync(mediaExecutable('ffprobe'), ['-v', 'error', '-show_entries',
        'stream=avg_frame_rate', '-select_streams', 'v:0', '-of', 'json', file], {encoding: 'utf8', env: testEnv()}));
      return original.streams[0]?.avg_frame_rate;
    };
    const uploadVideo = async (file: string, mimeType: 'video/mp4' | 'video/webm') => {
      const input = {name: path.basename(file), mimeType, dataBase64: readFileSync(file).toString('base64')};
      const asset = assetMediaDtoSchema.parse(await rpc(project.projectId, 'asset.import', input));
      videos.push({asset, input});
      return asset;
    };
    for (const [numerator, denominator, nearestInteger] of rateCases) {
      const file = path.join(root, `source-${numerator}.mp4`);
      execFileSync(mediaExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        `testsrc2=size=64x64:rate=${numerator}/${denominator}`, '-frames:v', '24', '-c:v', 'libx264', '-threads', '1', file], {env: testEnv()});
      assert.equal(probeAverage(file), `${numerator}/${denominator}`);
      const asset = await uploadVideo(file, 'video/mp4');
      assert.deepEqual(asset.videoFrameRate, {numerator, denominator, nearestInteger});
    }
    // The bundled FFprobe reports 0/0 for this short VFR EBML source.
    // System FFprobe versions can infer an average, so verify their own result.
    const variable = path.join(root, 'source-variable.webm');
    execFileSync(mediaExecutable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=64x64:rate=30:duration=2', '-frames:v', '2', '-vf', 'settb=1/1000,setpts=100*N*N',
      '-fps_mode', 'passthrough', '-c:v', 'libx264', '-threads', '1', '-f', 'matroska', variable], {env: testEnv()});
    const [numerator, denominator] = probeAverage(variable).split('/').map(Number);
    const expected = numerator > 0 && denominator > 0 ? {numerator, denominator, nearestInteger: Math.round(numerator / denominator)} : null;
    assert.deepEqual((await uploadVideo(variable, 'video/webm')).videoFrameRate, expected);
    const image = assetMediaDtoSchema.parse(await rpc(project.projectId, 'asset.import',
      {name: 'still.png', mimeType: 'image/png', dataBase64: png().toString('base64')}));
    assert.ok(!Object.hasOwn(image, 'videoFrameRate'));
    const wants = videos.map(({asset}) => ({assetId: asset.id, referenceRevision: asset.referenceRevision}));
    const prepare = async () => assetMediaPrepareResponseSchema.parse(await rpc(project.projectId, 'asset.media.prepare', {assets: wants, purpose: 'timeline'})).assets;
    const inspect = async () => (await rpc(project.projectId, 'asset.inspect')).items;
    const list = () => rpc(project.projectId, 'asset.list');
    const getAssets = async () => (await rpc(project.projectId, 'project.get')).assets;
    for (const rows of [await prepare(), await inspect(), await list(), await getAssets()]) {
      for (const {asset} of videos) assert.deepEqual(rows.find(({id}: {id: string}) => id === asset.id)?.videoFrameRate, asset.videoFrameRate);
      assert.ok(!JSON.stringify(rows).includes(root), 'asset metadata is path-free');
    }

    // Exercise a pre-feature row using the same valid imported bytes and ref.
    await server.close();
    const store = openProjectStore({projectFile: project.projectFile, allowFormat6: true,
      locate: id => projectLocation(serverAppDirectories(dataDir), id)});
    const missing = videos[0]!.asset;
    let oldAssetDigest: string;
    try {
      const prior = store.get('assets', missing.id) as Record<string, unknown>;
      assert.deepEqual(prior.videoFrameRate, missing.videoFrameRate);
      const {videoFrameRate: _videoFrameRate, ...older} = prior;
      store.put('assets', older);
      oldAssetDigest = projectAssetImportAssetDigest(older);
    } finally {store.close();}
    server = await startServer({...options, projectFormatForTest: undefined});
    for (const rows of [await getAssets(), await inspect(), await list()]) {
      assert.equal(rows.find(({id}: {id: string}) => id === missing.id)?.videoFrameRate, null);
    }
    assert.deepEqual((await prepare()).find(({id}) => id === missing.id)?.videoFrameRate, missing.videoFrameRate);
    assert.equal((await getAssets()).find(({id}: {id: string}) => id === missing.id)?.videoFrameRate, null);

    delete process.env[clockGate];
    for (const rows of [await getAssets(), await inspect(), await list(), await prepare()]) {
      for (const row of rows) assert.ok(!Object.hasOwn(row, 'videoFrameRate'));
    }
    await server.close();
    process.env[clockGate] = '1';
    const verified = openProjectStore({projectFile: project.projectFile, allowFormat6: true,
      locate: id => projectLocation(serverAppDirectories(dataDir), id)});
    try {assert.equal(projectAssetImportAssetDigest(verified.get('assets', missing.id)), oldAssetDigest);}
    finally {verified.close();}
    server = await startServer({...options, projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION});
    const legacy = await server.projectEntries.create({name: 'Format 5 control'});
    const legacyAsset = await rpc(legacy.projectId, 'asset.import', videos[0]!.input);
    assert.ok(!Object.hasOwn(legacyAsset, 'videoFrameRate'));
    assert.ok(!(await rpc(legacy.projectId, 'project.get')).assets.some((row: Record<string, unknown>) => Object.hasOwn(row, 'videoFrameRate')));
  } finally {await server.close();}
});
