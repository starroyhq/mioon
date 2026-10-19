/** Synthetic mixed-image native QA. Preparation is the only fixture mutation.
 * All later product changes must come from ordinary supported native UI input.
 * Audits open SQLite read-only. Cold backup/restore uses the public offline CLI.
 * Never launches a browser driver, injects RPCs, changes fuses, disables sandbox,
 * removes a backend lock, or accesses a provider/network/deployment service. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile, writeFile, readdir, lstat, open, mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {openStore, createServices} from '../packages/business/src/index.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {inspectStaticSrgbPng} from '../packages/business/src/timeline-image-admission.ts';
import {timelineColourInputFilter} from '../packages/business/src/timeline-colour-lut.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'evidence/mixed-images/native');
const runtime = path.join(root, 'private-runtime'), report = path.join(root, 'report');
const userData = path.join(runtime, 'user-data'), workspace = path.join(userData, 'workspace');
const restoredUserData = path.join(runtime, 'restored-user-data'), restoredWorkspace = path.join(restoredUserData, 'workspace');
const backup = path.join(runtime, 'verified-schema32-backup');
const fixtureFile = path.join(runtime, 'fixture.json');
const executable = path.join(repo, 'release/desktop/production/linux-unpacked/mioon');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const stamp = () => new Date().toISOString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = name => { assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/u); return '"' + name + '"'; };
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readJson(file) { const s = await lstat(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.size < 32 * 1024 * 1024); return JSON.parse(await readFile(file, 'utf8')); }
async function save(name, value) { assert.match(name, /^[a-z0-9-]+\.json$/u); const bytes = Buffer.from(json(value)); assert.ok(bytes.length < 32 * 1024 * 1024); await writeFile(path.join(report, name), bytes, {mode: 0o600, flag: 'wx'}); }
async function fileHash(file, max = 512 * 1024 * 1024) {
  const before = await lstat(file); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= max);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let count = 0;
  try {
    for (;;) { const {bytesRead} = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; count += bytesRead; assert.ok(count <= max); digest.update(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat(); for (const key of ['dev', 'ino', 'size', 'mtimeMs']) assert.equal(after[key], before[key], 'File changed while hashing'); assert.equal(count, before.size);
  } finally { await handle.close(); }
  return {bytes: count, sha256: digest.digest('hex')};
}
async function tree(directory) {
  const files = {}; let count = 0, bytes = 0;
  async function visit(relative, depth) {
    assert.ok(depth < 9 && ++count <= 512); const file = path.join(directory, relative), s = await lstat(file); assert.ok(!s.isSymbolicLink());
    if (s.isDirectory()) { for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name), depth + 1); }
    else { files[relative] = await fileHash(file); bytes += files[relative].bytes; assert.ok(bytes < 1024 * 1024 * 1024); }
  }
  await visit('', 0); return files;
}
function environment(data = userData) {
  return {...Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
    MIOON_DESKTOP_USER_DATA: data, MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', MIOON_FFPROBE_PATH: '/usr/bin/ffprobe'};
}
function own(child) {
  let closed = false;
  const done = new Promise(resolve => { let error; child.on('error', e => { error = e.message; }); child.once('close', (code, signal) => { closed = true; resolve({code, signal, ...(error ? {error} : {})}); }); });
  return {child, done, get closed() { return closed; }, async stop() {
    if (closed) return done; child.kill('SIGTERM'); let timer;
    try { return await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned child cleanup unconfirmed; do not relaunch')), 10000); })]); }
    finally { clearTimeout(timer); }
  }};
}
async function command(binary, args, label) {
  assert.match(label, /^[a-z0-9-]{1,60}$/u);
  const stdout = await open(path.join(runtime, label + '.stdout'), 'wx', 0o600), stderr = await open(path.join(runtime, label + '.stderr'), 'wx', 0o600);
  const owned = own(spawn(binary, args, {cwd: repo, env: environment(), stdio: ['ignore', stdout.fd, stderr.fd]})); let timer;
  try {
    const result = await Promise.race([owned.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bounded offline command timed out')), 120000); })]);
    await save(label + '-command.json', {synthetic: true, at: stamp(), binary, args, result}); assert.deepEqual(result, {code: 0, signal: null});
    assert.ok((await lstat(path.join(runtime, label + '.stdout'))).size < 4 * 1024 * 1024); return result;
  } catch (e) { await owned.stop(); throw e; } finally { clearTimeout(timer); await stdout.close(); await stderr.close(); }
}
async function cold(directory) {
  assert.equal(await exists(path.join(directory, 'server.lock')), false, 'Close the exact owned backend normally; never remove its lock');
  for (const suffix of ['-wal', '-journal']) { const file = path.join(directory, 'workbench.sqlite' + suffix); if (await exists(file)) assert.equal((await lstat(file)).size, 0, 'Checkpointed cold SQLite required'); }
}
function rawTable(db, name, columns) {
  columns ??= db.prepare(`PRAGMA table_info(${q(name)})`).all().map(r => r.name); assert.ok(columns.length <= 64);
  const budget = db.prepare(`SELECT count(*) AS n, coalesce(sum(${columns.map(c => `coalesce(length(CAST(${q(c)} AS BLOB)),0)`).join('+')}),0) AS bytes FROM ${q(name)}`).get();
  assert.ok(budget.n <= 1000 && budget.bytes <= 8 * 1024 * 1024);
  const rows = db.prepare(`SELECT CAST(rowid AS TEXT) AS capturedRowid,${columns.flatMap((c, n) => [`typeof(${q(c)}) AS t${n}`, `hex(CAST(${q(c)} AS BLOB)) AS v${n}`]).join(',')} FROM ${q(name)} ORDER BY rowid`).all();
  return {columns, rows: rows.map(r => ({rowid: r.capturedRowid, values: columns.map((_, n) => ({type: r['t' + n], hex: r['v' + n]}))}))};
}
function cell(row, table, column) { const c = row.values[table.columns.indexOf(column)]; assert.ok(c); return c.type === 'null' ? null : Buffer.from(c.hex, 'hex').toString('utf8'); }
function decode(table, column = 'data') { return table.rows.map(r => JSON.parse(cell(r, table, column))); }
function readDb(directory, callback) {
  const db = new DatabaseSync(path.join(directory, 'workbench.sqlite'), {readOnly: true});
  try { db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN'); const value = callback(db); db.exec('COMMIT'); return value; }
  finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}
async function fixture() { const f = await readJson(fixtureFile); assert.equal(f.synthetic, true); assert.equal(f.workspace, workspace); return f; }
async function writeLauncher(label) {
  await writeFile(path.join(runtime, 'launch-' + label + '.sh'), `#!/bin/bash\nset -e\ncd ${JSON.stringify(repo)}\nexec ${JSON.stringify(process.execPath)} tests/timeline-image-qa-native.mjs launch ${label}\n`, {mode: 0o700, flag: 'wx'});
}
async function prepare() {
  await mkdir(path.dirname(root), {recursive: true}); ensurePrivateDirectory(root, {create: true});
  for (const dir of [runtime, report]) { assert.equal(await exists(dir), false, 'Preserve any earlier fixture; never silently resume or overwrite preparation'); ensurePrivateDirectory(dir, {create: true}); }
  ensurePrivateDirectory(userData, {create: true});
  const source = path.join(runtime, 'synthetic-rec709-green.mp4'), image = path.join(runtime, 'synthetic-untagged-rgba.png'), replacement = path.join(runtime, 'synthetic-replacement-rgba.png');
  await command('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv', '-movflags', '+faststart', '-n', source], 'prepare-video');
  const pixels = (x, y) => x < 96 ? [255, 0, 255, 0] : x < 224 ? [128, 128, 128, 128] : y < 90 ? [240, 90, 20, 255] : [20, 80, 230, 255];
  await writeFile(image, png({width: 320, height: 180, tagged: false, pixel: pixels}), {mode: 0o600, flag: 'wx'});
  await writeFile(replacement, png({width: 320, height: 180, tagged: false, pixel: (x, y) => x < 96 ? [0, 255, 255, 0] : x < 224 ? [176, 176, 176, 128] : pixels(x, y)}), {mode: 0o600, flag: 'wx'});
  const originalEnvironment = {MIOON_FFMPEG_PATH: process.env.MIOON_FFMPEG_PATH, MIOON_FFPROBE_PATH: process.env.MIOON_FFPROBE_PATH};
  process.env.MIOON_FFMPEG_PATH = '/usr/bin/ffmpeg'; process.env.MIOON_FFPROBE_PATH = '/usr/bin/ffprobe';
  const store = openStore(workspace), services = createServices(store, new Map()); let f;
  try {
    const project = await services.call('project.create', {name: 'PNG 与视频混合 SDR · 合成验收'}), assets = {};
    for (const [key, file, mimeType] of [['video', source, 'video/mp4'], ['image', image, 'image/png'], ['replacement', replacement, 'image/png']]) {
      const imported = await services.call('asset.import', {projectId: project.id, name: path.basename(file), mimeType, dataBase64: (await readFile(file)).toString('base64')});
      assets[key] = {...store.get('assets', imported.id), fixtureFile: file, fixtureHash: await fileHash(file)};
    }
    assert.notEqual(assets.image.sha256, assets.replacement.sha256);
    const videoInspection = await services.call('timeline.colour.source.inspect', {projectId: project.id, assetId: assets.video.id}); assert.equal(videoInspection.status, 'compatible');
    const videoColour = {profileId: 'mioon-rec709-sdr-clip-v1', source: {assetSha256: assets.video.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp()}, look: null};
    let timeline = await services.call('timeline.format.set', {projectId: project.id, expectedProjectRevision: project.revision, expectedRevision: 0, requestId: randomUUID(), presetId: 'landscape_720'});
    const mutate = async (operation, extra) => { timeline = await services.call(operation, {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...extra}); };
    await mutate('timeline.clip.add', {assetId: assets.video.id, trackId: timeline.tracks.find(t => t.kind === 'video').id, startFrame: 0, sourceInFrame: 0, durationFrames: 90, name: 'Rec709 green background', colour: videoColour});
    const videoClipId = timeline.clips[0].id;
    await mutate('timeline.track.add', {kind: 'video', name: 'PNG overlay'});
    const imageTrack = timeline.tracks.find(t => t.name === 'PNG overlay');
    await mutate('timeline.clip.add', {assetId: assets.image.id, trackId: imageTrack.id, startFrame: 0, sourceInFrame: 0, durationFrames: 90, name: 'Untagged RGBA: confirm sRGB', rect: {x: 320, y: 180, width: 640, height: 360}});
    const imageClipId = timeline.clips.find(c => c.assetId === assets.image.id).id;
    await mutate('timeline.subtitle.add', {text: 'Mixed SDR subtitle', startFrame: 30, durationFrames: 30});
    assert.equal(Object.hasOwn(timeline.clips.find(c => c.id === imageClipId), 'colour'), false);
    const state = defaultWorkspaceState(); state.activeMode = 'editing'; state.editing.selectedClipId = imageClipId; state.editing.previewKind = 'source'; state.shared.inspectorCollapsed = false; delete state.shared.assetSearch;
    createWorkspacePreferences(store).put(project.id, {expectedRevision: 0, state});
    f = {synthetic: true, id: randomUUID(), at: stamp(), userData, workspace, restoredUserData, restoredWorkspace, backup, projectId: project.id, timelineId: timeline.id, videoClipId, imageClipId, imageTrackId: imageTrack.id, baseRevision: timeline.revision, initialTimeline: timeline, assets, videoInspection,
      expectedImageEvidence: await inspectStaticSrgbPng(await readFile(image)), setupOnly: 'Video interpretation and imports were seeded. Image inspection/interpretation/save/undo/redo/replacement/export must be performed through native UI after preparation.'};
  } finally { await services.drain(); store.close(); for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  await writeFile(fixtureFile, json(f), {mode: 0o600, flag: 'wx'}); await save('fixture.json', f); await audit('prepared');
  for (const label of ['first', 'reopen']) await writeLauncher(label);
  return {synthetic: true, projectId: f.projectId, imageClipId: f.imageClipId, baseRevision: f.baseRevision, userData, commands: ['launch-first.sh', 'launch-reopen.sh'].map(name => path.join(runtime, name))};
}
async function audit(label, branch = 'original') {
  assert.match(label, /^[a-z0-9-]{1,45}$/u); assert.ok(['original', 'restored'].includes(branch)); const f = await fixture(), directory = branch === 'restored' ? restoredWorkspace : workspace;
  const raw = readDb(directory, db => {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 129").all(); assert.ok(names.length <= 128);
    return Object.fromEntries(names.map(({name}) => [name, rawTable(db, name)]));
  });
  assert.ok(Buffer.byteLength(json(raw)) < 24 * 1024 * 1024);
  const assets = decode(raw.assets), originals = {};
  for (const [name, asset] of Object.entries(f.assets)) {
    assert.match(asset.relativePath, /^media\/[a-zA-Z0-9._-]+$/u); originals[name] = {managed: await fileHash(path.join(directory, asset.relativePath)), fixture: await fileHash(asset.fixtureFile)};
    assert.equal(originals[name].managed.sha256, asset.sha256); assert.deepEqual(originals[name].fixture, asset.fixtureHash);
  }
  const draftFile = path.join(directory, 'local-drafts-v1.json'), timeline = decode(raw.timelines).find(t => t.id === f.timelineId);
  const result = {synthetic: true, at: stamp(), branch, schemaVersion: readDb(directory, db => db.prepare('SELECT max(version) AS n FROM schema_version').get().n),
    tables: Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, {count: value.rows.length, sha256: sha(json(value))}])), raw, timeline, assets, exports: decode(raw.exports),
    draft: await exists(draftFile) ? await readJson(draftFile) : null, media: await tree(path.join(directory, 'media')), originals};
  await save(label + '-audit.json', result);
  return {label, branch, schemaVersion: result.schemaVersion, revision: timeline.revision, imageClip: timeline.clips.find(c => c.id === f.imageClipId), exports: result.exports.map(e => ({id: e.id, status: e.status, purpose: e.purpose}))};
}
async function artifacts() {
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder')), dependencies = createRequire(builder.resolve('app-builder-lib'));
  const asar = dependencies('@electron/asar'), {getCurrentFuseWire, FuseV1Options} = dependencies('@electron/fuses');
  const archive = path.join(path.dirname(executable), 'resources/app.asar'), metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.equal(metadata.name, 'mioon-desktop'); assert.equal(metadata.mioonDesktop.channel, 'production');
  const wire = await getCurrentFuseWire(executable), fuses = {};
  for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']) { assert.equal(wire[FuseV1Options[name]], 48); fuses[name] = false; }
  for (const name of ['EnableCookieEncryption', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) { assert.equal(wire[FuseV1Options[name]], 49); fuses[name] = true; }
  return {executable: await fileHash(executable), asar: await fileHash(archive), helper: await fileHash(fileURLToPath(import.meta.url)), ffmpeg: await fileHash('/usr/bin/ffmpeg'), ffprobe: await fileHash('/usr/bin/ffprobe'), productionIdentity: metadata.mioonDesktop, fuses, subtitles: await tree(path.join(path.dirname(executable), 'resources/subtitles'))};
}
async function launch(label) {
  assert.ok(['first', 'reopen', 'restored'].includes(label)); await fixture(); const directory = label === 'restored' ? restoredWorkspace : workspace;
  await cold(directory); const frozenArtifacts = await artifacts();
  if (label !== 'first') { const first = await readJson(path.join(report, 'first-launch.json')); assert.deepEqual(frozenArtifacts, first.artifacts, 'Native reopen must use the exact unchanged production package and helper'); }
  if (label === 'restored') await readJson(path.join(report, 'cold-restore.json'));
  const log = await open(path.join(runtime, label + '-native.log'), 'wx', 0o600);
  const owned = own(spawn(executable, [], {cwd: repo, env: environment(label === 'restored' ? restoredUserData : userData), stdio: ['ignore', log.fd, log.fd]}));
  const initial = {synthetic: true, at: stamp(), label, pid: owned.child.pid, executable, artifacts: frozenArtifacts, argv: [], sandboxUnchanged: true, debugging: false, liveProviderEnabled: false};
  await save(label + '-launch.json', initial); let timer, failure, result;
  const stop = () => { failure ??= 'Launcher interrupted; not a normal UI exit'; owned.stop().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    result = await Promise.race([owned.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native observation budget ended')), 45 * 60 * 1000); })]);
  } catch (error) { failure = error.message; result = await owned.stop(); }
  finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await log.close(); }
  const until = Date.now() + 45000; while (await exists(path.join(directory, 'server.lock')) && Date.now() < until) await pause(250);
  const backendLockReleased = !await exists(path.join(directory, 'server.lock'));
  await save(label + '-exit.json', {...initial, endedAt: stamp(), result, backendLockReleased, normal: !failure && result.code === 0 && result.signal === null && !result.error, ...(failure ? {failure} : {})});
  assert.equal(failure, undefined); assert.deepEqual(result, {code: 0, signal: null}); assert.ok(backendLockReleased); await cold(directory);
  assert.deepEqual(await artifacts(), frozenArtifacts); await audit(label + '-exit', label === 'restored' ? 'restored' : 'original');
}
async function offline(commandName) {
  const args = ['apps/cli/src/backup.ts', commandName, ...(commandName === 'create' ? ['--source', workspace, '--destination', backup] : commandName === 'restore' ? ['--directory', backup, '--destination', restoredWorkspace] : ['--directory', backup])];
  await command(process.execPath, args, 'offline-' + commandName); const value = await readJson(path.join(runtime, 'offline-' + commandName + '.stdout')); assert.equal(value.ok, true); assert.equal(value.data.warnings, undefined);
  if (commandName === 'restore') { assert.equal(value.data.publication, 'confirmed'); assert.equal(value.data.databaseSchemaVersion, 33); }
  else { assert.equal(value.data.integrity, 'verified'); assert.equal(value.data.databaseSchemaVersion, 32); }
  return value.data;
}
function assertRestoreRaw(before, directory) {
  return readDb(directory, db => {
    for (const [name, original] of Object.entries(before)) { if (name === 'schema_version') continue; assert.deepEqual(rawTable(db, name, original.columns), original, 'Immediate restore exact original cells: ' + name); }
    for (const [name, target] of [['timeline_history', 'workspace_restore_timeline_history'], ['timeline_history_cursors', 'workspace_restore_timeline_cursors']]) assert.deepEqual(rawTable(db, target, before[name].columns), before[name], 'Exact history archive: ' + name);
    return {holds: rawTable(db, 'workspace_restore_holds'), history: rawTable(db, 'workspace_restore_timeline_history'), cursors: rawTable(db, 'workspace_restore_timeline_cursors')};
  });
}
async function coldRestore() {
  const exited = await readJson(path.join(report, 'first-exit.json')); assert.equal(exited.normal, true); assert.equal(exited.backendLockReleased, true); await cold(workspace);
  assert.equal(await exists(backup), false); assert.equal(await exists(restoredUserData), false); ensurePrivateDirectory(restoredUserData, {create: true});
  const sourceAudit = await readJson(path.join(report, 'first-exit-audit.json')); assert.equal(sourceAudit.schemaVersion, 32);
  const sourceDatabase = await fileHash(path.join(workspace, 'workbench.sqlite')), sourceMedia = await tree(path.join(workspace, 'media'));
  const created = await offline('create'), verified = await offline('verify'), backupFiles = await tree(backup), restored = await offline('restore'); await cold(restoredWorkspace);
  assert.deepEqual(await fileHash(path.join(workspace, 'workbench.sqlite')), sourceDatabase); assert.deepEqual(await tree(path.join(workspace, 'media')), sourceMedia); assert.deepEqual(await tree(backup), backupFiles);
  assert.deepEqual(await fileHash(path.join(backup, 'payload/workbench.sqlite')), sourceDatabase); assert.deepEqual(await tree(path.join(restoredWorkspace, 'media')), sourceMedia);
  const exact = assertRestoreRaw(sourceAudit.raw, restoredWorkspace);
  await save('cold-restore.json', {synthetic: true, at: stamp(), sourceSchema: 32, restoredSchema: 33, sourceDatabase, sourceMedia, backupFiles, created, verified, restored, exact});
  await audit('restored-before-launch', 'restored'); await writeLauncher('restored');
  return {synthetic: true, sourceSchema: 32, restoredSchema: 33, originalUnchanged: true, restoredOriginalCellsExact: true, launch: path.join(runtime, 'launch-restored.sh')};
}
const imageClip = (audit, f) => audit.timeline.clips.find(c => c.id === f.imageClipId);
const cleanDraft = audit => audit.draft === null || audit.draft.entries.every(e => e.draft === null);
async function verifyOutput(audit, purpose, f) {
  const record = audit.exports.filter(e => e.status === 'succeeded' && e.purpose === purpose).at(-1); assert.ok(record, 'Missing successful native UI ' + purpose);
  const asset = audit.assets.find(a => a.id === record.assetId); assert.ok(asset); assert.match(asset.relativePath, /^media\/[a-zA-Z0-9._-]+\.mp4$/u); const file = path.join(workspace, asset.relativePath);
  assert.equal(record.snapshot.colourPlan.profileId, 'mioon-mixed-sdr-render-v2'); const bindings = record.snapshot.colourPlan.clips;
  assert.equal(bindings.find(c => c.clipId === f.imageClipId).kind, 'image'); assert.equal(bindings.find(c => c.clipId === f.imageClipId).assetSha256, f.assets.image.sha256); assert.equal(bindings.find(c => c.clipId === f.videoClipId).kind, 'video');
  assert.deepEqual(record.snapshot.timeline.subtitles, f.initialTimeline.subtitles);
  await command('/usr/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], purpose + '-probe');
  const probe = await readJson(path.join(runtime, purpose + '-probe.stdout')), video = probe.streams.find(s => s.codec_type === 'video');
  for (const key of ['color_space', 'color_transfer', 'color_primaries']) assert.equal(video[key], 'bt709'); assert.equal(video.color_range, 'tv'); assert.equal(video.pix_fmt, 'yuv420p'); assert.equal(Number(video.nb_frames), 90); assert.equal(video.width, 1280); assert.equal(video.height, 720);
  await command('/usr/bin/ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], purpose + '-decode');
  const rgbFile = path.join(runtime, purpose + '-frames-0-45.rgb');
  await command('/usr/bin/ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-vf', `select='eq(n,0)+eq(n,45)',${timelineColourInputFilter('limited')},format=rgb24`, '-an', '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', '-n', rgbFile], purpose + '-samples');
  const rgb = await readFile(rgbFile); assert.equal(rgb.length, 2 * 1280 * 720 * 3);
  const pixel = (frame, x, y) => [...rgb.subarray((frame * 1280 * 720 + y * 1280 + x) * 3, (frame * 1280 * 720 + y * 1280 + x) * 3 + 3)];
  const background = pixel(0, 120, 300), transparent = pixel(0, 400, 300), grey = pixel(0, 640, 300), expectedGrey = background.map(v => 255 * .527924914041446 * (128 / 255) + v * (127 / 255));
  assert.ok(transparent.every((v, i) => Math.abs(v - background[i]) <= 5), 'Hidden alpha0 RGB must not leak into the composite'); assert.ok(grey.every((v, i) => Math.abs(v - expectedGrey[i]) <= 6), 'Semi-transparent grey must use the explicit sRGB display transform');
  const whites = [0, 0]; for (let frame = 0; frame < 2; frame++) for (let y = 552; y < 672; y++) for (let x = 48; x < 1232; x++) if (pixel(frame, x, y).every(v => v > 220)) whites[frame]++;
  assert.equal(whites[0], 0); assert.ok(whites[1] > 200, 'Subtitle must appear only inside its saved interval');
  return {purpose, id: record.id, fileHash: await fileHash(file), sampledDecodedHash: await fileHash(rgbFile), video, colourPlan: record.snapshot.colourPlan, pixels: {background, transparent, grey, expectedGrey, subtitleWhitePixels: whites}, fullDecodeExit: 0};
}
async function final() {
  const f = await fixture(), labels = ['prepared', 'inspected', 'saved', 'undo', 'redo', 'rendered', 'replaced', 'replacement-undo', 'first-exit', 'reopen-exit', 'restored-before-launch', 'restored-exit'];
  const a = Object.fromEntries(await Promise.all(labels.map(async label => [label, await readJson(path.join(report, label + '-audit.json'))])));
  assert.deepEqual(a.inspected.timeline, a.prepared.timeline, 'Inspecting the image must not save a declaration');
  const base = imageClip(a.prepared, f), saved = imageClip(a.saved, f); assert.equal(Object.hasOwn(base, 'colour'), false);
  assert.deepEqual({...saved, colour: undefined}, {...base, colour: undefined}); assert.equal(saved.colour.profileId, 'mioon-srgb-image-clip-v1'); assert.equal(saved.colour.source.interpretation, 'srgb'); assert.equal(saved.colour.source.declaredBy, 'user'); assert.equal(saved.colour.source.assetSha256, f.assets.image.sha256); assert.equal(saved.colour.source.evidence.colourTag, 'untagged'); assert.equal(saved.colour.source.evidence.alphaMode, 'straight'); assert.equal(saved.colour.look, null);
  const {status: _status, ...expectedEvidence} = f.expectedImageEvidence; assert.deepEqual(saved.colour.source.evidence, expectedEvidence);
  assert.deepEqual(imageClip(a.undo, f), base); assert.deepEqual(imageClip(a.redo, f), saved);
  assert.deepEqual(imageClip(a.rendered, f), saved); assert.equal(imageClip(a.replaced, f).assetId, f.assets.replacement.id); assert.deepEqual(imageClip(a.replaced, f).colour, {...saved.colour, source: null}); assert.deepEqual(imageClip(a['replacement-undo'], f), saved);
  for (const [label, delta] of [['saved', 1], ['undo', 2], ['redo', 3], ['replaced', 4], ['replacement-undo', 5]]) assert.equal(a[label].timeline.revision, f.baseRevision + delta, 'Unexpected UI mutation sequence: ' + label);
  for (const label of ['first-exit', 'reopen-exit', 'restored-before-launch', 'restored-exit']) { assert.deepEqual(a[label].timeline, a['replacement-undo'].timeline, 'Exact saved timeline after ' + label); assert.ok(cleanDraft(a[label]), 'No stale local draft at ' + label); }
  for (const value of Object.values(a)) { assert.deepEqual(value.timeline.clips.find(c => c.id === f.videoClipId), f.initialTimeline.clips.find(c => c.id === f.videoClipId)); assert.deepEqual(value.timeline.subtitles, f.initialTimeline.subtitles); }
  const edits = a.saved.raw.edit_tasks, applied = edits.rows.filter(r => cell(r, edits, 'status') === 'applied' && cell(r, edits, 'acknowledged') === '1');
  assert.ok(applied.some(r => cell(r, edits, 'operation') === 'timeline.clip.update' && JSON.parse(cell(r, edits, 'input')).patch?.colour?.profileId === 'mioon-srgb-image-clip-v1'), 'UI save must have a durable acknowledged edit task');
  const restore = await readJson(path.join(report, 'cold-restore.json')); assert.deepEqual(await tree(backup), restore.backupFiles); assert.equal(a['restored-exit'].schemaVersion, 33);
  for (const [name, expected] of [['workspace_restore_holds', restore.exact.holds], ['workspace_restore_timeline_history', restore.exact.history], ['workspace_restore_timeline_cursors', restore.exact.cursors]]) assert.deepEqual(a['restored-exit'].raw[name], expected, 'Captured restore evidence remained exact');
  const held = restore.exact.holds;
  for (const row of held.rows) { const name = cell(row, held, 'kind'), rowid = cell(row, held, 'capturedRowid'), original = a['first-exit'].raw[name], current = a['restored-exit'].raw[name]; const before = original.rows.find(r => r.rowid === rowid), after = current.rows.find(r => r.rowid === rowid); assert.ok(before && after); assert.deepEqual(original.columns.map((c, i) => after.values[current.columns.indexOf(c)]), before.values, 'Held original row changed: ' + name); }
  const launches = await Promise.all(['first', 'reopen', 'restored'].map(label => readJson(path.join(report, label + '-exit.json'))));
  for (const launch of launches) { assert.equal(launch.normal, true); assert.equal(launch.backendLockReleased, true); assert.deepEqual(launch.artifacts, launches[0].artifacts); assert.deepEqual(launch.argv, []); }
  assert.deepEqual(await artifacts(), launches[0].artifacts); await cold(workspace); await cold(restoredWorkspace);
  const observations = await readJson(path.join(report, 'ui-observations.json')); assert.equal(observations.synthetic, true); assert.equal(observations.method, 'supported-native-cua');
  const required = ['inspect-untagged', 'declare-and-save-srgb', 'undo', 'redo', 'preview', 'export', 'replace-invalidates', 'replacement-undo', 'reopen', 'restored-reopen'];
  const uiEvidence = [];
  for (const action of required) { const entry = observations.actions.find(e => e.action === action); assert.ok(entry && entry.observed === true && typeof entry.notes === 'string' && entry.notes.length > 0, 'Missing actual native observation: ' + action); assert.match(entry.screenshot, /^[a-z0-9-]+\.png$/u); uiEvidence.push({...entry, file: await fileHash(path.join(report, entry.screenshot), 20 * 1024 * 1024)}); }
  const output = []; for (const purpose of ['preview', 'export']) output.push(await verifyOutput(a['reopen-exit'], purpose, f));
  assert.deepEqual(output[0].sampledDecodedHash, output[1].sampledDecodedHash, 'Preview/export must share decoded pixels');
  const summary = {synthetic: true, at: stamp(), platform: 'linux-x64', packagedProduction: true, imageWorkflowVerified: true, sourceOriginalHashesUnchanged: true, explicitUntaggedSrgbSaved: true, undoRedoExact: true, replacementInvalidatedAndUndoExact: true, reopenedTimelineExact: true, coldBackupSchema: 32, restoredSchema: 33, restoredCapturedRowsAndEvidenceExact: true, savedImageColour: saved.colour, output, launches, uiEvidence, macOSVerified: false, hdrLogSupported: false,
    scope: 'Synthetic Linux production native UI observations plus read-only durable-state/output verification. No claim of OS-wide network tracing, macOS verification, or live provider validation.'};
  await save('summary.json', summary); return summary;
}

const [action, label, branch] = process.argv.slice(2);
if (action === 'prepare') console.log(json(await prepare()));
else if (action === 'audit') console.log(json(await audit(label, branch)));
else if (action === 'launch') await launch(label);
else if (action === 'cold-restore') console.log(json(await coldRestore()));
else if (action === 'final') console.log(json(await final()));
else throw Error('Expected prepare, audit LABEL [original|restored], launch first|reopen|restored, cold-restore, or final');
