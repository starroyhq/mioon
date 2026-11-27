import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  buildClipSpeedPreviewBinding,
  buildSpeedWaveformWindow,
  clipNeedsPreviewMediaRpc,
  compileClipTimeMapForPreview,
  computeClipThumbnailSamples,
  isPreviewMediaForClip,
  outputFrameFromSourceSeconds,
  parsePreviewMediaForClip,
  previewMediaNeedsPolling,
  projectSpeedClipWaveformEntry,
  projectSpeedClipWaveformPeaks,
  sampleClipSourceAtTimelineFrame,
} from '../apps/web/src/speed-preview/speed-preview-model.ts';
import type {PreviewMedia} from '../apps/web/src/speed-preview/speed-preview-model.ts';
import {
  SPEED_PREVIEW_POLL_INTERVAL_MS,
  createSpeedPreviewMediaController,
} from '../apps/web/src/speed-preview/use-speed-preview-media.ts';
import {
  createWaveformController,
  visibleWaveformWindows,
  waveformPath,
} from '../apps/web/src/waveform-state.ts';
import type {ClipTiming, SpeedProcessingItem} from '../packages/contracts/src/timeline-speed.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {timelinePreviewMediaPath} from '../packages/contracts/src/timeline-preview-media.ts';
import {
  TIMELINE_TIME_MAP_BASIS_PROFILE,
  compileTimeMap,
  initialTimeMap,
  instantiateSpeedPreset,
  timeMapSourceAtOutputFrame,
} from '../packages/contracts/src/timeline-time-map.ts';
import type {TimeMapBasis} from '../packages/contracts/src/timeline-time-map.ts';
import {translate} from '../packages/i18n/src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const t = ((key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate('zh-Hans', key, params)) as never;

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DIGEST = 'a'.repeat(64);
const SOURCE_URL = projectMediaPath(PROJECT_ID, ASSET_ID);
const PROXY_URL = timelinePreviewMediaPath({projectId: PROJECT_ID, assetId: ASSET_ID, clipId: CLIP_ID, taskId: TASK_ID, digest: DIGEST});

function makeConstantTiming(options: {
  sourceInFrame?: number;
  sourceDurationFrames?: number;
  numerator: number;
  denominator: number;
  direction?: 'forward' | 'reverse';
  pitchShift?: boolean;
  outputFrom?: number;
  outputTo?: number;
}): {readonly timing: ClipTiming; readonly durationFrames: number} {
  const sourceInFrame = options.sourceInFrame ?? 0;
  const sourceDurationFrames = options.sourceDurationFrames ?? 120;
  const basis: TimeMapBasis = {
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: {fpsNumerator: 30, fpsDenominator: 1},
    sourceRange: {
      start: {kind: 'rational', numerator: String(sourceInFrame), denominator: '1'},
      end: {kind: 'rational', numerator: String(sourceInFrame + sourceDurationFrames), denominator: '1'},
    },
    speed: {kind: 'constant', rate: {numerator: options.numerator, denominator: options.denominator}},
  };
  const compiled = compileTimeMap(basis);
  assert.equal(compiled.ok, true);
  const fullDuration = compiled.value.durationFrames;
  const fromFrame = options.outputFrom ?? 0;
  const toFrame = options.outputTo ?? fullDuration;
  return {
    durationFrames: toFrame - fromFrame,
    timing: {
      profile: 'timeline-speed-v1',
      basis,
      view: {
        direction: options.direction ?? 'forward',
        loTime: {anchor: 'start', offsetOutputFrames: 0},
        hiTime: {anchor: 'end', offsetOutputFrames: 0},
      },
      outputWindow: {fromFrame, toFrame},
      pitchShift: options.pitchShift ?? true,
      interpolation: 'off',
    },
  };
}

