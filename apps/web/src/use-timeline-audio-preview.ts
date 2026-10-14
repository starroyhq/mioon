import { useLayoutEffect, useRef, useState } from 'react';
import { AUDIO_PREVIEW_LIMITS, type AudioPreviewPlan, type AudioPreviewPlanInput } from '@mioon/contracts/timeline-audio-preview';
import { createTimelineAudioPreviewClient, TimelineAudioPreviewError, type AudioPreviewPrepareOptions, type AudioPreviewReadOptions, type PreparedAudioPreview } from './timeline-audio-preview-client.ts';
import { createTimelineAudioPreviewTransport, type AudioPreviewTransportOptions, type AudioPreviewTransportState, type TimelineAudioPreviewTransport } from './timeline-audio-preview-engine.ts';

export interface TimelineAudioPreviewContext {
  /** Includes the workspace identity and project-open epoch, not just a project id. */
  scope: string | null;
  executionScope: string;
  projectId: string | null;
  timelineId: string | null;
  revision: number | null;
  durationFrames: number;
  /** Saved timeline plus relevant public source hashes; no draft values. */
  sourceIdentity: string;
  connected: boolean;
  visible: boolean;
  restored: boolean;
  hasUnsavedDrafts: boolean;
}
export type TimelineAudioPreviewPhase = 'idle' | 'preparing' | 'ready' | 'starting' | 'playing' | 'paused' | 'ended' | 'cancelled' | 'error';
export interface TimelineAudioPreviewState extends TimelineAudioPreviewContext {
  phase: TimelineAudioPreviewPhase;
  retirement: 'none' | 'closing' | 'failed';
  plan: AudioPreviewPlan | null;
  positionFrame: number | null;
  requestedStartFrame: number | null;
  preparedSources: number;
  totalSources: number;
  error: string;
}
export interface TimelineAudioPreviewControllerOptions {
  readPlan: (input: AudioPreviewPlanInput, options: AudioPreviewReadOptions) => Promise<unknown>;
  getContext?: () => TimelineAudioPreviewContext;
  getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  onChange?: (state: TimelineAudioPreviewState) => void;
  onUnauthorized?: () => void;
  /** Explicit user seek/stop only. RAF and all lifecycle changes never call this. */
  onExplicitPosition?: (frame: number) => void;
  /** Pause the separate rendered/source native player before starting sound. */
  onBeforePlay?: () => void;
  createContext?: () => AudioContext;
  prepare?: (input: AudioPreviewPlanInput, options: AudioPreviewPrepareOptions) => Promise<PreparedAudioPreview>;
  createTransport?: (options: AudioPreviewTransportOptions) => TimelineAudioPreviewTransport;
}
const emptyContext = (): TimelineAudioPreviewContext => ({ scope: null, executionScope: '', projectId: null, timelineId: null,
  revision: null, durationFrames: 0, sourceIdentity: '', connected: false, visible: false, restored: false, hasUnsavedDrafts: false });
const initial = (): TimelineAudioPreviewState => ({ ...emptyContext(), phase: 'idle', retirement: 'none', plan: null, positionFrame: null,
  requestedStartFrame: null, preparedSources: 0, totalSources: 0, error: '' });
const sameBinding = (a: TimelineAudioPreviewContext, b: TimelineAudioPreviewContext): boolean =>
  a.scope === b.scope && a.executionScope === b.executionScope && a.projectId === b.projectId && a.timelineId === b.timelineId &&
  a.revision === b.revision && a.durationFrames === b.durationFrames && a.sourceIdentity === b.sourceIdentity &&
  a.connected === b.connected && a.visible === b.visible && a.restored === b.restored;
