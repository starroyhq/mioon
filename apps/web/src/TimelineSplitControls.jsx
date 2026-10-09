import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.jsx';

export default function TimelineSplitControls({ state, onSplit }) {
  return <div className="timeline-split-controls" role="group" aria-label="分割所选片段">
    <Button variant="ghost" className="button small" data-testid="timeline-split" disabled={!state.canSplit} onClick={onSplit} aria-keyshortcuts="Control+B Meta+B" aria-label={`分割所选片段：${state.clipName}，播放头 ${state.atFrame} 帧`} title={state.blockedReason || `分割为 ${state.leftDuration} + ${state.rightDuration} 帧 · Ctrl/⌘+B · 不移动其他片段`}><Icon name="scissors" size={13} />分割</Button>
    <span className="timeline-split-target" data-testid="timeline-split-target" title={state.blockedReason || `${state.clipName} · 在第 ${state.atFrame} 帧分割`}><span>{state.clipName}</span><b> @ {state.atFrame}f</b></span>
  </div>;
}