function makeCurveTiming(options: {
  presetId: 'slowMiddle' | 'fastToSlow' | 'slowToFast' | 'fastMiddle' | 'flashIn' | 'flashOut';
  sourceInFrame?: number;
  sourceDurationFrames?: number;
  direction?: 'forward' | 'reverse';
}): {readonly timing: ClipTiming; readonly durationFrames: number} {
  const sourceInFrame = options.sourceInFrame ?? 0;
  const sourceDurationFrames = options.sourceDurationFrames ?? 120;
  const speed = instantiateSpeedPreset(options.presetId, sourceInFrame, sourceInFrame + sourceDurationFrames);
  assert.equal(speed.ok, true);
  const basis: TimeMapBasis = {
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: {fpsNumerator: 30, fpsDenominator: 1},
    sourceRange: {
      start: {kind: 'rational', numerator: String(sourceInFrame), denominator: '1'},
      end: {kind: 'rational', numerator: String(sourceInFrame + sourceDurationFrames), denominator: '1'},
    },
    speed: speed.value,
  };
  const compiled = compileTimeMap(basis);
  assert.equal(compiled.ok, true);
  return {
    durationFrames: compiled.value.durationFrames,
    timing: {
      profile: 'timeline-speed-v1',
      basis,
      view: {
        direction: options.direction ?? 'forward',
        loTime: {anchor: 'start', offsetOutputFrames: 0},
        hiTime: {anchor: 'end', offsetOutputFrames: 0},
      },
      outputWindow: {fromFrame: 0, toFrame: compiled.value.durationFrames},
      pitchShift: true,
      interpolation: 'off',
    },
  };
}

function makeFreezeTiming(sourceFrame: number): ClipTiming {
  return {
    profile: 'timeline-freeze-v1',
    sourceFrame,
    sourceVersionId: null,
    sourceSha256: DIGEST,
  };
}

const SPEED_TIMELINE = {
  id: 'tl-1',
  projectId: PROJECT_ID,
  fps: 30,
  capabilities: {speed: true},
};

const GATE_OFF_TIMELINE = {
  id: 'tl-1',
  projectId: PROJECT_ID,
  fps: 30,
  capabilities: {speed: false},
};

const VIDEO_ASSET = {
  id: ASSET_ID,
  projectId: PROJECT_ID,
  mimeType: 'video/mp4',
  duration: 10,
  hasAudio: true,
};

test('PreviewMedia schema validates native, ready proxy verbatim URL, and pending/failed proxy states', () => {
  const native = parsePreviewMediaForClip({mode: 'native', rate: {numerator: 2, denominator: 1}}, PROJECT_ID, CLIP_ID);
  assert.deepEqual(native, {mode: 'native', rate: {numerator: 2, denominator: 1}});
  assert.equal(previewMediaNeedsPolling(native), false);

  const ready = parsePreviewMediaForClip({mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: 90}, PROJECT_ID, CLIP_ID);
  assert.deepEqual(ready, {mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: 90});
  assert.equal(previewMediaNeedsPolling(ready), false);

  const running = parsePreviewMediaForClip({mode: 'proxy', status: 'running', taskId: TASK_ID, progress: 42}, PROJECT_ID, CLIP_ID);
  assert.deepEqual(running, {mode: 'proxy', status: 'running', taskId: TASK_ID, progress: 42});
  assert.equal(previewMediaNeedsPolling(running), true);

  const failed = parsePreviewMediaForClip(
    {mode: 'proxy', status: 'failed', taskId: TASK_ID, reason: 'INTERPOLATION_UNAVAILABLE'},
    PROJECT_ID,
    CLIP_ID,
  );
  assert.deepEqual(failed, {mode: 'proxy', status: 'failed', taskId: TASK_ID, reason: 'INTERPOLATION_UNAVAILABLE'});
  assert.equal(previewMediaNeedsPolling(failed), false);

  // Reject foreign project, foreign clip, missing digest, out-of-range rate, or external URL.
  assert.equal(
    isPreviewMediaForClip({mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: 90}, OTHER_PROJECT_ID, CLIP_ID),
    false,
  );
  assert.equal(
    isPreviewMediaForClip({mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: 90}, PROJECT_ID, 'other-clip'),
    false,
  );
  assert.equal(
    parsePreviewMediaForClip(
      {mode: 'proxy', status: 'ready', url: `${SOURCE_URL}?speedPreview=${CLIP_ID}&taskId=${TASK_ID}`, durationFrames: 90},
      PROJECT_ID,
      CLIP_ID,
    ),
    null,
  );
  assert.equal(parsePreviewMediaForClip({mode: 'proxy', status: 'ready', url: PROXY_URL + '&extra=1', durationFrames: 90}, PROJECT_ID, CLIP_ID), null);
  assert.equal(
    parsePreviewMediaForClip({mode: 'proxy', status: 'ready', url: 'https://evil.example/a.mp4', durationFrames: 90}, PROJECT_ID, CLIP_ID),
    null,
  );
  assert.equal(parsePreviewMediaForClip({mode: 'native', rate: {numerator: 11, denominator: 1}}, PROJECT_ID, CLIP_ID), null);
  assert.equal(parsePreviewMediaForClip({mode: 'native', rate: {numerator: 1, denominator: 20}}, PROJECT_ID, CLIP_ID), null);
});

