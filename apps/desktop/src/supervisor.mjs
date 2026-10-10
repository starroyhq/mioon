import { EventEmitter } from 'node:events';
import { trustedOrigin } from './security.mjs';
import { createAgentSettingsBroker } from './secret-broker.mjs';

// Normal worker drains finish inside the first phase. A signal being accepted
// is not proof of exit: keep the owned handle until Electron reports its exit.
export const BACKEND_STOP_BUDGET = Object.freeze({ gracefulMs: 10000, terminateMs: 2000, confirmMs: 1000 });
const stopError = (code, exitConfirmed) => Object.assign(new Error(code === 'BACKEND_STOP_UNCONFIRMED'
  ? '本地服务未确认退出。请稍后重试；在确认退出前不能重启服务。'
  : code === 'BACKEND_MEDIA_EXIT_UNCONFIRMED' ? '本地服务已退出，但媒体子进程是否退出尚无法确认。不能自动重启服务。'
  : '本地服务退出时未能完成正常清理。已保存的数据将在下次启动时恢复。'), { code, exitConfirmed });
const unconfirmedMediaError = () => Object.assign(stopError('BACKEND_MEDIA_EXIT_UNCONFIRMED', true), { mediaExitConfirmed: false });
const forceOwnedUtility = child => {
  const pid = child.pid;
  if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, 'SIGKILL');
};

export class BackendSupervisor extends EventEmitter {
  constructor({ fork, modulePath, environment, startupTimeout = 20000, stopTimeout = BACKEND_STOP_BUDGET.gracefulMs,
    terminateTimeout = BACKEND_STOP_BUDGET.terminateMs, exitTimeout = BACKEND_STOP_BUDGET.confirmMs,
    forceKill = forceOwnedUtility, agentSettings }) {
    super();
    for (const value of [startupTimeout, stopTimeout, terminateTimeout, exitTimeout]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 60000) throw new Error('Invalid backend lifecycle budget');
    }
    Object.assign(this, { fork, modulePath, environment, startupTimeout, stopTimeout, terminateTimeout, exitTimeout,
      forceKill, agentSettings });
    this.state = 'idle';
    this.mediaPids = new Set();
    this.mediaKinds = new Map();
    this.hasUnconfirmedMedia = false;
  }

  start(config) {
    if (this.hasUnconfirmedMedia) throw unconfirmedMediaError();
    if (this.child || this.stopping || !['idle', 'stopped', 'failed'].includes(this.state)) throw new Error('Backend already active');
    this.state = 'starting';
    this.origin = null;
    this.expectedExit = false;
    this.stopFailure = null;
    this.stopOutcome = null;
    this.shutdownFailed = false;
    this.stopForced = false;
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
      } catch (error) { fail(error); return; }
      const kill = () => { if (this.child === child) { try { child.kill(); } catch {} } };
      // The listener and replies belong to this exact child. A late completion
      // from an old utility can never be delivered to its replacement.
      const settingsBroker = createAgentSettingsBroker({ agentSettings: this.agentSettings,
        send: message => child.postMessage(message),
        isActive: () => this.child === child && ['running', 'stopping'].includes(this.state),
        getSelfPort: () => this.origin ? Number(new URL(this.origin).port) : null });
      timer = setTimeout(() => { fail(new Error('本地服务启动超时')); kill(); }, this.startupTimeout);
      child.on('error', () => {
        if (this.child !== child || !['starting', 'running'].includes(this.state)) return;
        fail(new Error('本地服务运行时错误')); kill();
      });
      child.on('message', message => {
        if (settingsBroker.handle(message)) return;
        if (this.child !== child) return;
        if (message?.type === 'media-process') {
          const pid = message.pid;
          if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== child.pid) {
            if (message.event === 'started') { this.mediaPids.add(pid); this.mediaKinds.set(pid, message.kind); }
            if (message.event === 'exited') { this.mediaPids.delete(pid); this.mediaKinds.delete(pid); }
          }
          return;
        }
        if (message?.type === 'shutdown-failed') { this.shutdownFailed = true; return; }
        if (message?.type === 'failed') { fail(new Error('本地服务启动失败。请检查数据目录和应用文件。')); return; }
        if (message?.type !== 'ready' || settled || this.state !== 'starting') return;
        try { this.origin = trustedOrigin(message.url); }
        catch (error) { fail(error); kill(); return; }
        settled = true;
        clearTimeout(timer);
        this.cancelStart = null;
        this.state = 'running';
        heartbeat = this.heartbeat = setInterval(() => {
          if (this.child === child && this.state === 'running') { try { child.postMessage({ type: 'ping' }); } catch { kill(); } }
        }, 10000);
        resolve({ url: this.origin, runtime: message.runtime });
      });
      child.once('exit', code => {
        settingsBroker.close();
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (this.child !== child) return;
        if (!settled) fail(new Error(`本地服务退出 (${code})`));
        this.child = null;
        this.stopFailure = null;
        this.stopOutcome = { exitConfirmed: true, forced: this.stopForced, code };
        // Telemetry identifies a reported PID, not an OS process handle. After
        // utility death that PID could have been reused: never signal it or
        // claim media reap. Retain uncertainty and block automatic replacement.
        this.hasUnconfirmedMedia = this.mediaPids.size > 0;
        if (this.hasUnconfirmedMedia) this.stopOutcome.mediaExitConfirmed = false;
        this.state = this.hasUnconfirmedMedia ? 'media-unconfirmed' : this.expectedExit ? 'stopped' : 'failed';
        this.emit('exit', { code, expected: this.expectedExit,
          ...(this.hasUnconfirmedMedia ? { mediaExitConfirmed: false } : {}) });
      });
      try { child.postMessage({ type: 'start', ...config }); }
      catch { fail(new Error('本地服务启动通信失败')); kill(); }
    });
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
          if (!error.exitConfirmed) { this.stopFailure = error; this.state = 'stop-unconfirmed'; }
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
        try { child.kill(); } catch { /* Continue to the owned hard-stop phase. */ }
        if (done) return;
        forceTimer = setTimeout(() => {
          if (done || this.child !== child) return;
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
