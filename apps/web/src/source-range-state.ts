import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/types.ts';
import { TimelineUiError, timelineFailure } from './timeline-notices.ts';
import { SOURCE_RANGE_FPS, sourceFrameCount, isSourceRangeResponse } from '@mioon/contracts';
import type { SourceRange, SourceRangeResponse } from '../../../packages/contracts/src/source-range.ts';
import { MAX_TIMELINE_FRAME } from './timeline-snapping.ts';

export { SOURCE_RANGE_FPS, sourceFrameCount };
export interface SourceRangeAsset {
  readonly id?: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly duration?: unknown;
}
export interface SourceRangeDraft { inFrame: number | string; outFrame: number | string }
export interface SourceRangeSnapshot {
  readonly projectId: string;
  readonly assetId: string;
  readonly scope: string | null;
  readonly revision: number;
  readonly inFrame: number;
  readonly outFrame: number;
  readonly [key: string]: unknown;
}
export interface SourceRangeContext {
  scope: string | null;
  projectId: string;
  asset: SourceRangeAsset;
}
export interface SourceRangeState {
  scope: string | null;
  row: SourceRangeResponse | null;
  draft: SourceRangeDraft | null;
  baseRevision: number | null;
  dirty: boolean;
  conflict: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  errorMessage?: DisplayMessage;
  position: number;
  seek: { scope: string | null; id: number; frame: number } | null;
}
export interface SourceRangeReadInput { projectId: string; assetId: string }
export interface SourceRangeSaveInput { projectId: string; assetId: string; expectedRevision: number; inFrame: number; outFrame: number }
export interface SourceRangeControllerOptions {
  read: (input: SourceRangeReadInput) => Promise<unknown>;
  save: (input: SourceRangeSaveInput) => Promise<unknown>;
  onChange?: (state: SourceRangeState) => void;
}
export interface SourceRangePlanTrack { id: string }
export interface SourceRangePlanTimeline {
  readonly projectId?: string;
  readonly revision?: number;
  readonly tracks?: readonly { readonly id: string; readonly kind?: string }[];
  readonly clips?: readonly { readonly trackId?: string; readonly startFrame: number; readonly durationFrames: number }[];
}
export interface SourceRangeAddPlan {
  valid: boolean;
  reason: string;
  reasonMessage: DisplayMessage | null;
  startFrame: number;
  durationFrames: number;
  track: SourceRangePlanTrack | undefined;
  expectedRevision: number | undefined;
  input: Readonly<{ trackId: string; assetId: string; name: string | undefined; startFrame: number; durationFrames: number; sourceInFrame: number }> | null;
}

