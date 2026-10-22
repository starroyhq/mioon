/** Browser client for the project-file HTTP endpoints. They are deliberately
 * outside /api/rpc (workspace management, like backups), so they use plain
 * same-origin requests with the session cookie. Every response is validated
 * from unknown before the UI trusts it. */
export type ProjectPackageMedia = 'all' | 'used';
export interface ProjectPackageCounts { shots: number; assets: number; versions: number; clips: number; subtitles: number; subjects: number; luts: number }
export interface ProjectPackageMissing { assetId: string; name: string; reason: 'missing' | 'changed' }
export interface ProjectPackageExportPreview {
  projectId: string; counts: ProjectPackageCounts; totalBytes: number; assets: { total: number; used: number };
  exports: { count: number; bytes: number }; missing: ProjectPackageMissing[]; warnings: { runningTasks: number };
}
export interface ProjectPackageFailure { code: string; details?: Record<string, unknown> }
export interface ProjectPackageExportStatus {
  id: string; kind: 'export'; projectId: string; phase: 'running' | 'ready' | 'failed' | 'cancelled'; stage: 'writing' | 'verifying' | 'done';
  files: number; totalFiles: number; bytes: number; totalBytes: number; fileName: string; error?: ProjectPackageFailure;
}
export interface ProjectPackageImportPreview {
  id: string; kind: 'import'; name: string; suggestedName: string; nameTaken: boolean; counts: ProjectPackageCounts; totalBytes: number;
  fileCount: number; appVersion: string; createdAt: string; timeline: { width: number; height: number; fps: number } | null;
}

/** `network` means no server answer was read, so the outcome is unknown. */
export class ProjectPackageRequestError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly network: boolean;
  constructor(code: string, details?: Record<string, unknown>, network = false) {
    super('The project file request did not complete.'); this.name = 'ProjectPackageRequestError';
    this.code = code; this.details = details; this.network = network;
  }
}

type Fetcher = typeof fetch;
export interface ProjectPackageClientOptions {
  readonly fetcher?: Fetcher;
  readonly createXhr?: () => XMLHttpRequest;
  readonly wait?: (ms: number) => Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 400): value is string => typeof value === 'string' && value.length <= max;
const protocol = (): ProjectPackageRequestError => new ProjectPackageRequestError('BACKEND_PROTOCOL_ERROR');
const COUNT_KEYS = ['shots', 'assets', 'versions', 'clips', 'subtitles', 'subjects', 'luts'] as const;

function counts(value: unknown): ProjectPackageCounts {
  if (!record(value) || !COUNT_KEYS.every(key => count(value[key]))) throw protocol();
  return Object.fromEntries(COUNT_KEYS.map(key => [key, value[key]])) as unknown as ProjectPackageCounts;
}
function failure(value: unknown): ProjectPackageFailure | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !text(value.code, 96)) throw protocol();
  return { code: value.code, ...(record(value.details) ? { details: value.details } : {}) };
}
export function parseExportPreview(value: unknown): ProjectPackageExportPreview {
  if (!record(value) || !text(value.projectId) || !count(value.totalBytes) || !record(value.assets) || !count(value.assets.total) || !count(value.assets.used)
    || !record(value.exports) || !count(value.exports.count) || !count(value.exports.bytes) || !Array.isArray(value.missing) || !record(value.warnings) || !count(value.warnings.runningTasks)) throw protocol();
  const missing = value.missing.map(item => {
    if (!record(item) || !text(item.assetId) || !text(item.name) || (item.reason !== 'missing' && item.reason !== 'changed')) throw protocol();
    return { assetId: item.assetId, name: item.name, reason: item.reason } as ProjectPackageMissing;
  });
  return { projectId: value.projectId, counts: counts(value.counts), totalBytes: value.totalBytes, assets: { total: value.assets.total, used: value.assets.used },
    exports: { count: value.exports.count, bytes: value.exports.bytes }, missing, warnings: { runningTasks: value.warnings.runningTasks } };
}
export function parseExportStatus(value: unknown): ProjectPackageExportStatus {
  if (!record(value) || !text(value.id) || value.kind !== 'export' || !text(value.projectId) || !['running', 'ready', 'failed', 'cancelled'].includes(value.phase as string)
    || !['writing', 'verifying', 'done'].includes(value.stage as string) || !count(value.files) || !count(value.totalFiles) || !count(value.bytes) || !count(value.totalBytes) || !text(value.fileName)) throw protocol();
  const error = failure(value.error);
  return { id: value.id, kind: 'export', projectId: value.projectId, phase: value.phase as ProjectPackageExportStatus['phase'], stage: value.stage as ProjectPackageExportStatus['stage'],
    files: value.files, totalFiles: value.totalFiles, bytes: value.bytes, totalBytes: value.totalBytes, fileName: value.fileName, ...(error ? { error } : {}) };
}
export function parseImportPreview(value: unknown): ProjectPackageImportPreview {
  if (!record(value) || !text(value.id) || value.kind !== 'import' || !text(value.name, 150) || !text(value.suggestedName, 160) || typeof value.nameTaken !== 'boolean'
    || !count(value.totalBytes) || !count(value.fileCount) || !text(value.appVersion, 40) || !text(value.createdAt, 40)) throw protocol();
  let timeline: ProjectPackageImportPreview['timeline'] = null;
  if (value.timeline !== null) {
    const line = value.timeline;
    if (!record(line) || !count(line.width) || !count(line.height) || typeof line.fps !== 'number' || !Number.isFinite(line.fps) || line.fps < 0) throw protocol();
    timeline = { width: line.width, height: line.height, fps: line.fps };
  }
  return { id: value.id, kind: 'import', name: value.name, suggestedName: value.suggestedName, nameTaken: value.nameTaken, counts: counts(value.counts),
    totalBytes: value.totalBytes, fileCount: value.fileCount, appVersion: value.appVersion, createdAt: value.createdAt, timeline };
}
function created(value: unknown): { projectId: string } {
  if (!record(value) || !text(value.projectId) || !value.projectId) throw protocol();
  return { projectId: value.projectId };
}

