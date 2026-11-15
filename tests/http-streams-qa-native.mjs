import {importNativeQaAsset,nativeQaAssetFile,coldNativeQaAssetFile} from './helpers/native-local-qa-fixture.ts';
/** Ordinary sandboxed Q4 native fixture. Synthetic private data only; no
 * renderer hooks, remote debugging, token reads or external provider calls. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, writeFile, appendFile, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {prepareNativeQaProject, closeQaProject, captureNativeQa} from './helpers/native-local-qa-fixture.ts';
import {readQaFixture} from './helpers/kernel-qa-fixture.mjs';
import {ownQaChild} from './helpers/qa-owned-child.mjs';
import {run, fileInfo, safePath} from '@mioon/business/media';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(process.env.MIOON_QA_FIXTURE_ROOT || path.join(repo, 'evidence/q4-http-streams/native-kernel'));
const userData = path.join(root, 'user-data'), workspace = path.join(userData, 'data');
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

export async function prepareHttpNativeFixture() {
  ensurePrivateDirectory(root, {create: true});
  const previous = readQaFixture(path.join(root, 'fixture.json'), workspace);
  if(previous&&previous.assetReferenceFixture!==1)throw Error('Historical pre-reference fixture must be preserved; choose a fresh MIOON_QA_FIXTURE_ROOT');
  if (previous) return previous;
  if (existsSync(path.join(workspace, 'app-library.db'))) throw Error('Partial QA data must be preserved; choose a fresh MIOON_QA_FIXTURE_ROOT');
  ensurePrivateDirectory(userData, {create: true});
  const prepared = await prepareNativeQaProject(workspace, 'Q4 · 文件传输与断连恢复'), {store, services, project} = prepared;
  const video = path.join(store.tempDir, 'synthetic-transport-' + randomUUID() + '.mp4');
  let fixture;
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', video]);
    const missing = await importNativeQaAsset(prepared, {projectId: project.id, name: '模拟已缺失素材.png', mimeType: 'image/png',
      dataBase64: (await readFile(path.join(repo, 'examples/synthetic/reference.png'))).toString('base64')});
    const healthy = await importNativeQaAsset(prepared, {projectId: project.id, name: '正常视频 · 断连后仍可播放.mp4', mimeType: 'video/mp4',
      dataBase64: (await readFile(video)).toString('base64')});
    const timeline = await services.call('timeline.get', {projectId: project.id});
    await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId: healthy.id, trackId: timeline.tracks.find(track => track.kind === 'video').id, startFrame: 0, durationFrames: 120});
    const missingFile = (await nativeQaAssetFile(store,missing.id)).file;
    await unlink(missingFile); // Exact new synthetic file; no existing user data.
    fixture = {synthetic: true, kernel: true, assetReferenceFixture:1, workspace, projectDir: store.projectDir, localDir: store.localDir, projectFile: store.projectFile,
      projectId: project.id, healthyAssetId: healthy.id, missingAssetId: missing.id, expectedVideo: await fileInfo(video)};
  } finally {
    try {await closeQaProject(prepared);} finally {try {await unlink(video);} catch (error) {if (error.code !== 'ENOENT') throw error;}}
  }
  await json(path.join(root, 'fixture.json'), fixture);
  return fixture;
}
async function audit() {
  const fixture = await prepareHttpNativeFixture();
  // No bare SQLite: a live native owner is rejected by the normal B1 opener.
  const snapshot = captureNativeQa(workspace), row = snapshot.rows.assets.find(row => row.id === fixture.healthyAssetId);
  if (!row || typeof row.data !== 'string') throw Error('Synthetic healthy video row is missing');
  const asset = JSON.parse(row.data), location = snapshot.locations[asset.projectId];
  if (asset.projectId !== fixture.projectId || !location) throw Error('Synthetic video owner differs');
  const counts = Object.fromEntries(['assets', 'jobs', 'exports', 'mio_runs'].map(table => [table, snapshot.rows[table].length]));
  const bytes = await fileInfo((await coldNativeQaAssetFile(workspace,asset.projectId,asset.id)).file);
  return {counts, agentCounter: 'mio_runs', storage: snapshot, healthyVideo: bytes,
    publishedBytesMatch: bytes.sha256 === asset.sha256 && bytes.sizeBytes === asset.sizeBytes};
}
async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {pid, parentPid: Number(fields[1]), startTicks: fields[19]};
  } catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error;}
}

async function launch() {
  if (process.platform !== 'linux') throw Error('Native process observation requires Linux; prepare/audit are headless');
  await prepareHttpNativeFixture();
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  Object.assign(env, {MIOON_DESKTOP_USER_DATA: userData, MIOON_FFMPEG_PATH: process.env.MIOON_FFMPEG_PATH || '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: process.env.MIOON_FFPROBE_PATH || '/usr/bin/ffprobe'});
  const mainSha256 = await hash(path.join(repo, 'apps/desktop/build/main.cjs')), backendSha256 = await hash(path.join(repo, 'apps/desktop/build/backend.cjs'));
  const child = spawn(createRequire(import.meta.url)('electron'), [path.join(repo, 'apps/desktop/build')], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  const owned = ownQaChild(child);
  let logs = Promise.resolve(), backend, observing = false, observationFailure;
  const observe = async () => {if (observing || owned.closed || backend) return; observing = true;
    try {const connection = JSON.parse(await readFile(path.join(userData, 'mcp-connection.json'), 'utf8'));
      if (!Number.isSafeInteger(connection.pid) || connection.pid <= 1) throw Error('Invalid synthetic backend PID');
      const candidate = await identity(connection.pid);if (candidate?.parentPid === child.pid) backend = candidate;
    } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) observationFailure = error.code || 'OBSERVATION_FAILED';}
    finally {observing = false;}
  };
  const timer = setInterval(() => {void observe();}, 100);
  for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
    logs = logs.then(() => appendFile(path.join(root, `${kind}.log`), bytes, {mode: 0o600}));
  });
  const launchRecord = {pid: child.pid, startedAt: new Date().toISOString(), synthetic: true, sandboxUnchanged: true,
    remoteDebugging: false, mainSha256, backendSha256};
  try {await json(path.join(root, 'launch.json'), launchRecord);} catch (error) {clearInterval(timer);await owned.stop();throw error;}
  let result;
  try {result = await owned.done;} finally {clearInterval(timer);}
  while (observing) await new Promise(resolve => setTimeout(resolve, 10));
  await logs;
  let remaining = backend;
  for (const deadline = Date.now() + 45000;remaining && Date.now() < deadline;) {
    const current = await identity(remaining.pid);if (current?.startTicks !== remaining.startTicks) {remaining = null;break;}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!backend) observationFailure ||= 'BACKEND_NOT_OBSERVED';
  await json(path.join(root, 'exit.json'), {...result, pid: child.pid, endedAt: new Date().toISOString(), backend, remainingOwnedBackend: remaining, observationFailure,
    audit: !backend || remaining ? null : await audit()});
  process.exitCode = result.code || (result.signal || remaining || observationFailure ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Synthetic Q4: --prepare seeds one real kernel project with one deliberately missing image and one healthy video; --audit is cold only after native/backend exit. Use a fresh MIOON_QA_FIXTURE_ROOT. Prepare never implies GUI/HTTP-stream verification.');
  else if (process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareHttpNativeFixture()));
  else if (process.argv.includes('--audit')) console.log(JSON.stringify(await audit()));
  else await launch();
}
