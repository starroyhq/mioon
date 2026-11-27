import {AppError} from '../../contracts/src/app-error.ts';
import {
  INTERPOLATION_UNAVAILABLE, SPEED_PROCESSING_NOT_READY, TIMELINE_SPEED_EXPORT_MESSAGES, UNSUPPORTED_INTERPOLATION_FORMAT,
  type TimelineSpeedExportProxy,
} from '../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect} from './media-runtime.ts';
import {hasUnconfirmedMediaProcesses, waitForMediaProcesses} from './media-processes.ts';
import type {SpeedExportLayout, SpeedExportSnapshotContext} from './timeline-speed-export-admission.ts';
import {speedExportMappingError} from './timeline-speed-export-plan.ts';
import type {
  TimelineOpticalProxyLease, TimelineOpticalProxyPort, TimelineOpticalProxyRequest,
} from './timeline-processing/optical-proxy-port.ts';

type Clip = SpeedExportLayout['clips'][number];
type OpticalAsset = {readonly sha256?: string};
type FenceOptions = {readonly signal?: AbortSignal; readonly beforeEffect?: () => void};
const digest = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function notReady(clipId: string, taskId?: string): never {
  throw new AppError(SPEED_PROCESSING_NOT_READY, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_PROCESSING_NOT_READY], 409,
    {clipId, ...(taskId && uuid.test(taskId) ? {taskId} : {})});
}

function requestFor(snapshot: SpeedExportSnapshotContext, item: Clip, asset: OpticalAsset | undefined): TimelineOpticalProxyRequest {
  if (!asset?.sha256 || !digest.test(asset.sha256)) throw speedExportMappingError(item.clipId, 'OPTICAL_SOURCE_IDENTITY');
  const start = item.clip.startFrame;
  return {
    projectId: snapshot.timeline.projectId, timelineId: snapshot.timeline.id, clipId: item.clipId, assetId: item.assetId,
    sourceSha256: asset.sha256, mapHash: item.mapHash, timing: item.timing,
    outputWindow: {fromFrame: item.video[0]!.beginFrame - start, toFrame: item.video.at(-1)!.endFrame - start},
  };
}

function frozenProof(snapshot: SpeedExportSnapshotContext, clipId: string): TimelineSpeedExportProxy | undefined {
  return snapshot.speedExport?.clips.find(clip => clip.clipId === clipId)?.opticalProxy;
}

export function freezeTimelineOpticalProxies(snapshot: SpeedExportSnapshotContext, layout: SpeedExportLayout,
  assets: ReadonlyMap<string, OpticalAsset>, port?: TimelineOpticalProxyPort): ReadonlyMap<string, TimelineSpeedExportProxy> {
  const proofs = new Map<string, TimelineSpeedExportProxy>();
  for (const item of layout.clips) {
    if (item.interpolation?.mode !== 'optical') continue;
    const task = port?.lookup(requestFor(snapshot, item, assets.get(item.assetId)));
    const reason = task?.reason;
    if (reason === INTERPOLATION_UNAVAILABLE || reason === UNSUPPORTED_INTERPOLATION_FORMAT) {
      throw new AppError(reason, TIMELINE_SPEED_EXPORT_MESSAGES[reason], 409, {clipId: item.clipId});
    }
    if (!task || !uuid.test(task.taskId) || !task.readySha256 || !digest.test(task.readySha256)) notReady(item.clipId, task?.taskId);
    proofs.set(item.clipId, {taskId: task.taskId, sha256: task.readySha256});
  }
  return proofs;
}

export function assertTimelineOpticalProxyBindings(snapshot: SpeedExportSnapshotContext, layout: SpeedExportLayout,
  port?: TimelineOpticalProxyPort): void {
  for (const item of layout.clips) {
    if (item.interpolation?.mode !== 'optical') continue;
    const proof = frozenProof(snapshot, item.clipId);
    if (!port || !proof) notReady(item.clipId, proof?.taskId);
  }
}

export async function withTimelineOpticalProxy<T>(snapshot: SpeedExportSnapshotContext,
  item: Clip, asset: OpticalAsset, port: TimelineOpticalProxyPort | undefined, options: FenceOptions,
  consume: (video: TimelineOpticalProxyLease['video'] | undefined, beforeEffect?: () => void) => Promise<T>): Promise<T> {
  if (item.interpolation?.mode !== 'optical') return consume(undefined, options.beforeEffect);
  const proof = frozenProof(snapshot, item.clipId);
  if (!port || !proof) notReady(item.clipId, proof?.taskId);
  checkMediaEffect(options.beforeEffect, options.signal);
  const request = requestFor(snapshot, item, asset);
  const lease = await port.acquire(request, proof, options);
  if (!lease) {
    checkMediaEffect(options.beforeEffect, options.signal);
    notReady(item.clipId, proof.taskId);
  }
  const fence = (): void => {
    checkMediaEffect(options.beforeEffect, options.signal);
    if (!lease.verify()) notReady(item.clipId, proof.taskId);
  };
  let deferRelease = false;
  try {
    const {firstOutputFrame, frameCount} = lease.video;
    if (lease.proof.taskId !== proof.taskId || lease.proof.sha256 !== proof.sha256 ||
        !Number.isSafeInteger(firstOutputFrame) || !Number.isSafeInteger(frameCount) || frameCount <= 0 ||
        firstOutputFrame > request.outputWindow.fromFrame || firstOutputFrame + frameCount < request.outputWindow.toFrame)
      notReady(item.clipId, proof.taskId);
    fence();
    const result = await consume(lease.video, fence);
    fence();
    return result;
  } catch (error) {
    deferRelease = Boolean((error as {terminationUnconfirmed?: boolean})?.terminationUnconfirmed) ||
      hasUnconfirmedMediaProcesses({signal: options.signal});
    if (!deferRelease && (error as {details?: {reason?: string}})?.details?.reason === 'OPTICAL_PROXY_COVERAGE') {
      notReady(item.clipId, proof.taskId);
    }
    throw error;
  } finally {
    if (deferRelease) void waitForMediaProcesses({signal: options.signal}).then(() => lease.release()).catch(() => {});
    else lease.release();
  }
}
