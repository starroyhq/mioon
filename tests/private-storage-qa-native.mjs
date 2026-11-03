/** Ordinary sandboxed Electron fixture. Synthetic app data only; no provider,
 * key, remote-debugging switch, smoke bridge or automatic permission repair. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, chmod, writeFile, readFile, readdir, lstat, appendFile} from 'node:fs/promises';
import {prepareNativeQaProject, closeQaProject} from './helpers/native-local-qa-fixture.ts';
import {ownQaChild} from './helpers/qa-owned-child.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.MIOON_QA_FIXTURE_ROOT ? path.resolve(process.env.MIOON_QA_FIXTURE_ROOT) : path.join(repo, 'evidence/q2-private-storage');
const modes = new Set(['unsafe', 'safe']);
async function json(file, value) {await writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});}
export async function storageQaSnapshot(directory) {
  const entries = [];
  async function visit(target, relative = '') {
    const info = await lstat(target);
    const item = {path: relative || '.', mode: info.mode & 0o7777, uid: info.uid, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'};
    if (info.isFile()) item.sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
    entries.push(item);
    if (entries.length > 512) throw Error('Synthetic storage audit exceeded its bound');
    if (info.isDirectory()) for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
  }
  await visit(directory); return entries;
}
export async function prepareStorageQa(mode) {
  if (!modes.has(mode)) throw Error('Unknown synthetic storage mode');
  const runtime = path.join(evidence, `native-${mode}`), userData = path.join(runtime, 'user-data'), dataDir = path.join(userData, 'data');
  await mkdir(runtime, {recursive: true, mode: 0o700});
  try {
    const existing = JSON.parse(await readFile(path.join(runtime, 'fixture.json'), 'utf8'));
    if (existing.synthetic !== true || existing.kernel !== true || existing.mode !== mode || existing.userData !== userData || existing.dataDir !== dataDir) throw Error('Historical storage fixture must be preserved; choose a fresh current-kernel fixture directory');
    return existing;
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  await mkdir(userData, {mode: mode === 'unsafe' ? 0o755 : 0o700});
  // Native GUI sessions may use umask077. This newly created disposable test
  // directory must actually be broad to exercise refusal; never repair real data.
  if (mode === 'unsafe') await chmod(userData, 0o755);
  if (((await lstat(userData)).mode & 0o777) !== (mode === 'unsafe' ? 0o755 : 0o700)) throw Error('Synthetic fixture permissions differ from the intended case');
  await writeFile(path.join(userData, 'synthetic-preserve-me.txt'), 'Synthetic Q2 fixture: preserve existing bytes and mode.\n', {mode: 0o600});
  let project, shot;
  if (mode === 'safe') {
    const current = await prepareNativeQaProject(dataDir, 'Q2 · 私有目录兼容验证');
    try {
      project = current.project;
      shot = await current.services.call('shot.create', {projectId: project.id, title: '已存项目保留 · Synthetic saved shot', prompt: '本地合成验收数据。没有供应商调用。', duration: 2});
    } finally {await closeQaProject(current);}
  }
  // Leave the native last-project locator/preferences unseeded: first launch
  // must discover this actual B1 registration through the ordinary UI path.
  const fixture = {synthetic: true, kernel: true, mode, runtime, userData, dataDir, ...(project ? {project, shot} : {})};
  await json(path.join(runtime, 'fixture.json'), fixture);
  await json(path.join(runtime, 'before.json'), await storageQaSnapshot(userData));
  return fixture;
}
async function launch(mode) {
  const fixture = await prepareStorageQa(mode), require = createRequire(import.meta.url), binary = require('electron');
  const env = {...process.env, MIOON_DESKTOP_USER_DATA: fixture.userData, MIOON_ENABLE_LIVE_PROVIDER: '0',
    MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe'};
  for (const key of Object.keys(env)) if (/^(RUNWAY|RUNWAYML|ARK_|VEO_|GEMINI_|MINIMAX_|HAILUO_|VIDU_|OPENAI_|DEEPSEEK_|DASHSCOPE_|MOONSHOT_|MIOON_TOKEN|MIOON_CONNECTION_FILE|MIOON_DESKTOP_SMOKE_)/u.test(key)) delete env[key];
  const launchId = randomUUID();
  const child = spawn(binary, [path.join(repo, 'apps/desktop/build')], {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  const owned = ownQaChild(child);
  let logs = Promise.resolve();
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {logs = logs.then(() => appendFile(path.join(fixture.runtime, `${name}.log`), bytes));});
  const launchRecord = {launchId, pid: child.pid, fixturePid: process.pid, startedAt: new Date().toISOString(), synthetic: true, mode, sandboxUnchanged: true, remoteDebugging: false, smokeHooks: false};
  try {
    await json(path.join(fixture.runtime, 'launch.json'), launchRecord);
    await appendFile(path.join(fixture.runtime, 'launches.jsonl'), JSON.stringify(launchRecord) + '\n', {mode: 0o600});
  } catch (error) {await owned.stop();throw error;}
  const result = await owned.done;
  await logs;
  const after = await storageQaSnapshot(fixture.userData);
  await json(path.join(fixture.runtime, 'after.json'), after);
  const before = JSON.parse(await readFile(path.join(fixture.runtime, 'before.json'), 'utf8'));
  const exitRecord = {launchId, pid: child.pid, ...result, endedAt: new Date().toISOString(), closed: true, synthetic: true, ...(mode === 'unsafe' ? {originalUnchanged: JSON.stringify(before) === JSON.stringify(after)} : {})};
  await json(path.join(fixture.runtime, 'exit.json'), exitRecord);
  await appendFile(path.join(fixture.runtime, 'exits.jsonl'), JSON.stringify(exitRecord) + '\n', {mode: 0o600});
  process.exitCode = result.code || (result.signal ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--unsafe') ? 'unsafe' : 'safe';
  if (process.argv.includes('--help')) console.log('Usage: node tests/private-storage-qa-native.mjs [--safe|--unsafe] [--prepare]\nSynthetic current-kernel fixture; prepare/help do not launch or validate the native GUI.');
  else if (process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareStorageQa(mode)));
  else await launch(mode);
}
