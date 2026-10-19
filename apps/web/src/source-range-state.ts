import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import { TimelineUiError, timelineFailure } from './timeline-notices.ts';
import { SOURCE_RANGE_FPS, sourceFrameCount, isSourceRangeResponse } from '@mioon/contracts';
import { MAX_TIMELINE_FRAME } from './timeline-snapping.ts';

export { SOURCE_RANGE_FPS, sourceFrameCount };
export const supportsSourceRange = asset => /^(video|audio)\//.test(asset?.mimeType || '');
export const sameSourceRange = (left, right) => left?.inFrame === right?.inFrame && left?.outFrame === right?.outFrame;
export function sourceSeekMatchesTime(seconds, intendedFrame) {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(intendedFrame) || intendedFrame < 0) return false;
  const intendedSeconds = intendedFrame / SOURCE_RANGE_FPS;
  if (seconds === intendedSeconds) return true;
  // Chromium serializes media positions on a microsecond clock. Recognize only
  // the two adjacent microsecond representations of an explicit integer seek;
  // this is not a tolerance added to arbitrary playback or duration bounds.
  const micros = Math.round(seconds * 1e6), intendedMicros = intendedSeconds * 1e6;
  return Number.isSafeInteger(micros) && seconds === micros / 1e6 &&
    (micros === Math.floor(intendedMicros) || micros === Math.ceil(intendedMicros));
}
export function sourcePositionFrame(seconds, count, intendedFrame = null) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const frame = sourceSeekMatchesTime(seconds, intendedFrame) ? intendedFrame : Math.floor(seconds * SOURCE_RANGE_FPS + 1e-6);
  return Math.max(0, Math.min(count ?? Number.MAX_SAFE_INTEGER, frame));
}
export function sourceRangeMessage(range, count) {
  if (!Number.isSafeInteger(count) || count < 1) return message('timeline.range.error.durationUnknown');
  if (!range || range.inFrame === '' || range.outFrame === '') return message('timeline.range.error.required');
  const start = Number(range.inFrame), end = Number(range.outFrame);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return message('timeline.range.error.integer');
  if (start < 0 || start >= end || end > count) return message('timeline.range.error.bounds', { count });
  return null;
}
export function sourceRangeIssue(range, count) { return renderMessage('zh-Hans', sourceRangeMessage(range, count)); }
function validRow(row, context) {
  return isSourceRangeResponse(row) && row.assetId === context.asset.id && row.projectId === context.projectId && row.sourceFrameCount === sourceFrameCount(context.asset.duration);
}
export function sameSourceSnapshot(left, right) {
  return Boolean(left && right && ['scope', 'projectId', 'assetId', 'revision', 'inFrame', 'outFrame'].every(key => left[key] === right[key]));
}
const cloneRange = range => range ? { inFrame: range.inFrame, outFrame: range.outFrame } : null;
const copyRow = row => ({ ...row, range: cloneRange(row.range) });
const initialState = () => ({ scope: null, row: null, draft: null, baseRevision: null, dirty: false, conflict: false, loading: false, saving: false, error: '', position: 0, seek: null });