export const supportsSourceRange = (asset: SourceRangeAsset | null | undefined): boolean => /^(video|audio)\//.test(asset?.mimeType || '');
export const sameSourceRange = (left: SourceRange | null | undefined, right: SourceRange | null | undefined): boolean => left?.inFrame === right?.inFrame && left?.outFrame === right?.outFrame;
export function sourceSeekMatchesTime(seconds: number, intendedFrame: number | null | undefined): boolean {
  if (!Number.isFinite(seconds) || seconds < 0 || typeof intendedFrame !== 'number' || !Number.isSafeInteger(intendedFrame) || intendedFrame < 0) return false;
  const intendedSeconds = intendedFrame / SOURCE_RANGE_FPS;
  if (seconds === intendedSeconds) return true;
  // Chromium serializes media positions on a microsecond clock. Recognize only
  // the two adjacent microsecond representations of an explicit integer seek;
  // this is not a tolerance added to arbitrary playback or duration bounds.
  const micros = Math.round(seconds * 1e6), intendedMicros = intendedSeconds * 1e6;
  return Number.isSafeInteger(micros) && seconds === micros / 1e6 &&
    (micros === Math.floor(intendedMicros) || micros === Math.ceil(intendedMicros));
}
export function sourcePositionFrame(seconds: number, count: number | null | undefined, intendedFrame: number | null = null): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const frame = intendedFrame !== null && sourceSeekMatchesTime(seconds, intendedFrame) ? intendedFrame : Math.floor(seconds * SOURCE_RANGE_FPS + 1e-6);
  return Math.max(0, Math.min(count ?? Number.MAX_SAFE_INTEGER, frame));
}
export function sourceRangeMessage(range: { readonly inFrame?: unknown; readonly outFrame?: unknown } | null | undefined, count: number | null | undefined): DisplayMessage | null {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return message('timeline.range.error.durationUnknown');
  if (!range || range.inFrame === '' || range.outFrame === '') return message('timeline.range.error.required');
  const start = Number(range.inFrame), end = Number(range.outFrame);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return message('timeline.range.error.integer');
  if (start < 0 || start >= end || end > count) return message('timeline.range.error.bounds', { count });
  return null;
}
export function sourceRangeIssue(range: { readonly inFrame?: unknown; readonly outFrame?: unknown } | null | undefined, count: number | null | undefined): string { return renderMessage('zh-Hans', sourceRangeMessage(range, count)); }
function validRow(row: unknown, context: SourceRangeContext | null): row is SourceRangeResponse {
  if (!context) return false;
  return isSourceRangeResponse(row) && row.assetId === context.asset.id && row.projectId === context.projectId && row.sourceFrameCount === sourceFrameCount(context.asset.duration);
}
export function sameSourceSnapshot(left: SourceRangeSnapshot | null | undefined, right: SourceRangeSnapshot | null | undefined): boolean {
  return Boolean(left && right && ['scope', 'projectId', 'assetId', 'revision', 'inFrame', 'outFrame'].every(key => left[key] === right[key]));
}
const cloneRange = (range: SourceRange | null | undefined): SourceRange | null => range ? { inFrame: range.inFrame, outFrame: range.outFrame } : null;
const copyRow = (row: SourceRangeResponse): SourceRangeResponse => ({ ...row, range: cloneRange(row.range) });
const initialState = (): SourceRangeState => ({ scope: null, row: null, draft: null, baseRevision: null, dirty: false, conflict: false, loading: false, saving: false, error: '', position: 0, seek: null });

