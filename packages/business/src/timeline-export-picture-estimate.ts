import {isClipLayoutRect} from '../../contracts/src/timeline-clip-layout.ts';
import {savedClipTransition} from '../../contracts/src/timeline-clip-transition.ts';
import type {TimelineExportRange} from '../../contracts/src/timeline-export-range.ts';
import type {TimelineRecord} from './timeline-inputs.ts';
import {clipRenderPlacement} from './timeline-transform-filter.ts';

interface Raster {readonly width: number; readonly height: number}
type SavedPicture = Pick<TimelineRecord, 'width' | 'height' | 'fps' | 'clips' | 'tracks'>;

// Static padding still costs some bits, particularly around picture edges.
// The 2-second landscape-in-portrait calibration charged it at 1/6 of picture cost.
const BACKGROUND_PIXEL_WEIGHT = 1 / 6;

/** Use saved geometry only. CRF preflight and discovery do not decode or
 * write media. Effects or overlap that need compositing keep the original
 * full-raster model, as do missing source dimensions and uncovered gaps. */
export function estimatedVideoPixels(timeline: SavedPicture, output: Raster, frames: number,
    outputComposition: boolean, range: TimelineExportRange | undefined,
    sourceSize: (id: string) => Raster | null): number {
  const outputPixels = output.width * output.height;
  if (!frames) return outputPixels;
  const visibleTracks = new Set(timeline.tracks.filter(track => track.kind === 'video' && !track.hidden).map(track => track.id));
  const visible = timeline.clips.filter(clip => visibleTracks.has(clip.trackId));
  if (visible.some(clip => savedClipTransition(clip) ||
      !Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0 ||
      !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1)) return outputPixels;

  const start = range?.startFrame ?? 0, end = start + frames;
  // 4K composes directly at delivery resolution. Other tiers resize after
  // compositing on the editing canvas, preserving the same coverage ratio.
  const canvas = outputComposition ? output : timeline;
  const canvasPixels = canvas.width * canvas.height;
  let lastEnd = start, paddingPixelFrames = 0;
  for (const clip of visible.sort((a, b) => a.startFrame - b.startFrame)) {
    const from = Math.max(start, clip.startFrame), to = Math.min(end, clip.startFrame + clip.durationFrames);
    if (to <= from) continue;
    if (from < lastEnd || clip.transform != null || !isClipLayoutRect(clip, timeline)) return outputPixels;
    const source = sourceSize(clip.assetId);
    if (!source) return outputPixels;
    const placement = clipRenderPlacement(clip, timeline, Infinity, outputComposition ? output : undefined);
    const fit = Math.min(placement.width / source.width, placement.height / source.height);
    const picturePixels = Math.min(canvasPixels, source.width * source.height * fit ** 2);
    paddingPixelFrames += (canvasPixels - picturePixels) * (to - from);
    lastEnd = to;
  }
  const paddingFraction = paddingPixelFrames / (canvasPixels * frames);
  // When the compositor raster is upscaled, padding edges grow with the
  // linear scale, while the delivery pixel count grows with its square.
  const upscale = Math.max(1, Math.sqrt(outputPixels / canvasPixels));
  return outputPixels * (1 - (1 - BACKGROUND_PIXEL_WEIGHT / upscale) * paddingFraction);
}
