import {desktopUpdateRequestSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {
  DesktopUpdateActivity, DesktopUpdateError, DesktopUpdateNotice, DesktopUpdateReply, DesktopUpdateState, DesktopUpdateView,
} from '../../../packages/contracts/src/desktop-update.ts';

export interface UpdateDocument {
  readonly id: string;
  isCurrent(): boolean;
  isVisible(): boolean;
  send(view: DesktopUpdateView): void;
}
interface UpdateEngine {
  state(): DesktopUpdateState;
  start(options?: {checkImmediately?: boolean}): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(version: string): Promise<DesktopUpdateState>;
  cancel(): boolean;
  setInstallOnQuit(version: string): boolean;
}
interface UpdateHostOptions {
  readonly engine: UpdateEngine;
  readonly currentVersion: string;
  readonly showInstallFailureOnLaunch?: boolean | undefined;
  documents(): readonly UpdateDocument[];
  focused(): UpdateDocument | null;
  activity(): Promise<DesktopUpdateActivity>;
  install(version: string, beforeClose: () => Promise<boolean>): Promise<boolean>;
}
const inactive = Object.freeze({exports: false, generations: false});
const refuse = (code: DesktopUpdateError['code'], status: DesktopUpdateError['status']): DesktopUpdateReply =>
  ({ok: false, error: {code, status}});
const presentsOnLaunch = (state: DesktopUpdateState) => state.kind === 'available' || state.kind === 'failed' && state.stage === 'install';

export function createDesktopUpdateHost({engine, currentVersion, showInstallFailureOnLaunch = false, documents, focused, activity, install}: UpdateHostOptions) {
  let activityState: DesktopUpdateActivity = inactive;
  let activityRead: Promise<DesktopUpdateActivity> | undefined;
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let revision = 0;
  let noticeId = 0;
  let started = false;
  let launchPending = showInstallFailureOnLaunch;
  let previousKind = engine.state().kind;
  const notices = new Map<string, DesktopUpdateNotice>();
  const view = (owner: UpdateDocument): DesktopUpdateView => ({
    revision, currentVersion, state: engine.state(), notice: notices.get(owner.id) ?? null, activity: activityState,
  });
  const publish = () => {
    revision++;
    const active = documents().filter(owner => owner.isCurrent());
    const ids = new Set(active.map(owner => owner.id));
    for (const id of notices.keys()) if (!ids.has(id)) notices.delete(id);
    for (const owner of active) {
      try {owner.send(view(owner));} catch { /* A closing window has no update audience. */ }
    }
  };
  const notice = (owner: UpdateDocument | null, kind: DesktopUpdateNotice['kind']) => {
    if (owner?.isCurrent()) notices.set(owner.id, {id: ++noticeId, kind});
  };
  async function refreshActivity(fresh = false): Promise<DesktopUpdateActivity> {
    if (fresh && activityRead) await activityRead.catch(() => {});
    const next = await (activityRead ??= activity().finally(() => {activityRead = undefined;}));
    if (engine.state().kind === 'ready' && (next.exports !== activityState.exports || next.generations !== activityState.generations)) {
      activityState = next;
      publish();
    }
    return next;
  }
  function changed(): void {
    const state = engine.state(), {kind} = state;
    if (!presentsOnLaunch(state)) launchPending = false;
    if (kind === 'ready' && previousKind !== 'ready') {
      notice(focused(), 'ready');
      void refreshActivity().catch(() => {});
      activityTimer = setInterval(() => {
        if (documents().length) void refreshActivity().catch(() => {});
      }, 2000);
      activityTimer.unref();
    } else if (kind !== 'ready' && previousKind === 'ready') {
      clearInterval(activityTimer);
      activityTimer = undefined;
      activityState = inactive;
    }
    previousKind = kind;
    publish();
  }
  function presentLaunch(first: UpdateDocument): void {
    if (!launchPending || !presentsOnLaunch(engine.state())) return;
    const owner = first.isCurrent() && first.isVisible() ? first : focused();
    if (!owner?.isCurrent() || !owner.isVisible()) return;
    launchPending = false;
    if (notices.get(owner.id)?.kind === 'manual') return;
    notice(owner, 'launch');
    publish();
  }
  function start(first: UpdateDocument): void {
    if (!first.isCurrent() || !first.isVisible()) return;
    if (started) {presentLaunch(first); return;}
    started = true;
    presentLaunch(first);
    // A new install failure is presented before any release-feed response.
    void engine.start({checkImmediately: !showInstallFailureOnLaunch}).then(result => {
      if (result.kind !== 'available' || engine.state().kind !== 'available') return;
      launchPending = true;
      presentLaunch(first);
    }).catch(() => {});
  }
  async function check(owner: UpdateDocument): Promise<void> {
    if (!owner.isCurrent() || engine.state().kind === 'disabled') return;
    const checking = engine.check();
    await Promise.resolve();
    if (!owner.isCurrent()) return;
    notice(owner, 'manual');
    publish();
    await checking;
  }
  async function dispatch(owner: UpdateDocument | null, raw: unknown): Promise<DesktopUpdateReply> {
    if (!owner?.isCurrent()) return refuse('UPDATE_UNAVAILABLE', 503);
    const parsed = desktopUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) return refuse('UPDATE_INVALID', 400);
    const data = () => ({ok: true as const, data: view(owner)});
    const request = parsed.data, status = engine.state();
    if (request.kind === 'read') return data();
    if (status.kind === 'disabled') return refuse('UPDATE_UNAVAILABLE', 503);
    try {
      switch (request.kind) {
        case 'check': await check(owner); break;
        case 'download': {
          const version = status.kind === 'available' || status.kind === 'failed' && status.stage === 'download' ? status.offer.version
            : status.kind === 'failed' && status.stage === 'install' && status.canRetry ? status.version : null;
          if (version !== request.expectedVersion) return refuse('UPDATE_VERSION_CHANGED', 409);
          await engine.download(request.expectedVersion);
          break;
        }
        case 'cancel': engine.cancel(); break;
        case 'install': {
          if (status.kind !== 'ready' || status.offer.version !== request.expectedVersion) return refuse('UPDATE_VERSION_CHANGED', 409);
          if (request.mode === 'on-quit') {
            if (!engine.setInstallOnQuit(request.expectedVersion)) return refuse('UPDATE_VERSION_CHANGED', 409);
            break;
          }
          let refusal = refuse('UPDATE_NOT_SAVED', 409);
          const confirmActivity = async (fresh: boolean) => {
            const current = await refreshActivity(fresh);
            if (!owner.isCurrent()) {refusal = refuse('UPDATE_UNAVAILABLE', 503); return false;}
            if (current.exports && !request.acknowledgeExports) {refusal = refuse('UPDATE_EXPORT_ACTIVE', 409); return false;}
            return true;
          };
          if (!await confirmActivity(false) || !await install(request.expectedVersion, () => confirmActivity(true))) return refusal;
          break;
        }
      }
      return owner.isCurrent() ? data() : refuse('UPDATE_UNAVAILABLE', 503);
    } catch {return refuse('UPDATE_UNAVAILABLE', 503);}
  }
  return {changed, start, check, dispatch, dispose: () => clearInterval(activityTimer)};
}
