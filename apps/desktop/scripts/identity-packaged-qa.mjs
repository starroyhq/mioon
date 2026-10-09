/** Black-box two-channel Linux QA. Uses only local packages, private discovery and HTTP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, access, readdir, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import desktopIdentity from '../identity.cjs';
import { providerEnvironmentKeys } from '@video-workbench/business';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'evidence/v4.1-app-id');
const directory = await mkdtemp(path.join(tmpdir(), 'wb-packaged-identity-'));
const configHome = path.join(directory, 'config');
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const dependencies = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = dependencies('@electron/asar');
const { getCurrentFuseWire, FuseV1Options } = dependencies('@electron/fuses');
const children = [], checks = [], packages = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, details = {}) => checks.push({ name, ok: true, ...details });
async function waitFor(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
function launch(binary, env) {
  const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { child.log = (child.log + data).slice(-10000); });
  children.push(child); return child;
}
async function rpc(descriptor, operation, input = {}) {
  const token = (await readFile(descriptor.tokenFile, 'utf8')).trim();
  const response = await fetch(descriptor.url + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.data;
}
try {
  await mkdir(output, { recursive: true });
  await mkdir(path.join(configHome, 'video-workbench'), { recursive: true });
  await writeFile(path.join(configHome, 'video-workbench', 'legacy-preserved.txt'), 'Existing legacy data is not touched.');
  for (const channel of ['production', 'development']) {
    const identity = desktopIdentity.identityForChannel(channel);
    const packageDir = path.join(root, 'release/desktop', channel, 'linux-unpacked');
    const binary = path.join(packageDir, identity.executableName), archive = path.join(packageDir, 'resources/app.asar');
    const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
    assert.deepEqual(metadata.workbenchDesktop, identity);
    assert.equal(metadata.desktopName, `${identity.appId}.desktop`);
    assert.equal(metadata.version, '0.4.1');
    const files = asar.listPackage(archive);
    assert.equal(files.some(file => /^\/(?:node_modules|data|workspace)(?:\/|$)/.test(file) || /\/(?:access-token|mcp-token|mcp-connection.json)$/.test(file)), false);
    const wire = await getCurrentFuseWire(binary);
    for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']) assert.equal(wire[FuseV1Options[name]], 48);
    for (const name of ['EnableCookieEncryption', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) assert.equal(wire[FuseV1Options[name]], 49);
    record('packaged-identity-and-security-fuses', { channel, appId: identity.appId });
    const env = { ...process.env, XDG_CONFIG_HOME: configHome, WB_FFMPEG_PATH: '/usr/bin/ffmpeg', WB_FFPROBE_PATH: '/usr/bin/ffprobe', VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER: '0',
      // Deliberately conflicting runtime values must not change the embedded channel.
      NODE_ENV: channel === 'production' ? 'development' : 'production', WB_DESKTOP_CHANNEL: channel === 'production' ? 'development' : 'production' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'WB_DESKTOP_USER_DATA', 'WB_DESKTOP_SMOKE_OUTPUT', ...providerEnvironmentKeys.filter(key => key !== 'VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER')]) delete env[key];
    const child = launch(binary, env), userData = path.join(configHome, identity.appId), descriptorFile = path.join(userData, 'mcp-connection.json');
    const descriptor = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode) throw new Error(`App exited: ${child.log}`);
      try { return JSON.parse(await readFile(descriptorFile, 'utf8')); } catch { return false; }
    }, `${channel} discovery`);
    assert.equal(descriptor.appId, identity.appId); assert.equal(descriptor.channel, channel);
    const marker = JSON.parse(await readFile(path.join(userData, 'desktop-identity.json'), 'utf8'));
    assert.equal(marker.appId, identity.appId);
    const utilityCmd = await readFile(`/proc/${descriptor.pid}/cmdline`, 'utf8');
    assert.equal(await readlink(`/proc/${descriptor.pid}/exe`), binary); assert.match(utilityCmd, /--type=utility/);
    assert.equal((await rpc(descriptor, 'project.list')).length, 0);
    const project = await rpc(descriptor, 'project.create', { name: `V4.1 ${channel} isolated project` });
    record('packaged-runtime-identity-default-data-and-bundled-backend', { channel, appId: descriptor.appId, userData, projectId: project.id });
    const duplicate = launch(binary, env);
    await waitFor(() => duplicate.exitCode !== null || duplicate.signalCode, `${channel} duplicate exits`, 15000);
    assert.equal(duplicate.exitCode, 0);
    assert.equal(JSON.parse(await readFile(descriptorFile, 'utf8')).pid, descriptor.pid);
    record('same-channel-second-instance-reuses-first', { channel });
    packages.push({ channel, identity, child, descriptor, descriptorFile, userData, project, archive, env, binary });
  }
  assert.notEqual(packages[0].descriptor.pid, packages[1].descriptor.pid);
  assert.notEqual(packages[0].descriptor.url, packages[1].descriptor.url);
  for (const item of packages) {
    const projects = await rpc(item.descriptor, 'project.list');
    assert.deepEqual(projects.map(project => project.id), [item.project.id]);
  }
  assert.equal(await readFile(path.join(configHome, 'video-workbench', 'legacy-preserved.txt'), 'utf8'), 'Existing legacy data is not touched.');
  assert.deepEqual(await readdir(path.join(configHome, 'video-workbench')), ['legacy-preserved.txt']);
  record('production-development-coexist-with-independent-projects-and-legacy-retention');
  await writeFile(path.join(output, 'packaged-windows-ready.json'), JSON.stringify({ ok: true, appIds: packages.map(item => item.identity.appId) }));
  // Optional bounded pause for CUA's screenshot; no debugging interface or packaged test hook.
  if (process.env.WB_IDENTITY_QA_SCREENSHOT === '1') await waitFor(async () => {
    try { await access(path.join(output, 'packaged-screenshot-done')); return true; } catch { return false; }
  }, 'native screenshot', 180000);
  for (const item of packages) {
    const closed = once(item.child, 'close'); item.child.kill('SIGTERM');
    const [code] = await closed; assert.equal(code, 0);
    await assert.rejects(access(item.descriptorFile), { code: 'ENOENT' });
    await assert.rejects(access(path.join(item.userData, 'mcp-token')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(item.userData, 'workspace/server.lock')), { code: 'ENOENT' });
    await access(path.join(item.userData, 'workspace/workbench.sqlite'));
    record('normal-exit-cleans-own-discovery-and-preserves-project-data', { channel: item.channel });
  }
  const report = { ok: true, platform: 'linux-x64', version: '0.4.1', checks, packageHashes: await Promise.all(packages.map(async item => ({ channel: item.channel, appId: item.identity.appId, asarSha256: createHash('sha256').update(await readFile(item.archive)).digest('hex') }))), macOSNativeVerified: false, liveProviderVerified: false };
  await writeFile(path.join(output, 'packaged-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
}
