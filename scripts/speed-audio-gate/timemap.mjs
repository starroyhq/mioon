/** Thin adapter between the SP-M compiled map and the audio measurements.
 *
 * Constant maps use the exact closed-form mapping from the compiled plan; curve
 * maps use the SP-M window queries (`timeMapTailInverse`) at chunk boundaries and
 * signal markers. The 300k-frame integer vector is never materialised: audio is
 * a continuous-clock consumer, as the SP-M review requires. */
import {
  compileTimeMap, initialTimeMap, instantiateSpeedPreset, timeMapPlanInfo, timeMapRootInfo, timeMapTailInverse,
} from '../../packages/contracts/src/timeline-time-map.ts';
import {SAMPLE_RATE, SAMPLES_PER_FRAME} from './pcm.mjs';

export const SOURCE_FPS = 30;
export const OUTPUT_FPS = 30;
export const PROJECT_FPS = 30;
export const SAMPLES_PER_PROJECT_FRAME = SAMPLE_RATE / PROJECT_FPS;

const unwrap = (result, label) => {
  if (!result.ok) throw new Error(`${label}: ${result.code} ${result.detail}`);
  return result.value;
};
const rational = (numerator, denominator = 1) => ({kind: 'rational', numerator: String(numerator), denominator: String(denominator)});
const timebase = fps => ({fpsNumerator: fps, fpsDenominator: 1});

export function speedValue(rate) {
  return {kind: 'constant', rate: {numerator: rate.numerator, denominator: rate.denominator}};
}
export function projectFrames(material) {
  return Math.round(material.audioFrames / SAMPLES_PER_PROJECT_FRAME);
}

/** Builds a compiled plan for one material and a constant rate. */
export function constantPlan(material, rate) {
  const sourceFrames = projectFrames(material);
  const basis = {profile: 'timeline-speed-v1', sourceFps: timebase(SOURCE_FPS), outputFps: timebase(OUTPUT_FPS),
    sourceRange: {start: rational(0), end: rational(sourceFrames)}, speed: speedValue(rate)};
  const root = unwrap(compileTimeMap(basis), `compile ${rate.numerator}/${rate.denominator}`);
  const plan = initialTimeMap(root);
  const rootInfo = timeMapRootInfo(root);
  const planInfo = unwrap(timeMapPlanInfo(plan), 'plan info');
  const length = rootInfo.rootLength.kind === 'exact'
    ? Number(rootInfo.rootLength.numerator) / Number(rootInfo.rootLength.denominator)
    : rootInfo.rootLength.value;
  const durationFrames = root.durationFrames;
  const totalSamples = durationFrames * SAMPLES_PER_PROJECT_FRAME;
  const motionSamples = Math.ceil(length * SAMPLES_PER_PROJECT_FRAME);
  const rateValue = rate.numerator / rate.denominator;
  const framesPerOutputFrame = rateValue * SOURCE_FPS / OUTPUT_FPS;
  return {kind: 'constant', sourceFrames, rate: rateValue, rateFraction: {...rate}, basis, root, rootInfo, plan, planInfo,
    length, durationFrames, totalSamples, motionSamples, framesPerOutputFrame,
    sourceStartSample: 0, sourceEndSample: material.audioFrames};
}

/** Instantiated point set for a named preset over this material's source range. */
export function presetPlan(material, presetId) {
  const sourceFrames = projectFrames(material);
  const speed = unwrap(instantiateSpeedPreset(presetId, 0, sourceFrames), `preset ${presetId}`);
  if (speed.kind !== 'curve') return constantPlan(material, {numerator: 1, denominator: 1});
  const basis = {profile: 'timeline-speed-v1', sourceFps: timebase(SOURCE_FPS), outputFps: timebase(OUTPUT_FPS),
    sourceRange: {start: rational(0), end: rational(sourceFrames)}, speed};
  const root = unwrap(compileTimeMap(basis), `compile curve ${presetId}`);
  const plan = initialTimeMap(root);
  const rootInfo = timeMapRootInfo(root);
  const planInfo = unwrap(timeMapPlanInfo(plan), 'plan info');
  const length = rootInfo.rootLength.kind === 'numeric' ? rootInfo.rootLength.value : rootInfo.rootLength.value;
  const durationFrames = root.durationFrames;
  return {kind: 'curve', presetId, sourceFrames, basis, root, rootInfo, plan, planInfo,
    length, durationFrames, totalSamples: durationFrames * SAMPLES_PER_PROJECT_FRAME,
    motionSamples: Math.ceil(length * SAMPLES_PER_PROJECT_FRAME), sourceStartSample: 0, sourceEndSample: material.audioFrames};
}

/** Continuous source position (frames) for an output clock time (frames). */
export function sourceFramesAtOutputTime(bundle, outputFrames) {
  if (outputFrames <= 0) return 0;
  if (outputFrames >= bundle.length) return bundle.sourceFrames;
  return sampleOfPosition(unwrap(timeMapTailInverse(bundle.plan,
    {numerator: String(Math.round(outputFrames * SAMPLES_PER_PROJECT_FRAME)), denominator: String(SAMPLES_PER_PROJECT_FRAME)},
    {tailInverse: 'latest'}), 'inverse source').position).value;
}
/** Continuous source frame position for an output frame time on constant maps. */
export function constantSourceFrameAtOutputFrames(bundle, outputFrames) {
  return bundle.sourceStartSample / SAMPLES_PER_PROJECT_FRAME + outputFrames * bundle.framesPerOutputFrame;
}
/** Output frame time for a source frame position; constant closed form, curve bisection. */
export function outputFramesForSourceFrame(bundle, sourceFrame) {
  if (bundle.kind === 'constant') return (sourceFrame - bundle.sourceStartSample / SAMPLES_PER_PROJECT_FRAME) / bundle.framesPerOutputFrame;
  let low = 0, high = bundle.length;
  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (low + high) / 2;
    if (sourceFramesAtOutputTime(bundle, middle) < sourceFrame) low = middle; else high = middle;
  }
  return (low + high) / 2;
}
function sampleOfPosition(position) {
  if (position.kind === 'exact') {
    return {kind: 'exact', value: Number(position.numerator) / Number(position.denominator)};
  }
  return {kind: 'numeric', value: position.value, errorBound: position.errorBound};
}
export function projectSamplesToSourceFrame(samples, fps = SOURCE_FPS) {
  return samples / SAMPLES_PER_SECOND_PER_FRAME(fps);
}
const SAMPLES_PER_SECOND_PER_FRAME = fps => SAMPLE_RATE / fps;

/** Normalised output sample count expected from SP-M for this plan. */
export function expectedTargetSamples(bundle) {
  return {total: bundle.totalSamples, motion: bundle.motionSamples, intentionalTail: bundle.totalSamples - bundle.motionSamples};
}

/** Maps an output sample index to a source sample index on constant plans.
 * Returns null for the intentional ceil tail. */
export function sourceSampleForOutputSample(bundle, outputSample) {
  if (outputSample >= bundle.motionSamples) return null;
  const outputFrames = outputSample / SAMPLES_PER_PROJECT_FRAME;
  return constantSourceFrameAtOutputFrames(bundle, outputFrames) * SAMPLES_PER_PROJECT_FRAME;
}
