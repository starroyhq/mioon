import electronUpdater from 'electron-updater';
import type {AppUpdater, CancellationToken, ProgressInfo, UpdateInfo} from 'electron-updater';
import {DESKTOP_UPDATE_RELEASES, desktopReleaseVersionSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateOffer, DesktopUpdateState} from '../../../packages/contracts/src/desktop-update.ts';

export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DESKTOP_UPDATE_LATEST_URL = DESKTOP_UPDATE_RELEASES + '/latest';
const releaseUrlBase = DESKTOP_UPDATE_RELEASES + '/tag/v';
const sha512 = /^[A-Za-z0-9+/]{85}[AQgw]==$/u;

export function validDesktopUpdateVersion(value: unknown): value is string {
  return desktopReleaseVersionSchema.safeParse(value).success;
}

export function desktopUpdateReleaseUrl(version: string): string | null {
  return validDesktopUpdateVersion(version) ? releaseUrlBase + version : null;
}

export function isDesktopUpdateExternalUrl(value: string): boolean {
  return value === DESKTOP_UPDATE_LATEST_URL ||
    value.startsWith(releaseUrlBase) && validDesktopUpdateVersion(value.slice(releaseUrlBase.length));
}

const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
function decodeEntity(match: string, name: string): string {
  if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? match;
  const hex = name[1]?.toLowerCase() === 'x';
  const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  return point >= 0x20 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
}