test('shared time-map frame sampling matches compileTimeMap for 0.1x, 0.5x, 2x, 10x, split, curve, reverse, and freeze', () => {
  // 0.1×, 0.5×, 2×, 10× constant forward speeds
  for (const [num, den] of [[1, 10], [1, 2], [2, 1], [10, 1]] as const) {
    const {timing, durationFrames} = makeConstantTiming({sourceInFrame: 30, sourceDurationFrames: 120, numerator: num, denominator: den});
    const clip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 60, durationFrames, sourceInFrame: 30, timing};
    const plan = compileClipTimeMapForPreview(clip, 30);
    assert.equal(plan.ok, true);
    const midOut = Math.floor(durationFrames / 2);
    const expected = timeMapSourceAtOutputFrame(plan.value, midOut);
    assert.equal(expected.ok, true);
    const sampled = sampleClipSourceAtTimelineFrame(clip, 30, 60 + midOut, plan.value);
    assert.equal(sampled.sourceFrame, expected.value.sourceFrame);
    assert.equal(sampled.sourceSeconds, expected.value.sourceFrame / 30);
    // Inverse mapping aligns back to the output frame within 1 frame.
    const back = outputFrameFromSourceSeconds(clip, 30, sampled.sourceSeconds, plan.value);
    assert.ok(Math.abs(back - (60 + midOut)) <= Math.ceil(den / num), `rate ${num}/${den}: ${back} vs ${60 + midOut}`);
  }

  // Split sub-window: second half of a 2× clip (outputWindow 30..60)
  const split = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 2, denominator: 1, outputFrom: 30, outputTo: 60});
  const splitClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 100, durationFrames: split.durationFrames, sourceInFrame: 0, timing: split.timing};
  assert.equal(sampleClipSourceAtTimelineFrame(splitClip, 30, 100).sourceFrame, 60);
  assert.equal(sampleClipSourceAtTimelineFrame(splitClip, 30, 115).sourceFrame, 90);
  assert.equal(outputFrameFromSourceSeconds(splitClip, 30, 90 / 30), 115);

  // Reverse clip: source frames strictly descend as output frames ascend.
  const rev = makeConstantTiming({sourceInFrame: 10, sourceDurationFrames: 90, numerator: 1, denominator: 1, direction: 'reverse'});
  const revClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: rev.durationFrames, sourceInFrame: 10, timing: rev.timing};
  const revStart = sampleClipSourceAtTimelineFrame(revClip, 30, 0).sourceFrame;
  const revMid = sampleClipSourceAtTimelineFrame(revClip, 30, 45).sourceFrame;
  const revEnd = sampleClipSourceAtTimelineFrame(revClip, 30, 89).sourceFrame;
  assert.ok(revStart > revMid && revMid > revEnd, `reverse frames must descend: ${revStart} > ${revMid} > ${revEnd}`);

  // Curve clip: matches direct compiled time-map at every sampled output frame.
  const curve = makeCurveTiming({presetId: 'slowMiddle', sourceInFrame: 0, sourceDurationFrames: 120});
  const curveClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 20, durationFrames: curve.durationFrames, sourceInFrame: 0, timing: curve.timing};
  const curvePlan = compileTimeMap((curve.timing as Extract<ClipTiming, {profile: 'timeline-speed-v1'}>).basis);
  assert.equal(curvePlan.ok, true);
  const direct = initialTimeMap(curvePlan.value);
  for (const offset of [0, 10, Math.floor(curve.durationFrames / 2), curve.durationFrames - 1]) {
    const directSample = timeMapSourceAtOutputFrame(direct, offset);
    assert.equal(directSample.ok, true);
    assert.equal(sampleClipSourceAtTimelineFrame(curveClip, 30, 20 + offset).sourceFrame, directSample.value.sourceFrame);
  }

  // Freeze clip: holds exact `sourceFrame` across the entire clip duration.
  const freezeClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 50, durationFrames: 60, sourceInFrame: 0, timing: makeFreezeTiming(77)};
  for (const frame of [50, 65, 80, 109, 110]) {
    const sample = sampleClipSourceAtTimelineFrame(freezeClip, 30, frame);
    assert.equal(sample.sourceFrame, 77);
    assert.equal(sample.sourceSeconds, 77 / 30);
  }
});

