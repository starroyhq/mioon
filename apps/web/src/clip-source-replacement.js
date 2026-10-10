import { sourceFrameCount } from '@mioon/contracts';
import { clipAudioIssue } from './clip-audio-state.js';

const kind = asset => /^(video|audio|image)\//.exec(asset?.mimeType || '')?.[1] || null;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (left, right) => canonical(left) === canonical(right);
function freezeCopy(value) {
  const copy = structuredClone(value);
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
}
const metadataKeys = ['id', 'projectId', 'name', 'mimeType', 'duration', 'hasAudio', 'hasVideo', 'width', 'height', 'sha256', 'sizeBytes', 'relativePath', 'url', 'provenance', 'revision', 'createdAt', 'updatedAt'];
const versionKeys = ['id', 'projectId', 'assetId', 'shotId', 'number', 'jobId', 'sha256', 'providerId', 'model', 'createdAt'];
const sourceSnapshot = asset => Object.fromEntries(metadataKeys.filter(key => Object.hasOwn(asset, key)).map(key => [key, asset[key]]));
const selectedClip = context => context?.timeline?.clips?.find(clip => clip.id === context.clipId);

export function clipReplacementBlockedReason(context) {
  if (!context?.projectId || !context.scope || context.timeline?.projectId !== context.projectId || !context.timeline.id || !Number.isSafeInteger(context.timeline.revision) || context.timeline.revision < 1 || !selectedClip(context)) return '项目或所选片段已变化，请重新选择片段。';
  if (context.dirty) return '请先保存或放弃片段的未保存修改，再替换来源。';
  if (!context.connected) return '请等待连接恢复后再核对来源。';
  if (context.pending) return '上一条时间线请求结果待确认，请先在任务面板恢复同一请求。';
  if (context.busy) return '正在保存时间线，请稍后再核对来源。';
  if (context.visible === false) return '请在片段属性中核对并确认替换。';
  return '';
}

export function clipReplacementCompatibility(clip, previous, candidate, projectId) {
  if (!clip || !previous || !candidate || previous.id !== clip.assetId || previous.projectId !== projectId || candidate.projectId !== projectId) return '来源必须属于当前项目。';
  if (candidate.id === previous.id) return '不能替换为当前来源；不会生成重复历史。';
  if (!kind(previous) || kind(candidate) !== kind(previous)) return '新旧来源必须同为视频、音频或图片。';
  if (!Number.isSafeInteger(clip.sourceInFrame) || clip.sourceInFrame < 0 || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1) return '片段范围无效，请先检查片段。';
  if (kind(candidate) === 'image') {
    if (clip.sourceInFrame !== 0) return '图片片段的素材入点必须为 0。';
  } else {
    const frames = sourceFrameCount(candidate.duration);
    if (frames === null) return '新来源时长尚未确认，无法保留片段范围。';
    if (clip.sourceInFrame + clip.durationFrames > frames) return '新来源不足以覆盖原入点与片段时长；不会自动裁短。';
  }
  return clipAudioIssue(clip, candidate);
}

// These are choices from the current project snapshot, not authorization or
// media verification. The shared business operation revalidates the source.
export function clipReplacementCandidates(context) {
  const clip = selectedClip(context), assets = context?.assets || [];
  const previous = assets.find(asset => asset.id === clip?.assetId);
  if (!clip || context.timeline?.projectId !== context.projectId) return [];
  return assets.filter(asset => !clipReplacementCompatibility(clip, previous, asset, context.projectId)).flatMap(asset => {
    const source = sourceSnapshot(asset);
    const choices = [{ key: `asset:${asset.id}`, assetId: asset.id, source, label: `${asset.name || asset.id} · 仅素材` }];
    for (const version of context.versions || []) {
      const shot = context.shots?.find(item => item.id === version.shotId && item.projectId === context.projectId);
      if (version.assetId !== asset.id || version.projectId !== context.projectId || !shot || !Number.isSafeInteger(version.number) || version.number < 1) continue;
      choices.push({ key: `version:${version.id}`, assetId: asset.id, versionId: version.id, source,
        version: { ...Object.fromEntries(versionKeys.filter(key => Object.hasOwn(version, key)).map(key => [key, version[key]])), shotTitle: shot.title },
        label: `${asset.name || asset.id} · ${shot.title} · V${version.number}` });
    }
    return choices;
  });
}

