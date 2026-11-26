import {randomBytes, timingSafeEqual} from 'node:crypto';
import {chmodSync, lstatSync, realpathSync, rmdirSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPrivateTemporaryDirectory, readPrivateFile, removePrivateFile, validatePrivateDirectory,
  writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {cliRuntimeFrame, cliRuntimeFrameHeaderLength, cliRuntimeFrames, cliRuntimeJsonFrame, cliRuntimeMaxPayload,
  cliRuntimeProtocol, helloHeaderLength, isCliRuntimeVersion, readHello, readHelloHeader} from './cli-runtime-wire.ts';
import type {CliRuntimeChannel, CliRuntimeErrorCode, CliRuntimeHello} from './cli-runtime-wire.ts';

const maxSessions = 8;
const handshakeTimeoutMs = 5_000;
const cliTimeoutMs = 5 * 60_000;
const stdinProgressTimeoutMs = 30_000;
const terminateGraceMs = 1_000;
const socketMaxBytes = 103; // macOS sun_path includes its NUL.
const environmentKeys = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'WINDIR', 'MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH'] as const;
const modules = {cli: 'cli-runtime.cjs', mcp: 'mcp-runtime.cjs'} as const;
const empty = Buffer.alloc(0);

type OutputPipe = NodeJS.ReadableStream & {destroy?(): void};
export interface CliRuntimeUtility {
  readonly pid: number | undefined;
  readonly stdout: OutputPipe | null;
  readonly stderr: OutputPipe | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'error' | 'spawn', listener: () => void): unknown;
}
export type CliRuntimeFork = (modulePath: string, args: string[], options: {
  env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; serviceName: string;
  cwd: string; execArgv: string[]; allowLoadingUnsignedLibraries: false;
}) => CliRuntimeUtility;
export interface CliRuntimeDescriptor {
  readonly protocol: 1;
  readonly socket: string;
  readonly tokenFile: string;
}
export interface CliRuntimeHostOptions {
  readonly userData: string;
  readonly appVersion: string;
  readonly channel: CliRuntimeChannel;
  readonly runtimeDirectory: string;
  readonly connectionFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fork: CliRuntimeFork;
}
export interface CliRuntimeHost {
  readonly descriptor: CliRuntimeDescriptor;
  close(): Promise<void>;
}

function socketError(code: CliRuntimeErrorCode, details?: object): Buffer {
  return cliRuntimeJsonFrame(cliRuntimeFrames.error, {...details, code});
}

function socketDirectory(userData: string): string {
  const fits = (parent: string): boolean => Buffer.byteLength(path.join(parent, 'cli-XXXXXX', 'rpc.sock')) <= socketMaxBytes;
  if (fits(userData)) return createPrivateTemporaryDirectory(userData, 'cli-');
  for (const candidate of [tmpdir(), process.platform === 'darwin' ? '/private/tmp' : '/tmp']) {
    try {
      const parent = realpathSync(candidate);
      if (fits(parent)) return createPrivateTemporaryDirectory(parent, 'cli-');
    } catch { /* Try the system temporary root if the configured one is unavailable. */ }
  }
  throw new Error('No private CLI socket directory is available');
}

function sendAndClose(socket: Socket, frame: Buffer): void {
  if (socket.destroyed || !socket.writable) { socket.destroy(); return; }
  const timer = setTimeout(() => socket.destroy(), terminateGraceMs);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.end(frame, () => socket.destroy());
}

function write(socket: Socket, frame: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(frame, error => error ? reject(error) : resolve());
  });
}

interface Session {
  readonly done: Promise<void>;
  stop(): void;
}

