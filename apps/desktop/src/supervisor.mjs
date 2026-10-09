import { EventEmitter } from 'node:events';
import { trustedOrigin } from './security.mjs';

export class BackendSupervisor extends EventEmitter {
  constructor({ fork, modulePath, environment, startupTimeout = 20000, stopTimeout = 10000,
    killMedia = pid => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } }) {
    super();
    Object.assign(this, { fork, modulePath, environment, startupTimeout, stopTimeout, killMedia });
    this.state = 'idle';
    this.mediaPids = new Set();
    this.mediaKinds = new Map();
  }

  start(config) {
    if (!['idle', 'stopped', 'failed'].includes(this.state)) throw new Error('Backend already active');
    this.state = 'starting';
    this.expectedExit = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = 'failed';
        reject(error);
      };
      let child;
      try {
        child = this.child = this.fork(this.modulePath, [], {
          env: this.environment, stdio: 'ignore', serviceName: 'Mioon Backend',
          allowLoadingUnsignedLibraries: false, execArgv: []
        });
      } catch (error) { fail(error); return; }
      timer = setTimeout(() => { fail(new Error('本地服务启动超时')); child.kill(); }, this.startupTimeout);
      child.on('error', () => { fail(new Error('本地服务运行时错误')); child.kill(); });
      child.on('message', message => {
        if (message?.type === 'media-process') {
          const pid = message.pid;
          if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== child.pid) {
            if (message.event === 'started') { this.mediaPids.add(pid); this.mediaKinds.set(pid, message.kind); }
            if (message.event === 'exited') { this.mediaPids.delete(pid); this.mediaKinds.delete(pid); }
          }
          return;
        }
        if (message?.type === 'failed') { fail(new Error(message.message)); return; }
        if (message?.type !== 'ready' || settled) return;
        try { this.origin = trustedOrigin(message.url); }
        catch (error) { fail(error); child.kill(); return; }
        settled = true;
        clearTimeout(timer);
        this.state = 'running';
        this.heartbeat = setInterval(() => { if (this.child === child && this.state === 'running') child.postMessage({ type: 'ping' }); }, 10000);
        resolve({ url: this.origin, runtime: message.runtime });
      });
      child.once('exit', code => {
        clearTimeout(timer);
        clearInterval(this.heartbeat);
        if (!settled) fail(new Error(`本地服务退出 (${code})`));
        this.child = null;
        // Only PIDs reported by our trusted utility as its active media children.
        // Clean these before allowing a new utility to recover queued render work.
        for (const pid of this.mediaPids) { try { this.killMedia(pid); } catch {} }
        this.mediaPids.clear();
        this.mediaKinds.clear();
        this.state = this.expectedExit ? 'stopped' : 'failed';
        this.emit('exit', { code, expected: this.expectedExit });
      });
      child.postMessage({ type: 'start', ...config });
    });
  }

  async stop() {
    if (!this.child) { this.state = 'stopped'; return; }
    if (this.stopping) return this.stopping;
    this.expectedExit = true;
    this.state = 'stopping';
    clearInterval(this.heartbeat);
    const child = this.child;
    this.stopping = new Promise(resolve => {
      let forceTimer;
      const timer = setTimeout(() => {
        child.kill();
        // Last resort only after graceful stop and SIGTERM; preserves WAL recovery.
        forceTimer = setTimeout(() => { if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch {} } }, 2000);
      }, this.stopTimeout);
      child.once('exit', () => { clearTimeout(timer); clearTimeout(forceTimer); resolve(); });
      child.postMessage({ type: 'stop' });
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