// The controller owns only the currently selected source. It is mounted above
// the dock, so hidden Properties/Agent panes never discard the draft. Every
// async completion must still own the same project/asset/selection epoch.
export function createSourceRangeController({ read, save, onChange = () => {} }) {
  let state = initialState(), context = null, epoch = 0, readGeneration = 0, editSerial = 0, seekSerial = 0;
  const emit = patch => { state = { ...state, ...patch }; onChange(state); return state; };
  const owns = token => token === epoch && context !== null;
  function mergeRow(row, { acknowledgedSerial } = {}) {
    if (!validRow(row, context)) throw new TimelineUiError(message('timeline.range.error.invalidReply'));
    if (state.row && row.revision < state.row.revision) return false;
    if (state.row?.revision === row.revision && !sameSourceRange(state.row.range, row.range)) throw new TimelineUiError(message('timeline.range.error.inconsistentReply'));
    const draft = cloneRange(row.range) || { inFrame: 0, outFrame: row.sourceFrameCount ?? '' };
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
  async function load() {
    if (!context || !supportsSourceRange(context.asset)) return null;
    const owner = epoch, generation = ++readGeneration, captured = context;
    emit({ loading: true, error: '' });
    try {
      const row = await read({ projectId: captured.projectId, assetId: captured.asset.id });
      if (!owns(owner) || generation !== readGeneration) return null;
      mergeRow(row); return row;
    } catch (error) {
      if (owns(owner) && generation === readGeneration) emit({ ...timelineFailure('error', error, message('timeline.range.error.readFailed')) });
      return null;
    } finally { if (owns(owner) && generation === readGeneration) emit({ loading: false }); }
  }
  return {
    getState: () => state,
    setContext(next) {
      if ((next && context?.scope === next.scope) || (!next && state.scope === null)) return;
      epoch++; readGeneration++; editSerial = 0; context = next;
      state = { ...initialState(), scope: next?.scope || null };
      onChange(state);
      if (next && supportsSourceRange(next.asset)) void load();
    },
    dispose() { epoch++; readGeneration++; context = null; },
    read: load,
    edit(key, value) {
      if (!context || !state.row || !['inFrame', 'outFrame'].includes(key)) return;
      editSerial++; emit({ draft: { ...state.draft, [key]: value }, dirty: true });
    },
    discard() {
      if (!state.row) return;
      editSerial++;
      emit({ draft: cloneRange(state.row.range) || { inFrame: 0, outFrame: state.row.sourceFrameCount ?? '' }, baseRevision: state.row.revision, dirty: false, conflict: false, error: '' });
    },
    position(frame, scope) {
      if (!context || scope !== context.scope || !Number.isSafeInteger(frame) || frame < 0) return;
      emit({ position: Math.min(frame, sourceFrameCount(context.asset.duration) ?? frame) });
    },
    seek(frame) {
      const count = context && sourceFrameCount(context.asset.duration);
      if (!context || !Number.isSafeInteger(frame) || count === null || frame < 0 || frame > count) return;
      emit({ seek: { scope: context.scope, id: ++seekSerial, frame } });
    },
    async save() {
      if (!context || !state.row || state.loading || state.saving || state.conflict || sourceRangeIssue(state.draft, state.row.sourceFrameCount)) return null;
      const owner = epoch, captured = context, serial = editSerial;
      const input = { projectId: captured.projectId, assetId: captured.asset.id, expectedRevision: state.baseRevision, inFrame: Number(state.draft.inFrame), outFrame: Number(state.draft.outFrame) };
      // Invalidate any GET that began before this request, including one whose
      // reply could otherwise race with the acknowledged saved revision.
      readGeneration++; emit({ saving: true, loading: false, error: '' });
      try {
        const row = await save(input);
        if (!owns(owner)) return null;
        if (!row) {
          emit({ dirty: true, error: '保存尚未确认；草稿已保留。请检查任务中的原请求或重新读取范围。', errorMessage: message('timeline.range.error.saveUnconfirmed') });
          await load();
          return null;
        }
        readGeneration++;
        if (!validRow(row, captured) || row.revision !== input.expectedRevision + 1 || row.range?.inFrame !== input.inFrame || row.range?.outFrame !== input.outFrame) throw new TimelineUiError(message('timeline.range.error.saveMismatch'));
        const merged = mergeRow(row, { acknowledgedSerial: serial });
        if (!merged) emit({ dirty: true, conflict: true, error: '范围已出现更新版本；已保留当前输入，请核对后继续。', errorMessage: message('timeline.range.error.newerRange') });
        return row;
      } catch (error) {
        if (owns(owner)) emit({ dirty: true, ...timelineFailure('error', error, message('timeline.range.error.saveFailed')) });
        return null;
      } finally { if (owns(owner)) emit({ saving: false, loading: false }); }
    },
    snapshot() {
      if (!context || !state.row?.range || state.row.revision < 1 || state.dirty || state.conflict || state.loading || state.saving || state.error || sourceRangeIssue(state.row.range, state.row.sourceFrameCount)) return null;
      return Object.freeze({ projectId: context.projectId, assetId: context.asset.id, scope: context.scope, revision: state.row.revision, ...state.row.range });
    },
  };
}

export function sourceRangeAddPlan({ snapshot, asset, timeline, blocked = false }) {
  let reason = '', reasonMessage = null;
  if (blocked) { reason = '请先确认正在处理的范围或时间线请求。'; reasonMessage = message('timeline.range.error.pending'); }
  else if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) { reason = '请先明确保存源范围，且确保没有未保存修改。'; reasonMessage = message('timeline.range.error.saveFirst'); }
  else if (!asset || !supportsSourceRange(asset) || asset.id !== snapshot.assetId || asset.projectId !== snapshot.projectId || timeline?.projectId !== snapshot.projectId) { reason = '源素材或时间线已变化，请重新选择。'; reasonMessage = message('timeline.range.error.changed'); }
  else if (!Number.isSafeInteger(snapshot.inFrame) || !Number.isSafeInteger(snapshot.outFrame)) { reason = '已保存范围必须使用整数帧。'; reasonMessage = message('timeline.range.error.savedInteger'); }
  else { reasonMessage = sourceRangeMessage(snapshot, sourceFrameCount(asset.duration)); reason = renderMessage('zh-Hans', reasonMessage); }
  const kind = asset?.mimeType?.startsWith('audio/') ? 'audio' : 'video';
  const track = timeline?.tracks?.find(item => item.kind === kind);
  const startFrame = track ? Math.max(0, ...timeline.clips.filter(clip => clip.trackId === track.id).map(clip => clip.startFrame + clip.durationFrames)) : 0;
  const durationFrames = snapshot ? snapshot.outFrame - snapshot.inFrame : 0;
  if (!reason && !track) { reasonMessage = message(kind === 'audio' ? 'timeline.range.error.audioTrack' : 'timeline.range.error.videoTrack'); reason = renderMessage('zh-Hans', reasonMessage); }
  if (!reason && (!Number.isSafeInteger(startFrame + durationFrames) || startFrame + durationFrames > MAX_TIMELINE_FRAME)) { reason = '追加后的终点超过时间线 18000 帧上限；请缩短已保存范围或调整轨道。'; reasonMessage = message('timeline.range.error.tooLong'); }
  if (!reason && timeline.clips.length >= 100) { reason = '时间线最多容纳 100 个片段。'; reasonMessage = message('timeline.range.error.clipLimit'); }
  return { valid: !reason, reason, reasonMessage, startFrame, durationFrames, track, expectedRevision: timeline?.revision,
    input: reason ? null : Object.freeze({ trackId: track.id, assetId: asset.id, name: asset.name, startFrame, durationFrames, sourceInFrame: snapshot.inFrame }) };
}
