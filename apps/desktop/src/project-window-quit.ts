/** Native Quit observes actual window closure. It never manufactures a renderer
 * admission, overrides beforeunload, destroys a window, or stops a live owner. */
type Listener = (...args: unknown[]) => void;
export interface ProjectQuitWindow {
  isDestroyed(): boolean;
  close(): void;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
export type ProjectQuitState = 'idle' | 'requesting' | 'stopping' | 'finished';
export interface ProjectWindowQuitOptions<W extends ProjectQuitWindow> {
  /** Current owners, including a handle awaiting its actual closed event.
   * Remove an owner only when that event has been observed. */
  getWindows(): readonly W[];
  stop(): unknown | Promise<unknown>;
  finish(): void;
  onStateChange?(state: ProjectQuitState): void;
}
interface CloseOwner<W> { window: W; closed: boolean; listener: Listener }
interface QuitAttempt<W> {
  owners: CloseOwner<W>[];
  active: CloseOwner<W> | null;
  resolve: (result: boolean) => void;
  reject: (error: unknown) => void;
}

export class MultiWindowQuitCoordinator<W extends ProjectQuitWindow = ProjectQuitWindow> {
  private options: ProjectWindowQuitOptions<W>;
  private attempt: QuitAttempt<W> | null = null;
  state: ProjectQuitState = 'idle';
  pending: Promise<boolean> | undefined;

  constructor(options: ProjectWindowQuitOptions<W>) { this.options = options; }

  get activeWindow(): W | null { return this.attempt?.active?.window ?? null; }

  private transition(state: ProjectQuitState) {
    this.state = state;
    try { this.options.onStateChange?.(state); } catch { /* Notification is not admission. */ }
  }

  request(source?: W): Promise<boolean> {
    if (this.state !== 'idle') return this.pending ?? Promise.resolve(false);
    const windows = [...new Set(this.options.getWindows())];
    if (source && !windows.includes(source)) return Promise.resolve(false);
    if (source) windows.splice(windows.indexOf(source), 1), windows.unshift(source);
    let resolve!: (result: boolean) => void, reject!: (error: unknown) => void;
    const pending = this.pending = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
    const attempt: QuitAttempt<W> = { owners: [], active: null, resolve, reject };
    this.attempt = attempt;
    // Set the fence before notifications, listeners, or the first close. Window
    // ownership remains valid while this creation/reveal permission is closed.
    this.transition('requesting');
    try {
      for (const window of windows) {
        const owner: CloseOwner<W> = { window, closed: false, listener: () => {} };
        owner.listener = () => {
          if (this.attempt !== attempt || this.state !== 'requesting') return;
          owner.closed = true;
          window.removeListener('closed', owner.listener);
          if (attempt.active === owner) this.advance(attempt);
        };
        attempt.owners.push(owner);
        window.on('closed', owner.listener);
      }
      // Do not introduce a promise/await boundary here. P0's confirmed-gone
      // allowance belongs to this exact originating window and this call stack.
      this.advance(attempt);
    } catch (error) { this.fail(attempt, error); }
    return pending;
  }

  private detach(attempt: QuitAttempt<W>) {
    for (const owner of attempt.owners) owner.window.removeListener('closed', owner.listener);
    attempt.active = null;
  }

  private advance(attempt: QuitAttempt<W>) {
    if (this.attempt !== attempt || this.state !== 'requesting') return;
    const next = attempt.owners.find(owner => !owner.closed);
    attempt.active = next ?? null;
    if (next) {
      // A pending close already has an exact owner. Unrelated window closure
      // cannot reissue its close or spend a second P0 ticket.
      if (!next.window.isDestroyed()) next.window.close();
      return;
    }
    this.detach(attempt);
    this.transition('stopping');
    void Promise.resolve().then(() => this.options.stop()).then(() => {
      if (this.attempt !== attempt) return;
      this.transition('finished');
      this.options.finish();
      this.attempt = null;
      attempt.resolve(true);
    }).catch(error => this.fail(attempt, error));
  }

  private fail(attempt: QuitAttempt<W>, error: unknown) {
    if (this.attempt !== attempt) return;
    this.detach(attempt); this.attempt = null;
    this.transition('idle'); attempt.reject(error);
  }

