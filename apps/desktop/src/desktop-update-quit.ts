interface UpdateQuitOptions<W> {
  readonly windows: () => readonly W[];
  readonly saved: (window: W) => Promise<boolean>;
  readonly projects: () => readonly string[];
  readonly canStart: (version: string) => boolean;
  readonly quit: (source?: W) => Promise<boolean>;
  readonly handoff: {stage(version: string, projects: readonly string[]): void};
  readonly install: (version: string, relaunch: boolean) => boolean;
  readonly installFailed: () => void;
}
interface Attempt {
  readonly version: string;
  readonly relaunch: boolean;
  pending: Promise<boolean>;
  projects: readonly string[];
  phase: 'checking' | 'closing' | 'installing';
}

/** Installation uses the regular per-document close proofs and backend drain.
 * The updater is called only by the QuitCoordinator's finished callback. */
export function createDesktopUpdateQuit<W>({windows, saved, projects, canStart, quit, handoff, install, installFailed}: UpdateQuitOptions<W>) {
  let attempt: Attempt | undefined;
  function request(version: string, relaunch: boolean, source?: W, beforeClose?: () => Promise<boolean>): Promise<boolean> {
    if (attempt) return attempt.version === version ? attempt.pending : Promise.resolve(false);
    if (!canStart(version)) return Promise.resolve(false);
    const current: Attempt = {version, relaunch, pending: Promise.resolve(false), projects: [], phase: 'checking'};
    attempt = current;
    current.pending = (async () => {
      try {
        const owners = windows();
        if (source && !owners.includes(source)) return false;
        if (!(await Promise.all(owners.map(saved))).every(Boolean)) return false;
        if (beforeClose && !await beforeClose()) return false;
        if (!canStart(version)) return false;
        const latest = windows();
        if (latest.length !== owners.length || owners.some(window => !latest.includes(window))) return false;
        current.projects = projects();
        current.phase = 'closing';
        return await quit(source);
      } finally {
        if (attempt === current && current.phase !== 'installing') attempt = undefined;
      }
    })();
    return current.pending;
  }
  function failed(): void {
    if (attempt?.phase !== 'installing') return;
    attempt = undefined;
    // Startup also accounts for native failures reported just before exit.
    installFailed();
  }
  function finish(): boolean {
    const current = attempt;
    if (!current || current.phase !== 'closing') return false;
    current.phase = 'installing';
    try {
      handoff.stage(current.version, current.projects);
      if (install(current.version, current.relaunch)) return true;
    } catch { /* Avoid reporting paths, signed asset URLs or provider errors. */ }
    failed();
    return true;
  }
  return {
    request, finish, failed,
    get pending() {return attempt?.pending;},
    get closing() {return attempt?.phase === 'closing';},
  };
}
