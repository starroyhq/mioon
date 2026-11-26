import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {operationDefinition, schemas} from '@mioon/client';
import {isMcpOperationAllowed} from '../../mcp/src/tool-policy.ts';
import {command, executable} from '../../../.github/scripts/media-environment.ts';
import {macBundleExecutable} from '../../../.github/scripts/mac-dmg.ts';
import {MAC_CLI_LAUNCHER_ARCHITECTURES, MAC_CLI_LAUNCHER_MAX_BYTES, macCliLauncherBundleEntry} from '../cli-launcher-binary.ts';
import {identityForChannel} from '../identity.ts';
import {createCliInstaller} from '../src/cli-install.ts';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}

function quantiles(samples: number[]) {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(ordered[Math.ceil(p * ordered.length) - 1]! * 10) / 10;
  return {samples: samples.length, medianMs: percentile(0.5), p95Ms: percentile(0.95)};
}

assert.equal(process.platform, 'darwin');
assert.equal(process.argv.length, 3, 'Pass the path to the unpacked macOS development app');
const bundle = await realpath(process.argv[2]!);
const identity = identityForChannel('development');
const appId = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')], 'PLIST_ID_FAILED');
assert.equal(appId.trim(), identity.appId, 'Only the development channel is eligible for local QA');
const binary = await macBundleExecutable(bundle);
const launcher = path.join(bundle, macCliLauncherBundleEntry(identity));
await command('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', launcher], 'LAUNCHER_SIGNATURE_INVALID');
const archs = (await command('/usr/bin/lipo', ['-archs', launcher], 'LAUNCHER_ARCH_INVALID')).trim().split(/\s+/).sort();
assert.deepEqual(archs, [...MAC_CLI_LAUNCHER_ARCHITECTURES]);
const launcherBytes = (await lstat(launcher)).size;
assert.ok(launcherBytes < MAC_CLI_LAUNCHER_MAX_BYTES);

const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH);
const ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-native-qa-'));
const home = path.join(root, 'home'), emptyPath = path.join(root, 'no-node');
const userData = path.join(home, 'Library', 'Application Support', identity.appId);
const env = {HOME: home, TMPDIR: root, PATH: emptyPath, LANG: 'en_US.UTF-8'};
await Promise.all([mkdir(home, {mode: 0o700}), mkdir(emptyPath, {mode: 0o700})]);

