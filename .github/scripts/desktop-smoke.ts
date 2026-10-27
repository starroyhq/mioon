import {spawn} from 'node:child_process';
import {access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {argumentsFor, CheckFailure, cleanEnvironment, command, executable, fail, isMain, report, safeFailure, targetArch, targetPlatform} from './media-environment.ts';
import type {Check, TargetArch, TargetPlatform} from './media-environment.ts';
import {EXIT_DIAGNOSTIC_LIMITS} from '../../apps/desktop/src/exit-diagnostics.ts';
import type {ExitDiagnosticRecord} from '../../apps/desktop/src/exit-diagnostics.ts';
import {classifyRendererEvent,RENDERER_DIAGNOSTIC_LIMITS} from '../../apps/desktop/src/renderer-diagnostics.ts';
import type {RendererDiagnosticRecord} from '../../apps/desktop/src/renderer-diagnostics.ts';

interface Discovery {appId: string; channel: string; url: string; pid: number; tokenFile: string}
interface Timeline {revision: number; tracks: Array<{id: string; kind: string}>; clips: unknown[]}
interface Job {id: string; status: string; url?: string}
interface Outcome {code: number | null; signal: NodeJS.Signals | null}
interface SmokeReport {ok: boolean; platform: TargetPlatform; arch: TargetArch; checks: Check[]; phase: string; error?: string; render?: {bytes: number; width: number; height: number}; exit?: Outcome; sigtermSent?: boolean; shutdownDiagnostics?: SmokeShutdownDiagnostics}
export const smokeTimeouts = Object.freeze({startup: 90000, render: 120000, exit: 30000});
export function smokeEnvironment(source: NodeJS.ProcessEnv, userData: string, ffmpeg: string, ffprobe: string): NodeJS.ProcessEnv {
  return {...cleanEnvironment(source), MIOON_DESKTOP_USER_DATA: userData, MIOON_ENABLE_LIVE_PROVIDER: '0', MIOON_FFMPEG_PATH: ffmpeg, MIOON_FFPROBE_PATH: ffprobe};
}
type DiagnosticStatus = 'ok' | 'missing' | 'unsafe' | 'oversized' | 'invalid' | 'changed' | 'unavailable';
type SafeBackendDiagnostic = Pick<ExitDiagnosticRecord,'event'|'classification'|'reason'|'state'|'expected'|'forced'|'exitConfirmed'|'shutdownFailed'|'mediaExitConfirmed'|'code'|'termination'>;
type SafeRendererDiagnostic = Pick<RendererDiagnosticRecord,'event'|'classification'|'reason'|'exitCode'>;
interface DiagnosticSnapshot<T> {status: DiagnosticStatus; records: T[]}
export interface SmokeShutdownDiagnostics {
  scope: DiagnosticStatus;
  transientFiles: {connectionPresent: boolean | null; tokenPresent: boolean | null; workspaceLockPresent: boolean | null};
  backend: DiagnosticSnapshot<SafeBackendDiagnostic>;
  renderer: DiagnosticSnapshot<SafeRendererDiagnostic>;
}
class DiagnosticReadFailure extends Error {
  readonly status: DiagnosticStatus;
  constructor(status: DiagnosticStatus) {super(status);this.status=status;}
}
function diagnosticFailure(status: DiagnosticStatus): never {throw new DiagnosticReadFailure(status);}
const diagnosticStatus = (error: unknown): DiagnosticStatus => error instanceof DiagnosticReadFailure ? error.status :
  error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'missing' : 'unavailable';
const enumField = <T extends string>(value: unknown, allowed: readonly T[]): T | null => allowed.find(item => item === value) ?? null;
const booleanField = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const numericField = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
function diagnosticObject(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) diagnosticFailure('invalid');
  return value as Record<string,unknown>;
}
function safeBackendDiagnostic(value: unknown): SafeBackendDiagnostic {
  const data = diagnosticObject(value);
  return {
    event:enumField(data.event,['start','ready','stop-requested','termination-requested','backend-notice','exit','stop-unconfirmed','spawn-failed']),
    classification:enumField(data.classification,['normal','terminated','abnormal','connection-lost']),
    reason:enumField(data.reason,['stop-requested','startup-timeout','startup-error','startup-failed','startup-communication-failed','invalid-origin','runtime-error','communication-lost','lease-expired','signal-term','signal-int','uncaught-exception','unhandled-rejection','shutdown-failed','utility-exit']),
    state:enumField(data.state,['idle','starting','running','stopping','stopped','failed','stop-unconfirmed','media-unconfirmed']),
    expected:booleanField(data.expected),forced:booleanField(data.forced),exitConfirmed:booleanField(data.exitConfirmed),
    shutdownFailed:booleanField(data.shutdownFailed),mediaExitConfirmed:booleanField(data.mediaExitConfirmed),code:numericField(data.code),
    termination:enumField(data.termination,['utility-kill','owned-sigkill'])
  };
}
function safeRendererDiagnostic(value: unknown): SafeRendererDiagnostic {
  const data = diagnosticObject(value), event = enumField(data.event,['unresponsive','responsive','render-process-gone']),
    reason = enumField(data.reason,['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure']);
  return {event,reason,classification:classifyRendererEvent(event,{reason}),exitCode:numericField(data.exitCode)};
}
async function ownedDiagnosticDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
      (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) diagnosticFailure('unsafe');
}
const sameDiagnosticFile = (a: Stats,b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function readDiagnosticFile<T>(file: string,maxBytes: number,sanitize: (value: unknown) => T): Promise<DiagnosticSnapshot<T>> {
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid())) diagnosticFailure('unsafe');
    if (before.size > maxBytes) diagnosticFailure('oversized');
    const handle = await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try {
      if (!sameDiagnosticFile(before,await handle.stat())) diagnosticFailure('changed');
      const buffer = Buffer.alloc(maxBytes+1); let bytes = 0;
      while (bytes < buffer.length) {const part = await handle.read(buffer,bytes,buffer.length-bytes,bytes); if (!part.bytesRead) break; bytes+=part.bytesRead;}
      if (bytes > maxBytes) diagnosticFailure('oversized');
      if (bytes !== before.size || !sameDiagnosticFile(before,await handle.stat()) || !sameDiagnosticFile(before,await lstat(file))) diagnosticFailure('changed');
      let records: T[];
      try {
        const lines = new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes)).split('\n').filter(line=>line.trim());
        if (lines.length > 256) diagnosticFailure('oversized');
        records=lines.map(line=>sanitize(JSON.parse(line) as unknown));
      } catch (error) {if (error instanceof DiagnosticReadFailure) throw error; diagnosticFailure('invalid');}
      return {status:'ok',records};
    } finally {await handle.close();}
  } catch (error) {return {status:diagnosticStatus(error),records:[]};}
}
async function transientPresence(file: string): Promise<boolean | null> {
  try {const info = await lstat(file); return info.isSymbolicLink() ? null : true;}
  catch (error) {return diagnosticStatus(error) === 'missing' ? false : null;}
}
/** Only this invocation's canonical synthetic root is eligible. No discovery,
 * arbitrary log paths or user data are read; diagnostic text is never copied. */
