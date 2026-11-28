import { useI18n } from './i18n/I18nProvider.tsx';
import { message } from '../../../packages/i18n/src/index.ts';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@mioon/ui/components/badge';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { Textarea } from '@mioon/ui/components/textarea';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import { subtitleCanSave, subtitleDraftMessage, createSubtitleController } from './subtitle-state.ts';
import type { SubtitleState } from './subtitle-state.ts';
import {
  acquireAgentEditingTargetAtRevision,
  readCachedAgentEditingTargetRevision,
  reconcileAgentEditingTargetClaim,
  releaseAgentEditingTarget,
} from './AgentEditingBoundary.tsx';
import {
  buildCoEditingComparison,
  findMioWriteForTarget,
  parseCoEditingClaimResult,
  refreshMioActiveWrites,
  useMioActiveWrites,
} from './mio-co-editing.ts';
import type { CoEditingConflict } from './mio-co-editing.ts';
import { MioCoEditingConflictCard, MioEditingBadge } from './MioCoEditingControls.tsx';
type SubtitleController = ReturnType<typeof createSubtitleController>;
export interface SubtitleRenderJobView {timelineRevision: number}
import Icon from './icons.tsx';
import './subtitles.css';

export default function SubtitleInspector({
  state,
  controller,
  renderJob,
  onBack,
  onOpenTasks,
  onRefreshProject,
  onOpenMioPanel,
}: {
  state?: SubtitleState | null;
  controller: SubtitleController;
  renderJob?: SubtitleRenderJobView | null;
  onBack: () => void;
  onOpenTasks: () => void;
  onRefreshProject?: () => Promise<unknown> | unknown;
  onOpenMioPanel?: () => unknown;
}) {
  const { t, renderMessage, formatNumber } = useI18n();
  const confirm = useConfirmation(), visible = useWorkspaceVisibility(), live = useRef<{mounted: boolean; visible: boolean}>({ mounted: false, visible: false });
  useLayoutEffect(() => { live.current = { mounted: true, visible }; return () => { live.current.mounted = false; }; }, [visible]);
  const admit = (action: () => unknown): unknown => { const current = controller.getState(); if (live.current.mounted && live.current.visible && state?.scope === current.scope && state?.selection === current.selection) return action(); };
  const draft = state?.draft, issue = draft ? renderMessage(subtitleDraftMessage(state)) : '', stale = renderJob && state?.timeline && renderJob.timelineRevision !== state.timeline.revision;

  const projectId = state?.projectId ?? null;
  const targetKind = state?.cueId ? 'timeline_subtitle' : 'timeline';
  const targetId = state?.cueId || projectId || '';
  const mioWrites = useMioActiveWrites(projectId, Boolean(visible && projectId && targetId));
  const mioWrite = targetId ? findMioWriteForTarget(mioWrites, { kind: targetKind, id: targetId }) : null;

  const [coEditConflict, setCoEditConflict] = useState<CoEditingConflict | null>(null);
  const [coEditBusy, setCoEditBusy] = useState(false);
  const baselineRevision = useRef<number>(0);
  const selectionKey = `${projectId ?? ''}:${state?.cueId ?? 'new'}:${state?.selection ?? 0}`;
  const lastSelectionKey = useRef(selectionKey);
  if (lastSelectionKey.current !== selectionKey) {
    lastSelectionKey.current = selectionKey;
    if (projectId && targetId) {
      baselineRevision.current = readCachedAgentEditingTargetRevision(projectId, { kind: targetKind, id: targetId }) ?? 0;
    }
    if (coEditConflict !== null) setCoEditConflict(null);
    if (coEditBusy) setCoEditBusy(false);
  }

  function probeSubtitleClaim(allowFromCommitting = false): void {
    if (!projectId || !targetId || !visible) return;
    if (coEditConflict && !(allowFromCommitting && coEditConflict.kind === 'mio_committing')) return;
    const rev = readCachedAgentEditingTargetRevision(projectId, { kind: targetKind, id: targetId }) ?? baselineRevision.current;
    const target = { kind: targetKind, id: targetId, revision: rev };
    void acquireAgentEditingTargetAtRevision(projectId, target).then(result => {
      if (!live.current.mounted) return;
      if (result.status === 'acquired') { setCoEditConflict(null); return; }
      const conflict = parseCoEditingClaimResult(result, target);
      if (conflict) {
        setCoEditConflict(conflict);
        if (conflict.kind === 'mio_committing') void refreshMioActiveWrites(projectId);
        else if (conflict.kind === 'revision_changed' && conflict.currentValues === null) void onRefreshProject?.();
      }
    });
  }
  const hadMioWrite = useRef(false);
  if (mioWrite) {
    hadMioWrite.current = true;
  } else if (hadMioWrite.current) {
    hadMioWrite.current = false;
    if (coEditConflict?.kind === 'mio_committing') {
      queueMicrotask(() => { if (live.current.mounted) probeSubtitleClaim(true); });
    }
  }
  function claimOnSubtitleInput(): void { probeSubtitleClaim(false); }

  const savedCue = state?.cueId ? state.timeline?.subtitles?.cues?.find(cue => cue.id === state.cueId) : null;
  const diff = coEditConflict?.kind === 'revision_changed' && draft
    ? buildCoEditingComparison({
        localValues: { text: draft.text, startFrame: Number(draft.startFrame), durationFrames: Number(draft.durationFrames) },
        serverValues: (coEditConflict.currentValues as Record<string, unknown> | null)
          ?? (savedCue ? { text: savedCue.text, startFrame: savedCue.startFrame, durationFrames: savedCue.durationFrames } : null),
        baselineValues: savedCue ? { text: savedCue.text, startFrame: savedCue.startFrame, durationFrames: savedCue.durationFrames } : undefined,
        fields: ['text', 'startFrame', 'durationFrames'],
        format: { fps: 30, t, formatNumber },
      })
    : { rows: [], conflictedFields: new Set<string>() };

  async function adoptMio(): Promise<void> {
    if (!projectId || !targetId || coEditConflict?.kind !== 'revision_changed') return;
    setCoEditBusy(true);
    try {
      baselineRevision.current = coEditConflict.currentRevision;
      setCoEditConflict(null);
      if (state?.scope) controller.discardDraft(state.scope);
      await releaseAgentEditingTarget(projectId, { kind: targetKind, id: targetId });
      await onRefreshProject?.();
    } finally {
      if (live.current.mounted) setCoEditBusy(false);
    }
  }

  async function keepMine(): Promise<void> {
    if (!projectId || !targetId || coEditConflict?.kind !== 'revision_changed') return;
    setCoEditBusy(true);
    try {
      const target = { kind: targetKind, id: targetId, revision: coEditConflict.currentRevision };
      const result = await acquireAgentEditingTargetAtRevision(projectId, target);
      if (!live.current.mounted) return;
      if (result.status === 'acquired') {
        baselineRevision.current = coEditConflict.currentRevision;
        setCoEditConflict(null);
        await onRefreshProject?.();
      } else {
        setCoEditConflict(parseCoEditingClaimResult(result, target));
      }
    } finally {
      if (live.current.mounted) setCoEditBusy(false);
    }
  }

  async function reconcileUnknown(): Promise<void> {
    if (!projectId || !targetId || coEditConflict?.kind !== 'claim_unknown') return;
    setCoEditBusy(true);
    try {
      const target = { kind: targetKind, id: targetId, revision: coEditConflict.revision };
      const result = await reconcileAgentEditingTargetClaim(projectId, target, coEditConflict.requestId);
      if (!live.current.mounted) return;
      if (result.status === 'acquired') setCoEditConflict(null);
      else setCoEditConflict(parseCoEditingClaimResult(result, target));
    } finally {
      if (live.current.mounted) setCoEditBusy(false);
    }
  }

  const blockedByCoEdit = Boolean(mioWrite || coEditConflict);
  const saveDisabled = !subtitleCanSave(state ?? undefined) || blockedByCoEdit;

  return <aside className="inspector subtitle-inspector" data-testid="subtitle-inspector" aria-labelledby="subtitle-title">
    <header className="inspector-heading"><Icon name="text" /><span id="subtitle-title">{t('subtitles.ui.title')}</span><Badge className="small-badge neutral">{t('subtitles.ui.fixed')}</Badge><Button type="button" variant="ghost" size="sm" data-testid="subtitle-back" onClick={() => admit(onBack)}>{t('subtitles.ui.back')}</Button></header>
    <ScrollArea className="subtitle-scroll" style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll subtitle-form">
      <p className="input-hint">{t('subtitles.ui.limits')}</p>
      <p className={stale ? 'notice warning' : 'input-hint'} data-testid="subtitle-render-status" role="status">{!state?.timeline ? t('subtitles.ui.checking') : stale ? t('subtitles.ui.stale', { rendered: renderJob.timelineRevision, current: state.timeline.revision }) : renderJob ? t('subtitles.ui.matching', { revision: renderJob.timelineRevision }) : t('subtitles.ui.noPreview')}</p>
      <div role="status" aria-live="polite" data-testid="subtitle-save-status">{coEditConflict || state?.conflict ? t('agent.coEdit.unresolvedConflict') : state?.submitting ? t('subtitles.ui.saving') : state?.uncertain ? t('subtitles.ui.unconfirmed') : state?.dirty ? t('subtitles.ui.dirty') : draft ? t('subtitles.ui.saved') : null}</div>
      {draft && <section className="mio-coedit-section" data-mio-editing={mioWrite ? 'true' : undefined} data-coedit-conflict={coEditConflict && !mioWrite ? 'true' : undefined} style={mioWrite ? { '--mio-coedit-color': mioWrite.color } as React.CSSProperties : undefined}>
        {mioWrite && <div className="mio-coedit-section-header"><MioEditingBadge color={mioWrite.color} testId="mio-editing-badge-subtitle" /></div>}
        {coEditConflict && <MioCoEditingConflictCard conflict={coEditConflict} groupLabel={t('agent.coEdit.group.subtitle')} rows={diff.rows} busy={coEditBusy} testId="coedit-conflict-subtitle" onAdoptMio={adoptMio} onKeepMine={keepMine} onReconcile={reconcileUnknown} onCheckInMio={onOpenMioPanel} />}
        <fieldset className="mio-coedit-lock-fieldset" disabled={Boolean(mioWrite)}>
          <div className="mio-coedit-lock-body">
            <Label className="field-label" htmlFor="subtitle-text">{t('subtitles.ui.text')}</Label><Textarea id="subtitle-text" data-testid="subtitle-text" data-coedit-field-conflict={diff.conflictedFields.has('text') ? 'true' : undefined} value={draft.text} rows={3} spellCheck={false} aria-invalid={Boolean(issue)} aria-describedby="subtitle-validation" onChange={event => admit(() => { controller.edit('text', event.target.value, state); claimOnSubtitleInput(); })} />
            <div className="field-row">{([['startFrame', t('timeline.inspector.start'), 0], ['durationFrames', t('timeline.inspector.duration'), 1]] as ReadonlyArray<readonly ['startFrame' | 'durationFrames', string, number]>).map(([key, label, min]) => <div key={key}><Label className="field-label" htmlFor={`subtitle-${key}`}>{label}</Label><Input id={`subtitle-${key}`} data-testid={`subtitle-${key}`} data-coedit-field-conflict={diff.conflictedFields.has(key) ? 'true' : undefined} type="number" aria-describedby="subtitle-validation" aria-invalid={Boolean(issue)} step="1" min={min} max={state.timeline?.durationFrames || 0} value={draft[key]} onChange={event => admit(() => { controller.edit(key, event.target.value, state as SubtitleState); claimOnSubtitleInput(); })} /></div>)}</div>
            <p id="subtitle-validation" data-testid="subtitle-validation" className={issue ? 'notice warning' : 'input-hint'} role={issue ? 'alert' : undefined}>{issue || t('subtitles.ui.characters', { counts: draft.text.split('\n').map((line: string) => [...line].length).join(' / ') })}</p>
          </div>
        </fieldset>
      </section>}
      {state?.conflict && !coEditConflict && <div className="notice warning" role="alert">{t('subtitles.ui.conflict')}<Button type="button" variant="outline" data-testid="subtitle-discard-reload" disabled={state.submitting} onClick={() => admit(() => controller.discardDraft(state.scope))}>{t('subtitles.ui.discardReload')}</Button></div>}
      {state?.error && <p className="notice warning" role="alert">{renderMessage(state.errorMessage || message('subtitles.error.unknown'))}</p>}
      {(state?.pending || state?.uncertain) && <Button type="button" variant="outline" size="sm" data-testid="subtitle-open-tasks" onClick={() => admit(onOpenTasks)}>{t('subtitles.ui.tasks')}</Button>}
      <details className="input-hint"><summary>{t('subtitles.ui.punctuation')}</summary><p>，。！？；：、（）【】《》〈〉“”‘’—…·￥％～</p><p>{t('subtitles.ui.characterSupport')}</p></details>
      <p className="input-hint">{t('subtitles.ui.retained')}</p>
    </div></ScrollArea>
    <footer className="subtitle-actions"><Button type="button" className="mio-coedit-save-btn" data-testid="subtitle-save" disabled={saveDisabled} onClick={() => admit(() => controller.save(state as SubtitleState))}><Icon name="check" size={14} />{t('subtitles.ui.save')}</Button><Button type="button" variant="outline" data-testid="subtitle-discard" disabled={!draft || state?.submitting} onClick={() => admit(() => { setCoEditConflict(null); controller.discardDraft(state?.scope ?? null); })}>{t('timeline.inspector.discard')}</Button><Button type="button" variant="ghost" className="danger-text" data-testid="subtitle-remove" disabled={!state?.cueId || state.dirty || state.conflict || blockedByCoEdit || state.submitting || state.pending || Boolean(state.uncertain) || !state.connected} onClick={() => admit(async () => { const snapshot = controller.getState(); if (await confirm(message('subtitles.ui.removeConfirm')) && snapshot === controller.getState()) admit(() => controller.remove(state as SubtitleState)); })}>{t('subtitles.ui.remove')}</Button></footer>
  </aside>;
}
