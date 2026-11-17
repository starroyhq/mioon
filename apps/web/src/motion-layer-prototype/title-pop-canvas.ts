import {sampleTitlePop, titleFontFamily} from './title-pop-state.ts';
import type {TitlePopParams} from './title-pop-state.ts';
import type {MotionFrameProps} from './runtime.ts';

/** Paint into the caller's transparent frame at logical pixels. The caller owns its backing store and scale. */
export function paintTitlePop(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  props: MotionFrameProps<TitlePopParams>,
): void {
  const state = sampleTitlePop(props);
  if (!state) return;
  const {width, height, params: {fontSize, color}} = props;

  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.font = `400 ${fontSize}px ${titleFontFamily}`;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.fillStyle = color;
  const metrics = context.measureText('M');
  const baseline = (metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
  const advances = state.glyphs.map(({glyph}) => context.measureText(glyph).width);
  let left = (width - advances.reduce((sum, advance) => sum + advance, 0)) / 2;
  for (const [index, {glyph, opacity, offsetY, scale}] of state.glyphs.entries()) {
    const advance = advances[index];
    context.save();
    context.globalAlpha = state.opacity * opacity;
    context.translate(left + advance / 2, height / 2 + offsetY);
    context.scale(scale, scale);
    context.fillText(glyph, -advance / 2, baseline);
    context.restore();
    left += advance;
  }
  context.restore();
}
