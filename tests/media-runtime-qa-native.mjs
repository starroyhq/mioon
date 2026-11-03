/** Ordinary sandboxed native Q3 fixture. All media/data are synthetic. The
 * launcher observes only children of its own Electron/backend processes; it
 * never drives the renderer or uses the app's authentication token. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, writeFile, appendFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {prepareNativeQaProject, closeQaProject, captureNativeQa} from './helpers/native-local-qa-fixture.ts';
import {readQaFixture} from './helpers/kernel-qa-fixture.mjs';
import {ownQaChild} from './helpers/qa-owned-child.mjs';
import {fileInfo, probe, safePath} from '@mioon/business/media';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';

const repo = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.resolve(process.env.MIOON_QA_FIXTURE_ROOT || path.join(repo, 'evidence/q3-media-runtime/native-kernel'));
const userData = path.join(runtime, 'user-data');
const workspace = path.join(userData, 'data');
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function prepareMediaNativeFixture() {
  ensurePrivateDirectory(runtime, {create: true});
  const previous = readQaFixture(path.join(runtime, 'fixture.json'), workspace);
  if (previous) return previous;
  if (existsSync(path.join(workspace, 'app-library.db'))) throw Error('Partial QA data must be preserved; choose a fresh MIOON_QA_FIXTURE_ROOT');
  ensurePrivateDirectory(userData, {create: true});
  const projects = [], bytes = await readFile(path.join(repo, 'examples/synthetic/reference.png'));
  for (const [name, frames] of [['Q3 · 实际媒体导出', 60], ['Q3 · 长导出退出恢复', 18000]]) {
    const prepared = await prepareNativeQaProject(workspace, name), {store, services, project} = prepared;
    try {
      const asset = await services.call('asset.import', {projectId: project.id, name: 'synthetic-reference.png', mimeType: 'image/png', dataBase64: bytes.toString('base64')});
      const timeline = await services.call('timeline.get', {projectId: project.id});
      await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision,
        requestId: randomUUID(), assetId: asset.id, trackId: timeline.tracks.find(track => track.kind === 'video').id, startFrame: 0, durationFrames: frames});
      projects.push({id: project.id, name, assetId: asset.id, frames, projectDir: store.projectDir, localDir: store.localDir, projectFile: store.projectFile});
    } finally {await closeQaProject(prepared);}
  }
  const fixture = {synthetic: true, kernel: true, runtime, userData, workspace, projects};
  await json(path.join(runtime, 'fixture.json'), fixture);
  return fixture;
}

export async function auditMediaNativeFixture() {
  // Cold only: the real B1 opener rejects any live native owner before project SQL.
  const snapshot = captureNativeQa(workspace), rows = table => snapshot.rows[table].map(row => JSON.parse(row.data));
  const assets = rows('assets'), exports = rows('exports');
  const published = exports.filter(row => row.status === 'succeeded').map(row => assets.find(asset => asset.id === row.assetId));
  const report = {synthetic: true, kernel: true, projects: rows('projects').map(({id, name}) => ({id, name})),
    exports: exports.map(({id, projectId, status, error, assetId, snapshot}) => ({id, projectId, status, error, assetId,
      frames: snapshot?.timeline?.clips?.map(clip => clip.durationFrames)})),
    assets: assets.map(({id, projectId, kind, sha256, sizeBytes, width, height, duration}) => ({id, projectId, kind, sha256, sizeBytes, width, height, duration})),
    generationJobs: snapshot.rows.jobs.length, agentRuns: snapshot.rows.mio_runs.length, agentCounter: 'mio_runs',
    storage: snapshot};
  report.verifiedOutputs = [];
  for (const asset of published) {
    if (!asset) throw Error('Synthetic export asset missing');
    const location = snapshot.locations[asset.projectId];
    if (!location) throw Error('Synthetic export belongs to an unregistered project');
    const file = await safePath(location.projectDir, asset.relativePath), actual = await fileInfo(file), metadata = await probe(file);
    if (actual.sha256 !== asset.sha256 || actual.sizeBytes !== asset.sizeBytes) throw Error('Synthetic export bytes differ from publication');
    report.verifiedOutputs.push({assetId: asset.id, ...actual, codec: metadata.codec, matchesPublishedBytes: true});
  }
  return report;
}

// Linux-only observation evidence; this is not the product's termination API.
async function identity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const [comm, stat] = await Promise.all([readFile(`/proc/${pid}/comm`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
    return {pid, comm: comm.trim(), startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]};
  } catch (error) {if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error;}
}
async function ownMediaChildren(backendPid) {
  if (process.platform !== 'linux') return [];
  try {
    // This desktop's virtualized task/children files are empty even for a
    // verified direct child. Inspect bounded PID/parent metadata only; never
    // read environment/argv or retain unrelated process information.
    const ids = (await readdir('/proc')).filter(value => /^\d+$/u.test(value));
    if (ids.length > 16384) throw Error('Synthetic process metadata audit exceeded its bound');
    const records = await Promise.all(ids.map(async id => {
      try {
        const stat = await readFile(`/proc/${id}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[1]) !== backendPid) return null;
        const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        if (!['ffmpeg', 'ffprobe'].includes(comm)) return null;
        return {pid: Number(id), comm, startTicks: fields[19]};
      } catch (error) {if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null; throw error;}
    }));
    return records.filter(Boolean);
  } catch (error) {if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; throw error;}
}
function nativeEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return {...env, MIOON_DESKTOP_USER_DATA: userData, MIOON_ENABLE_LIVE_PROVIDER: '0',
    MIOON_FFMPEG_PATH: process.env.MIOON_FFMPEG_PATH || '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: process.env.MIOON_FFPROBE_PATH || '/usr/bin/ffprobe'};
}

async function launch() {
  if (process.platform !== 'linux') throw Error('Native process observation requires Linux; prepare/audit are headless');
  await prepareMediaNativeFixture();
  try {
    const previous = JSON.parse(await readFile(path.join(runtime, 'launch.json'), 'utf8'));
    let exited;
    try {exited = JSON.parse(await readFile(path.join(runtime, 'exit.json'), 'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (previous.launchId !== exited?.launchId && await identity(previous.pid)) throw Error('Previous synthetic native launch is still running');
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const binary = createRequire(import.meta.url)('electron'), launchId = randomUUID();
  const mainSha256 = createHash('sha256').update(await readFile(path.join(repo, 'apps/desktop/build/main.cjs'))).digest('hex');
  const backendSha256 = createHash('sha256').update(await readFile(path.join(repo, 'apps/desktop/build/backend.cjs'))).digest('hex');
  const child = spawn(binary, [path.join(repo, 'apps/desktop/build')], {cwd: repo, env: nativeEnvironment(), stdio: ['ignore', 'pipe', 'pipe']});
  let logTail = Promise.resolve(), ended = false, backend, observerBusy = false;
  const owned = ownQaChild(child), outcome = owned.done.then(result => {ended = true; return result;});
  const seen = new Map();
  for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream.on('data', bytes => {
    logTail = logTail.then(() => appendFile(path.join(runtime, `${launchId}.${kind}.log`), bytes, {mode: 0o600}));
  });
  const launchRecord = {launchId, pid: child.pid, fixturePid: process.pid, startedAt: new Date().toISOString(), synthetic: true,
    sandboxUnchanged: true, remoteDebugging: false, smokeHooks: false,
    mainSha256, backendSha256};
  try {await json(path.join(runtime, 'launch.json'), launchRecord);
    await appendFile(path.join(runtime, 'launches.jsonl'), JSON.stringify(launchRecord) + '\n', {mode: 0o600});
  } catch (error) {await owned.stop();throw error;}
  const observe = async () => {
    if (observerBusy || ended) return;
    observerBusy = true;
    try {
      if (!backend) {
        try {
          // The descriptor is read only to identify this launch's backend. Its
          // token is never logged, copied, used in requests or exposed to UI.
          const connection = JSON.parse(await readFile(path.join(userData, 'mcp-connection.json'), 'utf8'));
          const status = await readFile(`/proc/${connection.pid}/status`, 'utf8');
          if (Number(/^PPid:\s+(\d+)$/mu.exec(status)?.[1]) === child.pid) backend = await identity(connection.pid);
        } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
      }
      if (backend) for (const record of await ownMediaChildren(backend.pid)) {
        const key = `${record.pid}:${record.startTicks}`;
        if (!seen.has(key)) {seen.set(key, {...record, observedAt: new Date().toISOString()});
          await appendFile(path.join(runtime, `${launchId}.media.jsonl`), JSON.stringify(seen.get(key)) + '\n', {mode: 0o600});}
      }
    } finally {observerBusy = false;}
  };
  let observationFailure;
  const timer = setInterval(() => {void observe().catch(error => {observationFailure = error.code || 'OBSERVATION_FAILED';});}, 100);
  try {
    const result = await outcome;
    clearInterval(timer);
    while (observerBusy) await pause(10);
    await logTail;
    let remaining = [];
    for (const deadline = Date.now() + 45000;;) {
      remaining = [];
      for (const record of [...seen.values(), ...(backend ? [backend] : [])]) {
        const current = await identity(record.pid);
        if (current?.startTicks === record.startTicks) remaining.push(record);
      }
      if (!remaining.length || Date.now() >= deadline) break;
      await pause(100);
    }
    if (!backend) observationFailure ||= 'BACKEND_NOT_OBSERVED';
    const exit = {...result, launchId, pid: child.pid, endedAt: new Date().toISOString(), synthetic: true,
      backend, observedMedia: [...seen.values()], remainingOwnedProcesses: remaining, observationFailure,
      audit: !backend || remaining.length ? null : await auditMediaNativeFixture()};
    await json(path.join(runtime, 'exit.json'), exit);
    await appendFile(path.join(runtime, 'exits.jsonl'), JSON.stringify(exit) + '\n', {mode: 0o600});
    process.exitCode = result.code || (result.signal || remaining.length || observationFailure ? 1 : 0);
  } finally {clearInterval(timer);}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Synthetic Q3: --prepare seeds two real kernel projects; launch observes owned Linux native/media processes; --audit is cold only after normal quit/backend exit. Use a fresh MIOON_QA_FIXTURE_ROOT; no GUI verification is implied by prepare.');
  else if (process.argv.includes('--prepare')) console.log(JSON.stringify(await prepareMediaNativeFixture(), null, 2));
  else if (process.argv.includes('--audit')) console.log(JSON.stringify(await auditMediaNativeFixture(), null, 2));
  else await launch();
}