export async function captureSmokeShutdownDiagnostics(ownedRoot: string): Promise<SmokeShutdownDiagnostics> {
  const result: SmokeShutdownDiagnostics = {scope:'unavailable',transientFiles:{connectionPresent:null,tokenPresent:null,workspaceLockPresent:null},backend:{status:'unavailable',records:[]},renderer:{status:'unavailable',records:[]}};
  try {
    if (!path.isAbsolute(ownedRoot) || path.dirname(ownedRoot) !== await realpath(tmpdir()) || !/^mioon-ci-native-[A-Za-z0-9]{6}$/.test(path.basename(ownedRoot))) diagnosticFailure('unsafe');
    await ownedDiagnosticDirectory(ownedRoot);
    const userData = path.join(ownedRoot,'user-data'); await ownedDiagnosticDirectory(userData); result.scope='ok';
    result.transientFiles.connectionPresent=await transientPresence(path.join(userData,'mcp-connection.json'));
    result.transientFiles.tokenPresent=await transientPresence(path.join(userData,'mcp-token'));
    const workspace = path.join(userData,'workspace');
    try {await ownedDiagnosticDirectory(workspace);}
    catch (error) {
      const status=diagnosticStatus(error); result.transientFiles.workspaceLockPresent=status==='missing'?false:null;
      result.backend={status,records:[]}; result.renderer={status,records:[]}; return result;
    }
    result.transientFiles.workspaceLockPresent=await transientPresence(path.join(workspace,'server.lock'));
    const directory = path.join(workspace,'diagnostics');
    try {await ownedDiagnosticDirectory(directory);}
    catch (error) {const status=diagnosticStatus(error); result.backend={status,records:[]};result.renderer={status,records:[]};return result;}
    result.backend=await readDiagnosticFile(path.join(directory,'backend-exit.jsonl'),EXIT_DIAGNOSTIC_LIMITS.maxBytes,safeBackendDiagnostic);
    result.renderer=await readDiagnosticFile(path.join(directory,'renderer-health.jsonl'),RENDERER_DIAGNOSTIC_LIMITS.maxBytes,safeRendererDiagnostic);
  } catch (error) {const status=diagnosticStatus(error);result.scope=status;result.backend={status,records:[]};result.renderer={status,records:[]};}
  return result;
}
export function validateDiscovery(value: unknown, userData: string): Discovery {
  if (!value || typeof value !== 'object') fail('INVALID_DISCOVERY');
  const data = value as Partial<Discovery>;
  if (data.appId !== 'app.starroy.mioon' || data.channel !== 'production' || !Number.isSafeInteger(data.pid) || (data.pid ?? 0) <= 1 ||
      data.tokenFile !== path.join(userData, 'mcp-token') || typeof data.url !== 'string') fail('INVALID_DISCOVERY');
  let url: URL; try { url = new URL(data.url); } catch { fail('INVALID_DISCOVERY_ORIGIN'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_DISCOVERY_ORIGIN');
  return data as Discovery;
}
export function mountedDmgFor(binary: string): string | null {
  // This parses a macOS bundle path even when pure checks run on Windows.
  const marker = '/Contents/MacOS/';
  const index = binary.lastIndexOf(marker); if (index < 0) return null;
  const app = binary.slice(0, index), mount = path.posix.dirname(app);
  return path.posix.basename(app).endsWith('.app') && path.posix.basename(mount).startsWith('mioon-ci-dmg-') ? mount : null;
}
export function extractedTarFor(binary: string): string | null {
  const app = path.posix.dirname(binary), directory = path.posix.dirname(app);
  return path.posix.basename(binary) === 'mioon' && /^mioon-[0-9A-Za-z.+-]+-linux-x64$/.test(path.posix.basename(app)) &&
    /^mioon-ci-extract-[A-Za-z0-9]{6}$/.test(path.posix.basename(directory)) ? directory : null;
}
export async function boundedPoll<T>(fn: (remaining: number) => Promise<T | false>, timeout: number, code: string, exited: () => boolean = () => false): Promise<T> {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) fail('INVALID_POLL_TIMEOUT');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited()) fail('APP_EXITED_EARLY');
    const remaining = Math.max(1, deadline - Date.now());
    let timer: NodeJS.Timeout | undefined;
    let value: T | false;
    try {
      value = await Promise.race([fn(remaining), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), {name: 'PollTimeout'})), remaining);
      })]);
    } catch (error) {
      if (error instanceof Error && error.name === 'PollTimeout') fail(code);
      throw error;
    } finally { clearTimeout(timer); }
    if (value !== false) return value;
    await new Promise(resolve => setTimeout(resolve, Math.min(150, Math.max(1, deadline - Date.now()))));
  }
  fail(code);
}
async function windowVisible(platform: TargetPlatform, pid: number, remaining: number): Promise<boolean> {
  try {
    if (platform === 'linux') return /^\d+/m.test(await command('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], 'WINDOW_NOT_VISIBLE', {timeout: Math.min(3000, remaining)}));
    const swift = `import Foundation\nimport CoreGraphics\nlet windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []\nlet found = windows.contains { item in guard let pid = item[kCGWindowOwnerPID as String] as? Int, let layer = item[kCGWindowLayer as String] as? Int, let bounds = item[kCGWindowBounds as String] as? [String: Any], let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else { return false }; return pid == ${pid} && layer == 0 && width >= 300 && height >= 200 }\nprint(found ? "visible" : "missing")`;
    return (await command('/usr/bin/swift', ['-e', swift], 'WINDOW_PROBE_FAILED', {timeout: Math.min(30000, remaining)})).trim() === 'visible';
  } catch { return false; }
}
async function absent(file: string): Promise<boolean> {
  try { await access(file); return false; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
}
export interface CompositionOptions {
  origin: string; token: string; video: string; audio: string; ffprobe: string; directory: string; env: NodeJS.ProcessEnv;
  onPhase?: (phase: string) => void; onCheck?: (name: string) => void; exited?: () => boolean;
}
/** Uses the same public HTTP recipe in native CI and source-only integration tests. */
export async function exerciseComposition(options: CompositionOptions): Promise<{bytes: number; width: number; height: number}> {
  const {origin, token, video, audio, ffprobe, directory, env} = options;
  const check = options.onCheck ?? (() => {});
  let renderDeadline = 0;
  const rpc = async <T>(operation: string, input: unknown = {}): Promise<T> => {
    const response = await fetch(`${origin}/api/rpc`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({operation, input}), signal: AbortSignal.timeout(renderDeadline ? Math.min(15000, Math.max(1, renderDeadline - Date.now())) : 15000)});
    const body = await response.json() as {ok?: unknown; data: T};
    if (response.status !== 200 || body.ok !== true) fail('RPC_FAILED'); return body.data;
  };
  const denied = await fetch(`${origin}/api/rpc`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation: 'project.list'}), signal: AbortSignal.timeout(10000)});
  if (denied.status !== 401) fail('ANONYMOUS_RPC_NOT_DENIED'); check('anonymous-http-rpc-denied');
  options.onPhase?.('seed');
  const project = await rpc<{id: string; revision: number}>('project.create', {name: 'CI synthetic local composition', timelinePresetId: 'landscape_1080'});
  let timeline = await rpc<Timeline>('timeline.get', {projectId: project.id});
  const projectView = await rpc<{project: {revision: number}}>('project.get', {projectId: project.id});
  await rpc<unknown>('timeline.format.set', {projectId: project.id, expectedProjectRevision: projectView.project.revision, expectedRevision: timeline.revision, requestId: randomUUID(), presetId: 'landscape_720'});
  timeline = await rpc<Timeline>('timeline.get', {projectId: project.id});
  for (const [file, mimeType, kind] of [[video, 'video/mp4', 'video'], [audio, 'audio/wav', 'audio']] as const) {
    const asset = await rpc<{id: string}>('asset.import', {projectId: project.id, name: path.basename(file), mimeType, dataBase64: (await readFile(file)).toString('base64')});
    const track = timeline.tracks.find(item => item.kind === kind); if (!track) fail('DEFAULT_TRACK_MISSING');
    timeline = await rpc<Timeline>('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 30, gain: 0.5, name: `Synthetic ${kind}`});
  }
  if (timeline.clips.length !== 2) fail('SYNTHETIC_CLIP_COUNT_MISMATCH'); check('project-import-and-multitrack-edit-through-public-http-rpc');
  options.onPhase?.('render'); renderDeadline = Date.now() + smokeTimeouts.render;
  const queued = await rpc<Job>('timeline.render', {projectId: project.id, expectedRevision: timeline.revision, purpose: 'preview', requestId: randomUUID()});
  const completed = await boundedPoll(async () => {
    const current = await rpc<Job>('export.get', {exportId: queued.id});
    if (current.status === 'failed') fail('LOCAL_RENDER_FAILED'); return current.status === 'succeeded' ? current : false;
  }, Math.max(1, renderDeadline - Date.now()), 'LOCAL_RENDER_TIMEOUT', options.exited);
  if (!completed.url || !completed.url.startsWith('/') || completed.url.startsWith('//')) fail('INVALID_RENDER_URL');
  const response = await fetch(`${origin}${completed.url}`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(Math.max(1, renderDeadline - Date.now()))});
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || response.headers.get('Content-Type') !== 'video/mp4' || bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp') fail('INVALID_RENDERED_MP4');
  const rendered = path.join(directory, 'rendered.mp4'); await writeFile(rendered, bytes, {mode: 0o600});
  const probe = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', rendered], 'RENDER_PROBE_FAILED', {env, timeout: Math.min(30000, Math.max(1, renderDeadline - Date.now()))})) as {streams: Array<{codec_type: string; width?: number; height?: number}>; format: {duration: string}};
  const stream = probe.streams.find(item => item.codec_type === 'video');
  if (!stream || stream.width !== 1280 || stream.height !== 720 || !probe.streams.some(item => item.codec_type === 'audio') || Number(probe.format.duration) < 0.9) fail('RENDERED_STREAM_MISMATCH');
  check('real-authenticated-mp4-with-video-audio-and-expected-geometry');
  return {bytes: bytes.length, width: stream.width, height: stream.height};
}
export async function runSmoke(platform: TargetPlatform, arch: TargetArch, binary: string, output: string): Promise<void> {
  const result: SmokeReport = {ok: false, platform, arch, checks: [], phase: 'preflight'};
  const check = (name: string): void => { result.checks.push({name, ok: true}); };
  let ownedRoot: string | undefined, child: ReturnType<typeof spawn> | undefined, outcome: Promise<Outcome> | undefined, ended = false;
  const mountPoint = platform === 'darwin' ? mountedDmgFor(binary) : null;
  const extractRoot = platform === 'linux' ? extractedTarFor(binary) : null;
  let ownsExtractRoot = false;
  try {
    if (process.platform !== platform || process.arch !== arch || !path.isAbsolute(binary)) fail('SMOKE_HOST_OR_EXECUTABLE_MISMATCH');
    if (platform === 'darwin' && !mountPoint) fail('FINAL_DMG_EXECUTABLE_REQUIRED');
    if (platform === 'linux') {
      if (process.getuid?.() === 0) fail('NON_ROOT_LINUX_RUNNER_REQUIRED');
      if (!extractRoot || path.dirname(extractRoot) !== await realpath(tmpdir()) || (await lstat(extractRoot)).isSymbolicLink() || await realpath(extractRoot) !== extractRoot) fail('FINAL_TARBALL_EXECUTABLE_REQUIRED');
      ownsExtractRoot = true;
    }
    const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH), ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
    ownedRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-ci-native-')); await chmod(ownedRoot, 0o700);
    const userData = path.join(ownedRoot, 'user-data'); await mkdir(userData, {mode: 0o700});
    const env = smokeEnvironment(process.env, userData, ffmpeg, ffprobe), video = path.join(ownedRoot, 'synthetic.mp4'), audio = path.join(ownedRoot, 'synthetic.wav');
    result.phase = 'fixture';
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-n', video], 'SYNTHETIC_VIDEO_FAILED', {env});
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', '-n', audio], 'SYNTHETIC_AUDIO_FAILED', {env});
    check('self-contained-color-sine-mp4-and-wav-fixture');
    result.phase = 'startup';
    child = spawn(binary, [], {env, detached: true, stdio: ['ignore', 'ignore', 'ignore']});
    const app = child;
    outcome = new Promise<Outcome>((resolve, reject) => {
      app.once('error', () => { ended = true; reject(new CheckFailure('APP_SPAWN_FAILED')); });
      app.once('exit', (code, signal) => { ended = true; resolve({code, signal}); });
    });
    // Attach a handler immediately; readiness errors may precede the final await.
    void outcome.catch(() => {});
    const deadline = Date.now() + smokeTimeouts.startup;
    const discovery = await boundedPoll(async () => {
      try { return validateDiscovery(JSON.parse(await readFile(path.join(userData, 'mcp-connection.json'), 'utf8')), userData); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
    }, smokeTimeouts.startup, 'STARTUP_TIMEOUT', () => ended);
    const origin = new URL(discovery.url).origin, token = (await readFile(discovery.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) fail('INVALID_PRIVATE_TOKEN');
    const health = await fetch(`${origin}/health`, {signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
    const healthBody = await health.json() as {ok?: unknown; service?: unknown; sqlite?: unknown};
    if (health.status !== 200 || healthBody.ok !== true || healthBody.service !== 'mioon' || !healthBody.sqlite) fail('BACKEND_HEALTH_FAILED');
    if (!app.pid) fail('APP_PID_MISSING');
    await boundedPoll(remaining => windowVisible(platform, app.pid!, remaining), Math.max(1, deadline - Date.now()), 'NATIVE_WINDOW_TIMEOUT', () => ended);
    check('actual-final-package-native-window-and-backend-ready');
    result.render = await exerciseComposition({origin, token, video, audio, ffprobe, directory: ownedRoot, env, onPhase: phase => { result.phase = phase; }, onCheck: check, exited: () => ended});
    result.phase = 'shutdown'; result.sigtermSent = app.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    try { result.exit = await Promise.race([outcome, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CheckFailure('EXIT_TIMEOUT')), smokeTimeouts.exit); })]); }
    finally { clearTimeout(timer); }
    if (result.exit.code !== 0 || result.exit.signal !== null) fail('UNCLEAN_NATIVE_EXIT');
    for (const relative of ['mcp-connection.json', 'mcp-token', 'workspace/server.lock']) if (!await absent(path.join(userData, relative))) fail('TRANSIENT_STORAGE_NOT_CLEANED');
    check('sigterm-normal-exit-removes-discovery-token-and-workspace-lock'); result.ok = true; result.phase = 'complete';
  } catch (error) { result.error = safeFailure(error); }
  finally {
    // Snapshot before any forced kill or fixture deletion can erase the cause.
    if (ownedRoot) result.shutdownDiagnostics = await captureSmokeShutdownDiagnostics(ownedRoot);
    if (child?.pid && (!ended || !result.ok)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group may already be gone. */ }
      await Promise.race([outcome?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    if (mountPoint) {
      try { await command('hdiutil', ['detach', mountPoint], 'DMG_DETACH_FAILED'); await rm(mountPoint, {recursive: true}); check('read-only-dmg-unmounted'); }
      catch { result.ok = false; result.error = 'DMG_DETACH_FAILED'; }
    }
    if (ownedRoot) await rm(ownedRoot, {recursive: true, force: true}).catch(() => { result.ok = false; result.error = 'PRIVATE_FIXTURE_CLEANUP_FAILED'; });
    if (extractRoot && ownsExtractRoot) {
      try { await rm(extractRoot, {recursive: true, force: true}); check('delivered-tarball-extraction-cleaned'); }
      catch { result.ok = false; result.error = 'EXTRACT_CLEANUP_FAILED'; }
    }
    await report(output, result);
  }
  if (!result.ok) fail(result.error ?? 'NATIVE_SMOKE_FAILED');
}
if (isMain(import.meta.url)) {
  try {
    const args = argumentsFor(process.argv.slice(2), ['platform', 'arch', 'executable', 'output']);
    await runSmoke(targetPlatform(args.platform), targetArch(args.arch), args.executable, args.output);
  } catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
}
