import {spawn} from 'node:child_process';
import {access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import type {Stats} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {argumentsFor, CheckFailure, cleanEnvironment, command, executable, fail, isMain, report, safeFailure, targetArch, targetPlatform} from './media-environment.ts';
import type {Check, TargetArch, TargetPlatform} from './media-environment.ts';
import {dataPaths} from '../../apps/desktop/src/config.ts';
import {EXIT_DIAGNOSTIC_LIMITS} from '../../apps/desktop/src/exit-diagnostics.ts';
import {rpcPathFor} from '../../packages/contracts/src/project-addressing.ts';
import {projectMediaPath} from '../../packages/contracts/src/project-file.ts';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS} from '../../packages/contracts/src/timeline-export-profile.ts';
import type {ExitDiagnosticRecord} from '../../apps/desktop/src/exit-diagnostics.ts';
import {classifyRendererEvent,RENDERER_DIAGNOSTIC_LIMITS} from '../../apps/desktop/src/renderer-diagnostics.ts';
import type {RendererDiagnosticRecord} from '../../apps/desktop/src/renderer-diagnostics.ts';
import {attachMacDmg, detachMacDmg, macBundleExecutable, macDmgEvidence, uniqueMacApp} from './mac-dmg.ts';
import type {MacDmgEvidence} from './mac-dmg.ts';
import {createReleaseCliSmoke, installReleaseApp, launcherSmokeEnvironment} from './release-cli-smoke.ts';
import type {ReleaseCliSmokeEvidence} from './release-cli-smoke.ts';

