import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {createConnection, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {setImmediate as turn} from 'node:timers/promises';
import {startCliRuntimeHost} from '../apps/desktop/src/cli-runtime-host.ts';
import type {CliRuntimeFork, CliRuntimeHost, CliRuntimeUtility} from '../apps/desktop/src/cli-runtime-host.ts';

const maximum = 1_048_576;
const version = '0.4.0-fixture';
const unsupported = process.platform === 'win32';

class Utility extends EventEmitter implements CliRuntimeUtility {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly messages: unknown[] = [];
  killCount = 0;
  autoExit = true;
  postMessage(message: unknown): void { this.messages.push(message); this.emit('input'); }
  kill(): boolean {
    this.killCount++;
    if (this.autoExit) setImmediate(() => this.finish(143));
    return true;
  }
  finish(code: number): void {
    this.emit('exit', code);
    this.stdout.end();
    this.stderr.end();
  }
}

function frame(type: number, data: Buffer = Buffer.alloc(0), length = data.length): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(length, 1);
  return Buffer.concat([header, data]);
}
function helloFrame(value: object | Buffer, {protocol = 1, length}: {protocol?: number; length?: number} = {}): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(15);
  header.write('MIOONCLI\0', 'ascii');
  header.writeUInt16BE(protocol, 9);
  header.writeUInt32BE(length ?? body.length, 11);
  return Buffer.concat([header, body]);
}

function peer(socket: Socket) {
  const reader = socket[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  async function next(): Promise<{type: number; payload: Buffer}> {
    while (buffered.length < 5 || buffered.length < 5 + buffered.readUInt32BE(1)) {
      const chunk = await reader.next();
      if (chunk.done) throw new Error('Socket closed before the next frame');
      buffered = Buffer.concat([buffered, chunk.value]);
    }
    const length = buffered.readUInt32BE(1), type = buffered[0]!;
    assert.ok(length <= maximum);
    const payload = buffered.subarray(5, 5 + length);
    buffered = buffered.subarray(5 + length);
    return {type, payload};
  }
  async function json(type: number): Promise<unknown> {
    const result = await next();
    assert.equal(result.type, type);
    return JSON.parse(result.payload.toString('utf8'));
  }
  return {socket, next, json};
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cli-host-'));
  const hosts: CliRuntimeHost[] = [], sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(hosts.map(host => host.close()));
    rmSync(root, {recursive: true, force: true});
  });
  const calls: Array<{module: string; argv: string[]; options: Parameters<CliRuntimeFork>[2]; child: Utility}> = [];
  let autoReady = true;
  const fork: CliRuntimeFork = (module, argv, options) => {
    const child = new Utility();
    calls.push({module, argv, options, child});
    if (autoReady) setImmediate(() => child.emit('message', {type: 'ready'}));
    return child;
  };
  const start = async (userData = root) => {
    const host = await startCliRuntimeHost({userData, appVersion: version, channel: 'development', runtimeDirectory: root,
      connectionFile: path.join(userData, 'mcp-connection.json'), fork, env: {LANG: 'C', TMPDIR: root,
        MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg', PATH: 'unused-path', NODE_OPTIONS: 'unused-node-options',
        ELECTRON_RUN_AS_NODE: '1', MIOON_TOKEN: 'unused-http-value', MIOON_CONNECTION_FILE: 'unused-connection-file'}});
    hosts.push(host);
    async function open() {
      const socket = createConnection(host.descriptor.socket);
      sockets.push(socket);
      await once(socket, 'connect');
      return peer(socket);
    }
    const hello = () => ({protocol: 1, channel: 'development', launcherVersion: version, appVersion: version,
      token: readFileSync(host.descriptor.tokenFile, 'utf8').trimEnd(), role: 'cli', argv: []});
    return {host, open, hello};
  };
  return {root, calls, start, holdReady: () => { autoReady = false; }};
}