test('createSpeedPreviewMediaController polls every 2000ms while queued/running, stops on terminal states, and fences stale replies', async () => {
  const timers: {fn: () => void; ms: number; cleared: boolean}[] = [];
  const signals: AbortSignal[] = [];
  const replies: Array<(value: PreviewMedia) => void> = [];
  const observed: Array<PreviewMedia | null> = [];

  const controller = createSpeedPreviewMediaController({
    projectId: PROJECT_ID,
    clipId: CLIP_ID,
    intervalMs: SPEED_PREVIEW_POLL_INTERVAL_MS,
    read(signal) {
      signals.push(signal);
      return new Promise(resolve => {
        replies.push(resolve);
      });
    },
    onMedia(media) {
      observed.push(media);
    },
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const entry = {fn, ms, cleared: false};
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutFn: ((handle: ReturnType<typeof setTimeout>) => {
      (handle as unknown as {cleared: boolean}).cleared = true;
    }) as typeof clearTimeout,
  });

  controller.start();
  assert.equal(replies.length, 1);

  // Reply 1: queued -> schedules 2000ms poll.
  replies[0]!({mode: 'proxy', status: 'queued', taskId: TASK_ID});
  await Promise.resolve();
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.mode, 'proxy');
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 2000);

  // Fire timer -> poll 2 returns running 55% -> schedules next 2000ms poll.
  timers[0]!.fn();
  assert.equal(replies.length, 2);
  replies[1]!({mode: 'proxy', status: 'running', taskId: TASK_ID, progress: 55});
  await Promise.resolve();
  assert.equal(observed.length, 2);
  assert.equal(timers.length, 2);

  // Fire timer -> poll 3 returns ready -> stops polling (no new timer).
  timers[1]!.fn();
  assert.equal(replies.length, 3);
  replies[2]!({mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: 90});
  await Promise.resolve();
  assert.equal(observed.length, 3);
  assert.equal(timers.length, 2);

  // Refresh then immediately stop: aborts in-flight request and ignores stale reply.
  controller.refresh();
  assert.equal(replies.length, 4);
  controller.stop();
  assert.equal(signals[3]?.aborted, true);
  replies[3]!({mode: 'native', rate: {numerator: 2, denominator: 1}});
  await Promise.resolve();
  assert.equal(observed.length, 3);
  controller.dispose();
});

test('timeline thumbnails sample shared time-map frames (descending for reverse, single frame for freeze)', () => {
  const fast = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 2, denominator: 1});
  const fastSamples = computeClipThumbnailSamples(
    {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: fast.durationFrames, sourceInFrame: 0, timing: fast.timing},
    30,
    384,
  );
  assert.equal(fastSamples.length, 4);
  assert.ok(fastSamples[0]!.sourceFrame < fastSamples[3]!.sourceFrame);
  // Output offset near midpoint (~30f) maps to source frame ~60f at 2×.
  assert.equal(fastSamples[2]!.sourceFrame, fastSamples[2]!.outputOffsetFrames * 2);

  const rev = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 1, denominator: 1, direction: 'reverse'});
  const revSamples = computeClipThumbnailSamples(
    {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: rev.durationFrames, sourceInFrame: 0, timing: rev.timing},
    30,
    384,
  );
  assert.equal(revSamples.length, 4);
  assert.ok(revSamples[0]!.sourceFrame > revSamples[1]!.sourceFrame && revSamples[2]!.sourceFrame > revSamples[3]!.sourceFrame);

  const freezeSamples = computeClipThumbnailSamples(
    {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 10, durationFrames: 60, sourceInFrame: 0, timing: makeFreezeTiming(42)},
    30,
    384,
  );
  assert.equal(freezeSamples.length, 1);
  assert.equal(freezeSamples[0]?.sourceFrame, 42);
  assert.equal(freezeSamples[0]?.sourceSeconds, 42 / 30);
});

