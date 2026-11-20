#!/usr/bin/env node
/** SP-I0 prototype: curve-speed optical-flow phase, blend direct consumption,
 * pixel-format admission, three-mode measurement, scene/occlusion/fast samples
 * and 2-second chunk ownership. No product code, no project format changes. */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveTools} from './tools.mjs';
import {compiledCurve, inverseSourceTimes, timestampRemap, errorStats, independentLinearFit, phaseRowsForCurve,
  curvePhaseSweep, CURVE_POINTS} from './phase.mjs';
import {curveEmpirical, constantEmpirical, reverseConstantEmpirical} from './empirical.mjs';
import {probeFormats, probeFilterHelp} from './formats.mjs';
import {generatePortrait, generateAnalytic} from './samples.mjs';
import {measureAllModes} from './bench.mjs';
import {sceneCutEvidence, motionEvidence, chunkEvidence} from './evidence.mjs';

const args = process.argv.slice(2);
const value = name => {const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];};
const output = path.resolve(value('--output') ?? 'sp-i0-results');
const skipBench = args.includes('--skip-bench');
const quick = args.includes('--quick');
mkdirSync(output, {recursive: true});
const statusFile = path.join(output, 'status.log');
const status = line => {writeFileSync(statusFile, `${line}\n`, {flag: 'a'}); process.stdout.write(`${line}\n`);};
const root = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'mioon-sp-i0-'));
const results = {schemaVersion: 1, status: 'running', card: 'SP-I0', generatedBy: 'scripts/speed-interp-phase/run-prototype.mjs',
  environment: {platform: process.platform, arch: process.arch, node: process.version}, profile: 'timeline-time-map-v1', curvePoints: CURVE_POINTS};
