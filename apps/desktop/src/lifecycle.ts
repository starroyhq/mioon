/** Quit keeps the backend alive until renderer beforeunload has actually allowed close. */
export class QuitCoordinator {
  constructor({ getWindow, stop, finish }) {
    Object.assign(this, { getWindow, stop, finish });
    this.state = 'idle';
  }
  request() {
    if (this.state !== 'idle') return this.pending;
    this.state = 'requesting';
    this.pending = (async () => {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        const allowed = await new Promise(resolve => {
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

export function installUnsavedGuard(win, { confirmDiscard, onCancel }) {
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
export function installPreferencesCloseDrain(win, { flush, confirmClose, onCancel, timeoutMs = 1500 }) {
  let draining = false, allowOnce = false;
  win.on('close', event => {
    if (allowOnce) { allowOnce = false; return; }
    event.preventDefault();
    if (draining) return;
    draining = true;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
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
