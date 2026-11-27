import {AppError} from '../../contracts/src/app-error.ts';
import {
  SPEED_PROCESSING_NOT_READY, TIMELINE_SPEED_EXPORT_MESSAGES, type TimelineSpeedExportProxy,
} from '../../contracts/src/timeline-speed-export.ts';
import {timeMapSourceWindowForOutput, type TimeMapSourceWindow} from '../../contracts/src/timeline-time-map.ts';
import type {SpeedExportLayout, SpeedExportSnapshotContext} from './timeline-speed-export-admission.ts';
import {speedExportMappingError} from './timeline-speed-export-plan.ts';
import {timelineReverseAudioClock} from './timeline-speed-export-audio.ts';
import {checkMediaEffect} from './media-runtime.ts';
import {hasUnconfirmedMediaProcesses, waitForMediaProcesses} from './media-processes.ts';
import type {TimelineReverseProxyLease, TimelineReverseProxyPort, TimelineReverseProxyRequest} from './timeline-processing/reverse-lease.ts';

export type {TimelineReverseProxyLease, TimelineReverseProxyPort, TimelineReverseProxyRequest} from './timeline-processing/reverse-lease.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha256 = /^[0-9a-f]{64}$/u;
type ProxyAsset = {readonly sha256?: string; readonly mimeType: string};
type ReverseClip = SpeedExportLayout['clips'][number];
const needsReverseProxy = (item: ReverseClip): boolean =>
  item.plan.direction === 'reverse' && (item.interpolation?.mode !== 'optical' || item.audio);

function notReady(clipId: string, taskId?: string): never {
  throw new AppError(SPEED_PROCESSING_NOT_READY, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_PROCESSING_NOT_READY], 409,
    {clipId, ...(taskId && uuid.test(taskId) ? {taskId} : {})});
}

function requestFor(snapshot: SpeedExportSnapshotContext, item: ReverseClip,
  asset: ProxyAsset | undefined): TimelineReverseProxyRequest {
  const window = (plan: ReverseClip['plan']): TimeMapSourceWindow => {
    const result = timeMapSourceWindowForOutput(plan);
    if (!result.ok) throw speedExportMappingError(item.clipId, result.code);
    return result.value;
  };
  if (!asset?.sha256 || !sha256.test(asset.sha256)) throw speedExportMappingError(item.clipId, 'REVERSE_SOURCE_IDENTITY');
  const track = snapshot.timeline.tracks.find(track => track.id === item.clip.trackId);
  return {
    projectId: snapshot.timeline.projectId, timelineId: snapshot.timeline.id, clipId: item.clipId,
    assetId: item.assetId, sourceSha256: asset.sha256, mapHash: item.mapHash,
    media: asset.mimeType.startsWith('video/') && track?.kind !== 'audio' ? 'video' : 'audio',
    sourceFps: item.plan.root.sourceFps,
    sourceWindow: window(item.plan),
    pictureWindows: item.interpolation?.mode === 'optical' ? [] : item.video.map(value => window(value.plan)), needsAudio: item.audio,
    audioWindow: item.audio ? timelineReverseAudioClock(item.plan, item.timing) : null,
  };
}

export function freezeTimelineReverseProxies(snapshot: SpeedExportSnapshotContext, layout: SpeedExportLayout,
  assets: ReadonlyMap<string, ProxyAsset>, port?: TimelineReverseProxyPort): ReadonlyMap<string, TimelineSpeedExportProxy> {
  const proofs = new Map<string, TimelineSpeedExportProxy>();
  for (const item of layout.clips) {
    if (!needsReverseProxy(item)) continue;
    const task = port?.lookup(requestFor(snapshot, item, assets.get(item.assetId)));
    if (!task || !uuid.test(task.taskId) || !task.readySha256 || !sha256.test(task.readySha256)) notReady(item.clipId, task?.taskId);
    proofs.set(item.clipId, {taskId: task.taskId, sha256: task.readySha256});
  }
  return proofs;
}

function frozenProof(snapshot: SpeedExportSnapshotContext, clipId: string): TimelineSpeedExportProxy | undefined {
  return snapshot.speedExport?.clips.find(clip => clip.clipId === clipId)?.proxy;
}