try {
  const tools = resolveTools(scratch);
  results.environment.ffmpeg = tools.version;
  results.environment.mediaToolSource = tools.source;
  status(`media-tools ${tools.version} (${tools.source})`);
  const {ffmpeg, ffprobe} = tools;

  // 1. Curve optical phase: shared-map inverse PTS vs internal minterpolate
  //    arithmetic and empirical blend output on a lossless VFR source.
  const curve = compiledCurve();
  const times = inverseSourceTimes(curve.samples);
  const remapRows = timestampRemap(curve.samples, times).filter(row => row.outputFrame < curve.outputFrames - 2);
  const active = phaseRowsForCurve(CURVE_POINTS, 150, 600);
  results.curvePhase = {
    outputFrames: curve.outputFrames,
    mapHash: curve.root.mapHash,
    activeCurveRows: {frames: active.rows.length, phaseErrorFrames: errorStats(active.rows.map(row => row.error))},
    curveSweep: curvePhaseSweep(150),
    internalAlphaQuantization: '1/1024 integer alpha, truncated; alpha == 0 or 1024 copies a source frame',
    timestampRewrite: {
      rule: 'source frame n input PTS = inverse shared map at integer source position n',
      phaseErrorFrames: errorStats(remapRows.map(row => row.error)),
    },
    independentLinearFitLowerBound: independentLinearFit(curve.samples),
    empirical: curveEmpirical(ffmpeg, ffprobe, scratch),
    constantRateControl: constantEmpirical(ffmpeg, ffprobe, scratch),
    quantizationProposal: {
      profile: 'interp-phase-pts-v1',
      rule: 'compile inverse source-frame times on a rational PTS grid; declare the per-curve max |phase - map phase| over active slow rows and reject that curve for optical when the bound exceeds a coordinator-chosen epsilon',
      measuredBoundFrames: errorStats(active.rows.map(row => row.error)).maxAbs,
      caveats: [
        'the bound is per compiled curve and must be checked at compile time; it is not a universal guarantee',
        'the last two output frames are the minterpolate tail (source end clamp) and are excluded from the phase rows',
        'internal alpha is quantized to 1/1024 of a source interval; the accepted bound includes that quantization',
      ],
    },
  };
  status(`curve phase: measured max |error| ${results.curvePhase.timestampRewrite.phaseErrorFrames.maxAbs.toFixed(6)} frame, alpha-formula matches ` +
    `${results.curvePhase.empirical.probe.minterpolateMatches}/${results.curvePhase.empirical.probe.rows.length}`);

  // 2. Frame blending: the filter consumes continuous source coordinates from
  //    input PTS; prove the 7-bit weight formula empirically (it is not an
  //    off-table repeat/duplicate followed by a blend).
  results.frameBlend = {
    filter: 'framerate=fps=30:interp_start=0:interp_end=255',
    weights: '7-bit interpolate = round((work_pts - pts0) * 128 / (pts1 - pts0)); blend is src1*(128-w)+src2*w',
    directCoordinateEvidence: {
      curveWeightsMatchFormula: results.curvePhase.empirical.probe.framerateFormulaMatches,
      curveFrames: results.curvePhase.empirical.probe.rows.length,
      constantRateWeightsMatchFormula: results.curvePhase.constantRateControl.probe.framerateFormulaMatches,
      curvePhaseErrorFrames: results.curvePhase.empirical.probe.frameratePhaseError,
      note: 'off-table drop/duplicate first would make the two blend inputs identical (weight irrelevant); the measured weights are non-trivial fractions of the shared map coordinates',
    },
    directionWeights: 'direction is encoded by the order of source frames in the window; the same fractional weight then applies to the ordered next frame. Reverse windows reverse the frame order and the expected next-frame weight becomes 1 - forward phase (verified below).',
    empiricalPhaseErrorVersusSharedMap: results.curvePhase.empirical.probe.frameratePhaseError,
    reverseDirectionControl: reverseConstantEmpirical(ffmpeg, ffprobe, scratch),
  };

  // 3. Pixel-format admission, no automatic 8-bit downgrade.
  results.pixelFormats = {...probeFormats(ffmpeg, scratch), help: probeFilterHelp(ffmpeg, scratch)};
  status(`pixel formats: direct accepted ${results.pixelFormats.accepted8BitPlanar.length}, rejected ${results.pixelFormats.rejected.length}`);

  // 4. Measurements: portrait 600 frames, three modes, plus scene/occlusion/fast.
  results.measurements = skipBench ? {skipped: true} : (() => {
    const portrait = generatePortrait(ffmpeg, path.join(scratch, 'portrait'));
    return measureAllModes(ffmpeg, ffprobe, portrait.file, path.join(scratch, 'bench'));
  })();
  const analytic = generateAnalytic(ffmpeg, path.join(scratch, 'analytic'));
  results.sceneCut = sceneCutEvidence(ffmpeg, analytic.sceneCut, scratch);
  results.motionSamples = motionEvidence(ffmpeg, {occlusion: analytic.occlusion, fastMotion: analytic.fastMotion}, scratch);
  status(`measurements done${skipBench ? ' (bench skipped)' : ''}`);

  // 5. Chunk ownership: 2-second source chunks with two-source-frame overlap,
  //    only owned output frames, no duplicate/missing frame at boundaries.
  results.chunking = chunkEvidence(ffmpeg, scratch);
  status(`chunking: owned ${results.chunking.ownedFrames}/${results.chunking.outputFrames}, mismatched ${results.chunking.mismatchedFrames}`);

  results.status = 'ok';
  const bench = results.measurements?.rows ?? [];
  const summary = {
    schemaVersion: 1, card: 'SP-I0', status: 'ok', mediaTool: results.environment.ffmpeg,
    curveMapHash: results.curvePhase.mapHash,
    curvePhase: {activeRows: results.curvePhase.activeCurveRows.frames,
      maxAbsErrorFrames: results.curvePhase.activeCurveRows.phaseErrorFrames.maxAbs,
      p95AbsErrorFrames: results.curvePhase.activeCurveRows.phaseErrorFrames.p95Abs,
      alphaFormulaMatches: `${results.curvePhase.empirical.probe.minterpolateMatches}/${results.curvePhase.empirical.probe.rows.length}`,
      framerateFormulaMatches: `${results.curvePhase.empirical.probe.framerateFormulaMatches}/${results.curvePhase.empirical.probe.rows.length}`,
      curveSweep: Object.fromEntries(Object.entries(results.curvePhase.curveSweep).map(([name, value]) =>
        [name, {maxAbsErrorFrames: value.phaseErrorFrames.maxAbs, outputFrames: value.outputFrames}]))},
    frameBlend: {constantRateFormulaMatches: results.frameBlend.directCoordinateEvidence.constantRateWeightsMatchFormula,
      curveFormulaMatches: results.frameBlend.directCoordinateEvidence.curveWeightsMatchFormula,
      reverseFrameWeightsMatches: results.frameBlend.reverseDirectionControl.framerateMatches,
      reverseDirectionFrames: results.frameBlend.reverseDirectionControl.frames},
    pixelFormats: {directAccepted: results.pixelFormats.accepted8BitPlanar,
      rejected: results.pixelFormats.rejected.map(row => row.format)},
    bench: bench.map(row => ({mode: row.name, wallSeconds: row.wallSeconds, peakRssBytes: row.peakRssBytes,
      frames: row.output.nbFrames, exact600: row.exact600, bytes: row.bytes})),
    sceneCut: results.sceneCut, motionSamples: results.motionSamples.rows, chunking: results.chunking,
  };
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  status('SP-I0 prototype complete');
  if (quick) rmSync(scratch, {recursive: true, force: true});
} catch (error) {
  results.status = 'failed';
  results.error = {message: String(error?.message ?? error).slice(0, 2000)};
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  status(`SP-I0 prototype failed: ${results.error.message.split('\n')[0]}`);
  rmSync(scratch, {recursive: true, force: true});
  process.exitCode = 1;
}
