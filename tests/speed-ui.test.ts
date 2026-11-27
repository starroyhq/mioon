import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  TIMELINE_SPEED_PRESETS,
  TIMELINE_TIME_MAP_BASIS_PROFILE,
  TIMELINE_TIME_MAP_INTERPOLATION,
  compileTimeMap,
  initialTimeMap,
  instantiateSpeedPreset,
} from '../packages/contracts/src/timeline-time-map.ts';
import {
  clipTimingSchema,
  sequenceEditSpeedIntentSchema,
  speedProcessingItemSchema,
  speedProcessingListResponseSchema,
  speedSettingSchema,
} from '../packages/contracts/src/timeline-speed.ts';
import type {ClipTiming, SpeedProcessingItem, SpeedProcessingReason, SpeedSetting} from '../packages/contracts/src/timeline-speed.ts';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import {timelineSpeedMessages} from '../packages/i18n/src/catalogs/timeline-speed.ts';
import {
  DEFAULT_FREEZE_DURATION_FRAMES,
  SPEED_SLIDER_TICKS,
  addCurveControlPoint,
  buildClipSpeedIntent,
  buildFreezeFrameIntent,
  canFreezeClipAtPlayhead,
  clipNeedsSpeedProcessing,
  clipSupportsSpeed,
  defaultSpeedSetting,
  deleteCurveControlPoint,
  formatOriginalSeconds,
  formatSpeedRateInput,
  formatSpeedRateLabel,
  instantiatePresetForClip,
  isConstantKeepPitchRate,
  isDefaultSpeedSetting,
  isFreezeClip,
  logNormToRate,
  moveCurveControlPoint,
  normalizeSpeedSettingForSubmit,
  parseRateToRational,
  playheadSourceNormOnClip,
  previewLocalSpeedSetting,
  rateToLogNorm,
  resolveClipSpeedGeometry,
  resolvePitchShiftControl,
  sampleLogPchipCurve,
  settingFromClip,
  speedNeedsInterpolation,
  speedPreviewErrorKey,
  speedProcessingCanRetry,
  speedProcessingReasonKey,
  timelineSpeedEnabled,
  validateCurvePointsLocal,
} from '../apps/web/src/speed-ui/speed-model.ts';
import {
  buildSpeedProcessingOverviewItems,
  buildTimelineClipSpeedViews,
  speedProcessingActiveLabel,
  speedProcessingFailureSentence,
  speedProcessingItemTitle,
} from '../apps/web/src/speed-ui/speed-presentation.ts';
import {
  SPEED_PROCESSING_POLL_INTERVAL_MS,
  createSpeedProcessingPoller,
} from '../apps/web/src/speed-ui/use-speed-processing.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const tZh = ((key: string, params?: Record<string, string | number>) =>
  translate('zh-Hans', key as never, params as never)) as never;

function makeSpeedTiming(overrides: {
  rate?: {numerator: number; denominator: number};
  curve?: {presetId: string; points: {sourceFrame: number; rate: {numerator: number; denominator: number}}[]};
  direction?: 'forward' | 'reverse';
  pitchShift?: boolean;
  interpolation?: 'off' | 'blend' | 'optical';
  sourceStart?: number;
  sourceEnd?: number;
  outputFrom?: number;
  outputTo?: number;
} = {}): ClipTiming {
  const start = overrides.sourceStart ?? 0;
  const end = overrides.sourceEnd ?? 210;
  const speed = overrides.curve
    ? {kind: 'curve' as const, interpolation: TIMELINE_TIME_MAP_INTERPOLATION, presetId: overrides.curve.presetId, points: overrides.curve.points}
    : {kind: 'constant' as const, rate: overrides.rate ?? {numerator: 2, denominator: 1}};
  const basis = {
    profile: TIMELINE_TIME_MAP_BASIS_PROFILE,
    sourceFps: {fpsNumerator: 30, fpsDenominator: 1},
    outputFps: {fpsNumerator: 30, fpsDenominator: 1},
    sourceRange: {
      start: {kind: 'rational' as const, numerator: String(start), denominator: '1'},
      end: {kind: 'rational' as const, numerator: String(end), denominator: '1'},
    },
    speed,
  };
  const compiled = compileTimeMap(basis);
  assert.equal(compiled.ok, true);
  const fullDuration = compiled.ok ? compiled.value.durationFrames : 105;
  return {
    profile: 'timeline-speed-v1',
    basis,
    view: {
      loTime: {anchor: 'start', offsetOutputFrames: 0},
      hiTime: {anchor: 'end', offsetOutputFrames: 0},
      direction: overrides.direction ?? 'forward',
    },
    outputWindow: {fromFrame: overrides.outputFrom ?? 0, toFrame: overrides.outputTo ?? fullDuration},
    pitchShift: overrides.pitchShift ?? false,
    interpolation: overrides.interpolation ?? 'off',
  };
}