  /** Only the exact currently closing window can cancel this quit. A late
   * dialog belonging to another or replaced owner cannot cancel a newer quit. */
  cancel(window: W): boolean {
    const attempt = this.attempt;
    if (this.state !== 'requesting' || !attempt || attempt.active?.window !== window) return false;
    this.detach(attempt); this.attempt = null;
    this.transition('idle'); attempt.resolve(false);
    return true;
  }
}

export type ProjectRestartState = 'idle' | 'requesting' | 'stopping' | 'starting';
export interface ProjectWindowRestartOptions<W extends ProjectQuitWindow> {
  getWindows(): readonly W[];
  /** Main's Quit coordinator must be idle. The paired main-side Quit entry
   * calls cancelForQuit() before requesting its own window-close transaction. */
  canRequest(): boolean;
  stop(): unknown | Promise<unknown>;
  start(): unknown | Promise<unknown>;
  onStateChange?(state: ProjectRestartState): void;
}

/** Restart uses exactly the same P0 admission and actual-closed observation as
 * Quit. During stop/start a new Quit is explicitly deferred by main, never run
 * in parallel. During requesting it can synchronously supersede this attempt. */
export class MultiWindowRestartCoordinator<W extends ProjectQuitWindow = ProjectQuitWindow> {
  private options: ProjectWindowRestartOptions<W>;
  private closing: MultiWindowQuitCoordinator<W> | null = null;
  state: ProjectRestartState = 'idle';
  pending: Promise<boolean> | undefined;

  constructor(options: ProjectWindowRestartOptions<W>) { this.options = options; }

  private transition(state: ProjectRestartState) {
    this.state = state;
    try { this.options.onStateChange?.(state); } catch { /* Notifications cannot admit close. */ }
  }

  request(source?: W): Promise<boolean> {
    if (this.state !== 'idle') return this.pending ?? Promise.resolve(false);
    if (!this.options.canRequest()) return Promise.resolve(false);
    let resolve!: (result: boolean) => void, reject!: (error: unknown) => void;
    const pending = this.pending = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
    const closing = new MultiWindowQuitCoordinator<W>({ getWindows: () => this.options.getWindows(),
      stop: async () => {
        await this.options.stop();
        // Quit can become pending while the backend is draining. Preserve that
        // request without creating another startup for it to cancel and drain.
        if (!this.options.canRequest()) return;
        this.transition('starting');
        await this.options.start();
      },
      finish() {},
      onStateChange: state => {
        if (this.closing !== closing) return;
        if (state === 'requesting' || state === 'stopping') this.transition(state);
        if (state === 'idle' || state === 'finished') this.transition('idle');
      },
    });
    this.closing = closing;
    void closing.request(source).then(result => {
      if (this.closing === closing) this.closing = null;
      resolve(result);
    }, error => {
      if (this.closing === closing) this.closing = null;
      reject(error);
    });
    return pending;
  }

  cancel(window: W): boolean { return this.closing?.cancel(window) ?? false; }

  /** Main must immediately call Quit.request() in this same synchronous stack
   * after true. False means stop/start already owns the lifecycle; main should
   * retain the explicit pending Quit until this restart's promise settles. */
  cancelForQuit(): boolean {
    if (this.state === 'idle') return true;
    if (this.state !== 'requesting') return false;
    const window = this.closing?.activeWindow;
    return window ? this.closing!.cancel(window) : false;
  }
}

export interface ProjectWindowQuitRouterOptions<W extends ProjectQuitWindow> {
  readonly quit: MultiWindowQuitCoordinator<W>;
  readonly restart: MultiWindowRestartCoordinator<W>;
  onPendingChange?(pending: boolean): void;
}

/** Main's sole Quit entry point. A Quit arriving during backend restart is a
 * retained request, never a dropped click or a second concurrent stop/start.
 * This object holds no renderer permission: source permits never cross await. */
export type ProjectWindowQuitRouter<W extends ProjectQuitWindow> = ReturnType<typeof createProjectWindowQuitRouter<W>>;
export function createProjectWindowQuitRouter<W extends ProjectQuitWindow>(options: ProjectWindowQuitRouterOptions<W>) {
  let isPending = false, pending: Promise<boolean> | undefined;
  function mark(value: boolean) {
    isPending = value;
    try { options.onPendingChange?.(value); } catch { /* Fence already took effect. */ }
  }
  function request(source?: W): Promise<boolean> {
    if (isPending && pending) return pending;
    let resolve!: (result: boolean) => void, reject!: (error: unknown) => void;
    const result = pending = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
    // Fence before any callback or cancellation notification. In particular,
    // restart's new backend may finish starting but cannot open a new window.
    mark(true);
    const complete = (value: boolean) => { mark(false); resolve(value); };
    const fail = (error: unknown) => { mark(false); reject(error); };
    try {
      if (options.restart.cancelForQuit()) {
        // Exact source close remains on the recovery Exit call stack.
        void options.quit.request(source).then(complete, fail);
      } else {
        const restarting = options.restart.pending;
        if (!restarting) throw new Error('Restart lifecycle has no pending owner');
        void restarting.catch(() => false).then(() => {
          // Never carry source or a confirmed-gone permit across this wait.
          return options.quit.request();
        }).then(complete, fail);
      }
    } catch (error) { fail(error); }
    return result;
  }
  return {
    request,
    get isPending() { return isPending; },
    get pending() { return pending; },
    get allowsWindows() {
      return !isPending && options.quit.state === 'idle' &&
        (options.restart.state === 'idle' || options.restart.state === 'starting');
    },
  };
}
