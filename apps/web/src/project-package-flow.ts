import { createProjectPackageClient, ProjectPackageRequestError } from './project-package-client.ts';
import type { ProjectPackageClient, ProjectPackageCounts, ProjectPackageExportPreview, ProjectPackageExportStatus, ProjectPackageFailure, ProjectPackageImportPreview, ProjectPackageMedia, ProjectPackageMissing } from './project-package-client.ts';
import { isProjectPackageDestination, projectPackagesBridge } from './project-package-bridge.ts';
import type { ProjectPackagesBridge } from './project-package-bridge.ts';

/** One export, import or duplicate at a time, owned by this module rather than a
 * component: the dialog may collapse into a background notice and the user may
 * move between the home page and the workbench while it runs. It never enters
 * the task center. */
export interface PackageProject { readonly id: string; readonly name: string }
export type ExportView =
  | { step: 'options'; media: ProjectPackageMedia; preview: ProjectPackageExportPreview | null; loading: boolean; previewFailed: boolean; choosing: boolean; error?: ProjectPackageFailure }
  | { step: 'running'; status: ProjectPackageExportStatus }
  | { step: 'saving'; status: ProjectPackageExportStatus }
  | { step: 'done'; fileName: string; bytes: number; token: string | null }
  | { step: 'failed'; error: ProjectPackageFailure };
export type ImportView =
  | { step: 'uploading'; loaded: number; total: number }
  | { step: 'preview'; preview: ProjectPackageImportPreview; name: string }
  | { step: 'committing'; preview: ProjectPackageImportPreview; name: string }
  | { step: 'done'; projectId: string; name: string; counts: ProjectPackageCounts }
  | { step: 'failed'; error: ProjectPackageFailure };
export type DuplicateView =
  | { step: 'editing'; name: string; estimate: number | null }
  | { step: 'running'; name: string }
  | { step: 'done'; projectId: string; name: string }
  | { step: 'failed'; error: ProjectPackageFailure };
export type PackageFlow =
  | { kind: 'export'; serial: number; project: PackageProject; unsaved: boolean; background: boolean; view: ExportView }
  | { kind: 'import'; serial: number; fileName: string; fileBytes: number; background: boolean; view: ImportView }
  | { kind: 'duplicate'; serial: number; project: PackageProject; background: boolean; view: DuplicateView };
export interface PackageFlowState {
  readonly flow: PackageFlow | null;
  /** Projects imported during this session, newest first: the home cards show "just imported". */
  readonly recentImports: readonly string[];
  /** Increments whenever a new project was created, so mounted lists refresh. */
  readonly created: number;
}

export function isFlowRunning(flow: PackageFlow | null): boolean {
  if (!flow) return false;
  const step = flow.view.step;
  return step === 'running' || step === 'saving' || step === 'uploading' || step === 'committing';
}
export function failureOf(error: unknown): ProjectPackageFailure {
  if (error instanceof ProjectPackageRequestError) return { code: error.network ? 'NETWORK' : error.code, ...(error.details ? { details: error.details } : {}) };
  return { code: 'UNKNOWN' };
}
export function missingOf(failure: ProjectPackageFailure | undefined): ProjectPackageMissing[] {
  const list = failure?.details?.missing;
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.assetId === 'string'
    ? [{ assetId: item.assetId, name: item.name, reason: item.reason === 'changed' ? 'changed' as const : 'missing' as const }] : []);
}
export const PROJECT_FILE_EXTENSION = '.mioon';
export const isProjectFileName = (name: string): boolean => name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);
const fileSafe = (name: string): string => name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim().slice(0, 120) || 'project';

export interface PackageFlowDependencies {
  readonly client?: ProjectPackageClient;
  readonly bridge?: () => ProjectPackagesBridge | null;
  readonly randomId?: () => string;
  readonly schedule?: (run: () => void, ms: number) => unknown;
  /** Starts a browser download of a same-origin URL. */
  readonly download?: (url: string, fileName: string) => void;
  readonly pollMs?: number;
  readonly downloadGraceMs?: number;
}

function browserDownload(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener'; anchor.style.display = 'none';
  document.body.append(anchor); anchor.click(); anchor.remove();
}

