type Listener = (...args: unknown[]) => void;
interface Events { on(event: string, listener: Listener): unknown; removeListener(event: string, listener: Listener): unknown }
interface EmptyWindow extends Events { isDestroyed(): boolean; close(): void; webContents: Events & { readonly mainFrame: object; getURL(): string; loadURL(url: string): Promise<unknown> } }
/** Only an exact, never-committed empty document may bypass renderer admission.
 * Failed reloads and unresponsive/gone application documents retain P0. */
export function observeInitialProjectLoad(window: EmptyWindow, assignedURL: string, isCurrent: () => boolean) {
  const contents = window.webContents;
  let generation = 0, committed = false, disposed = false, failed = false;
  let closePermit: (() => boolean) | null = null;
  const started: Listener = (details, _url, sameDocument, mainFrame) => {
    const d = details && typeof details === 'object' ? details as Record<string, unknown> : null;
    if ((d && 'isMainFrame' in d ? d.isMainFrame : mainFrame) === false ||
        (d && 'isSameDocument' in d ? d.isSameDocument : sameDocument) === true) return;
    generation++; failed = false; closePermit = null;
  };
  const navigated: Listener = () => { committed = true; failed = false; closePermit = null; };
  const valid = () => { try { return !disposed && !committed && !window.isDestroyed() && isCurrent() && ['', 'about:blank'].includes(contents.getURL()); } catch { return false; } };
  contents.on('did-start-navigation', started); contents.on('did-navigate', navigated);
  const api = {
    captureFailure() {
      if (!valid()) return null;
      failed = true;
      const epoch = generation, frame = contents.mainFrame;
      let consumed = false;
      const current = () => !consumed && failed && generation === epoch && valid() && contents.mainFrame === frame;
      return Object.freeze({
        isCurrent: current,
        async retry() { if (!current()) return false; consumed = true; failed = false; await contents.loadURL(assignedURL); return !disposed && isCurrent(); },
        close() {
          if (!current()) return false;
          // Native close consumes this exact proof synchronously; no renderer
          // executeJavaScript, input drain, business write or quit permission.
          closePermit = () => { if (!current()) return false; consumed = true; return true; };
          try { window.close(); return consumed; } finally { consumed = true; closePermit = null; }
        },
      });
    },
    consumeClose() { const permit = closePermit; closePermit = null; return permit?.() === true; },
    get failed() { return failed; },
    dispose() { disposed = true; closePermit = null; contents.removeListener('did-start-navigation', started); contents.removeListener('did-navigate', navigated); },
  };
  window.on('closed', api.dispose);
  return api;
}

export interface ProjectRendererRecovery {
  claimPrompt(): boolean; reload(): Promise<unknown>; exit(): Promise<unknown>; takePendingIncident(): boolean;
}
/** One prompt per exact window/context. An A-window dialog cannot overwrite B's
 * incident or suppress a later A incident; all replies recheck current owner. */
export function createProjectRendererRecovery<W extends object, C extends object>(options: {
  isCurrent(window: W, context: C): boolean;
  capture(window: W): ProjectRendererRecovery | null | undefined;
  prompt(window: W): Promise<number>;
}) {
  const pending = new WeakMap<W, { context: C }>();
  const run = async (window: W, context: C, reason: 'incident' | 'load-error' = 'incident'): Promise<void> => {
    if (!options.isCurrent(window, context) || pending.get(window)?.context === context) return;
    const recovery = options.capture(window); if (!recovery || reason === 'incident' && !recovery.claimPrompt()) return;
    const owner = { context }; pending.set(window, owner);
    try {
      const result = await options.prompt(window);
      if (!options.isCurrent(window, context) || pending.get(window) !== owner) return;
      if (result === 0) await recovery.reload(); else if (result === 1) await recovery.exit();
    } catch (error) { if (options.isCurrent(window, context) && pending.get(window) === owner) throw error; }
    finally {
      if (pending.get(window) === owner) {
        pending.delete(window);
        if (options.isCurrent(window, context) && recovery.takePendingIncident()) await run(window, context);
      }
    }
  };
  return run;
}

/** Dead backend retains live window/P0 ownership, while denying new interaction.
 * Only a newly created backend scope can reset this terminal observation. */
export function createProjectBackendIncident() {
  let failed = false, prompted = false;
  return {
    get failed() { return failed; }, fail() { failed = true; },
    assertAlive() {
      if (failed) throw Object.assign(new Error('本地服务在窗口准备完成前已停止'), { code: 'BACKEND_START_EXITED' });
    },
    claimPrompt() { if (prompted) return false; prompted = true; return true; },
  };
}
