import { isProjectWindowId } from '../../desktop/src/project-window-protocol.ts';
import type { ProjectWindowOpenResult } from '../../desktop/src/project-window-protocol.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import type { LauncherClient, LauncherCreateMetadata, LauncherState } from './launcher-state.ts';
import { LauncherCreateError } from './launcher-state.ts';
import { createLastProjectController } from './last-project-state.ts';
import type { LastProjectController } from './last-project-state.ts';
import { assertLastProjectBootIdentity, chooseInitialProject } from './last-project-navigation.ts';

export interface ProjectEntryState extends LauncherState {
  readonly shown: boolean;
  readonly mode: 'open' | 'new';
  readonly formIntent: number;
  readonly sealed: boolean;
  readonly openUnknown: boolean;
  readonly createdProjectId: string | null;
}
interface Departure { readonly owner: number; readonly localVersion: number; readonly intent: number; readonly metadataVersion: number }
interface Permit {
  readonly token: string;
  readonly projectId: string;
  readonly contextId: string;
  readonly backendId: string;
  readonly localVersion: number;
  consumed: boolean;
}
export interface ProjectEntryConsumption { readonly version: 1; readonly entryToken: string; readonly projectId: string; readonly accepted: boolean }
/** An entry owns only its catalog, create request and departure permission.
 * Sealing happens synchronously after consent. Every input handler consults the
 * same latch; the native host can consume, but cannot mint, this permission. */