test('waveform window calculation and output-domain projection remap 0.5x, 2x, reverse, curve, freeze, and missing coverage', async () => {
  // Asymmetric source ramp: 0..1 across 120 frames (400 source bins at 100 bins/sec).
  const sourcePeaks = Array.from({length: 400}, (_, index) => Number((index / 399).toFixed(4)));

  // 2× fast-forward (60 output frames covering 0..120 source frames).
  const fast = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 2, denominator: 1});
  const fastClip = {id: 'c-fast', trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: fast.durationFrames, sourceInFrame: 0, timing: fast.timing};
  const fastWin = buildSpeedWaveformWindow(fastClip, 30, 2, 0, 60)!;
  assert.equal(fastWin.sourceStartFrame, 0);
  assert.equal(fastWin.sourceEndFrame, 120);
  assert.equal(fastWin.outputStartFrame, 0);
  assert.equal(fastWin.outputEndFrame, 60);
  const fastProjected = projectSpeedClipWaveformPeaks(
    fastClip,
    30,
    {outputStartFrame: 0, outputEndFrame: 60, points: 20},
    {peaks: sourcePeaks, sourceStartFrame: 0, sourceEndFrame: 120, decodedSampleFrames: 120 * 1600},
  )!;
  assert.equal(fastProjected.length, 20);
  assert.ok((fastProjected[0] ?? 0) < (fastProjected[19] ?? 0));
  assert.equal(fastProjected[19], 1);

  // Reverse (120 output frames): ramp must mirror (high on left, low on right!).
  const rev = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 1, denominator: 1, direction: 'reverse'});
  const revClip = {id: 'c-rev', trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: rev.durationFrames, sourceInFrame: 0, timing: rev.timing};
  const revProjected = projectSpeedClipWaveformPeaks(
    revClip,
    30,
    {outputStartFrame: 0, outputEndFrame: 120, points: 20},
    {peaks: sourcePeaks, sourceStartFrame: 0, sourceEndFrame: 120, decodedSampleFrames: 120 * 1600},
  )!;
  assert.equal(revProjected.length, 20);
  assert.ok((revProjected[0] ?? 0) > 0.9 && (revProjected[19] ?? 1) < 0.1, `reverse waveform should mirror: start=${revProjected[0]}, end=${revProjected[19]}`);

  // Missing decoder coverage (only first half decoded -> reverse clip has null gap on the LEFT, non-null on the RIGHT!).
  const partialRev = projectSpeedClipWaveformPeaks(
    revClip,
    30,
    {outputStartFrame: 0, outputEndFrame: 120, points: 20},
    {peaks: sourcePeaks, sourceStartFrame: 0, sourceEndFrame: 120, decodedSampleFrames: 60 * 1600},
  )!;
  assert.equal(partialRev[0], null);
  assert.notEqual(partialRev[19], null);

  // Freeze clip: silent flat 0 peaks, zero RPC calls through waveform controller!
  const freezeClip = {id: 'c-freeze', trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: 60, sourceInFrame: 0, timing: makeFreezeTiming(45)};
  const freezeWin = buildSpeedWaveformWindow(freezeClip, 30, 2, 0, 60)!;
  assert.equal(freezeWin.speedFreeze, true);
  const rpcCalls: string[] = [];
  const wfController = createWaveformController({
    api: async op => {
      rpcCalls.push(op);
      return {};
    },
  });
  const windows = visibleWaveformWindows({
    timeline: {projectId: PROJECT_ID, clips: [freezeClip]},
    assets: [VIDEO_ASSET],
    pixelsPerFrame: 2,
    leftFrame: 0,
    rightFrame: 60,
    visibleTrackIds: new Set(['v1']),
    windowForClip: (clip, ppf, l, r) => buildSpeedWaveformWindow(clip as never, 30, ppf, l, r),
  });
  assert.equal(windows.length, 1);
  wfController.setView({projectId: PROJECT_ID, active: true, windows});
  wfController.setEnabled(true);
  await Promise.resolve();
  assert.deepEqual(rpcCalls, [], 'freeze clip must never call asset.waveform.get');
  const freezeEntry = wfController.snapshot().entries.get(windows[0]!.key)!;
  assert.equal(freezeEntry.status, 'ready');
  assert.equal(freezeEntry.outputDomain, true);
  assert.ok(freezeEntry.peaks!.length > 0 && freezeEntry.peaks!.every(v => v === 0));
  assert.ok(waveformPath(freezeEntry.peaks).includes('v0'));

  // `projectSpeedClipWaveformEntry` marks projected speed entries `outputDomain: true` and leaves plain clips untouched.
  const plainEntry = {
    ...fastWin,
    status: 'ready' as const,
    phase: 'idle' as const,
    nextAt: 0,
    retry: false,
    peaks: sourcePeaks,
    decodedSampleFrames: 120 * 1600,
  };
  const projectedEntry = projectSpeedClipWaveformEntry(fastClip, 30, fastWin, plainEntry)!;
  assert.equal(projectedEntry.outputDomain, true);
  const untouched = projectSpeedClipWaveformEntry(
    {id: 'plain', trackId: 'v1', startFrame: 0, durationFrames: 60, sourceInFrame: 0},
    30,
    fastWin,
    plainEntry,
  );
  assert.equal(untouched, plainEntry);
});