test('contract schemas validate speed timing, freeze timing, intents, and processing items strictly', () => {
  const speedTiming = makeSpeedTiming({rate: {numerator: 1, denominator: 2}, direction: 'reverse', interpolation: 'optical'});
  assert.equal(clipTimingSchema.safeParse(speedTiming).success, true);

  const freezeTiming: ClipTiming = {
    profile: 'timeline-freeze-v1',
    sourceFrame: 42,
    sourceVersionId: 'v-1',
    sourceSha256: 'a'.repeat(64),
  };
  assert.equal(clipTimingSchema.safeParse(freezeTiming).success, true);
  assert.equal(clipTimingSchema.safeParse({...freezeTiming, extra: 1}).success, false);

  const speedIntent = buildClipSpeedIntent('clip-1', {
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}},
    direction: 'reverse',
    pitchShift: true,
    interpolation: 'blend',
  });
  assert.equal(sequenceEditSpeedIntentSchema.safeParse(speedIntent).success, true);

  const freezeIntent = buildFreezeFrameIntent('clip-1', 120);
  assert.equal(sequenceEditSpeedIntentSchema.safeParse(freezeIntent).success, true);
  assert.equal(freezeIntent.operation.kind, 'freeze-frame');
  if (freezeIntent.operation.kind === 'freeze-frame') {
    assert.equal(freezeIntent.operation.durationFrames, DEFAULT_FREEZE_DURATION_FRAMES);
  }

  const processingList = {
    items: [
      {taskId: 't1', clipId: 'clip-1', kind: 'reverse', status: 'running', progress: 42},
      {taskId: 't2', clipId: 'clip-2', kind: 'optical', status: 'failed', reason: 'DISK_FULL'},
      {taskId: 't3', clipId: 'clip-3', kind: 'optical', status: 'failed', reason: 'INTERPOLATION_UNAVAILABLE'},
      {taskId: 't4', clipId: 'clip-4', kind: 'preview', status: 'running', progress: 65},
    ],
  };
  assert.equal(speedProcessingListResponseSchema.safeParse(processingList).success, true);
  assert.equal(speedProcessingItemSchema.safeParse({taskId: 't3', clipId: 'c', kind: 'optical', status: 'running', progress: 150}).success, false);
  assert.equal(speedSettingSchema.safeParse({speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}}, direction: 'forward', pitchShift: false, interpolation: 'off'}).success, true);
});

test('A1/F7: capabilities.speed !== true hides all timeline badges, overview tasks, and polling triggers', () => {
  assert.equal(timelineSpeedEnabled(null), false);
  assert.equal(timelineSpeedEnabled(undefined), false);
  assert.equal(timelineSpeedEnabled({}), false);
  assert.equal(timelineSpeedEnabled({capabilities: null}), false);
  assert.equal(timelineSpeedEnabled({capabilities: {}}), false);
  assert.equal(timelineSpeedEnabled({capabilities: {speed: false}}), false);
  assert.equal(timelineSpeedEnabled({capabilities: {speed: 1 as unknown as boolean}}), false);
  assert.equal(timelineSpeedEnabled({capabilities: {speed: true}}), true);

  const clip = {
    id: 'c1',
    name: '02 窗口剪影',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 105,
    sourceInFrame: 0,
    timing: makeSpeedTiming({rate: {numerator: 2, denominator: 1}, direction: 'reverse'}),
  };
  const procItems: SpeedProcessingItem[] = [
    {taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 42},
  ];

  // Disabled when capabilities.speed is absent or false: MUST return null / empty!
  assert.equal(buildTimelineClipSpeedViews({clips: [clip]}, procItems, tZh), null);
  assert.equal(buildTimelineClipSpeedViews({capabilities: {speed: false}, clips: [clip]}, procItems, tZh), null);
  assert.deepEqual(
    buildSpeedProcessingOverviewItems({
      enabled: false,
      items: procItems,
      clipNameFor: () => '02 窗口剪影',
      t: tZh,
      onCancel: () => {},
      onRetry: () => {},
    }),
    [],
  );

  // Enabled when capabilities.speed === true
  const views = buildTimelineClipSpeedViews({capabilities: {speed: true}, clips: [clip]}, procItems, tZh);
  assert.ok(views instanceof Map);
  const c1 = views!.get('c1');
  assert.equal(c1?.badgeText, ' · 2.0× · 倒放');
  assert.equal(c1?.processingActive, true);
  assert.equal(c1?.processingPercent, 42);
  assert.equal(c1?.processingLabel, '处理中 42%');
});

