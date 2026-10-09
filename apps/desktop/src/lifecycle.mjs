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
