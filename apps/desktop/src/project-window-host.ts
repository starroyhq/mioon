import { randomUUID } from 'node:crypto';
import { PROJECT_WINDOW_EVENT, isProjectWindowId, isProjectWindowRequest, isProjectWindowSettingsSlot } from './project-window-protocol.ts';
import type { ProjectWindowContext, ProjectWindowOpenResult, ProjectWindowRole, ProjectWindowSettingsSlot } from './project-window-protocol.ts';

type Listener = (...args: unknown[]) => void;
interface EventSource {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
export interface ProjectWindowFrame { readonly url: string }
export interface ProjectWindowWebContents extends EventSource {
  readonly mainFrame: ProjectWindowFrame;
  getURL(): string;
  send(channel: string, context: ProjectWindowContext): void;
}
export interface ProjectNativeWindow extends EventSource {
  readonly webContents: ProjectWindowWebContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
  close(): void;
  loadURL(url: string): Promise<unknown>;
}
export interface ProjectWindowCreation {
  readonly role: ProjectWindowRole;
  readonly contextId: string;
  readonly backendId: string;
  readonly projectId: string | null;
  readonly autoOpen: boolean;
  readonly url: string;
}
export interface ProjectWindowOwner<W extends ProjectNativeWindow> {
  readonly window: W;
  readonly role: ProjectWindowRole;
  readonly url: string;
  readonly contextId: string;
  /** Window/backend lifetime, deliberately independent of Quit's reveal fence
   * and bridge document generations. P0 tracks its own document admission. */
  isCurrent(): boolean;
}
export interface ProjectWindowHostOptions<W extends ProjectNativeWindow> {
  readonly backendId: string;
  readonly launcherUrl: string;
  editorUrl(projectId: string): string;
  isCurrent(): boolean;
  canInteract(): boolean;
  createWindow(context: ProjectWindowCreation): W;
  prepareWindow?(window: W, owner: ProjectWindowOwner<W>): void;
  onLoadError?(error: unknown, window: W, owner: ProjectWindowOwner<W>): void;
}
export interface ProjectWindowIPCEvent {
  readonly sender: ProjectWindowWebContents;
  readonly senderFrame: ProjectWindowFrame | null;
}
interface WindowRecord<W extends ProjectNativeWindow> {
  window: W;
  role: ProjectWindowRole;
  contextId: string;
  initialProjectId: string | null;
  autoOpen: boolean;
  closed: boolean;
  committed: boolean;
  reportedReady: boolean;
  rememberVersion: number;
  rememberProjectId: string | null;
  frame: ProjectWindowFrame | null;
  revealIntent: number;
  readyToShow: boolean;
  load: Promise<void>;
  owner: ProjectWindowOwner<W>;
  listeners: Array<{ target: EventSource; event: string; listener: Listener }>;
}

/** One launcher and at most one editor, both sharing the backend identity and
 * session supplied by main. This module only manages navigation and lifetime. */
export function createProjectWindowHost<W extends ProjectNativeWindow>(options: ProjectWindowHostOptions<W>) {
  if (!isProjectWindowId(options.backendId)) throw new Error('Invalid project-window backend identity');
  let launcher: WindowRecord<W> | null = null, editor: WindowRecord<W> | null = null;
  let disposed = false, launcherCreated = false, intent = 0, rememberSerial = 0;
  let editorProjectId: string | null = null;
  let editorPhase: ProjectWindowContext['editorPhase'] = 'none';
  let settingsSlot: ProjectWindowSettingsSlot | null = null, settingsVersion = 0;
  const records = new Map<W, WindowRecord<W>>();
  const lifetime = () => !disposed && options.isCurrent();
  const permitted = () => lifetime() && options.canInteract();
  const ownsRecord = (record: WindowRecord<W>) => lifetime() && !record.closed && !record.window.isDestroyed() &&
    records.get(record.window) === record && (record.role === 'launcher' ? launcher === record : editor === record);
  const currentUrl = (record: WindowRecord<W>): string | null => {
    try { return record.window.webContents.getURL(); } catch { return null; }
  };
  function projectAtUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      const projectId = new URL(url).searchParams.get('project');
      return isProjectWindowId(projectId) && options.editorUrl(projectId) === url ? projectId : null;
    } catch { return null; }
  }
  function validUrl(record: WindowRecord<W>, url: string | null): boolean {
    return record.role === 'launcher' ? url === options.launcherUrl : projectAtUrl(url) !== null;
  }
  function context(record: WindowRecord<W>): ProjectWindowContext {
    return { version: 1, role: record.role, contextId: record.contextId, backendId: options.backendId,
      initialProjectId: record.initialProjectId, autoOpen: record.autoOpen, editorProjectId, editorPhase,
      settingsSlot, settingsVersion, quitting: !options.canInteract(),
      ...(record.role === 'editor' && record.rememberVersion > 0 ? { rememberVersion: record.rememberVersion } : {}) };
  }
  function trustedDocument(record: WindowRecord<W>): boolean {
    try {
      const contents = record.window.webContents, url = currentUrl(record);
      return ownsRecord(record) && record.committed && record.frame === contents.mainFrame &&
        contents.mainFrame.url === url && validUrl(record, url);
    } catch { return false; }
  }
  function refresh() {
    for (const record of records.values()) {
      if (!trustedDocument(record)) continue;
      try { record.window.webContents.send(PROJECT_WINDOW_EVENT, context(record)); }
      catch { /* A renderer disappearing cannot authorize a replacement. */ }
    }
  }
  function reveal(record: WindowRecord<W>, focus = true) {
    if (!permitted() || !ownsRecord(record)) return false;
    // restore() can itself activate a native window. A stale editor readiness
    // signal must use only the non-activating path after newer launcher intent.
    if (focus && record.window.isMinimized()) record.window.restore();
    if (focus) { record.window.show(); record.window.focus(); }
    else record.window.showInactive();
    return true;
  }
  function listen(record: WindowRecord<W>, target: EventSource, event: string, listener: Listener) {
    target.on(event, listener); record.listeners.push({ target, event, listener });
  }
  function create(role: ProjectWindowRole, projectId: string | null, remember = false): WindowRecord<W> | null {
    if (!permitted()) return null;
    const url = role === 'launcher' ? options.launcherUrl : options.editorUrl(projectId!);
    const contextId = randomUUID(), autoOpen = role === 'launcher' && !launcherCreated;
    const window = options.createWindow({ role, contextId, backendId: options.backendId, projectId, autoOpen, url });
    let record!: WindowRecord<W>;
    const owner: ProjectWindowOwner<W> = { window, role, url, get contextId() { return record.contextId; },
      isCurrent: () => ownsRecord(record) };
    record = { window, role, contextId, initialProjectId: projectId, autoOpen, closed: false, committed: false, reportedReady: false,
      rememberVersion: remember ? ++rememberSerial : 0, rememberProjectId: remember ? projectId : null,
      frame: null, revealIntent: intent, readyToShow: false, load: Promise.resolve(), owner, listeners: [] };
    const initialLoad: { contextId: string; started: boolean; frame: ProjectWindowFrame | null } =
      { contextId, started: false, frame: null };
    records.set(window, record);
    if (role === 'launcher') { launcher = record; launcherCreated = true; }
    else { editor = record; editorProjectId = projectId; editorPhase = 'opening'; }
    listen(record, window, 'closed', () => {
      if (record.closed) return;
      record.closed = true;
      records.delete(window);
      for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      if (role === 'launcher' && launcher === record) launcher = null;
      if (role === 'editor' && editor === record) {
        editor = null; editorProjectId = null; editorPhase = 'none';
        // Only actual close releases the slot. Quit already fenced this path.
        if (permitted()) showProjects();
      }
      refresh();
    });
    listen(record, window, 'ready-to-show', () => {
      if (!ownsRecord(record)) return;
      record.readyToShow = true;
      if (role === 'launcher' && record.revealIntent === intent) reveal(record);
    });
    listen(record, window.webContents, 'did-start-navigation', (details, legacyUrl, legacyInPlace, legacyMainFrame) => {
      const value = details && typeof details === 'object' ? details as Record<string, unknown> : null;
      const mainFrame = value && 'isMainFrame' in value ? value.isMainFrame : legacyMainFrame;
      const sameDocument = value && 'isSameDocument' in value ? value.isSameDocument : legacyInPlace;
      if (mainFrame === false || sameDocument === true || !ownsRecord(record)) return;
      const target = value && 'url' in value ? value.url : legacyUrl;
      const previousContext = record.contextId;
      const firstAssignedLoad = !initialLoad.started && initialLoad.contextId === previousContext && target === url;
      if (!firstAssignedLoad && record.role === 'editor' && record.rememberVersion > 0) {
        // Notify the still-owned old document before its bridge identity is
        // rotated. refresh() deliberately excludes uncommitted documents, so
        // sending only after rotation could leave a held describe reply live.
        record.rememberVersion = 0; record.rememberProjectId = null;
        if (trustedDocument(record)) {
          try { window.webContents.send(PROJECT_WINDOW_EVENT, context(record)); }
          catch { /* A disappearing renderer gains no replacement authority. */ }
        }
      }
      record.committed = false; record.frame = null; record.contextId = randomUUID();
      if (firstAssignedLoad) {
        initialLoad.started = true; initialLoad.contextId = record.contextId;
      } else {
        // Reload/new documents cannot borrow a previous explicit selection's
        // remember intent. The first assigned load alone inherits that intent.
        record.rememberVersion = 0; record.rememberProjectId = null;
      }
      if (role === 'editor' && record.reportedReady) {
        const project = typeof target === 'string' ? projectAtUrl(target) : null;
        if (project) { record.initialProjectId = project; editorProjectId = project; editorPhase = 'opening'; }
      }
      record.reportedReady = false;
      refresh();
    });
    listen(record, window.webContents, 'did-navigate', () => {
      if (!ownsRecord(record)) return;
      record.committed = validUrl(record, currentUrl(record));
      record.frame = record.committed ? window.webContents.mainFrame : null;
      if (initialLoad.contextId === record.contextId) initialLoad.frame = record.frame;
      refresh();
    });
    options.prepareWindow?.(window, owner);
    record.load = Promise.resolve().then(() => {
      if (!ownsRecord(record) || record.contextId !== initialLoad.contextId) return;
      return window.loadURL(url);
    }).then(() => {}).catch(error => {
      // The initial navigation's promise can reject after a successful legal
      // reload of this same live window. Lifetime alone is not its authority.
      if (!ownsRecord(record) || record.contextId !== initialLoad.contextId ||
          (initialLoad.frame && (initialLoad.frame !== window.webContents.mainFrame || currentUrl(record) !== url))) return;
      if (role === 'editor') {
        record.rememberVersion = 0; record.rememberProjectId = null;
        editorPhase = 'failed'; refresh();
        if (record.revealIntent === intent && permitted()) showProjects();
      }
      options.onLoadError?.(error, window, owner);
      throw error;
    });
    // Main may await loadFor(), but navigation requests must never leave an
    // unhandled rejection or replay the rejected load themselves.
    void record.load.catch(() => {});
    refresh();
    return record;
  }
  function ensureLauncher(): W | null {
    if (!permitted()) return null;
    if (launcher && !ownsRecord(launcher)) return null;
    const record = launcher ?? create('launcher', null);
    return record?.window ?? null;
  }
  function showProjects(): boolean {
    if (!permitted()) return false;
    intent++;
    settingsSlot = null; settingsVersion++;
    const window = ensureLauncher();
    if (!window || !launcher) return false;
    launcher.autoOpen = false;
    launcher.revealIntent = intent;
    if (launcher.readyToShow) reveal(launcher);
    refresh();
    return true;
  }
  function showSettings(slot: ProjectWindowSettingsSlot): boolean {
    if (!isProjectWindowSettingsSlot(slot) || !permitted()) return false;
    intent++;
    settingsSlot = slot; settingsVersion++;
    const window = ensureLauncher();
    if (!window || !launcher) return false;
    launcher.autoOpen = false;
    launcher.revealIntent = intent;
    if (launcher.readyToShow) reveal(launcher);
    refresh();
    return true;
  }
  function openProject(projectId: string, remember = true): ProjectWindowOpenResult {
    if (!isProjectWindowId(projectId) || typeof remember !== 'boolean' || !lifetime()) return { ok: false, reason: 'unavailable' };
    if (!permitted()) return { ok: false, reason: 'busy' };
    if (editor) {
      if (!ownsRecord(editor)) return { ok: false, reason: 'busy' };
      if (editorProjectId !== projectId) return { ok: false, reason: 'another-editor' };
      if (launcher) launcher.autoOpen = false;
      editor.revealIntent = ++intent;
      if (remember) { editor.rememberVersion = ++rememberSerial; editor.rememberProjectId = projectId; }
      if (editorPhase !== 'opening') reveal(editor);
      refresh();
      return { ok: true, reason: 'already-open' };
    }
    if (launcher) launcher.autoOpen = false;
    intent++;
    return create('editor', projectId, remember) ? { ok: true, reason: 'accepted' } : { ok: false, reason: 'unavailable' };
  }
  function dispatch(event: ProjectWindowIPCEvent, request: unknown): ProjectWindowContext | ProjectWindowOpenResult | boolean {
    if (!isProjectWindowRequest(request)) throw new Error('Rejected project-window request');
    const record = [...records.values()].find(value => value.window.webContents === event.sender);
    if (!record || !trustedDocument(record) || event.senderFrame !== record.frame ||
        event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== currentUrl(record)) {
      throw new Error('Rejected project-window sender');
    }
    if (request.action === 'describe') return context(record);
    if (request.contextId !== record.contextId) throw new Error('Stale project-window context');
    if (request.action === 'open') return openProject(request.projectId, record.role === 'launcher' && (request.remember ?? true));
    if (request.action === 'projects') return showProjects();
    if (request.action === 'settings') return showSettings(request.slot);
    if (record.role !== 'editor' || projectAtUrl(currentUrl(record)) !== request.projectId ||
        (!record.reportedReady && record.initialProjectId !== request.projectId)) return false;
    editorProjectId = request.projectId; editorPhase = request.phase;
    if (request.phase === 'failed' || record.rememberProjectId !== request.projectId) {
      record.rememberVersion = 0; record.rememberProjectId = null;
    }
    if (request.phase === 'ready') record.reportedReady = true;
    refresh();
    if (!permitted()) return true;
    if (request.phase === 'ready') {
      const latestIntent = record.revealIntent === intent;
      reveal(record, latestIntent);
    } else if (record.revealIntent === intent) showProjects();
    return true;
  }
  function windows(): W[] {
    // A destroyed native handle can precede delivery of its closed event. Keep
    // that owned closure observable until the event actually releases its slot.
    return lifetime() ? [...records.values()].filter(record => !record.closed).map(record => record.window) : [];
  }
  return {
    ensureLauncher, showProjects, showSettings, openProject, dispatch, refresh, windows, getWindows: windows,
    owns(window: W, contextId?: string): boolean {
      const record = records.get(window);
      return Boolean(record && ownsRecord(record) && (contextId === undefined || record.contextId === contextId));
    },
    isTrustedDocument(window: W): boolean {
      const record = records.get(window); return Boolean(record && trustedDocument(record));
    },
    contextFor(window: W): ProjectWindowContext | null {
      const record = records.get(window); return record && ownsRecord(record) ? context(record) : null;
    },
    loadFor(window: W): Promise<void> { return records.get(window)?.load ?? Promise.resolve(); },
    dispose() {
      disposed = true;
      for (const record of records.values()) {
        for (const entry of record.listeners) entry.target.removeListener(entry.event, entry.listener);
      }
      records.clear(); launcher = null; editor = null;
    },
  };
}
