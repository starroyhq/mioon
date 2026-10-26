import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import {AudioLines} from '@mioon/ui/components/workbench-icons';
import { Button } from '@mioon/ui/components/button';
import { WAVEFORM_LIMITS, waveformCoverageWidth, waveformPath, waveformStatusMessage } from './waveform-state.ts';
import type { WaveformEntry, WaveformWindow } from './waveform-state.ts';
export interface WaveformControlsState {
  entries: ReadonlyMap<string, WaveformEntry>;
  windows: readonly WaveformWindow[];
  enabled: boolean;
  readOnly?: boolean;
  autoLimitReached?: boolean;
  retryable: boolean;
  setEnabled(value: boolean): void;
  retry(): void;
}

export function TimelineWaveformControls({ state, disabled }: {state: WaveformControlsState; disabled?: boolean}) {
  const { t, renderMessage } = useI18n();
  const disclosure = t('audio.waveform.disclosure'), background = t('audio.waveform.background');
  const entries: WaveformEntry[] = [...state.entries.values()];
  const visibleKeys = new Set(state.windows.slice(0, WAVEFORM_LIMITS.entries).map((item: WaveformWindow) => item.key));
  const visibleEntries = entries.filter(entry => visibleKeys.has(entry.key));
  const clipped = visibleEntries.some(entry => entry.status === 'ready' && entry.clipped);
  const loading = !state.readOnly && visibleEntries.some(entry => ['loading', 'queued', 'running'].includes(entry.status));
  const issue = visibleEntries.find(entry => ['error', 'interrupted', 'unsupported', 'missing'].includes(entry.status) && entry.phase === 'idle');
  const status = state.readOnly ? t('audio.waveform.readOnly') : !state.enabled ? t('audio.waveform.defaultOff') : state.windows.length > WAVEFORM_LIMITS.entries ? t('audio.waveform.visibleLimit') : state.autoLimitReached && issue?.status === 'missing' ? t('audio.waveform.attemptLimit') : loading ? t('audio.waveform.visibleOnly') : issue ? renderMessage(waveformStatusMessage(issue)) : state.windows.length ? t('audio.waveform.sourceScale') : t('audio.waveform.noAudio');
  return <div className="timeline-waveform-controls">
    <Button variant="ghost" className={`button small timeline-waveform-toggle ${state.enabled ? 'active' : ''}`} data-testid="timeline-waveform-toggle" aria-pressed={state.enabled} aria-describedby="timeline-waveform-disclosure" disabled={disabled} title={state.readOnly ? status : `${disclosure}. ${background}`} onClick={() => state.setEnabled(!state.enabled)}><AudioLines size={15} />{t(state.readOnly ? (state.enabled ? 'audio.waveform.savedOn' : 'audio.waveform.savedOff') : (state.enabled ? 'audio.waveform.on' : 'audio.waveform.off'))}</Button>
    <span className="timeline-waveform-status" data-text-selectable role="status" aria-live="polite" data-testid="timeline-waveform-status" title={`${status}. ${disclosure}. ${background}`}>{status}</span>
    {state.enabled && clipped && <span className="timeline-waveform-clipped" data-testid="timeline-waveform-clipped" title={t('audio.waveform.clippedHint')}>{t('audio.waveform.clipped')}</span>}
    {state.enabled && state.retryable && <Button variant="ghost" className="button small timeline-waveform-retry" data-testid="timeline-waveform-retry" title={t('audio.waveform.retryHint')} onClick={state.retry}>{t('audio.waveform.retry')}</Button>}
    <span className="sr-only" id="timeline-waveform-disclosure">{disclosure}. {background} {t('audio.waveform.defaultDisclosure')}</span>
  </div>;
}

export default function TimelineWaveform({ window: range, entry }: {window?: WaveformWindow | null; entry?: WaveformEntry | null}) {
  const { renderMessage } = useI18n();
  if (!range) return null;
  const status = renderMessage(waveformStatusMessage(entry));
  // Crop to actual decoded time without rescaling the requested bin spacing.
  const width = entry?.status === 'ready' ? waveformCoverageWidth(range, entry.decodedSampleFrames) : range.width;
  return <span className={`timeline-waveform ${entry?.status === 'ready' ? 'is-ready' : 'is-pending'}`} style={{ left: range.left, width }} data-testid={`timeline-waveform-${range.clipId}`} data-waveform-status={entry?.status || 'missing'} aria-hidden="true" title={status}>
    {entry?.status === 'ready' ? <svg style={{ width: range.width }} viewBox={`0 0 ${Math.max(1, entry.peaks?.length ?? 1)} 20`} preserveAspectRatio="none" focusable="false"><path d={waveformPath(entry.peaks)} /></svg> : <span className="timeline-waveform-placeholder">{status}</span>}
  </span>;
}
