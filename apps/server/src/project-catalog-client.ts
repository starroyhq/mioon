import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AppError} from '../../../packages/contracts/src/app-error.ts';
import {catalogObject, isCatalogScanBatch, isCatalogScanResult} from './project-catalog-scan.ts';
import type {ProjectCatalogScanInput, ProjectCatalogScanResult} from './project-catalog-scan.ts';

export interface ProjectCatalogMessagePort {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface ProjectCatalogClient {
  scan(inputs: readonly ProjectCatalogScanInput[]): Promise<readonly ProjectCatalogScanResult[]>;
  close(): void;
  drain?(): Promise<void>;
}

export const projectCatalogUnavailable = (): AppError =>
  new AppError('PROJECT_ENTRY_UNAVAILABLE', '暂时无法检查项目目录', 503);

/** Owns a single trusted scanner endpoint. The caller joins catalog requests;
 * filesystem probes for concurrently discovered moves can use it as well. */
export function createProjectCatalogClient(port: ProjectCatalogMessagePort): ProjectCatalogClient {
  let closed = false;
  let sequence = 0;
  const pending = new Map<number, {
    readonly length: number;
    readonly resolve: (result: readonly ProjectCatalogScanResult[]) => void;
    readonly reject: (error: unknown) => void;
  }>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(projectCatalogUnavailable());
    pending.clear();
    port.close();
  };
  port.onClose(close);
  port.onMessage(value => {
    if (closed) return;
    const message = catalogObject(value);
    const id = message?.id;
    const request = typeof id === 'number' ? pending.get(id) : undefined;
    if (!message || typeof id !== 'number' || !request || Object.keys(message).length !== 3 || message.type !== 'project-catalog:result'
      || !Array.isArray(message.results) || message.results.length !== request.length || !message.results.every(isCatalogScanResult)) {
      close();
      return;
    }
    pending.delete(id);
    request.resolve(message.results);
  });
  return {
    scan(inputs) {
      if (closed || !isCatalogScanBatch(inputs)) return Promise.reject(projectCatalogUnavailable());
      if (inputs.length === 0) return Promise.resolve([]);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, {length: inputs.length, resolve, reject});
        try { port.postMessage({type: 'project-catalog:scan', id, inputs}); }
        catch { close(); }
      });
    },
    close,
  };
}

// No access token, provider credentials, NODE_OPTIONS or custom loader goes
// to a child that only needs the operating system's temporary directory.
const inheritedEnvironment = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;

/** The standalone server runs from TS source with Node 24. Electron supplies a
 * distinct utility process through the same normalized client interface. */
export function createNodeProjectCatalogClient(): ProjectCatalogClient {
  let client: ProjectCatalogClient | undefined;
  let stopped = false;
  const owned = new Set<Promise<void>>();
  const start = (): ProjectCatalogClient => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of inheritedEnvironment) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    const child = fork(fileURLToPath(new URL('./project-catalog-node.ts', import.meta.url)), [], {
      execPath: process.execPath, execArgv: [], env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<void>(resolve => {
      // Node need not emit 'close' after explicit IPC disconnect with all
      // three stdio streams ignored. 'exit' confirms the owned process is
      // gone; 'close' still covers failures to spawn.
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    owned.add(exited);
    void exited.then(() => owned.delete(exited));
    const connected = createProjectCatalogClient({
      postMessage(value) {
        if (!child.connected) throw projectCatalogUnavailable();
        child.send(value as Parameters<typeof child.send>[0], error => { if (error) connected.close(); });
      },
      onMessage(listener) { child.on('message', listener); },
      onClose(listener) { child.once('close', listener); child.once('error', listener); child.once('disconnect', listener); },
      close() {
        if (client === connected) client = undefined;
        try { if (child.connected) child.disconnect(); } catch { /* Reap below if disconnect races with exit. */ }
        if (child.exitCode === null && child.signalCode === null) {
          // A graceful IPC close allows an active rollback to finish. If a
          // filesystem operation has stalled, reap this exact owned process.
          const force = setTimeout(() => {
            try {child.kill('SIGKILL');} catch { /* The owner still awaits confirmed close. */ }
          }, 100);
          force.unref();
          void exited.then(() => clearTimeout(force));
        }
      },
    });
    return connected;
  };
  return {
    async scan(inputs) {
      if (stopped || !isCatalogScanBatch(inputs)) throw projectCatalogUnavailable();
      if (!inputs.length) return [];
      try {
        // A broken IPC channel can retire a worker during native recovery.
        // Confirm the retired process exited before admitting its replacement.
        if (!client && owned.size > 0) await Promise.all(owned);
        if (stopped) throw projectCatalogUnavailable();
        return await (client ??= start()).scan(inputs);
      }
      catch { throw projectCatalogUnavailable(); }
    },
    close() {
      stopped = true;
      client?.close();
    },
    async drain() { await Promise.all(owned); },
  };
}
