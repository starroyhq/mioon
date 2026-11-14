import { ensurePrivateDirectory, validatePrivateDirectory } from '@mioon/contracts/private-storage';
import { EventEmitter } from 'node:events';
import { trustedOrigin } from './security.ts';
import { createAgentSettingsBroker } from './secret-broker.ts';
import { createImageSecretBroker } from './image-secret-broker.ts';
import { createVideoSecretBroker } from './video-secret-broker.ts';
import { createNativeAudioPreviewBroker } from './native-audio-preview-broker.ts';
import {createProjectTrashBroker} from './project-trash-broker.ts';
import type {ProjectTrashNativeOptions} from './project-trash-broker.ts';
import { nativeAudioConfigSchema } from '@mioon/contracts/native-audio-preview';
import type {NativeAudioCommand, NativeAudioConfig, NativeAudioReply} from '@mioon/contracts/native-audio-preview';
import { createExitDiagnostics, classifyBackendExit } from './exit-diagnostics.ts';
import type {DesktopAgentSettings} from './secret-store.ts';
import type {ImageSecretCodec} from './image-secret-store.ts';
import type {VideoSecretCodec} from './video-secret-store.ts';
import {randomUUID} from 'node:crypto';
import {createProjectEntryControlClient} from './project-entry-control.ts';
import type {DesktopProjectEntryControl} from './project-entry-control.ts';
import {createSettingsEventLoopClient} from './settings-event-loop.ts';
import type {MessageChannelMain, MessagePortMain} from 'electron';

/** Electron utilityProcess surface used by the supervisor (structural for tests). */
export interface BackendUtilityProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
  kill(): boolean;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
}
export interface BackendForkOptions {
  env: NodeJS.ProcessEnv;
  stdio: 'ignore';
  serviceName: string;
  allowLoadingUnsignedLibraries: boolean;
  execArgv: string[];
}
export type BackendFork = (modulePath: string, args: string[], options: BackendForkOptions) => BackendUtilityProcess;
export interface BackendRuntime {
  readonly electron: string;
  readonly node: string;
  readonly sqlite: string;
  readonly pid: number;
}
export interface BackendReady {
  readonly url: string;
  readonly runtime: BackendRuntime;
}
export interface StopOutcome {
  readonly exitConfirmed: true;
  readonly forced: boolean;
  readonly code: number | null;
  mediaExitConfirmed?: boolean;
}
export type SupervisorState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'stop-unconfirmed' | 'media-unconfirmed';
interface StopError extends Error { code?: string; exitConfirmed?: boolean; mediaExitConfirmed?: boolean }
interface BackendStartConfig {
  readonly backendId?: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly projectsDir: string;
  readonly distDir: string;
  readonly subtitleResourcesDir: string;
  readonly projectTemplatesDir?: string;
  readonly token: string;
  readonly nativeAudioPreview?: NativeAudioConfig;
}
export interface BackendSupervisorOptions {
  fork: BackendFork;
  modulePath: string;
  environment: NodeJS.ProcessEnv;
  projectCatalog?: {readonly modulePath: string; createChannel(): MessageChannelMain};
  startupTimeout?: number;
  stopTimeout?: number;
  terminateTimeout?: number;
  exitTimeout?: number;
  forceKill?: (child: BackendUtilityProcess) => void;
  agentSettings?: DesktopAgentSettings | null;
  imageSecretCodec?: ImageSecretCodec | null;
  videoSecretCodec?: VideoSecretCodec | null;
  projectTrash?: ProjectTrashNativeOptions;
}
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
function isPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 1 && (value as number) !== process.pid;
}
function isBackendLeaseProbe(value: unknown): value is {type: 'lease-probe'; probeId: number} {
  const probe = recordOf(value);
  return Boolean(probe && !Array.isArray(value) && Object.keys(probe).length === 2 &&
    Object.hasOwn(probe, 'type') && Object.hasOwn(probe, 'probeId') && probe.type === 'lease-probe' &&
    Number.isSafeInteger(probe.probeId) && Number(probe.probeId) > 0);
}
function stopError(code: 'BACKEND_STOP_UNCONFIRMED' | 'BACKEND_STOP_FAILED' | 'BACKEND_MEDIA_EXIT_UNCONFIRMED', exitConfirmed?: boolean): StopError {
  return Object.assign(new Error(code === 'BACKEND_STOP_UNCONFIRMED'
    ? '本地服务未确认退出。请稍后重试；在确认退出前不能重启服务'
    : code === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? '本地服务已退出，但媒体子进程是否退出尚无法确认。不能自动重启服务'
    : '本地服务退出时未能完成正常清理。已保存的数据将在下次启动时恢复'), { code, exitConfirmed });
}
const unconfirmedMediaError = (): StopError => Object.assign(stopError('BACKEND_MEDIA_EXIT_UNCONFIRMED', true), { mediaExitConfirmed: false });
const forceOwnedUtility = (child: BackendUtilityProcess) => {
  const pid = child.pid;
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, 'SIGKILL');
};
const backendExitReasons = new Set(['stop-requested', 'lease-expired', 'signal-term', 'signal-int',
  'uncaught-exception', 'unhandled-rejection', 'shutdown-failed', 'startup-failed']);