test('A2/F1: logarithmic slider mapping, reduced rational parsing, live duration, interpolation, and reset', () => {
  assert.deepEqual([...SPEED_SLIDER_TICKS], [0.1, 0.5, 1, 2, 5, 10]);
  assert.equal(rateToLogNorm(0.1), 0);
  assert.equal(rateToLogNorm(1), 0.5);
  assert.equal(rateToLogNorm(10), 1);
  assert.ok(rateToLogNorm(0.5) > 0 && rateToLogNorm(0.5) < 0.5);
  assert.ok(rateToLogNorm(2) > 0.5 && rateToLogNorm(2) < rateToLogNorm(5));

  for (const tick of SPEED_SLIDER_TICKS) {
    assert.equal(logNormToRate(rateToLogNorm(tick)), tick);
  }

  // Reduced rational conversion & out-of-range rejection
  assert.deepEqual(parseRateToRational('2.0'), {ok: true, rate: {numerator: 2, denominator: 1}, numeric: 2});
  assert.deepEqual(parseRateToRational('0.5×'), {ok: true, rate: {numerator: 1, denominator: 2}, numeric: 0.5});
  assert.deepEqual(parseRateToRational('1.25'), {ok: true, rate: {numerator: 5, denominator: 4}, numeric: 1.25});
  assert.deepEqual(parseRateToRational('0.1'), {ok: true, rate: {numerator: 1, denominator: 10}, numeric: 0.1});
  assert.deepEqual(parseRateToRational('10'), {ok: true, rate: {numerator: 10, denominator: 1}, numeric: 10});
  assert.equal(parseRateToRational('0.09').ok, false);
  assert.equal(parseRateToRational('10.01').ok, false);
  assert.equal(parseRateToRational('0').ok, false);
  assert.equal(parseRateToRational('-2').ok, false);
  assert.equal(parseRateToRational('fast').ok, false);

  // Original duration & live duration compilation via shared timeline-time-map.ts
  const clip2x = {
    id: 'c-2x',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 105,
    sourceInFrame: 0,
    timing: makeSpeedTiming({sourceStart: 0, sourceEnd: 210, rate: {numerator: 2, denominator: 1}}),
  };
  const geom = resolveClipSpeedGeometry(clip2x, 30);
  assert.equal(geom.originalFrames, 210);
  assert.equal(formatOriginalSeconds(geom.originalFrames, 30), '7.0');

  // Split sub-window [0, 50) of a 2.0x clip covers exactly 100 original source frames
  const splitLeft = {
    id: 'c-2x-left',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 50,
    sourceInFrame: 0,
    timing: makeSpeedTiming({sourceStart: 0, sourceEnd: 210, rate: {numerator: 2, denominator: 1}, outputFrom: 0, outputTo: 50}),
  };
  assert.equal(resolveClipSpeedGeometry(splitLeft, 30).originalFrames, 100);

  const previewHalf = previewLocalSpeedSetting(geom, {
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}},
    direction: 'forward',
    pitchShift: false,
    interpolation: 'blend',
  });
  assert.equal(previewHalf.ok, true);
  if (previewHalf.ok) assert.equal(previewHalf.durationFrames, 420);

  // Interpolation appears strictly below 1× and normalizes to 'off' when >= 1×
  assert.equal(speedNeedsInterpolation({kind: 'constant', rate: {numerator: 1, denominator: 2}}), true);
  assert.equal(speedNeedsInterpolation({kind: 'constant', rate: {numerator: 1, denominator: 1}}), false);
  assert.equal(speedNeedsInterpolation({kind: 'constant', rate: {numerator: 2, denominator: 1}}), false);
  const fastNormalized = normalizeSpeedSettingForSubmit({
    speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}},
    direction: 'forward',
    pitchShift: true,
    interpolation: 'optical',
  });
  assert.equal(fastNormalized.interpolation, 'off');

  // Reset restores 1×, forward, pitchShift=false, interpolation='off'
  const reset = defaultSpeedSetting();
  assert.equal(isDefaultSpeedSetting(reset), true);
  assert.deepEqual(reset, {
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
    direction: 'forward',
    pitchShift: false,
    interpolation: 'off',
  });

  // 11-27: pitchShift is only toggleable in constant 2×–4×; outside 2×–4× and all curves
  // display locked ON with distinct ⓘ hints while preserving the user's stored pitchShift.
  assert.equal(isConstantKeepPitchRate({numerator: 2, denominator: 1}), true);
  assert.equal(isConstantKeepPitchRate({numerator: 3, denominator: 1}), true);
  assert.equal(isConstantKeepPitchRate({numerator: 4, denominator: 1}), true);
  assert.equal(isConstantKeepPitchRate({numerator: 1, denominator: 1}), false);
  assert.equal(isConstantKeepPitchRate({numerator: 1, denominator: 2}), false);
  assert.equal(isConstantKeepPitchRate({numerator: 199, denominator: 100}), false);
  assert.equal(isConstantKeepPitchRate({numerator: 401, denominator: 100}), false);
  assert.equal(isConstantKeepPitchRate({numerator: 5, denominator: 1}), false);

  const userOffAt2x: SpeedSetting = {
    speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}},
    direction: 'forward',
    pitchShift: false,
    interpolation: 'off',
  };
  assert.deepEqual(resolvePitchShiftControl('constant', userOffAt2x), {
    locked: false,
    checked: false,
    lockReason: null,
    tooltipKey: null,
  });

  // Moving to 0.5× locks UI ON with constant hint, while stored pitchShift stays false
  const movedToHalf: SpeedSetting = {...userOffAt2x, speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}}};
  assert.deepEqual(resolvePitchShiftControl('constant', movedToHalf), {
    locked: true,
    checked: true,
    lockReason: 'constant-range',
    tooltipKey: 'speed.pitchShift.constantOnlyHint',
  });
  assert.equal(translate('zh-Hans', 'speed.pitchShift.constantOnlyHint'), '这个倍速只能变调');
  const submittedHalf = buildClipSpeedIntent('c1', movedToHalf);
  assert.equal(submittedHalf.operation.kind === 'clip-speed' && submittedHalf.operation.setting.pitchShift, false);

  // Even a curve whose points stay inside 2×–4× locks ON with curve hint
  const curveIn2to4: SpeedSetting = {
    speed: {
      kind: 'curve',
      interpolation: TIMELINE_TIME_MAP_INTERPOLATION,
      presetId: 'custom',
      points: [
        {sourceFrame: 0, rate: {numerator: 2, denominator: 1}},
        {sourceFrame: 210, rate: {numerator: 4, denominator: 1}},
      ],
    },
    direction: 'forward',
    pitchShift: false,
    interpolation: 'off',
  };
  assert.deepEqual(resolvePitchShiftControl('curve', curveIn2to4), {
    locked: true,
    checked: true,
    lockReason: 'curve',
    tooltipKey: 'speed.pitchShift.curveOnlyHint',
  });
  assert.equal(translate('zh-Hans', 'speed.pitchShift.curveOnlyHint'), '曲线变速只能变调');

  // Returning to 2×–4× constant restores user's original choice (both false and true)
  const backTo3x: SpeedSetting = {...movedToHalf, speed: {kind: 'constant', rate: {numerator: 3, denominator: 1}}};
  assert.equal(resolvePitchShiftControl('constant', backTo3x).checked, false);
  assert.equal(resolvePitchShiftControl('constant', {...backTo3x, pitchShift: true}).checked, true);
});