/** Reads the {ok,data}|{ok:false,error} envelope shared by the local server. */
export function readEnvelope(status: number, body: unknown): unknown {
  if (record(body) && body.ok === true && 'data' in body && status >= 200 && status < 300) return body.data;
  if (record(body) && body.ok === false && record(body.error) && text(body.error.code, 96) && /^[A-Z][A-Z0-9_]*$/u.test(body.error.code))
    throw new ProjectPackageRequestError(status === 401 ? 'UNAUTHORIZED' : body.error.code, record(body.error.details) ? body.error.details : undefined);
  throw protocol();
}

export function createProjectPackageClient({ fetcher = (...args) => fetch(...args), createXhr = () => new XMLHttpRequest(), wait = ms => new Promise(resolve => { setTimeout(resolve, ms); }) }: ProjectPackageClientOptions = {}) {
  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try { response = await fetcher(url, { credentials: 'same-origin', ...init }); }
    catch (error) { if ((error as { name?: string })?.name === 'AbortError') throw error; throw new ProjectPackageRequestError('NETWORK', undefined, true); }
    let body: unknown;
    try { body = await response.json(); } catch { throw protocol(); }
    return readEnvelope(response.status, body);
  }
  const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  /** Creation endpoints replay by requestId, so a lost answer is retried
   * with the same id and never creates a second project. */
  async function replayable(url: string, value: Record<string, unknown>): Promise<{ projectId: string }> {
    const delays = [400, 1200, 3000];
    for (let attempt = 0; ; attempt++) {
      try { return created(await request(url, json('POST', value))); }
      catch (error) {
        if (!(error instanceof ProjectPackageRequestError) || !error.network || attempt >= delays.length) throw error;
        await wait(delays[attempt]!);
      }
    }
  }
  return {
    exportPreview: async (projectId: string, media: ProjectPackageMedia, signal?: AbortSignal) =>
      parseExportPreview(await request(`/api/projects/${encodeURIComponent(projectId)}/package-preview?media=${media}`, signal ? { signal } : {})),
    startExport: async (projectId: string, media: ProjectPackageMedia) => parseExportStatus(await request('/api/project-packages/exports', json('POST', { projectId, media }))),
    exportStatus: async (id: string) => parseExportStatus(await request(`/api/project-packages/exports/${encodeURIComponent(id)}`)),
    discardExport: async (id: string): Promise<void> => { await request(`/api/project-packages/exports/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    downloadUrl: (id: string): string => `/api/project-packages/exports/${encodeURIComponent(id)}/download`,
    commitImport: (id: string, input: { requestId: string; name: string }) => replayable(`/api/project-packages/imports/${encodeURIComponent(id)}/commit`, input),
    discardImport: async (id: string): Promise<void> => { await request(`/api/project-packages/imports/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    duplicate: (input: { projectId: string; requestId: string; name: string }) => replayable('/api/project-packages/duplicates', input),
    /** A file the desktop received from the OS (double-click), already verified; each is handed out once. */
    takeOpenedImport: async (): Promise<ProjectPackageImportPreview | null> => {
      const value = await request('/api/project-packages/imports/opened');
      if (!record(value)) throw protocol();
      return value.preview === null ? null : parseImportPreview(value.preview);
    },
    /** XHR instead of fetch so upload progress can be shown while the server verifies. */
    uploadImport(file: Blob, { onProgress, signal }: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {}): Promise<ProjectPackageImportPreview> {
      return new Promise((resolve, reject) => {
        const xhr = createXhr(), abort = () => xhr.abort();
        const done = () => signal?.removeEventListener('abort', abort);
        xhr.open('POST', '/api/project-packages/imports');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = event => { onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size); };
        xhr.onload = () => {
          done();
          try { let body: unknown; try { body = JSON.parse(String(xhr.responseText)); } catch { throw protocol(); } resolve(parseImportPreview(readEnvelope(xhr.status, body))); }
          catch (error) { reject(error); }
        };
        xhr.onerror = () => { done(); reject(new ProjectPackageRequestError('NETWORK', undefined, true)); };
        xhr.onabort = () => { done(); reject(new ProjectPackageRequestError('PROJECT_PACKAGE_CANCELLED')); };
        if (signal?.aborted) { reject(new ProjectPackageRequestError('PROJECT_PACKAGE_CANCELLED')); return; }
        signal?.addEventListener('abort', abort, { once: true });
        xhr.send(file);
      });
    },
  };
}
export type ProjectPackageClient = ReturnType<typeof createProjectPackageClient>;
