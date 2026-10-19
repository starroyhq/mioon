import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor, MessageKey } from '../../../packages/i18n/src/index.ts';
import { isWaveformResponse } from '@mioon/contracts';

// Waveforms are a read-only, opt-in view of the first source audio stream.
// Frame ranges use the editor's 30 fps timebase, with an exclusive end.
export const WAVEFORM_LIMITS = Object.freeze({ points: 2048, entries: 32, pending: 4, attempts: 64, seconds: 600 });
export const WAVEFORM_DISCLOSURE = '原始源音轨（首条） · 固定满刻度 · 不反映音量、静音或淡入/淡出';
export const WAVEFORM_BACKGROUND_NOTICE = '关闭、收起或切换面板后停止请求；已接受的本地解码可能继续完成。';

export const WAVEFORM_STATUSES = Object.freeze(['missing', 'queued', 'running', 'ready', 'interrupted', 'error', 'unsupported'] as const);
export type WaveformStatus = (typeof WAVEFORM_STATUSES)[number];
export type WaveformEntryStatus = WaveformStatus | 'loading';
type WaveformPhase = 'idle' | 'discover' | 'poll' | 'request';
type WaveformOperation = 'asset.waveform.request' | 'asset.waveform.get';

export interface WaveformAsset {
  readonly id?: string;
  readonly projectId?: string;
  readonly duration?: number;
  readonly hasAudio?: boolean;
  readonly mimeType?: string;
}
export interface WaveformClip {
  readonly id: string;
  readonly assetId: string;
  readonly trackId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame?: number;
}
export interface WaveformTimeline {
  readonly projectId?: string;
  readonly clips?: readonly WaveformClip[];
}
export interface WaveformWindow {
  clipId: string;
  assetId: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  points: number;
  left: number;
  width: number;
  key: string;
  unsupported?: boolean;
}
export interface WaveformReason { code: string; message: string }
export interface WaveformEntry {
  clipId: string;
  assetId: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  points: number;
  left: number;
  width: number;
  key: string;
  unsupported?: boolean;
  status: WaveformEntryStatus;
  reason?: WaveformReason;
  phase: WaveformPhase;
  nextAt: number;
  retry: boolean;
  held?: boolean;
  peaks?: readonly (number | null)[];
  clipped?: boolean;
  decodedSampleFrames?: number;
  resultEndFrame?: number;
}
export interface WaveformSnapshot {
  readonly projectId: string | null;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly active: boolean;
  readonly entries: Map<string, WaveformEntry>;
  readonly pending: number;
  readonly inFlight: boolean;
  readonly autoLimitReached: boolean;
  readonly retryable: boolean;
}
export interface WaveformControllerOptions {
  api: (operation: string, input: unknown) => Promise<unknown>;
  onChange?: (snapshot: WaveformSnapshot) => void;
  now?: () => number;
  setTimer?: (handler: () => void, milliseconds: number) => number;
  clearTimer?: (handle: number | undefined) => void;
  pollMs?: number;
}
export interface WaveformView {
  projectId: string | null;
  active: boolean;
  windows?: readonly WaveformWindow[];
  readOnly?: boolean;
  workspaceOrigin?: unknown;
}

export const supportsWaveform = (asset: WaveformAsset | null | undefined): asset is WaveformAsset => asset?.hasAudio === true && /^(audio|video)\//.test(asset?.mimeType || '');
export const waveformKey = (item: Pick<WaveformWindow, 'assetId' | 'sourceStartFrame' | 'sourceEndFrame' | 'points'>): string => `${item.assetId}:${item.sourceStartFrame}:${item.sourceEndFrame}:${item.points}`;

