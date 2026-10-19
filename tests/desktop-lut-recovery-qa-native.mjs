/** Synthetic preparation and read-only audits for manual native recovery QA.
 * This is NOT a native lost-ACK capture. No GUI launch, control, kill, RPC after
 * preparation, or production mutation is implemented here. Close GUI normally.
 * Usage: node tests/desktop-lut-recovery-qa-native.mjs prepare
 *        node tests/desktop-lut-recovery-qa-native.mjs audit committed <label>
 *        node tests/desktop-lut-recovery-qa-native.mjs audit undispatched <label>
 *        node tests/desktop-lut-recovery-qa-native.mjs audit-live committed <label>
 * Profiles: /workspace/shared/mioon-lut-recovery-{committed,undispatched}-20261015.
 * Run preparation/audits in the actual GUI host environment: workspace scope binds
 * filesystem device/inode identity, not just the shared pathname. Existing profiles
 * and audit labels are never overwritten. Historical /tmp fixtures are not used.
 * FFmpeg preparation is limited to 30 seconds and 16 KiB of stderr, then SIGTERM
 * with a 5-second exit-confirmation budget; no force kill or success on timeout.
 * Live audits use SQLite readOnly + query_only + one read transaction; no writes.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import * as storage from '@mioon/contracts/private-storage';
import { calculateWorkspaceScope } from '@mioon/contracts/workspace-scope';
import { openStore, createServices } from '../packages/business/src/index.ts';
import { createWorkspacePreferences } from '../packages/business/src/workspace-preferences.ts';
import { defaultWorkspaceState } from '../apps/web/src/workspace-state.ts';
import { createDesktopLutRecoveryStore } from '../apps/desktop/src/lut-recovery-store.ts';
import { saveToolConfig, writeAppLanguagePreference } from '../apps/desktop/src/config.ts';
import { serializeLanguagePreference } from '../packages/i18n/src/preference.ts';
const repo = fileURLToPath(new URL('../', import.meta.url));
const kinds = ['committed', 'undispatched'];
const rootFor = kind => { assert.ok(kinds.includes(kind)); return `/workspace/shared/mioon-lut-recovery-${kind}-20261015`; };
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function fileHash(file) { const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 512 * 1024 * 1024); return { bytes: stat.size, sha256: hash(await readFile(file)) }; }
const save = (file, value) => writeFile(file, json(value), { mode: 0o600, flag: 'wx' });
function scope(workspace) {
  const directory = storage.validatePrivateDirectory(workspace), db = storage.validateManagedFile(path.join(workspace, 'workbench.sqlite'), { root: workspace });
  assert.ok(directory && db); return calculateWorkspaceScope({ channel: 'production', root: workspace, directory, db });
}
async function media(source) {
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv', '-movflags', '+faststart', '-n', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrLimit = 16 * 1024;
    let errors = Buffer.alloc(0), timedOut = false, settled = false, exitTimer;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(exitTimer);
      if (error) reject(error); else resolve();
    };
    child.stderr.on('data', part => {
      if (errors.length < stderrLimit) errors = Buffer.concat([errors, part.subarray(0, stderrLimit - errors.length)]);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // Only this newly spawned synthetic preparation process is signalled.
      child.kill('SIGTERM');
      exitTimer = setTimeout(() => {
        child.stderr.destroy(); child.unref();
        finish(Error('Synthetic FFmpeg timed out; SIGTERM exit is unconfirmed. Preserve the fixture and inspect the owned process; do not retry preparation.'));
      }, 5000);
    }, 30000);
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(!timedOut && code === 0 && signal === null ? null :
      Error(`Synthetic FFmpeg ${timedOut ? 'timed out' : 'failed'}: ${code}/${signal}: ${errors.toString('utf8')}`)));
  });
}
async function prepare(kind) {
  const root = rootFor(kind); await mkdir(root, { mode: 0o700 });
  const userData = path.join(root, 'user-data'), workspace = path.join(userData, 'workspace');
  await mkdir(userData, { mode: 0o700 });
  const sourceFile = path.join(root, 'synthetic-rec709-green.mp4'), lutFile = path.join(root, 'synthetic-swap-red-green.cube');
  await media(sourceFile);
  const cube = ['TITLE "Synthetic Rec709 creative R-G swap"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b <= 1; b++) for (let g = 0; g <= 1; g++) for (let r = 0; r <= 1; r++) cube.push(`${g} ${r} ${b}`);
  await writeFile(lutFile, cube.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  await saveToolConfig(path.join(userData, 'desktop-config.json'), { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' });
  writeAppLanguagePreference({ userData }, serializeLanguagePreference('en'));
  const store = openStore(workspace), services = createServices(store, new Map()); let fixture;
  try {
    const project = await services.call('project.create', { name: `Synthetic LUT recovery: ${kind}` });
    const asset = await services.call('asset.import', { projectId: project.id, name: 'Synthetic Rec709 green.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(sourceFile)).toString('base64') });
    let timeline = await services.call('timeline.format.set', { projectId: project.id, expectedProjectRevision: project.revision, expectedRevision: 0, requestId: randomUUID(), presetId: 'landscape_720' });
    timeline = await services.call('timeline.clip.add', { projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: asset.id, trackId: timeline.tracks.find(t => t.kind === 'video').id, startFrame: 0, durationFrames: 90, name: 'Synthetic SDR clip' });
    const clip = timeline.clips[0], state = defaultWorkspaceState();
    state.activeMode = 'editing'; state.editing.selectedClipId = clip.id; state.editing.quickAssetId = null; state.editing.previewKind = 'source'; state.shared.inspectorCollapsed = false; delete state.shared.assetSearch;
    createWorkspacePreferences(store).put(project.id, { expectedRevision: 0, state });
    const bytes = await readFile(lutFile), requestId = randomUUID();
    const input = { projectId: project.id, requestId, name: path.basename(lutFile), dataBase64: bytes.toString('base64') };
    const pending = { version: 1, workspaceScope: scope(workspace), projectId: project.id, requestId, name: input.name, sizeBytes: bytes.length, sha256: hash(bytes) };
    const recovery = createDesktopLutRecoveryStore({ userData, storage, guard() { assert.equal(scope(workspace), pending.workspaceScope); } });
    recovery.reserve(pending); recovery.verify(pending);
    const reply = kind === 'committed' ? await services.call('lut.import', input) : null;
    const resources = store.db.prepare('SELECT count(*) AS n FROM project_lut_resources').get().n;
    const receipts = store.db.prepare('SELECT count(*) AS n FROM lut_import_requests').get().n;
    assert.equal(resources, kind === 'committed' ? 1 : 0); assert.equal(receipts, resources);
    if (reply) assert.equal(store.db.prepare('SELECT requestId FROM lut_import_requests').get().requestId, requestId);
    const storedAsset = JSON.parse(store.db.prepare('SELECT data FROM assets WHERE id=?').get(asset.id).data);
    fixture = { synthetic: true, nativeLostAckCapture: false, preparation: 'Synthetic pending state seeded using real typed recovery storage and services; no native ACK was lost or captured.', kind, channel: 'production', root, userData, workspace, projectId: project.id, timelineId: timeline.id, clipId: clip.id, assetId: asset.id, baseRevision: timeline.revision, originalClip: clip, originalRequestId: requestId, pending, seededResourceId: reply?.resource.id ?? null, sourceFile, sourceFileHash: await fileHash(sourceFile), sourceRelativePath: storedAsset.relativePath, sourceHash: asset.sha256, lutFile, lutFileHash: await fileHash(lutFile) };
  } finally { await services.drain(); store.close(); }
  await save(path.join(root, 'fixture.json'), fixture);
  const launch = `cd ${JSON.stringify(repo)}\nenv -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_PATH MIOON_DESKTOP_USER_DATA=${JSON.stringify(userData)} MIOON_ENABLE_LIVE_PROVIDER=0 MIOON_FFMPEG_PATH=/usr/bin/ffmpeg MIOON_FFPROBE_PATH=/usr/bin/ffprobe ${JSON.stringify(path.join(repo, 'node_modules/electron/dist/electron'))} ${JSON.stringify(path.join(repo, 'apps/desktop/build'))}`;
  await writeFile(path.join(root, 'README.txt'), `SYNTHETIC FIXTURE ONLY. NOT A NATIVE LOST-ACK CAPTURE.\nNo GUI has been launched by this helper.\nManual native launch, parent-controlled, sandbox unchanged, no CDP/debug flags:\n${launch}\nClose the application normally. Do not force kill. Audit only after normal close and backend lock release:\nnode tests/desktop-lut-recovery-qa-native.mjs audit ${kind} after-close\nOpen the sole project if the home screen appears; editing preferences already select the synthetic clip.\nExact recovery file: ${lutFile}\nOriginal request UUID: ${fixture.originalRequestId}\n`, { mode: 0o600, flag: 'wx' });
  await audit(kind, 'prepared'); return fixture;
}
async function audit(kind, label, live = false) {
  assert.match(label, /^[a-z0-9-]{1,50}$/);
  const root = rootFor(kind), fixture = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
  assert.equal(await exists(path.join(fixture.workspace, 'server.lock')), live, live ? 'Live audit requires the running synthetic backend' : 'Audit only after normal close and backend lock release');
  const rows = {}, db = new DatabaseSync(path.join(fixture.workspace, 'workbench.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.ok(tables.length <= 128);
    for (const { name } of tables) { assert.match(name, /^[a-z_]+$/); rows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid LIMIT 1001`).all(); assert.ok(rows[name].length <= 1000); }
    db.exec('COMMIT');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  const pendingFile = path.join(fixture.userData, 'lut-import-pending-v1.json');
  const result = { synthetic: true, nativeLostAckCapture: false, liveReadOnlyAudit: live, kind, at: new Date().toISOString(), originalRequestId: fixture.originalRequestId, originalPending: fixture.pending,
    currentWorkspaceScope: scope(fixture.workspace), tables: Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, { count: value.length, sha256: hash(json(value)) }])),
    lutResources: rows.project_lut_resources, lutRequests: rows.lut_import_requests, timelines: rows.timelines, timelineRequests: rows.timeline_requests, history: rows.timeline_history, editTasks: rows.edit_tasks, assets: rows.assets,
    pendingStore: await exists(pendingFile) ? { ...(await fileHash(pendingFile)), metadata: JSON.parse(await readFile(pendingFile, 'utf8')) } : null,
    source: await fileHash(path.join(fixture.workspace, fixture.sourceRelativePath)), sourceFixture: await fileHash(fixture.sourceFile), exactLut: await fileHash(fixture.lutFile) };
  assert.equal(result.source.sha256, fixture.sourceHash); assert.equal(result.sourceFixture.sha256, fixture.sourceFileHash.sha256); assert.equal(result.exactLut.sha256, fixture.lutFileHash.sha256);
  await save(path.join(root, `${label}-audit.json`), result); return result;
}
const [action, kind, label] = process.argv.slice(2);
if (action === 'prepare') {
  for (const item of kinds) assert.equal(await exists(rootFor(item)), false, `Refusing existing profile: ${rootFor(item)}`);
  for (const item of kinds) console.log(json(await prepare(item)));
} else if (action === 'audit' || action === 'audit-live') console.log(json(await audit(kind, label, action === 'audit-live')));
else throw Error('Expected prepare or audit committed|undispatched label; GUI launch is intentionally unsupported.');
