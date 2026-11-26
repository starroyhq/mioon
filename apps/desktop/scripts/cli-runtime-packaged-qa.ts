// Black-box v1 client for the development ASAR. No native launcher is needed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import type {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {EXIT_CODES, operationDefinition, schemas} from '@mioon/client';
import {isMcpOperationAllowed} from '../../mcp/src/tool-policy.ts';
import {command, executable} from '../../../.github/scripts/media-environment.ts';
import {macBundleExecutable} from '../../../.github/scripts/mac-dmg.ts';
import {identityForChannel} from '../identity.ts';

type Json = Record<string, unknown>;
interface Descriptor {
  readonly appId: string;
  readonly channel: 'development';
  readonly appVersion: string;
  readonly cli: {readonly protocol: 1; readonly socket: string; readonly tokenFile: string};
}

const MAX_FRAME = 1024 * 1024;
const socketSet = new Set<Socket>();
function wireFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  assert.ok(payload.length <= MAX_FRAME);
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
function object(value: unknown): Json {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Json;
}
const json = (bytes: Buffer): Json => object(JSON.parse(bytes.toString('utf8')));
function connect(descriptor: Descriptor, token: string, role: 'cli' | 'mcp', argv: string[], overrides: Json = {}) {
  const socket = createConnection(descriptor.cli.socket);
  socketSet.add(socket);
  socket.once('close', () => socketSet.delete(socket));
  socket.setTimeout(20_000, () => socket.destroy(new Error('Timed out reading the runtime socket')));
  const iterator = socket[Symbol.asyncIterator]();
  const payload = Buffer.from(JSON.stringify({protocol: 1, channel: 'development', launcherVersion: descriptor.appVersion,
    appVersion: descriptor.appVersion, token, role, argv, ...overrides}));
  const preamble = Buffer.alloc(15);
  preamble.write('MIOONCLI\0', 'ascii');
  preamble.writeUInt16BE(1, 9);
  preamble.writeUInt32BE(payload.length, 11);
  socket.write(Buffer.concat([preamble, payload]));
  let queued: Buffer = Buffer.alloc(0);
  async function fill(size: number): Promise<boolean> {
    while (queued.length < size) {
      const item = await iterator.next();
      if (item.done) return false;
      assert.ok(Buffer.isBuffer(item.value));
      queued = Buffer.concat([queued, item.value]);
    }
    return true;
  }
  return {
    async frame() {
      if (!await fill(5)) {
        assert.equal(queued.length, 0, 'partial frame head');
        return null;
      }
      const type = queued[0]!, length = queued.readUInt32BE(1);
      assert.ok(length <= MAX_FRAME);
      assert.equal(await fill(5 + length), true, 'partial frame payload');
      const bytes = queued.subarray(5, 5 + length);
      queued = queued.subarray(5 + length);
      return {type, bytes};
    },
    send(type: number, bytes?: Buffer) {socket.write(wireFrame(type, bytes));},
    close() {socket.destroy();},
  };
}

async function ready(client: ReturnType<typeof connect>, version: string): Promise<void> {
  const frame = await client.frame();
  assert.ok(frame);
  assert.equal(frame.type, 7, 'launcher must receive READY first');
  assert.deepEqual(json(frame.bytes), {protocol: 1, appVersion: version, channel: 'development'});
}

async function runCli(descriptor: Descriptor, token: string, argv: string[], input?: Buffer, cwd?: string) {
  const client = connect(descriptor, token, 'cli', argv, cwd ? {cwd} : {});
  try {
    await ready(client, descriptor.appVersion);
    if (input) {
      for (let offset = 0; offset < input.length; offset += MAX_FRAME) client.send(1, input.subarray(offset, offset + MAX_FRAME));
      client.send(2);
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    for (let frame = await client.frame(); frame; frame = await client.frame()) {
      if (frame.type === 6) return {code: json(frame.bytes).code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)};
      assert.ok(frame.type === 3 || frame.type === 4);
      (frame.type === 3 ? stdout : stderr).push(frame.bytes);
    }
    assert.fail('CLI session closed without EXIT');
  } finally {
    client.close();
  }
}