interface Discovery {appId: string; channel: string; url: string; pid: number; tokenFile: string}
interface Job {id: string; status: string; url?: string; assetId?: string}
interface Outcome {code: number | null; signal: NodeJS.Signals | null}
interface SmokeReport {ok: boolean; platform: TargetPlatform; arch: TargetArch; package?: MacDmgEvidence; checks: Check[]; phase: string; error?: string; render?: {bytes: number; width: number; height: number}; exit?: Outcome; sigtermSent?: boolean; shutdownDiagnostics?: SmokeShutdownDiagnostics; cliLauncher?: ReleaseCliSmokeEvidence}
export const smokeTimeouts = Object.freeze({startup: 90000, render: 120000, exit: 30000});
export function smokeEnvironment(source: NodeJS.ProcessEnv, userData: string, ffmpeg: string, ffprobe: string): NodeJS.ProcessEnv {
  return {...cleanEnvironment(source), MIOON_DESKTOP_USER_DATA: userData, MIOON_FFMPEG_PATH: ffmpeg, MIOON_FFPROBE_PATH: ffprobe};
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
    const {dataDir} = dataPaths(ownedRoot, userData);
    try {await ownedDiagnosticDirectory(dataDir);}
    catch (error) {
      const status=diagnosticStatus(error); result.transientFiles.workspaceLockPresent=status==='missing'?false:null;
      result.backend={status,records:[]}; result.renderer={status,records:[]}; return result;
    }
    result.transientFiles.workspaceLockPresent=await transientPresence(path.join(dataDir,'server.lock'));
    const directory = path.join(dataDir,'diagnostics');
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
  let projectContext: string | undefined;
  const rpc = async <T>(operation: string, input: unknown = {}): Promise<T> => {
    const response = await fetch(`${origin}${rpcPathFor(operation,input,projectContext)}`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({operation, input}), signal: AbortSignal.timeout(renderDeadline ? Math.min(15000, Math.max(1, renderDeadline - Date.now())) : 15000)});
    const body = await response.json() as {ok?: unknown; data: T};
    if (response.status !== 200 || body.ok !== true) fail('RPC_FAILED'); return body.data;
  };
  const denied = await fetch(`${origin}/api/rpc`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation: 'project.list'}), signal: AbortSignal.timeout(10000)});
  if (denied.status !== 401) fail('ANONYMOUS_RPC_NOT_DENIED'); check('anonymous-http-rpc-denied');
  options.onPhase?.('seed');
  // Format 5 projects are created by default after AC. Seed them through the
  // public sequence write entries; the legacy timeline.get/format.set/clip.add
  // writes are rejected by the FR-0 gate on a format-5 project.
  const project = await rpc<{id: string; revision: number}>('project.create', {name: 'CI synthetic local composition'});
  projectContext = project.id;
  const projectId = project.id;
  const sequenceCommit = async (payload: Record<string, unknown>): Promise<void> => {
    const requestId = `smoke-${randomUUID()}`;
    const preview = await rpc<{ok?: unknown; code?: unknown; envelope?: unknown; planDigest?: unknown}>('sequence.preview', {projectId, requestId, ...payload});
    if (preview.ok === false) {
      const code = typeof preview.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(preview.code) ? preview.code : 'FAILED';
      fail(`SEQUENCE_PREVIEW_${code}`);
    }
    if (!preview.envelope || typeof preview.planDigest !== 'string') fail('SEQUENCE_PREVIEW_INVALID');
    const committed = await rpc<{status?: unknown}>('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
    if (committed.status !== 'applied') fail('SEQUENCE_COMMIT_NOT_APPLIED');
  };
  type SmokeProject = {projectFormatVersion?: unknown; timeline?: {revision?: unknown; tracks?: Array<{id: string; kind: string}>; clips?: Array<{id: string; trackId?: string}>}; project?: {revision?: number}};
  let state = await rpc<SmokeProject>('project.get', {projectId: project.id});
  // The host runtime appends projectFormatVersion to project.get; the direct
  // test-server fixture has the same format-5 store without that projection.
  if (state.projectFormatVersion !== undefined && state.projectFormatVersion !== 5) fail('FORMAT5_PROJECT_REQUIRED');
  // FR-D format intent: explicit 16:9 / landscape 720 through the format-5 entry.
  await sequenceCommit({formatIntent: {side: 'timeline', operation: {kind: 'timeline-format', presetId: 'landscape_1080'}}});
  // FR-D track intent: create the A1 audio track the fixture inserts into.
  const audioTrackId = randomUUID();
  await sequenceCommit({trackIntent: {side: 'timeline', operation: {kind: 'track-structure',
    edit: {kind: 'add', trackId: audioTrackId, trackKind: 'audio', name: 'A1'}}}});
  state = await rpc<SmokeProject>('project.get', {projectId: project.id});
  if (!state.timeline?.tracks?.some(track => track.id === audioTrackId && track.kind === 'audio')) fail('AUDIO_TRACK_MISSING');
  const videoAsset = await rpc<{id: string}>('asset.import', {projectId: project.id, name: path.basename(video), mimeType: 'video/mp4', dataBase64: (await readFile(video)).toString('base64')});
  const audioAsset = await rpc<{id: string}>('asset.import', {projectId: project.id, name: path.basename(audio), mimeType: 'audio/wav', dataBase64: (await readFile(audio)).toString('base64')});
  // Uploaded assets carry a sampled fingerprint; prepare the full hash before
  // the sequence entries put them on a timeline (the production import path does
  // the same before accepting an insert).
  await rpc<unknown>('asset.media.prepare', {projectId: project.id, purpose: 'timeline',
    assets: [{assetId: videoAsset.id, referenceRevision: 1}, {assetId: audioAsset.id, referenceRevision: 1}]});
  // Main track: the video clip keeps its own audio and lands on the main track.
  await sequenceCommit({intents: [{side: 'timeline', operation: {kind: 'track',
    edit: {kind: 'insert-asset', assetId: videoAsset.id, trackId: null, startFrame: 0}}}]});
  // A1: the imported WAV is inserted as an anchored overlay on the audio track.
  await sequenceCommit({intents: [{side: 'timeline', operation: {kind: 'track',
    edit: {kind: 'insert-asset', assetId: audioAsset.id, trackId: audioTrackId, startFrame: 0}}}]});
  state = await rpc<SmokeProject>('project.get', {projectId: project.id});
  if (state.timeline?.clips?.length !== 2) fail('SYNTHETIC_CLIP_COUNT_MISMATCH');
  check('project-import-and-multitrack-edit-through-public-http-rpc');
  options.onPhase?.('render'); renderDeadline = Date.now() + smokeTimeouts.render;
  const revision = state.timeline.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) fail('TIMELINE_REVISION_MISSING');
  // landscape_1080 keeps the project tier; the fixed delivery profile scales it
  // to the same 1280x720 smoke output as before.
  const exportSettings = {...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_720' as const};
  const capability = await rpc<{status?: unknown; delivery?: {effective?: {width?: number; height?: number}}}>('timeline.export.capabilities',
    {projectId: project.id, expectedRevision: revision, exportSettings});
  if (capability.status !== 'available') fail('EXPORT_CAPABILITY_UNAVAILABLE');
  const preflight = await rpc<{status?: unknown; snapshotHash?: unknown; summary?: {width?: number; height?: number} | null}>('timeline.export.preflight',
    {projectId: project.id, expectedRevision: revision, exportSettings});
  if (preflight.status !== 'ready' || typeof preflight.snapshotHash !== 'string') fail('EXPORT_PREFLIGHT_NOT_READY');
  if (capability.delivery?.effective?.width !== 1280 || capability.delivery.effective.height !== 720) fail('EXPORT_GEOMETRY_MISMATCH');
  check('format5-export-capability-and-preflight-ready');
  const queued = await rpc<Job>('timeline.render', {projectId: project.id, expectedRevision: revision, purpose: 'export', requestId: randomUUID(),
    exportSettings, preflightSnapshotHash: preflight.snapshotHash});
  const completed = await boundedPoll(async () => {
    const current = await rpc<Job>('export.get', {exportId: queued.id});
    if (current.status === 'failed') fail('LOCAL_RENDER_FAILED'); return current.status === 'succeeded' ? current : false;
  }, Math.max(1, renderDeadline - Date.now()), 'LOCAL_RENDER_TIMEOUT', options.exited);
  if (!completed.url || !completed.url.startsWith('/') || completed.url.startsWith('//') || !completed.assetId) fail('INVALID_RENDER_URL');
  const response = await fetch(`${origin}${projectMediaPath(project.id,completed.assetId)}`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(Math.max(1, renderDeadline - Date.now()))});
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200 || response.headers.get('Content-Type') !== 'video/mp4' || bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp') fail('INVALID_RENDERED_MP4');
  const rendered = path.join(directory, 'rendered.mp4'); await writeFile(rendered, bytes, {mode: 0o600});
  const probe = JSON.parse(await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', rendered], 'RENDER_PROBE_FAILED', {env, timeout: Math.min(30000, Math.max(1, renderDeadline - Date.now()))})) as {streams: Array<{codec_type: string; width?: number; height?: number}>; format: {duration: string}};
  const stream = probe.streams.find(item => item.codec_type === 'video');
  if (!stream || stream.width !== 1280 || stream.height !== 720 || !probe.streams.some(item => item.codec_type === 'audio') || Number(probe.format.duration) < 0.9) fail('RENDERED_STREAM_MISMATCH');
  check('real-authenticated-mp4-with-video-audio-and-expected-geometry');
  return {bytes: bytes.length, width: stream.width, height: stream.height};
}
type SmokeInput = {dmg: string} | {executable: string};
export async function runSmoke(platform: TargetPlatform, arch: TargetArch, input: SmokeInput, output: string): Promise<void> {
  const result: SmokeReport = {ok: false, platform, arch, checks: [], phase: 'preflight'};
  const check = (name: string): void => { result.checks.push({name, ok: true}); };
  let ownedRoot: string | undefined, child: ReturnType<typeof spawn> | undefined, outcome: Promise<Outcome> | undefined, ended = false;
  const extractRoot = platform === 'linux' && 'executable' in input ? extractedTarFor(input.executable) : null;
  let mountPoint: string | undefined;
  let ownsExtractRoot = false;
  try {
    if (process.platform !== platform || process.arch !== arch) fail('SMOKE_HOST_OR_EXECUTABLE_MISMATCH');
    let binary: string | undefined, sourceApp: string | undefined;
    if (platform === 'darwin') {
      if (!('dmg' in input)) fail('FINAL_DMG_REQUIRED');
      result.phase = 'dmg';
      result.package = await macDmgEvidence(input.dmg);
      mountPoint = await attachMacDmg(input.dmg);
      sourceApp = await uniqueMacApp(mountPoint);
      check('read-only-final-dmg-mounted');
    } else {
      if (!('executable' in input) || !path.isAbsolute(input.executable)) fail('SMOKE_HOST_OR_EXECUTABLE_MISMATCH');
      if (process.getuid?.() === 0) fail('NON_ROOT_LINUX_RUNNER_REQUIRED');
      if (!extractRoot || path.dirname(extractRoot) !== await realpath(tmpdir()) || (await lstat(extractRoot)).isSymbolicLink() || await realpath(extractRoot) !== extractRoot) fail('FINAL_TARBALL_EXECUTABLE_REQUIRED');
      ownsExtractRoot = true;
      binary = input.executable;
    }
    const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH), ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
    ownedRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-ci-native-')); await chmod(ownedRoot, 0o700);
    const userData = path.join(ownedRoot, 'user-data'), home = path.join(ownedRoot, 'home'), tmp = path.join(ownedRoot, 'tmp');
    await Promise.all([userData, home, tmp].map(directory => mkdir(directory, {mode: 0o700})));
    const env = {...smokeEnvironment(process.env, userData, ffmpeg, ffprobe), HOME: home, CFFIXED_USER_HOME: home,
      TMPDIR: tmp, TMP: tmp, TEMP: tmp}, video = path.join(ownedRoot, 'synthetic.mp4'), audio = path.join(ownedRoot, 'synthetic.wav');
    let cliSmoke: ReturnType<typeof createReleaseCliSmoke> | undefined;
    if (sourceApp && result.package) {
      result.phase = 'dmg-install';
      const version = process.env.MIOON_RELEASE_VERSION ?? result.package.name.slice('mioon-'.length, -'-mac.dmg'.length);
      if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version) || result.package.name !== `mioon-${version}-mac.dmg`) fail('CLI_SMOKE_RELEASE_VERSION_MISMATCH');
      const app = await installReleaseApp(sourceApp, ownedRoot);
      binary = await macBundleExecutable(app);
      check('final-dmg-app-copied-to-disposable-applications');
      const emptyPath = path.join(ownedRoot, 'no-host-tools');
      await mkdir(emptyPath, {mode: 0o700});
      cliSmoke = createReleaseCliSmoke({sourceApp, installedApp: app, root: ownedRoot, version,
        env: launcherSmokeEnvironment(home, tmp, emptyPath, userData)});
      result.cliLauncher = cliSmoke.evidence;
      result.phase = 'cli-app-stopped-before-start';
      await cliSmoke.beforeAppStarts();
      check('packaged-cli-first-and-warm-stopped-diagnostics');
    }
    if (!binary) fail('SMOKE_HOST_OR_EXECUTABLE_MISMATCH');
    result.phase = 'fixture';
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x18bf57:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-n', video], 'SYNTHETIC_VIDEO_FAILED', {env});
    await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', '-n', audio], 'SYNTHETIC_AUDIO_FAILED', {env});
    check('self-contained-color-sine-mp4-and-wav-fixture');
    result.phase = 'startup';
    // Chromium waits for login-keychain authorization during shutdown in the isolated macOS profile.
    // Use its test keychain only for this process and its disposable data.
    const appArgs = platform === 'darwin' ? ['--use-mock-keychain'] : [];
    child = spawn(binary, appArgs, {env, detached: true, stdio: ['ignore', 'ignore', 'ignore']});
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
    if (cliSmoke) {
      result.phase = 'cli-app-running';
      await cliSmoke.duringApp();
      check('packaged-cli-version-doctor-project-list-and-mcp-initialize-tools-list');
    }
    result.render = await exerciseComposition({origin, token, video, audio, ffprobe, directory: ownedRoot, env, onPhase: phase => { result.phase = phase; }, onCheck: check, exited: () => ended});
    result.phase = 'shutdown'; result.sigtermSent = app.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    try { result.exit = await Promise.race([outcome, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CheckFailure('EXIT_TIMEOUT')), smokeTimeouts.exit); })]); }
    finally { clearTimeout(timer); }
    if (result.exit.code !== 0 || result.exit.signal !== null) fail('UNCLEAN_NATIVE_EXIT');
    const {dataDir} = dataPaths(ownedRoot, userData);
    for (const file of [path.join(userData, 'mcp-connection.json'), path.join(userData, 'mcp-token'), path.join(dataDir, 'server.lock')]) {
      if (!await absent(file)) fail('TRANSIENT_STORAGE_NOT_CLEANED');
    }
    check('sigterm-normal-exit-removes-discovery-token-and-workspace-lock');
    if (cliSmoke) {
      result.phase = 'cli-app-stopped-after-quit';
      if (!await absent(path.join(userData, 'cli-token'))) fail('TRANSIENT_STORAGE_NOT_CLEANED');
      await cliSmoke.afterAppStops();
      check('packaged-cli-stopped-diagnostic-after-quit');
    }
    if ('dmg' in input) {
      result.phase = 'dmg-sha256';
      if ((await macDmgEvidence(input.dmg)).sha256 !== result.package?.sha256) fail('DMG_CHANGED_DURING_VERIFICATION');
      check('final-dmg-sha256-unchanged-after-native-smoke');
    }
    result.ok = true; result.phase = 'complete';
  } catch (error) { result.error = safeFailure(error); }
  finally {
    // Snapshot before any forced kill or fixture deletion can erase the cause.
    if (ownedRoot) result.shutdownDiagnostics = await captureSmokeShutdownDiagnostics(ownedRoot);
    if (child?.pid && (!ended || !result.ok)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group may already be gone. */ }
      await Promise.race([outcome?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    if (mountPoint) {
      try { await detachMacDmg(mountPoint); check('read-only-dmg-unmounted'); }
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
    const args = argumentsFor(process.argv.slice(2), ['platform', 'arch', 'output'], ['dmg', 'executable']);
    if (Boolean(args.dmg) === Boolean(args.executable)) fail('INVALID_ARGUMENTS');
    await runSmoke(targetPlatform(args.platform), targetArch(args.arch), args.dmg ? {dmg: path.resolve(args.dmg)} : {executable: args.executable}, args.output);
  } catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
}