test('discovery rotates owner-only credentials and falls back to a short private socket directory', {skip: unsupported}, async t => {
  const f = fixture(t);
  const userData = path.join(f.root, 'long'.repeat(35));
  mkdirSync(userData, {mode: 0o700});
  const first = await f.start(userData);
  const {descriptor} = first.host;
  assert.equal(descriptor.protocol, 1);
  assert.equal(descriptor.tokenFile, path.join(userData, 'cli-token'));
  assert.ok(Buffer.byteLength(descriptor.socket) <= 103);
  assert.equal(path.dirname(descriptor.socket).startsWith(userData), false);
  const directory = lstatSync(path.dirname(descriptor.socket));
  const socket = lstatSync(descriptor.socket), token = lstatSync(descriptor.tokenFile);
  assert.ok(directory.isDirectory() && socket.isSocket() && token.isFile());
  assert.deepEqual([directory.mode, socket.mode, token.mode].map(mode => mode & 0o777), [0o700, 0o600, 0o600]);
  assert.ok([directory, socket, token].every(info => info.uid === process.getuid?.()));
  assert.equal(token.size, 65);
  assert.equal(/^[a-f0-9]{64}\n$/u.test(readFileSync(descriptor.tokenFile, 'utf8')), true);
  const originalToken = first.hello().token;
  await first.host.close();
  assert.throws(() => lstatSync(descriptor.socket), {code: 'ENOENT'});
  assert.throws(() => lstatSync(descriptor.tokenFile), {code: 'ENOENT'});
  const second = await f.start(userData);
  assert.notEqual(second.host.descriptor.socket, descriptor.socket);
  assert.equal(second.hello().token === originalToken, false);
});

test('discovery rejects a symbolic link and leaves its target untouched', {skip: unsupported}, async t => {
  const f = fixture(t);
  const target = path.join(f.root, 'fixture');
  writeFileSync(target, 'unchanged', {mode: 0o600});
  symlinkSync(target, path.join(f.root, 'cli-token'));
  await assert.rejects(f.start());
  assert.equal(readFileSync(target, 'utf8'), 'unchanged');
});

test('READY waits for the child and forwards only the fixed module, validated cwd and app environment', {skip: unsupported}, async t => {
  const f = fixture(t);
  f.holdReady();
  const server = await f.start();
  const cwd = path.join(f.root, 'command-cwd');
  mkdirSync(cwd, {mode: 0o700});
  const client = await server.open();
  const wire = helloFrame({...server.hello(), role: 'mcp', argv: ['', '多字节🎬', '--help'], cwd});
  for (const bytes of [wire.subarray(0, 4), wire.subarray(4, 18), wire.subarray(18, 31), wire.subarray(31)]) {
    client.socket.write(bytes);
    await turn();
  }
  await waitedFor(() => f.calls.length === 1);
  const [call] = f.calls;
  assert.ok(call);
  assert.equal(call.module, path.join(f.root, 'mcp-runtime.cjs'));
  assert.deepEqual(call.argv, ['', '多字节🎬', '--help']);
  assert.deepEqual(call.options, {cwd, env: {TMPDIR: f.root, LANG: 'C', MIOON_FFMPEG_PATH: '/usr/bin/ffmpeg',
    MIOON_CONNECTION_FILE: path.join(f.root, 'mcp-connection.json')}, stdio: ['ignore', 'pipe', 'pipe'],
  serviceName: 'Mioon MCP', execArgv: [], allowLoadingUnsignedLibraries: false});
  let ready = false;
  const received = client.json(7).then(response => { ready = true; return response; });
  await turn();
  assert.equal(ready, false);
  call.child.emit('message', {type: 'ready'});
  assert.deepEqual(await received, {protocol: 1, appVersion: version, channel: 'development'});
});