export function assertTimelineReverseProxyBindings(snapshot: SpeedExportSnapshotContext, layout: SpeedExportLayout,
  port?: TimelineReverseProxyPort): void {
  for (const item of layout.clips) {
    if (!needsReverseProxy(item)) continue;
    const proof = frozenProof(snapshot, item.clipId);
    if (!port || !proof) notReady(item.clipId, proof?.taskId);
  }
}

export async function withTimelineReverseProxy<T>(snapshot: SpeedExportSnapshotContext,
  item: ReverseClip, asset: ProxyAsset, port: TimelineReverseProxyPort | undefined,
  options: {signal?: AbortSignal; beforeEffect?: () => void},
  consume: (lease: TimelineReverseProxyLease | undefined, fence?: () => void) => Promise<T>): Promise<T> {
  if (!needsReverseProxy(item)) return consume(undefined, options.beforeEffect);
  const proof = frozenProof(snapshot, item.clipId);
  if (!port || !proof) notReady(item.clipId, proof?.taskId);
  checkMediaEffect(options.beforeEffect, options.signal);
  const request = requestFor(snapshot, item, asset);
  return withReverseProxyLease(request, port, proof, options, consume);
}

/** Audition uses the same verified lossless PCM lease as export. It resolves
 * the current saved task independently of the export's frozen snapshot. */
export async function withTimelineReverseAudio<T>(request: TimelineReverseProxyRequest, port: TimelineReverseProxyPort | undefined,
  options: {signal?: AbortSignal; beforeEffect?: () => void},
  consume: (audio: NonNullable<TimelineReverseProxyLease['audio']>, fence: () => void) => Promise<T>): Promise<T> {
  checkMediaEffect(options.beforeEffect, options.signal);
  const lookup = port?.lookup(request);
  if (!port || !lookup || !uuid.test(lookup.taskId) || !lookup.readySha256 || !sha256.test(lookup.readySha256)) {
    notReady(request.clipId, lookup?.taskId);
  }
  return withReverseProxyLease(request, port, {taskId: lookup.taskId, sha256: lookup.readySha256}, options, (lease, fence) => {
    if (!lease.audio) notReady(request.clipId, lookup.taskId);
    return consume(lease.audio, fence);
  });
}

async function withReverseProxyLease<T>(request: TimelineReverseProxyRequest, port: TimelineReverseProxyPort,
  proof: TimelineSpeedExportProxy, options: {signal?: AbortSignal; beforeEffect?: () => void},
  consume: (lease: TimelineReverseProxyLease, fence: () => void) => Promise<T>): Promise<T> {
  checkMediaEffect(options.beforeEffect, options.signal);
  const lease = await port.acquire(request, proof, options);
  if (!lease) {
    checkMediaEffect(options.beforeEffect, options.signal);
    notReady(request.clipId, proof.taskId);
  }
  const fence = (): void => {
    checkMediaEffect(options.beforeEffect, options.signal);
    if (!lease.verify()) notReady(request.clipId, proof.taskId);
  };
  let deferRelease = false;
  try {
    if (lease.proof.taskId !== proof.taskId || lease.proof.sha256 !== proof.sha256 ||
        (request.pictureWindows.length > 0 && !lease.video) || (request.needsAudio && !lease.audio)) notReady(request.clipId, proof.taskId);
    if (request.audioWindow && lease.audio) {
      const {fromSample, toSample} = lease.audio.clock;
      if (!Number.isSafeInteger(fromSample) || !Number.isSafeInteger(toSample) || fromSample < 0 || toSample <= fromSample ||
          fromSample > request.audioWindow.fromSample || toSample < request.audioWindow.toSample) notReady(request.clipId, proof.taskId);
    }
    fence();
    const result = await consume(lease, fence);
    fence();
    return result;
  } catch (error) {
    deferRelease = Boolean((error as {terminationUnconfirmed?: boolean})?.terminationUnconfirmed) ||
      hasUnconfirmedMediaProcesses({signal: options.signal});
    const details = (error as {details?: {reason?: string; audioReason?: string}})?.details;
    if (!deferRelease && (details?.reason === 'REVERSE_PROXY_COVERAGE' || details?.audioReason === 'REVERSE_PCM_WINDOW')) {
      notReady(request.clipId, proof.taskId);
    }
    throw error;
  } finally {
    if (deferRelease) void waitForMediaProcesses({signal: options.signal}).then(() => lease.release()).catch(() => {});
    else lease.release();
  }
}
