import { randomUUID } from 'node:crypto';
import { PROJECT_WINDOW_EVENT, isProjectWindowId, isProjectWindowRequest, isProjectWindowSettingsSlot, isProjectWindowEntryMode } from './project-window-protocol.ts';
import type { ProjectWindowContext, ProjectWindowEntryMode, ProjectWindowEntryReceipt, ProjectWindowOpenResult, ProjectWindowRole, ProjectWindowSettingsSlot, ProjectWindowPhase, ProjectWindowLocatorStatus, ProjectWindowLocatorIntent } from './project-window-protocol.ts';

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
export interface ProjectWindowCreation {
  readonly role: ProjectWindowRole;
  readonly windowId: string;
  readonly contextId: string;
  readonly backendId: string;
  readonly projectId: string | null;
  readonly autoOpen: boolean;
  readonly url: string;
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
  editorUrl(projectId: string): string;
  isCurrent(): boolean; canInteract(): boolean;
  createWindow(context: ProjectWindowCreation): W;
  prepareWindow?(window: W, owner: ProjectWindowOwner<W>): void;
  onLoadError?(error: unknown, window: W, owner: ProjectWindowOwner<W>): void;
  /** Resource invalidation is not renderer destruction or release evidence. */
  onDocumentInvalidated?(owner: ProjectWindowDocumentOwner<W>): void;
  /** Only the exact WebContents destroyed event establishes this fact. */
  onWebContentsDestroyed?(windowId: string): void;
  /** Fixed renderer entry-admission hook. Absence/invalid response denies. */
  consumeProjectEntry?(owner: ProjectWindowDocumentOwner<W>, entryToken: string, projectId: string): unknown | Promise<unknown>;
}
export interface ProjectWindowIPCEvent { readonly sender: ProjectWindowWebContents; readonly senderFrame: ProjectWindowFrame | null }
interface EntryAttempt {
  readonly contextId: string; readonly entryToken: string; readonly projectId: string; readonly remember: boolean;
  readonly promise: Promise<ProjectWindowOpenResult>; readonly complete: (result: ProjectWindowOpenResult) => void;
  result: ProjectWindowOpenResult | null;
}
type EditorPhase = Exclude<ProjectWindowPhase, 'none'>;
interface WindowRecord<W extends ProjectNativeWindow> {
  readonly window: W; readonly contents: ProjectWindowWebContents; readonly windowId: string; readonly role: ProjectWindowRole; readonly projectId: string | null; readonly url: string;
  contextId: string; autoOpen: boolean; closed: boolean; committed: boolean; phase: EditorPhase;
  retainedPhase: Exclude<EditorPhase, 'closing'>; frame: ProjectWindowFrame | null;
  revealIntent: number; revealFence: number; readyToShow: boolean; focusOrder: number;
  entryMode: ProjectWindowEntryMode | null; entryVersion: number; entryReceipt: ProjectWindowEntryReceipt | null; entryAttempt: EntryAttempt | null;
  settingsSlot: ProjectWindowSettingsSlot | null; settingsVersion: number;
  load: Promise<void>; owner: ProjectWindowOwner<W>;
  listeners: Array<{ target: EventSource; event: string; listener: Listener }>;
}
const refused = (reason: 'busy' | 'unavailable'): ProjectWindowOpenResult =>
  Object.freeze({ ok: false, reason, targetWindowId: null, targetPhase: null });
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
  const records = new Map<W, WindowRecord<W>>(), contentsRecords = new Map<ProjectWindowWebContents, WindowRecord<W>>();
  let disposed = false, launcherCreated = false, intent = 0, focusOrder = 0, fence = 0, wasPermitted = options.canInteract();
  let locatorStatus: ProjectWindowLocatorStatus | null = null, locatorIntent: ProjectWindowLocatorIntent | null = null;
  let locatorContextId: string | null = null, locatorIntentVersion = 0;
  let selectionVersion = 0, selectionRecord: WindowRecord<W> | null = null, selectionContextId: string | null = null;
  const lifetime = () => !disposed && options.isCurrent();
  const editorCount = () => editors.size + reservations.size;
  function permitted() {
    const allowed = lifetime() && options.canInteract();
    const invalidating = wasPermitted && !allowed;
    wasPermitted = allowed;
    if (invalidating) {
      fence++; intent++;
      for (const record of records.values()) invalidateDocument(record);
    }
    return allowed;
  }
  const ownsRecord = (record: WindowRecord<W>) => lifetime() && !record.closed && !record.window.isDestroyed() && records.get(record.window) === record &&
    (record.role === 'launcher' ? launcher === record : record.role === 'settings' ? settings === record : editors.get(record.projectId!) === record);
  function currentUrl(record: WindowRecord<W>): string | null { try { return record.contents.getURL(); } catch { return null; } }
  function trustedDocument(record: WindowRecord<W>): boolean {
    try { return ownsRecord(record) && record.committed && record.frame === record.contents.mainFrame &&
      record.frame?.url === record.url && currentUrl(record) === record.url; } catch { return false; }
  }
  function selectedProject(): string | null {
    return selectionRecord && selectionRecord.contextId === selectionContextId && selectionRecord.phase === 'ready' && trustedDocument(selectionRecord)
      ? selectionRecord.projectId : null;
  }
  function context(record: WindowRecord<W>): ProjectWindowContext {
    return { version: 2, role: record.role, windowId: record.windowId, contextId: record.contextId, backendId: options.backendId,
      initialProjectId: record.projectId, autoOpen: record.autoOpen, editorProjectId: record.projectId,
      editorPhase: record.role === 'editor' ? record.phase : 'none', editorCount: editorCount(),
      entryMode: record.entryMode, entryVersion: record.entryVersion, entryReceipt: record.entryReceipt,
      settingsSlot: record.settingsSlot, settingsVersion: record.settingsVersion,
      selectionProjectId: record.role === 'launcher' ? selectedProject() : null,
      selectionVersion: record.role === 'launcher' ? selectionVersion : 0,
      locatorStatus: launcher && locatorContextId === launcher.contextId && trustedDocument(launcher) ? locatorStatus : null,
      locatorIntent: record.role === 'launcher' && locatorContextId === record.contextId ? locatorIntent : null, quitting: !permitted() };
  }
  function refresh() {
    permitted();
    for (const record of records.values()) if (trustedDocument(record)) {
      try { record.contents.send(PROJECT_WINDOW_EVENT, context(record)); } catch { /* Disappearance cannot mint another owner. */ }
    }
  }
  function capture(record: WindowRecord<W>): ProjectWindowDocumentOwner<W> | null {
    if (!trustedDocument(record) || !record.frame) return null;
    const contextId = record.contextId, frame = record.frame;
    return Object.freeze({ window: record.window, windowId: record.windowId, role: record.role, backendId: options.backendId,
      projectId: record.projectId, url: record.url, contextId, frame,
      isCurrent: () => record.contextId === contextId && record.frame === frame && trustedDocument(record) });
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
    if (!permitted() || !ownsRecord(record) || record.revealFence !== fence || record.phase === 'closing' || record.role === 'launcher' && editorCount() !== 0) return false;
    if (focus && record.window.isMinimized()) record.window.restore();
    if (focus) { record.window.show(); record.window.focus(); record.focusOrder = ++focusOrder; }
    else record.window.showInactive();
    return true;
  }
  function hideLauncher() { if (launcher && ownsRecord(launcher)) launcher.window.hide(); }
  function listen(record: WindowRecord<W>, target: EventSource, event: string, listener: Listener) {
    target.on(event, listener); record.listeners.push({ target, event, listener });
  }
  function revokeSelection(record: WindowRecord<W>) {
    if (selectionRecord === record) { selectionRecord = null; selectionContextId = null; }
  }
  function create(role: ProjectWindowRole, projectId: string | null, revealIntent = intent): WindowRecord<W> | null {
    if (!permitted()) return null;
    if (role === 'editor') {
      if (!projectId || editors.has(projectId) || reservations.has(projectId)) return null;
      reservations.add(projectId); hideLauncher();
    }
    const url = role === 'editor' ? options.editorUrl(projectId!) : role === 'settings' ? options.settingsUrl ?? options.launcherUrl : options.launcherUrl;
    const windowId = randomUUID(), contextId = randomUUID(), autoOpen = role === 'launcher' && !launcherCreated;
    let window: W, contents: ProjectWindowWebContents;
    try {
      window = options.createWindow({ role, windowId, contextId, backendId: options.backendId, projectId, autoOpen, url });
      // BrowserWindow.webContents is a native getter and may throw at closed.
      contents = window.webContents;
    }
    catch (error) {
      if (projectId) reservations.delete(projectId);
      if (editorCount() === 0 && launcher?.readyToShow) reveal(launcher);
      throw error;
    }
    let record!: WindowRecord<W>;
    const owner: ProjectWindowOwner<W> = { window, windowId, role, url, backendId: options.backendId, projectId,
      get contextId() { return record.contextId; }, isCurrent: () => ownsRecord(record) };
    record = { window, contents, windowId, role, projectId, url, contextId, autoOpen, closed: false, committed: false, phase: 'opening', retainedPhase: 'opening',
      frame: null, revealIntent, revealFence: fence, readyToShow: false, focusOrder: ++focusOrder,
      entryMode: null, entryVersion: 0, entryReceipt: null, entryAttempt: null, settingsSlot: null, settingsVersion: 0,
      load: Promise.resolve(), owner, listeners: [] };
    records.set(window, record); contentsRecords.set(contents, record);
    if (role === 'launcher') { launcher = record; launcherCreated = true; }
    else if (role === 'settings') settings = record;
    else { editors.set(projectId!, record); reservations.delete(projectId!); }
    const initialLoad: { contextId: string; started: boolean; frame: ProjectWindowFrame | null } = { contextId, started: false, frame: null };
    listen(record, window, 'closed', () => {
      if (record.closed) return;
      record.closed = true; revokeSelection(record); retireLocator(record);
      records.delete(window); contentsRecords.delete(contents);
      for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      if (launcher === record) launcher = null;
      if (settings === record) settings = null;
      if (role === 'editor' && editors.get(projectId!) === record) {
        editors.delete(projectId!);
        // Retire only at actual closure; settings and minimizing are irrelevant.
        if (editorCount() === 0 && permitted()) revealLauncher();
      }
      refresh();
    });
    // Keep this one listener through BrowserWindow.closed and host disposal:
    // only actual contents destruction proves every old document is gone.
    const destroyed = () => {
      contents.removeListener('destroyed', destroyed);
      try { options.onWebContentsDestroyed?.(windowId); } catch { /* Observation is never a new resource grant. */ }
    };
    contents.on('destroyed', destroyed);
    listen(record, window, 'show', () => {
      // OS Window menus cannot make the launcher coexist visibly with an editor.
      if (role === 'launcher' && editorCount() !== 0 && ownsRecord(record)) window.hide();
    });
    listen(record, window, 'focus', () => { if (ownsRecord(record)) record.focusOrder = ++focusOrder; });
    listen(record, window, 'ready-to-show', () => {
      if (!ownsRecord(record)) return;
      record.readyToShow = true;
      if (role === 'launcher') { if (record.revealIntent === intent) reveal(record); }
      else reveal(record, record.revealIntent === intent);
    });
    listen(record, contents, 'did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const value = details && typeof details === 'object' ? details as Record<string, unknown> : null;
      const mainFrame = value && 'isMainFrame' in value ? value.isMainFrame : legacyMainFrame;
      const sameDocument = value && 'isSameDocument' in value ? value.isSameDocument : legacyInPlace;
      if (mainFrame === false || sameDocument === true || !ownsRecord(record)) return;
      const target = value && 'url' in value ? value.url : legacyUrl;
      const previousContext = record.contextId;
      const firstAssignedLoad = !initialLoad.started && initialLoad.contextId === previousContext && target === url;
      invalidateDocument(record); retireLocator(record);
      record.committed = false; record.frame = null; record.contextId = randomUUID();
      record.entryAttempt = null; record.entryReceipt = null;
      if (firstAssignedLoad) {
        initialLoad.started = true; initialLoad.contextId = record.contextId;
        if (selectionRecord === record && selectionContextId === previousContext) selectionContextId = record.contextId;
      } else revokeSelection(record);
      record.phase = 'opening';
      refresh();
    });
    listen(record, contents, 'did-navigate', () => {
      if (!ownsRecord(record)) return;
      record.committed = currentUrl(record) === record.url;
      record.frame = record.committed ? contents.mainFrame : null;
      if (initialLoad.contextId === record.contextId) initialLoad.frame = record.frame;
      refresh();
    });
    try { options.prepareWindow?.(window, owner); }
    catch (error) {
      // Security/P0 preparation failure cannot fall through into app loading.
      record.phase = 'failed'; revokeSelection(record);
      record.load = Promise.reject(error); void record.load.catch(() => {});
      if (role !== 'launcher') reveal(record, record.revealIntent === intent);
      try { options.onLoadError?.(error, window, owner); } catch { /* This failed owner still retains its slot. */ }
      refresh(); return record;
    }
    record.load = Promise.resolve().then(() => {
      if (!ownsRecord(record) || record.contextId !== initialLoad.contextId) return;
      return window.loadURL(url);
    }).then(() => {}).catch(error => {
      if (!ownsRecord(record) || record.contextId !== initialLoad.contextId ||
        initialLoad.frame && (initialLoad.frame !== contents.mainFrame || currentUrl(record) !== url)) return;
      if (record.phase !== 'closing') record.phase = 'failed';
      revokeSelection(record); refresh();
      // A failed editor still owns its slot and its own bounded recovery UI.
      if (role !== 'launcher') reveal(record, record.revealIntent === intent);
      options.onLoadError?.(error, window, owner);
      throw error;
    });
    void record.load.catch(() => {});
    refresh();
    return record;
  }
  function ensureLauncher(): W | null {
    if (!permitted() || launcher && !ownsRecord(launcher)) return null;
    return (launcher ?? create('launcher', null))?.window ?? null;
  }
  function revealLauncher(): boolean {
    if (!permitted() || editorCount() !== 0) return false;
    const window = ensureLauncher();
    if (!window || !launcher) return false;
    launcher.autoOpen = false; launcher.revealIntent = ++intent; launcher.revealFence = fence;
    if (launcher.readyToShow) reveal(launcher);
    refresh(); return true;
  }
  function preferredRecord(focused?: W | null, role?: ProjectWindowRole): WindowRecord<W> | null {
    const explicit = focused ? records.get(focused) : undefined;
    if (explicit && ownsRecord(explicit) && explicit.phase !== 'closing' && (explicit.role !== 'launcher' || editorCount() === 0) && (!role || explicit.role === role)) return explicit;
    return [...records.values()].filter(record => ownsRecord(record) && record.phase !== 'closing' && (record.role !== 'launcher' || editorCount() === 0) && (!role || record.role === role))
      .sort((left, right) => right.focusOrder - left.focusOrder)[0] ?? null;
  }
  function requestProjectEntry(mode: ProjectWindowEntryMode, focused?: W | null): boolean {
    if (!isProjectWindowEntryMode(mode) || !permitted()) return false;
    let record: WindowRecord<W> | null;
    if (editorCount() !== 0) record = preferredRecord(focused, 'editor');
    else { ensureLauncher(); record = launcher; }
    if (!record || !ownsRecord(record) || record.phase === 'closing' || record.entryAttempt && !record.entryAttempt.result) return false;
    record.autoOpen = false; record.entryMode = mode; record.entryVersion++; record.revealIntent = ++intent; record.revealFence = fence;
    if (record.readyToShow) reveal(record);
    refresh(); return true;
  }
  function activate(focused?: W | null): boolean {
    if (!permitted()) return false;
    if (editorCount() === 0) return revealLauncher();
    const record = preferredRecord(focused, 'editor');
    if (!record) return false;
    record.revealIntent = ++intent; record.revealFence = fence;
    if (record.readyToShow || record.phase === 'ready' || record.phase === 'failed') reveal(record);
    refresh(); return true;
  }
  function showSettings(slot: ProjectWindowSettingsSlot): boolean {
    if (!isProjectWindowSettingsSlot(slot) || !permitted() || settings && !ownsRecord(settings)) return false;
    intent++;
    const record = settings ?? create('settings', null);
    if (!record || record.phase === 'closing') return false;
    record.settingsSlot = slot; record.settingsVersion++; record.revealIntent = intent; record.revealFence = fence;
    if (record.readyToShow) reveal(record);
    refresh(); return true;
  }
  function reserveProject(projectId: string, revealIntent: number): ProjectWindowOpenResult {
    if (!permitted()) return refused('busy');
    const existing = editors.get(projectId);
    if (existing) {
      if (!ownsRecord(existing) || existing.phase === 'closing') return refused('busy');
      existing.revealIntent = revealIntent; existing.revealFence = fence;
      if (existing.readyToShow || existing.phase === 'ready' || existing.phase === 'failed') reveal(existing, revealIntent === intent);
      return Object.freeze({ ok: true, reason: 'already-open', targetWindowId: existing.windowId, targetPhase: existing.phase });
    }
    if (reservations.has(projectId)) return refused('busy');
    const record = create('editor', projectId, revealIntent);
    return record ? Object.freeze({ ok: true, reason: 'accepted', targetWindowId: record.windowId, targetPhase: record.phase }) : refused('unavailable');
  }
  function openProject(record: WindowRecord<W>, projectId: string, remember: boolean, entryToken: string): Promise<ProjectWindowOpenResult> {
    if (record.role === 'settings') return Promise.resolve(refused('unavailable'));
    const previous = record.entryAttempt;
    if (previous && previous.contextId === record.contextId && previous.entryToken === entryToken) {
      return previous.projectId === projectId && previous.remember === remember ? previous.promise : Promise.resolve(refused('unavailable'));
    }
    if (previous && !previous.result) return Promise.resolve(refused('busy'));
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
    const selectedVersion = remember ? ++selectionVersion : 0;
    if (remember) { selectionRecord = null; selectionContextId = null; }
    let complete!: EntryAttempt['complete'];
    const promise = new Promise<ProjectWindowOpenResult>(resolve => { complete = resolve; });
    const attempt: EntryAttempt = { contextId: record.contextId, entryToken, projectId, remember, promise, complete, result: null };
    record.entryAttempt = attempt; record.entryReceipt = null;
    refresh();
    void (async () => {
      let result = refused('unavailable');
      try {
        const receipt = await options.consumeProjectEntry?.(owner, entryToken, projectId);
        if (!owner.isCurrent() || record.entryAttempt !== attempt || !permitted() || fence !== capturedFence || record.phase === 'closing') result = refused('busy');
        else if (consumed(receipt, entryToken, projectId)) {
          // A first editor may only depart the still-visible launcher whose
          // exact entry state supplied this one-use, synchronously sealed token.
          if (editorCount() === 0 && record !== launcher) result = refused('busy');
          else {
            if (launcher) launcher.autoOpen = false;
            result = reserveProject(projectId.toLowerCase(), revealIntent);
            const target = editors.get(projectId.toLowerCase());
            if (result.ok && target && remember && selectedVersion === selectionVersion) {
              selectionRecord = target; selectionContextId = target.contextId;
            }
          }
        }
      } catch { result = refused('unavailable'); }
      attempt.result = result;
      if (record.entryAttempt === attempt && record.contextId === attempt.contextId) {
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
  function dispatch(event: ProjectWindowIPCEvent, request: unknown): ProjectWindowContext | ProjectWindowOpenResult | Promise<ProjectWindowOpenResult> | boolean {
    if (!isProjectWindowRequest(request)) throw new Error('Rejected project-window request');
    const record = contentsRecords.get(event.sender);
    if (!record || !trustedDocument(record) || event.senderFrame !== record.frame || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== record.url)
      throw new Error('Rejected project-window sender');
    if (request.action === 'describe') return context(record);
    if (request.contextId !== record.contextId) throw new Error('Stale project-window context');
    if (request.action === 'locator-status') return publishLocatorStatus(record, request.status);
    if (request.action === 'locator-action') return requestLocatorAction(record, request.locatorAction, request.expectedStatusVersion);
    if (request.action === 'open') return openProject(record, request.projectId, request.remember, request.entryToken);
    if (request.action === 'projects' || request.action === 'project-entry') return record.role !== 'settings' &&
      requestProjectEntry(request.action === 'projects' ? 'open' : request.mode, record.window);
    if (request.action === 'settings') return showSettings(request.slot);
    if (record.role !== 'editor' || record.projectId !== request.projectId || record.phase === 'closing') return false;
    record.phase = request.phase;
    if (request.phase === 'failed') revokeSelection(record);
    refresh();
    reveal(record, record.revealIntent === intent);
    return true;
  }
  function closeStateChanged(window: W, state: 'closing' | 'retained'): boolean {
    const record = records.get(window);
    if (!record || !ownsRecord(record)) return false;
    if (state === 'closing' && record.phase !== 'closing') { record.retainedPhase = record.phase; record.phase = 'closing'; revokeSelection(record); }
    if (state === 'retained' && record.phase === 'closing') record.phase = record.retainedPhase;
    refresh(); return true;
  }
  function windows(): W[] { return lifetime() ? [...records.values()].filter(record => !record.closed).map(record => record.window) : []; }
  return {
    ensureLauncher, activate, requestProjectEntry, showProjects: (focused?: W | null) => requestProjectEntry('open', focused), showSettings,
    dispatch, refresh, windows, getWindows: windows, closeStateChanged,
    preferredWindow(focused?: W | null): W | null { return preferredRecord(focused)?.window ?? null; },
    windowForContents(contents: ProjectWindowWebContents): W | null { const record = contentsRecords.get(contents); return record && trustedDocument(record) ? record.window : null; },
    ownerForContents(contents: ProjectWindowWebContents): ProjectWindowDocumentOwner<W> | null { const record = contentsRecords.get(contents); return record ? capture(record) : null; },
    owns(window: W, contextId?: string): boolean { const record = records.get(window); return Boolean(record && ownsRecord(record) && (contextId === undefined || record.contextId === contextId)); },
    isTrustedDocument(window: W): boolean { const record = records.get(window); return Boolean(record && trustedDocument(record)); },
    contextFor(window: W): ProjectWindowContext | null { const record = records.get(window); return record && ownsRecord(record) ? context(record) : null; },
    loadFor(window: W): Promise<void> { return records.get(window)?.load ?? Promise.resolve(); },
    dispose() {
      disposed = true;
      for (const record of records.values()) for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      records.clear(); contentsRecords.clear(); editors.clear(); reservations.clear(); launcher = null; settings = null;
    },
  };
}
