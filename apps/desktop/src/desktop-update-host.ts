import {desktopUpdateRequestSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {
  DesktopUpdateActivity, DesktopUpdateError, DesktopUpdateNotice, DesktopUpdateReply, DesktopUpdateState, DesktopUpdateView,
} from '../../../packages/contracts/src/desktop-update.ts';

export interface UpdateDocument {
  readonly id: string;
  isCurrent(): boolean;
  send(view: DesktopUpdateView): void;
}
interface UpdateEngine {
  state(): DesktopUpdateState;
  start(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(version: string): Promise<DesktopUpdateState>;
  cancel(): boolean;
  setInstallOnQuit(version: string): boolean;
}
interface UpdateHostOptions {
  readonly engine: UpdateEngine;
  readonly currentVersion: string;
  documents(): readonly UpdateDocument[];
  focused(): UpdateDocument | null;
  activity(): Promise<DesktopUpdateActivity>;
  install(version: string): Promise<boolean>;
}
const inactive = Object.freeze({exports: false, generations: false});
const refuse = (code: DesktopUpdateError['code'], status: DesktopUpdateError['status']): DesktopUpdateReply =>
  ({ok: false, error: {code, status}});

export function createDesktopUpdateHost({engine, currentVersion, documents, focused, activity, install}: UpdateHostOptions) {
  let activityState: DesktopUpdateActivity = inactive;
  let activityRead: Promise<DesktopUpdateActivity> | undefined;
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let revision = 0;
  let noticeId = 0;
  let started = false;
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
  async function refreshActivity(): Promise<DesktopUpdateActivity> {
    const next = await (activityRead ??= activity().finally(() => {activityRead = undefined;}));
    if (engine.state().kind === 'ready' && (next.exports !== activityState.exports || next.generations !== activityState.generations)) {
      activityState = next;
      publish();
    }
    return next;
  }
  function changed(): void {
    const {kind} = engine.state();
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
  function start(first: UpdateDocument): void {
    if (started || !first.isCurrent()) return;
    started = true;
    void engine.start().then(result => {
      if (result.kind !== 'available' || engine.state().kind !== 'available') return;
      // An explicit check may already be showing the same initial result.
      const owner = first.isCurrent() ? first : focused();
      if (owner && notices.get(owner.id)?.kind !== 'manual') {
        notice(owner, 'launch');
        publish();
      }
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
        case 'download':
          if ((status.kind !== 'available' && !(status.kind === 'failed' && status.stage === 'download')) ||
            status.offer.version !== request.expectedVersion) return refuse('UPDATE_VERSION_CHANGED', 409);
          await engine.download(request.expectedVersion);
          break;
        case 'cancel': engine.cancel(); break;
        case 'install': {
          if (status.kind !== 'ready' || status.offer.version !== request.expectedVersion) return refuse('UPDATE_VERSION_CHANGED', 409);
          if (request.mode === 'on-quit') {
            if (!engine.setInstallOnQuit(request.expectedVersion)) return refuse('UPDATE_VERSION_CHANGED', 409);
            break;
          }
          const current = await refreshActivity();
          if (!owner.isCurrent()) return refuse('UPDATE_UNAVAILABLE', 503);
          if (current.exports && !request.acknowledgeExports) return refuse('UPDATE_EXPORT_ACTIVE', 409);
          if (!await install(request.expectedVersion)) return refuse('UPDATE_NOT_SAVED', 409);
          break;
        }
      }
      return owner.isCurrent() ? data() : refuse('UPDATE_UNAVAILABLE', 503);
    } catch {return refuse('UPDATE_UNAVAILABLE', 503);}
  }
  return {changed, start, check, dispatch, dispose: () => clearInterval(activityTimer)};
}
