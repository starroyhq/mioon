import { ensurePrivateDirectory, validatePrivateDirectory } from '@mioon/contracts/private-storage';
import { EventEmitter } from 'node:events';
import { trustedOrigin } from './security.ts';
import { createAgentSettingsBroker } from './secret-broker.ts';
import { createImageSecretBroker } from './image-secret-broker.ts';
import { createNativeAudioPreviewBroker } from './native-audio-preview-broker.ts';
import { nativeAudioConfigSchema } from '@mioon/contracts/native-audio-preview';
import { createExitDiagnostics, classifyBackendExit } from './exit-diagnostics.ts';

// Normal worker drains finish inside the first phase. A signal being accepted
// is not proof of exit: keep the owned handle until Electron reports its exit.
export const BACKEND_STOP_BUDGET = Object.freeze({ gracefulMs: 10000, terminateMs: 2000, confirmMs: 1000 });
const stopError = (code, exitConfirmed) => Object.assign(new Error(code === 'BACKEND_STOP_UNCONFIRMED'
  ? '本地服务未确认退出。请稍后重试；在确认退出前不能重启服务'
  : code === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? '本地服务已退出，但媒体子进程是否退出尚无法确认。不能自动重启服务'
  : '本地服务退出时未能完成正常清理。已保存的数据将在下次启动时恢复'), { code, exitConfirmed });
const unconfirmedMediaError = () => Object.assign(stopError('BACKEND_MEDIA_EXIT_UNCONFIRMED', true), { mediaExitConfirmed: false });
const forceOwnedUtility = child => {
  const pid = child.pid;
  if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, 'SIGKILL');
};
const backendExitReasons = new Set(['stop-requested', 'lease-expired', 'signal-term', 'signal-int',
  'uncaught-exception', 'unhandled-rejection', 'shutdown-failed', 'startup-failed']);

