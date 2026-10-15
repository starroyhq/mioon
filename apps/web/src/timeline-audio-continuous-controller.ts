import {message} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage} from '../../../packages/i18n/src/types.ts';
import type {ContinuousAudioPlanInput} from '@mioon/contracts/timeline-audio-continuous';
import {createContinuousAudioPreviewClient, type ContinuousAudioClientSession} from './timeline-audio-continuous-client.ts';
import {createContinuousTimelineAudioTransport} from './timeline-audio-continuous-engine.ts';
import {timelineAudioPreviewErrorDescriptor, type TimelineAudioPreviewContext, type TimelineAudioPreviewState,
  type TimelineAudioPreviewControllerOptions} from './use-timeline-audio-preview.ts';
import type {AudioPreviewReadOptions} from './timeline-audio-preview-client.ts';

export interface ContinuousAudioControllerOptions extends TimelineAudioPreviewControllerOptions {
  readContinuousPlan: (input: ContinuousAudioPlanInput, options: AudioPreviewReadOptions) => Promise<unknown>;
  prepareContinuous?: ReturnType<typeof createContinuousAudioPreviewClient>['prepare'];
  createContinuousTransport?: typeof createContinuousTimelineAudioTransport;
}
const blank = (): TimelineAudioPreviewState => ({scope: null, executionScope: '', projectId: null, timelineId: null, revision: null,
  durationFrames: 0, sourceIdentity: '', connected: false, visible: false, restored: false, hasUnsavedDrafts: false,
  phase: 'idle', retirement: 'none', nativeAdmission: 'none', plan: null, continuousPlan: null, continuous: true, positionFrame: null,
  requestedStartFrame: null, preparedSources: 0, totalSources: 0, error: ''});
const same = (a: TimelineAudioPreviewContext, b: TimelineAudioPreviewContext): boolean =>
  a.scope === b.scope && a.executionScope === b.executionScope && a.projectId === b.projectId && a.timelineId === b.timelineId &&
  a.revision === b.revision && a.durationFrames === b.durationFrames && a.sourceIdentity === b.sourceIdentity &&
  a.connected === b.connected && a.visible === b.visible && a.restored === b.restored;
const allowed = (state: TimelineAudioPreviewContext): boolean => Boolean(state.scope && state.projectId && state.timelineId &&
  Number.isSafeInteger(state.revision) && (state.revision ?? 0) > 0 && Number.isSafeInteger(state.durationFrames) &&
  state.durationFrames > 0 && state.durationFrames <= 18000 && state.sourceIdentity && state.connected && state.visible && !state.restored);

/** The continuous owner retains the existing saved-only binding. Language and
 * drafts are presentation state; neither becomes an audio session identity. */
