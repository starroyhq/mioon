/** Quit keeps the backend alive until renderer beforeunload has actually allowed close. */
export type QuitState = 'idle' | 'requesting' | 'stopping' | 'finished';
interface QuitWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
  close(): void;
}
interface QuitOptions<W extends QuitWindow> {
  getWindow(): W | null | undefined;
  stop(): unknown | Promise<unknown>;
  finish(): unknown;
}
interface PreventableEvent {
  preventDefault(): void;
}
interface GuardContents {
  on(event: 'will-prevent-unload', listener: (event: PreventableEvent) => void): unknown;
}
interface GuardWindow {
  readonly webContents: GuardContents;
}
interface DrainWindow {
  on(event: 'close', listener: (event: PreventableEvent) => void): unknown;
  isDestroyed(): boolean;
  close(): void;
}

export class QuitCoordinator<W extends QuitWindow = QuitWindow> {
  state: QuitState = 'idle';
  pending: Promise<boolean> | undefined;
  cancelClose: (() => void) | null = null;
  private readonly getWindow: () => W | null | undefined;
  private readonly stop: () => unknown | Promise<unknown>;
  private readonly finish: () => unknown;

  constructor({ getWindow, stop, finish }: QuitOptions<W>) {
    this.getWindow = getWindow;
    this.stop = stop;
    this.finish = finish;
  }
  request(): Promise<boolean> {
    if (this.state !== 'idle') return this.pending!;
    this.state = 'requesting';
    this.pending = (async (): Promise<boolean> => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        const allowed = await new Promise<boolean>(resolve => {
          const closed = () => { this.cancelClose = null; resolve(true); };
          this.cancelClose = () => { win.removeListener('closed', closed); this.cancelClose = null; resolve(false); };
          win.once('closed', closed);
          win.close();
        });
        if (!allowed) { this.state = 'idle'; return false; }
      }
      this.state = 'stopping';
      await this.stop();
      this.state = 'finished';
      this.finish();
      return true;
    })().catch(error => { this.state = 'idle'; throw error; });
    return this.pending;
  }
  cancel() { if (this.state === 'requesting') this.cancelClose?.(); }
}

export function installUnsavedGuard(win: GuardWindow, { confirmDiscard, onCancel }: {
  confirmDiscard(): boolean;
  onCancel(): void;
}): void {
  win.webContents.on('will-prevent-unload', event => {
    // In Electron, preventing this event explicitly overrides renderer beforeunload.
    if (confirmDiscard()) event.preventDefault();
    else onCancel();
  });
}

/** Keep the renderer alive just long enough to finish ordinary preference HTTP.
 * This is a main-to-page lifecycle request, never a renderer-to-native API.
 * Failure is bounded and lets the user either close or keep the window open.
 */
export function installPreferencesCloseDrain(win: DrainWindow, { flush, confirmClose, onCancel, timeoutMs = 1500 }: {
  flush(): unknown | Promise<unknown>;
  confirmClose(): boolean | Promise<boolean>;
  onCancel(): void;
  timeoutMs?: number;
}): void {
  let draining = false, allowOnce = false;
  win.on('close', event => {
    if (allowOnce) { allowOnce = false; return; }
    event.preventDefault();
    if (draining) return;
    draining = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    void Promise.race([Promise.resolve().then(flush).then(result => result === true, () => false), deadline])
      .then(async saved => {
        clearTimeout(timer);
        if (win.isDestroyed()) return;
        const close = saved || await confirmClose();
        draining = false;
        if (win.isDestroyed()) return;
        if (close) { allowOnce = true; win.close(); }
        else onCancel();
      }).catch(() => {
        clearTimeout(timer); draining = false;
        if (!win.isDestroyed()) onCancel();
      });
  });
}