test('A3/F2: all 8 curve presets match shared instantiateSpeedPreset and enforce curve point constraints', () => {
  assert.equal(TIMELINE_SPEED_PRESETS.length, 8);
  for (const preset of TIMELINE_SPEED_PRESETS) {
    const shared = instantiateSpeedPreset(preset.id, 0, 210);
    const local = instantiatePresetForClip(preset.id, 0, 210);
    assert.equal(shared.ok, true, preset.id);
    assert.equal(local.ok, true, preset.id);
    if (shared.ok && local.ok) {
      assert.deepEqual(local.speed, shared.value, preset.id);
    }
  }

  // Slow middle curve dips below 1× -> interpolation dropdown visible
  const slowMid = instantiatePresetForClip('slowMiddle', 0, 210);
  assert.equal(slowMid.ok, true);
  if (!slowMid.ok || slowMid.speed.kind !== 'curve') throw new Error('expected curve');
  assert.equal(speedNeedsInterpolation(slowMid.speed), true);

  // Flash in stays >= 1× -> interpolation dropdown hidden
  const flashIn = instantiatePresetForClip('flashIn', 0, 210);
  assert.equal(flashIn.ok, true);
  if (!flashIn.ok || flashIn.speed.kind !== 'curve') throw new Error('expected curve');
  assert.equal(speedNeedsInterpolation(flashIn.speed), false);

  // Smooth log-PCHIP sampler stays strictly within [0.1, 10]
  const sampled = sampleLogPchipCurve(
    slowMid.speed.points.map(p => ({x: p.sourceFrame, rate: p.rate.numerator / p.rate.denominator})),
    40,
  );
  assert.equal(sampled.length, 41);
  assert.ok(sampled.every(s => s.rate >= 0.1 && s.rate <= 10 && s.yNorm >= 0 && s.yNorm <= 1));

  // Endpoint deletion is rejected locally
  assert.deepEqual(deleteCurveControlPoint(slowMid.speed.points, 0), {ok: false, error: 'ENDPOINT_FIXED'});
  assert.deepEqual(deleteCurveControlPoint(slowMid.speed.points, 2), {ok: false, error: 'ENDPOINT_FIXED'});
  // Interior deletion succeeds
  const deleted = deleteCurveControlPoint(slowMid.speed.points, 1);
  assert.equal(deleted.ok, true);
  if (deleted.ok) assert.equal(deleted.points.length, 2);

  // Moving endpoint locks sourceFrame and updates only rate
  const movedEnd = moveCurveControlPoint(slowMid.speed.points, 0, 50, 3.0);
  assert.equal(movedEnd.ok, true);
  if (movedEnd.ok) {
    assert.equal(movedEnd.points[0]!.sourceFrame, 0);
    assert.deepEqual(movedEnd.points[0]!.rate, {numerator: 3, denominator: 1});
  }

  // Moving interior point clamps strictly between neighbors
  const movedMid = moveCurveControlPoint(slowMid.speed.points, 1, 999, 0.5);
  assert.equal(movedMid.ok, true);
  if (movedMid.ok) {
    assert.equal(movedMid.points[1]!.sourceFrame, 209);
  }

  // Moving to out-of-range rate rejected locally
  assert.deepEqual(moveCurveControlPoint(slowMid.speed.points, 1, 100, 12), {ok: false, error: 'INVALID_RATE'});

  // Adding up to 32 points works; 33rd point is rejected locally with POINT_LIMIT
  let pts = slowMid.speed.points;
  for (let frame = 10; pts.length < 32; frame += 5) {
    const added = addCurveControlPoint(pts, frame, 1.5);
    if (added.ok) pts = added.points;
  }
  assert.equal(pts.length, 32);
  assert.equal(validateCurvePointsLocal(pts, 0, 210), null);
  assert.deepEqual(addCurveControlPoint(pts, 195, 1.5), {ok: false, error: 'POINT_LIMIT'});

  // Playhead mapping respects forward & reverse direction
  const clip = {id: 'c1', trackId: 'v1', startFrame: 60, durationFrames: 105, sourceInFrame: 0};
  const geom = resolveClipSpeedGeometry({...clip, timing: makeSpeedTiming({sourceStart: 0, sourceEnd: 210, rate: {numerator: 2, denominator: 1}})}, 30);
  const fwd = previewLocalSpeedSetting(geom, {speed: slowMid.speed, direction: 'forward', pitchShift: false, interpolation: 'off'});
  const rev = previewLocalSpeedSetting(geom, {speed: slowMid.speed, direction: 'reverse', pitchShift: false, interpolation: 'off'});
  assert.equal(fwd.ok && rev.ok, true);
  if (fwd.ok && rev.ok) {
    const fwdStart = playheadSourceNormOnClip(clip, geom, fwd.plan, 60);
    const revStart = playheadSourceNormOnClip(clip, geom, rev.plan, 60);
    assert.ok(fwdStart !== null && revStart !== null);
    assert.ok(fwdStart! < 0.2, `forward start should be near left: ${fwdStart}`);
    assert.ok(revStart! > 0.8, `reverse start should be near right: ${revStart}`);
    assert.equal(playheadSourceNormOnClip(clip, geom, fwd.plan, 10), null);
  }
});

