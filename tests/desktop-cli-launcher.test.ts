import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import type {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const version = '1.2.3-test';
const appId = 'app.starroy.mioon.dev';
const token = 'b2'.repeat(32);
const maxFrame = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const parse = (bytes: Buffer) => JSON.parse(utf8.decode(bytes));
const jsonBytes = (value: object) => Buffer.from(JSON.stringify(value));

function encodeFrame(type: number, bytes: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + bytes.length);
  out[0] = type;
  out.writeUInt32BE(bytes.length, 1);
  out.set(bytes, 5);
  return out;
}

function session(socket: Socket) {
  const chunks = socket[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  async function take(length: number): Promise<Buffer> {
    while (pending.length < length) {
      const chunk = await chunks.next();
      assert.ok(!chunk.done && Buffer.isBuffer(chunk.value), 'launcher closed during a frame');
      pending = Buffer.concat([pending, chunk.value]);
    }
    const out = pending.subarray(0, length);
    pending = pending.subarray(length);
    return out;
  }
  return {
    async hello() {
      const header = await take(15);
      assert.equal(header.subarray(0, 9).toString('hex'), '4d494f4f4e434c4900');
      assert.equal(header.readUInt16BE(9), 1);
      const length = header.readUInt32BE(11);
      assert.ok(length > 0 && length <= maxFrame);
      return parse(await take(length));
    },
    async frame() {
      const header = await take(5);
      const size = header.readUInt32BE(1);
      assert.ok(size <= maxFrame);
      return {type: header[0], bytes: await take(size)};
    },
    ready() {
      const reply = encodeFrame(7, jsonBytes({protocol: 1, appVersion: version, channel: 'development'}));
      socket.write(reply.subarray(0, 2));
      socket.write(reply.subarray(2));
    },
  };
}

async function fixture(t: TestContext, root: string, launcher: string) {
  const directory = await mkdtemp(path.join(root, 's-'));
  const home = path.join(directory, 'home');
  const data = path.join(home, 'Library', 'Application Support', appId);
  const emptyPath = path.join(directory, 'empty-path');
  const socketPath = path.join(directory, 'rpc.sock');
  const connectionFile = path.join(data, 'mcp-connection.json'), tokenFile = path.join(data, 'cli-token');
  const env = {HOME: home, TMPDIR: directory, PATH: emptyPath, LANG: 'en_US.UTF-8'};
  await Promise.all([mkdir(data, {mode: 0o700, recursive: true}), mkdir(emptyPath, {mode: 0o700})]);
  async function discovery(overrides: Record<string, unknown> = {}) {
    await writeFile(connectionFile, JSON.stringify({version: 1, appId, channel: 'development', appVersion: version,
      pid: process.pid, url: 'http://127.0.0.1:4318', tokenFile: path.join(data, 'not-the-cli-token'),
      cli: {protocol: 1, socket: socketPath, tokenFile}, ...overrides}), {mode: 0o600});
    await writeFile(tokenFile, token + '\n', {mode: 0o600});
  }
  async function listen() {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    server.listen(socketPath);
    await once(server, 'listening');
    await chmod(socketPath, 0o600);
    const connection = once(server, 'connection').then(([socket]) => socket as Socket);
    return {connection};
  }
  function launch(args: string[], overrides: Record<string, string> = {}, readStdout?: Promise<void>) {
    const child = spawn(launcher, args, {env: {...env, ...overrides}, cwd: directory});
    child.stdin.on('error', () => {});
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
      const buffers: Buffer[] = [];
      for await (const chunk of stream) {
        assert.ok(Buffer.isBuffer(chunk));
        buffers.push(chunk);
      }
      return Buffer.concat(buffers);
    }
    const stdout = readStdout ? readStdout.then(() => read(child.stdout)) : read(child.stdout);
    const done = Promise.all([once(child, 'close'), stdout, read(child.stderr)])
      .then(([[code, signal], stdout, stderr]) => ({code, signal, stdout, stderr}));
    void done.catch(() => {});
    return {child, done};
  }
  return {data, directory, connectionFile, tokenFile, socketPath, discovery, listen, launch};
}

