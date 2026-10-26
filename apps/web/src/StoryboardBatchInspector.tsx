import React, { useEffect, useState } from 'react';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchAlert, WorkbenchBadge, WorkbenchButton } from '@mioon/ui/components/workbench-controls';
import { useI18n } from './i18n/I18nProvider.tsx';
import Icon from './icons.tsx';
import BoardInspectorGroup from './BoardInspectorGroup.tsx';
import { sceneTime } from './scene-cuts.ts';
import type { SceneShotsTask, SceneUndoView } from './scene-detection.ts';
import { sceneAgo, storyboardBatchSummary, storyboardUndoReason } from './scene-storyboard.ts';
import type { StoryboardBatchShot } from './scene-storyboard.ts';
import './scene-storyboard.css';

export interface StoryboardBatchInspectorProps {
  readonly task: SceneShotsTask;
  /** The reference video's name, or null when it left the project. */
  readonly sourceName: string | null;
  readonly shots: readonly StoryboardBatchShot[];
  /** The keyframe image of each built segment, in segment order. */
  readonly keyframes: readonly { readonly assetId: string; readonly url?: string }[];
  readonly undo: SceneUndoView | undefined;
  readonly readOnly: boolean;
  /** Another scene request is being sent or awaits its receipt. */
  readonly busy: boolean;
  /** This storyboard's undo was sent and its receipt is unconfirmed. */
  readonly unconfirmed: boolean;
  readonly onUndo: () => void;
  readonly onRecheck: () => void;
  readonly onReconcile: () => void;
  readonly onResend: () => void;
}
const thumbnails = 5;

/** The inspector for the shots a storyboard just built (09-08b, 09-08d): what they
 * are, and whether the whole batch can still be undone, or why not. */
export default function StoryboardBatchInspector({ task, sourceName, shots, keyframes, undo, readOnly, busy, unconfirmed, onUndo, onRecheck, onReconcile, onResend }: StoryboardBatchInspectorProps) {
  const { t, renderMessage } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const blockers = undo?.undo?.blockers ?? null, summary = storyboardBatchSummary(task, shots, blockers);
  const count = task.shots?.length ?? task.segments.length, reason = blockers ? storyboardUndoReason(task, blockers, t) : null;
  const available = undo?.phase === 'ready' && undo.undo?.available === true && undo.revision === task.revision;
  const undoCard = readOnly ? null : <section className="storyboard-undo" data-testid="storyboard-undo" data-state={available ? 'ready' : reason ? 'blocked' : undo?.phase ?? 'loading'}>
    <WorkbenchButton variant="ghost" size="compact" className="storyboard-undo-action" data-testid="storyboard-undo-action" disabled={!available || busy} onClick={onUndo}><Icon name="undo" size={13} />{t('scene.batch.undo')}</WorkbenchButton>
    {available ? <p>{t('scene.batch.undoReady')}</p> : reason ? <p><span data-testid="storyboard-undo-reason">{reason}</span><span>{t('scene.batch.undoRule', { count })}</span></p>
      : <p>{undo?.phase === 'error' ? t('scene.batch.undoUnknown') : t('scene.batch.undoChecking')}</p>}
    {undo?.phase === 'error' && <WorkbenchButton variant="secondary" size="compact" data-testid="storyboard-undo-recheck" onClick={onRecheck}>{t('scene.batch.recheck')}</WorkbenchButton>}
  </section>;
  return <aside className="inspector storyboard-batch-inspector" data-testid="storyboard-batch-inspector">
    <header className="inspector-heading"><Icon name="grid" /><span>{t('scene.batch.title', { count: summary.shotIds.length })}</span></header>
    <ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll">
      <p className="storyboard-batch-source"><Icon name="film" size={13} /><span>{t('scene.batch.from', { name: sourceName ?? t('scene.task.unavailable'), time: renderMessage(sceneAgo(task.updatedAt, now)) })}</span></p>
      {unconfirmed && <WorkbenchAlert tone="warning" data-testid="storyboard-undo-unknown" actions={<><WorkbenchButton variant="secondary" size="compact" onClick={onReconcile}>{t('scene.request.reconcile')}</WorkbenchButton>
        <WorkbenchButton variant="ghost" size="compact" onClick={onResend}>{t('scene.request.retry')}</WorkbenchButton></>}>{t('scene.request.unknown')}</WorkbenchAlert>}
      {undoCard}
      <BoardInspectorGroup title={t('scene.batch.overview')}>
        <dl className="storyboard-batch-overview">
          <dt>{t('scene.batch.shots')}</dt><dd>{summary.first === summary.last ? summary.first : `${summary.first} – ${summary.last}`}</dd>
          <dt>{t('scene.batch.duration')}</dt><dd>{sceneTime(summary.seconds * 30)}</dd>
          <dt>{t('scene.batch.ratio')}</dt><dd>{task.aspectRatio}</dd>
          <dt>{t('scene.batch.state')}</dt><dd className="storyboard-batch-states">
            {summary.pending > 0 && <WorkbenchBadge>{t('scene.batch.pending', { count: summary.pending })}</WorkbenchBadge>}
            {summary.generated > 0 && <WorkbenchBadge tone="success">{t('scene.batch.generated', { count: summary.generated })}</WorkbenchBadge>}
            {summary.edited > 0 && <WorkbenchBadge tone="warning">{t('scene.batch.edited', { count: summary.edited })}</WorkbenchBadge>}
            {summary.missing > 0 && <WorkbenchBadge tone="danger">{t('scene.batch.missing', { count: summary.missing })}</WorkbenchBadge>}</dd>
        </dl>
      </BoardInspectorGroup>
      <BoardInspectorGroup title={t('scene.batch.references')}>
        <p className="storyboard-batch-hint">{t('scene.batch.referencesHint')}</p>
        <div className="storyboard-batch-keyframes">{keyframes.slice(0, thumbnails).map(keyframe => <span key={keyframe.assetId}>{keyframe.url && <img src={keyframe.url} alt="" draggable={false} />}</span>)}
          {keyframes.length > thumbnails && <b>{`+${keyframes.length - thumbnails}`}</b>}</div>
      </BoardInspectorGroup>
    </div></ScrollArea>
  </aside>;
}