export function createProjectEntryController({ client, bridge, context: initialContext, locator = null, explicitProjectId = null,
  confirm = async () => false, onChange = () => {}, newToken = () => globalThis.crypto.randomUUID(),
}: { client: LauncherClient; bridge: ProjectWindowBridge; context: ProjectWindowContext; locator?: LastProjectController | null;
  explicitProjectId?: string | null; confirm?: (message: string) => Promise<boolean>; onChange?: (state: ProjectEntryState) => void; newToken?: () => string }) {
  if (initialContext.role !== 'launcher' && initialContext.role !== 'editor') throw new Error('Project entry requires an owned entry window');
  let context = initialContext, active = false, lifetime = 0, readSerial = 0, intent = 0, interactionSerial = 0, localVersion = 0, contextVersion = 0;
  let visible = true, autoConsumed = initialContext.role !== 'launcher' || !initialContext.autoOpen;
  let observedEntry = 0, observedSelection = -1, rememberedSelection = -1;
  let metadata: LauncherCreateMetadata = { dirty: false, busy: false, version: 0 }, permit: Permit | null = null;
  let state: ProjectEntryState = { projects: [], workspace: null, listBusy: true, listError: '', phase: 'home', openingProjectId: null,
    error: '', notice: '', creating: false, createUnknown: false, version: 0, shown: initialContext.role === 'launcher', mode: 'open',
    formIntent: 0, sealed: false, openUnknown: false, createdProjectId: null };
  const emit = (patch: Partial<ProjectEntryState> = {}) => { state = Object.freeze({ ...state, ...patch, version: state.version + 1 }); if (active) onChange(state); };
  const alive = (owner: number) => active && lifetime === owner;
  const ownerCurrent = () => active && !context.quitting && context.contextId === initialContext.contextId && context.backendId === initialContext.backendId;
  const available = () => ownerCurrent() && visible && state.shown && (context.role !== 'launcher' || context.editorCount === 0) && !permit && !state.creating && !state.createUnknown && !state.openUnknown;
  const interact = () => { intent++; interactionSerial++; autoConsumed = true; };
  function reportCreate(next: LauncherCreateMetadata) {
    if (!Number.isSafeInteger(next.version) || next.version <= metadata.version) return;
    // View cleanup may report its own submitting latch after an exact receipt.
    // A sealed owner never accepts new form input from a deferred DOM handler.
    if (permit || state.creating) return;
    metadata = Object.freeze({ ...next }); localVersion++;
  }
  const departureCurrent = (ticket: Departure) => alive(ticket.owner) && available() && !metadata.busy &&
    ticket.localVersion === localVersion && ticket.metadataVersion === metadata.version && ticket.intent === intent;
  async function departure(message = '新建项目的输入尚未提交。保留这些输入并打开所选项目？'): Promise<Departure | null> {
    if (!available() || metadata.busy) return null;
    const ticket: Departure = Object.freeze({ owner: lifetime, localVersion, intent, metadataVersion: metadata.version });
    if (metadata.dirty && !await confirm(message)) return null;
    return departureCurrent(ticket) ? ticket : null;
  }
  function settle(token: string, result: ProjectWindowOpenResult): boolean {
    if (!permit || permit.token !== token) return false;
    permit = null;
    emit({ sealed: false, openUnknown: false, phase: result.ok ? 'home' : 'error',
      error: result.ok ? '' : '窗口暂不能打开。原项目与输入已保留，请核对后明确重试。',
      notice: result.ok ? (result.targetPhase === 'failed' ? '目标编辑窗口未能完成读取，请在该窗口核对。' : '') : state.notice,
      ...(result.ok && context.role === 'editor' ? { shown: false } : {}) });
    return result.ok;
  }
  function observeLocator(next: ProjectWindowContext) {
    if (!locator || next.role !== 'launcher' || next.selectionVersion < observedSelection) return;
    if (next.selectionVersion > observedSelection) { observedSelection = next.selectionVersion; locator.invalidateNavigation(observedSelection); }
    if (!next.quitting && next.selectionProjectId && next.selectionVersion > rememberedSelection && state.workspace && !state.workspace.restored) {
      rememberedSelection = next.selectionVersion;
      locator.rememberOpened(next.selectionProjectId, next.selectionVersion);
    }
  }
  function updateContext(next: ProjectWindowContext) {
    if (next.contextId !== context.contextId || next.backendId !== context.backendId || next.windowId !== context.windowId || next.role !== context.role) return;
    const enteredQuit = next.quitting && !context.quitting;
    context = next; contextVersion++;
    // A pre-quit catalog reply cannot regain authority if quitting is cancelled.
    if (enteredQuit) { readSerial++; if (state.listBusy) emit({ listBusy: false }); }
    if (!next.autoOpen) autoConsumed = true;
    if (next.entryReceipt && permit?.token === next.entryReceipt.entryToken) settle(permit.token, next.entryReceipt.result);
    observeLocator(next);
    if (next.entryVersion > observedEntry) {
      observedEntry = next.entryVersion; interact();
      if (next.entryMode) void show(next.entryMode);
    }
  }
  async function dispatchOpen(projectId: string, remember: boolean): Promise<boolean> {
    if (!ownerCurrent() || permit || state.createUnknown || !isProjectWindowId(projectId)) return false;
    const token = newToken();
    if (!isProjectWindowId(token)) return false;
    const owner = lifetime;
    permit = { token, projectId, contextId: context.contextId, backendId: context.backendId, localVersion, consumed: false };
    emit({ sealed: true, openUnknown: false, phase: 'opening', openingProjectId: projectId, error: '', notice: '' });
    try {
      const result = await bridge.openProject(projectId, remember, token);
      if (!alive(owner)) return false;
      if (permit?.token === token) return settle(token, result);
      // A matching subscription receipt may have arrived before invoke returned.
      return context.entryReceipt?.entryToken === token && context.entryReceipt.result.ok === true;
    } catch {
      if (!alive(owner) || permit?.token !== token) return context.entryReceipt?.entryToken === token && context.entryReceipt.result.ok === true;
      emit({ openUnknown: true, phase: 'error', error: '打开窗口的结果尚未确认。请核对窗口状态；不会自动重发打开或新建请求。' });
      await reconcileOpen();
      return context.entryReceipt?.entryToken === token && context.entryReceipt.result.ok === true;
    }
  }
  async function open(projectId: string, remember = true): Promise<boolean> {
    if (!isProjectWindowId(projectId) || !ownerCurrent() || permit || state.creating || state.createUnknown || state.openUnknown) return false;
    interact(); const owner = lifetime, selected = intent;
    if (!state.projects.some(project => project.id === projectId)) await refresh();
    if (!alive(owner) || intent !== selected || !state.projects.some(project => project.id === projectId)) return false;
    if (context.role === 'editor' && !state.shown) emit({ shown: true, mode: 'open' });
    const ticket = await departure();
    if (!ticket || !departureCurrent(ticket)) return false;
    return dispatchOpen(projectId, remember);
  }
  async function reconcileOpen(): Promise<void> {
    if (!active || !permit) return;
    const owner = lifetime, token = permit.token;
    try { const fresh = await bridge.context(); if (alive(owner) && permit?.token === token) updateContext(fresh); }
    catch { /* Missing evidence keeps the original owner and latch. */ }
  }
  async function show(mode: 'open' | 'new'): Promise<boolean> {
    if (!ownerCurrent() || permit || state.creating || state.createUnknown || state.openUnknown) {
      if (active) emit({ notice: '请先在此窗口核对当前新建或打开请求。现有输入已保留。' });
      return false;
    }
    interact();
    emit({ shown: true, mode, ...(mode === 'new' ? { formIntent: state.formIntent + 1 } : {}) });
    void refresh();
    return true;
  }
  async function dismiss(): Promise<boolean> {
    if (context.role !== 'editor') return false;
    interact();
    const ticket = await departure('新建项目的输入尚未提交。保留这些输入并关闭项目选择？');
    if (!ticket || !departureCurrent(ticket)) return false;
    emit({ shown: false }); return true;
  }
  async function refresh(initial = false): Promise<void> {
    if (!ownerCurrent()) return;
    const owner = lifetime, serial = ++readSerial, selection = interactionSerial;
    emit({ listBusy: true, listError: '' });
    try {
      const workspace = await client.inspect();
      if (!alive(owner) || serial !== readSerial) return;
      if (state.workspace && (workspace.restored !== state.workspace.restored || workspace.workspaceOrigin !== state.workspace.workspaceOrigin)) throw new Error('Workspace changed');
      const [projects, remembered] = await Promise.all([client.list(workspace), initial && locator && !workspace.restored ? locator.discover() : Promise.resolve(null)]);
      if (!alive(owner) || serial !== readSerial) return;
      if (locator) assertLastProjectBootIdentity(locator.getState());
      emit({ workspace, projects, listBusy: false }); observeLocator(context);
      if (initial && context.role === 'launcher' && context.autoOpen && !autoConsumed && selection === interactionSerial && !context.quitting && context.editorCount === 0) {
        autoConsumed = true;
        const choice = chooseInitialProject(projects, explicitProjectId, remembered?.envelope ?? null);
        if (choice.notice) emit({ notice: choice.notice });
        if (choice.projectId) await open(choice.projectId, false);
      }
    } catch { if (alive(owner) && serial === readSerial) emit({ listBusy: false, listError: '暂时无法读取工作区项目。请核对连接后刷新；现有输入会保留。' }); }
  }
  async function create(name: string, description: string): Promise<boolean> {
    if (!available() || !state.workspace || state.workspace.restored) return false;
    // The view's submit latch may already be busy; this exact call alone owns
    // it. No second submission can enter after creating is set synchronously.
    interact(); const owner = lifetime;
    emit({ creating: true, notice: '', error: '' });
    const observedContext = contextVersion;
    try {
      const fresh = await bridge.context();
      if (!alive(owner)) return false;
      if (fresh.contextId !== context.contextId || fresh.backendId !== context.backendId || fresh.windowId !== context.windowId ||
          fresh.role !== context.role || fresh.quitting || context.quitting) {
        emit({ creating: false, notice: '窗口身份或退出状态已变化，未发起新建项目。' }); return false;
      }
      // An older describe reply cannot erase a newer synchronous host event.
      if (observedContext === contextVersion) updateContext(fresh);
    } catch { if (alive(owner)) emit({ creating: false, notice: '窗口身份尚未确认，未发起新建项目。请核对后明确重试。' }); return false; }
    if (!ownerCurrent() || !visible || context.role === 'launcher' && context.editorCount > 0) { emit({ creating: false }); return false; }
    let created;
    try { created = await client.create(name, description); }
    catch (error) {
      if (alive(owner)) {
        const rejected = error instanceof LauncherCreateError && error.outcome === 'rejected';
        emit({ creating: false, createUnknown: !rejected, notice: rejected
          ? '新建请求未被接受。现有输入已保留，请核对后明确重试。'
          : '新建结果未确认。请保留此窗口并刷新项目列表核对；不要重复创建。' });
      }
      return false;
    }
    if (!alive(owner)) return false;
    emit({ projects: [created, ...state.projects.filter(project => project.id !== created.id)], createdProjectId: created.id, notice: '项目已创建。' });
    // Keep creating=true until the open permit is sealed. No free input turn
    // exists between the authoritative create ACK and host reservation.
    const opening = ownerCurrent() && visible ? dispatchOpen(created.id, true) : Promise.resolve(false);
    emit({ creating: false });
    await opening;
    return true; // The known create must never be replayed for an open failure.
  }
  return {
    activate() { if (!active) { active = true; lifetime++; locator?.activate(); } },
    dispose() { active = false; lifetime++; readSerial++; locator?.dispose(); },
    boot: () => refresh(true), refresh: () => refresh(false), open, create, show, dismiss, reconcileOpen, updateContext, reportCreate,
    interacted() { interactionSerial++; autoConsumed = true; },
    setVisible(value: boolean) { visible = value; },
    canMutate: () => available(),
    consume(entryToken: string, projectId: string): ProjectEntryConsumption {
      const accepted = Boolean(ownerCurrent() && permit && !permit.consumed && permit.token === entryToken && permit.projectId === projectId &&
        permit.contextId === context.contextId && permit.backendId === context.backendId && permit.localVersion === localVersion && !state.createUnknown);
      if (accepted && permit) permit.consumed = true;
      return Object.freeze({ version: 1, entryToken, projectId, accepted });
    },
    readCloseSnapshot() { return { dirty: metadata.dirty, busy: state.creating || Boolean(permit && !state.openUnknown), unknown: state.createUnknown,
      identity: [initialContext.contextId, intent, localVersion, metadata.version, state.creating, state.createUnknown, permit?.token ?? null, state.openUnknown] }; },
    getState: () => state, getContext: () => context, locator,
  };
}
export type ProjectEntryController = ReturnType<typeof createProjectEntryController>;
export function createLauncherEntryController(options: Omit<Parameters<typeof createProjectEntryController>[0], 'locator'> & { locator?: LastProjectController }) {
  return createProjectEntryController({ ...options, locator: options.locator ?? createLastProjectController() });
}
