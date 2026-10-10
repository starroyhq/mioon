import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { WAVEFORM_BACKGROUND_NOTICE, WAVEFORM_DISCLOSURE, WAVEFORM_LIMITS, waveformCoverageWidth, waveformPath, waveformStatusText } from './waveform-state.js';

export function TimelineWaveformControls({ state, disabled }) {
  const entries = [...state.entries.values()];
  const visibleKeys = new Set(state.windows.slice(0, WAVEFORM_LIMITS.entries).map(item => item.key));
  const visibleEntries = entries.filter(entry => visibleKeys.has(entry.key));
  const clipped = visibleEntries.some(entry => entry.status === 'ready' && entry.clipped);
  const loading = visibleEntries.some(entry => ['loading', 'queued', 'running'].includes(entry.status));
  const issue = visibleEntries.find(entry => ['error', 'interrupted', 'unsupported', 'missing'].includes(entry.status) && entry.phase === 'idle');
  const status = !state.enabled ? '本次会话默认关闭' : state.windows.length > WAVEFORM_LIMITS.entries ? '仅显示前32个可见片段波形' : state.autoLimitReached && issue?.status === 'missing' ? '已达64个素材，请手动重试' : loading ? '仅分析可见片段…' : issue ? waveformStatusText(issue) : state.windows.length ? '原始源音轨 · 固定满刻度' : '当前视区无已确认音轨';
  return <div className="timeline-waveform-controls">
    <Button variant="ghost" className={`button small timeline-waveform-toggle ${state.enabled ? 'active' : ''}`} data-testid="timeline-waveform-toggle" aria-pressed={state.enabled} aria-describedby="timeline-waveform-disclosure" disabled={disabled} title={`${WAVEFORM_DISCLOSURE}。${WAVEFORM_BACKGROUND_NOTICE}`} onClick={() => state.setEnabled(!state.enabled)}>波形{state.enabled ? '开' : '关'}</Button>
    <span className="timeline-waveform-status" role="status" aria-live="polite" data-testid="timeline-waveform-status" title={`${status}。${WAVEFORM_DISCLOSURE}。${WAVEFORM_BACKGROUND_NOTICE}`}>{status}</span>
    {state.enabled && clipped && <span className="timeline-waveform-clipped" data-testid="timeline-waveform-clipped" title="原始源音轨检测到满刻度峰值；不反映片段音量、静音或淡入/淡出">满刻度峰值</span>}
    {state.enabled && state.retryable && <Button variant="ghost" className="button small timeline-waveform-retry" data-testid="timeline-waveform-retry" title="先查询状态，仅在仍未完成时重试可见片段" onClick={state.retry}>重试波形</Button>}
    <span className="sr-only" id="timeline-waveform-disclosure">{WAVEFORM_DISCLOSURE}。{WAVEFORM_BACKGROUND_NOTICE} 每次打开项目默认关闭，仅在手动开启后按可见片段分析。</span>
  </div>;
}

export default function TimelineWaveform({ window: range, entry }) {
  if (!range) return null;
  const status = waveformStatusText(entry);
  // Crop to actual decoded time without rescaling the requested bin spacing.
  const width = entry?.status === 'ready' ? waveformCoverageWidth(range, entry.decodedSampleFrames) : range.width;
  return <span className={`timeline-waveform ${entry?.status === 'ready' ? 'is-ready' : 'is-pending'}`} style={{ left: range.left, width }} data-testid={`timeline-waveform-${range.clipId}`} data-waveform-status={entry?.status || 'missing'} aria-hidden="true" title={status}>
    {entry?.status === 'ready' ? <svg style={{ width: range.width }} viewBox={`0 0 ${Math.max(1, entry.peaks.length)} 20`} preserveAspectRatio="none" focusable="false"><path d={waveformPath(entry.peaks)} /></svg> : <span className="timeline-waveform-placeholder">{status}</span>}
  </span>;
}