test('A5/A6/F4/F5: speed label formatting, freeze clip classification, playhead gating, and 6-item context menu order', () => {
  assert.equal(formatSpeedRateLabel({numerator: 2, denominator: 1}), '2.0×');
  assert.equal(formatSpeedRateLabel({numerator: 1, denominator: 2}), '0.5×');
  assert.equal(formatSpeedRateLabel({numerator: 5, denominator: 4}), '1.25×');
  assert.equal(formatSpeedRateLabel({numerator: 1, denominator: 10}), '0.1×');
  assert.equal(formatSpeedRateLabel({numerator: 10, denominator: 1}), '10.0×');
  assert.equal(formatSpeedRateLabel({numerator: 1, denominator: 3}), '0.33×');
  assert.equal(formatSpeedRateInput({numerator: 2, denominator: 1}), '2.0');
  assert.equal(formatSpeedRateInput({numerator: 5, denominator: 4}), '1.25');

  const videoClip = {id: 'v1', trackId: 't1', startFrame: 100, durationFrames: 90, sourceInFrame: 0, sourceState: 'ready'};
  const freezeClip = {
    ...videoClip,
    id: 'f1',
    timing: {profile: 'timeline-freeze-v1' as const, sourceFrame: 30, sourceVersionId: null, sourceSha256: 'b'.repeat(64)},
  };
  const videoAsset = {mimeType: 'video/mp4'};
  const imageAsset = {mimeType: 'image/png'};
  const audioAsset = {mimeType: 'audio/wav'};

  assert.equal(isFreezeClip(freezeClip), true);
  assert.equal(clipSupportsSpeed(videoClip, videoAsset), true);
  assert.equal(clipSupportsSpeed(videoClip, audioAsset), true);
  assert.equal(clipSupportsSpeed(freezeClip, videoAsset), false);
  assert.equal(clipSupportsSpeed(videoClip, imageAsset), false);
  assert.equal(clipSupportsSpeed({...videoClip, sourceState: 'placeholder'}, videoAsset), false);

  // Freeze playhead boundary check: [startFrame, startFrame + durationFrames)
  assert.equal(canFreezeClipAtPlayhead(videoClip, videoAsset, 'video', 99), false);
  assert.equal(canFreezeClipAtPlayhead(videoClip, videoAsset, 'video', 100), true);
  assert.equal(canFreezeClipAtPlayhead(videoClip, videoAsset, 'video', 189), true);
  assert.equal(canFreezeClipAtPlayhead(videoClip, videoAsset, 'video', 190), false);
  assert.equal(canFreezeClipAtPlayhead(freezeClip, videoAsset, 'video', 120), false);
  assert.equal(canFreezeClipAtPlayhead(videoClip, audioAsset, 'audio', 120), false);

  // Context menu preserves exact 22-03 6-item order: 变速… -> 倒放 -> 定格 -> 分隔线 -> 切开 -> 复制成新镜头
  const menuSrc = read('apps/web/src/TimelineClipContextMenu.tsx');
  const order = [
    menuSrc.indexOf("'clip-menu-speed'"),
    menuSrc.indexOf("'clip-menu-reverse'"),
    menuSrc.indexOf("'clip-menu-freeze'"),
    menuSrc.indexOf('className="timeline-clip-menu-separator"'),
    menuSrc.indexOf("'clip-menu-split'"),
    menuSrc.indexOf("'clip-menu-copy-new-shot'"),
  ];
  assert.ok(order.every(pos => pos > 0), `missing menu items: ${order}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i]! > order[i - 1]!, `context menu item order mismatch at index ${i}`);
  }

  // Freeze clip renders snowflake + title 「定格」 when capabilities.speed === true
  const views = buildTimelineClipSpeedViews({capabilities: {speed: true}, clips: [freezeClip]}, [], tZh);
  assert.equal(views?.get('f1')?.isFreeze, true);
  assert.equal(views?.get('f1')?.freezeTitle, '定格');
});

test('A7/F6: processing poller polls every 2s while active, stops once ready/failed, and fences stale responses', async () => {
  assert.equal(SPEED_PROCESSING_POLL_INTERVAL_MS, 2000);
  const clipRev = {
    id: 'c1', trackId: 'v1', startFrame: 0, durationFrames: 120, sourceInFrame: 0,
    timing: makeSpeedTiming({direction: 'reverse'}),
  };
  const clipPlain = {
    id: 'c2', trackId: 'v1', startFrame: 120, durationFrames: 60, sourceInFrame: 0,
    timing: makeSpeedTiming({direction: 'forward', interpolation: 'off'}),
  };
  const clipCurve = {
    id: 'c3', trackId: 'v1', startFrame: 180, durationFrames: 120, sourceInFrame: 0,
    timing: makeSpeedTiming({
      curve: {
        presetId: 'slowMiddle',
        points: [
          {sourceFrame: 0, rate: {numerator: 2, denominator: 1}},
          {sourceFrame: 105, rate: {numerator: 1, denominator: 4}},
          {sourceFrame: 210, rate: {numerator: 2, denominator: 1}},
        ],
      },
      direction: 'forward',
      interpolation: 'off',
    }),
  };
  assert.equal(clipNeedsSpeedProcessing(clipRev), true);
  assert.equal(clipNeedsSpeedProcessing(clipPlain), false);
  assert.equal(clipNeedsSpeedProcessing(clipCurve), true);

  // 11-27: INTERPOLATION_UNAVAILABLE hides Retry, UNSUPPORTED_FORMAT uses interpolation copy, preview kind renders cleanly
  const unavailItem: SpeedProcessingItem = {
    taskId: 't-unavail', clipId: 'c3', kind: 'optical', status: 'failed', reason: 'INTERPOLATION_UNAVAILABLE',
  };
  const unsupportedItem: SpeedProcessingItem = {
    taskId: 't-fmt', clipId: 'c3', kind: 'optical', status: 'failed', reason: 'UNSUPPORTED_FORMAT',
  };
  const previewItem: SpeedProcessingItem = {
    taskId: 't-prev', clipId: 'c3', kind: 'preview', status: 'running', progress: 65,
  };
  assert.equal(speedProcessingCanRetry(unavailItem), false);
  assert.equal(speedProcessingCanRetry(unsupportedItem), true);
  assert.equal(speedProcessingFailureSentence(unavailItem, tZh), '这段变速没法补帧');
  assert.equal(speedProcessingFailureSentence(unsupportedItem, tZh), '这个素材的格式没法补帧');
  assert.equal(speedProcessingActiveLabel(previewItem, tZh), '预览处理中');
  assert.equal(speedProcessingItemTitle(previewItem, '03 霓虹街头', tZh), '预览处理 · 03 霓虹街头');

  const overview = buildSpeedProcessingOverviewItems({
    enabled: true,
    items: [unavailItem, unsupportedItem, previewItem],
    clipNameFor: () => '03 霓虹街头',
    t: tZh,
    onCancel: () => {},
    onRetry: () => {},
  });
  assert.equal(overview.find(item => item.id === 'speed:t-unavail')?.onRetry, undefined);
  assert.equal(overview.find(item => item.id === 'speed:t-unavail')?.detail, '这段变速没法补帧');
  assert.equal(typeof overview.find(item => item.id === 'speed:t-fmt')?.onRetry, 'function');
  assert.equal(overview.find(item => item.id === 'speed:t-fmt')?.detail, '这个素材的格式没法补帧');
  assert.equal(overview.find(item => item.id === 'speed:t-prev')?.label, '预览处理 · 03 霓虹街头');
  assert.equal(overview.find(item => item.id === 'speed:t-prev')?.progress, 65);

  let nextId = 1;
  const timers = new Map<number, {fn: () => void; ms: number}>();
  const delays: number[] = [];
  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = nextId++;
    delays.push(ms);
    timers.set(id, {fn, ms});
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as unknown as typeof clearTimeout;

  const responses: Array<{signal: AbortSignal; resolve: (val: unknown) => void}> = [];
  const snapshots: Array<readonly SpeedProcessingItem[]> = [];

  const poller = createSpeedProcessingPoller({
    projectId: 'p1',
    setTimeoutFn,
    clearTimeoutFn,
    list: signal => new Promise(resolve => { responses.push({signal, resolve}); }),
    onItems: items => snapshots.push(items),
  });

  poller.start();
  assert.equal(responses.length, 1);
  // First response: running 42% -> schedules next poll in 2000ms
  responses[0]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 42}]});
  await Promise.resolve();
  assert.equal(snapshots.length, 1);
  assert.deepEqual(delays, [2000]);
  assert.equal(timers.size, 1);

  // Fire 2s timer -> second request returns failed -> NO MORE TIMERS!
  const [tid, timer] = [...timers.entries()][0]!;
  timers.delete(tid);
  timer.fn();
  assert.equal(responses.length, 2);
  responses[1]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'failed', reason: 'DISK_FULL'}]});
  await Promise.resolve();
  assert.equal(snapshots.length, 2);
  assert.equal(timers.size, 0, 'polling must stop automatically when no task is queued or running');

  // Refresh starts a request; dispose aborts it and discards late response
  poller.refresh();
  assert.equal(responses.length, 3);
  poller.dispose();
  assert.equal(responses[2]!.signal.aborted, true);
  responses[2]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 99}]});
  await Promise.resolve();
  assert.equal(snapshots.length, 2);
});

test('A4/A8/F8: all preview failure codes, processing reasons, and catalog keys are complete across 4 locales', () => {
  const previewCodes = [
    'SPEED_SOURCE_NOT_READY',
    'SPEED_NOT_SUPPORTED',
    'SEQUENCE_EDIT_ANCHOR_CONFLICT',
    'INVALID_RATE',
    'POINT_LIMIT',
    'OUTPUT_FRAME_LIMIT',
    'SOURCE_FRAME_LIMIT',
  ];
  const reasons: SpeedProcessingReason[] = [
    'SOURCE_UNAVAILABLE',
    'DISK_FULL',
    'CACHE_LIMIT',
    'UNSUPPORTED_FORMAT',
    'INTERPOLATION_UNAVAILABLE',
    'PROCESSING_FAILED',
  ];

  for (const locale of LOCALES) {
    for (const code of previewCodes) {
      const text = translate(locale, speedPreviewErrorKey(code) as never);
      assert.ok(text.trim().length > 0, `${locale}/${code}`);
    }
    for (const reason of reasons) {
      const text = translate(locale, speedProcessingReasonKey(reason) as never);
      assert.ok(text.trim().length > 0, `${locale}/${reason}`);
    }
    for (const kind of ['reverse', 'optical', 'preview'] as const) {
      const tLoc = ((key: string, params?: Record<string, string | number>) => translate(locale, key as never, params as never)) as never;
      assert.ok(speedProcessingActiveLabel({taskId: 't1', clipId: 'c1', kind, status: 'running', progress: 50}, tLoc).trim().length > 0);
      assert.ok(speedProcessingItemTitle({taskId: 't1', clipId: 'c1', kind, status: 'running', progress: 50}, 'Shot 1', tLoc).trim().length > 0);
      assert.ok(speedProcessingFailureSentence({taskId: 't1', clipId: 'c1', kind, status: 'failed', reason: 'DISK_FULL'}, tLoc).trim().length > 0);
    }
  }

  for (const [key, entry] of Object.entries(timelineSpeedMessages)) {
    assert.deepEqual(Object.keys(entry).sort(), [...LOCALES].sort(), key);
  }

  // Setting extraction round-trip preserves saved timing
  const timing = makeSpeedTiming({
    rate: {numerator: 1, denominator: 2},
    direction: 'reverse',
    pitchShift: true,
    interpolation: 'optical',
  });
  const extracted: SpeedSetting = settingFromClip({id: 'c1', trackId: 'v1', startFrame: 0, durationFrames: 420, timing});
  assert.deepEqual(extracted, {
    speed: {kind: 'constant', rate: {numerator: 1, denominator: 2}},
    direction: 'reverse',
    pitchShift: true,
    interpolation: 'optical',
  });
});
