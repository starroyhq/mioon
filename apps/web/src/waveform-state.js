import { isWaveformResponse } from '@mioon/contracts';

// Waveforms are a read-only, opt-in view of the first source audio stream.
// Frame ranges use the editor's 30 fps timebase, with an exclusive end.
export const WAVEFORM_LIMITS = Object.freeze({ points: 2048, entries: 32, pending: 4, attempts: 64, seconds: 600 });
export const WAVEFORM_DISCLOSURE = '原始源音轨（首条） · 固定满刻度 · 不反映音量、静音或淡入/淡出';
export const WAVEFORM_BACKGROUND_NOTICE = '关闭、收起或切换面板后停止请求；已接受的本地解码可能继续完成。';
export const supportsWaveform = asset => asset?.hasAudio === true && /^(audio|video)\//.test(asset?.mimeType || '');
export const waveformKey = item => `${item.assetId}:${item.sourceStartFrame}:${item.sourceEndFrame}:${item.points}`;

export function waveformWindow(clip, pixelsPerFrame, leftFrame, rightFrame) {
  if (!(pixelsPerFrame > 0) || !(rightFrame > leftFrame) || !(clip.durationFrames > 0)) return null;
  const begin = Math.max(clip.startFrame, leftFrame), end = Math.min(clip.startFrame + clip.durationFrames, rightFrame);
  if (!(end > begin)) return null;
  // Include partial edge frames, then place the SVG at those exact frame bounds.
  const offset = Math.max(0, Math.floor(begin - clip.startFrame + 1e-7));
  const endOffset = Math.min(clip.durationFrames, Math.ceil(end - clip.startFrame - 1e-7));
  const sourceStartFrame = (clip.sourceInFrame || 0) + offset;
  const sourceEndFrame = (clip.sourceInFrame || 0) + endOffset;
  const width = (endOffset - offset) * pixelsPerFrame;
  const item = { clipId: clip.id, assetId: clip.assetId, sourceStartFrame, sourceEndFrame, points: Math.max(1, Math.min(WAVEFORM_LIMITS.points, Math.ceil(width))), left: offset * pixelsPerFrame, width };
  return { ...item, key: waveformKey(item) };
}

export function visibleWaveformWindows({ timeline, assets, pixelsPerFrame, leftFrame, rightFrame, visibleTrackIds }) {
  const sources = new Map(assets.map(asset => [asset.id, asset]));
  return (timeline?.clips || []).flatMap(clip => {
    const asset = sources.get(clip.assetId);
    if (!visibleTrackIds.has(clip.trackId) || !supportsWaveform(asset) || (asset.projectId && asset.projectId !== timeline.projectId)) return [];
    const item = waveformWindow(clip, pixelsPerFrame, leftFrame, rightFrame);
    return item ? [{ ...item, unsupported: Number(asset.duration) > WAVEFORM_LIMITS.seconds }] : [];
  });
}

export function waveformStatusText(entry) {
  if (!entry) return '等待可见片段';
  if (entry.status === 'unsupported' && (entry.reason?.code === 'DURATION_LIMIT' || /10分钟|600|duration/i.test(entry.reason?.code || ''))) return '超过10分钟暂不支持波形';
  return { missing: '波形未生成', loading: '检查波形…', queued: '波形排队中…', running: '本地分析中…', ready: '原始源音轨波形', interrupted: '波形分析已中断，请重试', error: '波形暂不可用，请重试', unsupported: entry.reason?.message || '此素材暂不支持波形' }[entry.status] || '波形暂不可用';
}

// Decoder coverage uses exact sample time, independent of editor frame rounding.
export function waveformCoverageWidth(range, decodedSampleFrames) {
  if (!Number.isSafeInteger(decodedSampleFrames) || decodedSampleFrames < 0) return 0;
  const coveredFrames = decodedSampleFrames / 48000 * 30 - range.sourceStartFrame;
  return Math.max(0, Math.min(range.width, coveredFrames / (range.sourceEndFrame - range.sourceStartFrame) * range.width));
}

