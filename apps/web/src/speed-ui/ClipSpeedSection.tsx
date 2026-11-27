/** Inspector «变速» group (22-01, 22-02, 22-05).
 *
 * Supports:
 * - F1 Standard mode: logarithmic slider (0.1×–10×) + numeric input (reduced rational),
 *   read-only live duration + original 1× duration, pitch shift switch, reverse switch,
 *   reset button, and frame interpolation dropdown (< 1× only).
 * - F2 Curve mode: 8 preset cards from `TIMELINE_SPEED_PRESETS` (`instantiateSpeedPreset`),
 *   interactive log-PCHIP SVG curve graph with playhead line, drag point, double-click
 *   add point, Delete/Backspace remove interior point, automatic switch to `custom`,
 *   and local validation rejecting endpoint delete / >32 points / out-of-range rates.
 * - F3 Commit: live local duration calculation via `compileTimeMap`; commits on slider
 *   release, Enter/blur, preset click, curve drag release, or toggle change.
 * - F6 Processing status: active progress bar or failed reason + Retry button.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Button} from '@mioon/ui/components/button';
import {Input} from '@mioon/ui/components/input';
import {Switch} from '@mioon/ui/components/switch';
import {CircleAlert, Info, RotateCcw} from '@mioon/ui/components/workbench-icons';
import type {TimeMapCurvePoint, TimeMapCurvePreset} from '../../../../packages/contracts/src/timeline-time-map.ts';
import type {SpeedInterpolation, SpeedProcessingItem, SpeedSetting} from '../../../../packages/contracts/src/timeline-speed.ts';
import InspectorGroup from '../InspectorGroup.tsx';
import {WorkbenchSelect, WorkbenchTooltip} from '../WorkspaceControls.tsx';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {useUiPreferences} from '../UiPreferencesProvider.tsx';
import {displayTimelineFrame} from '../timeline-removal.ts';
import {
  CURVE_SVG_GEOMETRY,
  SPEED_MAX_RATE,
  SPEED_MIN_RATE,
  SPEED_PRESET_LIST,
  SPEED_SLIDER_RESOLUTION,
  SPEED_SLIDER_TICKS,
  addCurveControlPoint,
  clientPointToCurveSvg,
  curveDragTargetCoords,
  curvePointsEqual,
  curveSvgPointToCoords,
  defaultSpeedSetting,
  deleteCurveControlPoint,
  formatOriginalSeconds,
  formatSpeedRateInput,
  formatSpeedRateLabel,
  instantiatePresetForClip,
  isDefaultSpeedSetting,
  logNormToRate,
  moveCurveControlPoint,
  normalizeSpeedSettingForSubmit,
  nudgeCurveControlPointFrame,
  nudgeCurveControlPointRate,
  parseRateToRational,
  playheadSourceNormOnClip,
  previewLocalSpeedSetting,
  processingItemActive,
  rateToLogNorm,
  rateToNumber,
  resolveClipSpeedGeometry,
  resolvePitchShiftControl,
  sampleLogPchipCurve,
  settingFromClip,
  speedNeedsInterpolation,
  speedPreviewErrorKey,
  speedProcessingCanRetry,
  speedSettingsEqual,
} from './speed-model.ts';
import type {CurveEditError, SpeedClipLike} from './speed-model.ts';
import type {SpeedProcessingPollState} from './use-speed-processing.ts';
import {speedProcessingActiveLabel, speedProcessingFailureSentence} from './speed-presentation.ts';
import './speed-ui.css';

export interface ClipSpeedSectionProps {
  readonly clip: SpeedClipLike;
  readonly fps: number;
  readonly playhead: number;
  readonly disabled: boolean;
  readonly processing: SpeedProcessingItem | null;
  readonly processingBusy: boolean;
  readonly processingPollState?: SpeedProcessingPollState;
  readonly onCommitSpeed: (setting: SpeedSetting) => Promise<unknown>;
  readonly onRetryProcessing: (taskId: string) => unknown;
  readonly onRefreshProcessing?: () => void;
}

const CURVE_SVG_W = CURVE_SVG_GEOMETRY.width;
const CURVE_SVG_H = CURVE_SVG_GEOMETRY.height;
const CURVE_PAD_LEFT = CURVE_SVG_GEOMETRY.padLeft;
const CURVE_PAD_RIGHT = CURVE_SVG_GEOMETRY.padRight;
const CURVE_PAD_TOP = CURVE_SVG_GEOMETRY.padTop;
const CURVE_PLOT_W = CURVE_SVG_GEOMETRY.plotWidth;
const CURVE_PLOT_H = CURVE_SVG_GEOMETRY.plotHeight;

function presetThumbnailPath(preset: TimeMapCurvePreset): string {
  const w = 52;
  const h = 24;
  const padX = 4;
  const padY = 4;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  if (preset.id === 'none') {
    const midY = padY + plotH * 0.5;
    return `M ${padX} ${midY} L ${w - padX} ${midY}`;
  }
  const sourcePts = preset.id === 'custom'
    ? [
        {x: 0, rate: 0.75},
        {x: 0.25, rate: 1.15},
        {x: 0.52, rate: 0.9},
        {x: 0.8, rate: 2.1},
        {x: 1, rate: 1.15},
      ]
    : preset.points.map(pt => ({x: pt.position, rate: rateToNumber(pt.rate)}));
  const samples = sampleLogPchipCurve(sourcePts, 28);
  return samples
    .map((pt, index) => {
      const px = padX + pt.x * plotW;
      const py = padY + (1 - pt.yNorm) * plotH;
      return `${index === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(' ');
}

function curveValidationMessageKey(error: CurveEditError): string {
  switch (error) {
    case 'POINT_LIMIT': return 'speed.validation.pointLimit';
    case 'ENDPOINT_FIXED': return 'speed.validation.endpointFixed';
    case 'INVALID_RATE': return 'speed.validation.rateRange';
    case 'POINT_ORDER': return 'speed.validation.pointOrder';
  }
}

export default function ClipSpeedSection({
  clip,
  fps,
  playhead,
  disabled,
  processing,
  processingBusy,
  processingPollState,
  onCommitSpeed,
  onRetryProcessing,
  onRefreshProcessing,
}: ClipSpeedSectionProps): React.ReactElement {
  const {t} = useI18n();
  const {preferences} = useUiPreferences();

  const geometry = useMemo(() => resolveClipSpeedGeometry(clip, fps), [clip, fps]);
  const savedSetting = useMemo(() => settingFromClip(clip), [clip]);
  const savedKey = useMemo(() => `${clip.id}:${JSON.stringify(savedSetting)}`, [clip.id, savedSetting]);

  const [mode, setMode] = useState<'constant' | 'curve'>(() => savedSetting.speed.kind);
  const [draft, setDraft] = useState<SpeedSetting>(() => savedSetting);
  const [rateText, setRateText] = useState<string>(() =>
    savedSetting.speed.kind === 'constant' ? formatSpeedRateInput(savedSetting.speed.rate) : '1.0',
  );
  const [selectedPointIndex, setSelectedPointIndex] = useState<number>(1);
  const [localError, setLocalError] = useState<string | null>(null);
  const [draggingPointIndex, setDraggingPointIndex] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const draftRef = useRef<SpeedSetting>(draft);
  draftRef.current = draft;
  const savedSettingRef = useRef<SpeedSetting>(savedSetting);
  savedSettingRef.current = savedSetting;

  // Sync local draft whenever the selected clip or its committed timing changes.
  useEffect(() => {
    setDraft(savedSetting);
    setMode(savedSetting.speed.kind);
    setRateText(savedSetting.speed.kind === 'constant' ? formatSpeedRateInput(savedSetting.speed.rate) : '1.0');
    setSelectedPointIndex(savedSetting.speed.kind === 'curve' ? Math.min(1, savedSetting.speed.points.length - 1) : 1);
    setLocalError(null);
    setDraggingPointIndex(null);
  }, [savedKey]);

  const livePreview = useMemo(() => previewLocalSpeedSetting(geometry, draft), [geometry, draft]);
  const liveDurationFrames = livePreview.ok ? livePreview.durationFrames : clip.durationFrames;
  const activePlan = livePreview.ok ? livePreview.plan : geometry.savedPlan;
  const playheadNorm = useMemo(
    () => playheadSourceNormOnClip(clip, geometry, activePlan, playhead),
    [clip, geometry, activePlan, playhead],
  );

  const currentConstantRate = draft.speed.kind === 'constant' ? rateToNumber(draft.speed.rate) : 1;
  const sliderValue = Math.round(rateToLogNorm(currentConstantRate) * SPEED_SLIDER_RESOLUTION);
  const showInterpolation = speedNeedsInterpolation(draft.speed);
  const originalSeconds = formatOriginalSeconds(geometry.originalFrames, geometry.fps);

  const activeCurvePoints: readonly TimeMapCurvePoint[] = useMemo(() => {
    if (draft.speed.kind === 'curve') return draft.speed.points;
    const end = Math.max(geometry.sourceStartFrame + 2, geometry.sourceEndFrame);
    const rate = draft.speed.rate;
    return [
      {sourceFrame: geometry.sourceStartFrame, rate},
      {sourceFrame: end, rate},
    ];
  }, [draft.speed, geometry.sourceStartFrame, geometry.sourceEndFrame]);

  const activePresetId = draft.speed.kind === 'curve' ? draft.speed.presetId : 'none';

  async function commit(next: SpeedSetting): Promise<void> {
    setLocalError(null);
    const check = previewLocalSpeedSetting(geometry, next);
    if (!check.ok) {
      setLocalError(t(speedPreviewErrorKey(check.code) as never));
      return;
    }
    await onCommitSpeed(next);
  }

  function handleModeChange(nextMode: 'constant' | 'curve'): void {
    if (disabled || nextMode === mode) return;
    setLocalError(null);
    setMode(nextMode);
    if (nextMode === 'constant') {
      if (draft.speed.kind !== 'constant') {
        const next: SpeedSetting = {
          ...draft,
          speed: {kind: 'constant', rate: {numerator: 1, denominator: 1}},
        };
        setDraft(next);
        setRateText('1.0');
      }
      return;
    }
    // Switching to curve tab keeps existing curve points or displays the editable baseline.
    if (draft.speed.kind === 'constant') {
      setSelectedPointIndex(0);
    }
  }

  function handleSliderInput(raw: number): void {
    if (disabled) return;
    setLocalError(null);
    const nextRate = logNormToRate(raw / SPEED_SLIDER_RESOLUTION);
    const parsed = parseRateToRational(nextRate);
    if (!parsed.ok) return;
    const next: SpeedSetting = {
      ...draftRef.current,
      speed: {kind: 'constant', rate: parsed.rate},
    };
    setDraft(next);
    setRateText(formatSpeedRateInput(parsed.rate));
  }

  function handleSliderCommit(): void {
    if (disabled) return;
    if (speedSettingsEqual(
      normalizeSpeedSettingForSubmit(draftRef.current),
      normalizeSpeedSettingForSubmit(savedSettingRef.current),
    )) {
      setLocalError(null);
      return;
    }
    void commit(draftRef.current);
  }

  function handleRateInputCommit(): void {
    if (disabled) return;
    const parsed = parseRateToRational(rateText);
    if (!parsed.ok) {
      setLocalError(t('speed.validation.rateRange'));
      return;
    }
    setLocalError(null);
    const next: SpeedSetting = {
      ...draftRef.current,
      speed: {kind: 'constant', rate: parsed.rate},
    };
    setDraft(next);
    setRateText(formatSpeedRateInput(parsed.rate));
    if (speedSettingsEqual(
      normalizeSpeedSettingForSubmit(next),
      normalizeSpeedSettingForSubmit(savedSettingRef.current),
    )) return;
    void commit(next);
  }

  function handlePresetSelect(presetId: string): void {
    if (disabled) return;
    setLocalError(null);
    const inst = instantiatePresetForClip(presetId, geometry.sourceStartFrame, geometry.sourceEndFrame);
    if (!inst.ok) {
      setLocalError(t(speedPreviewErrorKey(inst.code) as never));
      return;
    }
    const next: SpeedSetting = {
      ...draftRef.current,
      speed: inst.speed,
    };
    setDraft(next);
    if (inst.speed.kind === 'constant') {
      setRateText(formatSpeedRateInput(inst.speed.rate));
    } else {
      setSelectedPointIndex(Math.min(1, inst.speed.points.length - 1));
    }
    void commit(next);
  }

  const pitchControl = useMemo(
    () => resolvePitchShiftControl(mode, draft),
    [mode, draft],
  );

  function handlePitchShiftChange(checked: boolean): void {
    if (disabled || pitchControl.locked) return;
    const next: SpeedSetting = {...draftRef.current, pitchShift: checked};
    setDraft(next);
    void commit(next);
  }

  function handleReverseChange(checked: boolean): void {
    if (disabled) return;
    const next: SpeedSetting = {...draftRef.current, direction: checked ? 'reverse' : 'forward'};
    setDraft(next);
    void commit(next);
  }

  function handleInterpolationChange(value: string): void {
    if (disabled) return;
    if (value !== 'off' && value !== 'blend' && value !== 'optical') return;
    const next: SpeedSetting = {...draftRef.current, interpolation: value as SpeedInterpolation};
    setDraft(next);
    void commit(next);
  }

  function handleReset(): void {
    if (disabled) return;
    const next = defaultSpeedSetting();
    setLocalError(null);
    setMode('constant');
    setDraft(next);
    setRateText('1.0');
    void commit(next);
  }

  // Curve editor SVG pointer & keyboard editing.
  const curveStartFrame = activeCurvePoints[0]!.sourceFrame;
  const curveEndFrame = activeCurvePoints[activeCurvePoints.length - 1]!.sourceFrame;
  const curveSpan = Math.max(1, curveEndFrame - curveStartFrame);

  function frameToSvgX(sourceFrame: number): number {
    return CURVE_PAD_LEFT + ((sourceFrame - curveStartFrame) / curveSpan) * CURVE_PLOT_W;
  }

  function rateToSvgY(rate: number): number {
    return CURVE_PAD_TOP + (1 - rateToLogNorm(rate)) * CURVE_PLOT_H;
  }

  function clientToSvgPoint(clientX: number, clientY: number): {readonly x: number; readonly y: number} | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const rawCtm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    return clientPointToCurveSvg(clientX, clientY, rect, rawCtm);
  }

  function clientToCurveCoords(clientX: number, clientY: number): {frame: number; rate: number} | null {
    const svgPoint = clientToSvgPoint(clientX, clientY);
    if (!svgPoint) return null;
    return curveSvgPointToCoords(svgPoint, curveStartFrame, curveEndFrame);
  }

  function applyCurvePoints(points: readonly TimeMapCurvePoint[], nextSelected: number, shouldCommit: boolean): void {
    setLocalError(null);
    setSelectedPointIndex(nextSelected);
    const next: SpeedSetting = {
      ...draftRef.current,
      speed: {
        kind: 'curve',
        interpolation: 'log-pchip-v1',
        presetId: 'custom',
        points,
      },
    };
    setDraft(next);
    if (shouldCommit) void commit(next);
  }

  function handleCurveDoubleClick(event: React.MouseEvent<SVGSVGElement>): void {
    if (disabled) return;
    const coords = clientToCurveCoords(event.clientX, event.clientY);
    if (!coords) return;
    const result = addCurveControlPoint(activeCurvePoints, coords.frame, coords.rate);
    if (!result.ok) {
      setLocalError(t(curveValidationMessageKey(result.error) as never));
      return;
    }
    applyCurvePoints(result.points, result.selectedIndex, true);
  }

  function handlePointPointerDown(index: number, event: React.PointerEvent<SVGGElement>): void {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedPointIndex(index);
    setDraggingPointIndex(index);
    setLocalError(null);
    event.currentTarget.focus();

    const startSvg = clientToSvgPoint(event.clientX, event.clientY);
    const initialSetting = draftRef.current;
    const initialPoints = initialSetting.speed.kind === 'curve' ? initialSetting.speed.points : activeCurvePoints;
    const startPoint = initialPoints[index];
    if (!startSvg || !startPoint) {
      setDraggingPointIndex(null);
      return;
    }

    const startCurveFirst = initialPoints[0]!.sourceFrame;
    const startCurveLast = initialPoints[initialPoints.length - 1]!.sourceFrame;
    let movedAny = false;

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const currentSvg = clientToSvgPoint(moveEvent.clientX, moveEvent.clientY);
      if (!currentSvg) return;
      const target = curveDragTargetCoords(
        startPoint,
        startSvg,
        currentSvg,
        startCurveFirst,
        startCurveLast,
      );
      const currentPts = draftRef.current.speed.kind === 'curve' ? draftRef.current.speed.points : initialPoints;
      const moved = moveCurveControlPoint(currentPts, index, target.frame, target.rate);
      if (!moved.ok) {
        setLocalError(t(curveValidationMessageKey(moved.error) as never));
        return;
      }
      if (curvePointsEqual(currentPts, moved.points)) return;
      movedAny = true;
      applyCurvePoints(moved.points, moved.selectedIndex, false);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDraggingPointIndex(null);
      if (!movedAny) return;
      const finalPts = draftRef.current.speed.kind === 'curve' ? draftRef.current.speed.points : initialPoints;
      if (initialSetting.speed.kind === 'curve' && curvePointsEqual(initialPoints, finalPts)) return;
      void commit(draftRef.current);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function handlePointKeyDown(index: number, event: React.KeyboardEvent<SVGGElement>): void {
    if (disabled) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      const deleted = deleteCurveControlPoint(activeCurvePoints, index);
      if (!deleted.ok) {
        setLocalError(t(curveValidationMessageKey(deleted.error) as never));
        return;
      }
      applyCurvePoints(deleted.points, deleted.selectedIndex, true);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const moved = nudgeCurveControlPointRate(
        activeCurvePoints,
        index,
        event.key === 'ArrowUp' ? 'up' : 'down',
        event.shiftKey,
      );
      if (!moved.ok) {
        setLocalError(t(curveValidationMessageKey(moved.error) as never));
        return;
      }
      if (!moved.changed) {
        setLocalError(null);
        return;
      }
      applyCurvePoints(moved.points, moved.selectedIndex, true);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      const moved = nudgeCurveControlPointFrame(
        activeCurvePoints,
        index,
        event.key === 'ArrowRight' ? 'right' : 'left',
        event.shiftKey,
      );
      if (!moved.ok) {
        setLocalError(t(curveValidationMessageKey(moved.error) as never));
        return;
      }
      if (!moved.changed) return;
      applyCurvePoints(moved.points, moved.selectedIndex, true);
    }
  }

  const curvePathD = useMemo(() => {
    const pts = activeCurvePoints.map(pt => ({x: pt.sourceFrame, rate: rateToNumber(pt.rate)}));
    const sampled = sampleLogPchipCurve(pts, 64);
    return sampled
      .map((pt, index) => {
        const px = CURVE_PAD_LEFT + pt.x * CURVE_PLOT_W;
        const py = CURVE_PAD_TOP + (1 - pt.yNorm) * CURVE_PLOT_H;
        return `${index === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`;
      })
      .join(' ');
  }, [activeCurvePoints]);

  const processingActive = Boolean(processing && processingItemActive(processing));
  const processingFailed = processing?.status === 'failed';
  const processingPercent = processing?.status === 'running' && typeof processing.progress === 'number'
    ? Math.max(0, Math.min(100, Math.round(processing.progress)))
    : 0;

  const headerAction = (
    <div
      className="speed-mode-segmented"
      role="tablist"
      aria-label={t('speed.group.title')}
      data-testid="speed-mode-switch"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'constant'}
        className={mode === 'constant' ? 'is-active' : ''}
        data-testid="speed-mode-constant"
        disabled={disabled}
        onClick={() => handleModeChange('constant')}
      >
        {t('speed.mode.constant')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'curve'}
        className={mode === 'curve' ? 'is-active' : ''}
        data-testid="speed-mode-curve"
        disabled={disabled}
        onClick={() => handleModeChange('curve')}
      >
        {t('speed.mode.curve')}
      </button>
    </div>
  );

  return (
    <InspectorGroup
      groupKey="speed"
      title={t('speed.group.title')}
      className="edit-inspector-speed"
      headerAction={headerAction}
    >
      <div className="speed-section-body" data-testid="clip-speed-section" data-mode={mode}>
        {mode === 'constant' ? (
          <div className="speed-constant-panel" data-testid="speed-constant-panel">
            <div className="speed-row speed-rate-row">
              <label className="speed-row-label" htmlFor="clip-speed-rate-input">
                {t('speed.rate.label')}
              </label>
              <div className="speed-slider-column">
                <div className="speed-slider-track-wrap">
                  <input
                    type="range"
                    className="speed-rate-slider"
                    data-testid="speed-rate-slider"
                    aria-label={t('speed.rate.aria')}
                    min={0}
                    max={SPEED_SLIDER_RESOLUTION}
                    step={1}
                    value={sliderValue}
                    disabled={disabled}
                    style={{'--speed-fill': `${(sliderValue / SPEED_SLIDER_RESOLUTION) * 100}%`} as React.CSSProperties}
                    onChange={event => handleSliderInput(Number(event.target.value))}
                    onPointerUp={handleSliderCommit}
                    onKeyUp={event => {
                      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                        handleSliderCommit();
                      }
                    }}
                  />
                </div>
                <div className="speed-slider-ticks" aria-hidden="true" data-testid="speed-slider-ticks">
                  {SPEED_SLIDER_TICKS.map(tick => (
                    <span
                      key={tick}
                      style={{left: `${rateToLogNorm(tick) * 100}%`}}
                    >
                      {tick}×
                    </span>
                  ))}
                </div>
              </div>
              <div className="speed-rate-input-wrap">
                <Input
                  id="clip-speed-rate-input"
                  data-testid="speed-rate-input"
                  aria-label={t('speed.rate.inputAria')}
                  type="text"
                  inputMode="decimal"
                  value={rateText}
                  disabled={disabled}
                  onChange={event => {
                    setRateText(event.target.value);
                    const parsed = parseRateToRational(event.target.value);
                    if (parsed.ok) {
                      setLocalError(null);
                      setDraft(current => ({...current, speed: {kind: 'constant', rate: parsed.rate}}));
                    }
                  }}
                  onBlur={handleRateInputCommit}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.stopPropagation();
                      handleRateInputCommit();
                    }
                  }}
                />
                <span className="speed-rate-suffix" aria-hidden="true">×</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="speed-curve-panel" data-testid="speed-curve-panel">
            <div className="speed-preset-grid" role="group" aria-label={t('speed.mode.curve')} data-testid="speed-preset-grid">
              {SPEED_PRESET_LIST.map(preset => {
                const selected = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`speed-preset-card ${selected ? 'is-selected' : ''}`}
                    data-testid={`speed-preset-${preset.id}`}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => handlePresetSelect(preset.id)}
                  >
                    <svg className="speed-preset-thumb" viewBox="0 0 52 24" aria-hidden="true">
                      <line x1="4" y1="12" x2="48" y2="12" className="speed-preset-baseline" />
                      <path d={presetThumbnailPath(preset)} className="speed-preset-curve" />
                    </svg>
                    <span>{t(`speed.preset.${preset.id}` as never)}</span>
                  </button>
                );
              })}
            </div>

            <div className="speed-curve-editor-box">
              <svg
                ref={svgRef}
                className={`speed-curve-svg ${draggingPointIndex !== null ? 'is-dragging' : ''}`}
                viewBox={`0 0 ${CURVE_SVG_W} ${CURVE_SVG_H}`}
                role="group"
                aria-label={t('speed.curve.editorAria')}
                data-testid="speed-curve-editor"
                onDoubleClick={handleCurveDoubleClick}
              >
                <line
                  x1={CURVE_PAD_LEFT}
                  y1={rateToSvgY(SPEED_MAX_RATE)}
                  x2={CURVE_SVG_W - CURVE_PAD_RIGHT}
                  y2={rateToSvgY(SPEED_MAX_RATE)}
                  className="speed-curve-grid"
                />
                <line
                  x1={CURVE_PAD_LEFT}
                  y1={rateToSvgY(1)}
                  x2={CURVE_SVG_W - CURVE_PAD_RIGHT}
                  y2={rateToSvgY(1)}
                  className="speed-curve-grid-1x"
                />
                <line
                  x1={CURVE_PAD_LEFT}
                  y1={rateToSvgY(SPEED_MIN_RATE)}
                  x2={CURVE_SVG_W - CURVE_PAD_RIGHT}
                  y2={rateToSvgY(SPEED_MIN_RATE)}
                  className="speed-curve-grid"
                />
                <text x={CURVE_PAD_LEFT - 6} y={rateToSvgY(SPEED_MAX_RATE) + 3} className="speed-curve-axis-label">10×</text>
                <text x={CURVE_PAD_LEFT - 6} y={rateToSvgY(1) + 3} className="speed-curve-axis-label">1×</text>
                <text x={CURVE_PAD_LEFT - 6} y={rateToSvgY(SPEED_MIN_RATE) + 3} className="speed-curve-axis-label">0.1×</text>

                {playheadNorm !== null && (
                  <line
                    x1={CURVE_PAD_LEFT + playheadNorm * CURVE_PLOT_W}
                    y1={4}
                    x2={CURVE_PAD_LEFT + playheadNorm * CURVE_PLOT_W}
                    y2={CURVE_SVG_H - 4}
                    className="speed-curve-playhead"
                    data-testid="speed-curve-playhead"
                    aria-label={t('speed.curve.playheadAria')}
                  />
                )}

                <path d={curvePathD} className="speed-curve-path" data-testid="speed-curve-path" />

                {activeCurvePoints.map((pt, index) => {
                  const cx = frameToSvgX(pt.sourceFrame);
                  const cy = rateToSvgY(rateToNumber(pt.rate));
                  const selected = index === selectedPointIndex;
                  const isEndpoint = index === 0 || index === activeCurvePoints.length - 1;
                  return (
                    <g
                      key={index}
                      className={`speed-curve-point ${selected ? 'is-selected' : ''} ${isEndpoint ? 'is-endpoint' : ''}`}
                      data-testid={`speed-curve-point-${index}`}
                      data-frame={pt.sourceFrame}
                      data-rate={formatSpeedRateInput(pt.rate)}
                      tabIndex={disabled ? -1 : 0}
                      role="slider"
                      aria-label={t('speed.curve.pointAria', {
                        index: index + 1,
                        rate: formatSpeedRateLabel(pt.rate),
                      })}
                      aria-valuemin={SPEED_MIN_RATE}
                      aria-valuemax={SPEED_MAX_RATE}
                      aria-valuenow={Number(formatSpeedRateInput(pt.rate))}
                      onPointerDown={event => handlePointPointerDown(index, event)}
                      onFocus={() => setSelectedPointIndex(index)}
                      onKeyDown={event => handlePointKeyDown(index, event)}
                    >
                      <circle cx={cx} cy={cy} r={11} className="speed-curve-point-hit" />
                      <circle cx={cx} cy={cy} r={5} className="speed-curve-point-dot" />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}

        {localError && (
          <p className="speed-local-error" role="alert" data-testid="speed-local-error">
            {localError}
          </p>
        )}

        {showInterpolation && (
          <div className="speed-row speed-interpolation-row" data-testid="speed-interpolation-row">
            <label className="speed-row-label" htmlFor="clip-speed-interpolation">
              {t('speed.interpolation.label')}
            </label>
            <div className="speed-row-control">
              <WorkbenchSelect
                id="clip-speed-interpolation"
                data-testid="speed-interpolation-select"
                value={draft.interpolation}
                disabled={disabled}
                onChange={event => handleInterpolationChange(event.target.value)}
              >
                <option value="off">{t('speed.interpolation.off')}</option>
                <option value="blend">{t('speed.interpolation.blend')}</option>
                <option value="optical">{t('speed.interpolation.optical')}</option>
              </WorkbenchSelect>
            </div>
          </div>
        )}

        <div className="speed-row speed-duration-row">
          <span className="speed-row-label">{t('speed.duration.label')}</span>
          <div className="speed-duration-values">
            <span className="speed-duration-current" data-testid="speed-duration-value">
              {displayTimelineFrame(liveDurationFrames, geometry.fps, preferences.timecodeFormat)}
            </span>
            <span className="speed-duration-original" data-testid="speed-original-duration">
              {t('speed.duration.original', {seconds: originalSeconds})}
            </span>
          </div>
        </div>

        <div className="speed-row speed-switch-row" data-testid="speed-pitch-shift-row">
          <span className="speed-row-label-group">
            <label className="speed-row-label" htmlFor="clip-speed-pitch-shift">
              {t('speed.pitchShift.label')}
            </label>
            {pitchControl.locked && pitchControl.tooltipKey && (
              <WorkbenchTooltip content={t(pitchControl.tooltipKey as never)}>
                <button
                  type="button"
                  className="speed-info-trigger"
                  data-testid="speed-pitch-shift-info"
                  data-lock-reason={pitchControl.lockReason ?? undefined}
                  aria-label={t(pitchControl.tooltipKey as never)}
                  title={t(pitchControl.tooltipKey as never)}
                >
                  <Info size={13} aria-hidden="true" />
                </button>
              </WorkbenchTooltip>
            )}
          </span>
          <Switch
            id="clip-speed-pitch-shift"
            data-testid="speed-pitch-shift"
            checked={pitchControl.checked}
            disabled={disabled || pitchControl.locked}
            onCheckedChange={checked => handlePitchShiftChange(checked === true)}
          />
        </div>

        <div className="speed-row speed-switch-row">
          <label className="speed-row-label" htmlFor="clip-speed-reverse">
            {t('speed.reverse.label')}
          </label>
          <Switch
            id="clip-speed-reverse"
            data-testid="speed-reverse"
            checked={draft.direction === 'reverse'}
            disabled={disabled}
            onCheckedChange={checked => handleReverseChange(checked === true)}
          />
        </div>

        <div className="speed-reset-row">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="speed-reset-button"
            data-testid="speed-reset"
            disabled={disabled || isDefaultSpeedSetting(draft)}
            onClick={handleReset}
          >
            <RotateCcw size={13} />
            {t('speed.reset')}
          </Button>
        </div>

        {processingActive && processing && processingPollState === 'unknown' && (
          <div className="speed-inspector-failed" data-testid="speed-inspector-unknown" role="status">
            <span className="speed-inspector-failed-text">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{t('speed.processing.statusUnknown')}</span>
            </span>
            {onRefreshProcessing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="speed-inspector-retry"
                data-testid="speed-inspector-refresh"
                disabled={disabled || processingBusy}
                onClick={() => onRefreshProcessing()}
              >
                <RotateCcw size={12} />
                {t('speed.processing.retry')}
              </Button>
            )}
          </div>
        )}

        {processingActive && processing && processingPollState !== 'unknown' && (
          <div className="speed-inspector-processing" data-testid="speed-inspector-processing" role="status">
            <div className="speed-inspector-processing-head">
              <span className="speed-spinner" aria-hidden="true" />
              <span className="speed-inspector-processing-label">
                {processing.status === 'queued'
                  ? t('speed.processing.clipQueued')
                  : speedProcessingActiveLabel(processing, t)}
              </span>
              {processing.status === 'running' && (
                <span className="speed-inspector-processing-percent">{processingPercent}%</span>
              )}
            </div>
            <div className="speed-inspector-progress-track">
              <span style={{width: `${processing.status === 'running' ? Math.max(2, processingPercent) : 12}%`}} />
            </div>
          </div>
        )}

        {processingFailed && processing && (
          <div className="speed-inspector-failed" data-testid="speed-inspector-failed" role="alert">
            <span className="speed-inspector-failed-text">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{speedProcessingFailureSentence(processing, t)}</span>
            </span>
            {speedProcessingCanRetry(processing) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="speed-inspector-retry"
                data-testid="speed-inspector-retry"
                disabled={disabled || processingBusy}
                onClick={() => onRetryProcessing(processing.taskId)}
              >
                <RotateCcw size={12} />
                {t('speed.processing.retry')}
              </Button>
            )}
          </div>
        )}
      </div>
    </InspectorGroup>
  );
}