export function waveformWindow(clip: WaveformClip, pixelsPerFrame: number, leftFrame: number, rightFrame: number): WaveformWindow | null {
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

export function visibleWaveformWindows({ timeline, assets, pixelsPerFrame, leftFrame, rightFrame, visibleTrackIds }: {
  timeline: WaveformTimeline | null | undefined;
  assets: readonly WaveformAsset[];
  pixelsPerFrame: number;
  leftFrame: number;
  rightFrame: number;
  visibleTrackIds: ReadonlySet<string>;
}): WaveformWindow[] {
  const sources = new Map<string | undefined, WaveformAsset>(assets.map(asset => [asset.id, asset] as const));
  return (timeline?.clips || []).flatMap(clip => {
    const asset = sources.get(clip.assetId);
    if (!visibleTrackIds.has(clip.trackId) || !supportsWaveform(asset) || (asset.projectId && asset.projectId !== timeline?.projectId)) return [];
    const item = waveformWindow(clip, pixelsPerFrame, leftFrame, rightFrame);
    return item ? [{ ...item, unsupported: Number(asset.duration) > WAVEFORM_LIMITS.seconds }] : [];
  });
}

const heldKeys: Partial<Record<WaveformEntryStatus, MessageKey>> = { missing: 'audio.waveform.held.missing', loading: 'audio.waveform.held.loading', queued: 'audio.waveform.held.queued', running: 'audio.waveform.held.running', ready: 'audio.waveform.held.ready', interrupted: 'audio.waveform.held.interrupted', error: 'audio.waveform.held.error', unsupported: 'audio.waveform.held.unsupported' };
const statusKeys: Partial<Record<WaveformEntryStatus, MessageKey>> = { missing: 'audio.waveform.missing', loading: 'audio.waveform.loading', queued: 'audio.waveform.queued', running: 'audio.waveform.running', ready: 'audio.waveform.ready', interrupted: 'audio.waveform.interrupted', error: 'audio.waveform.error', unsupported: 'audio.waveform.unsupported' };
export function waveformStatusMessage(entry: Pick<WaveformEntry, 'held' | 'status' | 'reason'> | null | undefined): MessageDescriptor {
  if (!entry) return message('audio.waveform.waiting');
  if (entry.held) return message(heldKeys[entry.status] || 'audio.waveform.held.unavailable');
  if (entry.status === 'unsupported' && ['DURATION_LIMIT', 'WAVEFORM_DURATION_UNSUPPORTED'].includes(entry.reason?.code ?? '')) return message('audio.waveform.durationLimit');
  return message(statusKeys[entry.status] || 'audio.waveform.unavailable');
}
export function waveformStatusText(entry: Pick<WaveformEntry, 'held' | 'status' | 'reason'> | null | undefined): string { return renderMessage('zh-Hans', waveformStatusMessage(entry)); }

// Decoder coverage uses exact sample time, independent of editor frame rounding.
export function waveformCoverageWidth(range: Pick<WaveformWindow, 'sourceStartFrame' | 'sourceEndFrame' | 'width'>, decodedSampleFrames: number | undefined): number {
  if (typeof decodedSampleFrames !== 'number' || !Number.isSafeInteger(decodedSampleFrames) || decodedSampleFrames < 0) return 0;
  const coveredFrames = decodedSampleFrames / 48000 * 30 - range.sourceStartFrame;
  return Math.max(0, Math.min(range.width, coveredFrames / (range.sourceEndFrame - range.sourceStartFrame) * range.width));
}

// One SVG path, at most 2048 peak strokes. Never normalize to the clip's max.
export function waveformPath(peaks: readonly (number | null)[] | null | undefined, height = 20): string {
  return (Array.isArray(peaks) ? peaks : []).slice(0, WAVEFORM_LIMITS.points).map((peak, index) => {
    if (peak === null) return ''; // Missing decoder coverage is a gap, never invented silence.
    const amplitude = Math.max(0, Math.min(1, Number(peak) || 0)) * height / 2;
    return `M${index + 0.5},${height / 2 - amplitude}v${amplitude * 2}`;
  }).join('');
}

const retriable = (entry: WaveformEntry | undefined): boolean => ['error', 'interrupted', 'missing'].includes(entry?.status ?? '') && entry?.phase === 'idle';
const protocolError = (): Error => Object.assign(new Error('波形状态返回无效，请重试。'), { code: 'WAVEFORM_PROTOCOL' });

interface WaveformReply {
  readonly status: WaveformStatus;
  readonly reason?: WaveformReason;
  readonly peaks?: readonly (number | null)[];
  readonly clipped?: boolean;
  readonly decodedSampleFrames?: number;
  readonly sourceStartFrame?: number;
  readonly sourceEndFrame?: number;
}
function waveformReply(value: unknown): WaveformReply | null {
  if (!value || typeof value !== 'object') return null;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== 'string' || !(WAVEFORM_STATUSES as readonly string[]).includes(status)) return null;
  return value as WaveformReply;
}