// One SVG path, at most 2048 peak strokes. Never normalize to the clip's max.
export function waveformPath(peaks, height = 20) {
  return (Array.isArray(peaks) ? peaks : []).slice(0, WAVEFORM_LIMITS.points).map((peak, index) => {
    if (peak === null) return ''; // Missing decoder coverage is a gap, never invented silence.
    const amplitude = Math.max(0, Math.min(1, Number(peak) || 0)) * height / 2;
    return `M${index + 0.5},${height / 2 - amplitude}v${amplitude * 2}`;
  }).join('');
}

const retriable = entry => ['error', 'interrupted', 'missing'].includes(entry?.status) && entry.phase === 'idle';
const protocolError = () => Object.assign(new Error('波形状态返回无效，请重试。'), { code: 'WAVEFORM_PROTOCOL' });

// Separate transport scheduling from React so visibility and late acknowledgments
// have one owner. The in-flight lock survives project changes until it settles.
export function createWaveformController({ api, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 800 }) {
  let projectId = null, enabled = false, visible = false, connected = true, epoch = 0, timer = null, active = null, queue = [];
  let listener = onChange;
  const entries = new Map(), attempted = new Set();
  let wanted = new Map();
  const live = () => connected && enabled && visible && Boolean(projectId);
  const snapshot = () => ({ projectId, enabled, active: live(), entries: new Map(entries), pending: queue.length, inFlight: Boolean(active), autoLimitReached: attempted.size >= WAVEFORM_LIMITS.attempts, retryable: [...wanted.keys()].some(key => retriable(entries.get(key))) });
  const emit = () => { if (connected) listener(snapshot()); };
  const clearWake = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function fence() {
    epoch++; queue = []; clearWake();
    for (const entry of entries.values()) if (entry.phase !== 'idle') { entry.phase = 'discover'; entry.nextAt = 0; }
  }
  function put(item) {
    let entry = entries.get(item.key);
    if (!entry) {
      entry = { ...item, status: item.unsupported ? 'unsupported' : 'loading', reason: item.unsupported ? { code: 'DURATION_LIMIT', message: '超过10分钟暂不支持波形' } : undefined, phase: item.unsupported ? 'idle' : 'discover', nextAt: 0, retry: false };
      entries.set(item.key, entry);
    }
    // Touch LRU; never keep peak arrays for the entire library.
    entries.delete(item.key); entries.set(item.key, entry);
    while (entries.size > WAVEFORM_LIMITS.entries) {
      const remove = [...entries.keys()].find(key => !wanted.has(key)) ?? entries.keys().next().value;
      entries.delete(remove);
    }
    return entry;
  }
  function accept(entry, result, operation) {
    if ((Array.isArray(result?.peaks) && result.peaks.length > WAVEFORM_LIMITS.points) || !isWaveformResponse(result, { projectId, assetId: entry.assetId, points: entry.points, sourceStartFrame: entry.sourceStartFrame, sourceEndFrame: entry.sourceEndFrame })) throw protocolError();
    if (result.status === 'ready' && operation === 'asset.waveform.get') {
      if (!Number.isSafeInteger(result.decodedSampleFrames) || result.decodedSampleFrames < 0 || result.decodedSampleFrames > WAVEFORM_LIMITS.seconds * 48000 || !Array.isArray(result.peaks) || result.peaks.length > WAVEFORM_LIMITS.points || result.peaks.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) || result.sourceStartFrame !== entry.sourceStartFrame || !(result.sourceEndFrame > result.sourceStartFrame) || result.sourceEndFrame !== entry.sourceEndFrame) throw protocolError();
      Object.assign(entry, { status: 'ready', peaks: result.peaks, clipped: result.clipped === true, decodedSampleFrames: result.decodedSampleFrames, resultEndFrame: result.sourceEndFrame, reason: undefined, phase: 'idle', retry: false });
      return;
    }
    entry.status = result.status; entry.reason = result.reason; entry.peaks = undefined;
    if (result.status === 'ready') { entry.phase = 'discover'; entry.nextAt = 0; }
    else if (['queued', 'running'].includes(result.status)) { entry.phase = 'poll'; entry.nextAt = now() + pollMs; entry.retry = false; }
    else if (operation === 'asset.waveform.get' && result.status !== 'unsupported' && (entry.retry || (result.status === 'missing' && !attempted.has(entry.assetId) && attempted.size < WAVEFORM_LIMITS.attempts))) { entry.phase = 'request'; entry.nextAt = 0; }
    else { entry.phase = 'idle'; entry.retry = false; }
  }
  function pump() {
    clearWake();
    if (!live()) { queue = []; return; }
    const time = now();
    queue = [...wanted.keys()].map(key => entries.get(key)).filter(entry => entry && entry.phase !== 'idle' && entry.key !== active?.key && entry.nextAt <= time).slice(0, WAVEFORM_LIMITS.pending);
    if (active) return;
    const entry = queue.shift();
    if (!entry) {
      const times = [...wanted.keys()].map(key => entries.get(key)).filter(value => value && value.phase !== 'idle').map(value => value.nextAt);
      if (times.length) timer = setTimer(pump, Math.max(1, Math.min(...times) - time));
      return;
    }
    // Another visible trim of this asset may have submitted it already.
    if (entry.phase === 'request' && !entry.retry) {
      if (attempted.has(entry.assetId)) entry.phase = 'discover';
      else if (attempted.size >= WAVEFORM_LIMITS.attempts) { entry.phase = 'idle'; entry.status = 'missing'; pump(); return; }
    }
    const operation = entry.phase === 'request' ? 'asset.waveform.request' : 'asset.waveform.get';
    const requestEpoch = epoch, requestProject = projectId;
    const input = operation === 'asset.waveform.request' ? { projectId, assetId: entry.assetId, retry: entry.retry } : { projectId, assetId: entry.assetId, sourceStartFrame: entry.sourceStartFrame, sourceEndFrame: entry.sourceEndFrame, points: entry.points };
    if (operation === 'asset.waveform.request') entry.status = 'queued';
    active = { key: entry.key, epoch: requestEpoch };
    emit();
    const current = () => live() && epoch === requestEpoch && projectId === requestProject && entries.get(entry.key) === entry && wanted.has(entry.key);
    Promise.resolve().then(() => {
      // A synchronous hide/project switch between scheduling and transport must
      // not launch a new request, including a POST prepared by a prior GET.
      if (!current()) return null;
      // Bounded receipts survive peak-cache eviction and off/on toggles. Once
      // full, unknown assets require explicit retry rather than risking replay.
      if (operation === 'asset.waveform.request' && attempted.size < WAVEFORM_LIMITS.attempts) attempted.add(entry.assetId);
      return api(operation, input);
    }).then(result => { if (current() && result) accept(entry, result, operation); }).catch(error => {
      if (!current()) return;
      entry.status = 'error'; entry.reason = { code: error?.code || 'NETWORK', message: '无法读取波形状态，请重试。' }; entry.retry = false;
      // An unacknowledged POST gets one read-only discovery, never a replay.
      entry.phase = operation === 'asset.waveform.request' ? 'discover' : 'idle'; entry.nextAt = 0;
    }).finally(() => { active = null; pump(); emit(); });
  }
  return {
    snapshot,
    connect(callback = onChange) { connected = true; listener = callback; emit(); },
    disconnect() { connected = false; enabled = false; visible = false; fence(); },
    setView({ projectId: nextProject, active: nextVisible, windows = [] }) {
      if (projectId !== nextProject) { fence(); projectId = nextProject; enabled = false; entries.clear(); attempted.clear(); wanted.clear(); }
      if (visible !== Boolean(nextVisible)) { fence(); visible = Boolean(nextVisible); }
      // Render/cache at most 32 visible windows; the toolbar discloses the cap.
      // Additional clips keep their ordinary clip appearance.
      wanted = new Map(windows.slice(0, WAVEFORM_LIMITS.entries).map(item => [item.key, item]));
      if (enabled) for (const item of wanted.values()) put(item);
      pump(); emit();
    },
    setEnabled(value) {
      if (!connected || !projectId) return;
      enabled = Boolean(value); fence();
      if (enabled) for (const item of wanted.values()) put(item);
      pump(); emit();
    },
    retryVisible() {
      if (!live()) return;
      for (const key of wanted.keys()) { const entry = entries.get(key); if (retriable(entry)) { entry.retry = true; entry.phase = 'discover'; entry.status = 'loading'; entry.nextAt = 0; } }
      pump(); emit();
    },
  };
}