export class BackendSupervisor extends EventEmitter {
  constructor({ fork, modulePath, environment, startupTimeout = 20000, stopTimeout = BACKEND_STOP_BUDGET.gracefulMs,
    terminateTimeout = BACKEND_STOP_BUDGET.terminateMs, exitTimeout = BACKEND_STOP_BUDGET.confirmMs,
    forceKill = forceOwnedUtility, agentSettings, imageSecretCodec }) {
    super();
    for (const value of [startupTimeout, stopTimeout, terminateTimeout, exitTimeout]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 60000) throw new Error('Invalid backend lifecycle budget');
    }
    Object.assign(this, { fork, modulePath, environment, startupTimeout, stopTimeout, terminateTimeout, exitTimeout,
      forceKill, agentSettings, imageSecretCodec });
    this.state = 'idle';
    this.mediaPids = new Set();
    this.mediaKinds = new Map();
    this.hasUnconfirmedMedia = false;
  }

  start(config) {
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
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let heartbeat;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        this.state = 'failed';
        reject(error);
      };
      this.cancelStart = () => fail(Object.assign(new Error('本地服务启动已取消'), { code: 'BACKEND_START_CANCELLED' }));
      let child;
      try {
        child = this.child = this.fork(this.modulePath, [], {
          env: this.environment, stdio: 'ignore', serviceName: 'Mioon Backend',
          allowLoadingUnsignedLibraries: false, execArgv: []
        });
      } catch (error) { this.exitReason = 'startup-error'; this.recordDiagnostic('spawn-failed', { classification: 'abnormal' }); fail(error); return; }
      const kill = reason => {
        if (this.child !== child) return;
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
      // Startup needs vault status/decryption while the Images engine is loaded
      // in the utility. This bridge owns no settings or session credential RAM.
      const imageSecretBroker = createImageSecretBroker({ imageSecretCodec: this.imageSecretCodec,
        send: message => child.postMessage(message),
        isActive: () => this.child === child && ['starting', 'running', 'stopping'].includes(this.state) });
      const nativeAudioBroker = config.nativeAudioPreview ? createNativeAudioPreviewBroker({
        backendId: config.nativeAudioPreview.backendId, send: message => child.postMessage(message),
        isCurrent: () => this.child === child && ['running', 'stopping'].includes(this.state),
      }) : null;
      this.nativeAudioBroker = nativeAudioBroker;
      timer = setTimeout(() => { this.noteExitReason('startup-timeout'); fail(new Error('本地服务启动超时')); kill('startup-timeout'); }, this.startupTimeout);
      child.on('error', () => {
        if (this.child !== child || !['starting', 'running'].includes(this.state)) return;
        const reason = this.state === 'starting' ? 'startup-error' : 'runtime-error';
        this.noteExitReason(reason);
        fail(new Error('本地服务运行时错误')); kill(reason);
      });
      child.on('message', message => {
        if (settingsBroker.handle(message)) return;
        if (imageSecretBroker.handle(message)) return;
        if (nativeAudioBroker?.handle(message)) return;
        if (this.child !== child) return;
        if (message?.type === 'exit-diagnostic') {
          // Only fixed reason labels cross into diagnostics. Never persist a
          // utility message, error, runtime payload, or startup configuration.
          if (backendExitReasons.has(message.reason)) {
            this.noteExitReason(message.reason);
            if (message.reason === 'shutdown-failed') this.shutdownFailed = true;
            this.recordDiagnostic('backend-notice', { reason: message.reason });
          }
          return;
        }
        if (message?.type === 'media-process') {
          const pid = message.pid;
          if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== child.pid) {
            if (message.event === 'started') { this.mediaPids.add(pid); this.mediaKinds.set(pid, message.kind); }
            if (message.event === 'exited') { this.mediaPids.delete(pid); this.mediaKinds.delete(pid); }
          }
          return;
        }
        if (message?.type === 'shutdown-failed') {
          this.shutdownFailed = true; this.noteExitReason('shutdown-failed'); this.recordDiagnostic('backend-notice', { reason: 'shutdown-failed' }); return;
        }
        if (message?.type === 'failed') {
          this.noteExitReason('startup-failed'); this.recordDiagnostic('backend-notice');
          fail(new Error('本地服务启动失败。请检查数据目录和应用文件')); return;
        }
        if (message?.type !== 'ready' || settled || this.state !== 'starting') return;
        try { this.origin = trustedOrigin(message.url); }
        catch (error) { this.noteExitReason('invalid-origin'); fail(error); kill('invalid-origin'); return; }
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
        resolve({ url: this.origin, runtime: message.runtime });
      });
      child.once('exit', code => {
        settingsBroker.close();
        imageSecretBroker.close();
        nativeAudioBroker?.close();
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (this.child !== child) return;
        const exitState = this.state;
        if (!settled) fail(new Error(`本地服务退出 (${code})`));
        this.child = null;
        this.stopFailure = null;
        this.stopOutcome = { exitConfirmed: true, forced: this.stopForced, code };
        // Telemetry identifies a reported PID, not an OS process handle. After
        // utility death that PID could have been reused: never signal it or
        // claim media reap. Retain uncertainty and block automatic replacement.
        this.hasUnconfirmedMedia = this.mediaPids.size > 0;
        if (this.hasUnconfirmedMedia) this.stopOutcome.mediaExitConfirmed = false;
        const reason = this.exitReason ?? 'utility-exit';
        const classification = classifyBackendExit({ reason, shutdownFailed: this.shutdownFailed,
          forced: this.stopForced, expected: this.expectedExit, code, mediaExitConfirmed: !this.hasUnconfirmedMedia });
        this.recordDiagnostic('exit', { state: exitState, reason, classification, code,
          exitConfirmed: true, mediaExitConfirmed: !this.hasUnconfirmedMedia });
        this.state = this.hasUnconfirmedMedia ? 'media-unconfirmed' : this.expectedExit ? 'stopped' : 'failed';
        this.emit('exit', { code, expected: this.expectedExit,
          ...(this.hasUnconfirmedMedia ? { mediaExitConfirmed: false } : {}) });
      });
      try { child.postMessage({ type: 'start', ...config }); }
      catch { this.noteExitReason('startup-communication-failed'); fail(new Error('本地服务启动通信失败')); kill('startup-communication-failed'); }
    });
  }

  noteExitReason(reason) {
    // A later user quit must not erase the fault that initiated shutdown.
    if (!this.exitReason || this.exitReason === 'stop-requested' ||
      ['uncaught-exception', 'unhandled-rejection'].includes(reason)) this.exitReason = reason;
  }

  recordDiagnostic(event, details = {}) {
    this.diagnosticsAvailable = this.diagnostics?.record({ event, state: this.state, reason: this.exitReason,
      expected: this.expectedExit, forced: this.stopForced || this.termination !== null, shutdownFailed: this.shutdownFailed,
      termination: this.termination, ...details }) ?? false;
  }

  requestNativeAudio(command, onPending) {
    if (!this.nativeAudioBroker) return Promise.reject(Object.assign(new Error('Native audition is unavailable.'), {code: 'NATIVE_AUDIO_UNCONFIRMED'}));
    return this.nativeAudioBroker.request(command, onPending);
  }

  stop() {
    if (this.hasUnconfirmedMedia) return Promise.reject(unconfirmedMediaError());
    if (!this.child) { this.state = 'stopped'; return Promise.resolve(this.stopOutcome ?? { exitConfirmed: true, forced: false, code: null }); }
    if (this.stopping) return this.stopping;
    // A timed-out attempt must not forget its child or send fresh signals to a
    // PID that could later be reused. The permanent exit listener still owns it.
    if (this.stopFailure) return Promise.reject(this.stopFailure);
    this.cancelStart?.();
    this.expectedExit = true;
    this.state = 'stopping';
    this.noteExitReason('stop-requested');
    this.recordDiagnostic('stop-requested');
    clearInterval(this.heartbeat);
    const child = this.child;
    this.stopping = new Promise((resolve, reject) => {
      let timer, forceTimer, confirmTimer, done = false, forced = false;
      const finish = (error, outcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(confirmTimer);
        child.removeListener('exit', exited);
        if (error) {
          if (!error.exitConfirmed) {
            this.stopFailure = error; this.state = 'stop-unconfirmed';
            this.recordDiagnostic('stop-unconfirmed', { exitConfirmed: false });
          }
          reject(error);
        } else { this.stopOutcome = outcome; resolve(outcome); }
      };
      const exited = code => {
        const outcome = { exitConfirmed: true, forced, code,
          ...(this.hasUnconfirmedMedia ? { mediaExitConfirmed: false } : {}) };
        this.stopOutcome = outcome;
        // Nonzero forced exit is expected. A utility's own close failure must
        // still be reported even if it subsequently needed a signal to exit.
        if (this.hasUnconfirmedMedia) finish(unconfirmedMediaError());
        else if (this.shutdownFailed || (!forced && code !== 0)) finish(stopError('BACKEND_STOP_FAILED', true));
        else finish(null, outcome);
      };
      const terminate = () => {
        if (done || this.child !== child) return;
        clearTimeout(timer);
        forced = true;
        this.stopForced = true;
        this.termination = 'utility-kill';
        this.recordDiagnostic('termination-requested', { classification: 'terminated', exitConfirmed: false });
        try { child.kill(); } catch { /* Continue to the owned hard-stop phase. */ }
        if (done) return;
        forceTimer = setTimeout(() => {
          if (done || this.child !== child) return;
          this.termination = 'owned-sigkill';
          this.recordDiagnostic('termination-requested', { classification: 'terminated', exitConfirmed: false });
          try { this.forceKill(child); } catch { /* Exit confirmation remains mandatory. */ }
          if (done) return;
        }, this.terminateTimeout);
      };
      child.once('exit', exited);
      // One absolute deadline covers all phases, even if signal delivery throws
      // or a delayed event-loop callback shortens the confirmation interval.
      confirmTimer = setTimeout(() => finish(stopError('BACKEND_STOP_UNCONFIRMED', false)),
        this.stopTimeout + this.terminateTimeout + this.exitTimeout);
      timer = setTimeout(terminate, this.stopTimeout);
      try { child.postMessage({ type: 'stop' }); }
      catch { terminate(); }
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