export function createClipReplacementReview(context, candidateKey) {
  if (clipReplacementBlockedReason(context)) return null;
  const clip = selectedClip(context), previous = context.assets.find(asset => asset.id === clip.assetId);
  const candidate = clipReplacementCandidates(context).find(item => item.key === candidateKey);
  if (!candidate) return null;
  // Asset-only selection deliberately does not infer a version or shot link.
  return freezeCopy({ scope: context.scope, projectId: context.projectId, timelineId: context.timeline.id, expectedRevision: context.timeline.revision,
    clipId: clip.id, clip, previous: sourceSnapshot(previous), candidate,
    input: { clipId: clip.id, assetId: candidate.assetId, ...(candidate.versionId ? { versionId: candidate.versionId } : {}) } });
}

export function clipReplacementReviewIssue(review, context, { contentOnly = false } = {}) {
  if (!review || !context || review.scope !== context.scope || review.projectId !== context.projectId || review.clipId !== context.clipId || review.timelineId !== context.timeline?.id || context.timeline?.projectId !== review.projectId) return '项目或所选片段已变化，请重新选择并核对。';
  if (review.expectedRevision !== context.timeline.revision || !same(review.clip, selectedClip(context))) return '时间线或片段已变化。本次核对已失效，请重新选择并核对。';
  const previous = context.assets?.find(asset => asset.id === review.clip.assetId);
  const candidate = clipReplacementCandidates(context).find(item => item.key === review.candidate?.key);
  if (!previous || !same(review.previous, sourceSnapshot(previous)) || !candidate || !same(review.candidate, candidate)) return '来源或候选素材信息已变化。本次核对已失效，请重新选择并核对。';
  const input = { clipId: review.clipId, assetId: candidate.assetId, ...(candidate.versionId ? { versionId: candidate.versionId } : {}) };
  if (!same(review.input, input)) return '替换参数与核对内容不一致，请重新选择并核对。';
  return contentOnly ? '' : clipReplacementBlockedReason(context);
}