const projectCatalogEnvironmentKeys = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR',
  'MIOON_DESKTOP_PRIVATE_STORAGE_HELPER'];

// Normal worker drains finish inside the first phase. A signal being accepted
// is not proof of exit: keep the owned handle until Electron reports its exit.
export const BACKEND_STOP_BUDGET = Object.freeze({ gracefulMs: 10000, terminateMs: 2000, confirmMs: 1000 });
const CATALOG_DISCONNECT_GRACE_MS = 100;

export class BackendSupervisor extends EventEmitter {
  private projectControl: ReturnType<typeof createProjectEntryControlClient> | null = null;
  private settingsEventLoop: ReturnType<typeof createSettingsEventLoopClient> | null = null;
  private exitedChild: BackendUtilityProcess | null = null;
  get projectEntries(): DesktopProjectEntryControl {
    if(!this.projectControl || this.state!=='running') throw new Error('Project entry control is unavailable');
    return this.projectControl.api;
  }
  readonly fork: BackendFork;
  readonly modulePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly projectCatalog: BackendSupervisorOptions['projectCatalog'];
  readonly startupTimeout: number;
  readonly stopTimeout: number;
  readonly terminateTimeout: number;
  readonly exitTimeout: number;
  readonly forceKill: (child: BackendUtilityProcess) => void;
  readonly agentSettings: DesktopAgentSettings | null | undefined;
  readonly imageSecretCodec: ImageSecretCodec | null | undefined;
  readonly videoSecretCodec: VideoSecretCodec | null | undefined;
  readonly projectTrash: ProjectTrashNativeOptions | undefined;
  state: SupervisorState = 'idle';
  mediaPids = new Set<number>();
  mediaKinds = new Map<number, string | undefined>();
  hasUnconfirmedMedia = false;
  declare child: BackendUtilityProcess | null;
  declare stopping: Promise<StopOutcome> | null;
  declare origin: string | null;
  declare expectedExit: boolean;
  declare stopFailure: StopError | null;
  declare stopOutcome: StopOutcome | null;
  declare shutdownFailed: boolean;
  declare stopForced: boolean;
  declare exitReason: string | null;
  declare termination: string | null;
  declare diagnostics: ReturnType<typeof createExitDiagnostics> | null;
  declare diagnosticsAvailable: boolean;
  declare cancelStart: (() => void) | null;
  declare heartbeat: ReturnType<typeof setInterval> | null;
  declare nativeAudioBroker: ReturnType<typeof createNativeAudioPreviewBroker> | null;