async function nativeCommand(args: string[], input?: Buffer, binaryPath = launcher) {
  const start = performance.now();
  const child = spawn(binaryPath, args, {cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']});
  const stopped = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  async function collect(stream: NodeJS.ReadableStream) {
    const bytes: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      assert.ok(Buffer.isBuffer(chunk));
      total += chunk.length;
      assert.ok(total <= 4 * 1024 * 1024, 'unexpected output size in QA');
      bytes.push(chunk);
    }
    return Buffer.concat(bytes).toString('utf8');
  }
  try {
    const [[code, signal], stdout, stderr] = await Promise.all([stopped, collect(child.stdout), collect(child.stderr)]);
    assert.equal(signal, null);
    return {code, stdout, stderr, ms: performance.now() - start};
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

const output = (value: string): Json => object(JSON.parse(value));
const absent: number[] = [], versions: number[] = [], help: number[] = [], mcp: number[] = [];
let app: ReturnType<typeof spawn> | undefined;
let appExit: ReturnType<typeof once> | undefined;
try {
  let launcherVersion = '';
  for (let sample = 0; sample < 12; sample++) {
    const result = await nativeCommand(['--version']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr.length, 0);
    const body = output(result.stdout);
    assert.equal(body.ok, true);
    const version = object(body.data);
    assert.equal(version.name, 'mioon');
    assert.equal(typeof version.version, 'string');
    launcherVersion = String(version.version);
    versions.push(result.ms);
    const missing = await nativeCommand(['doctor']);
    assert.equal(missing.code, 4);
    assert.equal(object(output(missing.stdout).error).code, 'CLI_RUNTIME_UNAVAILABLE');
    absent.push(missing.ms);
  }
  const missingMcp = await nativeCommand(['mcp']);
  assert.equal(missingMcp.code, 1);
  assert.equal(missingMcp.stdout.length, 0);

  app = spawn(binary, [], {stdio: 'ignore', env: {...env, MIOON_DESKTOP_USER_DATA: userData,
    MIOON_FFMPEG_PATH: ffmpeg, MIOON_FFPROBE_PATH: ffprobe}});
  appExit = once(app, 'exit');
  void appExit.catch(() => {});
  const discovery = path.join(userData, 'mcp-connection.json');
  let descriptor: Json | undefined;
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(app.exitCode, null);
    assert.equal(app.signalCode, null);
    try {
      descriptor = output(await readFile(discovery, 'utf8'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await sleep(200);
    }
  }
  assert.ok(descriptor, 'Timed out waiting for development CLI discovery');
  assert.equal(descriptor.appVersion, launcherVersion);
  assert.equal(descriptor.channel, 'development');
  assert.equal(descriptor.appId, identity.appId);
  const tokenFile = object(descriptor.cli).tokenFile;
  assert.equal(tokenFile, path.join(userData, 'cli-token'));
  assert.equal(typeof tokenFile, 'string');
  const token = await readFile(tokenFile, 'utf8');
  try {
    await writeFile(tokenFile, '0'.repeat(64) + '\n', {mode: 0o600});
    const rejected = await nativeCommand(['doctor']);
    assert.equal(rejected.code, 4);
    assert.equal(object(output(rejected.stdout).error).code, 'CLI_AUTH_FAILED');
  } finally {
    await writeFile(tokenFile, token, {mode: 0o600});
  }

  for (let sample = 0; sample < 12; sample++) {
    const result = await nativeCommand(['--help']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr.length, 0);
    assert.ok(result.stdout.length > 0);
    help.push(result.ms);
  }
  const doctor = await nativeCommand(['doctor']);
  assert.equal(doctor.code, 0);
  assert.equal(object(output(doctor.stdout).data).ready, true);
  const invalid = await nativeCommand(['--native-qa-unknown']);
  assert.equal(invalid.code, 2);
  assert.equal(output(invalid.stdout).ok, false);
  assert.ok(invalid.stderr.length > 0);
  const input = Buffer.concat([Buffer.from('{"name":"Native launcher QA"}'), Buffer.alloc(1024 * 1024, 0x20)]);
  const created = await nativeCommand(['project', 'create', '--input', '-'], input);
  assert.equal(created.code, 0);
  assert.equal(object(output(created.stdout).data).name, 'Native launcher QA');
  await writeFile(path.join(root, 'native-relative.json'), '{"name":"Relative path QA"}', {mode: 0o600});
  const relative = await nativeCommand(['project', 'create', '--input-file', 'native-relative.json']);
  assert.equal(relative.code, 0);
  assert.equal(object(output(relative.stdout).data).name, 'Relative path QA');

  const expectedTools = [...Object.keys(schemas).filter(isMcpOperationAllowed).map(name => operationDefinition(name).toolName),
    'mioon_doctor', 'mioon_capabilities', 'mioon_schema'].sort();
  for (let sample = 0; sample < 12; sample++) {
    const client = new Client({name: 'mioon-launcher-qa', version: '1'});
    try {
      const start = performance.now();
      await client.connect(new StdioClientTransport({command: launcher, args: ['mcp'], cwd: root, env, stderr: 'pipe'}),
        {timeout: 20_000});
      mcp.push(performance.now() - start);
      if (sample === 0) {
        const {tools} = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
        assert.equal(client.getServerVersion()?.name, 'mioon');
      }
    } finally {
      await client.close();
    }
  }

  // Keep login-shell startup and any history within the disposable profile.
  process.env.ZDOTDIR = home;
  process.env.HISTFILE = path.join(home, '.zsh_history');
  const rcFile = path.join(home, '.zshrc');
  await writeFile(rcFile, 'export PATH=/usr/bin:/bin\n', {mode: 0o600});
  const installer = createCliInstaller({homeDir: home, userData, appPath: bundle, appVersion: launcherVersion,
    channel: 'development', shell: '/bin/zsh'});
  assert.equal((await installer.status()).cli.state, 'not-installed');
  const installed = await installer.install();
  assert.equal(installed.cli.state, 'installed', installed.cli.reason);
  assert.equal(installed.cli.version, launcherVersion);
  assert.equal(installed.managed, true);
  assert.equal(installed.cli.onPath, 'no');
  assert.equal(installed.cli.pathHint?.rcFile, '~/.zshrc');
  assert.equal(installed.cli.commandPath, path.join(home, '.local', 'bin', 'mioon-dev'));
  assert.ok(installed.cli.commandPath);
  assert.ok((await lstat(installed.cli.commandPath)).isSymbolicLink());
  const installedDoctor = await nativeCommand(['doctor'], undefined, installed.cli.commandPath);
  assert.equal(installedDoctor.code, 0);
  assert.equal(object(output(installedDoctor.stdout).data).ready, true);
  const pathFixture = 'export PATH="$HOME/.local/bin:/usr/bin:/bin"\n';
  await writeFile(rcFile, pathFixture, {mode: 0o600});
  assert.equal((await installer.status()).cli.onPath, 'yes');
  assert.equal((await installer.uninstall()).cli.state, 'not-installed');
  assert.equal(await readFile(rcFile, 'utf8'), pathFixture);
  await assert.rejects(lstat(installed.cli.commandPath), {code: 'ENOENT'});

  app.kill('SIGTERM');
  assert.deepEqual(await Promise.race([appExit, sleep(30_000, null, {ref: false})]), [0, null]);
  const stopped = await nativeCommand(['doctor']);
  assert.equal(stopped.code, 4);
  assert.equal(object(output(stopped.stdout).error).code, 'CLI_RUNTIME_UNAVAILABLE');
  console.log(JSON.stringify({ok: true, channel: identity.channel, launcherVersion, launcherBytes, archs,
    appStopped: quantiles(absent), localVersion: quantiles(versions), cliHelp: quantiles(help),
    mcpInitialize: quantiles(mcp), mcpToolCount: expectedTools.length, installationKind: installed.installationKind}));
} finally {
  if (app && appExit && app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM');
    const stopped = await Promise.race([appExit.catch(() => null), sleep(5_000, null, {ref: false})]);
    if (!stopped && app.exitCode === null && app.signalCode === null) {
      app.kill('SIGKILL');
      await appExit.catch(() => {});
    }
  }
  await rm(root, {recursive: true, force: true});
}
