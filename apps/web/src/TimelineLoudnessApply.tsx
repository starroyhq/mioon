import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { TIMELINE_LOUDNESS_APPLY_LIMITATION, timelineLoudnessCanReview } from './timeline-loudness-apply-state.ts';
import type { TimelineLoudnessApplyView } from './timeline-loudness-apply-state.ts';
import type { TimelineMixLoudnessState } from './timeline-mix-loudness-state.ts';
export interface TimelineLoudnessApplyProps { readonly apply: TimelineLoudnessApplyView; readonly observation: TimelineMixLoudnessState; readonly onOpenTasks: () => void }
export default function TimelineLoudnessApply({ apply, observation, onOpenTasks }: TimelineLoudnessApplyProps) {
  const { state, controller } = apply, pending = state.phase === 'submitting' || state.phase === 'unknown';
  if (!observation.scope || !observation.projectId || observation.restored || !observation.visible) return null;
  const owned = state.scope === observation.scope && state.projectId === observation.projectId;
  const canReview = timelineLoudnessCanReview(observation) && (!owned || !['digesting', 'confirming', 'submitting', 'unknown'].includes(state.phase) && (!['error', 'applied'].includes(state.phase) || state.observationVersion !== observation.version));
  if (!observation.report && !owned) return null;
  const message = !owned ? '' : state.phase === 'digesting' ? '正在绑定本次报告与候选…' : state.phase === 'confirming' ? '等待确认本次固定增益编辑。' :
    state.phase === 'submitting' ? '原请求正在准备、重新核验并应用，请等待确认。' : state.phase === 'unknown' ? '应用结果待确认。原请求保留在任务中心，请恢复同一请求；不会生成新的应用编号。' :
    state.phase === 'applied' ? '固定增益已作为一次时间线编辑保存，可用一次撤销恢复。请明确导出并重新测量成片。' : state.phase === 'stale' ? '本次确认已失效，请重新准备并核对候选。' : state.error;
  return <section data-testid="timeline-loudness-apply" aria-label="应用固定增益候选">
    <p className="export-sample-peak-limitation">{TIMELINE_LOUDNESS_APPLY_LIMITATION}</p>
    <Button type="button" variant="ghost" className="button quiet small" data-testid="timeline-loudness-apply-review" disabled={!canReview}
      onClick={() => { void controller.review(observation); }}>核对并应用固定增益</Button>
    {message && <p role="status" aria-live="polite" data-testid="timeline-loudness-apply-status">{message}</p>}
    {owned && pending && <Button type="button" variant="ghost" className="button quiet small" data-testid="timeline-loudness-apply-tasks" onClick={onOpenTasks}>核对原请求</Button>}
  </section>;
}