export function createPackageFlow({ client = createProjectPackageClient(), bridge = () => projectPackagesBridge(), randomId = () => crypto.randomUUID(),
  schedule = (run, ms) => setTimeout(run, ms), download = browserDownload, pollMs = 400, downloadGraceMs = 60_000 }: PackageFlowDependencies = {}) {
  let state: PackageFlowState = { flow: null, recentImports: [], created: 0 };
  let serial = 0, previewSerial = 0, uploadAbort: AbortController | null = null, checkingOpened = false;
  let heldOpened: ProjectPackageImportPreview | null = null;
  const listeners = new Set<() => void>();
  const layers: number[] = [];
  const pickers = new Map<number, () => void>();
  let layerSerial = 0;
  const emit = (): void => { for (const listener of [...listeners]) listener(); };
  const set = (next: Partial<PackageFlowState>): void => { state = { ...state, ...next }; emit(); };
  const current = <K extends PackageFlow['kind']>(kind: K, id: number): Extract<PackageFlow, { kind: K }> | null =>
    state.flow && state.flow.kind === kind && state.flow.serial === id ? state.flow as Extract<PackageFlow, { kind: K }> : null;
  function update<K extends PackageFlow['kind']>(kind: K, id: number, patch: (flow: Extract<PackageFlow, { kind: K }>) => Partial<Extract<PackageFlow, { kind: K }>>): boolean {
    const flow = current(kind, id); if (!flow) return false;
    set({ flow: { ...flow, ...patch(flow) } as PackageFlow }); return true;
  }
  const quietly = (work: Promise<unknown>): void => { void work.catch(() => {}); };
  /** A finished background notice gives way to a new request; a running one is shown instead. */
  function admit(): boolean {
    const flow = state.flow;
    if (!flow) return true;
    if (isFlowRunning(flow)) { set({ flow: { ...flow, background: false } as PackageFlow }); return false; }
    dismiss(); return true;
  }

  function loadPreview(id: number, projectId: string, media: ProjectPackageMedia): void {
    const ticket = ++previewSerial;
    void client.exportPreview(projectId, media).then(preview => {
      if (ticket === previewSerial) update('export', id, flow => flow.view.step === 'options' ? { view: { ...flow.view, preview, loading: false, previewFailed: false } } : {});
    }, () => {
      if (ticket === previewSerial) update('export', id, flow => flow.view.step === 'options' ? { view: { ...flow.view, loading: false, previewFailed: true } } : {});
    });
  }
  function poll(id: number, exportId: string, token: string | null, misses = 0): void {
    schedule(() => {
      const flow = current('export', id); if (!flow || flow.view.step !== 'running') return;
      void client.exportStatus(exportId).then(status => {
        if (!current('export', id) || current('export', id)!.view.step !== 'running') return;
        if (status.phase === 'running') { update('export', id, () => ({ view: { step: 'running', status } })); poll(id, exportId, token); return; }
        if (status.phase === 'ready') { void deliver(id, status, token); return; }
        quietly(client.discardExport(exportId));
        update('export', id, () => ({ view: { step: 'failed', error: status.error ?? { code: status.phase === 'cancelled' ? 'PROJECT_PACKAGE_CANCELLED' : 'UNKNOWN' } } }));
      }, error => {
        if (!current('export', id)) return;
        if (failureOf(error).code === 'NETWORK' && misses < 5) { poll(id, exportId, token, misses + 1); return; }
        update('export', id, () => ({ view: { step: 'failed', error: failureOf(error) } }));
      });
    }, pollMs);
  }
  async function deliver(id: number, status: ProjectPackageExportStatus, token: string | null): Promise<void> {
    update('export', id, () => ({ view: { step: 'saving', status } }));
    const native = token ? bridge() : null;
    if (token && native) {
      try {
        const saved = await native.save({ token, exportId: status.id });
        update('export', id, () => ({ view: { step: 'done', fileName: typeof saved?.fileName === 'string' && saved.fileName ? saved.fileName : status.fileName, bytes: status.totalBytes, token } }));
      } catch { update('export', id, () => ({ view: { step: 'failed', error: { code: 'SAVE_FAILED' } } })); }
      quietly(client.discardExport(status.id));
      return;
    }
    try { download(client.downloadUrl(status.id), status.fileName); }
    catch { quietly(client.discardExport(status.id)); update('export', id, () => ({ view: { step: 'failed', error: { code: 'SAVE_FAILED' } } })); return; }
    // The download request is already in flight; the server only needs the
    // staged file until its stream opens, so it is discarded after a grace period.
    schedule(() => quietly(client.discardExport(status.id)), downloadGraceMs);
    update('export', id, () => ({ view: { step: 'done', fileName: status.fileName, bytes: status.totalBytes, token: null } }));
  }
  async function commit(id: number, requestId: string): Promise<void> {
    const flow = current('import', id); if (!flow || flow.view.step !== 'committing') return;
    const { preview, name } = flow.view;
    try {
      const { projectId } = await client.commitImport(preview.id, { requestId, name });
      if (!current('import', id)) return;
      set({ recentImports: [projectId, ...state.recentImports.filter(value => value !== projectId)], created: state.created + 1 });
      update('import', id, () => ({ view: { step: 'done', projectId, name, counts: preview.counts } }));
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code !== 'NETWORK') quietly(client.discardImport(preview.id));
      // A lost answer may still have created the project; the list is refreshed either way.
      if (failure.code === 'NETWORK') set({ created: state.created + 1 });
      update('import', id, () => ({ view: { step: 'failed', error: failure } }));
    }
  }

  function dismiss(): void {
    const flow = state.flow; if (!flow) return;
    if (isFlowRunning(flow)) return;
    if (flow.kind === 'import' && flow.view.step === 'preview') quietly(client.discardImport(flow.view.preview.id));
    previewSerial++;
    set({ flow: null });
  }

  return {
    getState: (): PackageFlowState => state,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Only the most recently mounted layer renders, so an embedded home inside
     * the workbench never shows a second copy of the same dialog. */
    claimLayer(): number { const id = ++layerSerial; layers.push(id); emit(); return id; },
    releaseLayer(id: number): void { pickers.delete(id); const index = layers.indexOf(id); if (index >= 0) { layers.splice(index, 1); emit(); } },
    registerPicker(id: number, open: () => void): void { pickers.set(id, open); },
    /** Opens the top layer's file picker; must run inside the user's click. */
    chooseImportFile(): boolean {
      const open = pickers.get(layers[layers.length - 1] ?? -1);
      if (!open) return false;
      if (state.flow && isFlowRunning(state.flow)) { set({ flow: { ...state.flow, background: false } as PackageFlow }); return false; }
      open(); return true;
    },
    isTopLayer: (id: number): boolean => layers[layers.length - 1] === id,

    openExport(project: PackageProject, { unsaved = false }: { unsaved?: boolean } = {}): boolean {
      if (!admit()) return false;
      const id = ++serial;
      set({ flow: { kind: 'export', serial: id, project, unsaved, background: false, view: { step: 'options', media: 'all', preview: null, loading: true, previewFailed: false, choosing: false } } });
      loadPreview(id, project.id, 'all');
      return true;
    },
    setExportMedia(media: ProjectPackageMedia): void {
      const flow = state.flow; if (!flow || flow.kind !== 'export' || flow.view.step !== 'options' || flow.view.choosing || flow.view.media === media) return;
      update('export', flow.serial, item => item.view.step === 'options' ? { view: { ...item.view, media, loading: true, previewFailed: false, error: undefined } } : {});
      loadPreview(flow.serial, flow.project.id, media);
    },
    retryExportPreview(): void {
      const flow = state.flow; if (!flow || flow.kind !== 'export' || flow.view.step !== 'options' || flow.view.choosing) return;
      update('export', flow.serial, item => item.view.step === 'options' ? { view: { ...item.view, loading: true, previewFailed: false } } : {});
      loadPreview(flow.serial, flow.project.id, flow.view.media);
    },
    async confirmExport(): Promise<void> {
      const flow = state.flow; if (!flow || flow.kind !== 'export' || flow.view.step !== 'options' || flow.view.choosing || flow.view.loading || flow.view.preview?.missing.length) return;
      const id = flow.serial, media = flow.view.media;
      update('export', id, item => item.view.step === 'options' ? { view: { ...item.view, choosing: true, error: undefined } } : {});
      let token: string | null = null;
      const native = bridge();
      if (native) {
        let destination: unknown;
        try { destination = await native.chooseDestination({ suggestedName: `${fileSafe(flow.project.name)}${PROJECT_FILE_EXTENSION}` }); }
        catch { destination = null; }
        if (!isProjectPackageDestination(destination)) { update('export', id, item => item.view.step === 'options' ? { view: { ...item.view, choosing: false } } : {}); return; }
        token = destination.token;
      }
      if (!current('export', id)) return;
      try {
        const status = await client.startExport(flow.project.id, media);
        if (!update('export', id, () => ({ view: { step: 'running', status } }))) { quietly(client.discardExport(status.id)); return; }
        poll(id, status.id, token);
      } catch (error) {
        const failure = failureOf(error), missing = missingOf(failure);
        update('export', id, item => item.view.step !== 'options' ? {} : missing.length && item.view.preview
          ? { view: { ...item.view, choosing: false, preview: { ...item.view.preview, missing } } }
          : { view: { ...item.view, choosing: false, error: failure } });
      }
    },
    async cancelExport(): Promise<void> {
      const flow = state.flow; if (!flow || flow.kind !== 'export') return;
      if (flow.view.step === 'running') { const exportId = flow.view.status.id; set({ flow: null }); quietly(client.discardExport(exportId)); return; }
      if (!isFlowRunning(flow)) dismiss();
    },
    async reveal(): Promise<void> {
      const flow = state.flow; if (!flow || flow.kind !== 'export' || flow.view.step !== 'done' || !flow.view.token) return;
      try { await bridge()?.reveal({ token: flow.view.token }); } catch { /* The saved file stays where it is; revealing is best effort. */ }
    },

    openImport(file: File): boolean {
      if (!admit()) return false;
      const id = ++serial;
      if (!isProjectFileName(file.name)) {
        set({ flow: { kind: 'import', serial: id, fileName: file.name, fileBytes: file.size, background: false, view: { step: 'failed', error: { code: 'PROJECT_PACKAGE_NOT_MIOON' } } } });
        return true;
      }
      const abort = new AbortController(); uploadAbort = abort;
      set({ flow: { kind: 'import', serial: id, fileName: file.name, fileBytes: file.size, background: false, view: { step: 'uploading', loaded: 0, total: file.size } } });
      void client.uploadImport(file, { signal: abort.signal, onProgress: (loaded, total) => { update('import', id, item => item.view.step === 'uploading' ? { view: { step: 'uploading', loaded, total } } : {}); } }).then(preview => {
        if (!update('import', id, () => ({ view: { step: 'preview', preview, name: preview.suggestedName } }))) quietly(client.discardImport(preview.id));
      }, error => {
        if (abort.signal.aborted) return;
        update('import', id, () => ({ view: { step: 'failed', error: failureOf(error) } }));
      }).finally(() => { if (uploadAbort === abort) uploadAbort = null; });
      return true;
    },
    /** Shows a file opened from the OS. Only the desktop has one to give, and a
     * running flow keeps it waiting on the server until the next check. */
    async checkOpened(): Promise<void> {
      if (checkingOpened || !bridge() || isFlowRunning(state.flow)) return;
      checkingOpened = true;
      try {
        const preview = heldOpened ?? await client.takeOpenedImport();
        heldOpened = null;
        if (!preview) return;
        // A flow started while the request was out: keep the file for the next check.
        if (isFlowRunning(state.flow)) { heldOpened = preview; return; }
        admit();
        set({ flow: { kind: 'import', serial: ++serial, fileName: `${fileSafe(preview.name)}${PROJECT_FILE_EXTENSION}`, fileBytes: preview.totalBytes, background: false, view: { step: 'preview', preview, name: preview.suggestedName } } });
      } catch { /* The next check retries; a lost preview expires on the server. */ }
      finally { checkingOpened = false; }
    },
    cancelUpload(): void {
      const flow = state.flow; if (!flow || flow.kind !== 'import' || flow.view.step !== 'uploading') return;
      uploadAbort?.abort(); uploadAbort = null; set({ flow: null });
    },
    setImportName(name: string): void {
      const flow = state.flow; if (flow?.kind === 'import' && flow.view.step === 'preview') update('import', flow.serial, item => item.view.step === 'preview' ? { view: { ...item.view, name } } : {});
    },
    confirmImport(): void {
      const flow = state.flow; if (!flow || flow.kind !== 'import' || flow.view.step !== 'preview') return;
      const name = flow.view.name.trim(); if (!name || name.length > 150) return;
      update('import', flow.serial, item => item.view.step === 'preview' ? { view: { step: 'committing', preview: item.view.preview, name } } : {});
      void commit(flow.serial, randomId());
    },

    openDuplicate(project: PackageProject, defaultName: string): boolean {
      if (!admit()) return false;
      const id = ++serial;
      set({ flow: { kind: 'duplicate', serial: id, project, background: false, view: { step: 'editing', name: defaultName.slice(0, 150), estimate: null } } });
      void client.exportPreview(project.id, 'all').then(preview => {
        update('duplicate', id, item => item.view.step === 'editing' ? { view: { ...item.view, estimate: preview.totalBytes } } : {});
      }, () => {});
      return true;
    },
    setDuplicateName(name: string): void {
      const flow = state.flow; if (flow?.kind === 'duplicate' && flow.view.step === 'editing') update('duplicate', flow.serial, item => item.view.step === 'editing' ? { view: { ...item.view, name } } : {});
    },
    async confirmDuplicate(): Promise<void> {
      const flow = state.flow; if (!flow || flow.kind !== 'duplicate' || flow.view.step !== 'editing') return;
      const name = flow.view.name.trim(), id = flow.serial; if (!name || name.length > 150) return;
      update('duplicate', id, () => ({ view: { step: 'running', name } }));
      try {
        const { projectId } = await client.duplicate({ projectId: flow.project.id, requestId: randomId(), name });
        if (!current('duplicate', id)) return;
        set({ created: state.created + 1 });
        update('duplicate', id, () => ({ view: { step: 'done', projectId, name } }));
      } catch (error) {
        const failure = failureOf(error);
        if (failure.code === 'NETWORK') set({ created: state.created + 1 });
        update('duplicate', id, () => ({ view: { step: 'failed', error: failure } }));
      }
    },

    /** Collapses a running dialog into the bottom-right notice. */
    toBackground(): void { const flow = state.flow; if (flow && isFlowRunning(flow)) set({ flow: { ...flow, background: true } as PackageFlow }); },
    /** Reopens the dialog from the notice ("查看"). */
    toForeground(): void { const flow = state.flow; if (flow?.background) set({ flow: { ...flow, background: false } as PackageFlow }); },
    dismiss,
  };
}
export type PackageFlowController = ReturnType<typeof createPackageFlow>;

let shared: PackageFlowController | null = null;
/** The application-wide instance shared by the home page and the workbench. */
export function projectPackageFlow(): PackageFlowController { return shared ??= createPackageFlow(); }

/** Decimal units, as file managers show them; unit symbols are not translated. */
export function formatPackageBytes(bytes: number, formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1 })} ${units[unit]}`;
}
/** Percent for a progress bar, or null when no total is known yet. */
export function flowPercent(flow: PackageFlow): number | null {
  if (flow.kind === 'export' && (flow.view.step === 'running' || flow.view.step === 'saving')) {
    const view = flow.view;
    if (view.step === 'saving') return 100;
    const { bytes, totalBytes, files, totalFiles } = view.status;
    if (view.status.stage === 'verifying') return 99;
    return totalBytes > 0 ? Math.min(99, Math.floor(bytes / totalBytes * 100)) : totalFiles > 0 ? Math.min(99, Math.floor(files / totalFiles * 100)) : 0;
  }
  const view = flow.view;
  if (view.step === 'uploading') return view.total > 0 ? Math.min(100, Math.floor(view.loaded / view.total * 100)) : 0;
  return null;
}
