import {createHash} from 'node:crypto';
import type {ProjectStore} from '../project-file/store.ts';
import {readFormat5TimelineRecord} from '../project-file/format5-timeline.ts';
import {freezeSourceSha256} from '../format6-source-proof.ts';
import {canonicalJson} from '../project-versions/document.ts';
import {readOwnedTimelineAsset} from '../timeline-sources.ts';
import {compileClipTimeMap} from '../../../contracts/src/timeline-clip-timing.ts';
import {timeMapHasSlowMotion, timeMapPlanInfo} from '../../../contracts/src/timeline-time-map.ts';
import {sourceFrameCount} from '../../../contracts/src/source-range.ts';
import {speedPictureWindows, speedTransitionHandle} from '../timeline-speed-export-plan.ts';
import {timelineTransitionRegions, transitionPictureRange} from '../timeline-transition-filter.ts';
import {clipTimingSchema} from '../../../contracts/src/timeline-speed.ts';
import type {SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';
import {processingDigestSchema as digest} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingInput} from '../../../contracts/src/timeline-processing-storage.ts';
import {REVERSE_PROXY_PROFILE} from './reverse.ts';
import {OPTICAL_FLOW_CUT_POLICY, OPTICAL_PROXY_PROFILE} from './optical-proxy-port.ts';

export interface ProcessingDemand {
  readonly demandKey: string;
  readonly clipId: string;
  readonly input: ProcessingInput;
  readonly unavailable: SpeedProcessingReason | null;
}
type Asset = NonNullable<ReturnType<typeof readOwnedTimelineAsset>>;
export function processingHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function processingSourceIdentity(asset: Asset): string {
  return processingHash([asset.id, asset.projectId, asset.mimeType, asset.referenceRevision ?? null,
    asset.reference ?? null, asset.sha256 ?? null]);
}
function sourceHash(asset: Asset): string | null {
  const candidate = asset.reference && typeof asset.reference === 'object' && 'fullSha256' in asset.reference
    ? asset.reference.fullSha256 : null;
  const parsed = digest.safeParse(candidate);
  return freezeSourceSha256(asset) ?? (parsed.success ? parsed.data : null);
}

/** Read the committed contents through the shared kernel and map compiler.
 * Display/track effects don't participate in a source-domain proxy key. */