export function clipReplacementErrorMessage(error) {
  if (error?.code === 'UNAUTHORIZED') return '会话已过期，请重新登录后重新核对。';
  if (['CONFLICT', 'REVISION_CONFLICT'].includes(error?.code)) return '时间线已变化，未按本次核对替换。请重新选择并核对。';
  if (error?.code === 'SOURCE_UNCHANGED') return '所选素材已是当前来源，未新增历史记录。';
  if (error?.code === 'INVALID_CLIP_TYPE') return '新旧来源必须同为视频、音频或图片，请重新选择。';
  if (['INVALID_VERSION', 'NOT_FOUND', 'INVALID_ASSET', 'ASSET_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'TIMELINE_SOURCE_UNAVAILABLE'].includes(error?.code)) return '新来源或版本不可用，请重新选择并核对。';
  if (['SOURCE_BOUNDS', 'SOURCE_TOO_SHORT', 'SOURCE_RANGE_EXCEEDED', 'INVALID_SOURCE_RANGE'].includes(error?.code)) return '新来源无法保留原入点与片段时长，未进行自动裁短。';
  if (['INVALID_AUDIO_FADE', 'INVALID_FADE', 'AUDIO_UNAVAILABLE', 'FADE_AUDIO_UNSUPPORTED'].includes(error?.code)) return '新来源无法保留已有音频淡入/淡出，请重新核对。';
  return '替换未完成，请检查片段与来源后重新选择并核对。';
}

export function clipReplacementAcknowledged(review, timeline) {
  if (!review || !timeline || timeline.id !== review.timelineId || timeline.projectId !== review.projectId || timeline.revision !== review.expectedRevision + 1 || !Array.isArray(timeline.clips)) return false;
  const saved = timeline.clips.find(clip => clip?.id === review.clipId);
  if (!saved || saved.assetId !== review.candidate.assetId || Object.hasOwn(saved, 'jobId')) return false;
  if (review.candidate.versionId) {
    if (saved.versionId !== review.candidate.versionId || saved.shotId !== review.candidate.version.shotId) return false;
  } else if (Object.hasOwn(saved, 'versionId') || Object.hasOwn(saved, 'shotId')) return false;
  const retained = clip => Object.fromEntries(Object.entries(clip).filter(([key]) => !['assetId', 'versionId', 'shotId', 'jobId'].includes(key)));
  return same(retained(saved), retained(review.clip));
}

const initialState = () => ({ phase: 'idle', selectedKey: '', review: null, error: '' });
export function createClipReplacementController({ submit, getContext, onChange = () => {} }) {
  let state = initialState(), context = null, epoch = 0, disposed = false;
  const emit = patch => { state = { ...state, ...patch }; onChange(state); return state; };
  const sync = () => { if (getContext && !disposed) controller.setContext(getContext()); };
  const owns = owner => { sync(); return !disposed && owner === epoch; };
  const controller = {
    getState: () => state,
    activate() {
      // React's development StrictMode may clean up and reattach effects.
      if (disposed) { disposed = false; epoch++; context = null; state = initialState(); }
    },
    setContext(next) {
      if (disposed) return;
      const changedOwner = context?.scope !== next?.scope || context?.projectId !== next?.projectId || context?.clipId !== next?.clipId;
      context = next;
      if (changedOwner) { epoch++; state = initialState(); onChange(state); return; }
      if (state.phase === 'review') {
        const issue = clipReplacementReviewIssue(state.review, context, { contentOnly: true });
        if (issue) emit({ phase: 'stale', error: issue });
      }
    },
    begin(expected = state) {
      sync();
      if (disposed || expected !== state || !['idle', 'stale', 'error'].includes(state.phase) || clipReplacementBlockedReason(context)) return false;
      epoch++; emit({ ...initialState(), phase: 'choosing' }); return true;
    },
    choose(key, expected = state) {
      sync();
      if (disposed || expected !== state || state.phase !== 'choosing' || clipReplacementBlockedReason(context)) return false;
      if (!clipReplacementCandidates(context).some(candidate => candidate.key === key)) return false;
      emit({ selectedKey: key, error: '' }); return true;
    },
    review(expected = state) {
      sync();
      if (disposed || expected !== state || state.phase !== 'choosing') return null;
      const review = createClipReplacementReview(context, state.selectedKey);
      if (!review) return null;
      emit({ phase: 'review', review, error: '' }); return review;
    },
    cancel(expected = state) {
      sync();
      if (disposed || expected !== state || state.phase === 'sending') return false;
      epoch++; emit(initialState()); return true;
    },
    async approve(review) {
      sync();
      if (disposed || state.phase !== 'review' || review !== state.review || clipReplacementReviewIssue(review, context)) return null;
      const owner = epoch;
      emit({ phase: 'sending', error: '' });
      try {
        const result = await submit(review);
        if (!owns(owner)) return null;
        if (result?.status === 'applied' && clipReplacementAcknowledged(review, result.timeline)) {
          emit({ phase: 'applied', error: '' }); return result;
        }
        if (result?.status === 'rejected') emit({ phase: 'error', error: clipReplacementErrorMessage(result.error) });
        else emit({ phase: 'unknown', error: '替换结果尚未确认。请在任务面板恢复同一请求，不要重复替换。' });
      } catch {
        // Only App can verify a request-bound non-application proof. A thrown
        // transport error, including a definitive 4xx, is not that proof.
        if (owns(owner)) emit({ phase: 'unknown', error: '替换结果尚未确认。请在任务面板恢复同一请求，不要重复替换。' });
      }
      return null;
    },
    dispose() { disposed = true; epoch++; context = null; },
  };
  return controller;
}
