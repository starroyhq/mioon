/** Isolated synthetic packaged-native SDR acceptance. UI input is performed
 * separately through supported CUA. This helper never drives UI or calls RPCs
 * after preparation; audits use read-only SQLite and synthetic media only. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDirectory } from '../packages/contracts/src/private-storage.ts';
import { openStore, createServices } from '../packages/business/src/index.ts';
import { createWorkspacePreferences } from '../packages/business/src/workspace-preferences.ts';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'evidence/sdr-lut/native-final');
const runtime = path.join(root, 'private-runtime'), report = path.join(root, 'report');
const userData = path.join(runtime, 'user-data'), workspace = path.join(userData, 'workspace');
const fixtureFile = path.join(runtime, 'fixture.json');
const executable = path.join(repo, 'release/desktop/production/linux-unpacked/mioon');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function save(name, value) { assert.match(name, /^[a-z0-9-]+\.json$/); await writeFile(path.join(report, name), json(value), { mode: 0o600, flag: 'wx' }); }
async function fileHash(file) { const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 512 * 1024 * 1024); return { bytes: stat.size, sha256: sha(await readFile(file)) }; }
function environment() {
  return { ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
    MIOON_DESKTOP_USER_DATA: userData, MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe' };
}
function ownedChild(child) {
  let closed = false;
  const done = new Promise(resolve => { let error; child.on('error', e => { error = e.message; }); child.once('close', (code, signal) => { closed = true; resolve({ code, signal, ...(error ? { error } : {}) }); }); });
  return { child, done, get closed() { return closed; }, async stop() { if (!closed) child.kill('SIGTERM'); return await done; } };
}
async function command(binary, args, label) {
  const stdout = await open(path.join(runtime, label + '.stdout'), 'wx', 0o600), stderr = await open(path.join(runtime, label + '.stderr'), 'wx', 0o600);
  const owned = ownedChild(spawn(binary, args, { cwd: repo, env: environment(), stdio: ['ignore', stdout.fd, stderr.fd] }));
  let timer;
  try { const result = await Promise.race([owned.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic media command timeout')), 60000); })]); assert.deepEqual(result, { code: 0, signal: null }); return result; }
  catch (e) { await owned.stop(); throw e; }
  finally { clearTimeout(timer); await stdout.close(); await stderr.close(); }
}
async function prepare() {
  for (const dir of [root, runtime, report, userData]) ensurePrivateDirectory(dir, { create: true });
  assert.equal(await exists(fixtureFile), false, 'Use existing fixture with launch/reopen; never overwrite');
  const source = path.join(runtime, 'synthetic-rec709-green.mp4');
  await command('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv', '-movflags', '+faststart', '-n', source], 'source-media');
  const lutFile = path.join(runtime, 'synthetic-swap-red-green.cube');
  const cube = ['TITLE "Synthetic Rec709 creative R-G swap"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b <= 1; b++) for (let g = 0; g <= 1; g++) for (let r = 0; r <= 1; r++) cube.push(`${g} ${r} ${b}`);
  await writeFile(lutFile, cube.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  const store = openStore(workspace), services = createServices(store, new Map()); let fixture;
  try {
    const project = await services.call('project.create', { name: 'Rec.709 SDR LUT · 合成原生验收' });
    const asset = await services.call('asset.import', { projectId: project.id, name: 'Synthetic Rec709 green.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(source)).toString('base64') });
    let timeline = await services.call('timeline.format.set', { projectId: project.id, expectedProjectRevision: project.revision, expectedRevision: 0, requestId: randomUUID(), presetId: 'landscape_720' });
    timeline = await services.call('timeline.clip.add', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: asset.id, trackId: timeline.tracks.find(t => t.kind === 'video').id, startFrame: 0, durationFrames: 90, name: 'Synthetic SDR clip' });
    const clip = timeline.clips[0], state = defaultWorkspaceState();
    state.activeMode = 'editing'; state.editing.selectedClipId = clip.id; state.editing.quickAssetId = null; state.editing.previewKind = 'source'; state.shared.inspectorCollapsed = false; delete state.shared.assetSearch;
    createWorkspacePreferences(store).put(project.id, { expectedRevision: 0, state });
    const storedAsset = JSON.parse(store.db.prepare('SELECT data FROM assets WHERE id=?').get(asset.id).data);
    fixture = { synthetic: true, id: randomUUID(), projectId: project.id, timelineId: timeline.id, clipId: clip.id, assetId: asset.id, originalClip: clip, baseRevision: timeline.revision, sourceHash: asset.sha256, sourceRelativePath: storedAsset.relativePath, sourceFile: source, sourceFileHash: await fileHash(source), lutFile, lutFileHash: await fileHash(lutFile), userData, workspace };
  } finally { await services.drain(); store.close(); }
  await writeFile(fixtureFile, json(fixture), { mode: 0o600, flag: 'wx' }); await save('fixture.json', fixture); await audit('prepared');
  for (const label of ['first', 'reopen']) await writeFile(path.join(runtime, 'launch-' + label + '.sh'), `#!/bin/bash\nset -e\ncd ${JSON.stringify(repo)}\nexec ${JSON.stringify(process.execPath)} tests/timeline-colour-qa-native.mjs launch ${label}\n`, { mode: 0o700, flag: 'wx' });
  return fixture;
}
async function audit(label) {
  assert.match(label, /^[a-z0-9-]{1,40}$/); const fixture = await readJson(fixtureFile), rows = {};
  const db = new DatabaseSync(path.join(workspace, 'workbench.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 129").all(); assert.ok(names.length <= 128);
    for (const { name } of names) { assert.match(name, /^[a-z_]+$/); rows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all(); assert.ok(rows[name].length <= 1000); }
    db.exec('COMMIT');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  const media = []; for (const name of (await readdir(path.join(workspace, 'media'))).sort()) media.push({ name, ...await fileHash(path.join(workspace, 'media', name)) });
  const draftPath = path.join(workspace, 'local-drafts-v1.json');
  const result = { synthetic: true, at: new Date().toISOString(), tables: Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, { count: value.length, sha256: sha(json(value)) }])),
    timeline: rows.timelines.map(row => JSON.parse(row.data)).find(t => t.id === fixture.timelineId), requests: rows.timeline_requests, history: rows.timeline_history,
    editTasks: rows.edit_tasks, exports: rows.exports.map(row => JSON.parse(row.data)), assets: rows.assets.map(row => JSON.parse(row.data)), lutResources: rows.project_lut_resources, lutRequests: rows.lut_import_requests,
    draft: await exists(draftPath) ? await readJson(draftPath) : null, media, originalSource: await fileHash(path.join(workspace, fixture.sourceRelativePath)) };
  assert.equal(result.originalSource.sha256, fixture.sourceHash); await save(label + '-audit.json', result);
  return { label, revision: result.timeline.revision, colour: result.timeline.clips[0].colour, exports: result.exports.map(e => ({ id: e.id, status: e.status, purpose: e.purpose })), tables: result.tables };
}
async function launch(label) {
  assert.ok(['first', 'reopen'].includes(label)); await readJson(fixtureFile);
  assert.equal(await exists(path.join(workspace, 'server.lock')), false, 'No restart while backend owner remains');
  const log = await open(path.join(runtime, label + '-native.log'), 'wx', 0o600);
  const owned = ownedChild(spawn(executable, [], { cwd: repo, env: environment(), stdio: ['ignore', log.fd, log.fd] }));
  const initial = { at: new Date().toISOString(), label, pid: owned.child.pid, executable, executableHash: await fileHash(executable), asarHash: await fileHash(path.join(path.dirname(executable), 'resources/app.asar')), argv: [], sandboxUnchanged: true, debugging: false };
  await save(label + '-launch.json', initial); let timer;
  try {
    const result = await Promise.race([owned.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native UI observation budget ended')), 30 * 60 * 1000); })]);
    const until = Date.now() + 45000; while (await exists(path.join(workspace, 'server.lock')) && Date.now() < until) await pause(250);
    const backendLockReleased = !await exists(path.join(workspace, 'server.lock'));
    await save(label + '-exit.json', { ...initial, endedAt: new Date().toISOString(), result, backendLockReleased });
    assert.deepEqual(result, { code: 0, signal: null }); assert.ok(backendLockReleased); await audit(label + '-exit');
  } catch (e) { await owned.stop(); throw e; } finally { clearTimeout(timer); await log.close(); }
}
async function final() {
  const fixture = await readJson(fixtureFile), imported = await readJson(path.join(report, 'imported-audit.json')), saved = await readJson(path.join(report, 'saved-audit.json')), undone = await readJson(path.join(report, 'undo-audit.json')), redone = await readJson(path.join(report, 'redo-audit.json')), result = await readJson(path.join(report, 'reopen-exit-audit.json'));
  assert.equal(imported.timeline.revision, fixture.baseRevision, 'Import must not save the clip');
  assert.deepEqual(imported.timeline.clips[0], fixture.originalClip);
  assert.equal(imported.lutResources.length, 1); assert.equal(imported.lutRequests.length, 1);
  assert.equal(imported.lutResources[0].sha256, fixture.lutFileHash.sha256);
  assert.equal(imported.lutRequests[0].resourceId, imported.lutResources[0].id);
  assert.equal(saved.timeline.revision, fixture.baseRevision + 1); assert.equal(saved.timeline.clips[0].colour.source.assetSha256, fixture.sourceHash);
  assert.equal(saved.timeline.clips[0].colour.source.range, 'limited'); assert.equal(saved.timeline.clips[0].colour.look.enabled, true); assert.equal(saved.timeline.clips[0].colour.look.strength, 0.65);
  assert.equal(saved.timeline.clips[0].colour.look.resourceId, imported.lutResources[0].id); assert.equal(saved.timeline.clips[0].colour.look.resourceSha256, fixture.lutFileHash.sha256);
  assert.equal(saved.editTasks.length, 1); assert.equal(saved.editTasks[0].status, 'applied'); assert.equal(saved.editTasks[0].acknowledged, 1);
  assert.equal(undone.timeline.clips[0].colour, undefined); assert.deepEqual(redone.timeline.clips[0].colour, saved.timeline.clips[0].colour); assert.deepEqual(result.timeline.clips[0].colour, saved.timeline.clips[0].colour);
  assert.equal(result.originalSource.sha256, fixture.sourceHash); assert.ok(result.draft.entries.every(e => e.draft === null));
  const outputs = [];
  for (const purpose of ['preview', 'export']) {
    const items = result.exports.filter(e => e.status === 'succeeded' && e.purpose === purpose); assert.ok(items.length >= 1, `Missing successful ${purpose}`);
    const record = items.at(-1), asset = result.assets.find(a => a.id === record.assetId); assert.ok(asset); assert.match(asset.relativePath, /^media\/[a-zA-Z0-9._-]+\.mp4$/);
    const file = path.join(workspace, asset.relativePath);
    await command('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], purpose + '-probe');
    const probe = await readJson(path.join(runtime, purpose + '-probe.stdout')), video = probe.streams.find(s => s.codec_type === 'video');
    for (const key of ['color_space', 'color_transfer', 'color_primaries']) assert.equal(video[key], 'bt709'); assert.equal(video.color_range, 'tv'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(Number(video.nb_frames), 90);
    await command('/usr/bin/ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], purpose + '-decode');
    outputs.push({ purpose, id: record.id, fileHash: await fileHash(file), colourPlan: record.snapshot?.colourPlan ?? null, video, decodeExit: 0 });
  }
  const summary = { synthetic: true, platform: 'linux-x64', packagedProduction: true, sourceUnchanged: true, undoRedoExact: true, savedColour: saved.timeline.clips[0].colour, reopenedColourExact: true, draftCleared: true, output: outputs, launches: await Promise.all(['first', 'reopen'].map(label => readJson(path.join(report, label + '-exit.json')))), macOSVerified: false, hdrLogSupported: false, imageWorkflowVerified: false };
  await save('summary.json', summary); return summary;
}
const [action, label] = process.argv.slice(2);
if (action === 'prepare') console.log(json(await prepare())); else if (action === 'audit') console.log(json(await audit(label))); else if (action === 'launch') await launch(label); else if (action === 'final') console.log(json(await final())); else throw Error('Expected prepare/audit/launch/final');
