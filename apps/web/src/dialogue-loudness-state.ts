import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import type { ExportLoudnessTarget } from '@mioon/contracts/export-loudness';
import { TIMELINE_CLIP_LOUDNESS_LIMITS, TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU, isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';
import type { TimelineClipLoudnessInput } from '@mioon/contracts/timeline-clip-loudness';
import { parseTimelineMixLoudnessTarget } from './timeline-mix-loudness-state.ts';
import type { ExportLoudnessDraft } from './export-loudness-state.ts';
import { timelineClipLoudnessErrorMessage } from './timeline-clip-loudness-state.ts';

// Matches the loudness of every saved clip marked human voice. Each clip is
// measured on its own through the existing read-only clip loudness operation,
// one at a time; the kept suggestions are applied as one timeline edit.
export interface DialogueLoudnessClip {
  readonly id: string; readonly name: string; readonly trackId: string; readonly assetId: string;
  readonly startFrame: number; readonly durationFrames: number; readonly gain: number; readonly audioRole?: string | null;
}
export interface DialogueLoudnessTrack { readonly id: string; readonly name: string; readonly orderIndex: number; readonly muted: boolean }
export interface DialogueLoudnessContext {
  readonly scope: string | null;
  readonly executionScope: string;
  readonly projectId: string | null;
  readonly timelineId: string | null;
  readonly revision: number | null;
  /** Saved timeline and referenced public source metadata; it changes whenever the clips below can. */
  readonly sourceIdentity: string;
  readonly clips: readonly DialogueLoudnessClip[];
  readonly tracks: readonly DialogueLoudnessTrack[];
  /** Saved asset SHA-256 by asset id; the server re-verifies the bytes. */
  readonly assetHashes: Readonly<Record<string, string>>;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly hasUnsavedDrafts: boolean;
  readonly pending: boolean;
}
export type DialogueLoudnessSkip = 'muted' | 'zeroGain' | 'tooLong' | 'noSource';
export type DialogueLoudnessRowStatus = 'waiting' | 'measuring' | 'measured' | 'unavailable' | 'failed' | 'skipped';
export interface DialogueLoudnessRow {
  readonly clipId: string; readonly name: string; readonly trackName: string; readonly startFrame: number; readonly gain: number;
  readonly status: DialogueLoudnessRowStatus;
  readonly skip?: DialogueLoudnessSkip;
  /** The clip as saved: post gain and fades, before the mix. Null when it has no integrated loudness. */
  readonly integratedLufs?: number | null;
  readonly truePeakDbtp?: number | null;
  readonly requiredGainDb?: number;
  readonly afterGain?: number;
  /** Peak of the scaled clip, measured again by the server. */
  readonly afterTruePeakDbtp?: number | null;
  readonly meetsTruePeak?: boolean;
  readonly reason?: 'NO_VALID_LOUDNESS' | 'GAIN_OUT_OF_RANGE';
  readonly error?: string;
  readonly selected: boolean;
}
export type DialogueLoudnessPhase = 'idle' | 'measuring' | 'ready' | 'applying' | 'applied' | 'stale' | 'cancelled' | 'error';
export interface DialogueLoudnessState extends DialogueLoudnessContext {
  readonly draft: ExportLoudnessDraft;
  readonly version: number;
  readonly phase: DialogueLoudnessPhase;
  readonly rows: readonly DialogueLoudnessRow[];
  readonly target: ExportLoudnessTarget | null;
  readonly progress: Readonly<{ done: number; total: number }>;
  readonly applied: number;
  readonly error: string;
}
export interface DialogueLoudnessReadOptions { readonly signal: AbortSignal; readonly expectedWorkspaceOrigin?: string }
export interface DialogueLoudnessControllerOptions {
  readonly read: (input: TimelineClipLoudnessInput, options: DialogueLoudnessReadOptions) => Promise<unknown>;
  /** Applies the kept gains at the measured revision; resolves true once the edit is saved. */
  readonly apply: (gains: readonly { clipId: string; gain: number }[], expectedRevision: number) => Promise<boolean>;
  readonly getContext?: () => DialogueLoudnessContext;
  readonly getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  readonly onChange?: (state: DialogueLoudnessState) => void;
  readonly onUnauthorized?: () => void;
  readonly locale?: () => Locale;
}

// The clip inspector's editable starting values, not a delivery standard;
// nothing is sent until the user measures.
export const DIALOGUE_LOUDNESS_DEFAULT_DRAFT: ExportLoudnessDraft = Object.freeze({ integratedLufs: '-14', truePeakCeilingDbtp: '-1' });
const initial = (): DialogueLoudnessState => ({ scope: null, executionScope: '', projectId: null, timelineId: null, revision: null,
  sourceIdentity: '', clips: [], tracks: [], assetHashes: {}, connected: false, visible: false, restored: false, hasUnsavedDrafts: false,
  pending: false, draft: DIALOGUE_LOUDNESS_DEFAULT_DRAFT, version: 0, phase: 'idle', rows: [], target: null, progress: { done: 0, total: 0 }, applied: 0, error: '' });
// The clip, track and hash lists derive from the saved timeline that the
// revision and source identity already name, so they are not compared.
const contextKeys = ['scope', 'executionScope', 'projectId', 'timelineId', 'revision', 'sourceIdentity',
  'connected', 'visible', 'restored', 'hasUnsavedDrafts', 'pending'] as const;
const sameContext = (a: DialogueLoudnessContext, b: DialogueLoudnessContext): boolean => contextKeys.every(key => a[key] === b[key]);
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
// Failures that make every later reading meaningless stop the whole pass.
const fatal = (code: string): boolean => code === 'UNAUTHORIZED' || code === 'OPERATION_CANCELLED' || code.startsWith('RESTORE_') ||
  code === 'TIMELINE_CLIP_LOUDNESS_REVISION_CONFLICT' || code === 'TIMELINE_CLIP_LOUDNESS_STALE';

export function dialogueLoudnessAvailable(context: DialogueLoudnessContext): boolean {
  return Boolean(context.scope && context.projectId && context.timelineId && Number.isSafeInteger(context.revision) && (context.revision ?? 0) > 0 &&
    context.sourceIdentity && context.connected && context.visible && !context.restored && !context.hasUnsavedDrafts && !context.pending);
}
/** Both targets are required, as for the whole-timeline candidate. */
export function parseDialogueLoudnessTarget(draft: ExportLoudnessDraft, locale: Locale = 'zh-Hans'): Readonly<{ target?: ExportLoudnessTarget; error: string }> {
  return parseTimelineMixLoudnessTarget(draft, locale);
}
/** Every saved human-voice clip in timeline order, with the reason it cannot be measured, if any. */
export function dialogueLoudnessRows(context: Pick<DialogueLoudnessContext, 'clips' | 'tracks' | 'assetHashes'>): DialogueLoudnessRow[] {
  const tracks = new Map(context.tracks.map(track => [track.id, track]));
  return context.clips.filter(clip => clip.audioRole === 'human' && tracks.has(clip.trackId))
    .sort((a, b) => a.startFrame - b.startFrame || tracks.get(a.trackId)!.orderIndex - tracks.get(b.trackId)!.orderIndex)
    .map(clip => {
      const track = tracks.get(clip.trackId)!;
      const skip: DialogueLoudnessSkip | undefined = track.muted ? 'muted' : !(clip.gain > 0) ? 'zeroGain' :
        clip.durationFrames > TIMELINE_CLIP_LOUDNESS_LIMITS.clipFrames ? 'tooLong' : !context.assetHashes[clip.assetId] ? 'noSource' : undefined;
      return Object.freeze({ clipId: clip.id, name: clip.name, trackName: track.name, startFrame: clip.startFrame, gain: clip.gain,
        status: skip ? 'skipped' : 'waiting', ...(skip ? { skip } : {}), selected: false }) as DialogueLoudnessRow;
    });
}
/** A measured row is kept by default only when it moves the clip and stays under the peak ceiling. */
export function dialogueLoudnessSuggested(row: DialogueLoudnessRow): boolean {
  return row.status === 'measured' && row.meetsTruePeak === true && row.afterGain !== undefined && row.afterGain !== row.gain &&
    Math.abs(row.requiredGainDb ?? 0) >= TIMELINE_CLIP_LOUDNESS_TARGET_TOLERANCE_LU;
}
export function dialogueLoudnessGains(state: Pick<DialogueLoudnessState, 'rows'>): { clipId: string; gain: number }[] {
  return state.rows.filter(row => row.status === 'measured' && row.selected && row.afterGain !== undefined && row.afterGain !== row.gain)
    .map(row => ({ clipId: row.clipId, gain: row.afterGain! }));
}
/** Suppress prior readings during the render before the context effect runs. */
export function dialogueLoudnessViewState(state: DialogueLoudnessState, context: DialogueLoudnessContext): DialogueLoudnessState {
  if (sameContext(state, context)) return state;
  const ownerChanged = state.scope !== context.scope || state.projectId !== context.projectId || state.timelineId !== context.timelineId;
  // Applying flips the pending fence and then moves the revision; the apply
  // itself settles the phase unless the owner changed underneath it.
  if (state.phase === 'applying' && !ownerChanged) return Object.freeze({ ...state, ...context, version: state.version + 1 });
  const phase: DialogueLoudnessPhase = state.phase === 'idle' ? 'idle' : state.phase === 'measuring' ? 'cancelled' :
    state.phase === 'applied' && !ownerChanged ? 'applied' : 'stale';
  return Object.freeze({ ...state, ...context, version: state.version + 1, draft: ownerChanged ? DIALOGUE_LOUDNESS_DEFAULT_DRAFT : state.draft,
    phase: ownerChanged && phase !== 'idle' ? 'idle' : phase, rows: [], target: null, progress: { done: 0, total: 0 },
    applied: phase === 'applied' ? state.applied : 0, error: '' });
}
export function dialogueLoudnessStatusMessage(state: DialogueLoudnessState, locale: Locale = 'zh-Hans'): string {
  if (state.phase === 'measuring') return translate(locale, 'audio.loudness.dialogue.progress', { done: state.progress.done + 1, total: state.progress.total });
  if (state.phase === 'ready') {
    // An unavailable reading was still measured; only its suggestion is missing.
    const measured = state.rows.filter(row => row.status === 'measured' || row.status === 'unavailable').length;
    return translate(locale, 'audio.loudness.dialogue.summary', { count: measured, selected: dialogueLoudnessGains(state).length });
  }
  if (state.phase === 'applying') return translate(locale, 'audio.loudness.dialogue.applying');
  if (state.phase === 'applied') return translate(locale, 'audio.loudness.dialogue.applied', { count: state.applied });
  if (state.phase === 'stale') return translate(locale, 'audio.loudness.dialogue.stale');
  if (state.phase === 'cancelled') return translate(locale, 'audio.loudness.dialogue.cancelled');
  if (state.phase === 'error') return state.error;
  return '';
}
const protocolError = (): Error => Object.assign(new Error('Invalid saved clip loudness response'), { code: 'BACKEND_PROTOCOL_ERROR' });

export function createDialogueLoudnessController(options: DialogueLoudnessControllerOptions) {
  let state = initial(), generation = 0, version = 0, applying = 0, disposed = false;
  let active: AbortController | null = null;
  const locale = (): Locale => options.locale?.() ?? 'zh-Hans';
  const emit = (patch: Partial<DialogueLoudnessState>): void => { state = Object.freeze({ ...state, ...patch }); options.onChange?.(state); };
  const invalidate = (): void => { generation++; const previous = active; active = null; previous?.abort(); };
  const sync = (): void => { if (!disposed && options.getContext) controller.setContext(options.getContext()); };
  const allowed = (expected: DialogueLoudnessState): boolean => {
    sync();
    return !disposed && expected.version === state.version && sameContext(expected, state) && dialogueLoudnessAvailable(state);
  };
  const current = (attempt: number, captured: DialogueLoudnessState, abort: AbortController): boolean => {
    sync();
    return !disposed && generation === attempt && active === abort && !abort.signal.aborted && sameContext(captured, state) && dialogueLoudnessAvailable(state);
  };
  const patchRow = (clipId: string, patch: Partial<DialogueLoudnessRow>): readonly DialogueLoudnessRow[] =>
    Object.freeze(state.rows.map(row => row.clipId === clipId ? Object.freeze({ ...row, ...patch }) : row));
  const controller = {
    getState: (): DialogueLoudnessState => state,
    attach(context: DialogueLoudnessContext): void { disposed = false; controller.setContext(context); },
    setContext(context: DialogueLoudnessContext): void {
      if (disposed || sameContext(state, context)) return;
      invalidate();
      // A late apply result never speaks for another project or timeline.
      if (state.scope !== context.scope || state.projectId !== context.projectId || state.timelineId !== context.timelineId) applying++;
      const next = dialogueLoudnessViewState(state, context);
      emit({ ...next, version: ++version });
    },
    setDraft(draft: ExportLoudnessDraft, expected: DialogueLoudnessState): boolean {
      if (!allowed(expected) || state.phase === 'measuring' || state.phase === 'applying' || typeof draft.integratedLufs !== 'string' ||
        typeof draft.truePeakCeilingDbtp !== 'string' || draft.integratedLufs.length > 32 || draft.truePeakCeilingDbtp.length > 32) return false;
      if (draft.integratedLufs === state.draft.integratedLufs && draft.truePeakCeilingDbtp === state.draft.truePeakCeilingDbtp) return true;
      // Readings belong to the target they were taken for.
      emit({ draft: Object.freeze({ integratedLufs: draft.integratedLufs, truePeakCeilingDbtp: draft.truePeakCeilingDbtp }),
        version: ++version, phase: 'idle', rows: [], target: null, progress: { done: 0, total: 0 }, applied: 0, error: '' });
      return true;
    },
    /** Measures every measurable dialogue clip in turn; never writes. */
    async analyze(expected: DialogueLoudnessState): Promise<boolean> {
      if (!allowed(expected) || active || state.phase === 'applying') return false;
      const parsed = parseDialogueLoudnessTarget(state.draft, locale());
      if (!parsed.target || !state.projectId || !state.timelineId || !state.revision) return false;
      const rows = dialogueLoudnessRows(state), queue = rows.filter(row => row.status === 'waiting');
      if (!queue.length) return false;
      const attempt = ++generation, abort = new AbortController(); active = abort;
      const target = parsed.target, base = { projectId: state.projectId, timelineId: state.timelineId, expectedRevision: state.revision,
        measurementProfile: EXPORT_LOUDNESS_PROFILE as typeof EXPORT_LOUDNESS_PROFILE, target };
      emit({ version: ++version, phase: 'measuring', rows: Object.freeze(rows), target, progress: { done: 0, total: queue.length }, applied: 0, error: '' });
      const captured = state;
      try {
        for (const [index, row] of queue.entries()) {
          if (!current(attempt, captured, abort)) return false;
          const clip = state.clips.find(item => item.id === row.clipId)!;
          const input: TimelineClipLoudnessInput = Object.freeze({ ...base, clipId: clip.id, expectedAssetSha256: state.assetHashes[clip.assetId] });
          emit({ rows: patchRow(row.clipId, { status: 'measuring' }), progress: { done: index, total: queue.length } });
          try {
            const invocation = options.getInvocation?.() ?? {};
            const result = await options.read(input, { ...invocation, signal: abort.signal });
            if (!current(attempt, captured, abort)) return false;
            if (!isTimelineClipLoudnessResponse(result, input) || !result.candidate) throw protocolError();
            const candidate = result.candidate, measured = candidate.status === 'measured';
            const next: DialogueLoudnessRow = Object.freeze({ ...state.rows.find(item => item.clipId === row.clipId)!,
              status: measured ? 'measured' : 'unavailable', integratedLufs: result.measurement.integratedLufs, truePeakDbtp: result.measurement.truePeakDbtp,
              ...(measured ? { requiredGainDb: candidate.requiredGainDb, afterGain: candidate.afterGain, afterTruePeakDbtp: candidate.measurement.truePeakDbtp,
                meetsTruePeak: candidate.meetsTruePeak } : { reason: candidate.reason }), selected: false });
            emit({ rows: patchRow(row.clipId, { ...next, selected: dialogueLoudnessSuggested(next) }) });
          } catch (error: unknown) {
            if (!current(attempt, captured, abort)) return false;
            const code = codeOf(error);
            if (fatal(code)) {
              if (code === 'UNAUTHORIZED') options.onUnauthorized?.();
              emit({ phase: code.endsWith('_STALE') || code.endsWith('_REVISION_CONFLICT') ? 'stale' : 'error', rows: [], target: null,
                error: timelineClipLoudnessErrorMessage(error, locale()) });
              return false;
            }
            emit({ rows: patchRow(row.clipId, { status: 'failed', error: timelineClipLoudnessErrorMessage(error, locale()) }) });
          }
        }
        if (!current(attempt, captured, abort)) return false;
        emit({ phase: 'ready', progress: { done: queue.length, total: queue.length } });
        return true;
      } finally { if (active === abort) active = null; }
    },
    toggle(clipId: string, selected: boolean, expected: DialogueLoudnessState): boolean {
      if (!allowed(expected) || state.phase !== 'ready') return false;
      const row = state.rows.find(item => item.clipId === clipId);
      if (!row || row.status !== 'measured' || row.afterGain === row.gain) return false;
      emit({ rows: patchRow(clipId, { selected }), version: ++version });
      return true;
    },
    /** Applies the kept gains once, at the measured revision. */
    async apply(expected: DialogueLoudnessState): Promise<boolean> {
      if (!allowed(expected) || active || state.phase !== 'ready' || !state.revision) return false;
      const gains = dialogueLoudnessGains(state);
      if (!gains.length) return false;
      const attempt = ++applying, revision = state.revision, captured = state;
      emit({ version: ++version, phase: 'applying', error: '' });
      let saved = false;
      try { saved = await options.apply(gains, revision); } catch { saved = false; }
      if (disposed || applying !== attempt) return saved;
      sync();
      // A saved edit moved the revision, so its readings are spent and only the
      // count remains. An unsaved one keeps them while nothing else changed.
      if (saved) emit({ version: ++version, phase: 'applied', applied: gains.length, rows: [], target: null, progress: { done: 0, total: 0 } });
      else if (state.revision === captured.revision && state.sourceIdentity === captured.sourceIdentity) emit({ version: ++version, phase: 'ready' });
      else emit({ version: ++version, phase: 'stale', rows: [], target: null, progress: { done: 0, total: 0 } });
      return saved;
    },
    cancel(expected: DialogueLoudnessState): void {
      if (!allowed(expected) || !active) return;
      invalidate(); emit({ version: ++version, phase: 'cancelled', rows: [], target: null, progress: { done: 0, total: 0 }, error: '' });
    },
    revoke(expected?: DialogueLoudnessState): void {
      // An apply in flight settles on its own; closing the card does not abandon it.
      if (disposed || state.phase === 'applying' || expected && !allowed(expected)) return;
      invalidate();
      emit({ version: ++version, phase: state.phase === 'idle' || state.phase === 'applied' ? state.phase : 'cancelled', rows: [], target: null,
        progress: { done: 0, total: 0 }, error: '' });
    },
    dispose(): void { invalidate(); applying++; disposed = true; state = { ...initial(), version: ++version }; },
  };
  return controller;
}
export type DialogueLoudnessController = ReturnType<typeof createDialogueLoudnessController>;
export interface DialogueLoudnessView { readonly state: DialogueLoudnessState; readonly controller: DialogueLoudnessController }
