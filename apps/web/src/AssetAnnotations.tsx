import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Textarea } from '@mioon/ui/components/textarea';
import { useI18n } from './i18n/I18nProvider.tsx';
import { useWorkspaceVisibility } from './workspace-visibility.tsx';
import type { AnnotationState, AssetAnnotationController } from './asset-annotation-state.ts';
interface Props {
  asset?: { id: string; projectId: string; name: string } | null; state: AnnotationState | null;
  controller: AssetAnnotationController; blocked: boolean; restored?: boolean; onShowTasks?(): void;
  visible?: boolean;
  confirm(message: unknown): Promise<boolean>;
}
export default function AssetAnnotations({ asset, state, controller, blocked, restored = false, onShowTasks, confirm, visible: panelVisible = true }: Props) {
  const { t, renderMessage, formatNumber } = useI18n(), workspaceVisible = useWorkspaceVisibility(), visible = workspaceVisible && panelVisible;
  const token = useMemo(() => ({ scope: state?.scope, assetId: asset?.id, visible }), [state?.scope, asset?.id, visible]), live = useRef<typeof token | null>(null);
  useLayoutEffect(() => { live.current = token; return () => { live.current = null; }; }, [token]);
  const admit = (action: () => unknown) => { if (live.current === token && visible && state?.scope && controller.getState().scope === state.scope) return action(); };
  const owned = asset && asset.projectId === state?.projectId && state.assetIds.includes(asset.id) ? asset : null;
  const entry = owned ? state?.entries[owned.id] : null, draft = entry?.draft;
  const disabled = !visible || !entry?.row || entry.loading || entry.saving || entry.uncertain || restored || blocked;
  const status = entry?.uncertain ? t('annotations.unconfirmed') : entry?.saving ? t('annotations.saving') : entry?.loading ? t('annotations.loading') : entry?.conflict ? t('annotations.conflict') : entry?.dirty ? t('annotations.dirty') : entry?.row ? t('annotations.saved', { revision: entry.row.revision }) : t('annotations.select');
  return <section className="asset-annotations" data-testid="asset-annotations" aria-label={t('annotations.title')} data-no-asset-drag>
    <h3>{t('annotations.title')}</h3>
    {Boolean(state?.dirtyCount) && <div className="annotation-retained"><p role="status">{t('annotations.retained', { count: state!.dirtyCount })}</p><Button type="button" variant="ghost" size="sm" data-testid="annotation-discard-all" disabled={!visible} onClick={() => admit(async () => { const version = controller.getState().version; if (await confirm(t('annotations.discardConfirm')) && live.current === token) controller.discardRetained(version); })}>{t('annotations.discardAll')}</Button></div>}
    {Boolean(state?.uncertainCount) && !entry?.uncertain && <><p role="alert">{t('annotations.unconfirmed')}</p><Button type="button" variant="ghost" size="sm" disabled={!visible} onClick={() => admit(() => onShowTasks?.())}>{t('annotations.viewTasks')}</Button></>}
    {state?.error && <p role="alert">{renderMessage(state.error)}</p>}
    {!owned ? <p>{t('annotations.select')}</p> : <>
      <strong className="annotation-asset-name" title={owned.name}>{owned.name}</strong>
      <p className="annotation-status" role="status" data-testid="annotation-status">{status}</p>
      {restored && <p>{t('annotations.readOnly')}</p>}
      {entry?.error && <p role="alert" data-testid="annotation-error">{renderMessage(entry.error)}</p>}
      {entry?.row && !entry.dirty && !entry.row.tags.length && !entry.row.note && <p>{t('annotations.empty')}</p>}
      <label htmlFor="asset-annotation-tag">{t('annotations.tags')}</label>
      <div className="annotation-tags">{draft?.tags.map(tag => <span key={tag}>{tag}<Button variant="ghost" type="button" size="sm" disabled={disabled} aria-label={t('annotations.removeTag', { tag })} onClick={() => admit(() => controller.removeTag(owned.id, tag, state!.scope))}>×</Button></span>)}</div>
      <div className="annotation-tag-input"><Input id="asset-annotation-tag" data-testid="annotation-tag-input" value={draft?.tagInput || ''} disabled={disabled} onChange={event => admit(() => controller.editTagInput(owned.id, event.target.value, state!.scope))} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); admit(() => controller.addTag(owned.id, state!.scope)); } }} /><Button type="button" variant="outline" size="sm" data-testid="annotation-add-tag" disabled={disabled || !draft?.tagInput.trim()} onClick={() => admit(() => controller.addTag(owned.id, state!.scope))}>{t('annotations.addTag')}</Button></div>
      <label htmlFor="asset-annotation-note">{t('annotations.note')}</label>
      <Textarea id="asset-annotation-note" data-testid="annotation-note" rows={4} value={draft?.note || ''} disabled={disabled} onChange={event => admit(() => controller.editNote(owned.id, event.target.value, state!.scope))} />
      <p className="annotation-hint">{t('annotations.limits')} ({formatNumber([...(draft?.note || '')].length)}/4,000)</p>
      <div className="annotation-actions">
        <Button type="button" variant="outline" size="sm" data-testid="annotation-save" disabled={disabled || !entry?.verified || !entry.dirty || entry.conflict || Boolean(draft?.tagInput)} onClick={() => admit(() => controller.save(owned.id, state!.scope))}>{t('annotations.save')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-discard" disabled={!visible || !entry?.row || entry.saving || entry.uncertain || !entry.dirty && !entry.conflict} onClick={() => admit(() => controller.discard(owned.id, state!.scope))}>{t('annotations.discard')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-clear" disabled={disabled || !draft || !draft.tags.length && !draft.note && !draft.tagInput} onClick={() => admit(() => controller.clear(owned.id, state!.scope))}>{t('annotations.clear')}</Button>
        <Button type="button" variant="ghost" size="sm" data-testid="annotation-refresh" disabled={!visible || state?.loading || entry?.saving} onClick={() => admit(() => controller.refresh())}>{t('annotations.refresh')}</Button>
      </div>
      {entry?.uncertain && <Button type="button" variant="ghost" size="sm" data-testid="annotation-tasks" onClick={() => admit(() => onShowTasks?.())}>{t('annotations.viewTasks')}</Button>}
    </>}
    <p className="annotation-hint">{t('annotations.local')}</p><p className="annotation-hint">{t('annotations.session')}</p>
  </section>;
}
