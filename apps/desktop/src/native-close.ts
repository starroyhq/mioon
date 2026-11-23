/** Native close admission carries only bounded lifecycle metadata. It exposes no
 * IPC, filesystem, credential, provider, or business-operation capability. */
export interface NativeCloseInspection {
  readonly version: 1 | 2;
  readonly token: string;
  readonly disposition: 'clean' | 'dirty' | 'blocked' | 'unknown' | 'unknown-dirty';
  /** Bounded quit work summary; present only in version 2. */
  readonly work?: readonly NativeQuitWorkItem[];
}
export type NativeCloseBlockReason = 'blocked' | 'unavailable' | 'changed';
export type NativeCloseAction = 'close' | 'reload';
export const NATIVE_QUIT_WORK_KINDS = Object.freeze(['export', 'preview', 'generation', 'mio', 'import', 'pending', 'unknown'] as const);
export type NativeQuitWorkKind = typeof NATIVE_QUIT_WORK_KINDS[number];
export interface NativeQuitWorkItem { readonly kind: NativeQuitWorkKind; readonly count: number; readonly unknown?: boolean }
type Listener = (...args: unknown[]) => void;
interface EventSource {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
interface NativeCloseWindow extends EventSource {
  isDestroyed(): boolean;
  close(): void;
  destroy?(): void;
  webContents: EventSource & {
    getURL(): string;
    loadURL(url: string): Promise<unknown>;
    executeJavaScript(code: string): Promise<unknown>;
  };
}
interface NativeCloseOptions {
  /** True while the application-wide Quit coordinator owns these closes. */
  isQuitRequest?(): boolean;
  /** System shutdown/logout/reboot: autosave only, no 12-26 work prompt. */
  isSystemShutdown?(): boolean;
  /** Native 12-26 work decision. True exits; false cancels the whole quit. */
  onQuitWork?(work: readonly NativeQuitWorkItem[], facts: {readonly dirty: boolean; readonly unknown: boolean}): boolean | Promise<boolean>;
  /** Native 12-26 work decision for an ordinary window close. True closes it. */
  onCloseWork?(work: readonly NativeQuitWorkItem[], facts: {readonly dirty: boolean; readonly unknown: boolean}): boolean | Promise<boolean>;
  /** Native 12-26b decision for a page that did not answer the quit probe. */
  onQuitUnresponsive?(): 'quit' | 'wait' | Promise<'quit' | 'wait'>;
  /** The user chose quit and no renderer answer can be obtained. */
  forceClose?(): void;
  quitInspectTimeoutMs?: number;
  quitFlushTimeoutMs?: number;
  /** The captured BrowserWindow, startup, backend, session and allowed origin. */
  isCurrent(): boolean;
  /** Synchronous presentation dependency, separate from window ownership. A
   * modal child may temporarily prevent this parent's close/reload while the
   * parent still owns renderer incidents and confirmed-gone recovery proof. */
  canAct?(action: NativeCloseAction): boolean;
  confirmDiscard(action: NativeCloseAction): boolean | Promise<boolean>;
  confirmClose(action: NativeCloseAction): boolean | Promise<boolean>;
  /** A separate, default-cancel risk decision. Never substitutes for ordinary
   * dirty confirmation and never permits reload or changes business state. */
  confirmUnknown?(): boolean | Promise<boolean>;
  onBlocked(reason: NativeCloseBlockReason, action: NativeCloseAction): unknown;
  /** Must ignore a replaced window/backend. Also called when an initial close
   * is rejected before the current document has an allowed application URL. */
  onCancel(): void;
  /** Presentation/registry metadata only; never admission or a close permit. */
  onCloseStateChange?(state: 'closing' | 'retained'): void;
  /** Invoke the existing owner-scoped QuitCoordinator synchronously. Its promise
   * remains responsible for backend shutdown only after the window is closed. */
  requestQuit(): unknown;
  /** Exact never-committed blank-window close proof, owned by native startup. */
  consumeInitialEmptyClose?(): boolean;
  /** Retire only this document's native resources before taking a fresh P0
   * snapshot. Abort ends observation, never proves cleanup or resumes playback. */
  beforeReload?(signal: AbortSignal): boolean | Promise<boolean>;
  reloadPreparationTimeoutMs?: number;
  timeoutMs?: number;
}
interface Attempt {
  readonly id: number;
  readonly document: number;
  readonly abort: AbortController;
  readonly action: NativeCloseAction;
  readonly sourceUrl: string;
  readonly targetUrl: string | null;
  readonly result: Promise<boolean>;
  readonly resolve: (accepted: boolean) => void;
  readonly reject: (error: unknown) => void;
  quit?: boolean;
  reloadStarted?: boolean;
  reloadNavigationSeen?: boolean;
  committedDocument?: number;
  token: string | null;
  expiresAt?: number;
  closingTimer?: ReturnType<typeof setTimeout>;
}
interface GoneProof { readonly document: number; readonly sourceUrl: string }
interface GoneExitAllowance { readonly proof: GoneProof; readonly serial: number; consumed: boolean }
interface RendererIncident {
  readonly document: number;
  readonly serial: number;
  readonly sourceUrl: string;
  readonly confirmedGone: boolean;
  prompted: boolean;
}
type BoundedResult = { ok: true; value: unknown } | { ok: false };
const DEFAULT_TIMEOUT_MS = 1500;
const QUIT_INSPECT_TIMEOUT_MS = 5000;
const QUIT_FLUSH_TIMEOUT_MS = 3000;
const RELOAD_PREPARATION_TIMEOUT_MS = 10000;
const flushScript = "typeof globalThis.__mioonFlushWorkspacePreferences === 'function' ? globalThis.__mioonFlushWorkspacePreferences() : false";
const inspectScript = (action: NativeCloseAction, targetUrl: string | null) =>
  `typeof globalThis.__mioonNativeCloseAdmission?.inspect === 'function' ? globalThis.__mioonNativeCloseAdmission.inspect(${JSON.stringify(action)},${JSON.stringify(targetUrl)}) : null`;
const checkSavedScript = "typeof globalThis.__mioonNativeCloseAdmission?.isSavedForUpdate === 'function' && globalThis.__mioonNativeCloseAdmission.isSavedForUpdate() === true";

function quitWork(value: unknown): readonly NativeQuitWorkItem[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const seen = new Set<string>(), result: NativeQuitWorkItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some(key => !['kind', 'count', 'unknown'].includes(key)) ||
        !NATIVE_QUIT_WORK_KINDS.includes(record.kind as NativeQuitWorkKind) || !Number.isSafeInteger(record.count) ||
        (record.count as number) < 1 || (record.count as number) > 999 ||
        record.unknown !== undefined && typeof record.unknown !== 'boolean' || seen.has(record.kind as string)) return null;
    seen.add(record.kind as string);
    result.push(Object.freeze({kind: record.kind as NativeQuitWorkKind, count: record.count as number,
      ...(record.unknown === true ? {unknown: true} : {})}));
  }
  return Object.freeze(result);
}
function inspection(value: unknown): NativeCloseInspection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (version !== 1 && version !== 2 || !['version', 'token', 'disposition'].every(key => Object.hasOwn(record, key)) ||
      Object.keys(record).some(key => !['version', 'token', 'disposition'].includes(key) && !(version === 2 && key === 'work')) ||
      typeof record.token !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.token) ||
      !['clean', 'dirty', 'blocked', 'unknown', 'unknown-dirty'].includes(record.disposition as string)) return null;
  const work = version === 2 ? quitWork(record.work) : null;
  if (version === 2 && work === null) return null;
  return {version, token: record.token, disposition: record.disposition as NativeCloseInspection['disposition'],
    ...(work === null ? {} : {work})};
}

