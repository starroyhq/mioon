/** Ordinary sandboxed Q4 native fixture. Synthetic private data only; no
 * renderer hooks, remote debugging, token reads or external provider calls. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, writeFile, appendFile, unlink} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {openStore, createServices, safePath} from '@mioon/business';
import {run, fileInfo} from '@mioon/business/media';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'evidence/q4-http-streams/native');
const userData = path.join(root, 'user-data'), workspace = path.join(userData, 'workspace');
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

export async function prepareHttpNativeFixture() {
  ensurePrivateDirectory(root, {create: true});
  try {
    const previous = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
    if (previous.synthetic !== true || previous.workspace !== workspace) throw Error('Unexpected HTTP QA fixture');
    return previous;
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  ensurePrivateDirectory(userData, {create: true});
  const video = path.join(root, 'synthetic-transport.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', video]);
  const store = openStore(workspace);
  let fixture;
  try {
    const services = createServices(store, new Map());
    const project = await services.call('project.create', {name: 'Q4 · 文件传输与断连恢复'});
    const missing = await services.call('asset.import', {projectId: project.id, name: '模拟已缺失素材.png', mimeType: 'image/png',
      dataBase64: (await readFile(path.join(repo, 'examples/synthetic/reference.png'))).toString('base64')});
    const healthy = await services.call('asset.import', {projectId: project.id, name: '正常视频 · 断连后仍可播放.mp4', mimeType: 'video/mp4',
      dataBase64: (await readFile(video)).toString('base64')});
    const timeline = await services.call('timeline.get', {projectId: project.id});
    await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId: healthy.id, trackId: timeline.tracks.find(track => track.kind === 'video').id, startFrame: 0, durationFrames: 120});
    const missingFile = await safePath(workspace, store.get('assets', missing.id).relativePath);
    await unlink(missingFile); // Exact new synthetic file; no existing user data.
    fixture = {synthetic: true, workspace, projectId: project.id, healthyAssetId: healthy.id, missingAssetId: missing.id,
      expectedVideo: await fileInfo(video)};
  } finally {store.close();}
  await json(path.join(root, 'fixture.json'), fixture);
  return fixture;
}
async function audit() {
  const fixture = await prepareHttpNativeFixture();
  const db = new DatabaseSync(path.join(workspace, 'workbench.sqlite'), {readOnly: true});
  let asset, counts;
  try {
    asset = JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(fixture.healthyAssetId).data);
    counts = Object.fromEntries(['assets', 'jobs', 'exports', 'agent_chat_runs'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  } finally {db.close();}
  const bytes = await fileInfo(await safePath(workspace, asset.relativePath));
  return {counts, healthyVideo: bytes, publishedBytesMatch: bytes.sha256 === asset.sha256 && bytes.sizeBytes === asset.sizeBytes};
}
async function launch() {
  await prepareHttpNativeFixture();
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  Object.assign(env, {MIOON_DESKTOP_USER_DATA: userData, MIOON_ENABLE_LIVE_PROVIDER: '0',
    MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe'});
  const child = spawn(createRequire(import.meta.url)('electron'), [path.join(repo, 'apps/desktop/build')], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  let logs = Promise.resolve();
  for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
    logs = logs.then(() => appendFile(path.join(root, `${kind}.log`), bytes, {mode: 0o600}));
  });
  const launchRecord = {pid: child.pid, startedAt: new Date().toISOString(), synthetic: true, sandboxUnchanged: true,
    remoteDebugging: false, mainSha256: await hash(path.join(repo, 'apps/desktop/build/main.cjs')),
    backendSha256: await hash(path.join(repo, 'apps/desktop/build/backend.cjs'))};
  await json(path.join(root, 'launch.json'), launchRecord);
  const result = await new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal}));});
  await logs;
  await json(path.join(root, 'exit.json'), {...result, pid: child.pid, endedAt: new Date().toISOString(), audit: await audit()});
  process.exitCode = result.code || (result.signal ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareHttpNativeFixture()));
  else if (process.argv.includes('--audit')) console.log(JSON.stringify(await audit()));
  else await launch();
}