export function readProcessingDemands(store: ProjectStore): ProcessingDemand[] {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline || timeline.projectId !== store.projectId) return [];
  const mediaByAsset = new Map<string, Asset | null>();
  const hasOptical = timeline.clips.some(clip => clip.timing?.profile === 'timeline-speed-v1' && clip.timing.interpolation === 'optical');
  const renderable = hasOptical ? timeline.clips.flatMap(clip => clip.assetId && clip.sourceState === 'ready'
    ? [{...clip, assetId: clip.assetId}] : []) : [];
  for (const clip of renderable) if (!mediaByAsset.has(clip.assetId)) {
    mediaByAsset.set(clip.assetId, readOwnedTimelineAsset(store.db, store.projectId, clip.assetId));
  }
  const renderableById = new Map(renderable.map(clip => [clip.id, clip]));
  const durationFrames = timeline.durationFrames ?? renderable.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0);
  const fps = timeline.fps;
  function readTransitions(): ReturnType<typeof timelineTransitionRegions> | null {
    try {
      return timelineTransitionRegions({durationFrames, clips: renderable}, new Map([...mediaByAsset].flatMap(([id, asset]) => asset ? [[id, asset]] : [])),
        (clip, side, frames, source) => {
          const timed = renderableById.get(clip.id);
          if (timed?.timing) {
            const plan = compileClipTimeMap(timed, {fps});
            if (!plan.ok) return false;
            speedTransitionHandle({...timed, timing: timed.timing}, plan.value, side, frames, source.frames);
            return true;
          }
          return source.image || (side === 'before' ? clip.sourceInFrame >= frames
            : clip.sourceInFrame + clip.durationFrames + frames <= source.frames);
        });
    } catch { return null; }
  }
  const transitions = hasOptical ? readTransitions() : null;
  const tracks = new Map(timeline.tracks.map(track => [track.id, track.kind]));
  const result: ProcessingDemand[] = [];
  for (const clip of timeline.clips) {
    const timing = clip.timing;
    if (!timing || timing.profile !== 'timeline-speed-v1') continue;
    const kinds: ProcessingInput['kind'][] = [];
    if (timing.view.direction === 'reverse') kinds.push('reverse');
    const wantsOptical = timing.interpolation === 'optical' && tracks.get(clip.trackId) === 'video';
    if (!kinds.length && !wantsOptical) continue;
    const map = compileClipTimeMap(clip, timeline);
    const plan = map.ok ? timeMapPlanInfo(map.value) : null;
    const info = plan?.ok ? plan.value : null;
    if (clip.assetId && !mediaByAsset.has(clip.assetId)) {
      mediaByAsset.set(clip.assetId, readOwnedTimelineAsset(store.db, store.projectId, clip.assetId));
    }
    const asset = clip.assetId ? mediaByAsset.get(clip.assetId) : null;
    const media = asset?.mimeType.startsWith('video/') && tracks.get(clip.trackId) !== 'audio' ? 'video'
      : asset?.mimeType.startsWith('audio/') || asset?.mimeType.startsWith('video/') && tracks.get(clip.trackId) === 'audio' ? 'audio' : null;
    let optical: ProcessingInput['optical'];
    if (wantsOptical) {
      const sourceFrames = sourceFrameCount(asset?.duration);
      const renderClip = renderableById.get(clip.id);
      let hasSlow = true;
      if (transitions && renderClip && sourceFrames && map.ok) {
        const picture = transitionPictureRange(renderClip, transitions);
        try {
          const windows = speedPictureWindows({...renderClip, timing}, map.value, picture, picture, sourceFrames);
          const slow = windows.map(window => timeMapHasSlowMotion(window.plan));
          hasSlow = slow.some(value => !value.ok || value.value);
          optical = {timing: clipTimingSchema.options[0].parse(timing), sourceFrames, beforeFrames: clip.startFrame - picture.start,
            afterFrames: picture.end - clip.startFrame - clip.durationFrames};
        } catch { /* The unsupported handle stays unavailable for this demand. */ }
      } else if (map.ok) {
        const slow = timeMapHasSlowMotion(map.value);
        hasSlow = !slow.ok || slow.value;
      }
      if (hasSlow) kinds.push('optical');
    }
    const sourceIdentity = asset ? processingSourceIdentity(asset) : null;
    const sourceSha256 = asset ? sourceHash(asset) : null;
    for (const kind of kinds) {
      const colour = clip.colour && typeof clip.colour === 'object' && 'source' in clip.colour ? clip.colour.source : null;
      const reverseRecipe = [REVERSE_PROXY_PROFILE, kind, timing, info?.sourceWindow ?? null,
        media, timeline.width, timeline.height, timeline.fps, colour ?? null];
      const recipe = processingHash(kind === 'reverse' ? reverseRecipe : [OPTICAL_PROXY_PROFILE, OPTICAL_FLOW_CUT_POLICY, optical ?? timing,
        media, info?.mapHash ?? null, colour ?? null]);
      const demandKey = processingHash([store.projectId, recipe, sourceSha256 ?? sourceIdentity ?? clip.assetId ?? clip.id]);
      result.push({demandKey, clipId: clip.id,
        input: {version: 1, kind, timelineId: timeline.id, assetId: clip.assetId ?? null,
          sourceIdentity, sourceSha256, media, mapHash: info?.mapHash ?? null,
          sourceWindow: info?.sourceWindow ?? null, sourceFps: timing.basis.sourceFps, recipe,
          ...(kind === 'optical' && optical ? {optical} : {})},
        unavailable: clip.sourceState !== 'ready' || !asset ? 'SOURCE_UNAVAILABLE'
          : !media || !info || kind === 'optical' && (media !== 'video' || !optical) ? 'UNSUPPORTED_FORMAT' : null});
    }
  }
  return result;
}