function createSession(socket: Socket, configuration: Pick<CliRuntimeHostOptions, 'appVersion' | 'channel' | 'runtimeDirectory' | 'userData' | 'fork'>,
  token: Buffer, env: NodeJS.ProcessEnv): Session {
  let resolveLifetime!: () => void;
  const done = new Promise<void>(resolve => { resolveLifetime = resolve; });
  const expires = Date.now() + cliTimeoutMs;
  let phase: 'header' | 'hello' | 'starting' | 'ready' | 'draining' | 'closed' = 'header';
  let helloHeader: ReturnType<typeof readHelloHeader> = null;
  let inputHeader: {type: number; length: number} | null = null;
  let child: CliRuntimeUtility | undefined;
  let stdout: OutputPipe | null = null, stderr: OutputPipe | null = null;
  let outputs: Promise<void[]> | undefined;
  let exited = false, disconnected = false, reading = false, awaitingAck = false;
  let eof = false, cancelled = false, terminationRequested = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let timer = setTimeout(() => finish(socketError(phase === 'starting' ? 'CLI_RUNTIME_UNAVAILABLE' : 'CLI_PROTOCOL_ERROR')), handshakeTimeoutMs);
  timer.unref();

  function settle(): void {
    if (disconnected && (!child || exited)) resolveLifetime();
  }

  function requestTermination(): void {
    if (!child || exited || terminationRequested) return;
    const owned = child;
    terminationRequested = true;
    // Chromium owns reaping this utility. Escalate once if the exit event is delayed.
    forceTimer = setTimeout(() => {
      const pid = owned.pid;
      if (exited || pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
      try { process.kill(pid, 'SIGKILL'); } catch { /* Wait for the owned exit event. */ }
    }, terminateGraceMs);
    try { owned.kill(); } catch { /* The owned hard-stop phase still runs. */ }
  }

  function finish(frame?: Buffer): void {
    if (phase === 'closed') {
      if (!frame) socket.destroy();
      return;
    }
    phase = 'closed';
    clearTimeout(timer);
    clearTimeout(ackTimer);
    requestTermination();
    stdout?.destroy?.();
    stderr?.destroy?.();
    if (frame) sendAndClose(socket, frame);
    else socket.destroy();
  }

  function protocolError(): void { finish(socketError('CLI_PROTOCOL_ERROR')); }

  async function pump(stream: OutputPipe, type: number): Promise<void> {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length; offset += cliRuntimeMaxPayload) {
        if (phase === 'closed') return;
        // Each pipe holds at most one framed write until the socket flushes it.
        await write(socket, cliRuntimeFrame(type, bytes.subarray(offset, offset + cliRuntimeMaxPayload)));
      }
    }
  }

  function onExit(code: number): void {
    exited = true;
    clearTimeout(forceTimer);
    clearTimeout(ackTimer);
    settle();
    if (phase === 'closed') return;
    if (phase === 'starting' || !outputs) { finish(socketError('CLI_RUNTIME_UNAVAILABLE')); return; }
    phase = 'draining';
    void outputs.then(() => {
      if (phase !== 'closed') finish(cliRuntimeJsonFrame(cliRuntimeFrames.exit, {code: cancelled ? 130 : code}));
    }, () => finish(socketError('CLI_RUNTIME_UNAVAILABLE')));
  }

  function onMessage(message: unknown, hello: CliRuntimeHello): void {
    const type = message && typeof message === 'object' && 'type' in message ? message.type : null;
    if (type === 'ready' && phase === 'starting') {
      if (socket.readableLength > 0) { protocolError(); return; }
      clearTimeout(timer);
      if (hello.role === 'cli') {
        timer = setTimeout(() => finish(socketError('CLI_RUNTIME_UNAVAILABLE')), Math.max(0, expires - Date.now()));
        timer.unref();
      }
      phase = 'ready';
      // Queue READY before allowing either pipe to write a frame.
      socket.write(cliRuntimeJsonFrame(cliRuntimeFrames.ready, {protocol: cliRuntimeProtocol,
        appVersion: configuration.appVersion, channel: configuration.channel}));
      outputs = Promise.all([pump(stdout!, cliRuntimeFrames.stdout), pump(stderr!, cliRuntimeFrames.stderr)]);
      void outputs.catch(() => finish(socketError('CLI_RUNTIME_UNAVAILABLE')));
    } else if (type === 'stdin-ack' && phase === 'ready' && awaitingAck) {
      clearTimeout(ackTimer);
      awaitingAck = false;
      readInput();
    }
  }

  async function startChild(hello: CliRuntimeHello): Promise<void> {
    const authenticated = /^[a-f0-9]{64}$/u.test(hello.token)
      && timingSafeEqual(token, Buffer.from(hello.token, 'hex'));
    if (!authenticated) { finish(socketError('CLI_AUTH_FAILED')); return; }
    if (helloHeader?.protocol !== cliRuntimeProtocol || hello.protocol !== cliRuntimeProtocol
      || hello.channel !== configuration.channel || hello.launcherVersion !== configuration.appVersion
      || hello.appVersion !== configuration.appVersion) {
      finish(socketError('CLI_VERSION_MISMATCH', {launcherVersion: hello.launcherVersion,
        appVersion: configuration.appVersion, channel: configuration.channel}));
      return;
    }
    if (socket.readableLength > 0) { protocolError(); return; }
    const cwd = hello.cwd ?? configuration.userData;
    if (!path.isAbsolute(cwd)) { protocolError(); return; }
    phase = 'starting';
    const directory = await stat(cwd).then(info => info.isDirectory(), () => false);
    if (phase !== 'starting' || socket.destroyed) return;
    if (!directory || socket.readableLength > 0) { protocolError(); return; }
    try {
      child = configuration.fork(path.join(configuration.runtimeDirectory, modules[hello.role]), hello.argv,
        {cwd, env: {...env}, stdio: ['ignore', 'pipe', 'pipe'], serviceName: `Mioon ${hello.role.toUpperCase()}`,
          execArgv: [], allowLoadingUnsignedLibraries: false});
      child.on('exit', onExit);
      child.on('error', () => finish(socketError('CLI_RUNTIME_UNAVAILABLE')));
      child.on('spawn', () => {
        if (terminationRequested && !exited) {
          try { child?.kill(); } catch { /* The owned hard-stop phase still runs. */ }
        }
      });
      stdout = child.stdout;
      stderr = child.stderr;
      const pipeFailure = () => finish(socketError('CLI_RUNTIME_UNAVAILABLE'));
      stdout?.on('error', pipeFailure);
      stderr?.on('error', pipeFailure);
      if (!stdout || !stderr) { pipeFailure(); return; }
      child.on('message', message => onMessage(message, hello));
    } catch { finish(socketError('CLI_RUNTIME_UNAVAILABLE')); }
  }

  function readExact(length: number): Buffer | null {
    if (length === 0) return empty;
    const bytes: unknown = socket.read(length);
    if (bytes === null) return null;
    if (!Buffer.isBuffer(bytes) || bytes.length !== length) { protocolError(); return null; }
    return bytes;
  }

  function readInput(): void {
    if (reading) return;
    reading = true;
    try {
      if (phase === 'header') {
        const bytes = readExact(helloHeaderLength);
        if (!bytes) return;
        helloHeader = readHelloHeader(bytes);
        if (!helloHeader) { protocolError(); return; }
        phase = 'hello';
      }
      if (phase === 'hello' && helloHeader) {
        const bytes = readExact(helloHeader.length);
        if (!bytes) return;
        const hello = readHello(bytes);
        if (hello) void startChild(hello);
        else protocolError();
        return;
      }
      if (phase === 'starting' && socket.readableLength > 0) { protocolError(); return; }
      while (phase === 'ready') {
        if (!inputHeader) {
          const bytes = readExact(cliRuntimeFrameHeaderLength);
          if (!bytes) return;
          const type = bytes[0]!, length = bytes.readUInt32BE(1);
          const valid = type === cliRuntimeFrames.stdin ? !eof && length > 0 && length <= cliRuntimeMaxPayload
            : length === 0 && (type === cliRuntimeFrames.cancel || (type === cliRuntimeFrames.stdinEof && !eof));
          if (!valid) { protocolError(); return; }
          inputHeader = {type, length};
        }
        // Only one STDIN block can be submitted to Electron's message port.
        // A following CANCEL or EOF can be handled without additional buffering.
        if (inputHeader.type === cliRuntimeFrames.stdin && awaitingAck) return;
        const data = readExact(inputHeader.length);
        if (!data) return;
        const {type} = inputHeader;
        inputHeader = null;
        if (type === cliRuntimeFrames.cancel) {
          phase = 'draining';
          cancelled = true;
          clearTimeout(ackTimer);
          requestTermination();
        } else if (type === cliRuntimeFrames.stdinEof) {
          eof = true;
          clearTimeout(ackTimer);
          child!.postMessage({type: 'stdin-eof'});
        } else {
          awaitingAck = true;
          // A blocked reader can hide disconnect behind unread socket bytes.
          ackTimer = setTimeout(() => finish(socketError('CLI_RUNTIME_UNAVAILABLE')), stdinProgressTimeoutMs);
          ackTimer.unref();
          child!.postMessage({type: 'stdin', data: new Uint8Array(data)});
        }
      }
    } catch { finish(socketError('CLI_RUNTIME_UNAVAILABLE')); }
    finally { reading = false; }
  }

  socket.on('readable', readInput);
  socket.on('error', () => finish());
  socket.on('end', () => finish());
  socket.on('close', () => {
    disconnected = true;
    finish();
    settle();
  });
  return {done, stop: () => finish()};
}