const canPrepare = (context: TimelineAudioPreviewContext): boolean => Boolean(context.scope && context.projectId && context.timelineId &&
  Number.isSafeInteger(context.revision) && (context.revision ?? 0) > 0 && Number.isSafeInteger(context.durationFrames) && context.durationFrames > 0 &&
  context.durationFrames <= AUDIO_PREVIEW_LIMITS.timelineFrames && context.sourceIdentity.length > 0 && context.connected && context.visible && !context.restored);
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
export function timelineAudioPreviewErrorMessage(error: unknown): string {
  const code = codeOf(error);
  if (code === 'UNAUTHORIZED') return '会话已过期，请重新登录后明确准备声音。';
  if (code === 'AUDIO_PREVIEW_MEMORY_LIMIT' || code === 'AUDIO_PREVIEW_HASH_LIMIT') return '此完整区间超出声音试听容量，未省略音轨。可使用单独的已渲染视频预览。';
  if (code === 'AUDIO_PREVIEW_TIMEOUT') return '声音准备超过 120 秒预算，未保留部分音轨。请重新准备。';
  if (code === 'AUDIO_PREVIEW_BUSY') return '另一声音准备尚未结束，请稍后明确重试。';
  if (code === 'AUDIO_PREVIEW_SOURCE_LIMIT') return '此区间的来源文件超出声音试听限制，未省略音轨。';
  if (code === 'AUDIO_PREVIEW_REVISION_CONFLICT' || code === 'AUDIO_PREVIEW_SOURCE_CHANGED' || code === 'AUDIO_PREVIEW_STALE') return '已保存时间线或来源已变化，请重新准备。';
  if (code === 'AUDIO_PREVIEW_AUDIO_UNKNOWN') return '来源的音频信息尚不明确，完整区间未能准备。';
  if (code === 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT') return '此区间包含暂不支持的音频格式，未省略该音轨。';
  if (code === 'AUDIO_PREVIEW_SOURCE_BOUNDS') return '已保存片段超出当前来源的音频范围，请核对来源后重新准备。';
  if (code === 'AUDIO_PREVIEW_INVALID_PCM' || code === 'AUDIO_PREVIEW_TRUNCATED_PCM' || code === 'AUDIO_PREVIEW_DECODE_FAILED') return '来源声音解码不完整或无效，完整区间未能准备。';
  if (code === 'AUDIO_PREVIEW_BUDGET') return '此区间涉及的原始片段超出声音解码预算，完整区间未能准备。可使用单独的已渲染视频预览。';
  if (code === 'AUDIO_PREVIEW_SHUTDOWN_FAILED' || code === 'AUDIO_PREVIEW_STOP_TIMEOUT') return '上一声音解码尚未确认结束，请等待释放后明确重试。';
  if (code === 'AUDIO_PREVIEW_CONTEXT_CLOSED') return '试听音频时钟在准备过程中已关闭，请明确重新准备。';
  if (code === 'AUDIO_PREVIEW_SAMPLE_RATE') return '当前音频设备无法建立 48 kHz 试听时钟。';
  if (code === 'AUDIO_PREVIEW_UNSUPPORTED' || code.startsWith('RESTORE_')) return '此环境暂不支持已保存时间线声音试听。';
  if (code === 'AUDIO_PREVIEW_PROTOCOL' || code === 'AUDIO_PREVIEW_INVALID_GRAPH') return '声音响应不完整或与当前区间不匹配，请重新准备。';
  return '声音试听未完成，请确认连接与音频设备后重新准备。';
}
function contextFromGesture(): AudioContext {
  if (typeof AudioContext !== 'function') throw new TimelineAudioPreviewError('AUDIO_PREVIEW_UNSUPPORTED', '此环境暂不支持声音试听。');
  return new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
}

/** Pure controller owns disposable sound only. It cannot save, reset, discard,
 * merge or inspect any draft controller. Its complete binding is rechecked at
 * each async boundary, including retained handlers and late resume acknowledgments. */
export function createTimelineAudioPreviewController(options: TimelineAudioPreviewControllerOptions) {
  let state = initial(), generation = 0, disposed = false;
  let active: AbortController | null = null;
  interface ResourceOwner {
    context: AudioContext;
    transport: TimelineAudioPreviewTransport | null;
    flight: Promise<void>;
    settleFlight: () => void;
    resources: Promise<void> | null;
  }
  let owner: ResourceOwner | null = null;
  let retiring: { owner: ResourceOwner; failed: boolean } | null = null;
  let transport: TimelineAudioPreviewTransport | null = null;
  const preparePcm = options.prepare ?? createTimelineAudioPreviewClient({ readPlan: options.readPlan }).prepare;
  const makeTransport = options.createTransport ?? createTimelineAudioPreviewTransport;
  const emit = (patch: Partial<TimelineAudioPreviewState>): void => { state = Object.freeze({ ...state, ...patch }); options.onChange?.(state); };
  const clear = (phase: TimelineAudioPreviewPhase, error = ''): void => emit({ phase, error, plan: null, positionFrame: null,
    requestedStartFrame: null, preparedSources: 0, totalSources: 0 });
  const retirementState = (): TimelineAudioPreviewState['retirement'] => retiring ? retiring.failed ? 'failed' : 'closing' : 'none';
  const reflectRetirement = (): void => {
    if (!disposed) emit({ retirement: retirementState() });
    else state = Object.freeze({ ...state, retirement: retirementState() });
  };
  const retire = (owned: ResourceOwner): void => {
    const record = { owner: owned, failed: false }; retiring = record; reflectRetirement();
    let closed: Promise<void>;
    try { closed = owned.transport ? owned.transport.dispose() : owned.context.state === 'closed' ? Promise.resolve() : owned.context.close(); }
    catch (error) { closed = Promise.reject(error); }
    // The close and client resource acknowledgments are independent. A prompt
    // timeout/cancel result is not proof that a pending read released its PCM.
    const settlement = Promise.all([closed, owned.flight]).then(async () => {
      await owned.resources;
      if (owned.context.state !== 'closed') throw new Error('Exact audio context closure is unconfirmed');
    });
    void settlement.then(() => {
      if (retiring !== record) return;
      retiring = null; reflectRetirement();
    }, () => {
      if (retiring !== record) return;
      record.failed = true; reflectRetirement();
    });
  };
  const invalidate = (): void => {
    generation++; const abort = active; active = null; abort?.abort();
    transport = null;
    const owned = owner; owner = null;
    if (owned) retire(owned);
  };
  const sync = (): void => { if (!disposed && options.getContext) controller.setContext(options.getContext()); };
  const expectedMatches = (expected?: TimelineAudioPreviewContext): boolean => expected === undefined || sameBinding(state, expected);
  const current = (attempt: number): boolean => { sync(); return !disposed && generation === attempt && canPrepare(state); };
  const transportChange = (attempt: number, next: AudioPreviewTransportState): void => {
    if (!current(attempt) || next.status === 'disposed') return;
    if (next.status === 'stopped') {
      const frame = next.frame; invalidate();
      const reason = next.reason === 'outside-prepared-interval' ? '已离开准备区间，请明确准备新的最多 20 秒声音。'
        : next.reason === 'context-suspended' ? '音频设备或系统暂停了试听时钟，请明确重新准备。'
        : next.reason === 'context-closed' ? '试听音频时钟已关闭，请明确重新准备。'
        : next.reason === 'audio-output-failed' ? '音频输出设备发生错误，请检查设备后重新准备。'
        : next.reason === 'resume-failed' ? '音频时钟未能启动，请检查播放权限或设备后重新准备。'
        : next.reason === 'schedule-failed' ? '完整声音区间未能启动，已释放全部声音，请重新准备。'
        : '声音播放已停止，请明确重新准备。';
      clear('error', reason);
      emit({ positionFrame: frame }); return;
    }
    emit({ phase: next.status, positionFrame: next.frame });
  };
  const controller = {
    getState: (): TimelineAudioPreviewState => state,
    attach(context: TimelineAudioPreviewContext): void { disposed = false; controller.setContext(context); },
    setContext(context: TimelineAudioPreviewContext): void {
      if (disposed) return;
      if (sameBinding(state, context)) { if (context.hasUnsavedDrafts !== state.hasUnsavedDrafts) emit({ hasUnsavedDrafts: context.hasUnsavedDrafts }); return; }
      const hadSound = state.phase !== 'idle'; invalidate();
      state = Object.freeze({ ...initial(), ...context, retirement: retirementState(), phase: hadSound ? 'cancelled' : 'idle' }); options.onChange?.(state);
    },
    async prepare(startFrame: number, expected?: TimelineAudioPreviewContext): Promise<boolean> {
      sync();
      if (disposed || !expectedMatches(expected) || active || !canPrepare(state) || !Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= state.durationFrames) return false;
      if (retiring) return false;
      invalidate();
      if (retiring) { clear('cancelled'); return false; }
      const attempt = generation, abort = new AbortController(); active = abort;
      let attemptOwner: ResourceOwner | null = null;
      const input = { projectId: state.projectId!, timelineId: state.timelineId!, expectedRevision: state.revision!, startFrame };
      emit({ phase: 'preparing', plan: null, positionFrame: startFrame, requestedStartFrame: startFrame, preparedSources: 0, totalSources: 0, error: '' });
      try {
        // Synchronous creation inside the user's prepare gesture. No context,
        // RPC, decoder or network work is started by mounting this controller.
        const context = (options.createContext ?? contextFromGesture)();
        let settleFlight: () => void = () => {};
        const flight = new Promise<void>(resolve => { settleFlight = resolve; });
        attemptOwner = { context, transport: null, flight, settleFlight, resources: null }; owner = attemptOwner;
        const owned = attemptOwner;
        if (context.sampleRate !== 48000) throw new TimelineAudioPreviewError('AUDIO_PREVIEW_SAMPLE_RATE', '48 kHz clock unavailable');
        if (!current(attempt)) return false;
        const prepared = await preparePcm(input, { context, signal: abort.signal, ...options.getInvocation?.(),
          onResourceSettlement: resources => { owned.resources = resources; void resources.catch(() => {}); },
          onProgress: (preparedSources, totalSources) => { if (current(attempt)) emit({ preparedSources, totalSources }); } });
        if (!current(attempt) || abort.signal.aborted) { prepared.buffers.clear(); return false; }
        // Validate the saved duration as well as the RPC-bound start/revision.
        if (prepared.plan.range.endFrame !== Math.min(startFrame + 600, state.durationFrames)) {
          prepared.buffers.clear(); throw new TimelineAudioPreviewError('AUDIO_PREVIEW_PROTOCOL', 'Prepared interval has an unexpected end');
        }
        if (context.state === 'closed') {
          prepared.buffers.clear(); throw new TimelineAudioPreviewError('AUDIO_PREVIEW_CONTEXT_CLOSED', 'Audio context closed before publication');
        }
        const next = makeTransport({ context, plan: prepared.plan, buffers: prepared.buffers, onChange: value => transportChange(attempt, value) });
        owned.transport = next;
        if (!current(attempt)) { prepared.buffers.clear(); return false; }
        transport = next; active = null;
        // Transport has acquired only map entries; the completed client has no
        // further payload ownership and must never modify channel samples.
        prepared.buffers.clear();
        emit({ phase: 'ready', plan: prepared.plan, positionFrame: startFrame, error: '' }); return true;
      } catch (error: unknown) {
        if (!current(attempt)) return false;
        invalidate(); clear(codeOf(error) === 'AUDIO_PREVIEW_CANCELLED' ? 'cancelled' : 'error', timelineAudioPreviewErrorMessage(error));
        if (codeOf(error) === 'UNAUTHORIZED') options.onUnauthorized?.();
        return false;
      } finally { attemptOwner?.settleFlight(); if (active === abort) active = null; }
    },
    async play(expected?: TimelineAudioPreviewContext): Promise<boolean> {
      sync(); const owned = transport, attempt = generation;
      if (disposed || !expectedMatches(expected) || !canPrepare(state) || !owned || !state.plan || !['ready', 'paused', 'ended'].includes(state.phase)) return false;
      options.onBeforePlay?.();
      if (!current(attempt) || transport !== owned) return false;
      // The engine invokes resume() within this explicit gesture and guards
      // any late acknowledgment before scheduling nodes.
      const played = await owned.play();
      return current(attempt) && transport === owned && played;
    },
    pause(expected?: TimelineAudioPreviewContext): void { sync(); if (!disposed && expectedMatches(expected) && canPrepare(state)) transport?.pause(); },
    seek(frame: number, expected?: TimelineAudioPreviewContext): boolean {
      sync();
      if (disposed || !expectedMatches(expected) || !canPrepare(state) || !Number.isSafeInteger(frame) || frame < 0 || frame > AUDIO_PREVIEW_LIMITS.timelineFrames) return false;
      const owned = transport, plan = state.plan;
      if (!owned || !plan) {
        if (active) { invalidate(); clear('cancelled'); }
        options.onExplicitPosition?.(frame); return false;
      }
      const inside = frame >= plan.range.startFrame && frame <= plan.range.endFrame;
      if (inside) owned.seek(frame);
      else { invalidate(); clear('cancelled', '已离开准备区间，请明确准备新的最多 20 秒声音。'); }
      // Exactly one callback for this explicit action; transport RAF never calls it.
      options.onExplicitPosition?.(frame); return inside;
    },
    stop(expected?: TimelineAudioPreviewContext): void {
      sync(); if (disposed || !expectedMatches(expected)) return;
      const frame = transport?.getState().frame ?? state.positionFrame;
      invalidate(); clear('cancelled');
      if (frame !== null) options.onExplicitPosition?.(frame);
    },
    cancel(expected?: TimelineAudioPreviewContext): void { sync(); if (!expectedMatches(expected) || !active) return; invalidate(); clear('cancelled'); },
    /** Native player start or lifecycle revocation. Never persists a position. */
    revoke(): void { if (disposed) return; invalidate(); clear('cancelled'); },
    dispose(): void { invalidate(); disposed = true; state = { ...initial(), retirement: retirementState() }; },
  };
  return controller;
}
export type TimelineAudioPreviewController = ReturnType<typeof createTimelineAudioPreviewController>;
export interface TimelineAudioPreviewView { state: TimelineAudioPreviewState; controller: TimelineAudioPreviewController }


const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Stable, bounded saved-only projection. Public path/URL/provenance data and
 * unrelated library polling cannot become a sound generation identity. */
export function timelineAudioPreviewSourceIdentity(timeline: unknown, assets: unknown): string {
  if (!record(timeline) || !Array.isArray(timeline.tracks) || timeline.tracks.length > 12 ||
      !Array.isArray(timeline.clips) || timeline.clips.length > 100 || !Array.isArray(assets) || assets.length > 10000) return '';
  const project = (value: Record<string, unknown>, fields: readonly string[]): Record<string, string | number | boolean | null> | null => {
    const result: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
      const item = value[field];
      if (item === null || item === undefined) result[field] = null;
      else if (typeof item === 'string' && item.length <= 256 || typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean') result[field] = item;
      else return null;
    }
    return result;
  };
  const top = project(timeline, ['id', 'projectId', 'revision', 'fps', 'durationFrames']);
  const tracks = timeline.tracks.map(value => record(value) ? project(value, ['id', 'kind', 'orderIndex', 'muted', 'hidden']) : null);
  const clips = timeline.clips.map(value => record(value) ? project(value, ['id', 'trackId', 'assetId', 'startFrame', 'durationFrames', 'sourceInFrame', 'gain', 'fadeInFrames', 'fadeOutFrames']) : null);
  if (!top || tracks.some(value => value === null) || clips.some(value => value === null)) return '';
  const wanted = new Set(clips.map(value => value?.assetId));
  const selected = assets.filter(value => record(value) && wanted.has(value.id as string)).map(value => record(value) ?
    project(value, ['id', 'projectId', 'sha256', 'sizeBytes', 'duration', 'mimeType', 'hasAudio']) : null);
  if (selected.length > 100 || selected.some(value => value === null)) return '';
  const order = (a: Record<string, string | number | boolean | null> | null, b: Record<string, string | number | boolean | null> | null): number =>
    String(a?.id).localeCompare(String(b?.id));
  return JSON.stringify([top, tracks.sort(order), clips.sort(order), selected.sort(order)]);
}
/** Only fully admitted sound owns the displayed ephemeral playhead. */
export function timelineAudioPreviewPosition(view: Pick<TimelineAudioPreviewView, 'state'>, savedFrame: number): number {
  return view.state.plan && view.state.positionFrame !== null ? view.state.positionFrame : savedFrame;
}
/** Existing explicit seek behavior remains available when no audition owns it. */
export function seekTimelineAudioPreview(view: TimelineAudioPreviewView, frame: number, fallback: (frame: number) => void): void {
  if (view.state.plan || view.state.phase === 'preparing') view.controller.seek(frame, view.state);
  else fallback(frame);
}

function withPageVisibility(context: TimelineAudioPreviewContext): TimelineAudioPreviewContext {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden' ? context : { ...context, visible: false };
}
export function timelineAudioPreviewViewState(state: TimelineAudioPreviewState, context: TimelineAudioPreviewContext): TimelineAudioPreviewState {
  return sameBinding(state, context) ? { ...state, hasUnsavedDrafts: context.hasUnsavedDrafts } : { ...initial(), ...context, retirement: state.retirement };
}
export function useTimelineAudioPreview(options: TimelineAudioPreviewControllerOptions & { context: TimelineAudioPreviewContext }): TimelineAudioPreviewView {
  const callbacks = useRef(options); callbacks.current = options;
  const [state, setState] = useState<TimelineAudioPreviewState | null>(null);
  const controller = useRef<TimelineAudioPreviewController | null>(null);
  if (!controller.current) controller.current = createTimelineAudioPreviewController({
    readPlan: (input, invocation) => callbacks.current.readPlan(input, invocation),
    getContext: () => withPageVisibility(callbacks.current.getContext?.() ?? callbacks.current.context),
    getInvocation: () => callbacks.current.getInvocation?.() ?? {},
    onExplicitPosition: frame => callbacks.current.onExplicitPosition?.(frame), onBeforePlay: () => callbacks.current.onBeforePlay?.(),
    onUnauthorized: () => callbacks.current.onUnauthorized?.(), onChange: setState,
    ...(options.createContext ? { createContext: () => callbacks.current.createContext!() } : {}),
    ...(options.prepare ? { prepare: (input, invocation) => callbacks.current.prepare!(input, invocation) } : {}),
    ...(options.createTransport ? { createTransport: invocation => callbacks.current.createTransport!(invocation) } : {}),
  });
  const owned = controller.current;
  useLayoutEffect(() => {
    owned.attach(withPageVisibility(callbacks.current.context));
    const visibility = (): void => { owned.setContext(withPageVisibility(callbacks.current.getContext?.() ?? callbacks.current.context)); };
    const pagehide = (): void => owned.revoke();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); owned.dispose(); };
  }, [owned]);
  useLayoutEffect(() => { owned.setContext(withPageVisibility(options.context)); });
  return { state: timelineAudioPreviewViewState(state ?? owned.getState(), withPageVisibility(options.context)), controller: owned };
}
