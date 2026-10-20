import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { PreviewResult } from './export-preview-state.ts';
import {useExportWorkflowStep,useExportWorkflowMedia} from './ExportWorkflow.tsx';
import Icon from './icons.tsx';
import ExportRangeSummary from './ExportRangeSummary.tsx';

/** This player owns only its exact real output. It never drives editor playback. */
export default function ExportPreview({ result, visible, canSelect, canGenerate, onSelect, onGenerate, onBeforePlay, onRegisterMediaPause, rangeDraft, onRangeChange, preflightState, canCheck, onCheck, checkDetails }: {
  rangeDraft: { startText: string; endText: string } | null;
  onRangeChange: (draft: { startText: string; endText: string }) => void;
  checkDetails?: React.ReactNode;
  preflightState: { phase: 'idle' | 'checking' | 'ready' | 'incomplete' | 'blocked' | 'error' | 'stale'; error?: unknown } | null; canCheck: boolean; onCheck: () => void;
  result: PreviewResult; visible: boolean; canSelect: boolean; canGenerate: boolean;
  onSelect: () => void; onGenerate: () => void | Promise<unknown>; onBeforePlay: () => void;
  onRegisterMediaPause: (pause: () => void) => () => void;
}) {
  const { t } = useI18n(), step=useExportWorkflowStep(), formal=useExportWorkflowMedia();
  const formalRecord=formal.record;
  if(step>=4)result=step===5&&formal.enabled&&formalRecord?{phase:'succeeded',record:null,stale:false,url:formalRecord.url||(formalRecord.assetId?`/media/${formalRecord.assetId}`:null)}:{phase:'idle',record:null,stale:false,url:null};
  const video = useRef<HTMLVideoElement | null>(null), [closed, setClosed] = useState(false), [mediaError, setMediaError] = useState(false), [playing,setPlaying]=useState(false),[playhead,setPlayhead]=useState(0),[duration,setDuration]=useState(0);
  const [requesting, setRequesting] = useState(false), generationFlight = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => onRegisterMediaPause?.(() => video.current?.pause()), [onRegisterMediaPause]);
  useEffect(() => { setClosed(false); }, [result.record?.id,result.url]);
  useEffect(() => { setMediaError(false);setPlayhead(0);setDuration(0);setPlaying(false); }, [result.url]);
  const live = useRef({ visible, closed, url: result.url, onBeforePlay });
  useLayoutEffect(() => { live.current = { visible, closed, url: result.url, onBeforePlay }; });
  useLayoutEffect(() => {
    const element = video.current;
    if (!visible || closed || !result.url) element?.pause();
    return () => { element?.pause(); };
  }, [visible, closed, result.url]);
  useEffect(() => {
    const pause = () => video.current?.pause();
    const visibility = () => { if (document.visibilityState === 'hidden') pause(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pause);
    return () => { pause(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pause); };
  }, []);
  function guardPlayback(event: React.SyntheticEvent<HTMLVideoElement>) {
    const element = event.currentTarget, binding = live.current;
    if (element !== video.current || !binding.visible || binding.closed || !binding.url || element.getAttribute('src') !== binding.url || document.visibilityState === 'hidden') { element.pause(); return; }
    binding.onBeforePlay();setPlaying(true);
  }
  const playable=Boolean(result.url&&visible&&!closed), controlsEnabled=playable&&!mediaError;
  const preparing = preflightState?.phase === 'checking' || requesting;
  const running = ['submitting', 'queued', 'running'].includes(result.phase);
  const canRequest = canGenerate && !preparing && !running && result.phase !== 'unknown';
  // A retained control must not dispatch through a newer render's owner. The
  // application repeats the project/intent checks after its asynchronous check.
  const actions = { visible, step, canRequest, canSelect, canCheck, onGenerate, onSelect, onCheck, onRangeChange };
  const currentActions = useRef(actions);
  useLayoutEffect(() => { currentActions.current = actions; });
  const actionCurrent = () => currentActions.current === actions && actions.visible && actions.step <= 3;
  async function generateSample() {
    if (!actionCurrent() || !actions.canRequest || generationFlight.current) return;
    generationFlight.current = true; setRequesting(true);
    try { await actions.onGenerate(); }
    finally { generationFlight.current = false; if (mounted.current) setRequesting(false); }
  }
  const currentMedia=()=>{const element=video.current,binding=live.current;return element&&binding.visible&&!binding.closed&&binding.url&&element.getAttribute('src')===binding.url&&document.visibilityState!=='hidden'?element:null;};
  const time=(seconds:number)=>`${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
  function togglePlayback(){const element=currentMedia();if(!element)return;if(element.paused){void element.play().catch(()=>{if(currentMedia()===element)setMediaError(true);});}else element.pause();}
  return <section className="export-preview" data-testid="export-preview" aria-label={t(step===5?'redesign.export.finishedPreview':step===4?'redesign.export.encodingPreview':'redesign.export.samplePreview')}>
    <h3>{t(step===5?'redesign.export.finishedPreview':step===4?'redesign.export.encodingPreview':'redesign.export.samplePreview')}</h3>
    <div className="export-preview-stage">
      {result.phase !== 'idle' && result.url && visible && !closed ? <video ref={video} key={result.url} src={result.url} preload="metadata" playsInline onPlay={guardPlayback} onPlaying={guardPlayback} onPause={event=>{if(event.currentTarget===video.current)setPlaying(false);}} onLoadedMetadata={event=>{if(currentMedia()===event.currentTarget)setDuration(Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration:0);}} onTimeUpdate={event=>{if(currentMedia()===event.currentTarget)setPlayhead(event.currentTarget.currentTime);}} onError={event=>{if(event.currentTarget===video.current&&live.current.url===event.currentTarget.getAttribute('src'))setMediaError(true);}} data-testid="export-preview-player" /> : <div className="export-preview-placeholder">
        <p>{t(step===4?'redesign.export.encodingPreviewHelp':step===5?'redesign.export.finishedPreviewUnavailable':'export.sample.emptyPlayer')}</p>
        {step<=3 && (closed && result.url ? <Button className="button primary" onClick={() => { if (actionCurrent()) setClosed(false); }}>{t('export.sample.reopen')}</Button> : <Button className="button primary" disabled={!canRequest || !visible} onClick={generateSample} data-testid="export-preview-empty-generate">{preparing && <span className="spinner" aria-hidden="true" />}{t(preparing?'redesign.export.samplePreparing':running?'redesign.export.sampleRendering':'redesign.export.generateSample')}</Button>)}
      </div>}
    </div>
    <div className="export-player-controls"><Button variant="ghost" className="icon-button" disabled={!controlsEnabled} onClick={togglePlayback} aria-label={t(playing?'redesign.export.pause':'redesign.export.play')} data-testid="export-preview-play"><Icon name={playing?'pause':'play'} size={14}/></Button><output>{time(playhead)}</output><input type="range" aria-label={t('redesign.export.seek')} min="0" max={duration||0} step="0.1" value={Math.min(playhead,duration)} disabled={!controlsEnabled||!duration} onChange={event=>{const element=currentMedia();if(element)element.currentTime=Math.max(0,Math.min(duration,Number(event.currentTarget.value)));}}/><output>{time(duration)}</output></div>
    {step<=3 && <>
      <div className="export-sample-range" data-testid="export-preview-range-controls">
        <span>{t('redesign.export.sampleRange')}</span>
        <label><span className="sr-only">{t('export.sample.start')}</span><input type="number" min="0" step="1" placeholder="0" value={rangeDraft?.startText || ''} disabled={!canSelect || requesting || !visible} onChange={event => { if (actionCurrent() && actions.canSelect && !generationFlight.current) actions.onRangeChange({ startText: event.target.value, endText: rangeDraft?.endText || '' }); }} /></label>
        <span aria-hidden="true">–</span>
        <label><span className="sr-only">{t('export.sample.end')}</span><input type="number" min="1" step="1" placeholder="300" value={rangeDraft?.endText || ''} disabled={!canSelect || requesting || !visible} onChange={event => { if (actionCurrent() && actions.canSelect && !generationFlight.current) actions.onRangeChange({ startText: rangeDraft?.startText || '', endText: event.target.value }); }} /></label>
        <Button className="button" disabled={!canRequest || !visible} onClick={generateSample} data-testid="export-preview-generate">{t(preparing?'redesign.export.samplePreparing':running?'redesign.export.sampleRendering':'redesign.export.generateSampleCompact')}</Button>
      </div>
      <p className="export-sample-note">{t('redesign.export.sampleScope')}</p>
      {preparing && <p role="status" className="export-sample-status">{t('redesign.export.samplePreparing')}</p>}
      {result.phase !== 'idle' && <p role="status" aria-live="polite" className="export-sample-status" data-testid="export-preview-status">{t(`export.sample.phase.${result.phase}`)}</p>}
      {result.stale && <p className="notice warning" data-testid="export-preview-stale">{t('redesign.export.sampleStale')}</p>}
      {mediaError && <p className="notice warning">{t('export.sample.mediaError')}</p>}
      <details className="export-settings-help export-sample-details" data-testid="export-preview-details" open={['blocked', 'error'].includes(preflightState?.phase || '') || undefined}>
        <summary>{t('redesign.export.details')}</summary>
        <div className="export-preview-actions">
          <Button variant="ghost" className="button" disabled={!canSelect || requesting || !visible} onClick={() => { if (actionCurrent() && actions.canSelect && !generationFlight.current) actions.onSelect(); }} data-testid="export-preview-select">{t('export.sample.select')}</Button>
          <Button variant="ghost" className="button" disabled={!canCheck || preparing || !visible} onClick={() => { if (actionCurrent() && actions.canCheck && !generationFlight.current) actions.onCheck(); }} data-testid="export-preview-check">{t('export.sample.check')}</Button>
        </div>
        {preflightState && preflightState.phase !== 'idle' && <p role="status">{t('export.sample.checkState', { state: t(`export.preflight.phase.${preflightState.phase}`) })}</p>}
        {checkDetails}
        <p className="export-preflight-note">{t('export.sample.help')}</p>
        {result.record && <><ExportRangeSummary input={result.record.snapshot} snapshot testId="export-preview-range" /><small className="export-frozen-settings">{t('export.sample.receipt', { id: result.record.id })}</small></>}
        {result.url && <Button variant="ghost" className="button" onClick={() => { if (actionCurrent()) setClosed(value => !value); }}>{t(closed ? 'export.sample.reopen' : 'export.sample.close')}</Button>}
        <p className="export-preflight-note">{t('export.sample.retained')}</p>
      </details>
    </>}
  </section>;
}