export async function startCliRuntimeHost(options: CliRuntimeHostOptions): Promise<CliRuntimeHost> {
  const {userData, appVersion, channel, runtimeDirectory, connectionFile} = options;
  if (!isCliRuntimeVersion(appVersion) || (channel !== 'production' && channel !== 'development')
    || !path.isAbsolute(userData) || !path.isAbsolute(runtimeDirectory) || path.dirname(connectionFile) !== userData) {
    throw new TypeError('Invalid CLI runtime host configuration');
  }
  validatePrivateDirectory(userData);
  const token = randomBytes(32), tokenText = token.toString('hex') + '\n';
  const tokenFile = path.join(userData, 'cli-token');
  const directory = socketDirectory(userData), socketPath = path.join(directory, 'rpc.sock');
  const env: NodeJS.ProcessEnv = {};
  for (const key of environmentKeys) if (typeof options.env[key] === 'string') env[key] = options.env[key];
  env.MIOON_CONNECTION_FILE = connectionFile;
  const sessions = new Set<Session>();
  let published = false;
  let closing: Promise<void> | undefined;
  const server = createServer(socket => {
    if (!published || sessions.size >= maxSessions) {
      socket.on('error', () => socket.destroy());
      sendAndClose(socket, socketError(published ? 'SESSION_LIMIT' : 'CLI_RUNTIME_UNAVAILABLE'));
      return;
    }
    const session = createSession(socket, options, token, env);
    sessions.add(session);
    void session.done.then(() => { sessions.delete(session); });
  });
  function close(): Promise<void> {
    if (closing) return closing;
    published = false;
    const closed = new Promise<void>(resolve => { server.close(() => resolve()); });
    const active = [...sessions];
    for (const session of active) session.stop();
    closing = Promise.all([closed, ...active.map(session => session.done)]).then(() => {
      try {
        const storage = {root: userData, maxBytes: 65};
        if (readPrivateFile(tokenFile, {...storage, allowMissing: true, encoding: 'utf8'}) === tokenText) {
          removePrivateFile(tokenFile, storage);
        }
      } catch { /* Preserve discovery replaced by an untrusted or newer entry. */ }
      try { rmdirSync(directory); } catch { /* Never recursively remove unexpected directory contents. */ }
    });
    return closing;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => { void close(); });
    chmodSync(socketPath, 0o600);
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) {
      throw new Error('CLI runtime socket is not private');
    }
    writePrivateFileAtomic(tokenFile, tokenText, {root: userData, maxBytes: 65});
    published = true;
    return {descriptor: {protocol: cliRuntimeProtocol, socket: socketPath, tokenFile}, close};
  } catch (error) {
    await close();
    throw error;
  }
}
