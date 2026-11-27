import {createHash} from 'node:crypto';
import type {ProjectStore} from '../project-file/store.ts';
import {readFormat5TimelineRecord} from '../project-file/format5-timeline.ts';
import {freezeSourceSha256} from '../format6-source-proof.ts';
import {canonicalJson} from '../project-versions/document.ts';
import {readOwnedTimelineAsset} from '../timeline-sources.ts';
import {compileClipTimeMap} from '../../../contracts/src/timeline-clip-timing.ts';
import {clipTransitionOutputFits, clipTransitionPredecessor, clipTransitionSides, savedClipTransition} from '../../../contracts/src/timeline-clip-transition.ts';
import {sourceFrameCount} from '../../../contracts/src/source-range.ts';
import {timeMapPlanInfo} from '../../../contracts/src/timeline-time-map.ts';
import {processingDigestSchema as digest} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingInput, ProcessingTaskRow} from '../../../contracts/src/timeline-processing-storage.ts';
import {REVERSE_PROXY_PROFILE} from './reverse.ts';
import {reverseAudioCoverage, REVERSE_PROXY_COVERAGE_VERSION} from './reverse-profile.ts';
import {TIMELINE_PREVIEW_CACHE_PROFILE} from './preview-port.ts';
import {reversePictureCoverage} from './picture-coverage.ts';

export interface ProcessingDemand {
  readonly demandKey: string;
  readonly clipId: string;
  readonly input: ProcessingInput;
  readonly unavailable: ProcessingTaskRow['errorCode'];
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
export function readProcessingDemands(store: ProjectStore, previewEnabled = false): ProcessingDemand[] {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline || timeline.projectId !== store.projectId) return [];
  const mediaByAsset = new Map<string, Asset | null>();
  const tracks = new Map(timeline.tracks.map(track => [track.id, track.kind]));
  const videoClips = timeline.clips.filter(clip => tracks.get(clip.trackId) === 'video').map(clip => ({...clip, assetId: clip.assetId ?? ''}));
  const lead = new Map<string, number>(), tail = new Map<string, number>();
  for (const incoming of videoClips) {
    const transition = savedClipTransition(incoming);
    if (!transition) continue;
    const outgoing = clipTransitionPredecessor(videoClips, incoming);
    if (!outgoing || !clipTransitionOutputFits(videoClips, outgoing, incoming, transition.durationFrames)) continue;
    const {before, after} = clipTransitionSides(transition.durationFrames);
    lead.set(incoming.id, before);
    tail.set(outgoing.id, after);
  }
  const result: ProcessingDemand[] = [];
  for (const clip of timeline.clips) {
    const timing = clip.timing;
    if (!timing || timing.profile !== 'timeline-speed-v1') continue;
    const isVideo = tracks.get(clip.trackId) === 'video';
    const kinds: ProcessingInput['kind'][] = [];
    if (timing.view.direction === 'reverse') kinds.push('reverse');
    if (timing.interpolation === 'optical' && isVideo) kinds.push('optical');
    if (previewEnabled && isVideo && (timing.view.direction === 'reverse' || timing.basis.speed.kind === 'curve')) kinds.push('preview');
    if (!kinds.length) continue;
    const map = compileClipTimeMap(clip, timeline);
    const plan = map.ok ? timeMapPlanInfo(map.value) : null;
    const info = plan?.ok ? plan.value : null;
    if (clip.assetId && !mediaByAsset.has(clip.assetId)) {
      mediaByAsset.set(clip.assetId, readOwnedTimelineAsset(store.db, store.projectId, clip.assetId));
    }
    const asset = clip.assetId ? mediaByAsset.get(clip.assetId) : null;
    const media = asset?.mimeType.startsWith('video/') && tracks.get(clip.trackId) !== 'audio' ? 'video'
      : asset?.mimeType.startsWith('audio/') || asset?.mimeType.startsWith('video/') && tracks.get(clip.trackId) === 'audio' ? 'audio' : null;
    const sourceIdentity = asset ? processingSourceIdentity(asset) : null;
    const sourceSha256 = asset ? sourceHash(asset) : null;
    for (const kind of kinds) {
      const colour = clip.colour && typeof clip.colour === 'object' && 'source' in clip.colour ? clip.colour.source : null;
      const audioWindow = kind === 'reverse' && map.ok ? reverseAudioCoverage(map.value, timing) : undefined;
      const pictureWindow = kind === 'reverse' && media === 'video' && map.ok && info
        ? reversePictureCoverage(map.value, timing, info.sourceWindow, sourceFrameCount(asset?.duration) ?? 0,
          lead.get(clip.id) ?? 0, tail.get(clip.id) ?? 0) : undefined;
      const profile = kind === 'preview' ? TIMELINE_PREVIEW_CACHE_PROFILE : REVERSE_PROXY_PROFILE;
      const recipe = processingHash([profile, kind, timing, info?.sourceWindow ?? null,
        media, timeline.width, timeline.height, timeline.fps, colour ?? null,
        // Version the audio recipe so prior incomplete proxies are never the new demand.
        ...(kind === 'reverse' ? [{audioWindow: audioWindow ?? null, pictureWindow: pictureWindow ?? null,
          coverage: REVERSE_PROXY_COVERAGE_VERSION}] : [])]);
      const demandKey = processingHash([store.projectId, recipe, sourceSha256 ?? sourceIdentity ?? clip.assetId ?? clip.id]);
      result.push({demandKey, clipId: clip.id,
        input: {version: 1, kind, timelineId: timeline.id, assetId: clip.assetId ?? null,
          sourceIdentity, sourceSha256, media, mapHash: info?.mapHash ?? null,
          sourceWindow: info?.sourceWindow ?? null, sourceFps: timing.basis.sourceFps, recipe,
          ...(kind === 'preview' ? {timing} : {}), ...(audioWindow ? {audioWindow} : {}), ...(pictureWindow ? {pictureWindow} : {})},
        unavailable: kind === 'optical' ? 'UNSUPPORTED_FORMAT'
          : clip.sourceState !== 'ready' || !asset ? 'SOURCE_UNAVAILABLE'
            : !media || !info || kind === 'preview' && media !== 'video' ? 'UNSUPPORTED_FORMAT' : null});
    }
  }
  return result;
}