test('bad HELLO, auth and version mismatch never fork a utility', {skip: unsupported}, async t => {
  const f = fixture(t), server = await f.start(), hello = server.hello();
  const wrongToken = hello.token[0] === '0' ? '1' + hello.token.slice(1) : '0' + hello.token.slice(1);
  const notDirectory = path.join(f.root, 'regular-file');
  writeFileSync(notDirectory, '', {mode: 0o600});
  const inaccessible = path.join(f.root, 'denied');
  const cases: Array<[Buffer, string]> = [
    [helloFrame({...hello, token: wrongToken, launcherVersion: '0.3.0'}), 'CLI_AUTH_FAILED'],
    [helloFrame({...hello, channel: 'production'}), 'CLI_VERSION_MISMATCH'],
    [helloFrame({...hello, launcherVersion: '0.3.0'}), 'CLI_VERSION_MISMATCH'],
    [helloFrame({...hello, appVersion: '0.3.0'}), 'CLI_VERSION_MISMATCH'],
    [helloFrame({...hello, protocol: 2}), 'CLI_VERSION_MISMATCH'],
    [helloFrame(hello, {protocol: 2}), 'CLI_VERSION_MISMATCH'],
    [helloFrame({...hello, cwd: 'relative'}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, cwd: notDirectory}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, cwd: path.join(notDirectory, 'nested')}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, cwd: path.join(inaccessible, 'nested')}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, cwd: '/' + '厚'.repeat(1_366)}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, env: {LANG: 'invalid'}}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, role: '../cli'}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, argv: ['embedded\0nul']}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, argv: ['\ud800']}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({...hello, argv: Array(257).fill('')}), 'CLI_PROTOCOL_ERROR'],
    [helloFrame(Buffer.from([0xff])), 'CLI_PROTOCOL_ERROR'],
    [helloFrame(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(hello))])), 'CLI_PROTOCOL_ERROR'],
    [helloFrame({}, {length: maximum + 1}), 'CLI_PROTOCOL_ERROR'],
    [Buffer.concat([helloFrame(hello), frame(2)]), 'CLI_PROTOCOL_ERROR'],
  ];
  mkdirSync(inaccessible, {mode: 0o000});
  try {
    for (const [request, code] of cases) {
      const client = await server.open();
      client.socket.write(request);
      const reply = await client.json(8) as {code: string; launcherVersion?: string; appVersion?: string; channel?: string};
      assert.equal(reply.code, code);
      if (code === 'CLI_VERSION_MISMATCH') assert.equal(reply.appVersion, version);
      if (code === 'CLI_AUTH_FAILED') assert.deepEqual(reply, {code});
      client.socket.destroy();
    }
  } finally {
    chmodSync(inaccessible, 0o700);
  }
  assert.equal(f.calls.length, 0);
});

test('the five-second handshake deadline closes an incomplete HELLO or a utility that never becomes ready',
  {skip: unsupported, timeout: 5_000}, async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = fixture(t);
    f.holdReady();
    const server = await f.start();
    const partial = await server.open();
    partial.socket.write(Buffer.from('MIOON'));
    t.mock.timers.tick(5_000);
    assert.deepEqual(await partial.json(8), {code: 'CLI_PROTOCOL_ERROR'});
    const stalled = await server.open();
    stalled.socket.write(helloFrame(server.hello()));
    await waitedFor(() => f.calls.length === 1);
    t.mock.timers.tick(5_000);
    assert.deepEqual(await stalled.json(8), {code: 'CLI_RUNTIME_UNAVAILABLE'});
    assert.equal(f.calls[0]?.child.killCount, 1);
  });

async function waitedFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the runtime host');
    await turn();
  }
}

test('stdin waits for ACK, EOF is ordered and CANCEL works during backpressure', {skip: unsupported}, async t => {
  const f = fixture(t), server = await f.start(), client = await server.open();
  client.socket.write(helloFrame(server.hello()));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  assert.equal(call.module, path.join(f.root, 'cli-runtime.cjs'));
  assert.equal(call.options.cwd, f.root);
  const a = Buffer.from([0x80, 0, 0xff]), b = Buffer.from([0x61, 0x62]);
  const first = frame(1, a);
  client.socket.write(first.subarray(0, 3));
  await turn();
  client.socket.write(first.subarray(3, 6));
  await turn();
  client.socket.write(Buffer.concat([first.subarray(6), frame(1, b), frame(2)]));
  await waitedFor(() => call.child.messages.length === 1);
  await turn();
  assert.deepEqual(call.child.messages, [{type: 'stdin', data: new Uint8Array(a)}]);
  call.child.emit('message', {type: 'stdin-ack'});
  await waitedFor(() => call.child.messages.length === 3);
  assert.deepEqual(call.child.messages, [{type: 'stdin', data: new Uint8Array(a)}, {type: 'stdin', data: new Uint8Array(b)}, {type: 'stdin-eof'}]);
  call.child.stdout.write('before cancellation');
  client.socket.write(frame(5));
  assert.equal((await client.next()).payload.toString(), 'before cancellation');
  assert.deepEqual(await client.json(6), {code: 130});
  assert.equal(call.child.killCount, 1);
});

