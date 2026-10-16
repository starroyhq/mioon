/** Dormant pure compiler: no production consumer, media invocation or admission
 * authority. Input must already be bounded ordinary data; portable capture does
 * not establish safety against transparent proxies or installed filter support.
 */
import type {OpacityEnvelopeClip, OpacityEnvelopePoint} from '../../contracts/src/timeline-opacity-envelope.ts';
import {createOpacityEnvelopeEvaluator, opacityEnvelopeFieldsAfterEdit} from '../../contracts/src/timeline-opacity-envelope.ts';

export const TIMELINE_OPACITY_FILTER_BYTE_CAP_CANDIDATE = 8192;
export const TIMELINE_OPACITY_EXPRESSION_BYTE_CAP_CANDIDATE = 1536;

/** Required candidate integration order, not evidence that a renderer currently
 * consumes this stage. Optional colour/LUT steps keep these relative positions.
 * Managed images reach this stage as already premultiplied encoded RGB(A).
 */
export const TIMELINE_OPACITY_STAGE_ORDER_CANDIDATE = Object.freeze([
  'source-colour', 'creative-lut', 'resize-contain',
  'normalize-rgba-and-frame-timebase', 'clip-opacity', 'overlay', 'subtitles', 'output',
] as const);
export type TimelineOpacityAlphaModeCandidate = 'straight' | 'premultiplied';
export interface CompiledTimelineOpacityStageCandidate {
  readonly stage: 'clip-opacity';
  readonly stageOrder: typeof TIMELINE_OPACITY_STAGE_ORDER_CANDIDATE;
  readonly alphaMode: TimelineOpacityAlphaModeCandidate;
  readonly offsetFrames: number;
  readonly frameCount: number;
  /** One graph-level escaped stage; exactly empty for absent or explicit null. */
  readonly filter: string;
  /** Integer n on the fresh segment's half-open [0, frameCount) frame clock. */
  readonly atSegmentFrame: (frame: number) => number;
}

const fail = (message: string): never => {
  throw Object.assign(new Error(message), {code: 'INVALID_OPACITY_ENVELOPE_FILTER'});
};
const integer = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;

function expression(points: readonly OpacityEnvelopePoint[], offsetFrames: number): string {
  // geq's N is the zero-based input frame number, after the existing 30fps,
  // tpad/trim and PTS normalization. No source-in or output-range clock enters it.
  const x = `(N+${offsetFrames})`;
  let result = String(points[points.length - 1]!.opacity);
  for (let index = points.length - 2; index >= 0; index--) {
    const left = points[index]!, right = points[index + 1]!;
    result = `if(lt(${x},${right.frame}),${left.opacity}+(${right.opacity}-${left.opacity})*((${x}-${left.frame})/${right.frame - left.frame}),${result})`;
  }
  const first = points[0]!;
  result = `if(lte(${x},${first.frame}),${first.opacity},${result})`;
  // Numbers are finite and validated, so every emitted character is ASCII.
  // The point cap bounds construction before this final byte-length check.
  if (result.length > TIMELINE_OPACITY_EXPRESSION_BYTE_CAP_CANDIDATE) fail('Opacity expression exceeds its byte cap.');
  return result;
}

/** Compile the same layer stage for preview and export; there is no purpose
 * branch. The caller supplies the original composition segment's clip-local
 * offset, beginFrame - clip.startFrame, even for a selected export range. Range
 * trimming follows compositing, so it never resets this clock or adds reseeks.
 *
 * The eventual renderer must insert this after colour/LUT, contain resize/pad,
 * 30fps/tpad/trim and PTS normalization, immediately before overlay. Straight
 * RGBA changes A only; managed premultiplied layers change RGB and A together.
 * Conversion through planar RGB(A) requests geq's RGB options without a YUV
 * conversion. Integer sample rounding and actual FFmpeg support remain unproven
 * until the separately authorized bounded pixel test is run.
 *
 * Only validated numeric curve data enters the closed expression grammar. There
 * are no caller expressions, labels, paths, stage names or filter fragments.
 * This is not a complete clip/snapshot/source validator or a render capability.
 */
export function compileTimelineOpacityFilterCandidate(
  clip: OpacityEnvelopeClip,
  offsetFrames: number,
  frameCount: number,
  alphaMode: TimelineOpacityAlphaModeCandidate,
): Readonly<CompiledTimelineOpacityStageCandidate> {
  const fields = opacityEnvelopeFieldsAfterEdit(clip, {});
  const captured: OpacityEnvelopeClip = {durationFrames: clip.durationFrames, ...fields};
  if (!integer(offsetFrames, 0, captured.durationFrames - 1) ||
      !integer(frameCount, 1, captured.durationFrames - offsetFrames)) fail('Invalid clip-local frame range.');
  if (alphaMode !== 'straight' && alphaMode !== 'premultiplied') fail('Invalid layer alpha representation.');
  const evaluator = createOpacityEnvelopeEvaluator(captured);
  let filter = '';
  if (fields.opacityEnvelope !== undefined && fields.opacityEnvelope !== null) {
    const factor = expression(fields.opacityEnvelope.points, offsetFrames);
    const channel = (name: 'r' | 'g' | 'b' | 'alpha'): string =>
      `${name}(X,Y)${name === 'alpha' || alphaMode === 'premultiplied' ? `*(${factor})` : ''}`.replaceAll(',', '\\,');
    filter = `format=gbrap,geq=r=${channel('r')}:g=${channel('g')}:b=${channel('b')}:a=${channel('alpha')}:interpolation=nearest,format=rgba`;
    if (filter.length > TIMELINE_OPACITY_FILTER_BYTE_CAP_CANDIDATE) fail('Opacity stage exceeds its byte cap.');
  }
  return Object.freeze({
    stage: 'clip-opacity', stageOrder: TIMELINE_OPACITY_STAGE_ORDER_CANDIDATE,
    alphaMode, offsetFrames, frameCount, filter,
    atSegmentFrame(frame: number): number {
      if (!integer(frame, 0, frameCount - 1)) return fail('Invalid segment frame.');
      return evaluator.atFrame(offsetFrames + frame);
    },
  });
}
