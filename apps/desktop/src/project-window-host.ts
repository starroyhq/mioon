import { randomUUID } from 'node:crypto';
import {projectEntryWindowSchema,projectEntryWindowRevokedSchema} from '../../../packages/contracts/src/project-entry-native.ts';
import type {ProjectEntryControlPort,ProjectEntryWindow} from '../../../packages/contracts/src/project-entry-native.ts';
import { PROJECT_WINDOW_EVENT, isProjectWindowId, isProjectWindowRequest, isProjectWindowSettingsSlot, isProjectWindowEntryMode, projectWindowOpenFailure } from './project-window-protocol.ts';
import type { ProjectWindowContext, ProjectWindowEntryMode, ProjectWindowEntryReceipt, ProjectWindowOpenResult, ProjectWindowRole, ProjectWindowSettingsSlot, ProjectWindowPhase, ProjectWindowLocatorStatus, ProjectWindowLocatorIntent, ProjectWindowOpenFailure } from './project-window-protocol.ts';
import type { SettingsDiagnosticRequest, SettingsOpenPhase } from './settings-diagnostics-protocol.ts';
import type { SettingsOpeningDiagnostics } from './settings-opening-diagnostics.ts';

type Listener = (...args: unknown[]) => void;
interface EventSource { on(event: string, listener: Listener): unknown; removeListener(event: string, listener: Listener): unknown }
export interface ProjectWindowFrame { readonly url: string }
export interface ProjectWindowWebContents extends EventSource {
  readonly mainFrame: ProjectWindowFrame;
  getURL(): string;
  send(channel: string, context: ProjectWindowContext): void;
}
export interface ProjectNativeWindow extends EventSource {
  readonly webContents: ProjectWindowWebContents;
  isDestroyed(): boolean; isMinimized(): boolean;
  restore(): void; show(): void; showInactive(): void; hide(): void; focus(): void; close(): void;
  loadURL(url: string): Promise<unknown>;
}
export interface ProjectWindowCreation<W extends ProjectNativeWindow = ProjectNativeWindow> {
  readonly role: ProjectWindowRole;
  readonly windowId: string;
  readonly contextId: string;
  readonly backendId: string;
  readonly projectId: string | null;
  readonly autoOpen: boolean;
  readonly url: string;
  /** Main-owned modal parent only; never supplied through the renderer bridge. */
  readonly parent?: W;
}
/** Stable native lifetime used by P0. contextId is its current document, not a
 * captured authority: use ownerForContents() for asynchronous document work. */
