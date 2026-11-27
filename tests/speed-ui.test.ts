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
import {Format5EditSession} from '../apps/web/src/edit-ui/session.ts';
import {format5DialogueConflictPresentation} from '../apps/web/src/edit-ui/format5-panel-edits.ts';
import {
  DEFAULT_FREEZE_DURATION_FRAMES,
  SPEED_SLIDER_TICKS,
  addCurveControlPoint,
  buildClipSpeedIntent,
  buildFreezeFrameIntent,
  canFreezeClipAtPlayhead,
  clientPointToCurveSvg,
  clipNeedsSpeedProcessing,
  clipSupportsSpeed,
  curveDragTargetCoords,
  curvePointsEqual,
  curveSvgPointToCoords,
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
  nudgeCurveControlPointFrame,
  nudgeCurveControlPointRate,
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
  speedSettingsEqual,
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
  SPEED_PROCESSING_MAX_CONSECUTIVE_FAILURES,
  SPEED_PROCESSING_POLL_INTERVAL_MS,
  SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS,
  createScopedSpeedProcessingController,
  createSpeedProcessingPoller,
  isRetryableProcessingPollError,
  speedProcessingBackoffDelayMs,
} from '../apps/web/src/speed-ui/use-speed-processing.ts';
import type {SpeedProcessingPollState} from '../apps/web/src/speed-ui/use-speed-processing.ts';
import {ApiError} from '../apps/web/src/api.ts';
import {lenientFunction} from './helpers/eval-source.ts';
import {timelineSplitState} from '../apps/web/src/timeline-split.ts';

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