// The controller owns only the currently selected source. It is mounted above
// the dock, so hidden Properties/Agent panes never discard the draft. Every
// async completion must still own the same project/asset/selection epoch.
export function createSourceRangeController({ read, save, onChange = () => {} }: SourceRangeControllerOptions) {
  let state = initialState(), context: SourceRangeContext | null = null, epoch = 0, readGeneration = 0, editSerial = 0, seekSerial = 0;
  const emit = (patch: Partial<SourceRangeState>): SourceRangeState => { state = { ...state, ...patch }; onChange(state); return state; };
  const owns = (token: number): boolean => token === epoch && context !== null;
  function mergeRow(row: unknown, { acknowledgedSerial }: { acknowledgedSerial?: number } = {}): boolean {
    if (!validRow(row, context)) throw new TimelineUiError(message('timeline.range.error.invalidReply'));
    if (state.row && row.revision < state.row.revision) return false;
    if (state.row?.revision === row.revision && !sameSourceRange(state.row.range, row.range)) throw new TimelineUiError(message('timeline.range.error.inconsistentReply'));
    const draft: SourceRangeDraft = cloneRange(row.range) || { inFrame: 0, outFrame: row.sourceFrameCount ?? '' };
    if (acknowledgedSerial !== undefined) {
      emit({ row: copyRow(row), baseRevision: row.revision, conflict: false, error: '',
        ...(editSerial === acknowledgedSerial ? { draft, dirty: false } : { dirty: true }) });
    } else if (!state.dirty) {
      emit({ row: copyRow(row), draft, baseRevision: row.revision, conflict: false, error: '' });
    } else {
      emit({ row: copyRow(row), conflict: row.revision !== state.baseRevision, error: '' });
    }
    return true;
  }
  async function load(): Promise<SourceRangeResponse | null> {
    if (!context || !supportsSourceRange(context.asset)) return null;
    const owner = epoch, generation = ++readGeneration, captured = context;
    emit({ loading: true, error: '' });
    try {
      const row = await read({ projectId: captured.projectId, assetId: captured.asset.id ?? '' });
      if (!owns(owner) || generation !== readGeneration) return null;
      mergeRow(row); return row as SourceRangeResponse;
    } catch (error) {
      if (owns(owner) && generation === readGeneration) emit({ ...timelineFailure('error', error, message('timeline.range.error.readFailed')) });
      return null;
    } finally { if (owns(owner) && generation === readGeneration) emit({ loading: false }); }
  }
  return {
    getState: (): SourceRangeState => state,
    setContext(next: SourceRangeContext | null): void {
      if ((next && context?.scope === next.scope) || (!next && state.scope === null)) return;
      epoch++; readGeneration++; editSerial = 0; context = next;
      state = { ...initialState(), scope: next?.scope || null };
      onChange(state);
      if (next && supportsSourceRange(next.asset)) void load();
    },
    dispose(): void { epoch++; readGeneration++; context = null; },
    read: load,
    edit(key: 'inFrame' | 'outFrame', value: number | string): void {
      const draft = state.draft;
      if (!context || !state.row || !draft || !['inFrame', 'outFrame'].includes(key)) return;
      editSerial++;
      const next: SourceRangeDraft = key === 'inFrame' ? { inFrame: value, outFrame: draft.outFrame } : { inFrame: draft.inFrame, outFrame: value };
      emit({ draft: next, dirty: true });
    },
    discard(): void {
      if (!state.row) return;
      editSerial++;
      emit({ draft: cloneRange(state.row.range) || { inFrame: 0, outFrame: state.row.sourceFrameCount ?? '' }, baseRevision: state.row.revision, dirty: false, conflict: false, error: '' });
    },
    position(frame: number, scope: string | null): void {
      if (!context || scope !== context.scope || !Number.isSafeInteger(frame) || frame < 0) return;
      emit({ position: Math.min(frame, sourceFrameCount(context.asset.duration) ?? frame) });
    },
    seek(frame: number): void {
      const count = context && sourceFrameCount(context.asset.duration);
      if (!context || !Number.isSafeInteger(frame) || count === null || frame < 0 || frame > count) return;
      emit({ seek: { scope: context.scope, id: ++seekSerial, frame } });
    },
    async save(): Promise<SourceRangeResponse | null> {
      const draft = state.draft, row = state.row, expectedRevision = state.baseRevision;
      if (!context || !row || !draft || expectedRevision === null || state.loading || state.saving || state.conflict || sourceRangeIssue(draft, row.sourceFrameCount)) return null;
      const owner = epoch, captured = context, serial = editSerial;
      const input: SourceRangeSaveInput = { projectId: captured.projectId, assetId: captured.asset.id ?? '', expectedRevision, inFrame: Number(draft.inFrame), outFrame: Number(draft.outFrame) };
      // Invalidate any GET that began before this request, including one whose
      // reply could otherwise race with the acknowledged saved revision.
      readGeneration++; emit({ saving: true, loading: false, error: '' });
      try {
        const result = await save(input);
        if (!owns(owner)) return null;
        if (!result) {
          emit({ dirty: true, error: '保存尚未确认；草稿已保留。请检查任务中的原请求或重新读取范围。', errorMessage: message('timeline.range.error.saveUnconfirmed') });
          await load();
          return null;
        }
        readGeneration++;
        if (!validRow(result, captured) || result.revision !== input.expectedRevision + 1 || result.range?.inFrame !== input.inFrame || result.range?.outFrame !== input.outFrame) throw new TimelineUiError(message('timeline.range.error.saveMismatch'));
        const merged = mergeRow(result, { acknowledgedSerial: serial });
        if (!merged) emit({ dirty: true, conflict: true, error: '范围已出现更新版本；已保留当前输入，请核对后继续。', errorMessage: message('timeline.range.error.newerRange') });
        return result;
      } catch (error) {
        if (owns(owner)) emit({ dirty: true, ...timelineFailure('error', error, message('timeline.range.error.saveFailed')) });
        return null;
      } finally { if (owns(owner)) emit({ saving: false, loading: false }); }
    },
    snapshot(): Readonly<SourceRangeSnapshot> | null {
      if (!context || !state.row?.range || state.row.revision < 1 || state.dirty || state.conflict || state.loading || state.saving || state.error || sourceRangeIssue(state.row.range, state.row.sourceFrameCount)) return null;
      return Object.freeze({ projectId: context.projectId, assetId: context.asset.id ?? '', scope: context.scope, revision: state.row.revision, ...state.row.range });
    },
  };
}

