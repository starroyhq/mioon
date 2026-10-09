// External black-box QA for the actual ASAR/fuse-hardened Linux executable.
// The application has no packaged smoke bridge or remote debugging enabled.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { migrateData } from './migrate-data.mjs';
import { trustedOrigin } from '../src/security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binary = path.join(root, 'release/desktop/linux-unpacked/video-workbench');
const directory = await mkdtemp(path.join(tmpdir(), 'wb-packaged-qa-'));
const userData = path.join(directory, 'user-data');
const output = process.env.WB_PACKAGED_QA_OUTPUT || path.join(root, 'evidence/v3-desktop/packaged-qa.json');
await mkdir(path.dirname(output), { recursive: true });
const emptyPath = path.join(directory, 'path-without-node');
await mkdir(emptyPath);
const migration = await migrateData(path.join(root, 'examples/multitrack-project'), path.join(userData, 'workspace'));
if (!path.isAbsolute(process.env.WB_FFMPEG_PATH || '') || !path.isAbsolute(process.env.WB_FFPROBE_PATH || '')) {
  throw new Error('Set explicit absolute WB_FFMPEG_PATH and WB_FFPROBE_PATH for packaged QA');
}
const env = { ...process.env, PATH: emptyPath, WB_DESKTOP_USER_DATA: userData, VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER: '0' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'WB_DESKTOP_SMOKE_OUTPUT',
  'RUNWAYML_API_SECRET', 'RUNWAY_APPROVED_ASSET_SHA256', 'RUNWAY_OUTPUT_HOSTS', 'RUNWAY_MAX_GENERATIONS']) delete env[name];
const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '', ended = false;
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { tail = (tail + bytes).slice(-10000); });
const exit = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }); });
});
const report = { ok: false, binary, migration, noHostNodeInChildPath: true, packagedSmokeHooks: false, remoteDebugging: false, checks: [] };
const check = name => report.checks.push({ name, ok: true });
async function poll(fn, title, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (ended) throw new Error(`Packaged app exited before ${title}: ${tail}`);
    const result = await fn(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${title}`);
}
try {
  const descriptor = await poll(async () => {
    try { return JSON.parse(await readFile(path.join(userData, 'mcp-connection.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'private desktop discovery');
  const origin = trustedOrigin(descriptor.url);
  const token = (await readFile(descriptor.tokenFile, 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const health = await fetch(`${origin}/health`).then(response => response.json());
  assert.equal(health.ok, true); assert.ok(health.sqlite);
  report.health = health;
  check('actual-packaged-asar-backend-starts-with-empty-path');
  const utilityExecutable = await readlink(`/proc/${descriptor.pid}/exe`);
  assert.equal(utilityExecutable, binary);
  const utilityArgs = (await readFile(`/proc/${descriptor.pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(utilityArgs.includes('--type=utility'));
  assert.ok(utilityArgs.some(value => value.includes('node.mojom.NodeService')));
  report.utilityExecutable = utilityExecutable;
  check('backend-is-bundled-electron-node-utility-not-host-node');
  const rpc = async (operation, input = {}) => {
    const response = await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, input }) });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.ok, true, JSON.stringify(body.error));
    return body.data;
  };
  const projects = await rpc('project.list');
  assert.equal(projects.length, 1);
  const project = projects[0], timeline = await rpc('timeline.get', { projectId: project.id });
  assert.ok(timeline.clips.length >= 4);
  report.project = { name: project.name, clipCount: timeline.clips.length };
  check('migrated-synthetic-project-loaded-through-shared-http');
  const render = await rpc('timeline.render', { projectId: project.id, expectedRevision: timeline.revision, purpose: 'preview', requestId: randomUUID() });
  const completed = await poll(async () => {
    const job = await rpc('export.get', { exportId: render.id });
    if (job.status === 'failed') throw new Error(`Packaged FFmpeg render failed: ${JSON.stringify(job.error)}`);
    return job.status === 'succeeded' ? job : false;
  }, 'packaged real multitrack FFmpeg render');
  const media = await fetch(`${origin}${completed.url}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = new Uint8Array(await media.arrayBuffer());
  assert.equal(media.status, 200); assert.equal(media.headers.get('Content-Type'), 'video/mp4');
  assert.ok(bytes.byteLength > 10000);
  report.render = { status: completed.status, bytes: bytes.byteLength, timelineRevision: completed.timelineRevision };
  check('packaged-shared-ffmpeg-render-and-authenticated-video');
  const anonymous = await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'project.list' }) });
  assert.equal(anonymous.status, 401); check('packaged-anonymous-http-denied');
  report.readyForNativeInspection = true;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`PACKAGED_QA_READY ${output}\nThe real native window is open. Select preview → timeline composition for visual inspection, then quit the app normally.`);
  const outcome = await exit;
  assert.equal(outcome.code, 0);
  for (const name of ['mcp-connection.json', 'mcp-token', 'workspace/server.lock']) {
    await assert.rejects(access(path.join(userData, name)), { code: 'ENOENT' });
  }
  check('native-quit-cleans-descriptor-token-and-database-lock');
  report.ok = true; report.gracefulExit = outcome; report.readyForNativeInspection = false;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`PACKAGED_QA_PASS ${output}`);
} catch (error) {
  report.error = error.message;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.error(error.message);
  child.kill('SIGTERM');
  process.exitCode = 1;
}
