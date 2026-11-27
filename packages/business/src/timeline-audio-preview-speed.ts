import {AUDIO_PREVIEW_LIMITS} from '../../contracts/src/timeline-audio-preview.ts';
import {timeMapSourceWindowForOutput, trimTimeMap} from '../../contracts/src/timeline-time-map.ts';
import {sourceFrameCount} from '../../contracts/src/source-range.ts';
import {assertTimelineSpeedRenderable} from '../../contracts/src/timeline-speed-render.ts';
import {compileTimelineSpeedExportClips, type CompiledTimelineSpeedExportClip} from '../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect} from './media-runtime.ts';
import {probeTimelineSource} from './timeline-sources.ts';
import {renderTimelineSpeedAudioPcm, timelineReverseAudioClock, type TimelineSpeedAudioSource} from './timeline-speed-export-audio.ts';
import {withTimelineReverseAudio, type TimelineReverseProxyPort} from './timeline-speed-export-proxy.ts';
import {speedExportMappingError} from './timeline-speed-export-plan.ts';

export function readAudioPreviewTimings(timeline: unknown, enabled: boolean): ReadonlyMap<string, CompiledTimelineSpeedExportClip> {
  if (!enabled) {
    assertTimelineSpeedRenderable(timeline);
    return new Map();
  }
  return new Map(compileTimelineSpeedExportClips(timeline).map(timing => [timing.clipId, timing]));
}

interface PreviewSpeedSource {
  readonly projectId: string;
  readonly timelineId: string;
  readonly file: string;
  readonly asset: {readonly id: string; readonly sha256: string; readonly mimeType: string};
  readonly trackKind: 'video' | 'audio';
}
interface PreviewSpeedOptions {
  readonly signal?: AbortSignal;
  readonly beforeEffect: () => void;
  readonly reverseProxy?: TimelineReverseProxyPort;
  readonly onPcmAllocation?: (bytes: number) => void;
}
const samplesPerFrame = AUDIO_PREVIEW_LIMITS.samplesPerFrame;
const bytesPerSampleFrame = AUDIO_PREVIEW_LIMITS.channels * AUDIO_PREVIEW_LIMITS.bytesPerSample;
const invalidPcm = () => Object.assign(new Error('The retimed preview PCM does not match its saved output window.'),
  {code: 'AUDIO_PREVIEW_INVALID_PCM'});

/** Read a bounded output-coordinate window; the continuous export sample clock
 * retains the preceding WSOLA context and the unrounded tail. */
export async function renderAudioPreviewSpeedWindow(timed: CompiledTimelineSpeedExportClip, from: number, to: number,
  {file, asset, projectId, timelineId, trackKind}: PreviewSpeedSource, options: PreviewSpeedOptions): Promise<Buffer> {
  const {timing, clipId, plan, mapHash} = timed;
  const fence = (): void => checkMediaEffect(options.beforeEffect, options.signal);
  fence();
  if (to - from > AUDIO_PREVIEW_LIMITS.windowFrames) throw invalidPcm();
  const selected = trimTimeMap(plan, from, to);
  if (!selected.ok) throw speedExportMappingError(clipId, selected.code);
  const sampleFrames = selected.value.durationFrames * samplesPerFrame;
  const pcm = Buffer.alloc(sampleFrames * bytesPerSampleFrame);
  options.onPcmAllocation?.(pcm.byteLength);
  if (timing.profile === 'timeline-freeze-v1') return pcm;

  const render = async (source: TimelineSpeedAudioSource, beforeEffect = fence): Promise<Buffer> => {
    let offset = 0;
    const rendered = await renderTimelineSpeedAudioPcm({timing, plan: selected.value, source},
      {signal: options.signal, beforeEffect}, () => async chunk => {
        if (offset + chunk.length > pcm.byteLength) throw invalidPcm();
        offset += chunk.copy(pcm, offset);
      });
    if (rendered !== sampleFrames || offset !== pcm.byteLength) throw invalidPcm();
    return pcm;
  };
  const sourceWindow = timeMapSourceWindowForOutput(plan);
  if (!sourceWindow.ok) throw speedExportMappingError(clipId, sourceWindow.code);
  if (plan.direction === 'forward') {
    // Export prepares the same exact stream indices, including a timed video
    // with an audio clock different from its video origin or attached artwork.
    const streams = await probeTimelineSource(file, {signal: options.signal, beforeEffect: fence, beforeSpawn: fence});
    if (!streams.hasAudio || streams.audioStreamIndex == null || streams.duration === null ||
        streams.duration > AUDIO_PREVIEW_LIMITS.sourceSeconds || sourceWindow.value.endFrame > (sourceFrameCount(streams.duration) ?? 0)) throw invalidPcm();
    return render({file, streamIndex: streams.audioStreamIndex, videoStreamIndex: streams.videoStreamIndex});
  }
  const audioWindow = timelineReverseAudioClock(selected.value, timing);
  if (!audioWindow) return pcm;
  const request = {projectId, timelineId, clipId, assetId: asset.id, sourceSha256: asset.sha256, mapHash,
    media: asset.mimeType.startsWith('video/') && trackKind === 'video' ? 'video' as const : 'audio' as const,
    sourceFps: plan.root.sourceFps, sourceWindow: sourceWindow.value, pictureWindows: [], needsAudio: true, audioWindow};
  return withTimelineReverseAudio(request, options.reverseProxy, options, (audio, beforeEffect) => render({
    file: audio.file, streamIndex: 'a:0', reversed: {...audio.clock, ...(audio.raw ? {raw: audio.raw} : {})},
  }, beforeEffect));
}