export function sourceRangeAddPlan({ snapshot, asset, timeline, blocked = false }: {
  snapshot: SourceRangeSnapshot | null | undefined;
  asset: SourceRangeAsset | null | undefined;
  timeline: SourceRangePlanTimeline | null | undefined;
  blocked?: boolean;
}): SourceRangeAddPlan {
  let reason = '', reasonMessage: DisplayMessage | null = null;
  if (blocked) { reason = '请先确认正在处理的范围或时间线请求。'; reasonMessage = message('timeline.range.error.pending'); }
  else if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) { reason = '请先明确保存源范围，且确保没有未保存修改。'; reasonMessage = message('timeline.range.error.saveFirst'); }
  else if (!asset || !supportsSourceRange(asset) || asset.id !== snapshot.assetId || asset.projectId !== snapshot.projectId || timeline?.projectId !== snapshot.projectId) { reason = '源素材或时间线已变化，请重新选择。'; reasonMessage = message('timeline.range.error.changed'); }
  else if (!Number.isSafeInteger(snapshot.inFrame) || !Number.isSafeInteger(snapshot.outFrame)) { reason = '已保存范围必须使用整数帧。'; reasonMessage = message('timeline.range.error.savedInteger'); }
  else { reasonMessage = sourceRangeMessage(snapshot, sourceFrameCount(asset.duration)); reason = renderMessage('zh-Hans', reasonMessage); }
  const kind = asset?.mimeType?.startsWith('audio/') ? 'audio' : 'video';
  const track = timeline?.tracks?.find(item => item.kind === kind);
  const startFrame = track ? Math.max(0, ...(timeline?.clips || []).filter(clip => clip.trackId === track.id).map(clip => clip.startFrame + clip.durationFrames)) : 0;
  const durationFrames = snapshot ? snapshot.outFrame - snapshot.inFrame : 0;
  if (!reason && !track) { reasonMessage = message(kind === 'audio' ? 'timeline.range.error.audioTrack' : 'timeline.range.error.videoTrack'); reason = renderMessage('zh-Hans', reasonMessage); }
  if (!reason && (!Number.isSafeInteger(startFrame + durationFrames) || startFrame + durationFrames > MAX_TIMELINE_FRAME)) { reason = '追加后的终点超过时间线 18000 帧上限；请缩短已保存范围或调整轨道。'; reasonMessage = message('timeline.range.error.tooLong'); }
  if (!reason && (timeline?.clips || []).length >= 100) { reason = '时间线最多容纳 100 个片段。'; reasonMessage = message('timeline.range.error.clipLimit'); }
  return { valid: !reason, reason, reasonMessage, startFrame, durationFrames, track, expectedRevision: timeline?.revision,
    input: reason || !track || !snapshot || !asset ? null : Object.freeze({ trackId: track.id, assetId: asset.id ?? '', name: asset.name, startFrame, durationFrames, sourceInFrame: snapshot.inFrame }) };
}