  constructor({ fork, modulePath, environment, startupTimeout = 20000, stopTimeout = BACKEND_STOP_BUDGET.gracefulMs,
    terminateTimeout = BACKEND_STOP_BUDGET.terminateMs, exitTimeout = BACKEND_STOP_BUDGET.confirmMs,
    forceKill = forceOwnedUtility, agentSettings, imageSecretCodec, videoSecretCodec, projectTrash, projectCatalog }: BackendSupervisorOptions) {
    super();
    for (const value of [startupTimeout, stopTimeout, terminateTimeout, exitTimeout]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 60000) throw new Error('Invalid backend lifecycle budget');
    }
    this.fork = fork;
    this.modulePath = modulePath;
    this.environment = environment;
    this.projectCatalog = projectCatalog;
    this.startupTimeout = startupTimeout;
    this.stopTimeout = stopTimeout;
    this.terminateTimeout = terminateTimeout;
    this.exitTimeout = exitTimeout;
    this.forceKill = forceKill;
    this.agentSettings = agentSettings;
    this.imageSecretCodec = imageSecretCodec;
    this.videoSecretCodec = videoSecretCodec;
    this.projectTrash = projectTrash;
  }

  start(config: BackendStartConfig): Promise<BackendReady> {
    if (config.nativeAudioPreview !== undefined) nativeAudioConfigSchema.parse(config.nativeAudioPreview);
    if (this.hasUnconfirmedMedia) throw unconfirmedMediaError();
    if (this.child || this.stopping || !['idle', 'stopped', 'failed'].includes(this.state)) throw new Error('Backend already active');
    this.state = 'starting';
    this.origin = null;
    this.expectedExit = false;
    this.stopFailure = null;
    this.stopOutcome = null;
    this.shutdownFailed = false;
    this.stopForced = false;
    this.exitReason = null;
    this.termination = null;
    this.diagnostics = createExitDiagnostics({ dataDir: config.dataDir, modulePath: this.modulePath,
      directoryPolicy: { ensurePrivateDirectory, validatePrivateDirectory } });
    this.recordDiagnostic('start');
    return new Promise<BackendReady>((resolve, reject) => {
      let settled = false;
      let catalogReady = !this.projectCatalog;
      let pendingBackendReady: Record<string, unknown> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        this.state = 'failed';
        reject(error);
      };
      this.cancelStart = () => fail(Object.assign(new Error('本地服务启动已取消'), { code: 'BACKEND_START_CANCELLED' }));
      let child: BackendUtilityProcess;
      try {
        child = this.child = this.fork(this.modulePath, [], {
          env: this.environment, stdio: 'ignore', serviceName: 'Mioon Backend',
          allowLoadingUnsignedLibraries: false, execArgv: []
        });
      } catch (error) { this.exitReason = 'startup-error'; this.recordDiagnostic('spawn-failed', { classification: 'abnormal' }); fail(error as Error); return; }
      const kill = (reason: string) => {
        if (this.child !== child || this.exitedChild === child) return;
        this.settingsEventLoop?.close();
        this.noteExitReason(reason);
        this.termination = 'utility-kill';
        this.recordDiagnostic('termination-requested', { classification: 'terminated' });
        try { child.kill(); } catch { /* Only the exit event confirms termination. */ }
      };
      // The listener and replies belong to this exact child. A late completion
      // from an old utility can never be delivered to its replacement.
      const settingsBroker = createAgentSettingsBroker({ agentSettings: this.agentSettings,
        send: message => child.postMessage(message),
        isActive: () => this.child === child && ['running', 'stopping'].includes(this.state),
        getSelfPort: () => this.origin ? Number(new URL(this.origin).port) : null });
      const backendId=config.backendId??config.nativeAudioPreview?.backendId??randomUUID();
      const projectControl=this.projectControl=createProjectEntryControlClient({backendId,send:message=>child.postMessage(message),
        isCurrent:()=>this.child===child&&['running','stopping'].includes(this.state)});
      const settingsEventLoop = this.settingsEventLoop = createSettingsEventLoopClient(message => child.postMessage(message),
        () => this.child === child && this.state === 'running' && this.termination === null);
      // Startup needs vault status/decryption while the Images engine is loaded
      // in the utility. This bridge owns no settings or session credential RAM.
      const imageSecretBroker = createImageSecretBroker({ imageSecretCodec: this.imageSecretCodec,
        send: message => child.postMessage(message),
        isActive: () => this.child === child && ['starting', 'running', 'stopping'].includes(this.state) });
      const videoSecretBroker = createVideoSecretBroker({ videoSecretCodec: this.videoSecretCodec,
        send: message => child.postMessage(message),
        isActive: () => this.child === child && ['starting', 'running', 'stopping'].includes(this.state) });
      const nativeAudioBroker = config.nativeAudioPreview ? createNativeAudioPreviewBroker({
        backendId: config.nativeAudioPreview.backendId, send: message => child.postMessage(message),
        isCurrent: () => this.child === child && ['running', 'stopping'].includes(this.state),
      }) : null;
      this.nativeAudioBroker = nativeAudioBroker;
      const projectTrashBroker = createProjectTrashBroker({native: this.projectTrash,
        send: message => child.postMessage(message), isActive: () => this.child === child && this.state === 'running'});
      timer = setTimeout(() => { this.noteExitReason('startup-timeout'); fail(new Error('本地服务启动超时')); kill('startup-timeout'); }, this.startupTimeout);
      child.on('error', () => {
        if (this.child !== child || !['starting', 'running'].includes(this.state)) return;
        const reason = this.state === 'starting' ? 'startup-error' : 'runtime-error';
        this.noteExitReason(reason);
        fail(new Error('本地服务运行时错误')); kill(reason);
      });
      const acceptBackendMessage = (message: unknown) => {
        if (this.child !== child || this.exitedChild === child) return;
        if (projectControl.handle(message)) return;
        if (settingsBroker.handle(message)) return;
        if (imageSecretBroker.handle(message)) return;
        if (videoSecretBroker.handle(message)) return;
        if (nativeAudioBroker?.handle(message)) return;
        if (projectTrashBroker.handle(message)) return;
        if (settingsEventLoop.handle(message)) return;
        if (isBackendLeaseProbe(message)) {
          // A suspended utility must prove its parent is still this live
          // owner. This acknowledgement cannot start work or revive a child
          // whose shutdown has already begun.
          if ((this.state === 'starting' || this.state === 'running') && this.termination === null) {
            try { child.postMessage({type: 'lease-probe-ack', probeId: message.probeId}); }
            catch { clearInterval(heartbeat); fail(new Error('本地服务启动通信失败')); kill('communication-lost'); }
          }
          return;
        }
        const notice = recordOf(message);
        if (notice?.type === 'exit-diagnostic') {
          // Only fixed reason labels cross into diagnostics. Never persist a
          // utility message, error, runtime payload, or startup configuration.
          if (typeof notice.reason === 'string' && backendExitReasons.has(notice.reason)) {
            this.noteExitReason(notice.reason);
            if (notice.reason === 'shutdown-failed') this.shutdownFailed = true;
            this.recordDiagnostic('backend-notice', { reason: notice.reason });
          }
          return;
        }
        if (notice?.type === 'media-process') {
          const pid = notice.pid;
          if (isPid(pid) && pid !== child.pid) {
            if (notice.event === 'started') { this.mediaPids.add(pid); this.mediaKinds.set(pid, typeof notice.kind === 'string' ? notice.kind : undefined); }
            if (notice.event === 'exited') { this.mediaPids.delete(pid); this.mediaKinds.delete(pid); }
          }
          return;
        }
        if (notice?.type === 'shutdown-failed') {
          this.shutdownFailed = true; this.noteExitReason('shutdown-failed'); this.recordDiagnostic('backend-notice', { reason: 'shutdown-failed' }); return;
        }
        if (notice?.type === 'failed') {
          this.noteExitReason('startup-failed'); this.recordDiagnostic('backend-notice');
          fail(new Error('本地服务启动失败。请检查数据目录和应用文件')); return;
        }
        if (notice?.type !== 'ready' || settled || this.state !== 'starting') return;
        if (!catalogReady) { pendingBackendReady = notice; return; }
        pendingBackendReady = undefined;
        let origin: string;
        try { origin = trustedOrigin(notice.url); }
        catch (error) { this.noteExitReason('invalid-origin'); fail(error as Error); kill('invalid-origin'); return; }
        this.origin = origin;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        this.state = 'running';
        this.recordDiagnostic('ready');
        heartbeat = this.heartbeat = setInterval(() => {
          if (this.child === child && this.state === 'running') {
            try { child.postMessage({ type: 'ping' }); }
            catch { clearInterval(heartbeat); kill('communication-lost'); }
          }
        }, 10000);
        resolve({ url: origin, runtime: notice.runtime as BackendRuntime });
      };
      child.on('message', acceptBackendMessage);
      let catalog: BackendUtilityProcess | undefined;
      let catalogTerminateTimer: ReturnType<typeof setTimeout> | undefined;
      let catalogForceTimer: ReturnType<typeof setTimeout> | undefined;
      let backendExitCode: number | undefined;
      const finishExit = (code: number) => {
        if (this.child !== child) return;
        const exitState = this.state;
        this.child = null;
        this.exitedChild = null;
        this.stopFailure = null;
        const outcome: StopOutcome = { exitConfirmed: true, forced: this.stopForced, code };
        this.stopOutcome = outcome;
        // Telemetry identifies a reported PID, not an OS process handle. After
        // utility death that PID could have been reused: never signal it or
        // claim media reap. Retain uncertainty and block automatic replacement.
        this.hasUnconfirmedMedia = this.mediaPids.size > 0;
        if (this.hasUnconfirmedMedia) outcome.mediaExitConfirmed = false;
        const reason = this.exitReason ?? 'utility-exit';
        const classification = classifyBackendExit({ reason, shutdownFailed: this.shutdownFailed,
          forced: this.stopForced, expected: this.expectedExit, code, mediaExitConfirmed: !this.hasUnconfirmedMedia });
        this.recordDiagnostic('exit', { state: exitState, reason, classification, code,
          exitConfirmed: true, mediaExitConfirmed: !this.hasUnconfirmedMedia });
        this.state = this.hasUnconfirmedMedia ? 'media-unconfirmed' : this.expectedExit ? 'stopped' : 'failed';
        this.emit('exit', { code, expected: this.expectedExit,
          ...(this.hasUnconfirmedMedia ? { mediaExitConfirmed: false } : {}) });
      };
      child.once('exit', (code: number) => {
        projectControl.close();
        if(this.projectControl===projectControl)this.projectControl=null;
        settingsEventLoop.close();
        if (this.settingsEventLoop === settingsEventLoop) this.settingsEventLoop = null;
        settingsBroker.close();
        imageSecretBroker.close();
        videoSecretBroker.close();
        nativeAudioBroker?.close();
        projectTrashBroker.close();
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (this.child !== child) return;
        if (!settled) fail(new Error(`本地服务退出 (${code})`));
        this.exitedChild = child;
        backendExitCode = code;
        const ownedCatalog = catalog;
        if (!ownedCatalog) { finishExit(code); return; }
        // The peer port closes when the backend exits. Reap the helper even
        // if a cold filesystem call prevents it from handling that close.
        catalogTerminateTimer = setTimeout(() => {
          try { ownedCatalog.kill(); } catch { /* Keep the exact child until it reports exit. */ }
        }, CATALOG_DISCONNECT_GRACE_MS);
        catalogForceTimer = setTimeout(() => {
          try { this.forceKill(ownedCatalog); } catch { /* Keep waiting for the exit event. */ }
        }, CATALOG_DISCONNECT_GRACE_MS + this.terminateTimeout);
      });
      const startMessage = { type: 'start', ...config, backendId, projectTrashAvailable: this.projectTrash !== undefined };
      let catalogChannel: MessageChannelMain | undefined;
      try {
        if (!this.projectCatalog) { child.postMessage(startMessage); return; }
        catalogChannel = this.projectCatalog.createChannel();
        const environment: NodeJS.ProcessEnv = {};
        for (const key of projectCatalogEnvironmentKeys) {
          if (this.environment[key] !== undefined) environment[key] = this.environment[key];
        }
        catalog = this.fork(this.projectCatalog.modulePath, [], {
          env: environment, stdio: 'ignore', serviceName: 'Mioon Project Catalog',
          allowLoadingUnsignedLibraries: false, execArgv: [],
        });
        // Electron reports the subsequent exit even after a fatal V8 error.
        catalog.on('error', () => {});
        catalog.on('message', message => {
          if (message !== 'project-catalog-ready' || catalogReady || settled || this.child !== child || this.exitedChild === child) return;
          catalogReady = true;
          if (pendingBackendReady) acceptBackendMessage(pendingBackendReady);
        });
        catalog.once('exit', () => {
          clearTimeout(catalogTerminateTimer);
          clearTimeout(catalogForceTimer);
          catalog = undefined;
          if (backendExitCode !== undefined) finishExit(backendExitCode);
          else if (!settled) {
            fail(new Error('本地项目目录服务启动失败'));
            kill('startup-communication-failed');
          }
        });
        catalog.postMessage('start-project-catalog', [catalogChannel.port1]);
        child.postMessage(startMessage, [catalogChannel.port2]);
      } catch {
        catalogChannel?.port1.close();
        catalogChannel?.port2.close();
        this.noteExitReason('startup-communication-failed'); fail(new Error('本地服务启动通信失败')); kill('startup-communication-failed');
      }
    });
  }

  noteExitReason(reason: string) {
    // A later user quit must not erase the fault that initiated shutdown.
    if (!this.exitReason || this.exitReason === 'stop-requested' ||
      ['uncaught-exception', 'unhandled-rejection'].includes(reason)) this.exitReason = reason;
  }

  recordDiagnostic(event: string, details: Record<string, unknown> = {}) {
    this.diagnosticsAvailable = this.diagnostics?.record({ event, state: this.state, reason: this.exitReason,
      expected: this.expectedExit, forced: this.stopForced || this.termination !== null, shutdownFailed: this.shutdownFailed,
      termination: this.termination, ...details }) ?? false;
  }

  requestNativeAudio(command: NativeAudioCommand, onPending?: () => void): Promise<NativeAudioReply> {
    if (!this.nativeAudioBroker) return Promise.reject(Object.assign(new Error('Native audition is unavailable.'), {code: 'NATIVE_AUDIO_UNCONFIRMED'}));
    return this.nativeAudioBroker.request(command, onPending);
  }

  sampleSettingsEventLoop(fromMs: number, toMs: number, signal?: AbortSignal, onTimeout?: () => void): Promise<number | null> {
    return this.settingsEventLoop?.sample(fromMs, toMs, signal, onTimeout) ?? Promise.resolve(null);
  }

  stop(): Promise<StopOutcome> {
    if (this.hasUnconfirmedMedia) return Promise.reject(unconfirmedMediaError());
    if (!this.child) { this.state = 'stopped'; return Promise.resolve(this.stopOutcome ?? { exitConfirmed: true, forced: false, code: null }); }
    if (this.stopping) return this.stopping;
    // A timed-out attempt must not forget its child or send fresh signals to a
    // PID that could later be reused. The permanent exit listener still owns it.
    if (this.stopFailure) return Promise.reject(this.stopFailure);
    this.cancelStart?.();
    this.expectedExit = true;
    this.state = 'stopping';
    this.settingsEventLoop?.close();
    this.noteExitReason('stop-requested');
    this.recordDiagnostic('stop-requested');
    clearInterval(this.heartbeat ?? undefined);
    const child = this.child;
    const stopping = new Promise<StopOutcome>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined,
        confirmTimer: ReturnType<typeof setTimeout> | undefined, done = false, forced = false;
      const finish = (error: StopError | null, outcome?: StopOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(confirmTimer);
        this.removeListener('exit', exited);
        if (error) {
          if (!error.exitConfirmed) {
            this.stopFailure = error; this.state = 'stop-unconfirmed';
            this.recordDiagnostic('stop-unconfirmed', { exitConfirmed: false });
          }
          reject(error);
        } else { this.stopOutcome = outcome ?? null; resolve(outcome!); }
      };
      const exited = ({code}: {code: number}) => {
        const outcome: StopOutcome = { exitConfirmed: true, forced, code,
          ...(this.hasUnconfirmedMedia ? { mediaExitConfirmed: false } : {}) };
        this.stopOutcome = outcome;
        // Nonzero forced exit is expected. A utility's own close failure must
        // still be reported even if it subsequently needed a signal to exit.
        if (this.hasUnconfirmedMedia) finish(unconfirmedMediaError());
        else if (this.shutdownFailed || (!forced && code !== 0)) finish(stopError('BACKEND_STOP_FAILED', true));
        else finish(null, outcome);
      };
      const terminate = () => {
        if (done || this.child !== child || this.exitedChild === child) return;
        clearTimeout(timer);
        forced = true;
        this.stopForced = true;
        this.termination = 'utility-kill';
        this.recordDiagnostic('termination-requested', { classification: 'terminated', exitConfirmed: false });
        try { child.kill(); } catch { /* Continue to the owned hard-stop phase. */ }
        if (done) return;
        forceTimer = setTimeout(() => {
          if (done || this.child !== child || this.exitedChild === child) return;
          this.termination = 'owned-sigkill';
          this.recordDiagnostic('termination-requested', { classification: 'terminated', exitConfirmed: false });
          try { this.forceKill(child); } catch { /* Exit confirmation remains mandatory. */ }
          if (done) return;
        }, this.terminateTimeout);
      };
      this.once('exit', exited);
      // One absolute deadline covers all phases, even if signal delivery throws
      // or a delayed event-loop callback shortens the confirmation interval.
      confirmTimer = setTimeout(() => finish(stopError('BACKEND_STOP_UNCONFIRMED', false)),
        this.stopTimeout + this.terminateTimeout + this.exitTimeout);
      timer = setTimeout(terminate, this.stopTimeout);
      if (this.exitedChild !== child) {
        try { child.postMessage({ type: 'stop' }); }
        catch { terminate(); }
      }
    }).finally(() => { this.stopping = null; });
    this.stopping = stopping;
    return stopping;
  }
}