// The GitHub provider normally supplies HTML from the Atom release body.
// Handle plain Markdown as well, then return strings for text-only rendering.
export function desktopUpdateNotes(body: UpdateInfo['releaseNotes']): readonly string[] {
  const entries = typeof body === 'string' ? [body] : Array.isArray(body) ? body.slice(0, 5).map(entry => entry?.note) : [];
  const notes: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const lines = entry.slice(0, 32768)
      .replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?(?:<\/(?:script|style)\s*>|$)/giu, '')
      .replace(/<\/h[1-6]\s*>/giu, '\n')
      .replace(/<\/?(?:li|p|blockquote|br|ul|ol|div|pre|hr)\b[^>]*>/giu, '\n')
      .replace(/<[^>]*>/gu, '')
      .replace(/!?(\[([^\]\r\n]{1,512})\])\([^\r\n)]{1,2048}\)/gu, '$2')
      .replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, decodeEntity)
      .split(/\r\n?|\n/u);
    for (const line of lines) {
      const text = line.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .trim().replace(/^(?:#{1,6}|>|[-*+]|\d+\.)\s+/u, '').replace(/\s+/gu, ' ').trim();
      if (!text || /^(?:[|:\- ]+|```.*)$/u.test(text)) continue;
      notes.push(Array.from(text).slice(0, 200).join(''));
      if (notes.length === 5) return Object.freeze(notes);
    }
  }
  return Object.freeze(notes);
}

interface UpdateEvents {
  'download-progress': (progress: ProgressInfo) => void;
  error: (error: Error, message?: string) => void;
}
export type DesktopUpdatePort = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'autoRunAppAfterInstall' | 'allowPrerelease' |
  'allowDowngrade' | 'logger' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'> & {
  on<K extends keyof UpdateEvents>(event: K, listener: UpdateEvents[K]): unknown;
  off<K extends keyof UpdateEvents>(event: K, listener: UpdateEvents[K]): unknown;
  discardDownload?(): Promise<void>;
  stageForInstall?(): Promise<void>;
};
export type DesktopUpdateVerifier = (files: readonly string[], offer: DesktopUpdateOffer, signal: AbortSignal, expectedSha512: string) => Promise<void>;
interface DesktopUpdateOptions {
  readonly updater: DesktopUpdatePort | null;
  readonly enabled: boolean;
  readonly currentVersion: string;
  readonly verifyDownload: DesktopUpdateVerifier;
  readonly changed?: (state: DesktopUpdateState) => void;
  readonly installFailed?: () => void;
  readonly intervalMs?: number;
  readonly makeCancellationToken?: () => CancellationToken;
}
interface PendingUpdate {
  readonly offer: DesktopUpdateOffer;
  readonly digest: string;
}
interface DownloadAttempt {
  readonly pending: PendingUpdate;
  readonly token: CancellationToken;
  readonly controller: AbortController;
  promise?: Promise<DesktopUpdateState>;
}

const idle = Object.freeze({kind: 'idle'} as const);
const disabled = Object.freeze({kind: 'disabled'} as const);

function readOffer(info: UpdateInfo, currentVersion: string): PendingUpdate | null {
  if (!validDesktopUpdateVersion(info?.version) || info.version === currentVersion) return null;
  const tag = (info as {tag?: unknown}).tag;
  if (tag !== undefined && tag !== 'v' + info.version) return null;
  const files = Array.isArray(info.files) ? info.files : [];
  const zip = files.find(file => file?.url === `mioon-${info.version}-mac.zip`);
  if (typeof zip?.sha512 !== 'string' || !sha512.test(zip.sha512)) throw new Error('UPDATE_INVALID_MANIFEST');
  const date = typeof info.releaseDate === 'string' && info.releaseDate.length <= 64 &&
    Number.isFinite(Date.parse(info.releaseDate)) ? info.releaseDate : undefined;
  const size = zip.size;
  return {
    offer: Object.freeze({version: info.version, currentVersion, notes: desktopUpdateNotes(info.releaseNotes),
      ...(date ? {releaseDate: date} : {}),
      ...(typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? {sizeBytes: size} : {}),
    }),
    digest: zip.sha512,
  };
}

export function createDesktopUpdate({updater, enabled, currentVersion, verifyDownload, changed, installFailed,
  intervalMs = DESKTOP_UPDATE_CHECK_INTERVAL_MS, makeCancellationToken = () => new electronUpdater.CancellationToken()}: DesktopUpdateOptions) {
  const active = enabled && validDesktopUpdateVersion(currentVersion) ? updater : null;
  let snapshot: DesktopUpdateState = active ? idle : disabled;
  let pending: PendingUpdate | null = null;
  let checking: Promise<DesktopUpdateState> | undefined;
  let download: DownloadAttempt | null = null;
  let interval: NodeJS.Timeout | undefined;
  let disposed = false;
  let installing = false;
  let pendingUpdateVersion: string | null = null;

  function publish(state: DesktopUpdateState): DesktopUpdateState {
    if (disposed) return snapshot;
    snapshot = Object.freeze(state);
    try { changed?.(snapshot); } catch { /* The owner may have disposed a window. */ }
    return snapshot;
  }

  async function discard(): Promise<void> {
    try { await active?.discardDownload?.(); } catch { /* No rejected artifact becomes installable. */ }
  }

  const progress = ({percent, transferred, total, bytesPerSecond}: ProgressInfo) => {
    if (!download || download.controller.signal.aborted || snapshot.kind !== 'downloading' || !Number.isFinite(percent)) return;
    const hasSize = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(transferred) && transferred >= 0 && transferred <= total;
    const remaining = hasSize && Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
      ? Math.ceil((total - transferred) / bytesPerSecond) : null;
    publish({kind: 'downloading', offer: download.pending.offer, percent: Math.max(0, Math.min(100, Math.floor(percent))),
      secondsRemaining: remaining !== null && Number.isSafeInteger(remaining) ? remaining : null,
      ...(hasSize ? {transferredBytes: transferred, totalBytes: total} : {}),
    });
  };

  function failInstall(): void {
    if (!installing || !pending) return;
    installing = false;
    pendingUpdateVersion = null;
    publish({kind: 'failed', stage: 'download', offer: pending.offer});
    void discard().finally(() => installFailed?.()).catch(() => {});
  }

  if (active) {
    // Library diagnostics can contain signed download URLs and user paths.
    active.logger = null;
    active.autoDownload = false;
    active.autoInstallOnAppQuit = false;
    active.allowPrerelease = false;
    active.allowDowngrade = false;
    active.on('download-progress', progress);
    active.on('error', failInstall);
  }

  function check(): Promise<DesktopUpdateState> {
    if (checking) return checking;
    if (!active || disposed || download || installing || snapshot.kind === 'ready') return Promise.resolve(snapshot);
    checking = Promise.resolve().then(async () => {
      if (disposed) return snapshot;
      publish({kind: 'checking'});
      try {
        const result = await active.checkForUpdates();
        if (disposed) return snapshot;
        if (!result) return publish({kind: 'failed', stage: 'check'});
        pending = result.isUpdateAvailable ? readOffer(result.updateInfo, currentVersion) : null;
        return publish(pending ? {kind: 'available', offer: pending.offer} : idle);
      } catch {
        pending = null;
        return publish({kind: 'failed', stage: 'check'});
      }
    }).finally(() => { checking = undefined; });
    return checking;
  }

  function start(): Promise<DesktopUpdateState> {
    if (!active || disposed) return Promise.resolve(snapshot);
    if (interval) return checking ?? Promise.resolve(snapshot);
    interval = setInterval(() => { void check(); }, intervalMs);
    interval.unref();
    return check();
  }

  function downloadUpdate(expectedVersion: string): Promise<DesktopUpdateState> {
    if (!active || disposed || installing || checking || pending?.offer.version !== expectedVersion) return Promise.resolve(snapshot);
    if (download) return download.promise ?? Promise.resolve(snapshot);
    if (snapshot.kind !== 'available' && !(snapshot.kind === 'failed' && snapshot.stage === 'download')) return Promise.resolve(snapshot);
    const attempt: DownloadAttempt = {pending, token: makeCancellationToken(), controller: new AbortController()};
    download = attempt;
    attempt.promise = Promise.resolve().then(async () => {
      if (disposed) return snapshot;
      if (attempt.controller.signal.aborted) return publish({kind: 'available', offer: attempt.pending.offer});
      try {
        const files = await active.downloadUpdate(attempt.token);
        attempt.controller.signal.throwIfAborted();
        await verifyDownload(files, attempt.pending.offer, attempt.controller.signal, attempt.pending.digest);
        attempt.controller.signal.throwIfAborted();
        pendingUpdateVersion = expectedVersion;
        return publish({kind: 'ready', offer: attempt.pending.offer, installOnQuit: false});
      } catch {
        await discard();
        return publish(attempt.controller.signal.aborted
          ? {kind: 'available', offer: attempt.pending.offer}
          : {kind: 'failed', stage: 'download', offer: attempt.pending.offer});
      }
    }).finally(() => {
      attempt.token.dispose();
      download = null;
    });
    publish({kind: 'downloading', offer: attempt.pending.offer, percent: 0, secondsRemaining: null});
    return attempt.promise;
  }

  function cancel(): boolean {
    if (!download || disposed || download.controller.signal.aborted || snapshot.kind !== 'downloading') return false;
    download.controller.abort();
    download.token.cancel();
    return true;
  }

  function setInstallOnQuit(expectedVersion: string): boolean {
    if (!active || disposed || installing || snapshot.kind !== 'ready' || pendingUpdateVersion !== expectedVersion) return false;
    active.autoInstallOnAppQuit = true;
    if (!snapshot.installOnQuit) publish({...snapshot, installOnQuit: true});
    return true;
  }

  function install(expectedVersion: string, relaunch = true): boolean {
    if (!active || disposed || installing || snapshot.kind !== 'ready' || pendingUpdateVersion !== expectedVersion) return false;
    installing = true;
    // MacUpdater 6 starts Squirrel on explicit install only when this is off.
    // The host calls this after its normal project close and ownership drains.
    active.autoInstallOnAppQuit = false;
    active.autoRunAppAfterInstall = relaunch;
    try {
      if (active.stageForInstall) {
        void active.stageForInstall().then(() => {
          if (installing && !disposed) active.quitAndInstall();
        }).catch(failInstall);
      } else active.quitAndInstall();
    }
    catch { failInstall(); return false; }
    return installing;
  }

  return {
    state: () => snapshot, start, check, download: downloadUpdate, cancel, setInstallOnQuit, install,
    dispose() {
      if (disposed) return;
      if (interval) clearInterval(interval);
      cancel();
      disposed = true;
      active?.off('download-progress', progress);
      active?.off('error', failInstall);
    },
  };
}