test('buildClipSpeedPreviewBinding enforces capability gate (A7) and builds native, proxy-pending, proxy-ready, proxy-failed, and freeze bindings', () => {
  const fast = makeConstantTiming({sourceInFrame: 0, sourceDurationFrames: 120, numerator: 2, denominator: 1});
  const fastClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 30, durationFrames: fast.durationFrames, sourceInFrame: 0, timing: fast.timing};

  // A7: capabilities.speed !== true -> zero RPC eligibility and null preview binding!
  assert.equal(clipNeedsPreviewMediaRpc(GATE_OFF_TIMELINE, fastClip, VIDEO_ASSET), false);
  assert.equal(
    buildClipSpeedPreviewBinding({
      timeline: GATE_OFF_TIMELINE,
      clip: fastClip,
      asset: VIDEO_ASSET,
      sourceUrl: SOURCE_URL,
      fps: 30,
      media: {mode: 'native', rate: {numerator: 2, denominator: 1}},
      processingItems: [],
      t,
    }),
    null,
  );

  // Constant 2× forward: native rate = 2, muted video, no proxy overlay.
  assert.equal(clipNeedsPreviewMediaRpc(SPEED_TIMELINE, fastClip, VIDEO_ASSET), true);
  const nativeBinding = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: fastClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'native', rate: {numerator: 2, denominator: 1}},
    processingItems: [],
    t,
  })!;
  assert.equal(nativeBinding.mode, 'native');
  assert.equal(nativeBinding.playbackRate, 2);
  assert.equal(nativeBinding.muteVideo, true);
  assert.equal(nativeBinding.frameDrivenPlayback, false);
  assert.equal(nativeBinding.mediaUrl, SOURCE_URL);
  assert.equal(nativeBinding.overlay, null);
  assert.equal(nativeBinding.outputFrameToMediaSeconds(45), 30 / 30);
  assert.equal(nativeBinding.mediaSecondsToOutputFrame(30 / 30), 45);

  // Curve clip while proxy is running 42%: processing overlay + frame-driven shared-map seeking!
  const curve = makeCurveTiming({presetId: 'slowMiddle'});
  const curveClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 0, durationFrames: curve.durationFrames, sourceInFrame: 0, timing: curve.timing};
  const pendingBinding = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: curveClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'proxy', status: 'running', taskId: TASK_ID, progress: 42},
    processingItems: [],
    t,
  })!;
  assert.equal(pendingBinding.mode, 'proxy-pending');
  assert.equal(pendingBinding.frameDrivenPlayback, true);
  assert.equal(pendingBinding.muteVideo, true);
  assert.equal(pendingBinding.overlay?.kind, 'processing');
  assert.equal(pendingBinding.overlay?.kind === 'processing' ? pendingBinding.overlay.label : '', '处理中 42%');
  assert.equal(pendingBinding.overlay?.kind === 'processing' ? pendingBinding.overlay.percent : null, 42);

  // Curve clip once proxy is ready: verbatim URL, 1× playbackRate, muted video, no frame-driven loop!
  const readyBinding = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: curveClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: curve.durationFrames},
    processingItems: [],
    t,
  })!;
  assert.equal(readyBinding.mode, 'proxy-ready');
  assert.equal(readyBinding.mediaUrl, PROXY_URL);
  assert.equal(readyBinding.playbackRate, 1);
  assert.equal(readyBinding.muteVideo, true);
  assert.equal(readyBinding.frameDrivenPlayback, false);
  assert.equal(readyBinding.overlay, null);
  assert.equal(readyBinding.outputFrameToMediaSeconds(30), 1);
  assert.equal(readyBinding.mediaSecondsToOutputFrame(1), 30);

  // Proxy ready while optical interpolation is still running: keeps playing proxy AND shows optical status!
  const opticalRunning: SpeedProcessingItem = {
    taskId: TASK_ID,
    clipId: CLIP_ID,
    kind: 'optical',
    status: 'running',
    progress: 65,
  };
  const readyWithOptical = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: curveClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'proxy', status: 'ready', url: PROXY_URL, durationFrames: curve.durationFrames},
    processingItems: [opticalRunning],
    t,
  })!;
  assert.equal(readyWithOptical.mode, 'proxy-ready');
  assert.equal(readyWithOptical.overlay?.kind, 'processing');
  assert.match(readyWithOptical.overlay?.kind === 'processing' ? readyWithOptical.overlay.label : '', /补帧.*65%/);

  // Proxy failed with retryable reason vs INTERPOLATION_UNAVAILABLE (no Retry!).
  const failedRetryable = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: curveClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'proxy', status: 'failed', taskId: TASK_ID, reason: 'PROCESSING_FAILED'},
    processingItems: [],
    t,
  })!;
  assert.equal(failedRetryable.mode, 'proxy-failed');
  assert.equal(failedRetryable.overlay?.kind, 'failed');
  assert.equal(failedRetryable.overlay?.kind === 'failed' ? failedRetryable.overlay.canRetry : false, true);

  const failedNoRetry = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: curveClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: {mode: 'proxy', status: 'failed', taskId: TASK_ID, reason: 'INTERPOLATION_UNAVAILABLE'},
    processingItems: [],
    t,
  })!;
  assert.equal(failedNoRetry.overlay?.kind, 'failed');
  assert.equal(failedNoRetry.overlay?.kind === 'failed' ? failedNoRetry.overlay.canRetry : true, false);
  assert.equal(failedNoRetry.overlay?.kind === 'failed' ? failedNoRetry.overlay.message : '', '这段变速没法补帧');

  // Freeze clip: never calls `timeline.preview.media`, silent frame-driven hold at `sourceFrame`.
  const freezeClip = {id: CLIP_ID, trackId: 'v1', assetId: ASSET_ID, startFrame: 60, durationFrames: 60, sourceInFrame: 0, timing: makeFreezeTiming(90)};
  assert.equal(clipNeedsPreviewMediaRpc(SPEED_TIMELINE, freezeClip, VIDEO_ASSET), false);
  const freezeBinding = buildClipSpeedPreviewBinding({
    timeline: SPEED_TIMELINE,
    clip: freezeClip,
    asset: VIDEO_ASSET,
    sourceUrl: SOURCE_URL,
    fps: 30,
    media: null,
    processingItems: [],
    t,
  })!;
  assert.equal(freezeBinding.mode, 'freeze');
  assert.equal(freezeBinding.frameDrivenPlayback, true);
  assert.equal(freezeBinding.silent, true);
  assert.equal(freezeBinding.muteVideo, true);
  assert.equal(freezeBinding.outputFrameToMediaSeconds(60), 3);
  assert.equal(freezeBinding.outputFrameToMediaSeconds(119), 3);
});

