import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { Locale, DisplayMessage } from '../../../packages/i18n/src/types.ts';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Slider } from '@mioon/ui/components/slider';
import type { TimelineAudioPreviewState, TimelineAudioPreviewView } from './use-timeline-audio-preview.ts';

export interface TimelineAudioPreviewProps { audioPreview: TimelineAudioPreviewView; startFrame: number }
export function formatTimelineAudioFrame(frame: number): string {
  const value = Number.isSafeInteger(frame) && frame >= 0 ? frame : 0;
  return `${String(Math.floor(value / 1800)).padStart(2, '0')}:${String(Math.floor(value / 30) % 60).padStart(2, '0')}:${String(value % 30).padStart(2, '0')}`;
}
export function timelineAudioPreviewStatusMessage(state: TimelineAudioPreviewState): DisplayMessage {
  if (state.retirement === 'failed') return message('audio.preview.retirementFailed');
  if (state.retirement === 'closing') return message('audio.preview.retirementClosing');
  if (state.restored) return message('audio.preview.restored');
  if (!state.connected) return message('audio.preview.offline');
  if (!state.visible) return message('audio.preview.hidden');
  if (state.nativeAdmission === 'blocked') return message('audio.preview.nativeBlocked');
  if (state.nativeAdmission === 'waiting') return message('audio.preview.nativeWaiting');
  if (state.error) return state.errorMessage || message('audio.preview.error.failed');
  if (state.phase === 'preparing') return state.totalSources ? message('audio.preview.preparing', { prepared: state.preparedSources, total: state.totalSources }) : message('audio.preview.checking');
  if (state.phase === 'starting') return message('audio.preview.starting');
  if (state.phase === 'playing') return message('audio.preview.playing');
  if (state.phase === 'paused') return message('audio.preview.paused');
  if (state.phase === 'ended') return message('audio.preview.ended');
  if (state.phase === 'ready') return state.plan?.sources.length ? message('audio.preview.ready') : message('audio.preview.silentReady');
  if (state.phase === 'cancelled') return message('audio.preview.released');
  return message('audio.preview.idle');
}

export function timelineAudioPreviewStatus(state: TimelineAudioPreviewState, locale: Locale = 'zh-Hans'): string { return renderMessage(locale, timelineAudioPreviewStatusMessage(state)); }

/** The rendered/source video controls remain a separate, mutually exclusive
 * player. This compact panel never displays that video as synchronized audio. */
export default function TimelineAudioPreview({ audioPreview, startFrame }: TimelineAudioPreviewProps) {
  const { t, renderMessage } = useI18n();
  const { state, controller } = audioPreview;
  const requested = startFrame;
  const canRequest = Number.isSafeInteger(requested) && requested >= 0 && requested < state.durationFrames;
  const from = state.plan?.range.startFrame ?? state.requestedStartFrame ?? requested;
  const to = state.plan?.range.endFrame ?? (Number.isSafeInteger(from) && from >= 0 && from < state.durationFrames ? Math.min(from + 600, state.durationFrames) : from);
  const hasRange = Number.isSafeInteger(from) && from >= 0 && to > from;
  const enabled = state.connected && state.visible && !state.restored && Boolean(state.projectId && state.timelineId && state.revision && state.scope) && state.durationFrames > 0;
  const preparing = state.phase === 'preparing', playing = state.phase === 'playing' || state.phase === 'starting';
  const prepared = state.plan !== null && ['ready', 'starting', 'playing', 'paused', 'ended'].includes(state.phase);
  const position = Math.max(from, Math.min(to, state.positionFrame ?? from));
  return <section className="timeline-audio-preview" data-testid="timeline-audio-preview" aria-label={t('audio.preview.region')} style={{ minWidth: 0, maxWidth: '100%' }}>
    <div className="timeline-audio-preview-heading"><strong>{t('audio.preview.title')}</strong><span>{t('audio.preview.revision', { revision: state.revision ?? '—' })}</span></div>
    <p data-testid="timeline-audio-preview-range">{hasRange ? t('audio.preview.range', { fromTime: formatTimelineAudioFrame(from), toTime: formatTimelineAudioFrame(to), from, to }) : state.durationFrames <= 0 ? t('audio.preview.empty') : t('audio.preview.outside')}</p>
    {state.hasUnsavedDrafts && <p className="notice warning" data-testid="timeline-audio-preview-draft-warning">{t('audio.preview.draftWarning')}</p>}
    <div className="timeline-audio-preview-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
      <Button type="button" variant="outline" size="sm" data-testid="timeline-audio-preview-prepare" disabled={!enabled || !canRequest || preparing || state.retirement !== 'none'}
        style={{ height: 'auto', minWidth: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
        onClick={() => { if (canRequest) void controller.prepare(requested, state); }}>{prepared ? t('audio.preview.prepareAgain') : t('audio.preview.prepare')}</Button>
      {preparing ? <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-cancel" onClick={() => controller.cancel(state)}>{t('audio.preview.cancel')}</Button> : <>
        <Button type="button" variant="outline" size="sm" data-testid="timeline-audio-preview-play" disabled={!enabled || !prepared || playing}
          onClick={() => { void controller.play(state); }}>{state.phase === 'paused' ? t('audio.preview.resume') : state.phase === 'ended' ? t('audio.preview.replay') : t('audio.preview.play')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-pause" disabled={!playing} onClick={() => controller.pause(state)}>{t('audio.preview.pause')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-stop" disabled={!prepared} onClick={() => controller.stop(state)}>{t('audio.preview.stop')}</Button>
      </>}
    </div>
    {prepared && <label className="timeline-audio-preview-position" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span>{t('audio.preview.position')}</span><Slider min={from} max={to} step={1} value={[position]} disabled={!enabled || state.phase === 'starting'}
        aria-label={t('audio.preview.seek')} aria-valuetext={t('audio.preview.positionValue', { time: formatTimelineAudioFrame(position), frame: position })} data-testid="timeline-audio-preview-seek"
        style={{ flex: '1 1 120px', minWidth: 0, maxWidth: '100%' }} onValueChange={value => controller.seek(Array.isArray(value) ? value[0]! : value, state)} />
      <output aria-live="off" data-testid="timeline-audio-preview-position">{formatTimelineAudioFrame(position)}</output>
    </label>}
    <p role="status" aria-live="polite" aria-atomic="true" data-testid="timeline-audio-preview-status">{renderMessage(timelineAudioPreviewStatusMessage(state))}</p>
    <p className="input-hint">{t('audio.preview.disclosure')}</p>
  </section>;
}