test('native development launcher talks the documented socket protocol', {skip: process.platform !== 'darwin', timeout: 45_000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'launcher-v1-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const launcher = path.join(root, 'mioon-dev');
  await exec('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-Wall', '-Wextra', '-Werror',
    `-DMIOON_LAUNCHER_VERSION="${version}"`, '-DMIOON_LAUNCHER_CHANNEL="development"',
    `-DMIOON_LAUNCHER_APP_ID="${appId}"`, '-DMIOON_LAUNCHER_COMMAND="mioon-dev"',
    'apps/desktop/native/cli-launcher/main.m', '-o', launcher], {cwd: path.resolve(import.meta.dirname, '..'), timeout: 20_000});

  await t.test('local version, CLI unavailable and quiet MCP unavailable', async st => {
    const f = await fixture(st, root, launcher);
    const current = await f.launch(['--version']).done;
    assert.equal(current.code, 0);
    assert.deepEqual(parse(current.stdout), {ok: true, data: {name: 'mioon', version}});
    assert.equal(current.stderr.length, 0);
    const unavailable = await f.launch(['doctor']).done;
    assert.equal(unavailable.code, 4);
    assert.equal(parse(unavailable.stdout).error.code, 'CLI_RUNTIME_UNAVAILABLE');
    assert.ok(unavailable.stderr.length > 0);
    const mcp = await f.launch(['mcp']).done;
    assert.equal(mcp.code, 1);
    assert.equal(mcp.stdout.length, 0);
    assert.ok(mcp.stderr.length > 0);
  });

  await t.test('default discovery, exact argv/cwd, bounded stdin and byte-exact stdout and stderr', async st => {
    const f = await fixture(st, root, launcher);
    await f.discovery();
    const {connection} = await f.listen();
    const args = ['project', 'create', '--input', '-', '', '引用 "目录"'];
    const client = f.launch(args);
    const socket = await connection;
    const rpc = session(socket);
    assert.deepEqual(await rpc.hello(), {protocol: 1, channel: 'development', launcherVersion: version,
      appVersion: version, token, role: 'cli', argv: args, cwd: f.directory});
    const input = Buffer.alloc(2 * maxFrame + 19, 0xe1);
    const stdout = Buffer.from([0x00, 0xe4, 0xb8, 0xad, 0xff]), stderr = Buffer.from([0xe2, 0x82, 0xac, 0x00]);
    rpc.ready();
    client.child.stdin.end(input);
    socket.write(encodeFrame(3, stdout));
    const seen: Buffer[] = [];
    for (;;) {
      const frame = await rpc.frame();
      if (frame.type === 2) { assert.equal(frame.bytes.length, 0); break; }
      assert.equal(frame.type, 1);
      assert.ok(frame.bytes.length > 0);
      seen.push(frame.bytes);
    }
    assert.deepEqual(Buffer.concat(seen), input);
    socket.end(Buffer.concat([encodeFrame(4, stderr), encodeFrame(6, jsonBytes({code: 2}))]));
    assert.deepEqual(await client.done, {code: 2, signal: null, stdout, stderr});
  });

  await t.test('explicit descriptor override, role selection and interrupt forwarding', async st => {
    const f = await fixture(st, root, launcher);
    await f.discovery();
    const descriptor = path.join(f.data, 'custom-connection.json');
    await rename(f.connectionFile, descriptor);
    const {connection} = await f.listen();
    const client = f.launch(['mcp', '--language', 'en'], {MIOON_CONNECTION_FILE: descriptor,
      MIOON_CLI_USER_DATA: path.join(f.directory, 'unused')});
    const socket = await connection;
    const rpc = session(socket);
    const hello = await rpc.hello();
    assert.equal(hello.role, 'mcp');
    assert.deepEqual(hello.argv, ['--language', 'en']);
    rpc.ready();
    const request = Buffer.from('mcp request\n');
    client.child.stdin.write(request);
    assert.deepEqual(await rpc.frame(), {type: 1, bytes: request});
    assert.equal(client.child.kill('SIGINT'), true);
    assert.deepEqual(await rpc.frame(), {type: 5, bytes: Buffer.alloc(0)});
    socket.end(encodeFrame(6, jsonBytes({code: 130})));
    assert.deepEqual(await client.done, {code: 130, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)});
  });

  await t.test('stdin advances while the local stdout consumer is paused', {timeout: 10_000}, async st => {
    const f = await fixture(st, root, launcher);
    await f.discovery();
    const {connection} = await f.listen();
    let resume!: () => void;
    const paused = new Promise<void>(resolve => {resume = resolve;});
    st.after(resume);
    const client = f.launch(['mcp'], {}, paused);
    const socket = await connection;
    const rpc = session(socket);
    await rpc.hello();
    rpc.ready();
    const stdout = Buffer.alloc(maxFrame, 0x80);
    socket.write(encodeFrame(3, stdout));
    const input = Buffer.alloc(maxFrame + 11, 0x90);
    client.child.stdin.end(input);
    const frames: Buffer[] = [];
    for (;;) {
      const frame = await rpc.frame();
      if (frame.type === 2) break;
      assert.equal(frame.type, 1);
      frames.push(frame.bytes);
    }
    assert.deepEqual(Buffer.concat(frames), input);
    resume();
    socket.end(encodeFrame(6, jsonBytes({code: 0})));
    assert.deepEqual(await client.done, {code: 0, signal: null, stdout, stderr: Buffer.alloc(0)});
  });

  await t.test('authentication failure, immediate overload and version mismatch', async st => {
    const cases = ['CLI_AUTH_FAILED', 'SESSION_LIMIT', 'CLI_VERSION_MISMATCH'];
    for (const code of cases) {
      const f = await fixture(st, root, launcher);
      await f.discovery();
      const {connection} = await f.listen();
      const client = f.launch(['doctor'], {LC_ALL: 'zh_CN.UTF-8'});
      const socket = await connection;
      if (code !== 'SESSION_LIMIT') await session(socket).hello();
      socket.end(encodeFrame(8, jsonBytes({code, launcherVersion: version, appVersion: '9.8.7', channel: 'development'})));
      const result = await client.done;
      assert.equal(result.code, 4);
      assert.equal(parse(result.stdout).error.code, code);
      assert.ok(result.stderr.length > 0);
      if (code === 'CLI_VERSION_MISMATCH') {
        assert.ok(utf8.decode(result.stderr).includes(`命令行工具来自 Mioon ${version}，当前运行的是 9.8.7，请在 Mioon 设置里修复命令行工具。`));
      }
    }
  });

  await t.test('stale discovery and nonprivate or symlinked transport are refused', async st => {
    const f = await fixture(st, root, launcher);
    await f.discovery({pid: 2_147_483_647});
    assert.equal((await f.launch(['doctor']).done).code, 4);
    await f.discovery({channel: 'production', appId: 'app.starroy.mioon'});
    const wrongChannel = await f.launch(['doctor']).done;
    assert.equal(wrongChannel.code, 4);
    assert.equal(parse(wrongChannel.stdout).error.code, 'CLI_VERSION_MISMATCH');
    await f.discovery();
    await f.listen();
    await chmod(f.socketPath, 0o666);
    assert.equal((await f.launch(['doctor']).done).code, 4);
    await chmod(f.socketPath, 0o600);
    await chmod(f.tokenFile, 0o644);
    assert.equal((await f.launch(['doctor']).done).code, 4);
    await chmod(f.tokenFile, 0o600);
    const alias = path.join(f.directory, 'symlink.json');
    await symlink(f.connectionFile, alias);
    assert.equal((await f.launch(['doctor'], {MIOON_CONNECTION_FILE: alias}).done).code, 4);
  });

  await t.test('oversize frames, wrong READY and disconnect after MCP READY', async st => {
    for (const mode of ['oversize', 'wrong-ready', 'disconnect']) {
      const f = await fixture(st, root, launcher);
      await f.discovery();
      const {connection} = await f.listen();
      const client = f.launch(['mcp'], {MIOON_CLI_USER_DATA: f.data});
      const socket = await connection;
      const rpc = session(socket);
      await rpc.hello();
      if (mode === 'wrong-ready') {
        socket.end(encodeFrame(7, jsonBytes({protocol: 1, appVersion: '9.8.7', channel: 'development'})));
      } else {
        rpc.ready();
        if (mode === 'disconnect') socket.end();
        else {
          const bad = Buffer.alloc(5);
          bad[0] = 3;
          bad.writeUInt32BE(maxFrame + 1, 1);
          socket.end(bad);
        }
      }
      const result = await client.done;
      assert.equal(result.code, mode === 'wrong-ready' ? 1 : 4);
      assert.equal(result.stdout.length, 0);
      assert.ok(result.stderr.length > 0);
    }
  });
});