assert.equal(process.platform, 'darwin', 'Use a macOS development package');
assert.equal(process.argv.length, 3, 'Pass the path to the unpacked Mioon Dev.app');
const appBundle = await realpath(process.argv[2]!);
const identity = identityForChannel('development');
const appId = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appBundle, 'Contents', 'Info.plist')], 'PLIST_ID_FAILED');
assert.equal(appId.trim(), identity.appId, 'Only the development channel is eligible for local QA');
const binary = await macBundleExecutable(appBundle);
const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH);
const ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-cli-qa-'));
const userData = path.join(root, 'user-data'), home = path.join(root, 'home'), emptyPath = path.join(root, 'path-without-node');
await Promise.all([mkdir(home, {mode: 0o700}), mkdir(emptyPath, {mode: 0o700})]);
const app = spawn(binary, [], {stdio: 'ignore', env: {HOME: home, TMPDIR: root, PATH: emptyPath,
  LANG: 'en_US.UTF-8', MIOON_DESKTOP_USER_DATA: userData, MIOON_FFMPEG_PATH: ffmpeg, MIOON_FFPROBE_PATH: ffprobe}});
const exit = once(app, 'exit');
void exit.catch(() => {});

async function discovery(): Promise<Descriptor> {
  const file = path.join(userData, 'mcp-connection.json');
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(app.exitCode, null, 'Development app exited before discovery');
    assert.equal(app.signalCode, null);
    try {
      const descriptor = JSON.parse(await readFile(file, 'utf8')) as Descriptor;
      assert.equal(descriptor.appId, identity.appId);
      assert.equal(descriptor.channel, 'development');
      assert.equal(descriptor.cli?.protocol, 1, 'Desktop discovery must include its CLI endpoint');
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await sleep(200);
  }
  assert.fail('Timed out waiting for development CLI discovery');
}