test('normal EXIT follows both output pipes and frames preserve binary bytes within the limit', {skip: unsupported}, async t => {
  const f = fixture(t), server = await f.start(), client = await server.open();
  client.socket.write(helloFrame(server.hello()));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  const stdout = Buffer.alloc(maximum + 7, 0xff), stderr = Buffer.from([0xff, 0, 0x91, 0x61]);
  call.child.stdout.write(stdout);
  call.child.emit('exit', 17);
  call.child.stderr.end(stderr);
  call.child.stdout.end();
  const receivedOut: Buffer[] = [], receivedErr: Buffer[] = [];
  while (true) {
    const message = await client.next();
    if (message.type === 6) { assert.deepEqual(JSON.parse(message.payload.toString()), {code: 17}); break; }
    assert.ok(message.type === 3 || message.type === 4);
    (message.type === 3 ? receivedOut : receivedErr).push(message.payload);
  }
  assert.ok(Buffer.concat(receivedOut).equals(stdout));
  assert.ok(Buffer.concat(receivedErr).equals(stderr));
  assert.equal(call.child.killCount, 0);
});

test('malformed or out-of-order input closes the session and its utility', {skip: unsupported}, async t => {
  const invalid = [frame(1, Buffer.alloc(0), maximum + 1), frame(1), frame(3, Buffer.from('wrong direction')),
    Buffer.concat([frame(2), frame(2)]), Buffer.concat([frame(2), frame(1, Buffer.from('after eof'))])];
  const f = fixture(t), server = await f.start();
  for (const bytes of invalid) {
    const client = await server.open();
    client.socket.write(helloFrame(server.hello()));
    await client.json(7);
    const call = f.calls.at(-1)!;
    client.socket.write(bytes);
    assert.deepEqual(await client.json(8), {code: 'CLI_PROTOCOL_ERROR'});
    assert.equal(call.child.killCount, 1);
  }
});

test('an MCP utility blocked on stdin can still be cancelled', {skip: unsupported, timeout: 5_000}, async t => {
  const f = fixture(t), server = await f.start(), client = await server.open();
  client.socket.write(helloFrame({...server.hello(), role: 'mcp'}));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  client.socket.write(Buffer.concat([frame(1, Buffer.alloc(64 * 1024)), frame(5)]));
  assert.deepEqual(await client.json(6), {code: 130});
  assert.equal(call.child.messages.length, 1);
  assert.equal(call.child.killCount, 1);
});

test('CLI sessions retire at their five-minute limit', {skip: unsupported, timeout: 5_000}, async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const f = fixture(t), server = await f.start(), client = await server.open();
  client.socket.write(helloFrame(server.hello()));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  t.mock.timers.tick(299_999);
  assert.equal(call.child.killCount, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await client.json(8), {code: 'CLI_RUNTIME_UNAVAILABLE'});
  assert.equal(call.child.killCount, 1);
});

test('an unacknowledged MCP input is retired when unread bytes hide the peer disconnect', {skip: unsupported, timeout: 5_000}, async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = fixture(t), server = await f.start(), client = await server.open();
  client.socket.write(helloFrame({...server.hello(), role: 'mcp'}));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  t.mock.timers.tick(60_000);
  assert.equal(call.child.killCount, 0);

  client.socket.end(Buffer.concat([frame(1, Buffer.from('accepted')), frame(1, Buffer.from('still buffered'))]));
  await waitedFor(() => call.child.messages.length === 1);
  t.mock.timers.tick(29_999);
  assert.equal(call.child.killCount, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await client.json(8), {code: 'CLI_RUNTIME_UNAVAILABLE'});
  assert.equal(call.child.messages.length, 1);
  assert.equal(call.child.killCount, 1);
});

test('the concurrent limit counts handshakes and close waits for the active utility exit', {skip: unsupported, timeout: 5_000}, async t => {
  const f = fixture(t), server = await f.start();
  const clients = await Promise.all(Array.from({length: 8}, () => server.open()));
  const overflow = await server.open();
  assert.deepEqual(await overflow.json(8), {code: 'SESSION_LIMIT'});
  // A rejected peer which never reads or closes cannot keep host.close pending.
  await server.open();
  const client = clients[0]!;
  client.socket.write(helloFrame({...server.hello(), role: 'mcp'}));
  await client.json(7);
  const [call] = f.calls;
  assert.ok(call);
  call.child.autoExit = false;
  let closed = false;
  let closing: Promise<void>;
  try {
    client.socket.write(Buffer.concat([frame(1, Buffer.from('one')), frame(1, Buffer.from('two'))]));
    await waitedFor(() => call.child.messages.length === 1);
    closing = server.host.close().then(() => { closed = true; });
    assert.equal(call.child.killCount, 1);
    await turn();
    assert.equal(closed, false);
  } finally {
    call.child.finish(143);
  }
  await closing;
  assert.equal(closed, true);
  assert.throws(() => lstatSync(server.host.descriptor.tokenFile), {code: 'ENOENT'});
});
