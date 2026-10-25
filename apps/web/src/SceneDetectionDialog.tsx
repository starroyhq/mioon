import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Slider } from '@mioon/ui/components/slider';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton, WorkbenchProgress, WorkbenchTabs } from '@mioon/ui/components/workbench-controls';
import { LoaderCircle, Pause, Play, RefreshCw, Scissors, StepBack, StepForward, Video, X } from '@mioon/ui/components/workbench-icons';
import { SCENE_DETECTION_DEFAULTS, SCENE_MIN_SHOT_SECONDS, SOURCE_RANGE_FPS } from '@mioon/contracts';
import type { SceneDetectionOptionsInput, SceneResult } from '@mioon/contracts';
import { message as msg } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import { assetUrl } from './api.ts';
import Icon from './icons.tsx';
import { SceneCutBar, SceneSegmentStrip } from './SceneCutBar.tsx';
import { addSceneCut, moveSceneCut, removeSceneCut, sceneAdjustments, sceneDraftFrom, sceneDraftFrames, sceneFilmstripFrames, sceneSegmentAt, sceneSegmentNumber, sceneSegments, sceneSeconds, sceneTime } from './scene-cuts.ts';
import type { SceneDraftCut, SceneSegment } from './scene-cuts.ts';
import { sceneErrorMessage, sceneSensitivityLevel, sceneTaskActive, sceneTaskCanCancel, sceneTaskPercent } from './scene-detection.ts';
import type { SceneDetectionController, SceneDetectionState, SceneDetectTask, SceneSourceAsset } from './scene-detection.ts';
import { createSceneThumbnailer } from './scene-thumbnails.ts';
import type { SceneThumbnailer } from './scene-thumbnails.ts';
import './scene-detection.css';

export interface SceneDialogAsset extends SceneSourceAsset { name: string; url?: unknown; width?: number; height?: number }
export interface SceneDetectionDialogProps {
  readonly asset: SceneDialogAsset;
  readonly state: SceneDetectionState;
  readonly controller: SceneDetectionController;
  /** Clips on the timeline that use this video. */
  readonly timelineClips: number;
  /** Why the timeline cannot be split right now; null when it can. */
  readonly splitBlocked: DisplayMessage | null;
  readonly onSplit: (assetId: string, resultId: string) => Promise<unknown>;
  /** Opened from 拆解镜头: start detecting at once when there is no valid result. */
  readonly autoStart: boolean;
  readonly onClose: () => void;
}
interface Draft { readonly resultId: string; readonly base: readonly number[]; readonly cuts: readonly SceneDraftCut[] }
const tiles = 24, segmentThumbnails = 200;
const seed = (result: SceneResult): Draft => ({ resultId: result.id, base: result.cuts.map(cut => cut.frame), cuts: sceneDraftFrom(result.cuts) });
const clampMinShot = (value: number): number => Math.min(SCENE_MIN_SHOT_SECONDS[1], Math.max(SCENE_MIN_SHOT_SECONDS[0], Math.round(value * 10) / 10));

function useAgo(): (iso: string) => DisplayMessage {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  return iso => {
    const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
    return !Number.isFinite(minutes) || minutes < 1 ? msg('scene.time.justNow') : minutes < 60 ? msg('scene.time.minutes', { count: minutes }) : msg('scene.time.hours', { count: Math.floor(minutes / 60) });
  };
}