/** A deadline abandons observation, never retries or cancels a business write.
 * The action's eventual rejection/result is observed but cannot resume a close. */
function bounded(action: () => Promise<unknown>, signal: AbortSignal, expiresAt: number): Promise<BoundedResult> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(result);
    };
    const aborted = () => finish({ ok: false });
    if (signal.aborted || Date.now() >= expiresAt) { finish({ ok: false }); return; }
    signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(aborted, Math.max(0, expiresAt - Date.now()));
    void Promise.resolve().then(() => signal.aborted ? undefined : action()).then(
      value => finish(!signal.aborted && Date.now() < expiresAt ? { ok: true, value } : { ok: false }),
      () => finish({ ok: false }),
    );
  });
}

/** Single-window protocol. Renderer vetoes are final for each attempt. All
 * discard dialogs precede a final renderer validation and one-shot ticket; the
 * renderer must validate that ticket again synchronously during beforeunload. */
export function installNativeCloseAdmission(win: NativeCloseWindow, options: NativeCloseOptions) {
  const contents = win.webContents;
  const configuredTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configuredTimeout))) : DEFAULT_TIMEOUT_MS;
  const configuredPreparation = options.reloadPreparationTimeoutMs ?? RELOAD_PREPARATION_TIMEOUT_MS;
  const preparationTimeoutMs = Number.isFinite(configuredPreparation)
    ? Math.max(1, Math.min(RELOAD_PREPARATION_TIMEOUT_MS, Math.floor(configuredPreparation))) : RELOAD_PREPARATION_TIMEOUT_MS;
  let documentGeneration = 0, serial = 0, disposed = false;
  let active: Attempt | null = null;
  let allowOnce: Attempt | null = null;
  const loading = new Set<Attempt>();
  let goneProof: GoneProof | null = null;
  let goneExit: GoneExitAllowance | null = null;
  let rendererIncident: RendererIncident | null = null;
  let recoveryDocument = 0;
  const ownsWindow = () => {
    try { return !disposed && !win.isDestroyed() && options.isCurrent(); }
    catch { return false; }
  };
  const canAct = (action: NativeCloseAction) => {
    try { return options.canAct ? options.canAct(action) === true : true; }
    catch { return false; }
  };
  const readUrl = (): string | null => {
    if (!ownsWindow()) return null;
    try {
      const url = contents.getURL();
      return typeof url === 'string' && url.length > 0 && url.length <= 8192 ? url : null;
    } catch { return null; }
  };
  const ownsGeneration = (attempt: Attempt) => ownsWindow() && attempt.document === documentGeneration;
  const ownsDocument = (attempt: Attempt) => ownsGeneration(attempt) && readUrl() === attempt.sourceUrl;
  const current = (attempt: Attempt) => active === attempt && attempt.id === serial && !attempt.abort.signal.aborted && ownsDocument(attempt) && canAct(attempt.action);
  const currentLoad = (attempt: Attempt) => loading.has(attempt) && ownsWindow() && attempt.id === serial &&
    attempt.committedDocument === documentGeneration && readUrl() === attempt.sourceUrl;
  const abortedNavigation = (error: unknown) => Boolean(error && typeof error === 'object' &&
    (('code' in error && error.code === 'ERR_ABORTED') || ('errno' in error && error.errno === -3)));
  function retireLoadObservers() {
    for (const attempt of loading) attempt.resolve(false);
    loading.clear();
  }
  function revoke(attempt: Attempt) {
    if (!attempt.token || !ownsDocument(attempt)) return;
    const token = JSON.stringify(attempt.token);
    // Cleanup cannot authorize anything, and is intentionally best effort. An
    // absolute commit deadline also prevents a late script from arming a ticket.
    try { void contents.executeJavaScript(`typeof globalThis.__mioonNativeCloseAdmission?.cancel === 'function' ? globalThis.__mioonNativeCloseAdmission.cancel(${token}) : false`).catch(() => {}); }
    catch { /* Renderer loss already leaves native admission cancelled. */ }
  }
  function cancel(attempt: Attempt, reason?: NativeCloseBlockReason) {
    if (active !== attempt) return;
    active = null; allowOnce = null;
    attempt.abort.abort();
    if (attempt.closingTimer !== undefined) clearTimeout(attempt.closingTimer);
    revoke(attempt);
    attempt.resolve(false);
    // A replaced window/document must never cancel a newer owner's quit.
    if (!ownsGeneration(attempt)) return;
    if (attempt.action === 'close') { try { options.onCloseStateChange?.('retained'); } catch { /* Metadata cannot change admission. */ } }
    try { options.onCancel(); } catch { /* Cancellation remains final. */ }
    if (reason && ownsGeneration(attempt)) {
      try { void Promise.resolve(options.onBlocked(reason, attempt.action)).catch(() => {}); }
      catch { /* An unavailable notice is not permission to close. */ }
    }
  }
  function forceQuit(attempt: Attempt): void {
    if (active !== attempt) return;
    active = null; allowOnce = null;
    attempt.abort.abort();
    if (attempt.closingTimer !== undefined) clearTimeout(attempt.closingTimer);
    revoke(attempt);
    attempt.resolve(true);
    try { options.forceClose?.(); } catch { /* The window may already be gone. */ }
  }
  async function quitUnresponsive(attempt: Attempt): Promise<void> {
    let decision: 'quit' | 'wait' = 'quit';
    try {
      decision = await (options.onQuitUnresponsive?.() ?? 'quit');
    } catch { decision = 'quit'; }
    if (active !== attempt) return;
    if (decision === 'quit') forceQuit(attempt);
    else cancel(attempt);
  }
  async function proceedQuit(attempt: Attempt): Promise<void> {
    try {
      const startedAt = Date.now();
      const flushMs = Math.max(1, Math.min(QUIT_FLUSH_TIMEOUT_MS, Math.floor(options.quitFlushTimeoutMs ?? QUIT_FLUSH_TIMEOUT_MS)));
      const drained = await bounded(() => contents.executeJavaScript(flushScript), attempt.abort.signal, Date.now() + flushMs);
      if (!current(attempt)) { cancel(attempt); return; }
      const saved = drained.ok && drained.value === true;
      const inspectMs = Math.max(1, Math.min(QUIT_INSPECT_TIMEOUT_MS, Math.floor(options.quitInspectTimeoutMs ?? QUIT_INSPECT_TIMEOUT_MS)));
      // The 5-second “page did not answer” budget starts when Quit starts, not
      // after the 3-second autosave. A slow save cannot move the unresponsive
      // dialog past the documented deadline.
      const inspectDeadline = Math.min(startedAt + inspectMs, Date.now() + inspectMs);
      const shutdown = options.isSystemShutdown?.() === true;
      const inspected = await bounded(() => contents.executeJavaScript(inspectScript('close', null)), attempt.abort.signal, inspectDeadline);
      if (!current(attempt)) { cancel(attempt); return; }
      const captured = inspected.ok ? inspection(inspected.value) : null;
      if (!captured) {
        if (shutdown) forceQuit(attempt); else await quitUnresponsive(attempt);
        return;
      }
      attempt.token = captured.token;
      const dirty = captured.disposition === 'dirty' || captured.disposition === 'unknown-dirty';
      const unknown = captured.disposition === 'unknown' || captured.disposition === 'unknown-dirty';
      if (dirty && !saved) {
        if (!options.confirmDiscard) { cancel(attempt); return; }
        const accepted = await options.confirmDiscard('close');
        if (!current(attempt)) { cancel(attempt); return; }
        if (accepted !== true) { cancel(attempt); return; }
      }
      let work = captured.work ?? [];
      // A renderer that could report only `blocked` still gets a truthful exit
      // row instead of the old one-button dead end.
      if (work.length === 0 && ['blocked', 'unknown', 'unknown-dirty'].includes(captured.disposition)) work = [{kind: 'pending', count: 1}];
      if (!current(attempt)) { cancel(attempt); return; }
      if (work.length > 0 && !shutdown) {
        if (!options.onQuitWork) { await quitUnresponsive(attempt); return; }
        const accepted = await options.onQuitWork(work, {dirty, unknown});
        if (!current(attempt)) { cancel(attempt); return; }
        if (accepted !== true) { cancel(attempt); return; }
      }
      forceQuit(attempt);
    } catch { cancel(attempt); }
  }
  async function proceedWindowWork(attempt: Attempt, captured: NativeCloseInspection): Promise<void> {
    try {
      const drained = await bounded(() => contents.executeJavaScript(flushScript), attempt.abort.signal, Date.now() + QUIT_FLUSH_TIMEOUT_MS);
      if (!current(attempt)) { cancel(attempt); return; }
      const saved = drained.ok && drained.value === true;
      const dirty = captured.disposition === 'dirty' || captured.disposition === 'unknown-dirty';
      if (dirty && !saved) {
        if (!options.confirmDiscard) { cancel(attempt); return; }
        const accepted = await options.confirmDiscard('close');
        if (!current(attempt)) { cancel(attempt); return; }
        if (accepted !== true) { cancel(attempt); return; }
      }
      let work = captured.work ?? [];
      if (work.length === 0) work = [{kind: 'pending', count: 1}];
      if (!options.onCloseWork) { cancel(attempt, 'blocked'); return; }
      const accepted = await options.onCloseWork(work, {dirty, unknown: captured.disposition === 'unknown' || captured.disposition === 'unknown-dirty'});
      if (!current(attempt)) { cancel(attempt); return; }
      if (accepted === true) forceQuit(attempt); else cancel(attempt);
    } catch { cancel(attempt); }
  }
  async function loadCurrentUrl(attempt: Attempt) {
    if (!current(attempt)) { cancel(attempt); return; }
    attempt.reloadStarted = true;
    try {
      await contents.loadURL(attempt.targetUrl!);
    } catch (error) {
      if (attempt.committedDocument !== undefined) {
        const owned = currentLoad(attempt);
        loading.delete(attempt);
        if (!owned || abortedNavigation(error)) attempt.resolve(false);
        else attempt.reject(error);
        return;
      }
      if (!current(attempt)) { cancel(attempt); return; }
      if (abortedNavigation(error)) { cancel(attempt); return; }
      active = null; allowOnce = null; attempt.abort.abort(); revoke(attempt);
      attempt.reject(error);
      return;
    }
    if (attempt.committedDocument !== undefined) {
      const owned = currentLoad(attempt);
      loading.delete(attempt); attempt.resolve(owned);
      return;
    }
    if (!current(attempt)) { cancel(attempt); return; }
    active = null; attempt.abort.abort(); documentGeneration++;
    attempt.resolve(true);
  }
  async function proceed(attempt: Attempt) {
    try {
      if (attempt.action === 'reload' && options.beforeReload) {
        const prepared = await bounded(() => Promise.resolve(options.beforeReload!(attempt.abort.signal)),
          attempt.abort.signal, Date.now() + preparationTimeoutMs);
        if (!current(attempt)) { cancel(attempt); return; }
        if (!prepared.ok || prepared.value !== true) { cancel(attempt, 'unavailable'); return; }
      }
      // Retirement may have taken time and input may have changed. Inspect only
      // now; its final ticket still gets the original independent 1.5s lease.
      const result = await bounded(() => contents.executeJavaScript(inspectScript(attempt.action, attempt.targetUrl)), attempt.abort.signal, Date.now() + timeoutMs);
      if (!current(attempt)) { cancel(attempt); return; }
      const captured = result.ok ? inspection(result.value) : null;
      if (!captured) { cancel(attempt, 'unavailable'); return; }
      attempt.token = captured.token;
      if (captured.disposition === 'blocked') {
        if (attempt.action === 'close' && options.onCloseWork) { await proceedWindowWork(attempt, captured); return; }
        cancel(attempt, 'blocked'); return;
      }

      const unknown = captured.disposition === 'unknown' || captured.disposition === 'unknown-dirty';
      let saved = true;
      if (unknown) {
        if (attempt.action !== 'close') { cancel(attempt, 'blocked'); return; }
        if (!options.confirmUnknown) { cancel(attempt, 'unavailable'); return; }
        const accepted = await options.confirmUnknown();
        if (!current(attempt)) { cancel(attempt); return; }
        if (accepted !== true) { cancel(attempt); return; }
        // Explicit unknown-result exit performs zero drains/writes/retries.
        // The renderer must revalidate the exact owner/version/operation both
        // before arming and during its final synchronous beforeunload.
      } else {
        const drained = await bounded(() => contents.executeJavaScript(flushScript), attempt.abort.signal, Date.now() + timeoutMs);
        if (!current(attempt)) { cancel(attempt); return; }
        saved = drained.ok && drained.value === true;
        if (!saved) {
          const accepted = await options.confirmClose(attempt.action);
          if (!current(attempt)) { cancel(attempt); return; }
          if (accepted !== true) { cancel(attempt); return; }
        }
      }
      let discardDirty = false;
      if (captured.disposition === 'dirty' || captured.disposition === 'unknown-dirty') {
        // This decision covers only the renderer capture, never later input.
        discardDirty = await options.confirmDiscard(attempt.action) === true;
        if (!current(attempt)) { cancel(attempt); return; }
        if (!discardDirty) { cancel(attempt); return; }
      }
      if (!current(attempt)) { cancel(attempt); return; }
      const expiresAt = Date.now() + timeoutMs;
      const token = JSON.stringify(captured.token);
      const commitScript = `typeof globalThis.__mioonNativeCloseAdmission?.commit === 'function' ? globalThis.__mioonNativeCloseAdmission.commit(${token}, {discardDirty:${discardDirty},allowDrainFailure:${!saved},${unknown ? 'allowUnknown:true,' : ''}expiresAt:${expiresAt},action:${JSON.stringify(attempt.action)},targetUrl:${JSON.stringify(attempt.targetUrl)}}) : false`;
      const committed = await bounded(() => contents.executeJavaScript(commitScript), attempt.abort.signal, expiresAt);
      if (!current(attempt)) { cancel(attempt); return; }
      if (!committed.ok || committed.value !== true || Date.now() >= expiresAt) { cancel(attempt, 'changed'); return; }
      // Keep ownership until closed or vetoed, including the IPC gap between this
      // call and the renderer's final synchronous beforeunload validation.
      attempt.expiresAt = expiresAt;
      if (attempt.action === 'reload') {
        await loadCurrentUrl(attempt);
        return;
      }
      allowOnce = attempt;
      attempt.closingTimer = setTimeout(() => cancel(attempt, 'changed'), Math.max(0, expiresAt - Date.now()));
      win.close();
    } catch {
      cancel(attempt, 'unavailable');
    }
  }
  function begin(action: Attempt['action'], sourceUrl: string, mode: 'admit' | 'gone-reload' | 'gone-close' = 'admit'): Attempt {
    // A new user action supersedes observation of any older page load, without
    // cancelling its browser/network work or reusing its unload permission.
    retireLoadObservers();
    goneProof = null;
    goneExit = null;
    rendererIncident = null;
    let resolve!: Attempt['resolve'], reject!: Attempt['reject'];
    const result = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
    const attempt: Attempt = { id: ++serial, document: documentGeneration, abort: new AbortController(), token: null,
      action, sourceUrl, targetUrl: action === 'reload' ? sourceUrl : null, result, resolve, reject,
      quit: action === 'close' && options.isQuitRequest?.() === true };
    active = attempt;
    if (action === 'close') { try { options.onCloseStateChange?.('closing'); } catch { /* Metadata cannot change admission. */ } }
    if (mode === 'gone-reload') void loadCurrentUrl(attempt).catch(() => cancel(attempt, 'unavailable'));
    else if (mode === 'gone-close') {
      attempt.expiresAt = Date.now() + timeoutMs;
      attempt.closingTimer = setTimeout(() => cancel(attempt, 'changed'), timeoutMs);
    }
    else if (attempt.quit) void proceedQuit(attempt);
    else void proceed(attempt);
    return attempt;
  }
  const onClose: Listener = event => {
    if (!canAct('close')) {
      (event as { preventDefault(): void }).preventDefault();
      if (active) cancel(active);
      else { try { options.onCancel(); } catch { /* A rejected parent close cannot keep Quit waiting. */ } }
      return;
    }
    if (!active && !allowOnce && options.consumeInitialEmptyClose?.() === true) return;
    if (goneExit) {
      const allowance = goneExit;
      goneExit = null;
      if (!active && ownsWindow() && allowance.serial === serial && allowance.proof.document === documentGeneration &&
          allowance.proof.sourceUrl === readUrl()) {
        allowance.consumed = true;
        begin('close', allowance.proof.sourceUrl, 'gone-close');
        return;
      }
      (event as { preventDefault(): void }).preventDefault();
      try { options.onCancel(); } catch { /* Invalid recovery decisions stay cancelled. */ }
      return;
    }
    if (allowOnce && current(allowOnce) && Date.now() < (allowOnce.expiresAt ?? 0)) { allowOnce = null; return; }
    (event as { preventDefault(): void }).preventDefault();
    allowOnce = null;
    if (active) {
      if (!current(active)) cancel(active);
      else if (active.action === 'reload') {
        // A close cannot borrow a reload's approval or leave QuitCoordinator
        // waiting for a window that this attempt will never close.
        try { options.onCancel(); } catch { /* The extra close stays cancelled. */ }
      }
      else if (active.expiresAt !== undefined && Date.now() >= active.expiresAt) cancel(active, 'changed');
      return;
    }
    if (!ownsWindow()) {
      // The initial about:blank/loading window can still own a pending quit.
      // Its URL is not probeable yet, but that quit must settle as cancelled.
      // The caller's captured-owner check prevents touching a replacement.
      try { options.onCancel(); } catch { /* The rejected close stays cancelled. */ }
      return;
    }
    const sourceUrl = readUrl();
    if (!sourceUrl) { try { options.onCancel(); void Promise.resolve(options.onBlocked('unavailable', 'close')).catch(() => {}); } catch { /* Stay open. */ } return; }
    begin('close', sourceUrl);
  };
  const onVeto: Listener = () => {
    // NEVER preventDefault here: Electron interprets it as overriding the
    // renderer veto. In particular, no generic discard prompt is safe here.
    if (active) cancel(active, 'changed');
  };
  const onNavigation: Listener = (details, legacyUrl, _inPlace, legacyIsMainFrame) => {
    const mainFrame = details && typeof details === 'object' && 'isMainFrame' in details
      ? (details as { isMainFrame: unknown }).isMainFrame : legacyIsMainFrame;
    if (mainFrame === false) return;
    goneProof = null;
    goneExit = null;
    rendererIncident = null; recoveryDocument++;
    const url = details && typeof details === 'object' && 'url' in details
      ? (details as { url: unknown }).url : legacyUrl;
    if (active?.action === 'reload' && active.reloadStarted && !active.reloadNavigationSeen &&
        current(active) && url === active.targetUrl) {
      active.reloadNavigationSeen = true;
      return;
    }
    // Cancel while the old document still owns the attempt, before advancing.
    if (active) cancel(active);
    retireLoadObservers();
    documentGeneration++;
  };
  const onDocumentCommitted: Listener = (details, legacyUrl) => {
    goneProof = null;
    goneExit = null;
    rendererIncident = null; recoveryDocument++;
    const url = details && typeof details === 'object' && 'url' in details
      ? (details as { url: unknown }).url : legacyUrl;
    if (active?.action === 'reload' && active.reloadStarted && active.reloadNavigationSeen &&
        current(active) && url === active.targetUrl) {
      // did-navigate is main-frame document commit, earlier than the completion
      // of load-blocking resources. The old document's ticket is gone. Retire
      // admission now so a responsive new page can admit a fresh native close.
      const attempt = active;
      active = null; allowOnce = null; attempt.abort.abort();
      attempt.committedDocument = ++documentGeneration;
      loading.add(attempt);
      return;
    }
    if (active) cancel(active);
    retireLoadObservers(); documentGeneration++;
  };
  function invalidateRenderer(confirmedGone: boolean) {
    const wasOwned = ownsWindow(), sourceUrl = readUrl();
    // One unchanged process/document has one incident. A confirmed loss can
    // promote a live hang once; duplicate gone or late unresponsive events do
    // not mint fresh authority or repeatedly reopen a dismissed prompt.
    if (wasOwned && rendererIncident?.document === documentGeneration && rendererIncident.serial === serial &&
        rendererIncident.sourceUrl === sourceUrl && (rendererIncident.confirmedGone || !confirmedGone)) return;
    goneExit = null;
    if (active) cancel(active, 'unavailable');
    retireLoadObservers();
    documentGeneration++;
    goneProof = confirmedGone && wasOwned && ownsWindow() && sourceUrl && sourceUrl === readUrl()
      ? { document: documentGeneration, sourceUrl } : null;
    rendererIncident = wasOwned && ownsWindow() && sourceUrl && sourceUrl === readUrl()
      ? { document: documentGeneration, serial, sourceUrl, confirmedGone, prompted: false } : null;
  }
  const onRendererGone: Listener = () => invalidateRenderer(true);
  const onUnresponsive: Listener = () => invalidateRenderer(false);
  const onResponsive: Listener = () => {
    if (rendererIncident && !rendererIncident.confirmedGone) {
      rendererIncident = null; documentGeneration++;
    }
  };
  const onClosed: Listener = () => {
    goneProof = null;
    goneExit = null;
    rendererIncident = null; recoveryDocument++;
    if (active) {
      active.abort.abort();
      if (active.closingTimer !== undefined) clearTimeout(active.closingTimer);
      active.resolve(active.action === 'close');
    }
    retireLoadObservers();
    active = null; allowOnce = null; documentGeneration++;
  };
  win.on('close', onClose);
  win.on('closed', onClosed);
  contents.on('will-prevent-unload', onVeto);
  contents.on('did-start-navigation', onNavigation);
  contents.on('did-navigate', onDocumentCommitted);
  contents.on('render-process-gone', onRendererGone);
  contents.on('unresponsive', onUnresponsive);
  contents.on('responsive', onResponsive);
  function requestReload(): Promise<boolean> {
    if (!canAct('reload')) {
      if (active) cancel(active);
      else { try { options.onCancel(); } catch { /* Dependency rejection never authorizes another action. */ } }
      return Promise.resolve(false);
    }
    if (active) return active.action === 'reload' ? active.result : Promise.resolve(false);
    if (!ownsWindow()) return Promise.resolve(false);
    const sourceUrl = readUrl();
    if (!sourceUrl) return Promise.resolve(false);
    return begin('reload', sourceUrl).result;
  }
  return {
    /** Presentation only: hiding must not conceal an in-flight native close or
     * reload. This state cannot grant or replace any admission ticket. */
    get pending() { return active !== null || loading.size !== 0; },
    async savedForUpdate(): Promise<boolean> {
      const url = readUrl(), generation = documentGeneration, observed = serial;
      if (!url || active || loading.size) return false;
      const result = await bounded(() => contents.executeJavaScript(checkSavedScript),
        new AbortController().signal, Date.now() + timeoutMs);
      return result.ok && result.value === true &&
        !active && !loading.size && generation === documentGeneration && observed === serial && readUrl() === url;
    },
    /** Only the captured, already-allowed current URL is reloadable. Callers
     * cannot supply a destination or repurpose a close approval. */
    requestReload,
    /** A never-shown editor may close after this exact renderer exits. A live
     * document still needs the ordinary close handshake. */
    closeConfirmedGone(): boolean {
      const proof = goneProof;
      if (!proof || active || !canAct('close') || !ownsWindow() ||
          proof.document !== documentGeneration || proof.sourceUrl !== readUrl()) return false;
      goneProof = null;
      const allowance: GoneExitAllowance = {proof, serial, consumed: false};
      goneExit = allowance;
      try { win.close(); return allowance.consumed; }
      finally { if (goneExit === allowance) goneExit = null; }
    },
    /** Capture at the existing recovery dialog's creation. Reload and Exit share
     * one explicit decision, so neither can replay or consume a newer incident.
     * A dead renderer has no surviving owner to inspect/drain; a live or merely
     * unresponsive page still passes through ordinary close/reload admission. */
    captureRecoveryDecision(): { reload(): Promise<boolean>; exit(): Promise<boolean>; claimPrompt(): boolean; takePendingIncident(): boolean } {
      const proof = goneProof, sourceUrl = readUrl(), document = documentGeneration, capturedSerial = serial;
      const incident = rendererIncident, capturedRecoveryDocument = recoveryDocument;
      let used = false, pendingChecked = false;
      const ownsCapture = () => ownsWindow() && Boolean(sourceUrl) && sourceUrl === readUrl() &&
        capturedRecoveryDocument === recoveryDocument && capturedSerial === serial && !active;
      const claim = (action: NativeCloseAction) => {
        if (used) return false;
        if (!ownsCapture() || document !== documentGeneration ||
            proof && (proof !== goneProof || proof.document !== document || proof.sourceUrl !== sourceUrl)) { used = true; return false; }
        // Reject before consuming the decision or confirmed-gone proof. Never
        // carry an Exit allowance across waiting for a modal child's close.
        if (!canAct(action)) { try { options.onCancel(); } catch { /* The parent remains owned and recoverable. */ } return false; }
        used = true;
        return true;
      };
      return {
        claimPrompt() {
          if (!ownsCapture() || document !== documentGeneration || !incident || incident !== rendererIncident || incident.prompted)
            return false;
          incident.prompted = true;
          return true;
        },
        takePendingIncident() {
          if (pendingChecked) return false;
          pendingChecked = true;
          // Only a recorded newer event can cause another prompt. Its decision
          // is captured afresh by main; no old Reload/Exit response is carried.
          return ownsCapture() && Boolean(rendererIncident && rendererIncident !== incident && !rendererIncident.prompted &&
            rendererIncident.document === documentGeneration && rendererIncident.serial === serial && rendererIncident.sourceUrl === sourceUrl);
        },
        reload() {
          if (!claim('reload') || !sourceUrl) return Promise.resolve(false);
          if (proof) { goneProof = null; return begin('reload', sourceUrl, 'gone-reload').result; }
          return requestReload();
        },
        exit() {
          if (!claim('close')) return Promise.resolve(false);
          if (!proof) return Promise.resolve(options.requestQuit()).then(result => result === true);
          goneProof = null;
          const allowance: GoneExitAllowance = { proof, serial: capturedSerial, consumed: false };
          goneExit = allowance;
          try {
            // QuitCoordinator calls this window's close synchronously. Permit
            // that exact close only; no arm survives to a later menu or event.
            const result = options.requestQuit();
            if (allowance.consumed) return Promise.resolve(result).then(accepted => accepted === true);
            void Promise.resolve(result).catch(() => {});
            return Promise.resolve(false);
          } finally {
            if (goneExit === allowance) goneExit = null;
          }
        },
      };
    },
    dispose() {
      if (active) cancel(active);
      retireLoadObservers();
      goneProof = null;
      goneExit = null;
      rendererIncident = null;
      disposed = true;
      win.removeListener('close', onClose); win.removeListener('closed', onClosed);
      contents.removeListener('will-prevent-unload', onVeto);
      contents.removeListener('did-start-navigation', onNavigation);
      contents.removeListener('did-navigate', onDocumentCommitted);
      contents.removeListener('render-process-gone', onRendererGone);
      contents.removeListener('unresponsive', onUnresponsive);
      contents.removeListener('responsive', onResponsive);
    },
  };
}
