import AgentEditingBoundary, {
  acquireAgentEditingTargetAtRevision,
  reconcileAgentEditingTargetClaim,
  releaseAgentEditingTarget,
} from './AgentEditingBoundary.tsx';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import type { AnnotationState, AssetAnnotationController } from './asset-annotation-state.ts';
import type { AgentEditingClaimResult } from './agent-editing-protection.ts';
import type { AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import {
  buildCoEditingComparison,
  findMioWriteForTarget,
  parseCoEditingClaimResult,
  refreshMioActiveWrites,
  useMioActiveWrites,
} from './mio-co-editing.ts';
import type { CoEditingConflict } from './mio-co-editing.ts';
import { MioCoEditingConflictCard, MioEditingBadge } from './MioCoEditingControls.tsx';
interface Props {
  asset?: { id: string; projectId: string; name: string } | null; state: AnnotationState | null;
  controller: AssetAnnotationController; blocked: boolean;  onShowTasks?(): void;
  visible?: boolean;
  confirm(message: unknown): Promise<boolean>;
}
export default function AssetAnnotations({ asset, state, controller, blocked,  onShowTasks, confirm, visible: panelVisible = true }: Props) {
  const { t, renderMessage, formatNumber } = useI18n(), workspaceVisible = useWorkspaceVisibility(), visible = workspaceVisible && panelVisible;
  const token = useMemo(() => ({ scope: state?.scope, assetId: asset?.id, visible }), [state?.scope, asset?.id, visible]), live = useRef<typeof token | null>(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  const admit = (action: () => unknown) => { if (live.current === token && visible && state?.scope && controller.getState().scope === state.scope) return action(); };
  const owned = asset && asset.projectId === state?.projectId && state.assetIds.includes(asset.id) ? asset : null;
  const entry = owned ? state?.entries[owned.id] : null, draft = entry?.draft;
  const mioWrites = useMioActiveWrites(owned?.projectId, Boolean(visible && owned));
  const mioWrite = owned ? findMioWriteForTarget(mioWrites, { kind: 'asset_annotation', id: owned.id }) : null;
  const [coEditConflict, setCoEditConflict] = useState<CoEditingConflict | null>(null);
  const [coEditBusy, setCoEditBusy] = useState(false);
  useLayoutEffect(() => { setCoEditConflict(null); setCoEditBusy(false); }, [owned?.id, owned?.projectId]);

  const handleClaimResult = (result: AgentEditingClaimResult, target: AgentTaskTarget) => {
    if (live.current !== token) return;
    if (result.status === 'acquired') { setCoEditConflict(null); return; }
    const conflict = parseCoEditingClaimResult(result, target);
    setCoEditConflict(conflict);
    if (conflict?.kind === 'mio_committing' && owned) void refreshMioActiveWrites(owned.projectId);
    else if (conflict?.kind === 'revision_changed' && conflict.currentValues === null) void controller.refresh();
  };

  const diff = coEditConflict?.kind === 'revision_changed' && draft
    ? buildCoEditingComparison({
        localValues: { tags: draft.tags, note: draft.note },
        serverValues: (coEditConflict.currentValues as Record<string, unknown> | null)
          ?? (entry?.row ? { tags: entry.row.tags, note: entry.row.note } : null),
        baselineValues: entry?.row ? { tags: entry.row.tags, note: entry.row.note } : undefined,
        fields: ['tags', 'note'],
        format: { t, formatNumber },
      })
    : { rows: [], conflictedFields: new Set<string>() };

  async function adoptMio() {
    if (!owned || coEditConflict?.kind !== 'revision_changed') return;
    setCoEditBusy(true);
    try {
      setCoEditConflict(null);
      controller.discard(owned.id, state?.scope);
      await releaseAgentEditingTarget(owned.projectId, { kind: 'asset_annotation', id: owned.id });
      await controller.refresh();
    } finally {
      if (live.current === token) setCoEditBusy(false);
    }
  }

  async function keepMine() {
    if (!owned || coEditConflict?.kind !== 'revision_changed') return;
    setCoEditBusy(true);
    try {
      const target: AgentTaskTarget = { kind: 'asset_annotation', id: owned.id, revision: coEditConflict.currentRevision };
      const result = await acquireAgentEditingTargetAtRevision(owned.projectId, target);
      if (live.current !== token) return;
      if (result.status === 'acquired') {
        setCoEditConflict(null);
        await controller.refresh();
      } else {
        setCoEditConflict(parseCoEditingClaimResult(result, target));
      }
    } finally {
      if (live.current === token) setCoEditBusy(false);
    }
  }

  async function reconcileUnknown() {
    if (!owned || coEditConflict?.kind !== 'claim_unknown') return;
    setCoEditBusy(true);
    try {
      const target: AgentTaskTarget = { kind: 'asset_annotation', id: owned.id, revision: coEditConflict.revision };
      const result = await reconcileAgentEditingTargetClaim(owned.projectId, target, coEditConflict.requestId);
      if (live.current !== token) return;
      if (result.status === 'acquired') setCoEditConflict(null);
      else setCoEditConflict(parseCoEditingClaimResult(result, target));
    } finally {
      if (live.current === token) setCoEditBusy(false);
    }
  }

  const disabled = !visible || !entry?.row || entry.loading || entry.saving || entry.uncertain || blocked || Boolean(mioWrite);
  const status = coEditConflict ? t('agent.coEdit.unresolvedConflict') : entry?.uncertain ? t('annotations.unconfirmed') : entry?.saving ? t('annotations.saving') : entry?.loading ? t('annotations.loading') : entry?.conflict ? t('annotations.conflict') : entry?.dirty ? t('annotations.dirty') : entry?.row ? t('annotations.saved', { revision: entry.row.revision }) : t('annotations.select');
  return <AgentEditingBoundary disabled={false} projectId={owned?.projectId} targets={owned ? [{ kind: 'asset_annotation', id: owned.id, revision: entry?.row?.revision ?? 0 }] : []} onClaimResult={handleClaimResult} canRelease={() => { const current = owned ? controller.getState().entries[owned.id] : null; return !current?.dirty && !current?.saving && !current?.uncertain; }} onDiscard={()=>{if(owned)controller.discard(owned.id,state?.scope);}}><section className="asset-annotations mio-coedit-section" data-testid="asset-annotations" data-mio-editing={mioWrite ? 'true' : undefined} data-coedit-conflict={coEditConflict && !mioWrite ? 'true' : undefined} style={mioWrite ? { '--mio-coedit-color': mioWrite.color } as React.CSSProperties : undefined} aria-label={t('annotations.title')} data-no-asset-drag>
    <div className="mio-coedit-section-header"><h3>{t('annotations.title')}</h3>{mioWrite && <MioEditingBadge color={mioWrite.color} testId="mio-editing-badge-annotation" />}</div>
    {coEditConflict && <MioCoEditingConflictCard conflict={coEditConflict} groupLabel={t('agent.coEdit.group.annotation')} rows={diff.rows} busy={coEditBusy} testId="coedit-conflict-annotation" onAdoptMio={adoptMio} onKeepMine={keepMine} onReconcile={reconcileUnknown} />}
    {Boolean(state?.dirtyCount) && <div className="annotation-retained"><p role="status">{t('annotations.retained', { count: state!.dirtyCount })}</p><Button type="button" variant="ghost" size="sm" data-testid="annotation-discard-all" disabled={!visible} onClick={() => admit(async () => { const version = controller.getState().version; if (await confirm(t('annotations.discardConfirm')) && live.current === token) controller.discardRetained(version); })}>{t('annotations.discardAll')}</Button></div>}
    {Boolean(state?.uncertainCount) && !entry?.uncertain && <><p role="alert">{t('annotations.unconfirmed')}</p><Button type="button" variant="ghost" size="sm" disabled={!visible} onClick={() => admit(() => onShowTasks?.())}>{t('annotations.viewTasks')}</Button></>}
    {state?.error && <p role="alert">{renderMessage(state.error)}</p>}
    {!owned ? <p>{t('annotations.select')}</p> : <>
      <strong className="annotation-asset-name" title={owned.name}>{owned.name}</strong>
      <p className="annotation-status" role="status" data-testid="annotation-status">{status}</p>
      {false}
      {entry?.error && <p role="alert" data-testid="annotation-error">{renderMessage(entry.error)}</p>}
      {entry?.row && !entry.dirty && !entry.row.tags.length && !entry.row.note && <p>{t('annotations.empty')}</p>}
      <label htmlFor="asset-annotation-tag">{t('annotations.tags')}</label>
      <div className="annotation-tags">{draft?.tags.map(tag => <span key={tag}>{tag}<Button variant="ghost" type="button" size="sm" disabled={disabled} aria-label={t('annotations.removeTag', { tag })} onClick={() => admit(() => controller.removeTag(owned.id, tag, state!.scope))}>×</Button></span>)}</div>
      <div className="annotation-tag-input"><Input id="asset-annotation-tag" data-testid="annotation-tag-input" data-coedit-field-conflict={diff.conflictedFields.has('tags') ? 'true' : undefined} value={draft?.tagInput || ''} disabled={disabled} onChange={event => admit(() => controller.editTagInput(owned.id, event.target.value, state!.scope))} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); admit(() => controller.addTag(owned.id, state!.scope)); } }} /><Button type="button" variant="outline" size="sm" data-testid="annotation-add-tag" disabled={disabled || !draft?.tagInput.trim()} onClick={() => admit(() => controller.addTag(owned.id, state!.scope))}>{t('annotations.addTag')}</Button></div>
      <label htmlFor="asset-annotation-note">{t('annotations.note')}</label>
      <Textarea id="asset-annotation-note" data-testid="annotation-note" data-coedit-field-conflict={diff.conflictedFields.has('note') ? 'true' : undefined} rows={4} value={draft?.note || ''} disabled={disabled} onChange={event => admit(() => controller.editNote(owned.id, event.target.value, state!.scope))} />
      <p className="annotation-hint">{t('annotations.limits')} ({formatNumber([...(draft?.note || '')].length)}/4,000)</p>
      <div className="annotation-actions">
        <Button type="button" variant="outline" size="sm" className="mio-coedit-save-btn" data-testid="annotation-save" disabled={disabled || !entry?.verified || !entry.dirty || entry.conflict || Boolean(coEditConflict) || Boolean(draft?.tagInput)} onClick={() => admit(() => controller.save(owned.id, state!.scope))}>{t('annotations.save')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-discard" disabled={!visible || !entry?.row || entry.saving || entry.uncertain || !entry.dirty && !entry.conflict && !coEditConflict} onClick={() => admit(() => { setCoEditConflict(null); controller.discard(owned.id, state!.scope); })}>{t('annotations.discard')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-clear" disabled={disabled || !draft || !draft.tags.length && !draft.note && !draft.tagInput} onClick={() => admit(() => controller.clear(owned.id, state!.scope))}>{t('annotations.clear')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-refresh" disabled={!visible || state?.loading || entry?.saving} onClick={() => admit(() => controller.refresh())}>{t('annotations.refresh')}</Button>
      </div>
      {entry?.uncertain && <Button type="button" variant="ghost" size="sm" data-testid="annotation-tasks" onClick={() => admit(() => onShowTasks?.())}>{t('annotations.viewTasks')}</Button>}
    </>}
    <p className="annotation-hint">{t('annotations.local')}</p><p className="annotation-hint">{t('annotations.session')}</p>
  </section></AgentEditingBoundary>;
}