// Separate transport scheduling from React so visibility and late acknowledgments
// have one owner. The in-flight lock survives project changes until it settles.
export function createWaveformController({ api, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 800 }: WaveformControllerOptions) {
  let readOnly = false, workspaceOrigin: unknown = null;
  let projectId: string | null = null, enabled = false, visible = false, connected = true, epoch = 0, timer: number | null = null, active: { key: string; epoch: number } | null = null, queue: WaveformEntry[] = [];
  let listener = onChange;
  const entries = new Map<string, WaveformEntry>(), attempted = new Set<string>();
  let wanted = new Map<string, WaveformWindow>();
  const live = (): boolean => connected && enabled && visible && Boolean(projectId);
  const snapshot = (): WaveformSnapshot => ({ projectId, enabled, readOnly, active: live(), entries: new Map(entries), pending: queue.length, inFlight: Boolean(active), autoLimitReached: attempted.size >= WAVEFORM_LIMITS.attempts, retryable: !readOnly && [...wanted.keys()].some(key => retriable(entries.get(key))) });
  const emit = (): void => { if (connected) listener(snapshot()); };
  const clearWake = (): void => { if (timer !== null) clearTimer(timer); timer = null; };
  function fence(): void {
    epoch++; queue = []; clearWake();
    for (const entry of entries.values()) if (entry.phase !== 'idle') { entry.phase = 'discover'; entry.nextAt = 0; }
  }
  function put(item: WaveformWindow): WaveformEntry {
    let entry = entries.get(item.key);
    if (!entry) {
      entry = { ...item, status: item.unsupported ? 'unsupported' : 'loading', reason: item.unsupported ? { code: 'DURATION_LIMIT', message: '超过10分钟暂不支持波形' } : undefined, phase: item.unsupported ? 'idle' : 'discover', nextAt: 0, retry: false };
      entries.set(item.key, entry);
    }
    // Touch LRU; never keep peak arrays for the entire library.
    entries.delete(item.key); entries.set(item.key, entry);
    while (entries.size > WAVEFORM_LIMITS.entries) {
      const remove = [...entries.keys()].find(key => !wanted.has(key)) ?? entries.keys().next().value;
      if (remove !== undefined) entries.delete(remove);
    }
    return entry;
  }
  function accept(entry: WaveformEntry, value: unknown, operation: WaveformOperation): void {
    const result = waveformReply(value);
    const project = projectId;
    if (!project || !result || (Array.isArray(result.peaks) && result.peaks.length > WAVEFORM_LIMITS.points) || !isWaveformResponse(value, { projectId: project, assetId: entry.assetId, points: entry.points, sourceStartFrame: entry.sourceStartFrame, sourceEndFrame: entry.sourceEndFrame })) throw protocolError();
    if (result.status === 'ready' && operation === 'asset.waveform.get') {
      if (!Number.isSafeInteger(result.decodedSampleFrames) || (result.decodedSampleFrames ?? 0) < 0 || (result.decodedSampleFrames ?? 0) > WAVEFORM_LIMITS.seconds * 48000 || !Array.isArray(result.peaks) || result.peaks.length > WAVEFORM_LIMITS.points || result.peaks.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) || result.sourceStartFrame !== entry.sourceStartFrame || !((result.sourceEndFrame ?? 0) > (result.sourceStartFrame ?? 0)) || result.sourceEndFrame !== entry.sourceEndFrame) throw protocolError();
      Object.assign(entry, { status: 'ready', peaks: result.peaks, clipped: result.clipped === true, decodedSampleFrames: result.decodedSampleFrames, resultEndFrame: result.sourceEndFrame, reason: undefined, phase: 'idle', retry: false });
      return;
    }
    entry.status = result.status; entry.reason = result.reason; entry.peaks = undefined;
    if (readOnly) { entry.phase = 'idle'; entry.retry = false; entry.held = true; return; }
    if (result.status === 'ready') { entry.phase = 'discover'; entry.nextAt = 0; }
    else if (['queued', 'running'].includes(result.status)) { entry.phase = 'poll'; entry.nextAt = now() + pollMs; entry.retry = false; }
    else if (operation === 'asset.waveform.get' && result.status !== 'unsupported' && (entry.retry || (result.status === 'missing' && !attempted.has(entry.assetId) && attempted.size < WAVEFORM_LIMITS.attempts))) { entry.phase = 'request'; entry.nextAt = 0; }
    else { entry.phase = 'idle'; entry.retry = false; }
  }
  function pump(): void {
    clearWake();
    if (!live()) { queue = []; return; }
    const time = now();
    queue = [...wanted.keys()].map(key => entries.get(key)).filter((entry): entry is WaveformEntry => entry !== undefined && entry.phase !== 'idle' && entry.key !== active?.key && entry.nextAt <= time).slice(0, WAVEFORM_LIMITS.pending);
    if (active) return;
    const entry = queue.shift();
    if (!entry) {
      const times = [...wanted.keys()].map(key => entries.get(key)).filter((value): value is WaveformEntry => value !== undefined && value.phase !== 'idle').map(value => value.nextAt);
      if (times.length) timer = setTimer(pump, Math.max(1, Math.min(...times) - time));
      return;
    }
    // Another visible trim of this asset may have submitted it already.
    if (entry.phase === 'request' && !entry.retry) {
      if (attempted.has(entry.assetId)) entry.phase = 'discover';
      else if (attempted.size >= WAVEFORM_LIMITS.attempts) { entry.phase = 'idle'; entry.status = 'missing'; pump(); return; }
    }
    if (readOnly && entry.phase === 'request') { entry.phase = 'idle'; entry.held = true; pump(); return; }
    const operation: WaveformOperation = entry.phase === 'request' ? 'asset.waveform.request' : 'asset.waveform.get';
    const requestEpoch = epoch, requestProject = projectId;
    const input = operation === 'asset.waveform.request' ? { projectId, assetId: entry.assetId, retry: entry.retry } : { projectId, assetId: entry.assetId, sourceStartFrame: entry.sourceStartFrame, sourceEndFrame: entry.sourceEndFrame, points: entry.points };
    if (operation === 'asset.waveform.request') entry.status = 'queued';
    active = { key: entry.key, epoch: requestEpoch };
    emit();
    const current = (): boolean => live() && epoch === requestEpoch && projectId === requestProject && entries.get(entry.key) === entry && wanted.has(entry.key);
    void Promise.resolve().then(() => {
      // A synchronous hide/project switch between scheduling and transport must
      // not launch a new request, including a POST prepared by a prior GET.
      if (!current() || readOnly && operation === 'asset.waveform.request') return null;
      // Bounded receipts survive peak-cache eviction and off/on toggles. Once
      // full, unknown assets require explicit retry rather than risking replay.
      if (operation === 'asset.waveform.request' && attempted.size < WAVEFORM_LIMITS.attempts) attempted.add(entry.assetId);
      return api(operation, input);
    }).then(result => { if (current() && result) accept(entry, result, operation); }).catch((error: unknown) => {
      if (!current()) return;
      entry.status = 'error'; entry.reason = { code: (error as { code?: unknown })?.code as string || 'NETWORK', message: '无法读取波形状态，请重试。' }; entry.retry = false;
      // An unacknowledged POST gets one read-only discovery, never a replay.
      entry.phase = operation === 'asset.waveform.request' ? 'discover' : 'idle'; entry.nextAt = 0;
    }).finally(() => { active = null; pump(); emit(); });
  }
  return {
    snapshot,
    connect(callback: (value: WaveformSnapshot) => void = onChange): void { connected = true; listener = callback; emit(); },
    disconnect(): void { connected = false; enabled = false; visible = false; fence(); },
    setView({ projectId: nextProject, active: nextVisible, windows = [], readOnly: nextReadOnly = false, workspaceOrigin: nextOrigin = null }: WaveformView): void {
      if (readOnly !== Boolean(nextReadOnly) || workspaceOrigin !== nextOrigin) { fence(); readOnly = Boolean(nextReadOnly); workspaceOrigin = nextOrigin; enabled = false; entries.clear(); attempted.clear(); wanted.clear(); }
      if (projectId !== nextProject) { fence(); projectId = nextProject; enabled = false; entries.clear(); attempted.clear(); wanted.clear(); }
      if (visible !== Boolean(nextVisible)) { fence(); visible = Boolean(nextVisible); }
      // Render/cache at most 32 visible windows; the toolbar discloses the cap.
      // Additional clips keep their ordinary clip appearance.
      wanted = new Map(windows.slice(0, WAVEFORM_LIMITS.entries).map(item => [item.key, item] as const));
      if (enabled) for (const item of wanted.values()) put(item);
      pump(); emit();
    },
    setEnabled(value: boolean): void {
      if (!connected || !projectId) return;
      enabled = Boolean(value); fence();
      if (enabled) for (const item of wanted.values()) put(item);
      pump(); emit();
    },
    retryVisible(): void {
      if (!live() || readOnly) return;
      for (const key of wanted.keys()) { const entry = entries.get(key); if (entry && retriable(entry)) { entry.retry = true; entry.phase = 'discover'; entry.status = 'loading'; entry.nextAt = 0; } }
      pump(); emit();
    },
  };
}