export default function SceneDetectionDialog({ asset, state, controller, timelineClips, splitBlocked, onSplit, autoStart, onClose }: SceneDetectionDialogProps) {
  const { t, renderMessage, formatNumber } = useI18n();
  const confirm = useConfirmation(), ago = useAgo();
  const task = state.tasks.find(item => item.sourceAssetId === asset.id && sceneTaskActive(item)) ?? null;
  const latest = state.tasks.find(item => item.sourceAssetId === asset.id) ?? null;
  const view = state.results[asset.id], response = view?.response ?? null, result = response?.result ?? null, current = Boolean(response?.current);
  const pending = state.pending?.assetId === asset.id ? state.pending : null;
  const notice = state.notice && (state.notice.assetId === asset.id || state.notice.assetId === null) ? state.notice : null;
  const idle = state.phase === 'idle' && !state.pending, writable = !state.readOnly && idle;
  const url = assetUrl(asset), frameCount = result?.frameCount ?? task?.progress?.frameCount ?? Math.max(1, Math.floor(Number(asset.duration) * SOURCE_RANGE_FPS));

  useEffect(() => { void controller.loadResult(asset.id); }, [controller, asset.id, asset.sha256]);
  // A detection that finished elsewhere (or here) replaces the shown result.
  useEffect(() => { if (latest?.state === 'succeeded' && latest.result && latest.result.id !== result?.id) void controller.loadResult(asset.id); }, [controller, asset.id, latest?.id, latest?.state]);

  const [params, setParams] = useState<SceneDetectionOptionsInput>(() => ({ ...SCENE_DETECTION_DEFAULTS }));
  const touched = useRef(false);
  const knownOptions = result?.options ?? latest?.options ?? null;
  useEffect(() => { if (!touched.current && knownOptions) setParams({ ...knownOptions }); }, [knownOptions?.mode, knownOptions?.sensitivity, knownOptions?.minShotSeconds]);
  const changeParams = (patch: Partial<SceneDetectionOptionsInput>): void => { touched.current = true; setParams(value => ({ ...value, ...patch })); };
  const [minShotText, setMinShotText] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    setDraft(previous => !result ? null : previous && (previous.resultId === result.id || sceneAdjustments(previous.cuts, previous.base) > 0) ? previous : seed(result));
  }, [result?.id]);
  const adjustments = draft ? sceneAdjustments(draft.cuts, draft.base) : 0, dirty = adjustments > 0, outdated = Boolean(draft && result && draft.resultId !== result.id);
  const frames = draft ? sceneDraftFrames(draft.cuts) : result?.cuts.map(cut => cut.frame) ?? [];
  const segments = useMemo(() => sceneSegments(frames, frameCount), [frames.join(','), frameCount]);

  const video = useRef<HTMLVideoElement | null>(null);
  const [position, setPosition] = useState(0), [playing, setPlaying] = useState(false), [selected, setSelected] = useState(1);
  const segment = segments.find(item => item.index === selected) ?? segments[0] ?? null;
  const seek = (frame: number): void => { const element = video.current; setPosition(frame); if (element) { try { element.currentTime = (frame + 0.5) / SOURCE_RANGE_FPS; } catch {} } };
  const choose = (item: SceneSegment): void => { setSelected(item.index); seek(item.middle); };
  useEffect(() => { if (selected > segments.length) setSelected(Math.max(1, segments.length)); }, [segments.length]);

  const [thumbnails, setThumbnails] = useState<SceneThumbnailer | null>(null), [, setThumbnailVersion] = useState(0);
  useEffect(() => {
    if (!url) return;
    const instance = createSceneThumbnailer({ key: `${asset.id}:${asset.sha256}`, url, onUpdate: () => setThumbnailVersion(value => value + 1) });
    setThumbnails(instance);
    return () => { instance.dispose(); setThumbnails(value => value === instance ? null : value); };
  }, [asset.id, asset.sha256, url]);
  const detected = task ? task.progress?.frames ?? 0 : null;
  const tileFrames = useMemo(() => sceneFilmstripFrames(frameCount, tiles), [frameCount]);
  const decodedTiles = detected === null ? tiles : tileFrames.filter(frame => frame < detected).length;
  useEffect(() => { thumbnails?.request(tileFrames.slice(0, decodedTiles)); }, [thumbnails, tileFrames, decodedTiles]);
  useEffect(() => { if (!task) thumbnails?.request(segments.slice(0, segmentThumbnails).map(item => item.middle)); }, [thumbnails, segments, Boolean(task)]);
  useEffect(() => { if (segment && !task) thumbnails?.prioritize([segment.middle]); }, [thumbnails, segment?.middle, Boolean(task)]);
  // While detecting, the preview follows the decoded position unless the user plays it.
  useEffect(() => { if (detected !== null && !playing && Math.abs(detected - position) >= SOURCE_RANGE_FPS / 2) seek(Math.max(0, detected - 1)); }, [detected]);

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || state.readOnly || !state.tasksLoaded || view?.phase !== 'ready' || task || !idle) return;
    started.current = true;
    // The parameters effect has not re-rendered yet; start from what is known about this video.
    if (!current) void controller.detect(asset, touched.current ? params : knownOptions ?? params);
  }, [autoStart, state.readOnly, state.tasksLoaded, view?.phase, Boolean(task), idle, current]);

  const run = async (action: () => Promise<unknown>): Promise<void> => { try { await action(); } catch {} };
  const detect = (): Promise<void> => run(async () => {
    if (dirty && !await confirm(msg('scene.redetect.confirm', { count: adjustments }))) return;
    // Unsaved adjustments go only once the new detection is accepted; a refusal keeps them editable.
    if (await controller.detect(asset, params)) setDraft(result ? seed(result) : null);
  });
  const save = (): Promise<void> => run(async () => {
    if (!draft || !dirty) return;
    const cuts = sceneDraftFrames(draft.cuts), summary = await controller.saveCuts(asset, draft.resultId, cuts);
    if (summary) setDraft({ resultId: summary.id, base: cuts, cuts: cuts.map(frame => ({ frame, origin: frame })) });
  });
  const close = (): Promise<void> => run(async () => { if (!dirty || await confirm(msg('scene.close.confirm', { count: adjustments }))) onClose(); });
  const editDraft = (change: (cuts: readonly SceneDraftCut[]) => readonly SceneDraftCut[] | null): void => {
    if (!draft || !writable || !current || task) return;
    const cuts = change(draft.cuts);
    if (cuts) setDraft({ ...draft, cuts });
  };
  const splitReason = state.readOnly ? msg('scene.readOnly') : !result ? null : !current ? msg('scene.split.stale') : dirty ? msg('scene.split.saveFirst') : !timelineClips ? msg('scene.split.none') : splitBlocked;
  const sensitivityLabel = (value: number): string => { const level = sceneSensitivityLevel(value); return level === 'low' ? t('scene.sensitivity.low', { value }) : level === 'high' ? t('scene.sensitivity.high', { value }) : t('scene.sensitivity.medium', { value }); };
  const seconds = (value: number): string => formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const thumbnail = (frame: number): string | undefined => thumbnails?.get(frame);

  const requestAlert = pending ? <WorkbenchAlert tone="warning" data-testid="scene-request-unknown" actions={<><WorkbenchButton variant="secondary" size="compact" data-testid="scene-request-reconcile" disabled={state.phase !== 'unknown'} onClick={() => void controller.reconcileUnknown()}>{t('scene.request.reconcile')}</WorkbenchButton><WorkbenchButton variant="ghost" size="compact" data-testid="scene-request-retry" disabled={state.phase !== 'unknown' || state.readOnly} onClick={() => void controller.retryUnknown()}>{t('scene.request.retry')}</WorkbenchButton></>}>{renderMessage(notice?.descriptor ?? msg('scene.request.unknown'))}</WorkbenchAlert>
    : notice ? <WorkbenchAlert tone={notice.tone} data-testid="scene-notice" actions={<WorkbenchButton variant="icon" size="compact" aria-label={t('scene.notice.dismiss')} onClick={() => controller.clearNotice()}><X size={14} /></WorkbenchButton>}>{renderMessage(notice.descriptor)}</WorkbenchAlert> : null;
  const readOnlyAlert = state.readOnly ? <WorkbenchAlert tone="neutral" data-testid="scene-read-only">{t('scene.readOnly')}</WorkbenchAlert> : null;

  const preview = <div className="scene-preview">
    <div className="scene-preview-stage">{url ? <video ref={video} src={url} preload="metadata" playsInline data-testid="scene-preview-video"
      onLoadedMetadata={() => seek(position)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onTimeUpdate={event => { const frame = Math.min(frameCount - 1, Math.floor(event.currentTarget.currentTime * SOURCE_RANGE_FPS)); setPosition(frame); if (!event.currentTarget.paused && !task) { const at = sceneSegmentAt(segments, frame); if (at && at.index !== selected) setSelected(at.index); } }} /> : null}
      {task ? <span className="scene-preview-badge"><Icon name="search" size={12} />{t('scene.detecting.at', { time: sceneTime(detected ?? 0) })}</span>
        : segment && result ? <span className="scene-preview-badge"><b>{sceneSegmentNumber(segment.index)}</b>{t('scene.segment.badge', { index: segment.index })}</span> : null}</div>
    <div className="scene-transport">
      <WorkbenchButton variant="icon" data-testid="scene-preview-play" aria-label={t(playing ? 'scene.preview.pause' : 'scene.preview.play')} disabled={!url} onClick={() => { const element = video.current; if (!element) return; if (element.paused) void element.play().catch(() => setPlaying(false)); else element.pause(); }}>{playing ? <Pause size={14} /> : <Play size={14} />}</WorkbenchButton>
      <span className="scene-transport-time"><strong>{sceneTime(position)}</strong><span>{` / ${sceneTime(frameCount)}`}</span></span>
      {task ? <Slider className="scene-transport-slider" value={[Math.min(position, frameCount - 1)]} min={0} max={Math.max(1, frameCount - 1)} step={1} aria-label={t('scene.preview.position')} onValueChange={value => seek(Array.isArray(value) ? value[0] ?? 0 : value)} />
        : segment && result ? <><span className="scene-transport-segment">{t('scene.preview.segment', { index: sceneSegmentNumber(segment.index), start: sceneTime(segment.start), end: sceneTime(segment.end), seconds: seconds(sceneSeconds(segment.end - segment.start)) })}</span>
          <WorkbenchButton variant="icon" data-testid="scene-segment-previous" aria-label={t('scene.preview.previous')} disabled={segment.index <= 1} onClick={() => { const item = segments[segment.index - 2]; if (item) choose(item); }}><StepBack size={14} /></WorkbenchButton>
          <WorkbenchButton variant="icon" data-testid="scene-segment-next" aria-label={t('scene.preview.next')} disabled={segment.index >= segments.length} onClick={() => { const item = segments[segment.index]; if (item) choose(item); }}><StepForward size={14} /></WorkbenchButton></> : null}
    </div>
  </div>;

  const paramsPanel = <section className="scene-params" aria-label={t('scene.params.title')}>
    <h3>{t('scene.params.title')}</h3>
    <div className="scene-param-row"><span>{t('scene.params.mode')}</span><WorkbenchTabs value={params.mode} label={t('scene.params.mode')} onValueChange={value => changeParams({ mode: value === 'fixed' ? 'fixed' : 'adaptive' })}
      options={[{ value: 'adaptive', label: t('scene.mode.adaptive'), disabled: !writable, testId: 'scene-mode-adaptive' }, { value: 'fixed', label: t('scene.mode.fixed'), disabled: !writable, testId: 'scene-mode-fixed' }]} /></div>
    <div className="scene-param-row"><span id="scene-sensitivity-label">{t('scene.params.sensitivity')}</span><Slider className="scene-sensitivity" value={[params.sensitivity]} min={0} max={100} step={1} disabled={!writable} aria-labelledby="scene-sensitivity-label"
      onValueChange={value => changeParams({ sensitivity: Math.round(Array.isArray(value) ? value[0] ?? params.sensitivity : value) })} /><output>{params.sensitivity}</output></div>
    <div className="scene-param-row"><Label htmlFor="scene-min-shot">{t('scene.params.minShot')}</Label><div className="scene-param-input"><Input id="scene-min-shot" data-testid="scene-min-shot" type="number" inputMode="decimal" min={SCENE_MIN_SHOT_SECONDS[0]} max={SCENE_MIN_SHOT_SECONDS[1]} step={0.1} disabled={!writable}
      value={minShotText ?? String(params.minShotSeconds)} onChange={event => setMinShotText(event.target.value)}
      onBlur={() => { const value = Number(minShotText); if (minShotText !== null && Number.isFinite(value) && value > 0) changeParams({ minShotSeconds: clampMinShot(value) }); setMinShotText(null); }} /><span>{t('scene.unit.seconds')}</span></div></div>
    <div className="scene-param-actions"><WorkbenchButton variant="ghost" size="compact" data-testid="scene-redetect" disabled={!writable || Boolean(task)} title={state.readOnly ? t('scene.readOnly') : undefined} onClick={() => void detect()}><RefreshCw size={13} />{t(result ? 'scene.params.redetect' : 'scene.params.start')}</WorkbenchButton>
      {result && <span>{renderMessage(msg(result.origin === 'manual' ? 'scene.params.savedAt' : 'scene.params.detectedAt', { time: renderMessage(ago(result.createdAt)) }))}</span>}</div>
  </section>;

  const status = result && !current ? <WorkbenchAlert tone="warning" data-testid="scene-result-stale">{t(response?.staleReason === 'PROFILE_CHANGED' ? 'scene.stale.profile' : 'scene.stale.source')}</WorkbenchAlert>
    : outdated ? <WorkbenchAlert tone="warning" data-testid="scene-draft-outdated" actions={<WorkbenchButton variant="secondary" size="compact" onClick={() => result && setDraft(seed(result))}>{t('scene.draft.useLatest')}</WorkbenchButton>}>{t('scene.draft.outdated')}</WorkbenchAlert>
    : dirty ? <div className="scene-status-card" data-tone="warning" data-testid="scene-draft-dirty"><div className="scene-status-head"><strong><Icon name="pencil" size={13} />{t('scene.draft.adjusted', { count: adjustments })}</strong>
      <div className="scene-status-actions"><WorkbenchButton variant="ghost" size="compact" data-testid="scene-draft-discard" onClick={() => result && setDraft(seed(result))}>{t('scene.draft.discard')}</WorkbenchButton><WorkbenchButton variant="secondary" size="compact" data-testid="scene-draft-save" disabled={!writable} onClick={() => void save()}>{t('scene.draft.save')}</WorkbenchButton></div></div>
      <span>{t('scene.draft.redetectWarning')}</span></div>
    : result ? <div className="scene-status-card" data-testid="scene-draft-saved"><div className="scene-status-head"><strong><Icon name="check" size={13} />{t('scene.draft.saved', { count: segments.length })}</strong></div></div> : null;

  const cutsSection = result && <section className="scene-cuts-section" aria-label={t('scene.cuts.title')}>
    <header><h3>{t('scene.cuts.title')}</h3><span>{`${t('scene.cuts.count', { count: frames.length })} · ${t('scene.segments.count', { count: segments.length })}`}</span>
      {current && writable ? <span className="scene-hints"><span>{t('scene.cuts.hintAdd')}</span><span>{t('scene.cuts.hintDrag')}</span><span>{t('scene.cuts.hintRemove')}</span></span> : null}</header>
    <SceneCutBar frameCount={frameCount} cuts={draft?.cuts ?? sceneDraftFrom(result.cuts)} editable={writable && current && !outdated} selected={segment} playhead={position}
      tiles={tileFrames.map(frame => ({ frame, url: thumbnail(frame) }))} onSeek={frame => { const at = sceneSegmentAt(segments, frame); if (at) setSelected(at.index); seek(frame); }}
      onAdd={frame => editDraft(cuts => addSceneCut(cuts, frame, frameCount))} onMove={(index, frame) => editDraft(cuts => moveSceneCut(cuts, index, frame, frameCount))} onRemove={index => editDraft(cuts => removeSceneCut(cuts, index))} />
  </section>;
  const keyframes = result && <section className="scene-keyframes" aria-label={t('scene.keyframes.title')}>
    <header><h3>{t('scene.keyframes.title')}</h3><span>{t('scene.keyframes.hint')}</span></header>
    <SceneSegmentStrip segments={segments} selected={segment?.index ?? null} thumbnail={thumbnail} onSelect={choose} />
  </section>;

  const summary = task?.options ?? params;
  const detecting = task && <div className="scene-detecting">
    <section className="scene-source" aria-label={t('scene.source.title')}><header><h3>{t('scene.source.title')}</h3>{asset.width && asset.height ? <span>{`${asset.width}×${asset.height}`}</span> : null}</header>{preview}
      <dl className="scene-source-meta"><dt>{t('scene.source.duration')}</dt><dd>{sceneTime(frameCount)}</dd><dt>{t('scene.source.format')}</dt><dd>{String(asset.mimeType).replace('video/', '').toUpperCase()}</dd>{Number(asset.sizeBytes) > 0 && <><dt>{t('scene.source.size')}</dt><dd>{t('scene.source.megabytes', { size: formatNumber(Number(asset.sizeBytes) / 1048576, { maximumFractionDigits: 1 }) })}</dd></>}</dl></section>
    <section className="scene-progress" aria-live="polite" data-testid="scene-progress">
      <h3>{task.state === 'running' ? <LoaderCircle size={16} className="scene-spin" /> : <Icon name="clock" size={16} />}{task.state === 'queued' ? t('scene.detecting.queued') : task.state === 'cancelling' ? t('scene.detecting.cancelling') : t('scene.detecting.title', { percent: sceneTaskPercent(task) })}</h3>
      <div className="scene-progress-meta"><span>{t('scene.detecting.found', { count: task.progress?.cuts ?? 0 })}</span><span>{`${sceneTime(detected ?? 0)} / ${sceneTime(frameCount)}`}</span></div>
      <WorkbenchProgress value={sceneTaskPercent(task)} label={t('scene.detecting.part')} />
      <header className="scene-progress-strip"><h4>{t('scene.detecting.part')}</h4><span>{t('scene.detecting.partHint')}</span></header>
      <SceneCutBar frameCount={frameCount} cuts={[]} editable={false} detectedFrames={detected} selected={null} playhead={null} tiles={tileFrames.map(frame => ({ frame, url: thumbnail(frame) }))} />
      <dl className="scene-params-summary"><dt>{t('scene.params.mode')}</dt><dd>{t(summary.mode === 'fixed' ? 'scene.mode.fixed' : 'scene.mode.adaptive')}</dd><dt>{t('scene.params.sensitivity')}</dt><dd>{sensitivityLabel(summary.sensitivity)}</dd><dt>{t('scene.params.minShot')}</dt><dd>{t('scene.seconds', { seconds: seconds(summary.minShotSeconds) })}</dd></dl>
      <WorkbenchAlert tone="neutral" icon={<Icon name="info" size={14} />}>{t('scene.detecting.background')}</WorkbenchAlert>
      {requestAlert}{readOnlyAlert}
    </section>
  </div>;

  const failure = !task && latest && ['failed', 'interrupted'].includes(latest.state) && (!result || latest.createdAt > result.createdAt) ? latest : null;
  const results = !task && <div className="scene-results">
    <div className="scene-top">{preview}<aside className="scene-side">{paramsPanel}{requestAlert}{readOnlyAlert}{failure && <WorkbenchAlert tone="danger" data-testid="scene-task-failed">{renderMessage(msg('scene.failed', { reason: renderMessage(sceneErrorMessage(failure.errorCode)) }))}</WorkbenchAlert>}{status}
      {!result && view?.phase === 'ready' && !failure && <p className="scene-empty" data-testid="scene-empty">{t('scene.empty.hint')}</p>}
      {view?.phase === 'loading' && !result && <p className="scene-empty" role="status">{t('scene.loading')}</p>}
      {view?.phase === 'error' && <WorkbenchAlert tone="warning" actions={<WorkbenchButton variant="secondary" size="compact" onClick={() => void controller.loadResult(asset.id)}>{t('scene.reload')}</WorkbenchButton>}>{t('scene.loadFailed')}</WorkbenchAlert>}
    </aside></div>
    {cutsSection}{keyframes}
  </div>;

  return <Dialog open onOpenChange={open => { if (!open) void close(); }}>
    <DialogContent className="wb-dialog scene-dialog" data-size="large" data-testid="scene-dialog" data-view={task ? 'detecting' : result ? 'results' : 'empty'} showCloseButton={false}>
      <header className="scene-dialog-header">
        <DialogTitle>{t('scene.dialog.title')}</DialogTitle>
        <WorkbenchBadge media="video" className="scene-asset-chip" title={asset.name}><Video size={12} /><span>{asset.name}</span><span>{sceneTime(frameCount)}</span></WorkbenchBadge>
        <DialogDescription className="sr-only">{t('scene.dialog.description')}</DialogDescription>
        <span className="scene-local-chip"><Icon name="lock" size={11} />{t('scene.dialog.local')}</span>
        <WorkbenchButton variant="icon" data-testid="scene-dialog-close" aria-label={t('shell.closeDialog')} onClick={() => void close()}><X size={15} /></WorkbenchButton>
      </header>
      <div className="scene-dialog-body">{detecting || results}</div>
      <footer className="scene-dialog-footer">{task ? <>
        <span className="scene-footer-note">{state.remaining[task.id] ? t('scene.detecting.remaining', { seconds: state.remaining[task.id]! }) : null}</span>
        <WorkbenchButton variant="secondary" data-testid="scene-detect-cancel" disabled={!writable || !sceneTaskCanCancel(task)} onClick={() => void run(() => controller.cancel(task as SceneDetectTask))}>{t('scene.detecting.cancel')}</WorkbenchButton>
        <WorkbenchButton variant="primary" data-testid="scene-detect-background" onClick={() => void close()}>{t('scene.detecting.continue')}</WorkbenchButton>
      </> : <>
        <span className="scene-footer-note"><Icon name="film" size={13} />{timelineClips ? t('scene.split.clips', { count: timelineClips }) : t('scene.split.none')}</span>
        <WorkbenchButton variant="secondary" data-testid="scene-split" disabled={Boolean(splitReason) || !result || !idle} title={splitReason ? renderMessage(splitReason) : undefined} onClick={() => void run(() => result ? onSplit(asset.id, result.id) : Promise.resolve())}><Scissors size={14} />{t('scene.split.action')}</WorkbenchButton>
      </>}</footer>
    </DialogContent>
  </Dialog>;
}
