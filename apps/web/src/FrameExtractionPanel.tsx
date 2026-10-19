import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { FRAME_PROFILE, frameCaptureBusy, frameCanCancel, frameCanRecover, frameTaskMessage } from './frame-extraction.ts';
import './frame-extraction.css';

const active = task => ['queued', 'running', 'persisting'].includes(task.state);
export default function FrameExtractionPanel({ controller, visible = true }) {
  const { t, renderMessage, formatNumber } = useI18n();
  const ancestorVisible = useWorkspaceVisibility();
  visible = visible && ancestorVisible;
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
  const live = useRef(null);
  useLayoutEffect(() => {
    const token = { controller, visible, projectId: controller.getSnapshot().projectId, sourceScope: controller.getSnapshot().sourceScope };
    live.current = token;
    const update = () => setSnapshot(controller.getSnapshot());
    const unsubscribe = visible ? controller.subscribe(update) : () => {}; update();
    return () => { if (live.current === token) live.current = null; unsubscribe(); };
  }, [controller, visible, snapshot.projectId, snapshot.sourceScope]);
  const state = controller.getSnapshot();
  useEffect(() => { if (visible && state.visible && !state.blocked && state.projectId) void controller.refreshTasks(); }, [controller, visible, state.visible, state.blocked, state.projectId, state.sourceScope]);
  useEffect(() => {
    if (!visible || !state.visible || !state.tasks.some(active)) return;
    const timer = setTimeout(() => { if (live.current?.visible) void controller.refreshActive(); }, 2000);
    return () => clearTimeout(timer);
  }, [controller, visible, state.visible, state.tasks]);
  const capturedProject = state.projectId, capturedScope = state.sourceScope;
  const run = action => {
    const current = controller.getSnapshot(), binding = live.current;
    if (!binding || !binding.visible || binding.controller !== controller || binding.projectId !== capturedProject || binding.sourceScope !== capturedScope || !current.visible || current.projectId !== capturedProject || current.sourceScope !== capturedScope) return;
    return action();
  };
  const busy = !visible || frameCaptureBusy(state);
  const source = state.sourceAsset;
  const resultAsset = task => state.assets.find(asset => asset.projectId === task.projectId && asset.id === task.result?.assetId && asset.sha256 === task.result?.sha256 && asset.mimeType === 'image/png' && asset.provenance === 'extracted-frame');
  return <section className="frame-extraction-panel" aria-label={t('timeline.frame.title')} data-testid="frame-extraction-panel">
    <div className="frame-extraction-heading"><h3>{t('timeline.frame.title')}</h3><Badge className="small-badge neutral">{t('timeline.frame.local')}</Badge></div>
    <p className="input-hint">{t('timeline.frame.timebase')}</p>
    <p className="frame-extraction-profile" data-testid="frame-extraction-profile">{t('timeline.frame.profile', { edge: FRAME_PROFILE.maxEdge })}</p>
    {source && <p className="input-hint">{t('timeline.frame.source', { name: source.name || source.id })}</p>}
    <p className="input-hint">{t('timeline.frame.frozen')}</p>
    {!state.historyLoaded && <p className="notice" role="status">{t('timeline.frame.readFirst')}</p>}
    {state.pending && <div className="notice warning" data-testid="frame-extraction-unknown" role="status"><strong>{t('timeline.frame.unknown')}</strong><p>{t('timeline.frame.pendingPoint', { name: state.pending.sourceName || t('timeline.frame.originalTask'), frame: state.pending.sourceFrame })}</p><p>{t('timeline.frame.operation', { operation: state.pending.operation })}</p><span className="frame-extraction-id">{state.pending.input.requestId}</span><p>{t('timeline.frame.windowEvidence')}</p><div className="frame-extraction-actions"><Button type="button" variant="outline" size="sm" data-testid="frame-request-reconcile" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.reconcileUnknown())}>{t('timeline.frame.reconcile')}</Button><Button type="button" variant="ghost" size="sm" data-testid="frame-request-retry" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.retryUnknown())}>{t('timeline.frame.retry')}</Button></div></div>}
    {state.message && <p className="notice" role="status" data-testid="frame-extraction-message">{renderMessage(state.messageDescriptor || message('timeline.frame.safeFailure'))}</p>}
    {state.error && <p className="notice warning" role="alert">{renderMessage(state.errorMessage || message('timeline.frame.safeFailure'))}</p>}
    {state.acknowledged && state.currentTaskPending && <p className="notice">{t('timeline.frame.acceptedPending')}<Button type="button" variant="ghost" size="sm" disabled={!visible} onClick={() => run(() => controller.readTask(state.currentTaskPending))}>{t('timeline.frame.readTask')}</Button></p>}
    <div className="frame-extraction-heading"><h4>{t('timeline.frame.tasks')}</h4><Button type="button" variant="ghost" size="sm" data-testid="frame-task-refresh" disabled={!visible || state.phase === 'submitting'} onClick={() => run(() => controller.refreshTasks())}>{t('timeline.frame.refresh')}</Button></div><p className="input-hint" role="status" data-testid="frame-task-page">{state.loading ? t('timeline.frame.loading') : t('timeline.frame.page', { page: state.pageTrail.length + 1 })}</p>
    {!state.tasks.length && state.historyLoaded && !state.loading && <p className="input-hint">{t('timeline.frame.empty')}</p>}
    {state.tasks.map(task => {
      const asset = task.result && resultAsset(task);
      return <article className="frame-extraction-task" key={task.id} data-testid="frame-extraction-task" data-task-id={task.id} data-state={task.state}><div className="frame-extraction-heading"><strong>{t('timeline.frame.point', { frame: task.sourceFrame, seconds: formatNumber(task.sourceFrame / task.fps, { minimumFractionDigits: 3, maximumFractionDigits: 3 }) })}</strong><Badge className={`small-badge ${task.state === 'succeeded' ? 'success' : 'neutral'}`}>{renderMessage(frameTaskMessage(task.state))}</Badge></div><p className="input-hint">{t('timeline.frame.taskMeta', { revision: task.revision, status: t(task.started ? 'timeline.frame.started' : 'timeline.frame.notStarted') })}</p>
        {['failed', 'interrupted'].includes(task.state) && <p className="notice">{t('timeline.frame.noAutomaticRetry')}</p>}
        {task.state === 'local_result_error' && <p className="notice">{t('timeline.frame.localResult')}</p>}
        {task.state === 'interrupted' && task.started && <p className="notice">{t('timeline.frame.interruptedResult')}</p>}
        {task.errorCode && <p className="input-hint">{t('timeline.frame.errorCode', { code: task.errorCode })}</p>}
        {task.result && <div className="frame-extraction-result" data-testid="frame-extraction-result"><strong>{asset?.name || t('timeline.frame.savedFallback')}</strong><span>{task.result.width} × {task.result.height} · image/png · {Math.ceil(task.result.byteLength / 1024)} KB</span><span>{t('timeline.frame.provenance')}</span><Button type="button" variant="outline" size="sm" data-testid="frame-result-reveal" disabled={!visible || Boolean(state.pending || state.actionTaskId)} onClick={() => run(() => controller.revealResult(task))}>{t('timeline.frame.reveal')}</Button></div>}
        <details><summary>{t('timeline.frame.records')}</summary><span className="frame-extraction-id">{t('timeline.frame.sourceAsset', { id: task.sourceAssetId })}</span><span className="frame-extraction-id">{t('timeline.frame.sourceHash', { hash: task.sourceHash })}</span><span className="frame-extraction-id">{t('timeline.frame.task', { id: task.id })}</span><span className="frame-extraction-id">{t('timeline.frame.request', { id: task.requestId })}</span><span className="frame-extraction-id">{t('timeline.frame.profileId', { id: task.profileId })}</span>{task.result && <><span className="frame-extraction-id">{t('timeline.frame.asset', { id: task.result.assetId })}</span><span className="frame-extraction-id">SHA-256 {task.result.sha256}</span></>}</details>
        <div className="frame-extraction-actions">{frameCanCancel(task) && <Button type="button" variant="outline" size="sm" data-testid="frame-task-cancel" disabled={busy} onClick={() => run(() => controller.cancelQueued(task))}>{t('timeline.frame.cancel')}</Button>}{frameCanRecover(task) && <Button type="button" variant="outline" size="sm" data-testid="frame-task-recover" disabled={busy} onClick={() => run(() => controller.recoverResult(task))}>{task.state === 'interrupted' ? t('timeline.frame.checkRecover') : t('timeline.frame.recover')}</Button>}</div>
      </article>;
    })}
    <div className="frame-extraction-actions">{state.pageTrail.length > 0 && <Button type="button" variant="ghost" size="sm" data-testid="frame-task-previous" disabled={!visible || state.loading} onClick={() => run(() => controller.previousTasks())}>{t('timeline.frame.newer')}</Button>}{state.nextCursor && <Button type="button" variant="ghost" size="sm" data-testid="frame-task-more" disabled={!visible || state.loading} onClick={() => run(() => controller.loadMoreTasks())}>{t('timeline.frame.older')}</Button>}</div>
    <p className="input-hint">{t('timeline.frame.pagination')}</p>
  </section>;
}