test('A1: right-click and Shift+F10 intentionally preserve playhead across formats 3/4/5 regardless of speed switch', async () => {
  const appSrc = read('apps/web/src/App.tsx');
  const timelineSrc = read('apps/web/src/Timeline.tsx');
  const extractSection = (start: string, end: string): string => {
    const first = appSrc.indexOf(start);
    const last = appSrc.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Missing App section: ${start}`);
    assert.equal(appSrc.indexOf(start, first + start.length), -1, `Ambiguous App section: ${start}`);
    return appSrc.slice(first, last);
  };

  // Timeline routes both contextmenu and Shift+F10 / ContextMenu / Apps to onClipContextMenu without resetting playhead.
  assert.ok(timelineSrc.includes("event.shiftKey && event.key === 'F10'"));
  assert.ok(timelineSrc.includes('onClipContextMenu?.(clip.id, {x: e.clientX, y: e.clientY})'));
  assert.ok(appSrc.includes('onClipContextMenu={openClipContextMenu}'));

  const openMenuSource = extractSection('  function openClipContextMenu(', '  /** One bounded retry');
  const selectClipSource = extractSection('  async function selectClip(', '  async function addTimelineAsset(');

  for (const formatVersion of [3, 4, 5] as const) {
    for (const speedSwitch of [false, true] as const) {
      const clipId = `clip-fmt-${formatVersion}-${speedSwitch ? 'on' : 'off'}`;
      const projectId = `proj-${formatVersion}`;
      const timeline = {
        id: `tl-${formatVersion}`,
        projectId,
        revision: 1,
        fps: 30,
        capabilities: speedSwitch ? {speed: true} : {speed: false},
        tracks: [{id: 'v1', kind: 'video', orderIndex: 0}],
        clips: [{id: clipId, trackId: 'v1', assetId: 'a1', startFrame: 0, durationFrames: 120, sourceInFrame: 0}],
      };
      const viewEditing: Record<string, unknown> = {
        selectedClipId: null,
        quickAssetId: null,
        playhead: 20,
        previewKind: 'timeline',
      };
      let menuState: {clipId: string; x: number; y: number} | null = null;
      const env = {
        clipDraftRef: {current: null},
        context: () => ({projectId}),
        panelIntent: {current: 1},
        isCurrent: () => true,
        dataRef: {current: {projectFormatVersion: formatVersion, timeline}},
        selectedClipId: null as string | null,
        quickAssetId: null as string | null,
        workspaceMode: 'editing',
        subtitlesRef: {current: null},
        guardNavigation: async () => true,
        msg: (key: string) => key,
        setPropertiesPage: () => {},
        navigationEpoch: {current: 0},
        setNavigationPresentation: () => {},
        leaveReferencePage: () => {},
        updateView: (area: string, patch: unknown) => {
          if (area === 'editing' && patch && typeof patch === 'object') {
            Object.assign(viewEditing, patch);
          }
        },
        setMobilePanel: () => {},
        setClipContextMenu: (next: {clipId: string; x: number; y: number} | null) => { menuState = next; },
      };
      const api = lenientFunction(
        ...Object.keys(env),
        `${openMenuSource}\n${selectClipSource}\nreturn { openClipContextMenu, selectClip };`,
      )(...Object.values(env)) as {
        openClipContextMenu: (id: string, point: {x: number; y: number}) => void;
        selectClip: (id: string, showPreview?: boolean, options?: {preservePlayhead?: boolean}) => Promise<void>;
      };

      // Right-click / Shift+F10 keeps playhead at frame 20 instead of resetting to frame 0.
      api.openClipContextMenu(clipId, {x: 120, y: 80});
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(viewEditing.selectedClipId, clipId, `fmt=${formatVersion} speed=${speedSwitch}`);
      assert.equal(viewEditing.playhead, 20, `context menu must preserve playhead for fmt=${formatVersion} speed=${speedSwitch}`);
      assert.equal(viewEditing.previewKind, 'source');
      assert.deepEqual(menuState, {clipId, x: 120, y: 80});

      // Because playhead remains at 20 inside [0, 120), split stays enabled at frame 20.
      const split = timelineSplitState({
        projectId,
        timeline: timeline as never,
        history: {
          projectId,
          timelineId: timeline.id,
          revision: timeline.revision,
          cursor: 0,
          length: 0,
          canUndo: false,
          canRedo: false,
          undoEntry: null,
          redoEntry: null,
        },
        busy: false,
        pending: false,
        dirty: false,
        online: true,
        selectedClipId: clipId,
        playhead: viewEditing.playhead as number,
        mode: 'editing',
      });
      assert.equal(split.canSplit, true, `split must stay enabled at frame 20 for fmt=${formatVersion} speed=${speedSwitch}`);

      // Contrast: normal left-click selectClip still jumps playhead to clip.startFrame (0).
      await api.selectClip(clipId);
      assert.equal(viewEditing.playhead, 0, `direct selectClip still jumps to startFrame for fmt=${formatVersion} speed=${speedSwitch}`);
    }
  }
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

test('A3/F2: curve & speed bounds clamp silently on keys with zero commit, manual out-of-range keeps hint, and vertical drag keeps sourceFrame exact', () => {
  // 10× endpoint + ArrowUp and 0.1× endpoint/interior + ArrowDown clamp silently (`changed: false`, zero error, zero commit).
  const atBounds = [
    {sourceFrame: 0, rate: {numerator: 10, denominator: 1}},
    {sourceFrame: 60, rate: {numerator: 1, denominator: 10}},
    {sourceFrame: 120, rate: {numerator: 1, denominator: 1}},
  ];
  for (const [idx, dir, coarse] of [
    [0, 'up', false],
    [0, 'up', true],
    [1, 'down', false],
    [1, 'down', true],
  ] as const) {
    const res = nudgeCurveControlPointRate(atBounds, idx, dir, coarse);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.changed, false);
      assert.equal(curvePointsEqual(res.points, atBounds), true);
    }
  }

  // Moving away from 10× / 0.1× still succeeds, and reaching 10× then pressing up again clamps silently.
  const downFrom10 = nudgeCurveControlPointRate(atBounds, 0, 'down', false);
  assert.equal(downFrom10.ok, true);
  if (downFrom10.ok) {
    assert.equal(downFrom10.changed, true);
    assert.ok(downFrom10.points[0]!.rate.numerator / downFrom10.points[0]!.rate.denominator < 10);
    const backTo10 = nudgeCurveControlPointRate(downFrom10.points, 0, 'up', true);
    assert.equal(backTo10.ok, true);
    if (backTo10.ok) {
      assert.equal(backTo10.changed, true);
      assert.deepEqual(backTo10.points[0]!.rate, {numerator: 10, denominator: 1});
      const atCeilingAgain = nudgeCurveControlPointRate(backTo10.points, 0, 'up', false);
      assert.equal(atCeilingAgain.ok, true);
      if (atCeilingAgain.ok) assert.equal(atCeilingAgain.changed, false);
    }
  }

  // Constant slider at 10× or 0.1× stays equal to savedSetting so bound keys skip commit silently,
  // while manual text input outside 0.1×–10× still rejects with inline range hint.
  const at10xSetting: SpeedSetting = {
    speed: {kind: 'constant', rate: {numerator: 10, denominator: 1}},
    direction: 'forward',
    pitchShift: false,
    interpolation: 'off',
  };
  assert.equal(speedSettingsEqual(at10xSetting, {...at10xSetting}), true);
  assert.equal(speedSettingsEqual(at10xSetting, {...at10xSetting, speed: {kind: 'constant', rate: {numerator: 9, denominator: 1}}}), false);
  assert.deepEqual(parseRateToRational('0.09'), {ok: false, code: 'INVALID_RATE'});
  assert.deepEqual(parseRateToRational('10.01'), {ok: false, code: 'INVALID_RATE'});
  assert.equal(translate('zh-Hans', 'speed.validation.rateRange'), '倍速须在 0.1× 到 10× 之间。');

  // Horizontal nudges on fixed endpoints or neighbor-clamped interior points report changed: false (no NOOP commit).
  const leftEnd = nudgeCurveControlPointFrame(atBounds, 0, 'right', false);
  assert.equal(leftEnd.ok, true);
  if (leftEnd.ok) assert.equal(leftEnd.changed, false);
  const tight = [
    {sourceFrame: 0, rate: {numerator: 1, denominator: 1}},
    {sourceFrame: 1, rate: {numerator: 2, denominator: 1}},
    {sourceFrame: 120, rate: {numerator: 1, denominator: 1}},
  ];
  const clampedLeft = nudgeCurveControlPointFrame(tight, 1, 'left', false);
  assert.equal(clampedLeft.ok, true);
  if (clampedLeft.ok) assert.equal(clampedLeft.changed, false);

  // Vertical drag on flashIn [0, 120] interior point at frame 30 inside 292×132 letterboxed SVG (1440×900 viewport):
  const flashIn120 = instantiatePresetForClip('flashIn', 0, 120);
  assert.equal(flashIn120.ok, true);
  if (!flashIn120.ok || flashIn120.speed.kind !== 'curve') throw new Error('expected flashIn curve');
  const interior = flashIn120.speed.points[1]!;
  assert.equal(interior.sourceFrame, 30);

  const rect = {left: 1128, top: 178.84375, width: 292, height: 132};
  const ctm = {a: 1.03125, b: 0, c: 0, d: 1.03125, e: 1137.875, f: 178.84375};

  for (const activeCtm of [ctm, null] as const) {
    // Center click at frame 30 (clientX=1229.140625), pure vertical drag 15 CSS px upward.
    const startSvg = clientPointToCurveSvg(1229.140625, 244.84375, rect, activeCtm);
    const endSvg = clientPointToCurveSvg(1229.140625, 229.84375, rect, activeCtm);
    assert.ok(startSvg && endSvg);
    assert.equal(curveSvgPointToCoords(startSvg!, 0, 120).frame, 30);
    const dragged = curveDragTargetCoords(interior, startSvg!, endSvg!, 0, 120);
    assert.equal(dragged.frame, 30, 'vertical drag must keep sourceFrame at 30 instead of drifting to 32');
    assert.ok(dragged.rate > 1, 'upward drag must increase rate');
    const moved = moveCurveControlPoint(flashIn120.speed.points, 1, dragged.frame, dragged.rate);
    assert.equal(moved.ok, true);
    if (moved.ok) assert.equal(moved.points[1]!.sourceFrame, 30);

    // Off-center click inside the 11px hit target (+4 CSS px X) + pure vertical drag still keeps sourceFrame at 30.
    const offStart = clientPointToCurveSvg(1233.140625, 244.84375, rect, activeCtm);
    const offEnd = clientPointToCurveSvg(1233.140625, 229.84375, rect, activeCtm);
    assert.ok(offStart && offEnd);
    const offDragged = curveDragTargetCoords(interior, offStart!, offEnd!, 0, 120);
    assert.equal(offDragged.frame, 30, 'off-center vertical drag must keep sourceFrame exact');
    assert.ok(offDragged.rate > 1);

    // Pure horizontal drag updates sourceFrame while keeping rate exact.
    const horizEnd = clientPointToCurveSvg(1249.140625, 244.84375, rect, activeCtm);
    const horizDragged = curveDragTargetCoords(interior, startSvg!, horizEnd!, 0, 120);
    assert.ok(horizDragged.frame > 30);
    assert.equal(horizDragged.rate, 1);
  }

  // Click without movement is detected as equal and skips commit in ClipSpeedSection.
  assert.equal(curvePointsEqual(flashIn120.speed.points, flashIn120.speed.points), true);
  const sectionSrc = read('apps/web/src/speed-ui/ClipSpeedSection.tsx');
  assert.ok(sectionSrc.includes('nudgeCurveControlPointRate('));
  assert.ok(sectionSrc.includes('clientPointToCurveSvg('));
  assert.ok(sectionSrc.includes('curveDragTargetCoords('));
  assert.ok(sectionSrc.includes('if (!movedAny) return;'));
});

test('A5/A6/F4/F5: speed label formatting, freeze clip classification, playhead gating, and 6-item context menu order', async () => {
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

  // Copy-as-new-shot uses the dedicated copy-as-new-shot command (not paste-clip) and only on main-track clips
  const appSrc = read('apps/web/src/App.tsx');
  const copyStart = appSrc.indexOf('async function format5CopyClipAsNewShot(');
  const copyEnd = appSrc.indexOf('async function format5ToggleClipMute(', copyStart);
  assert.ok(copyStart > 0 && copyEnd > copyStart);
  const copyBody = appSrc.slice(copyStart, copyEnd);
  assert.ok(copyBody.includes('format5CopyAsNewShotCommand('), 'format5CopyClipAsNewShot must dispatch format5CopyAsNewShotCommand');
  assert.equal(copyBody.includes('format5PasteClipCommand'), false, 'format5CopyClipAsNewShot must not fall back to paste-clip');
  assert.ok(copyBody.includes('{copying: true}'), 'format5CopyClipAsNewShot must surface copy-specific dialogue conflict messages');
  assert.ok(appSrc.includes('isMainTrackClip ? {onCopyAsNewShot:'), 'copy-as-new-shot menu entry is restricted to main-track clips');
  assert.ok(appSrc.includes('format5DialogueConflictPresentation('));
  assert.ok(appSrc.includes('data-testid="global-toast-action"'));

  for (const locale of LOCALES) {
    const tLoc = (key: string, params?: Record<string, unknown>) => translate(locale, key as never, params as never);
    const conflict = format5DialogueConflictPresentation({
      blockers: [{cueId: 'cue-1', startFrame: 60, endFrame: 119, textExcerpt: '挡住的字幕'}],
      blockerCount: 1, requiredFrames: 2, availableFrames: 1,
    }, null, tLoc, {copying: true});
    assert.ok(conflict.message.includes('挡住的字幕'), locale);
    assert.deepEqual(conflict.locateCue, {cueId: 'cue-1', startFrame: 60});
  }
  const conflictSession = new Format5EditSession(async () => ({
    ok: false, code: 'SEQUENCE_EDIT_DIALOGUE_CONFLICT', ids: ['shot-copy'],
    dialogueConflict: {
      blockers: [{cueId: 'cue-7', startFrame: 30, endFrame: 90, textExcerpt: '占用字幕'}],
      blockerCount: 1, requiredFrames: 2, availableFrames: 0,
    },
  }), () => 'project-1');
  const conflictOutcome = await conflictSession.runPayload({intents: []});
  assert.equal(conflictOutcome.ok, false);
  if (!conflictOutcome.ok && !('unconfirmed' in conflictOutcome)) {
    assert.equal(conflictOutcome.dialogueConflict?.blockers[0]?.cueId, 'cue-7');
  }
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

test('A7/F6: processing poller recovers after retryable 503, backs off to unknown on consecutive failures, and stops on clip switch/leave', async () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  // Error classification: 5xx / 429 / 408 / network are retryable; 4xx definitive & AbortError stop immediately.
  assert.equal(isRetryableProcessingPollError(new ApiError('Unavailable', 'UNAVAILABLE', undefined, false, 503)), true);
  assert.equal(isRetryableProcessingPollError(new ApiError('Bad Gateway', 'BAD_GATEWAY', undefined, false, 502)), true);
  assert.equal(isRetryableProcessingPollError(new ApiError('Too Many Requests', 'RATE_LIMIT', undefined, true, 429)), true);
  assert.equal(isRetryableProcessingPollError(new ApiError('Timeout', 'TIMEOUT', undefined, true, 408)), true);
  assert.equal(isRetryableProcessingPollError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableProcessingPollError(new ApiError('Unauthorized', 'UNAUTHORIZED', undefined, true, 401)), false);
  assert.equal(isRetryableProcessingPollError(new ApiError('Not found', 'NOT_FOUND', undefined, true, 404)), false);
  assert.equal(isRetryableProcessingPollError(Object.assign(new Error('Aborted'), {name: 'AbortError'})), false);
  assert.equal(speedProcessingBackoffDelayMs(1), 2000);
  assert.equal(speedProcessingBackoffDelayMs(2), 4000);
  assert.equal(speedProcessingBackoffDelayMs(3), 8000);
  assert.equal(speedProcessingBackoffDelayMs(4), 16000);
  assert.equal(speedProcessingBackoffDelayMs(5), SPEED_PROCESSING_RETRY_MAX_BACKOFF_MS);

  const makeHarness = (maxConsecutiveFailures = SPEED_PROCESSING_MAX_CONSECUTIVE_FAILURES) => {
    let nextId = 1;
    const timers = new Map<number, {fn: () => void; ms: number}>();
    const delays: number[] = [];
    const requests: Array<{signal: AbortSignal; resolve: (val: unknown) => void; reject: (err: unknown) => void}> = [];
    const snapshots: Array<readonly SpeedProcessingItem[]> = [];
    const states: SpeedProcessingPollState[] = [];
    const poller = createSpeedProcessingPoller({
      projectId: 'p1',
      maxConsecutiveFailures,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        const id = nextId++;
        delays.push(ms);
        timers.set(id, {fn, ms});
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
      }) as unknown as typeof clearTimeout,
      list: signal => new Promise((resolve, reject) => { requests.push({signal, resolve, reject}); }),
      onItems: items => snapshots.push(items),
      onStateChange: state => states.push(state),
    });
    const fireTimer = () => {
      assert.equal(timers.size, 1, 'expected exactly one scheduled poll timer');
      const [tid, entry] = [...timers.entries()][0]!;
      timers.delete(tid);
      entry.fn();
    };
    return {poller, timers, delays, requests, snapshots, states, fireTimer};
  };

  // 1) Recovery after transient HTTP 503 while running at 42%: retries with backoff and recovers to 80% -> ready.
  {
    const h = makeHarness();
    h.poller.start();
    h.requests[0]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 42}]});
    await flushMicrotasks();
    assert.equal(h.snapshots[0]![0]!.progress, 42);
    assert.deepEqual(h.delays, [2000]);

    h.fireTimer();
    h.requests[1]!.reject(new ApiError('Service Unavailable', 'UNAVAILABLE', undefined, false, 503));
    await flushMicrotasks();
    assert.equal(h.poller.getState(), 'retrying');
    assert.equal(h.timers.size, 1, 'transient 503 must schedule a backoff retry instead of stopping');
    assert.deepEqual(h.delays, [2000, 2000]);

    h.fireTimer();
    h.requests[2]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 80}]});
    await flushMicrotasks();
    assert.equal(h.poller.getState(), 'polling');
    assert.equal(h.snapshots[1]![0]!.progress, 80);
    assert.deepEqual(h.delays, [2000, 2000, 2000]);

    h.fireTimer();
    h.requests[3]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'ready'}]});
    await flushMicrotasks();
    assert.equal(h.poller.getState(), 'idle');
    assert.equal(h.timers.size, 0, 'polling stops once task is ready');
  }

  // 2) Consecutive retryable 503 failures back off exponentially and stop in 'unknown' after cap.
  {
    const h = makeHarness(5);
    h.poller.start();
    h.requests[0]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 42}]});
    await flushMicrotasks();

    for (let attempt = 1; attempt <= 5; attempt++) {
      h.fireTimer();
      h.requests[attempt]!.reject(new ApiError('Service Unavailable', 'UNAVAILABLE', undefined, false, 503));
      await flushMicrotasks();
    }
    assert.deepEqual(h.delays, [2000, 2000, 4000, 8000, 16000]);
    assert.equal(h.poller.getState(), 'unknown');
    assert.equal(h.timers.size, 0, 'poller must stop scheduling once consecutive failures reach unknown cap');

    // Timeline view switches from stale 42% to statusUnknown when pollState is 'unknown'.
    const clip = {
      id: 'c1', name: 'Shot 1', trackId: 'v1', startFrame: 0, durationFrames: 120, sourceInFrame: 0,
      timing: makeSpeedTiming({direction: 'reverse'}),
    };
    const unknownViews = buildTimelineClipSpeedViews(
      {capabilities: {speed: true}, clips: [clip]},
      [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'running', progress: 42}],
      tZh,
      'unknown',
    );
    assert.equal(unknownViews?.get('c1')?.processingLabel, '状态未知');
    assert.equal(unknownViews?.get('c1')?.processingUnknown, true);
    assert.equal(unknownViews?.get('c1')?.processingPercent, null);

    // Explicit refresh from 'unknown' resets consecutive failures and recovers on 200 OK.
    h.poller.refresh();
    h.requests[6]!.resolve({items: [{taskId: 't1', clipId: 'c1', kind: 'reverse', status: 'ready'}]});
    await flushMicrotasks();
    assert.equal(h.poller.getState(), 'idle');
    assert.equal(h.timers.size, 0);
  }

  // 3) Definitive non-retryable 401/404 stops immediately with 'failed' and zero retries.
  {
    const h = makeHarness();
    h.poller.start();
    h.requests[0]!.reject(new ApiError('Unauthorized', 'UNAUTHORIZED', undefined, true, 401));
    await flushMicrotasks();
    assert.equal(h.poller.getState(), 'failed');
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.delays, []);
  }

  // 4) Switching clip / leaving clip or closing preview cancels pending backoff timers, aborts in-flight requests, and ignores late replies.
  {
    const clipAPoller = makeHarness();
    clipAPoller.poller.start();
    clipAPoller.requests[0]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 42}]});
    await flushMicrotasks();
    clipAPoller.fireTimer();
    clipAPoller.requests[1]!.reject(new ApiError('Service Unavailable', 'UNAVAILABLE', undefined, false, 503));
    await flushMicrotasks();
    assert.equal(clipAPoller.timers.size, 1, 'clip A has pending backoff timer');

    // Leave clip A / switch to clip B mid-backoff: timer cancelled immediately.
    clipAPoller.poller.dispose();
    assert.equal(clipAPoller.timers.size, 0);
    assert.equal(clipAPoller.poller.getState(), 'idle');

    // Clip B starts polling, then closes preview / switches away mid-request: aborts and ignores late 503 or 200.
    const clipBPoller = makeHarness();
    clipBPoller.poller.start();
    assert.equal(clipBPoller.requests.length, 1);
    clipBPoller.poller.stop();
    assert.equal(clipBPoller.requests[0]!.signal.aborted, true);
    clipBPoller.requests[0]!.reject(new ApiError('Service Unavailable', 'UNAVAILABLE', undefined, false, 503));
    await flushMicrotasks();
    assert.equal(clipBPoller.timers.size, 0, 'late 503 after stop/leave must never reschedule polling');
    assert.equal(clipBPoller.poller.getState(), 'idle');

    // Hook wires active/selectedClipId/scopeKey cleanup so leaving or closing stops polling cleanly.
    const hookSrc = read('apps/web/src/speed-ui/use-speed-processing.ts');
    assert.ok(hookSrc.includes('active = true'));
    assert.ok(hookSrc.includes('selectedClipId = null'));
    assert.ok(hookSrc.includes('createScopedSpeedProcessingController('));
    const appSrc = read('apps/web/src/App.tsx');
    assert.ok(appSrc.includes('active: speedProcessingVisible'));
    assert.ok(appSrc.includes('selectedClipId: speedProcessingClipId'));
    assert.ok(appSrc.includes('forceProjectWide: showTasks'));
  }
});

test('A7/F6: scoped processing controller aborts in-flight & clears backoff on clip switch/close, discards late old replies by clip ID, and handles rapid A->B->A switches', async () => {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const makeScoped = () => {
    let nextId = 1;
    const timers = new Map<number, {fn: () => void; ms: number}>();
    const reqs: Array<{
      projectId: string;
      clipId: string | null;
      signal: AbortSignal;
      resolve: (val: unknown) => void;
      reject: (err: unknown) => void;
    }> = [];
    const snapshots: Array<readonly SpeedProcessingItem[]> = [];
    const states: SpeedProcessingPollState[] = [];
    const manager = createScopedSpeedProcessingController({
      setTimeoutFn: ((fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, {fn, ms});
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
      }) as unknown as typeof clearTimeout,
      list: (projectId, signal, clipId) =>
        new Promise((resolve, reject) => {
          reqs.push({projectId, clipId, signal, resolve, reject});
        }),
      onItems: items => snapshots.push(items),
      onStateChange: state => states.push(state),
    });
    const fireOnlyTimer = () => {
      assert.equal(timers.size, 1, `expected 1 active timer, got ${timers.size}`);
      const [id, entry] = [...timers.entries()][0]!;
      timers.delete(id);
      entry.fn();
    };
    return {manager, timers, reqs, snapshots, states, fireOnlyTimer};
  };

  const baseScope = {
    active: true,
    projectId: 'p1',
    timelineRevision: 1,
    clipTriggerKey: 'clip-a:constant:reverse:off|clip-b:curve:forward:optical',
    selectedClipNeedsProcessing: true,
    forceProjectWide: false,
  };

  // 1) Late old response after switching A -> B: A's in-flight request is aborted immediately,
  // B fires immediately, late A response (71%) is discarded, and B's 64% is shown.
  {
    const h = makeScoped();
    // Initial editing entry (null) -> first poll, then initial clip A selection adopts without aborting.
    h.manager.update({...baseScope, selectedClipId: null});
    assert.equal(h.reqs.length, 1);
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    assert.equal(h.reqs.length, 1, 'initial null -> clip-a adopts running initial poll');
    assert.equal(h.reqs[0]!.signal.aborted, false);
    h.reqs[0]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 42}]});
    await flush();
    assert.equal(h.snapshots.at(-1)?.[0]?.progress, 42);

    // Next scheduled poll for A is in-flight when user switches to B.
    h.fireOnlyTimer();
    assert.equal(h.reqs.length, 2);
    assert.equal(h.reqs[1]!.signal.aborted, false);

    h.manager.update({...baseScope, selectedClipId: 'clip-b'});
    assert.equal(h.reqs[1]!.signal.aborted, true, 'switching A -> B must abort A in-flight request immediately');
    assert.equal(h.reqs.length, 3, 'clip B must immediately issue its own query');
    assert.equal(h.reqs[2]!.clipId, 'clip-b');

    // Late A response resolves anyway (simulating transport ignoring AbortSignal): MUST be discarded!
    h.reqs[1]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 71}]});
    await flush();
    assert.equal(h.snapshots.some(list => list.some(item => item.progress === 71)), false, 'late A 71% response must never apply');

    // B's response arrives and renders immediately.
    h.reqs[2]!.resolve({items: [{taskId: 't-b', clipId: 'clip-b', kind: 'preview', status: 'running', progress: 64}]});
    await flush();
    assert.equal(h.snapshots.at(-1)?.[0]?.clipId, 'clip-b');
    assert.equal(h.snapshots.at(-1)?.[0]?.progress, 64);
    h.manager.dispose();
  }

  // 2) 503 during switch: pending backoff timer for A is cancelled immediately & late 503 from A never taints B.
  {
    const h = makeScoped();
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    h.reqs[0]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 42}]});
    await flush();
    h.fireOnlyTimer();
    h.reqs[1]!.reject(new ApiError('Unavailable', 'UNAVAILABLE', undefined, false, 503));
    await flush();
    assert.equal(h.manager.getState(), 'retrying');
    assert.equal(h.timers.size, 1, 'A has pending 2s backoff timer');

    // Switch A -> B mid-backoff: A's timer is cleared and B immediately queries.
    h.manager.update({...baseScope, selectedClipId: 'clip-b'});
    assert.equal(h.timers.size, 0, 'A backoff timer must be cleared immediately on switch');
    assert.equal(h.reqs.length, 3, 'B must immediately start its own query instead of waiting for A backoff');
    assert.equal(h.manager.getState(), 'polling');

    // Now B's query is in-flight when user switches to A again, and B's aborted query later rejects with 503.
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    assert.equal(h.reqs[2]!.signal.aborted, true);
    assert.equal(h.reqs.length, 4);
    h.reqs[2]!.reject(new ApiError('Unavailable', 'UNAVAILABLE', undefined, false, 503));
    await flush();
    assert.equal(h.manager.getState(), 'polling', 'late 503 from aborted B must not push A into retrying');
    assert.equal(h.timers.size, 0);
    h.reqs[3]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'ready'}]});
    await flush();
    assert.equal(h.manager.getState(), 'idle');
    assert.equal(h.timers.size, 0);
    h.manager.dispose();
  }

  // 3) Rapid A -> B -> A switching: both A1 and B1 are aborted and late replies from either (even A1 with same clipId) are discarded.
  {
    const h = makeScoped();
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    assert.equal(h.reqs.length, 1);
    h.manager.update({...baseScope, selectedClipId: 'clip-b'});
    assert.equal(h.reqs[0]!.signal.aborted, true);
    assert.equal(h.reqs.length, 2);
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    assert.equal(h.reqs[1]!.signal.aborted, true);
    assert.equal(h.reqs.length, 3);

    // Late A1 (stale generation, same clipId) and late B1 both resolve: neither can overwrite A2.
    h.reqs[0]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 11}]});
    h.reqs[1]!.resolve({items: [{taskId: 't-b', clipId: 'clip-b', kind: 'preview', status: 'running', progress: 22}]});
    await flush();
    assert.equal(h.snapshots.length, 0);

    h.reqs[2]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 88}]});
    await flush();
    assert.equal(h.snapshots.length, 1);
    assert.equal(h.snapshots[0]![0]!.progress, 88);
    h.manager.dispose();
  }

  // 4) Switching to plain clip, closing inspector panel (clip -> null), or closing preview/editing (active -> false) stops immediately.
  {
    const h = makeScoped();
    h.manager.update({...baseScope, selectedClipId: 'clip-a'});
    h.reqs[0]!.resolve({items: [{taskId: 't-a', clipId: 'clip-a', kind: 'reverse', status: 'running', progress: 42}]});
    await flush();
    assert.equal(h.timers.size, 1);

    // Switch to plain clip C (no processing needed): cancels timer, sends 0 requests.
    h.manager.update({...baseScope, selectedClipId: 'clip-plain', selectedClipNeedsProcessing: false});
    assert.equal(h.timers.size, 0);
    assert.equal(h.reqs.length, 1);
    assert.equal(h.manager.getState(), 'idle');

    // Back to clip-a, in-flight request active -> close inspector panel (selectedClipId -> null): aborts immediately.
    h.manager.update({...baseScope, selectedClipId: 'clip-a', selectedClipNeedsProcessing: true});
    assert.equal(h.reqs.length, 2);
    h.manager.update({...baseScope, selectedClipId: null, selectedClipNeedsProcessing: false});
    assert.equal(h.reqs[1]!.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.manager.getState(), 'idle');

    // Re-open on clip-a -> close preview / leave editing (active -> false): aborts & clears items immediately.
    h.manager.update({...baseScope, selectedClipId: 'clip-a', selectedClipNeedsProcessing: true});
    assert.equal(h.reqs.length, 3);
    h.manager.update({...baseScope, active: false, selectedClipId: null, selectedClipNeedsProcessing: false});
    assert.equal(h.reqs[2]!.signal.aborted, true);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.snapshots.at(-1), []);
    h.manager.dispose();
  }
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
