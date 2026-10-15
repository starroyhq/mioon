import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { PreviewResult } from './export-preview-state.ts';
import ExportRangeSummary from './ExportRangeSummary.tsx';

/** This player owns only its exact real output. It never drives editor playback. */
export default function ExportPreview({ result, visible, canSelect, canGenerate, onSelect, onGenerate, onBeforePlay, onRegisterMediaPause, rangeDraft, onRangeChange, preflightState, canCheck, onCheck, checkDetails }: {
  rangeDraft: { startText: string; endText: string } | null;
  onRangeChange: (draft: { startText: string; endText: string }) => void;
  checkDetails?: React.ReactNode;
  preflightState: { phase: 'idle' | 'checking' | 'ready' | 'incomplete' | 'blocked' | 'error' | 'stale'; error?: unknown } | null; canCheck: boolean; onCheck: () => void;
  result: PreviewResult; visible: boolean; canSelect: boolean; canGenerate: boolean;
  onSelect: () => void; onGenerate: () => void; onBeforePlay: () => void;
  onRegisterMediaPause: (pause: () => void) => () => void;
}) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement | null>(null), [closed, setClosed] = useState(false), [mediaError, setMediaError] = useState(false);
  useLayoutEffect(() => onRegisterMediaPause?.(() => video.current?.pause()), [onRegisterMediaPause]);
  useEffect(() => { setClosed(false); }, [result.record?.id]);
  useEffect(() => { setMediaError(false); }, [result.url]);
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
    binding.onBeforePlay();
  }
  return <section className="export-preview" data-testid="export-preview" aria-label={t('export.sample.title')}>
    <h3>{t('export.sample.title')}</h3>
    <p className="export-preflight-note">{t('export.sample.help')}</p>
    <p className="export-preflight-note">{t('export.sample.separateRange')}</p>
    <div className="export-preview-actions">
      <label>{t('export.sample.start')}<input type="number" min="0" step="1" value={rangeDraft?.startText || ''} disabled={!canSelect} onChange={event => onRangeChange({ startText: event.target.value, endText: rangeDraft?.endText || '' })} /></label>
      <label>{t('export.sample.end')}<input type="number" min="1" step="1" value={rangeDraft?.endText || ''} disabled={!canSelect} onChange={event => onRangeChange({ startText: rangeDraft?.startText || '', endText: event.target.value })} /></label>
    </div>
    <div className="export-preview-actions">
      <Button variant="ghost" className="button" disabled={!canSelect} onClick={onSelect} data-testid="export-preview-select">{t('export.sample.select')}</Button>
      <Button variant="ghost" className="button" disabled={!canCheck || preflightState?.phase === 'checking'} onClick={onCheck} data-testid="export-preview-check">{t('export.sample.check')}</Button>
      <Button variant="ghost" className="button" disabled={!canGenerate} onClick={onGenerate} data-testid="export-preview-generate">{t('export.sample.generate')}</Button>
    </div>
    {preflightState && preflightState.phase !== 'idle' && <p role="status">{t('export.sample.checkState', { state: t(`export.preflight.phase.${preflightState.phase}`) })}</p>}
    {checkDetails}
    {result.phase !== 'idle' && <>
      <p role="status" aria-live="polite" data-testid="export-preview-status">{t(`export.sample.phase.${result.phase}`)}</p>
      {result.stale && <p className="notice warning" data-testid="export-preview-stale">{t('export.sample.stale')}</p>}
      {result.record && <><ExportRangeSummary input={result.record.snapshot} snapshot testId="export-preview-range" /><small className="export-frozen-settings">{t('export.sample.receipt', { id: result.record.id })}</small></>}
      {result.url && visible && !closed && <video ref={video} key={result.url} src={result.url} controls preload="metadata" playsInline onPlay={guardPlayback} onPlaying={guardPlayback} onError={() => setMediaError(true)} data-testid="export-preview-player" />}
      {mediaError && <p className="notice warning">{t('export.sample.mediaError')}</p>}
      {result.url && <Button variant="ghost" className="button" onClick={() => setClosed(value => !value)}>{t(closed ? 'export.sample.reopen' : 'export.sample.close')}</Button>}
      <p className="export-preflight-note">{t('export.sample.retained')}</p>
    </>}
  </section>;
}
