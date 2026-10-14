import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Slider } from '@mioon/ui/components/slider';
import type { TimelineAudioPreviewState, TimelineAudioPreviewView } from './use-timeline-audio-preview.ts';

export interface TimelineAudioPreviewProps { audioPreview: TimelineAudioPreviewView; startFrame: number }
export function formatTimelineAudioFrame(frame: number): string {
  const value = Number.isSafeInteger(frame) && frame >= 0 ? frame : 0;
  return `${String(Math.floor(value / 1800)).padStart(2, '0')}:${String(Math.floor(value / 30) % 60).padStart(2, '0')}:${String(value % 30).padStart(2, '0')}`;
}
export function timelineAudioPreviewStatus(state: TimelineAudioPreviewState): string {
  if (state.retirement === 'failed') return '上一次声音资源未能确认释放，已阻止再次准备。请重新打开编辑器后再试。';
  if (state.retirement === 'closing') return '正在释放上一次声音资源，确认完成后可明确重新准备。';
  if (state.restored) return '恢复分支暂不支持已保存时间线声音试听。';
  if (!state.connected) return '连接恢复后可明确准备声音。';
  if (!state.visible) return '试听面板隐藏后已释放声音，请重新准备。';
  if (state.nativeAdmission === 'blocked') return '上一窗口的声音资源尚未确认释放，当前试听已被阻止。';
  if (state.nativeAdmission === 'waiting') return '正在等待另一窗口释放声音资源，尚未开始准备当前声音。';
  if (state.error) return state.error;
  if (state.phase === 'preparing') return state.totalSources ? `正在准备完整区间的声音 ${state.preparedSources}/${state.totalSources}…` : '正在核对已保存区间与声音容量…';
  if (state.phase === 'starting') return '正在启动声音播放…';
  if (state.phase === 'playing') return '正在播放本区间的声音。';
  if (state.phase === 'paused') return '声音已暂停，可继续或在本区间定位。';
  if (state.phase === 'ended') return '本区间已结束；这不代表整条时间线已播放完。';
  if (state.phase === 'ready') return state.plan?.sources.length ? '完整区间已准备，请明确播放。' : '本区间为静音；已准备，可明确播放。';
  if (state.phase === 'cancelled') return '声音已释放，需要时请重新准备。';
  return '从当前播放头准备声音，每次最多 20 秒。';
}

/** The rendered/source video controls remain a separate, mutually exclusive
 * player. This compact panel never displays that video as synchronized audio. */
export default function TimelineAudioPreview({ audioPreview, startFrame }: TimelineAudioPreviewProps) {
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
  return <section className="timeline-audio-preview" data-testid="timeline-audio-preview" aria-label="已保存时间线声音试听" style={{ minWidth: 0, maxWidth: '100%' }}>
    <div className="timeline-audio-preview-heading"><strong>声音试听</strong><span>仅声音 · 已保存 rev {state.revision ?? '—'}</span></div>
    <p data-testid="timeline-audio-preview-range">{hasRange ? <>区间 [{formatTimelineAudioFrame(from)}, {formatTimelineAudioFrame(to)}) · 帧 {from}–{to} · 最多 20 秒</> : state.durationFrames <= 0 ? '已保存时间线暂无可试听区间。' : '当前播放头不在已保存时间线内，暂无可准备区间。'}</p>
    {state.hasUnsavedDrafts && <p className="notice warning" data-testid="timeline-audio-preview-draft-warning">尚未保存的编辑不包含在试听中；草稿会保留。</p>}
    <div className="timeline-audio-preview-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
      <Button type="button" variant="outline" size="sm" data-testid="timeline-audio-preview-prepare" disabled={!enabled || !canRequest || preparing || state.retirement !== 'none'}
        style={{ height: 'auto', minWidth: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
        onClick={() => { if (canRequest) void controller.prepare(requested, state); }}>{prepared ? '重新准备当前区间' : '准备当前区间'}</Button>
      {preparing ? <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-cancel" onClick={() => controller.cancel(state)}>取消准备</Button> : <>
        <Button type="button" variant="outline" size="sm" data-testid="timeline-audio-preview-play" disabled={!enabled || !prepared || playing}
          onClick={() => { void controller.play(state); }}>{state.phase === 'paused' ? '继续播放' : state.phase === 'ended' ? '重播本区间' : '播放本区间'}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-pause" disabled={!playing} onClick={() => controller.pause(state)}>暂停</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="timeline-audio-preview-stop" disabled={!prepared} onClick={() => controller.stop(state)}>停止并释放</Button>
      </>}
    </div>
    {prepared && <label className="timeline-audio-preview-position" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span>本区间定位</span><Slider min={from} max={to} step={1} value={[position]} disabled={!enabled || state.phase === 'starting'}
        aria-label="声音试听区间定位" aria-valuetext={`${formatTimelineAudioFrame(position)}，第 ${position} 帧`} data-testid="timeline-audio-preview-seek"
        style={{ flex: '1 1 120px', minWidth: 0, maxWidth: '100%' }} onValueChange={value => controller.seek(Array.isArray(value) ? value[0]! : value, state)} />
      <output aria-live="off" data-testid="timeline-audio-preview-position">{formatTimelineAudioFrame(position)}</output>
    </label>}
    <p role="status" aria-live="polite" aria-atomic="true" data-testid="timeline-audio-preview-status">{timelineAudioPreviewStatus(state)}</p>
    <p className="input-hint">已渲染视频单独播放，不与此声音试听同步。48 kHz 双声道；不做响度归一化或限幅。试听采用浮点混音，旧版 16 位导出可能在混音中削波；float-v2 导出会拒绝超过满幅的混音。</p>
  </section>;
}