export interface ProjectWindowOwner<W extends ProjectNativeWindow> {
  readonly window: W; readonly role: ProjectWindowRole; readonly url: string;
  readonly windowId: string; readonly backendId: string; readonly projectId: string | null; readonly contextId: string;
  isCurrent(): boolean;
}
/** An immutable snapshot of the exact committed main-frame document. */
export interface ProjectWindowDocumentOwner<W extends ProjectNativeWindow> extends ProjectWindowOwner<W> {
  readonly frame: ProjectWindowFrame;
}
export interface ProjectWindowHostOptions<W extends ProjectNativeWindow> {
  readonly backendId: string; readonly launcherUrl: string; readonly settingsUrl?: string;
  readonly autoOpenLauncher?: boolean;
  /** Trusted main may reopen windows before the new renderers admit actions. */
  rendererPaused?(): boolean;
  editorUrl(projectId: string): string;
  isCurrent(): boolean; canInteract(): boolean;
  createWindow(context: ProjectWindowCreation<W>): W;
  prepareWindow?(window: W, owner: ProjectWindowOwner<W>): void;
  /** Install only the passive shell policy, returning its retirement hook. */
  prepareWarmSettings?(window: W, url: string): () => void;
  discardWarmSettings?(window: W): void;
  warmSettingsMatches?(window: W): boolean;
  settingsDiagnostics?: SettingsOpeningDiagnostics<W>;
  settingsBootAckTimeoutMs?: number;
  /** Main may withhold explicit focus restoration after the user switches to
   * another app while an asynchronous settings close is being admitted. */
  canRestoreParentFocus?(parent: W): boolean;
  onLoadError?(error: unknown, window: W, owner: ProjectWindowOwner<W>): void;
  /** Requests P0 close for the exact, still-hidden initial editor. */
  closeCandidate?(window: W, cause: CandidateCloseCause): void;
  /** Resource invalidation is not renderer destruction or release evidence. */
  onDocumentInvalidated?(owner: ProjectWindowDocumentOwner<W>): void;
  /** Only the exact WebContents destroyed event establishes this fact. */
  onWebContentsDestroyed?(windowId: string): void;
  /** Fixed renderer entry-admission hook. Absence/invalid response denies. */
  consumeProjectEntry?(owner: ProjectWindowDocumentOwner<W>, entryToken: string, projectId: string): unknown | Promise<unknown>;
  /** Main retains these action tokens across backend/window-host replacement. */
  readonly projectActionReservations?: Map<string, object>;
  /** Main-owned utility port. Editors are never created without a window lease. */
  readonly projectEntries?: Pick<ProjectEntryControlPort,'openPath'|'acquire'|'release'|'onWindowRevoked'|'markOpened'>;
  /** Main checks the registered physical path/volume before renderer UUID open. */
  admitProject?(owner:ProjectWindowDocumentOwner<W>,projectId:string):Promise<string>;
}
export interface ProjectWindowIPCEvent { readonly sender: ProjectWindowWebContents; readonly senderFrame: ProjectWindowFrame | null }
interface EntryAttempt {
  readonly contextId: string; readonly entryToken: string; readonly projectId: string; readonly remember: boolean;
  readonly promise: Promise<ProjectWindowOpenResult>; readonly complete: (result: ProjectWindowOpenResult) => void;
  result: ProjectWindowOpenResult | null;
}
type EditorPhase = Exclude<ProjectWindowPhase, 'none'>;
type CandidateCloseCause = 'cancel' | 'load' | 'renderer' | 'gone' | 'owner';
export const PROJECT_OPEN_PENDING_MS = 10_000;
interface CandidateSource<W extends ProjectNativeWindow> {
  readonly record: WindowRecord<W>;
  readonly contextId: string;
  readonly entryToken: string;
  readonly attempt?: EntryAttempt;
  readonly kind?: 'selected';
}
interface CandidateOrigin<W extends ProjectNativeWindow> {
  readonly window: W;
  readonly contextId: string;
  isCurrent(): boolean;
}
interface CandidateAdmission<W extends ProjectNativeWindow> {
  readonly source?: CandidateSource<W>;
  readonly isCurrent: () => boolean;
}
interface PendingCandidateClose {
  readonly cause: CandidateCloseCause;
  readonly outcome: ProjectWindowOpenResult;
  inFlight?: CandidateCloseCause;
  readyContextId?: string;
  retried?: true;
}
interface PendingEditor<W extends ProjectNativeWindow> extends CandidateAdmission<W> {
  readonly promise: Promise<ProjectWindowOpenResult>;
  readonly complete: (result: ProjectWindowOpenResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  prompted: boolean;
  close?: PendingCandidateClose;
}
interface WindowLease {readonly windowId:string;projectId:string|null;projectFile?:string;released:boolean;revoked:boolean}
interface WindowRecord<W extends ProjectNativeWindow> {
  readonly window: W; readonly contents: ProjectWindowWebContents; readonly windowId: string; readonly role: ProjectWindowRole; readonly projectId: string | null; readonly url: string;
  readonly parent: WindowRecord<W> | null;
  contextId: string; autoOpen: boolean; closed: boolean; committed: boolean; phase: EditorPhase;
  retainedPhase: Exclude<EditorPhase, 'closing'>; frame: ProjectWindowFrame | null;
  revealIntent: number; revealFence: number; readyToShow: boolean; focusOrder: number;
  entryMode: ProjectWindowEntryMode | null; entryVersion: number; entryReceipt: ProjectWindowEntryReceipt | null; entryAttempt: EntryAttempt | null;
  settingsSlot: ProjectWindowSettingsSlot | null; settingsVersion: number;
  settingsLoadTimes?: Partial<Record<SettingsOpenPhase, number>>;
  settingsBoot?: 'reloading' | 'started' | 'done';
  settingsBootTimer?: ReturnType<typeof setTimeout>;
  initialLoad: { contextId: string; started: boolean; frame: ProjectWindowFrame | null };
  load: Promise<void>; owner: ProjectWindowOwner<W>;
  listeners: Array<{ target: EventSource; event: string; listener: Listener }>;
  pending: PendingEditor<W> | null;
  markedOpenedContext?: string;
  readonly lease:WindowLease|null;
}
const refused = (reason: 'busy' | 'unavailable' | 'cancelled', failure?: ProjectWindowOpenFailure): ProjectWindowOpenResult =>
  Object.freeze({ ok: false, reason, targetWindowId: null, targetPhase: null, ...(reason === 'unavailable' && failure ? {failure} : {}) });
function consumed(value: unknown, entryToken: string, projectId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 4 && ['version', 'entryToken', 'projectId', 'accepted'].every(key => Object.hasOwn(result, key)) &&
    result.version === 1 && result.entryToken === entryToken && result.projectId === projectId && result.accepted === true;
}

/** One backend, one launcher, one settings owner, one immutable editor per
 * project. A destroyed handle still owns its slot until actual `closed`. */
export function createProjectWindowHost<W extends ProjectNativeWindow>(options: ProjectWindowHostOptions<W>) {
  if (!isProjectWindowId(options.backendId)) throw new Error('Invalid project-window backend identity');
  let launcher: WindowRecord<W> | null = null, settings: WindowRecord<W> | null = null;
  const editors = new Map<string, WindowRecord<W>>(), reservations = new Set<string>();
  const projectActions = options.projectActionReservations ?? new Map<string, object>();
  const records = new Map<W, WindowRecord<W>>(), contentsRecords = new Map<ProjectWindowWebContents, WindowRecord<W>>();
  const leases=new Map<string,WindowLease>(),retiredLeases=new Set<string>(),revokedLeases=new Set<string>();
  let projectEntries=options.projectEntries??null,unsubscribeLeases:(()=>void)|null=null;
  if(projectEntries&&(['openPath','acquire','release','onWindowRevoked'] as const).some(key=>typeof projectEntries?.[key]!=='function'))projectEntries=null;
  const hiddenForTray = new WeakSet<WindowRecord<W>>();
  const nativeDialogPresentation = new WeakSet<WindowRecord<W>>();
  const nativeDialogOwners=new Map<WindowRecord<W>,string>();
  let disposed = false, launcherCreated = false, trayHidden = false, trayHideEpoch = 0, intent = 0, focusOrder = 0, fence = 0, wasPermitted = options.canInteract();
  let locatorStatus: ProjectWindowLocatorStatus | null = null, locatorIntent: ProjectWindowLocatorIntent | null = null;
  let locatorContextId: string | null = null, locatorIntentVersion = 0;
  let selectionVersion = 0, selectionRecord: WindowRecord<W> | null = null, selectionContextId: string | null = null;
  // This record stays outside both owner maps and the modal slot until the
  // exact parent requests it. Native dispatch never sees a dormant shell.
  let warmSettings: {record: WindowRecord<W>; parent: ProjectWindowDocumentOwner<W>; release: () => void; loaded: boolean} | null = null;
  const lifetime = () => !disposed && options.isCurrent();
  const diagnostics = options.settingsDiagnostics;
  function settingsPhase(record: WindowRecord<W>, phase: SettingsOpenPhase, at = Date.now()): void {
    if (record.role !== 'settings') return;
    if (record.settingsLoadTimes) record.settingsLoadTimes[phase] ??= at;
    diagnostics?.phase(record.window, phase, at);
  }
  function retireWarmSettings(): void {
    const warm = warmSettings;
    if (!warm) return;
    warmSettings = null;
    for (const entry of warm.record.listeners) entry.target.removeListener(entry.event, entry.listener);
    try { options.discardWarmSettings?.(warm.record.window); }
    catch { /* A dormant window can already be closing in Electron. */ }
    finally { warm.release(); }
  }
  function releaseLease(lease:WindowLease):void{
    if(lease.released)return;lease.released=true;retiredLeases.add(lease.windowId);if(leases.get(lease.windowId)===lease)leases.delete(lease.windowId);
    try{void Promise.resolve(projectEntries?.release({windowId:lease.windowId})).catch(()=>{});}catch{/* The utility lifetime also retires its owned leases. */}
  }
  function candidate(projectId:string|null=null,projectFile?:string):WindowLease{
    const lease={windowId:randomUUID(),projectId,...(projectFile?{projectFile}:{}),released:false,revoked:false};leases.set(lease.windowId,lease);return lease;
  }
  const editorCount = () => editors.size + reservations.size;
  const hasOpenEditor = () => [...editors.values()].some(record => record.pending === null);
  function permitted() {
    const allowed = lifetime() && options.canInteract();
    const invalidating = wasPermitted && !allowed;
    wasPermitted = allowed;
    if (invalidating) {
      fence++; intent++;
      retireWarmSettings();
      for (const record of records.values()) invalidateDocument(record);
    }
    return allowed;
  }
  const ownsRecord = (record: WindowRecord<W>) => lifetime() && !record.closed && !record.window.isDestroyed() && records.get(record.window) === record &&
    (record.role === 'launcher' ? launcher === record : record.role === 'settings' ? settings === record : editors.get(record.projectId!) === record);
  const isClosing=(record:WindowRecord<W>)=>record.phase==='closing';
  // Actual closed, rather than a close request or a renderer failure, releases
  // the parent. A vetoed settings close must keep both native and DOM modality.
  const modalFor = (record: WindowRecord<W>) => lifetime() && settings?.parent === record &&
    !settings.closed && records.get(settings.window) === settings ? settings : null;
  function currentUrl(record: WindowRecord<W>): string | null { try { return record.contents.getURL(); } catch { return null; } }
  function trustedDocument(record: WindowRecord<W>): boolean {
    try { return ownsRecord(record) && record.committed && record.frame === record.contents.mainFrame &&
      record.frame?.url === record.url && currentUrl(record) === record.url; } catch { return false; }
  }
  function selectedProject(): string | null {
    return selectionRecord && selectionRecord.contextId === selectionContextId && selectionRecord.phase === 'ready' && trustedDocument(selectionRecord)
      ? selectionRecord.projectId : null;
  }
  function hasCandidateSource(pending: PendingEditor<W>, record: WindowRecord<W>): boolean {
    const source = pending.source;
    return source?.record === record && source.contextId === record.contextId && (!source.attempt || source.attempt === record.entryAttempt);
  }
  function candidateFor(source: WindowRecord<W>): WindowRecord<W> | undefined {
    return [...editors.values()].find(target => target.pending && hasCandidateSource(target.pending, source));
  }
  function context(record: WindowRecord<W>): ProjectWindowContext {
    const target = candidateFor(record), pending = target?.pending;
    const source = pending?.prompted && pending.source;
    return { version: 2, role: record.role, windowId: record.windowId, contextId: record.contextId, backendId: options.backendId,
      initialProjectId: record.projectId, autoOpen: record.autoOpen, editorProjectId: record.projectId,
      editorPhase: record.role === 'editor' ? record.phase : 'none', editorCount: editorCount(),
      leaseRevoked:record.lease?.revoked===true,
      entryMode: record.entryMode, entryVersion: record.entryVersion, entryReceipt: record.entryReceipt,
      ...(source && target?.projectId ? {entryPending: {entryToken: source.entryToken, projectId: source.attempt?.projectId ?? target.projectId,
        ...(source.kind ? {kind: source.kind} : {})}} : {}),
      settingsSlot: record.settingsSlot, settingsVersion: record.settingsVersion,
      settingsModalOpen: Boolean(modalFor(record)),
      selectionProjectId: record.role === 'launcher' ? selectedProject() : null,
      selectionVersion: record.role === 'launcher' ? selectionVersion : 0,
      locatorStatus: launcher && locatorContextId === launcher.contextId && trustedDocument(launcher) ? locatorStatus : null,
      locatorIntent: record.role === 'launcher' && locatorContextId === record.contextId ? locatorIntent : null,
      quitting: !permitted() || options.rendererPaused?.() === true };
  }
  function refresh() {
    permitted();
    if (warmSettings && !warmSettings.parent.isCurrent()) retireWarmSettings();
    for (const record of records.values()) sendContext(record);
  }
  function sendContext(record: WindowRecord<W>): void {
    if (!trustedDocument(record)) return;
    try { record.contents.send(PROJECT_WINDOW_EVENT, context(record)); }
    catch { /* The next owned document will receive its own state. */ }
  }
  function capture(record: WindowRecord<W>): ProjectWindowDocumentOwner<W> | null {
    if (!trustedDocument(record) || !record.frame || record.lease?.revoked) return null;
    const contextId = record.contextId, frame = record.frame;
    return Object.freeze({ window: record.window, windowId: record.windowId, role: record.role, backendId: options.backendId,
      projectId: record.projectId, url: record.url, contextId, frame,
      isCurrent: () => !record.lease?.revoked && record.contextId === contextId && record.frame === frame && trustedDocument(record) });
  }
  function invalidateDocument(record: WindowRecord<W>) {
    const owner = capture(record);
    if (owner) { try { options.onDocumentInvalidated?.(owner); } catch { /* Failed retirement cannot authorize new resources. */ } }
  }
  function retireLocator(record: WindowRecord<W>) {
    if (record.role !== 'launcher') return;
    locatorStatus = null; locatorIntent = null; locatorContextId = null;
    selectionRecord = null; selectionContextId = null;
  }
  function reveal(record: WindowRecord<W>, focus = true): boolean {
    if (!permitted() || trayHidden || hiddenForTray.has(record) || !ownsRecord(record) || record.pending ||
      record.revealFence !== fence || record.phase === 'closing' || record.role === 'launcher' && hasOpenEditor()) return false;
    const modal = modalFor(record);
    if (modal) return focus ? reveal(modal) : false;
    if (record.role === 'settings' && record.parent && !ownsRecord(record.parent)) return false;
    if (record.role === 'editor' && launcher && !nativeDialogPresentation.has(launcher)) hideLauncher();
    // A sheet attached to a minimized parent is not visible. Only an explicit
    // settings reveal may restore that parent; late readiness must not bring it
    // back over another project's newer foreground window.
    if (focus && record.role === 'settings' && record.parent?.window.isMinimized()) record.parent.window.restore();
    if (focus && record.window.isMinimized()) record.window.restore();
    settingsPhase(record, 'showRequested');
    // macOS attaches a modal sheet in show(), not showInactive(). A settings
    // load that finishes after another editor gained focus still needs its
    // native parent binding, without explicitly taking the newer focus.
    if (focus || record.role === 'settings') record.window.show();
    else record.window.showInactive();
    settingsPhase(record, 'showReturned');
    if (focus) { record.window.focus(); record.focusOrder = ++focusOrder; }
    return true;
  }
  function hideLauncher() {
    if (launcher && ownsRecord(launcher)) {
      invalidateWarmSettings(launcher.window);
      launcher.window.hide();
    }
  }
  function allowExplicitReveal(record: WindowRecord<W>) {
    trayHidden = false;
    hiddenForTray.delete(record);
    const modal = modalFor(record);
    if (modal) hiddenForTray.delete(modal);
    if (record.role === 'settings' && record.parent) hiddenForTray.delete(record.parent);
  }
  function canRestoreParentFocus(parent: W): boolean {
    if (!options.canRestoreParentFocus) return true;
    try { return options.canRestoreParentFocus(parent) === true; }
    catch { return false; }
  }
  function listen(record: WindowRecord<W>, target: EventSource, event: string, listener: Listener) {
    target.on(event, listener); record.listeners.push({ target, event, listener });
  }
  function revokeSelection(record: WindowRecord<W>) {
    if (selectionRecord === record) { selectionRecord = null; selectionContextId = null; }
  }
  function completeCandidate(record: WindowRecord<W>, pending: PendingEditor<W>, result: ProjectWindowOpenResult): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    record.pending = null;
    pending.complete(result);
  }
  function requestCandidateClose(record: WindowRecord<W>, cause: CandidateCloseCause, result: ProjectWindowOpenResult): boolean {
    const pending = record.pending;
    if (!pending || !ownsRecord(record)) return false;
    // Seal the outcome before calling close, which can reenter the host. The
    // lease and receipt remain held until the native closed event.
    const close = pending.close ??= {cause, outcome: result};
    if (close.inFlight && (cause !== 'gone' || close.inFlight === 'gone')) return false;
    close.inFlight = cause;
    try {
      if (options.closeCandidate) options.closeCandidate(record.window, cause);
      else record.window.close();
      return true;
    } catch {
      close.inFlight = undefined;
      return false;
    }
  }
  function retryCandidateCloseAfterReady(record: WindowRecord<W>, pending: PendingEditor<W>, close: PendingCandidateClose): void {
    if (close.inFlight || close.retried || close.readyContextId !== record.contextId) return;
    close.retried = true;
    // Let the original P0 cancellation and its callbacks finish first.
    queueMicrotask(() => {
      if (record.pending === pending && record.contextId === close.readyContextId && !isClosing(record))
        requestCandidateClose(record, close.cause, close.outcome);
    });
  }
  function retireCandidateFor(source: WindowRecord<W>): void {
    const target = candidateFor(source);
    if (target) requestCandidateClose(target, 'owner', refused('busy'));
  }
  function markEditorOpened(record: WindowRecord<W>): void {
    if (!projectEntries?.markOpened || record.markedOpenedContext === record.contextId || !permitted() || options.rendererPaused?.()) return;
    record.markedOpenedContext = record.contextId;
    // Auxiliary recency maintenance cannot block a ready editor.
    try {
      void Promise.resolve(projectEntries.markOpened({windowId: record.windowId, contextId: record.contextId})).catch(() => {});
    } catch { /* The window retains its accepted ready state. */ }
  }
  function readyCandidate(record: WindowRecord<W>, pending: PendingEditor<W>): boolean {
    if (pending.close) {
      // Initialization can change the scope that the first P0 close inspected.
      // The exact document becoming ready may justify one fresh inspection.
      pending.close.readyContextId = record.contextId;
      retryCandidateCloseAfterReady(record, pending, pending.close);
      return false;
    }
    if (!pending.isCurrent()) {
      requestCandidateClose(record, 'owner', refused('busy'));
      return false;
    }
    record.phase = 'ready';
    completeCandidate(record, pending, Object.freeze({ok: true, reason: 'accepted', targetWindowId: record.windowId, targetPhase: 'ready'}));
    markEditorOpened(record);
    reveal(record, record.revealIntent === intent);
    refresh();
    return true;
  }
  function create(role: ProjectWindowRole, projectId: string | null, revealIntent = intent, parent: WindowRecord<W> | null = null, keepHidden = false, lease:WindowLease|null=null, pending: PendingEditor<W> | null = null, warmParent?: ProjectWindowDocumentOwner<W>): WindowRecord<W> | null {
    if (!permitted()) return null;
    if (role === 'settings' && (!parent || parent.role === 'settings' || !trustedDocument(parent) || parent.phase === 'closing')) return null;
    if (role === 'editor') {
      if (!projectId || !lease || lease.released || lease.revoked || lease.projectId!==projectId || editors.has(projectId) || reservations.has(projectId) || projectActions.has(projectId)) return null;
      reservations.add(projectId); if (!pending) hideLauncher();
    }
    let url:string;
    try{url=role==='editor'?options.editorUrl(projectId!):role==='settings'?options.settingsUrl??options.launcherUrl:options.launcherUrl;}
    catch(error){if(projectId)reservations.delete(projectId);throw error;}
    const windowId = lease?.windowId??randomUUID(), contextId = randomUUID();
    const autoOpen = role === 'launcher' && !launcherCreated && options.autoOpenLauncher !== false;
    const createStarted = role === 'settings' ? Date.now() : undefined;
    let window: W, contents: ProjectWindowWebContents;
    try {
      window = options.createWindow({ role, windowId, contextId, backendId: options.backendId, projectId, autoOpen, url, ...(parent ? {parent: parent.window} : {}) });
      // BrowserWindow.webContents is a native getter and may throw at closed.
      contents = window.webContents;
    }
    catch (error) {
      if (projectId) reservations.delete(projectId);
      if (!pending && !hasOpenEditor() && launcher?.readyToShow) reveal(launcher);
      throw error;
    }
    let record!: WindowRecord<W>;
    const owner: ProjectWindowOwner<W> = { window, windowId, role, url, backendId: options.backendId, projectId,
      get contextId() { return record.contextId; }, isCurrent: () => ownsRecord(record) };
    const initialLoad: WindowRecord<W>['initialLoad'] = { contextId, started: false, frame: null };
    record = { window, contents, windowId, role, projectId, url, parent, contextId, autoOpen, closed: false, committed: false, phase: 'opening', retainedPhase: 'opening',
      frame: null, revealIntent, revealFence: fence, readyToShow: false, focusOrder: warmParent ? 0 : ++focusOrder,
      entryMode: null, entryVersion: 0, entryReceipt: null, entryAttempt: null, settingsSlot: null, settingsVersion: 0,
      initialLoad, load: Promise.resolve(), owner, listeners: [], lease, pending };
    if (createStarted !== undefined) record.settingsLoadTimes = {createStarted, created: Date.now()};
    const isWarm = () => warmSettings?.record === record;
    const isLoadingOwner = () => ownsRecord(record) || isWarm() && lifetime() && !window.isDestroyed();
    if (warmParent) {
      try { warmSettings = {record, parent: warmParent, release: options.prepareWarmSettings!(window, url), loaded: false}; }
      catch (error) { options.discardWarmSettings!(window); throw error; }
      const retire = () => { if (isWarm()) retireWarmSettings(); };
      listen(record, contents, 'render-process-gone', retire);
      listen(record, window, 'unresponsive', retire);
    } else {
      records.set(window, record); contentsRecords.set(contents, record);
      if (trayHidden || keepHidden) hiddenForTray.add(record);
      if (role === 'launcher') { launcher = record; launcherCreated = true; }
      else if (role === 'settings') settings = record;
      else { editors.set(projectId!, record); reservations.delete(projectId!); }
    }
    listen(record, window, 'closed', () => {
      if (record.closed) return;
      if (isWarm()) { retireWarmSettings(); return; }
      clearTimeout(record.settingsBootTimer);
      if (role === 'settings') diagnostics?.close(window);
      const attached = modalFor(record);
      const restoreParentFocus = role === 'settings' && parent &&
        ![...records.values()].some(other => other !== record && !other.closed && other.focusOrder > record.focusOrder);
      const pending = record.pending;
      record.closed = true; revokeSelection(record); retireLocator(record);
      if(lease)releaseLease(lease);
      nativeDialogPresentation.delete(record);
      nativeDialogOwners.delete(record);
      records.delete(window); contentsRecords.delete(contents);
      for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      if (launcher === record) launcher = null;
      if (settings === record) settings = null;
      if (role === 'editor' && editors.get(projectId!) === record) {
        editors.delete(projectId!);
        if (pending) completeCandidate(record, pending, pending.close?.outcome ?? refused('cancelled'));
        // Retire only at actual closure; settings and minimizing are irrelevant.
        if (!hasOpenEditor() && (!pending || !launcher && !pending.source) && permitted())
          revealLauncher(hiddenForTray.has(record));
      }
      retireCandidateFor(record);
      // Normal close/restart paths close the settings owner first. If a parent
      // disappears unexpectedly, request its child's existing guarded closure;
      // never destroy its document or transfer it to another project's parent.
      if (attached && !attached.window.isDestroyed()) attached.window.close();
      refresh();
      if (restoreParentFocus && parent && ownsRecord(parent) && canRestoreParentFocus(parent.window)) reveal(parent);
    });
    // Keep this one listener through BrowserWindow.closed and host disposal:
    // only actual contents destruction proves every old document is gone.
    const destroyed = () => {
      contents.removeListener('destroyed', destroyed);
      try { options.onWebContentsDestroyed?.(windowId); } catch { /* Observation is never a new resource grant. */ }
    };
    contents.on('destroyed', destroyed);
    listen(record, window, 'show', () => {
      if (ownsRecord(record)) settingsPhase(record, 'show');
      if (ownsRecord(record) && (record.pending || role === 'launcher' && hasOpenEditor() && !nativeDialogPresentation.has(record))) window.hide();
    });
    listen(record, window, 'focus', () => { if (ownsRecord(record)) record.focusOrder = ++focusOrder; });
    listen(record, window, 'ready-to-show', () => {
      if (!isLoadingOwner()) return;
      record.readyToShow = true;
      settingsPhase(record, 'readyToShow');
      if (isWarm()) return;
      if (role === 'launcher') { if (record.revealIntent === intent) reveal(record); }
      else reveal(record, record.revealIntent === intent);
    });
    listen(record, contents, 'did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const value = details && typeof details === 'object' ? details as Record<string, unknown> : null;
      const mainFrame = value && 'isMainFrame' in value ? value.isMainFrame : legacyMainFrame;
      const sameDocument = value && 'isSameDocument' in value ? value.isSameDocument : legacyInPlace;
      if (mainFrame === false || sameDocument === true || !isLoadingOwner()) return;
      const target = value && 'url' in value ? value.url : legacyUrl;
      // The assigned-navigation policy rejects every other destination. Electron
      // emits this event before that rejection; retiring the still-live document
      // here would strand its renderer and close guard. A foreign commit remains
      // untrusted through the exact URL and main-frame checks below.
      if (target !== record.url) return;
      retireNativeDialogPresentation(record);
      const previousContext = record.contextId;
      const firstAssignedLoad = !initialLoad.started && initialLoad.contextId === previousContext && target === url;
      if (isWarm() && !firstAssignedLoad) { retireWarmSettings(); return; }
      diagnostics?.resetDocument(window);
      if (role === 'settings') {
        clearTimeout(record.settingsBootTimer);
        record.settingsBoot = undefined;
      }
      invalidateDocument(record); retireLocator(record);
      retireCandidateFor(record);
      record.committed = false; record.frame = null; record.contextId = randomUUID();
      record.entryAttempt = null; record.entryReceipt = null;
      if (firstAssignedLoad) {
        initialLoad.started = true; initialLoad.contextId = record.contextId;
        if (selectionRecord === record && selectionContextId === previousContext) selectionContextId = record.contextId;
      } else revokeSelection(record);
      record.phase = record.lease?.revoked?'failed':'opening';
      if (!isWarm()) refresh();
      if (!firstAssignedLoad && record.pending) requestCandidateClose(record, 'owner', refused('busy'));
    });
    listen(record, contents, 'did-navigate', () => {
      if (!isLoadingOwner()) return;
      record.committed = currentUrl(record) === record.url;
      record.frame = record.committed ? contents.mainFrame : null;
      if (initialLoad.contextId === record.contextId) initialLoad.frame = record.frame;
      if (!isWarm()) refresh();
    });
    if (role === 'settings') listen(record, contents, 'did-finish-load', () => {
      // The static settings page has subscribed by this point. Reloads also
      // need an activation event after their new document is committed.
      settingsPhase(record, 'didFinishLoad');
      sendContext(record);
    });
    try { if (!warmParent) options.prepareWindow?.(window, owner); }
    catch (error) {
      // Security/P0 preparation failure cannot fall through into app loading.
      record.phase = 'failed'; revokeSelection(record);
      record.load = Promise.reject(error); void record.load.catch(() => {});
      if (record.pending) requestCandidateClose(record, 'load', refused('unavailable'));
      else {
        if (role !== 'launcher') reveal(record, record.revealIntent === intent);
        try { options.onLoadError?.(error, window, owner); } catch { /* This failed owner still retains its slot. */ }
      }
      refresh(); return record;
    }
    record.load = Promise.resolve().then(() => {
      if (!isLoadingOwner() || record.contextId !== initialLoad.contextId) return;
      return window.loadURL(url);
    }).then(() => {
      if (warmSettings?.record === record) warmSettings.loaded = true;
    }).catch(error => {
      if (isWarm()) { retireWarmSettings(); return; }
      if (!ownsRecord(record) || record.contextId !== initialLoad.contextId ||
        !record.pending && initialLoad.frame && (initialLoad.frame !== contents.mainFrame || currentUrl(record) !== url)) return;
      if (record.phase !== 'closing') record.phase = 'failed';
      revokeSelection(record); refresh();
      if (record.pending) requestCandidateClose(record, 'load', refused('unavailable'));
      else {
        if (role !== 'launcher') reveal(record, record.revealIntent === intent);
        options.onLoadError?.(error, window, owner);
      }
      throw error;
    });
    void record.load.catch(() => {});
    const source = pending?.source;
    if (pending && source) {
      pending.timer = setTimeout(() => {
        if (record.pending !== pending || candidateFor(source.record) !== record) return;
        pending.prompted = true; refresh();
      }, PROJECT_OPEN_PENDING_MS);
      pending.timer.unref?.();
    }
    refresh();
    return record;
  }
  function ensureLauncher(): W | null {
    if (!permitted() || launcher && !ownsRecord(launcher)) return null;
    return (launcher ?? create('launcher', null))?.window ?? null;
  }
  function revealLauncher(preserveTrayHidden = false): boolean {
    if (!permitted() || hasOpenEditor()) return false;
    const window = ensureLauncher();
    if (!window || !launcher) return false;
    if (preserveTrayHidden) hiddenForTray.add(launcher);
    // Closing the last explicitly restored editor returns to the retained list.
    // Only a still-hidden editor's closure carries its suppression forward.
    else hiddenForTray.delete(launcher);
    launcher.autoOpen = false; launcher.revealIntent = ++intent; launcher.revealFence = fence;
    if (launcher.readyToShow || trustedDocument(launcher)) reveal(launcher);
    refresh(); return true;
  }
  function preferredRecord(focused?: W | null, role?: ProjectWindowRole): WindowRecord<W> | null {
    const isPresentable = (record: WindowRecord<W>) => ownsRecord(record) && !record.pending && !isClosing(record) &&
      (record.role !== 'launcher' || !hasOpenEditor()) && (!role || record.role === role);
    const explicit = focused ? records.get(focused) : undefined;
    if (explicit && isPresentable(explicit)) return explicit;
    return [...records.values()].filter(isPresentable)
      .sort((left, right) => right.focusOrder - left.focusOrder)[0] ?? null;
  }
  function requestProjectEntry(mode: ProjectWindowEntryMode, focused?: W | null): boolean {
    if (!isProjectWindowEntryMode(mode) || !permitted()) return false;
    const source = focused ? records.get(focused) : undefined;
    if (source?.role === 'settings' && ownsRecord(source)) { allowExplicitReveal(source); reveal(source); return false; }
    let record: WindowRecord<W> | null;
    if (hasOpenEditor()) record = preferredRecord(focused, 'editor');
    else { ensureLauncher(); record = launcher; }
    if (!record || !ownsRecord(record) || record.phase === 'closing' || record.entryAttempt && !record.entryAttempt.result || candidateFor(record)) return false;
    const modal = modalFor(record);
    if (modal) { allowExplicitReveal(modal); reveal(modal); return false; }
    allowExplicitReveal(record);
    record.autoOpen = false; record.entryMode = mode; record.entryVersion++; record.revealIntent = ++intent; record.revealFence = fence;
    if (record.readyToShow) reveal(record);
    refresh(); return true;
  }
  function activate(focused?: W | null): boolean {
    if (!permitted()) return false;
    const front = preferredRecord(focused);
    if (front?.role === 'settings') { allowExplicitReveal(front); return reveal(front); }
    if (!hasOpenEditor()) {
      if (!ensureLauncher() || !launcher) return false;
      allowExplicitReveal(launcher);
      return revealLauncher();
    }
    const record = preferredRecord(focused, 'editor');
    if (!record) return false;
    allowExplicitReveal(record);
    record.revealIntent = ++intent; record.revealFence = fence;
    if (record.readyToShow || record.phase === 'ready' || record.phase === 'failed') reveal(record);
    refresh(); return true;
  }
  function showSettings(slot: ProjectWindowSettingsSlot, focused?: W | null, receivedAt = Date.now()): boolean {
    if (!isProjectWindowSettingsSlot(slot) || !permitted() || settings && !ownsRecord(settings)) return false;
    const source = focused ? records.get(focused) : undefined;
    if (focused && (!source || !ownsRecord(source) || source.pending || isClosing(source))) return false;
    if (source?.role === 'launcher' && hasOpenEditor() || settings?.parent && !ownsRecord(settings.parent)) return false;
    let parent = settings?.parent ?? null;
    if (!settings) {
      parent = source?.role === 'settings' ? null : source ?? preferredRecord(undefined, hasOpenEditor() ? 'editor' : 'launcher');
      if (!parent || !trustedDocument(parent) || parent.phase === 'closing') return false;
    }
    intent++;
    const existing = settings;
    const promoted = existing ? null : promoteWarmSettings(parent);
    const record = existing ?? promoted ?? create('settings', null, intent, parent);
    if (!record || record.phase === 'closing') return false;
    const mode = existing ? 'existing' : promoted ? 'warm' : 'cold';
    diagnostics?.begin(record.window, source?.window, mode, receivedAt, mode === 'existing' ? {} : record.settingsLoadTimes ?? {});
    if (promoted) settingsPhase(record, 'promoted');
    allowExplicitReveal(record);
    record.settingsSlot = slot; record.settingsVersion++; record.revealIntent = intent; record.revealFence = fence;
    if (promoted && options.settingsBootAckTimeoutMs !== undefined) watchWarmActivation(record, options.settingsBootAckTimeoutMs);
    // Tell the child to start loading before AppKit presents its painted shell.
    if (record.readyToShow) { sendContext(record); reveal(record); }
    refresh();
    return true;
  }
  function watchWarmActivation(record: WindowRecord<W>, timeout: number): void {
    const owner = capture(record);
    if (!owner) return;
    record.settingsBootTimer = setTimeout(() => {
      record.settingsBootTimer = undefined;
      if (!owner.isCurrent() || !permitted() || isClosing(record) || record.settingsBoot) return;
      // The boot document cannot start importing the app without our ACK.
      // Reload only this exact idle shell. Keep its native modal and owner slot.
      record.settingsBoot = 'reloading';
      settingsPhase(record, 'warmFallback');
      let expectedContextId = owner.contextId;
      const stop = () => record.contents.removeListener('did-start-navigation', started);
      const started: Listener = (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
        const value = details && typeof details === 'object' ? details as Record<string, unknown> : null;
        const mainFrame = value && 'isMainFrame' in value ? value.isMainFrame : legacyMainFrame;
        const sameDocument = value && 'isSameDocument' in value ? value.isSameDocument : legacyInPlace;
        const target = value && 'url' in value ? value.url : legacyUrl;
        if (mainFrame === false || sameDocument === true || target !== record.url) return;
        // The host's navigation listener runs first and rotates the document ID.
        expectedContextId = record.contextId;
        stop();
      };
      const failed = (error: unknown) => {
        stop();
        if (error && typeof error === 'object' &&
          (('code' in error && error.code === 'ERR_ABORTED') || ('errno' in error && error.errno === -3))) return;
        if (!ownsRecord(record) || !permitted() || isClosing(record) || record.contextId !== expectedContextId) return;
        const url = currentUrl(record);
        if (url !== record.url && url !== '' && url !== 'about:blank') return;
        options.onLoadError?.(error, record.window, record.owner);
      };
      record.contents.on('did-start-navigation', started);
      try { void record.window.loadURL(record.url).then(stop, failed); }
      catch (error) { failed(error); }
    }, timeout);
    record.settingsBootTimer.unref?.();
  }

  function recordSettingsDiagnostic(event: ProjectWindowIPCEvent, request: SettingsDiagnosticRequest): boolean {
    const record = contentsRecords.get(event.sender);
    if (!record || !trustedDocument(record) || event.senderFrame !== record.frame || event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== record.url || !permitted() || options.rendererPaused?.() || isClosing(record)) return false;
    if (request.kind === 'click') {
      if (record.role === 'settings' || record.pending || trayHidden || hiddenForTray.has(record)) return false;
      diagnostics?.click(record.window, request);
      return true;
    }
    if (record.role !== 'settings' || !record.settingsSlot) return false;
    if (request.kind === 'read') {
      if (record.settingsBoot !== 'started' && record.settingsBoot !== 'done') return false;
      diagnostics?.read(record.window, request);
      return true;
    }
    if (request.phase === 'start') {
      if (record.settingsBoot) return false;
      record.settingsBoot = 'started';
      clearTimeout(record.settingsBootTimer);
    } else if (request.phase !== 'import') {
      if (record.settingsBoot !== 'started') return false;
      record.settingsBoot = 'done';
    } else if (record.settingsBoot !== 'started') return false;
    diagnostics?.boot(record.window, request.phase, request.at);
    return true;
  }
  function prewarmSettings(window: W): void {
    if (!options.prepareWarmSettings || !options.discardWarmSettings || !permitted() || options.rendererPaused?.() || settings || trayHidden || nativeDialogOwners.size) return;
    const record = records.get(window);
    if (!record || record.role === 'settings' || record.pending || isClosing(record) || hiddenForTray.has(record) || window.isMinimized() ||
      record.role === 'launcher' && hasOpenEditor()) return;
    const parent = capture(record);
    if (!parent || warmSettings?.parent.contextId === parent.contextId) return;
    retireWarmSettings();
    try { create('settings', null, intent, record, false, null, null, parent); }
    catch { /* A warm window is optional. The next request can create it normally. */ }
  }
  function invalidateWarmSettings(parent: W): void {
    if (warmSettings?.parent.window === parent) retireWarmSettings();
  }
  function promoteWarmSettings(parent: WindowRecord<W> | null): WindowRecord<W> | null {
    const warm = warmSettings;
    if (!warm) return null;
    const {record} = warm;
    if (!parent || warm.parent.window !== parent.window || !warm.parent.isCurrent() || !warm.loaded || !record.readyToShow || !record.committed ||
      options.warmSettingsMatches?.(record.window) === false ||
      record.frame !== record.contents.mainFrame || currentUrl(record) !== record.url || record.window.isDestroyed()) {
      retireWarmSettings();
      return null;
    }
    try { options.prepareWindow?.(record.window, record.owner); }
    catch { retireWarmSettings(); return null; }
    warmSettings = null;
    settings = record;
    records.set(record.window, record); contentsRecords.set(record.contents, record);
    record.focusOrder = ++focusOrder;
    warm.release();
    return record;
  }
  function reserveProject(projectId: string, revealIntent: number, mayReveal: boolean, lease: WindowLease, admission?: CandidateAdmission<W>): ProjectWindowOpenResult | Promise<ProjectWindowOpenResult> {
    if (!permitted()) return refused('busy');
    if (projectActions.has(projectId)) return refused('busy');
    const existing = editors.get(projectId);
    if (existing) {
      if (!ownsRecord(existing) || existing.pending || existing.phase === 'closing') return refused('busy');
      if (mayReveal) {
        allowExplicitReveal(existing);
        existing.revealIntent = revealIntent; existing.revealFence = fence;
        if (existing.readyToShow || existing.phase === 'ready' || existing.phase === 'failed') reveal(existing, revealIntent === intent);
      }
      return Object.freeze({ ok: true, reason: 'already-open', targetWindowId: existing.windowId, targetPhase: existing.phase });
    }
    if (reservations.has(projectId)) return refused('busy');
    const pending = admission ? makePendingEditor(admission) : null;
    const record = create('editor', projectId, revealIntent, null, !mayReveal, lease, pending);
    if(record&&mayReveal)allowExplicitReveal(record);
    return record ? pending?.promise ?? Object.freeze({ ok: true, reason: 'accepted', targetWindowId: record.windowId, targetPhase: record.phase }) : refused('unavailable');
  }
  function makePendingEditor(admission: CandidateAdmission<W>): PendingEditor<W> {
    let complete!: PendingEditor<W>['complete'];
    const promise = new Promise<ProjectWindowOpenResult>(resolve => { complete = resolve; });
    return {...admission, promise, complete, prompted: false};
  }
  function nativeOpenAllowed():boolean{
    return permitted()&&!(settings&&!settings.closed)&&nativeDialogOwners.size===0;
  }
  function acceptPrepared(raw:unknown,lease:WindowLease,revealIntent:number,mayReveal:boolean,native=false,admission?:CandidateAdmission<W>):ProjectWindowOpenResult | Promise<ProjectWindowOpenResult>{
    try{
      const parsed=projectEntryWindowSchema.safeParse(raw);
      if(!parsed.success||parsed.data.windowId!==lease.windowId||lease.projectId!==null&&parsed.data.project.projectId!==lease.projectId||lease.projectFile!==undefined&&parsed.data.project.projectFile!==lease.projectFile)return refused('unavailable');
      if(!permitted()||native&&!nativeOpenAllowed()||lease.released||lease.revoked||revokedLeases.has(lease.windowId)||admission&&!admission.isCurrent())return refused('busy');
      if (admission?.source && candidateFor(admission.source.record)) return refused('busy');
      lease.projectId=parsed.data.project.projectId;
      return reserveProject(lease.projectId,revealIntent,mayReveal,lease,admission);
    }finally{
      // Only the exact newly created record may take this candidate. Reuse,
      // stale ACKs and constructor failures retire their own temporary lease.
      if(![...records.values()].some(record=>record.lease===lease&&!record.closed))releaseLease(lease);
    }
  }
  async function adoptPrepared(prepared:ProjectEntryWindow,waitForReady=false,origin?:CandidateOrigin<W>):Promise<ProjectWindowOpenResult>{
    const parsed=projectEntryWindowSchema.safeParse(prepared);
    if(!parsed.success||!projectEntries)return refused('unavailable');
    const {windowId,project}=parsed.data;
    if(retiredLeases.has(windowId))return refused('unavailable');
    const originRecord = origin ? records.get(origin.window) : undefined;
    const originCurrent = () => !origin || Boolean(originRecord && originRecord.contextId === origin.contextId &&
      originRecord.role !== 'settings' && !originRecord.pending && !isClosing(originRecord) && trustedDocument(originRecord) && origin.isCurrent());
    const held=leases.get(windowId),existing=[...records.values()].find(record=>record.lease===held&&held!==undefined);
    if(existing){
      if(existing.projectId!==project.projectId||!nativeOpenAllowed()||!originCurrent()||!ownsRecord(existing)||existing.pending||isClosing(existing))return refused('busy');
      allowExplicitReveal(existing);existing.revealIntent=++intent;existing.revealFence=fence;
      if(existing.readyToShow||existing.phase==='ready'||existing.phase==='failed')reveal(existing);
      return Object.freeze({ok:true,reason:'already-open',targetWindowId:existing.windowId,targetPhase:existing.phase});
    }
    const lease=held??{windowId,projectId:project.projectId,released:false,revoked:revokedLeases.has(windowId)};
    leases.set(windowId,lease);
    if (!originCurrent()) { releaseLease(lease); return refused('busy'); }
    const capturedFence=fence;
    const source = origin && originRecord
      ? {record: originRecord, contextId: origin.contextId, entryToken: randomUUID(), kind: 'selected' as const} : undefined;
    return acceptPrepared(parsed.data,lease,++intent,true,true,waitForReady && !options.rendererPaused?.()
      ? {source,isCurrent:()=>nativeOpenAllowed()&&fence===capturedFence&&originCurrent()} : undefined);
  }
  async function acquireNativeWindow(
    prepare: (port: NonNullable<typeof projectEntries>, windowId: string) => Promise<ProjectEntryWindow>,
    projectId: string | null = null, expectedProjectFile?: string, waitForReady = false,
  ): Promise<ProjectWindowOpenResult> {
    if(!nativeOpenAllowed())return refused('busy');
    const port=projectEntries;if(!port)return refused('unavailable');
    const lease=candidate(projectId,expectedProjectFile),capturedFence=fence,revealIntent=++intent,presentationEpoch=trayHideEpoch;
    const isCurrent = () => nativeOpenAllowed() && fence === capturedFence;
    try{
      const prepared=await prepare(port,lease.windowId);
      if(!isCurrent())return refused('busy');
      return acceptPrepared(prepared,lease,revealIntent,presentationEpoch===trayHideEpoch,true,waitForReady ? {isCurrent} : undefined);
    }finally{
      if(![...records.values()].some(record=>record.lease===lease&&!record.closed))releaseLease(lease);
    }
  }
  function openPath(projectFile:string):Promise<ProjectWindowOpenResult>{
    // Check the path before consulting the UUID window map. A copied file
    // cannot focus an editor merely by carrying the original project's UUID.
    // The restart's file queue must finish before renderer status is resumed.
    const waitForReady = options.rendererPaused?.() !== true;
    return acquireNativeWindow((port,windowId)=>port.openPath({projectFile,windowId,
      ...(waitForReady && port.markOpened ? {deferRecent:true} : {})}),null,undefined,waitForReady);
  }
  // Main supplies the ID from the previous host and the path verified by the
  // new backend. The utility fences acquisition against a subsequent move.
  function restoreProject(projectId:string,expectedProjectFile:string):Promise<ProjectWindowOpenResult>{
    return acquireNativeWindow((port,windowId)=>port.acquire({projectId,windowId,expectedProjectFile}),projectId,expectedProjectFile);
  }
  function openProject(record: WindowRecord<W>, projectId: string, remember: boolean, entryToken: string): Promise<ProjectWindowOpenResult> {
    if (record.role === 'settings' || record.pending) return Promise.resolve(refused('unavailable'));
    const previous = record.entryAttempt;
    if (previous && previous.contextId === record.contextId && previous.entryToken === entryToken) {
      return previous.projectId === projectId && previous.remember === remember ? previous.promise : Promise.resolve(refused('unavailable'));
    }
    if (previous && !previous.result || candidateFor(record)) return Promise.resolve(refused('busy'));
    const modal = modalFor(record);
    if (modal) { reveal(modal); return Promise.resolve(refused('busy')); }
    const owner = capture(record), capturedFence = fence;
    if (!owner || !permitted() || record.phase === 'closing') {
      const result = refused('busy'), promise = Promise.resolve(result);
      // A lost negative ACK must be reconcilable too. This does not overwrite
      // another in-flight token, which was rejected above without admission.
      record.entryAttempt = { contextId: record.contextId, entryToken, projectId, remember, result, promise, complete() {} };
      record.entryReceipt = Object.freeze({ entryToken, result }); refresh();
      return promise;
    }
    // Only the latest explicit selection may become a locator write. A denied
    // newer choice still revokes an older callback's selection authority.
    const revealIntent = ++intent;
    // Tray presentation is separate from the sealed business entry. An old
    // entry may still receive its original receipt, but hiding during its ACK
    // wait must not lend a later foreground window to that old selection.
    const presentationEpoch = trayHideEpoch, sourceMayReveal = !trayHidden && !hiddenForTray.has(record);
    const selectedVersion = remember ? ++selectionVersion : 0;
    if (remember) { selectionRecord = null; selectionContextId = null; }
    let complete!: EntryAttempt['complete'];
    const promise = new Promise<ProjectWindowOpenResult>(resolve => { complete = resolve; });
    const attempt: EntryAttempt = { contextId: record.contextId, entryToken, projectId, remember, promise, complete, result: null };
    record.entryAttempt = attempt; record.entryReceipt = null;
    const isCurrent = () => owner.isCurrent() && record.entryAttempt === attempt && permitted() && fence === capturedFence &&
      !isClosing(record) && !modalFor(record);
    refresh();
    void (async () => {
      let result = refused('unavailable');
      try {
        const receipt = await options.consumeProjectEntry?.(owner, entryToken, projectId);
        if (!isCurrent()) result = refused('busy');
        else if (consumed(receipt, entryToken, projectId)) {
          // A first editor may only depart the still-visible launcher whose
          // exact entry state supplied this one-use, synchronously sealed token.
          if (editorCount() === 0 && record !== launcher) result = refused('busy');
          else {
            if(typeof options.admitProject!=='function')throw new Error('Project location admission unavailable');
            const expectedProjectFile=await options.admitProject(owner,projectId.toLowerCase());
            if(typeof expectedProjectFile!=='string'||!expectedProjectFile)throw new Error('Project location admission unavailable');
            if(!isCurrent())result=refused('busy');
            else{
            const port=projectEntries;
            if(!port)throw new Error('Project window lease port unavailable');
            const lease=candidate(projectId.toLowerCase(),expectedProjectFile);
            try{
              const prepared=await port.acquire({projectId:projectId.toLowerCase(),windowId:lease.windowId,expectedProjectFile,...(port.markOpened ? {deferRecent:true} : {})});
              if(!isCurrent())result=refused('busy');
              else{
                if(launcher)launcher.autoOpen=false;
                const mayReveal=sourceMayReveal&&presentationEpoch===trayHideEpoch&&!trayHidden&&!hiddenForTray.has(record);
                result=await acceptPrepared(prepared,lease,revealIntent,mayReveal,false,{isCurrent,
                  source:{record,attempt,contextId:attempt.contextId,entryToken}});
              }
            }finally{if(![...records.values()].some(target=>target.lease===lease&&!target.closed))releaseLease(lease);}
            const target = editors.get(projectId.toLowerCase());
            if (result.ok && target?.windowId === result.targetWindowId && (result.reason === 'already-open' || target.phase === 'ready') &&
              isCurrent() && remember && selectedVersion === selectionVersion) {
              selectionRecord = target; selectionContextId = target.contextId;
            }
            }
          }
        }
      } catch (error) { result = isCurrent() ? refused('unavailable',projectWindowOpenFailure(error,projectId.toLowerCase())) : refused('busy'); }
      attempt.result = result;
      if (owner.isCurrent() && record.entryAttempt === attempt && record.contextId === attempt.contextId) {
        record.entryReceipt = Object.freeze({ entryToken, result }); refresh();
      }
      attempt.complete(result);
    })();
    return promise;
  }
  function publishLocatorStatus(record: WindowRecord<W>, status: ProjectWindowLocatorStatus): boolean {
    if (record !== launcher || !trustedDocument(record)) return false;
    if (locatorContextId === record.contextId && locatorStatus) {
      if (status.statusVersion < locatorStatus.statusVersion) return false;
      if (status.statusVersion === locatorStatus.statusVersion) {
        return (Object.keys(status) as Array<keyof ProjectWindowLocatorStatus>).every(key => status[key] === locatorStatus![key]);
      }
    }
    locatorContextId = record.contextId; locatorStatus = Object.freeze({ ...status }); locatorIntent = null;
    refresh(); return true;
  }
  function requestLocatorAction(record: WindowRecord<W>, action: 'recheck' | 'retry', expectedStatusVersion: number): boolean {
    if (record.role !== 'settings' || !permitted() || record.phase === 'closing' || !launcher || !trustedDocument(launcher) ||
      launcher.phase === 'closing' || locatorContextId !== launcher.contextId || !locatorStatus || locatorStatus.statusVersion !== expectedStatusVersion ||
      !(action === 'retry' ? locatorStatus.canRetry : locatorStatus.canRecheck)) return false;
    // One current status can authorize one original-controller operation. A
    // duplicate click observes that intent; it cannot mint another retry.
    if (locatorIntent) return locatorIntent.action === action && locatorIntent.expectedStatusVersion === expectedStatusVersion;
    locatorIntent = Object.freeze({ action, expectedStatusVersion, intentVersion: ++locatorIntentVersion });
    refresh(); return true;
  }
  function dispatch(event: ProjectWindowIPCEvent, request: unknown): ProjectWindowContext | Promise<ProjectWindowOpenResult> | boolean {
    const receivedAt = Date.now();
    if (!isProjectWindowRequest(request)) throw new Error('Rejected project-window request');
    const record = contentsRecords.get(event.sender);
    if (!record || !trustedDocument(record) || event.senderFrame !== record.frame || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== record.url)
      throw new Error('Rejected project-window sender');
    if (request.action === 'describe') return context(record);
    if (request.contextId !== record.contextId) throw new Error('Stale project-window context');
    // A presentation request queued before native hiding cannot bring the
    // document back. The tray and native menu use the host methods directly.
    if ((trayHidden || hiddenForTray.has(record)) && ['settings', 'projects', 'project-entry'].includes(request.action)) return false;
    if (request.action === 'locator-status') return publishLocatorStatus(record, request.status);
    if (request.action === 'locator-action') return requestLocatorAction(record, request.locatorAction, request.expectedStatusVersion);
    if (request.action === 'open') return openProject(record, request.projectId, request.remember, request.entryToken);
    if (request.action === 'cancel-open') {
      const candidate = candidateFor(record), pending = candidate?.pending;
      return Boolean(candidate && pending?.prompted && permitted() && !isClosing(record) && !record.lease?.revoked &&
        pending.source?.entryToken === request.entryToken &&
        requestCandidateClose(candidate, 'cancel', refused('cancelled')));
    }
    if (request.action === 'projects' || request.action === 'project-entry') return record.role !== 'settings' &&
      requestProjectEntry(request.action === 'projects' ? 'open' : request.mode, record.window);
    if (request.action === 'settings') return showSettings(request.slot, record.window, receivedAt);
    if (request.action === 'settings-close') {
      if (record.role !== 'settings' || !permitted()) return false;
      // Main's native close admission owns dirty inspection and any one-use
      // unload permit. A repeated button click cannot bypass or restart it.
      if (record.phase !== 'closing') record.window.close();
      return true;
    }
    if (record.role !== 'editor' || record.projectId !== request.projectId || record.lease?.revoked) return false;
    if (record.pending) {
      return request.phase === 'ready'
        ? (!isClosing(record) || Boolean(record.pending.close)) && readyCandidate(record, record.pending)
        : !isClosing(record) && requestCandidateClose(record, 'renderer', refused('unavailable', request.failure));
    }
    if (isClosing(record)) return false;
    record.phase = request.phase;
    if (request.phase === 'failed') revokeSelection(record);
    else markEditorOpened(record);
    refresh();
    reveal(record, record.revealIntent === intent);
    return true;
  }
  function closeStateChanged(window: W, state: 'closing' | 'retained'): boolean {
    const record = records.get(window);
    if (!record || !ownsRecord(record)) return false;
    if (state === 'closing' && record.phase !== 'closing') {
      if (warmSettings?.parent.window === window) retireWarmSettings();
      record.retainedPhase = record.phase; record.phase = 'closing'; revokeSelection(record);
    }
    if (state === 'retained') {
      if (record.phase === 'closing') record.phase = record.retainedPhase;
      const pending = record.pending;
      if (pending?.close) {
        pending.close.inFlight = undefined;
        retryCandidateCloseAfterReady(record, pending, pending.close);
      }
    }
    refresh(); return true;
  }
  function isCandidate(window: W): boolean {
    const record = records.get(window);
    return Boolean(record?.pending && ownsRecord(record));
  }
  function candidateSourceWindow(window: W): W | null {
    const target = records.get(window), pending = target?.pending, source = pending?.source?.record;
    return target && pending && source && ownsRecord(target) && trustedDocument(source) && !isClosing(source) && !source.lease?.revoked &&
      !trayHidden && !hiddenForTray.has(source) && hasCandidateSource(pending, source) ? source.window : null;
  }
  function rendererGone(window: W): boolean {
    const record = records.get(window);
    if (!record || !ownsRecord(record)) return false;
    if (record.pending) {
      requestCandidateClose(record, 'gone', refused('unavailable'));
      return true;
    }
    retireCandidateFor(record);
    record.entryAttempt = null; record.entryReceipt = null;
    return false;
  }
  function windows(): W[] { return lifetime() ? [...records.values()].filter(record => !record.closed).map(record => record.window) : []; }
  function reserveClosedProjectAction(projectId: string): {isCurrent(): boolean; release(): void} | null {
    if (!isProjectWindowId(projectId)) return null;
    projectId = projectId.toLowerCase();
    if (!permitted() || editors.has(projectId) || reservations.has(projectId) || projectActions.has(projectId)) return null;
    const token = Object.freeze({});
    projectActions.set(projectId, token);
    return Object.freeze({
      isCurrent: () => lifetime() && projectActions.get(projectId) === token,
      release() {if (projectActions.get(projectId) === token) projectActions.delete(projectId);},
    });
  }
  function canHideToTray(): boolean {
    // Native alerts and the settings sheet must remain reachable. A destroyed
    // handle still reserves its slot until its actual closed event arrives.
    return lifetime() && options.canInteract() && !trayHidden && settings === null && records.size > 0 &&
      [...records.values()].every(record => ownsRecord(record) && record.phase !== 'closing' && !nativeDialogOwners.has(record));
  }
  function hideToTray(): boolean {
    if (!permitted()) return false;
    if (!canHideToTray()) {
      if (settings && !settings.closed && !settings.window.isDestroyed()) settings.window.focus();
      return false;
    }
    // Retain document owners and all business work. Late load/ready/status or
    // last-editor-closed callbacks cannot undo an explicit request to hide.
    trayHidden = true; trayHideEpoch++;
    retireWarmSettings();
    for (const record of records.values()) if (ownsRecord(record)) { hiddenForTray.add(record); record.window.hide(); }
    return true;
  }
  function prepareNativeDialog(window: W): boolean {
    const record = records.get(window);
    if (!record || !ownsRecord(record) || record.pending) return false;
    const modal = modalFor(record);
    if (modal) {
      if (!modal.window.isDestroyed()) modal.window.focus();
      return false;
    }
    if(nativeDialogOwners.has(record))return nativeDialogOwners.get(record)===record.contextId;
    invalidateWarmSettings(window);
    nativeDialogOwners.set(record,record.contextId);
    // P0 may be waiting on this exact owner while ordinary UI admission is
    // fenced. Reveal only it, without creating a window or changing any close
    // permission; the alert still owns its independent snapshot checks.
    const launcherDialog = record.role === 'launcher' && hasOpenEditor();
    if (launcherDialog) nativeDialogPresentation.add(record);
    const minimized = window.isMinimized(), hidden = trayHidden || hiddenForTray.has(record) || launcherDialog;
    trayHidden = false; hiddenForTray.delete(record);
    if (!hidden && !minimized) return true;
    if (minimized) window.restore();
    window.show(); window.focus(); record.focusOrder = ++focusOrder;
    return true;
  }
  function retireNativeDialogPresentation(record:WindowRecord<W>):void{
    if(nativeDialogPresentation.delete(record)&&record.role==='launcher'&&hasOpenEditor())record.window.hide();
  }
  function finishNativeDialog(window: W, expectedContextId?: string): void {
    const record = records.get(window);
    if (!record || !ownsRecord(record) || expectedContextId !== undefined && record.contextId !== expectedContextId && nativeDialogOwners.get(record)!==expectedContextId) return;
    nativeDialogOwners.delete(record);
    // Only the exact launcher shown for an owned native sheet is exempt from
    // normal project-window visibility. Cancellation releases that exemption;
    // a stale completion cannot hide a replacement document's new alert.
    retireNativeDialogPresentation(record);
  }
  function closeOrder(): W[] {
    const current = windows(), modal = settings;
    return modal && current.includes(modal.window) ? [modal.window, ...current.filter(window => window !== modal.window)] : current;
  }
  async function loadDocumentFor(window: W): Promise<ProjectWindowDocumentOwner<W> | null> {
    const record = records.get(window);
    if (!record || !ownsRecord(record)) return null;
    const expectedContext = record.contextId, initial = record.initialLoad;
    const awaitingInitial = !record.committed && record.phase === 'opening' && initial.contextId === expectedContext;
    await record.load;
    // Creation schedules its first assigned load in a microtask. That one
    // navigation rotates contextId legitimately; an intervening reload must
    // not lend its new document to the old presentation intent.
    if (record.contextId !== expectedContext && (!awaitingInitial || initial.contextId !== record.contextId)) return null;
    return capture(record);
  }
  if(projectEntries){
    try{unsubscribeLeases=projectEntries.onWindowRevoked(value=>{
      const parsed=projectEntryWindowRevokedSchema.safeParse(value);if(!parsed.success)return;
      const {windowId,projectId}=parsed.data,lease=leases.get(windowId);
      if(lease?.projectId!==null&&lease?.projectId!==undefined&&lease.projectId!==projectId)return;
      revokedLeases.add(windowId);if(!lease)return;
      const record=[...records.values()].find(current=>current.lease===lease);
      if(record)invalidateDocument(record);
      lease.revoked=true;
      if(record)retireCandidateFor(record);
      if(record?.pending)requestCandidateClose(record,'owner',refused('unavailable'));
      else if(record){record.phase='failed';record.retainedPhase='failed';revokeSelection(record);refresh();}
    });}catch{projectEntries=null;}
  }
  return {
    ensureLauncher, activate, requestProjectEntry, openPath, restoreProject, adoptPrepared, showProjects: (focused?: W | null) => requestProjectEntry('open', focused), showSettings, prewarmSettings, invalidateWarmSettings,
    dispatch, recordSettingsDiagnostic, refresh, windows, getWindows: windows, closeOrder, closeStateChanged, isCandidate, candidateSourceWindow, rendererGone,
    canHideToTray, hideToTray, prepareNativeDialog, finishNativeDialog, loadDocumentFor, reserveClosedProjectAction,
    settingsForParent(window: W): W | null { const record = records.get(window); return record ? modalFor(record)?.window ?? null : null; },
    preferredWindow(focused?: W | null): W | null { return preferredRecord(focused)?.window ?? null; },
    windowForContents(contents: ProjectWindowWebContents): W | null { const record = contentsRecords.get(contents); return record && trustedDocument(record) ? record.window : null; },
    ownerForContents(contents: ProjectWindowWebContents): ProjectWindowDocumentOwner<W> | null { const record = contentsRecords.get(contents); return record ? capture(record) : null; },
    owns(window: W, contextId?: string): boolean { const record = records.get(window); return Boolean(record && ownsRecord(record) && (contextId === undefined || record.contextId === contextId)); },
    isTrustedDocument(window: W): boolean { const record = records.get(window); return Boolean(record && trustedDocument(record)); },
    contextFor(window: W): ProjectWindowContext | null { const record = records.get(window); return record && ownsRecord(record) ? context(record) : null; },
    loadFor(window: W): Promise<void> { return records.get(window)?.load ?? Promise.resolve(); },
    dispose() {
      disposed = true;
      retireWarmSettings();
      try{unsubscribeLeases?.();}catch{/* A failed observer cleanup cannot retain leases. */}unsubscribeLeases=null;
      for(const lease of [...leases.values()])releaseLease(lease);
      nativeDialogOwners.clear();
      for (const record of records.values()) {
        clearTimeout(record.settingsBootTimer);
        if (record.role === 'settings') diagnostics?.close(record.window);
        if (record.pending) completeCandidate(record, record.pending, refused('busy'));
        for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      }
      records.clear(); contentsRecords.clear(); editors.clear(); reservations.clear(); launcher = null; settings = null;
    },
  };
}