test('Preview.tsx and Timeline.tsx keep zero new runtime imports and preserve eval-harness seams', () => {
  const previewSource = readFileSync(resolve(ROOT, 'apps/web/src/Preview.tsx'), 'utf8');
  const timelineSource = readFileSync(resolve(ROOT, 'apps/web/src/Timeline.tsx'), 'utf8');
  // Preview.tsx only imports type from speed-preview (never runtime import) and preserves guardPlayback verbatim.
  assert.doesNotMatch(previewSource, /^import\s+(?!type\b).*speed-preview/m);
  assert.match(previewSource, /^import type \{ClipSpeedPreviewBinding\} from '\.\/speed-preview\/speed-preview-model\.ts';/m);
  assert.match(previewSource, /function guardPlayback\(event: React\.SyntheticEvent<HTMLMediaElement>\): void \{\n    const element = event\.currentTarget;\n    if \(!isCurrentMedia\(element\)\) \{ element\.pause\(\); return; \}\n    onBeforePlay\?\.\(\);\n    audioPreview\?\.controller\.revoke\(\);\n    if \(!element\.seeking\) activeMedia\.current!\.programmaticSeek = null;\n    startTimelinePlayback\(element\);\n    captureObserver\.current\?\.\(\);\n  \}/);

  // Timeline.tsx adds zero runtime imports from speed-preview.
  assert.doesNotMatch(timelineSource, /speed-preview/);
});