try {
  const descriptor = await discovery();
  assert.equal(descriptor.cli.tokenFile, path.join(userData, 'cli-token'));
  assert.equal((await lstat(descriptor.cli.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(descriptor.cli.socket))).mode & 0o777, 0o700);
  const socket = await lstat(descriptor.cli.socket);
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  const token = (await readFile(descriptor.cli.tokenFile, 'utf8')).trimEnd();
  assert.match(token, /^[0-9a-f]{64}$/u);

  for (const [override, code] of [
    [{token: '0'.repeat(64)}, 'CLI_AUTH_FAILED'],
    [{launcherVersion: descriptor.appVersion + '-other'}, 'CLI_VERSION_MISMATCH'],
    [{channel: 'production'}, 'CLI_VERSION_MISMATCH'],
  ] as const) {
    const client = connect(descriptor, token, 'cli', ['--help'], override);
    const frame = await client.frame();
    assert.ok(frame);
    assert.equal(frame.type, 8);
    assert.equal(json(frame.bytes).code, code);
    client.close();
  }
  const help = await runCli(descriptor, token, ['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.length > 0);
  assert.equal(help.stderr.length, 0);
  const version = await runCli(descriptor, token, ['--version']);
  assert.equal(version.code, 0);
  assert.equal(object(json(version.stdout).data).version, descriptor.appVersion);
  const invalid = await runCli(descriptor, token, ['--cli-runtime-qa-invalid']);
  assert.equal(invalid.code, EXIT_CODES.validation);
  assert.equal(json(invalid.stdout).ok, false);
  assert.ok(invalid.stderr.length > 0, 'diagnostics are forwarded independently of JSON');
  const name = 'CLI runtime QA';
  const paddedInput = Buffer.concat([Buffer.from(JSON.stringify({name})), Buffer.alloc(MAX_FRAME, 0x20)]);
  const project = await runCli(descriptor, token, ['project', 'create', '--input', '-'], paddedInput);
  assert.equal(project.code, 0);
  const created = object(json(project.stdout).data);
  assert.equal(created.name, name);
  assert.equal(typeof created.id, 'string');
  await writeFile(path.join(root, 'relative-input.json'), JSON.stringify({name: 'Relative path QA'}), {mode: 0o600});
  const relative = await runCli(descriptor, token, ['project', 'create', '--input-file', 'relative-input.json'], undefined, root);
  assert.equal(relative.code, 0);
  assert.equal(object(json(relative.stdout).data).name, 'Relative path QA');

  const cancelled = connect(descriptor, token, 'cli', ['project', 'create', '--input', '-']);
  await ready(cancelled, descriptor.appVersion);
  cancelled.send(5);
  for (;;) {
    const frame = await cancelled.frame();
    assert.ok(frame, 'cancelled command must receive EXIT');
    if (frame.type === 6) {
      assert.equal(json(frame.bytes).code, 130);
      break;
    }
    assert.ok(frame.type === 3 || frame.type === 4);
  }

  const mcp = connect(descriptor, token, 'mcp', []);
  await ready(mcp, descriptor.appVersion);
  let pending = '';
  const decoder = new TextDecoder('utf-8', {fatal: true});
  async function mcpReply(id: number): Promise<Json> {
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline >= 0) {
        const reply = object(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        assert.equal(reply.id, id);
        return object(reply.result);
      }
      const frame = await mcp.frame();
      assert.ok(frame, 'MCP closed before its JSON-RPC reply');
      assert.equal(frame.type, 3, 'MCP replies use stdout only');
      pending += decoder.decode(frame.bytes, {stream: true});
      assert.ok(pending.length <= 8 * MAX_FRAME);
    }
  }
  const send = (message: Json) => mcp.send(1, Buffer.from(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n'));
  send({id: 1, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'mioon-qa', version: '1'}}});
  const initialized = await mcpReply(1);
  assert.ok(object(initialized.capabilities).tools);
  assert.equal(object(initialized.serverInfo).name, 'mioon');
  send({method: 'notifications/initialized'});
  send({id: 2, method: 'tools/call', params: {name: 'project_inspect', arguments: {projectId: created.id}}});
  const inspection = object((await mcpReply(2)).structuredContent);
  assert.equal(inspection.ok, true);
  assert.equal(object(inspection.data).id, created.id);
  send({id: 3, method: 'tools/list'});
  mcp.send(2);
  const {tools} = await mcpReply(3);
  assert.ok(Array.isArray(tools));
  const actual = tools.map(tool => object(tool).name).sort();
  const expected = [...Object.keys(schemas).filter(isMcpOperationAllowed).map(name => operationDefinition(name).toolName),
    'mioon_doctor', 'mioon_capabilities', 'mioon_schema'].sort();
  assert.deepEqual(actual, expected);
  const mcpExit = await mcp.frame();
  assert.ok(mcpExit);
  assert.equal(mcpExit.type, 6, 'EOF drains the accepted MCP request before EXIT');
  assert.equal(json(mcpExit.bytes).code, 0);

  const stillConnected = connect(descriptor, token, 'mcp', []);
  await ready(stillConnected, descriptor.appVersion);
  app.kill('SIGTERM');
  assert.equal(await stillConnected.frame(), null, 'application quit closes the still-connected MCP session');
  assert.deepEqual(await Promise.race([exit, sleep(30_000, null, {ref: false})]), [0, null]);
  for (const file of [descriptor.cli.socket, descriptor.cli.tokenFile, path.join(userData, 'mcp-connection.json')]) {
    await assert.rejects(lstat(file), {code: 'ENOENT'});
  }
  console.log(JSON.stringify({ok: true, appVersion: descriptor.appVersion, channel: descriptor.channel, tools: actual.length,
    checks: ['private discovery', 'authentication and version handshake', 'CLI help and exit codes',
      'CLI stdin over multiple frames', 'CLI relative files', 'CLI cancellation',
      'MCP initialize, project_inspect, tools/list and EOF', 'session cleanup during app quit']}));
} finally {
  for (const socket of socketSet) socket.destroy();
  if (app.exitCode === null && app.signalCode === null) {
    app.kill('SIGTERM');
    const stopped = await Promise.race([exit.catch(() => null), sleep(5_000, null, {ref: false})]);
    if (!stopped && app.exitCode === null && app.signalCode === null) {
      app.kill('SIGKILL');
      await exit.catch(() => {});
    }
  }
  await rm(root, {recursive: true, force: true});
}