export function createContinuousAudioPreviewController(options: ContinuousAudioControllerOptions) {
  type Transport = ReturnType<typeof createContinuousTimelineAudioTransport>;
  type Native = ReturnType<NonNullable<typeof options.nativeAdmission>['beginContinuous']>;
  interface Owner {context: AudioContext; session: ContinuousAudioClientSession | null; transport: Transport | null;
    native: Native | null; flight: Promise<void>; finish: () => void; resources: Promise<void> | null}
  let state = blank(), generation = 0, disposed = false, owner: Owner | null = null;
  let active: AbortController | null = null, retiring: {failed: boolean} | null = null;
  let retirementSettlement: Promise<void> | null = null, intent = 0, initialPlayIntent = false;
  let pendingSeek: {frame: number; token: number; autoplay: boolean} | null = null;
  const prepare = options.prepareContinuous ?? createContinuousAudioPreviewClient({readPlan: options.readContinuousPlan}).prepare;
  const emit = (patch: Partial<TimelineAudioPreviewState>): void => { state = Object.freeze({...state, ...patch}); if (!disposed) options.onChange?.(state); };
  const clear = (phase: TimelineAudioPreviewState['phase'], errorMessage: DisplayMessage | null = null): void => emit({phase, plan: null,
    continuousPlan: null, positionFrame: null, requestedStartFrame: null, preparedSources: 0, totalSources: 0,
    error: errorMessage ? 'AUDIO_PREVIEW_FAILED' : '', errorMessage, nativeAdmission: 'none'});
  const retire = (owned: Owner): void => {
    const record = {failed: false}; retiring = record; emit({retirement: 'closing'});
    // Stop audible output before starting either asynchronous cleanup lane.
    let close: Promise<void>;
    try { close = owned.transport ? owned.transport.dispose() : owned.context.state === 'closed' ? Promise.resolve() : owned.context.close(); }
    catch (error) { close = Promise.reject(error); }
    const clientCleanup = owned.flight.then(async () => {
      await Promise.all([owned.resources, owned.session?.dispose()]);
    });
    const cleanup = Promise.all([close, clientCleanup]).then(() => {
      if (owned.context.state !== 'closed') throw new Error('Audio context closure was not confirmed');
    });
    retirementSettlement = cleanup;
    owned.native?.retire(cleanup);
    void cleanup.then(() => { if (retiring === record) { retiring = null; emit({retirement: 'none'}); } }, () => {
      if (retiring === record) { record.failed = true; emit({retirement: 'failed'}); }
    });
  };
  const invalidate = (): void => {
    intent++; initialPlayIntent = false; pendingSeek = null;
    generation++; active?.abort(); active = null;
    const old = owner; owner = null; if (old) retire(old);
  };
  const sync = (): void => { if (!disposed && options.getContext) controller.setContext(options.getContext()); };
  const current = (attempt: number): boolean => { sync(); return !disposed && attempt === generation && allowed(state); };
  const matches = (expected?: TimelineAudioPreviewContext): boolean => !expected || same(expected, state);
  const fail = (attempt: number, error: unknown): void => {
    if (!current(attempt)) return;
    const positionFrame = owner?.transport?.getState().frame ?? state.positionFrame;
    invalidate(); clear('error', timelineAudioPreviewErrorDescriptor(error)); emit({positionFrame});
    if (error && typeof error === 'object' && 'code' in error && error.code === 'UNAUTHORIZED') options.onUnauthorized?.();
  };
  const controller = {
    getState: (): TimelineAudioPreviewState => state,
    attach(context: TimelineAudioPreviewContext): void { disposed = false; controller.setContext(context); },
    setContext(context: TimelineAudioPreviewContext): void {
      if (disposed) return;
      if (same(state, context)) { if (state.hasUnsavedDrafts !== context.hasUnsavedDrafts) emit({hasUnsavedDrafts: context.hasUnsavedDrafts}); return; }
      const hadSound = state.phase !== 'idle'; invalidate();
      emit({...blank(), ...context, retirement: retiring ? retiring.failed ? 'failed' : 'closing' : 'none', phase: hadSound ? 'cancelled' : 'idle'});
    },
    async prepare(startFrame: number, expected?: TimelineAudioPreviewContext): Promise<boolean> {
      sync();
      if (disposed || !matches(expected) || !allowed(state) || active || retiring || !Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= state.durationFrames) return false;
      if (owner) { invalidate(); clear('cancelled'); return false; }
      const attempt = ++generation, abort = new AbortController(); active = abort;
      let owned: Owner | null = null;
      emit({phase: 'preparing', error: '', errorMessage: null, requestedStartFrame: startFrame, positionFrame: startFrame});
      try {
        if (!current(attempt)) return false;
        const context = options.createContext?.() ?? new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
        let finish!: () => void; const flight = new Promise<void>(resolve => { finish = resolve; });
        owned = {context, flight, finish, session: null, transport: null, native: null, resources: null};
        if (!current(attempt)) { retire(owned); return false; }
        owner = owned;
        const own = owned;
        own.native = options.nativeAdmission?.beginContinuous({onRevoke: () => { if (owner === own) { invalidate(); clear('cancelled'); } },
          onWaiting: nativeAdmission => { if (current(attempt)) emit({nativeAdmission}); }}) ?? null;
        if (!current(attempt)) { own.native?.retire(retirementSettlement ?? Promise.resolve()); return false; }
        if (context.sampleRate !== 48000) throw Object.assign(new Error('Invalid audio clock'), {code: 'AUDIO_PREVIEW_SAMPLE_RATE'});
        // Unlock on the explicit gesture. Silence during preparation is not an
        // audible transport; all actual scheduling remains engine-owned.
        const resumed = context.resume(); void resumed.catch(() => {});
        const session = await prepare({projectId: state.projectId!, timelineId: state.timelineId!, expectedRevision: state.revision!, startFrame}, {
          context, signal: abort.signal, ...options.getInvocation?.(),
          ...(own.native ? {reserveNative: (plan, sessionId, signal) => own.native!.acquireContinuous(plan, sessionId, signal)} : {}),
          onResourceSettlement: resources => { own.resources = resources; void resources.catch(() => {}); },
        });
        own.session = session;
        if (!current(attempt)) { await session.dispose(); return false; }
        if (context.state === 'closed') throw Object.assign(new Error('Audio context closed during preparation'), {code: 'AUDIO_PREVIEW_CONTEXT_CLOSED'});
        if (session.plan.durationFrames !== state.durationFrames) throw Object.assign(new Error('Wrong saved end'), {code: 'AUDIO_PREVIEW_PROTOCOL'});
        const transport = (options.createContinuousTransport ?? createContinuousTimelineAudioTransport)({context, plan: session.plan,
          initialBlock: session.takeInitialBlock(), loadBlock: session.loadBlock, onReset: session.reset,
          onChange: next => {
            if (!current(attempt) || next.status === 'disposed') return;
            if (next.status === 'stopped') { fail(attempt, Object.assign(new Error('Audio output stopped'), {code: next.errorCode || 'AUDIO_PREVIEW_DECODE_FAILED'})); return; }
            emit({phase: next.status, positionFrame: next.frame, underruns: next.underruns, heldPcmBytes: next.heldBytes, peakPcmBytes: next.peakHeldBytes});
          }});
        own.transport = transport;
        if (!current(attempt)) return false;
        active = null; emit({phase: 'ready', continuousPlan: session.plan, positionFrame: startFrame, nativeAdmission: 'none'}); return current(attempt);
      } catch (error) { fail(attempt, error); return false; }
      finally { owned?.finish(); if (active === abort) active = null; }
    },
    async play(expected?: TimelineAudioPreviewContext): Promise<boolean> {
      sync(); const attempt = generation, owned = owner;
      if (disposed || !matches(expected) || !allowed(state) || !owned?.transport) return false;
      options.onBeforePlay?.(); if (!current(attempt) || owner !== owned) return false;
      try { const played = await owned.transport.play(); return current(attempt) && owner === owned && played; }
      catch (error) { fail(attempt, error); return false; }
    },
    async start(startFrame: number, expected?: TimelineAudioPreviewContext): Promise<boolean> {
      sync();
      if (disposed || !matches(expected) || !allowed(state) || active || retiring || owner) return false;
      const token = ++intent; initialPlayIntent = true;
      const ready = await controller.prepare(startFrame, expected);
      if (!ready || token !== intent || !initialPlayIntent) return false;
      initialPlayIntent = false; return controller.play();
    },
    pause(expected?: TimelineAudioPreviewContext): void { sync(); if (!disposed && matches(expected) && allowed(state)) owner?.transport?.pause(); },
    seek(frame: number, expected?: TimelineAudioPreviewContext): boolean {
      sync(); if (disposed || !matches(expected) || !allowed(state) || !Number.isSafeInteger(frame) || frame < 0 || frame > state.durationFrames) return false;
      options.onExplicitPosition?.(frame);
      const owned = owner, attempt = generation;
      if (!owned?.transport) {
        if ((active || pendingSeek) && state.phase === 'preparing' && frame < state.durationFrames) {
          const autoplay = initialPlayIntent || pendingSeek?.autoplay || false;
          invalidate();
          const queued = {frame, token: ++intent, autoplay}; pendingSeek = queued; initialPlayIntent = autoplay;
          emit({phase: 'preparing', continuousPlan: null, positionFrame: frame, requestedStartFrame: frame, error: '', errorMessage: null});
          void (retirementSettlement ?? Promise.resolve()).then(async () => {
            sync();
            if (disposed || pendingSeek !== queued || intent !== queued.token || !allowed(state) || retiring) return;
            pendingSeek = null;
            if (queued.autoplay) await controller.start(queued.frame);
            else await controller.prepare(queued.frame);
          }, () => { if (!disposed && pendingSeek === queued) { pendingSeek = null; clear('error', message('audio.preview.error.stopPending')); } });
          return true;
        }
        if (active || pendingSeek) { invalidate(); clear('cancelled'); }
        return false;
      }
      void Promise.resolve(owned.transport.seek(frame)).catch(error => fail(attempt, error)); return true;
    },
    stop(expected?: TimelineAudioPreviewContext): void {
      sync(); if (disposed || !matches(expected)) return;
      const frame = owner?.transport?.getState().frame ?? state.positionFrame;
      invalidate(); clear('cancelled'); if (frame !== null) options.onExplicitPosition?.(frame);
    },
    cancel(expected?: TimelineAudioPreviewContext): void { sync(); if (matches(expected) && (active || pendingSeek)) { invalidate(); clear('cancelled'); } },
    revoke(): void { if (!disposed) { invalidate(); clear('cancelled'); } },
    dispose(): void { invalidate(); disposed = true; state = {...blank(), retirement: retiring ? retiring.failed ? 'failed' : 'closing' : 'none'}; },
  };
  return controller;
}
