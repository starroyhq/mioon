import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchTooltip } from '@mioon/ui/components/workbench-tooltip';
import { Camera, Check, Lock, Sun, Upload } from '@mioon/ui/components/workbench-icons';
import BoardInspectorGroup from './BoardInspectorGroup.tsx';
import AgentEditingBoundary from './AgentEditingBoundary.tsx';
import { ImageChoice, SubjectImage, SubjectNotice, SubjectPager } from './SubjectLibrary.tsx';
import type { SubjectAssetView, SubjectsBundle } from './SubjectLibrary.tsx';
import SubjectVariantDialog from './SubjectVariantDialog.tsx';
import { SubjectVariantBatchRow, SubjectVariantItemTile, SubjectVariantNotice } from './SubjectVariantRows.tsx';
import { activeSubjectBindings, subjectImage, subjectKindDescriptor, subjectVariantTagParts, subjectVersionOriginDescriptor } from './subject-state.ts';
import { shownSubjectVariantBatches } from './subject-variant-state.ts';
import type { SubjectVariantController, SubjectVariantState } from './subject-variant-state.ts';
import { useSubjectInteraction } from './use-subjects.ts';
import type { SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';
import './subjects.css';

export interface SubjectInspectorShot { id: string; title?: string; orderIndex?: number; [key: string]: unknown }
export interface SubjectVariantsBundle { state: SubjectVariantState | null; controller: SubjectVariantController }
export interface SubjectInspectorProps {
  subjects?: SubjectsBundle | null;
  /** Angle and lighting batches (C7c); without it the pane offers no new angles. */
  variants?: SubjectVariantsBundle | null;
  subjectId: string;
  assets?: readonly SubjectAssetView[];
  shots?: readonly SubjectInspectorShot[];
  blocked?: boolean;
  restored?: boolean;
  onShowTasks?: () => unknown;
  onInspectShot?: (shotId: string) => unknown;
}
// Only characters and products have a stable look to re-shoot.
const VARIANT_KINDS = new Set(['character', 'product']);

// The properties pane for one subject (09-10a): read-only basics, the version
// grid and the shots that use it. The name and type cannot change after
// creation, so nothing here is a form to save; a new version is appended
// explicitly and becomes the default. Angle and lighting versions (09-10c) are
// added to the grid in batches and never become the default.
export default function SubjectInspector({ subjects, variants = null, subjectId, assets = [], shots = [], blocked = false, restored = false, onShowTasks, onInspectShot }: SubjectInspectorProps): ReactElement {
  const { t, renderMessage, formatDate } = useI18n();
  const state = subjects?.state ?? null, controller = subjects?.controller ?? null;
  const subject = state?.subjects[subjectId];
  const versionDraft = state?.versionDrafts[subjectId];
  const interaction = useSubjectInteraction(state?.scope, controller, `${subjectId}:${versionDraft?.assetId || ''}:${versionDraft?.expectedRevision || ''}`);
  const [chosen, setChosen] = useState<{ subjectId: string; versionId: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [variantDialog, setVariantDialog] = useState<{ subjectId: string; sourceId: string } | null>(null);
  const variantState = variants?.state ?? null, variantControl = variants?.controller ?? null;
  const variantKind = Boolean(subject && VARIANT_KINDS.has(subject.kind));
  // The shown subject's batches are read when it is shown and polled while its
  // images move; a hidden pane polls nothing.
  const watching = Boolean(variantControl && variantState?.scope && variantState.projectId && interaction.visible && variantKind);
  useEffect(() => { if (!watching || !variantControl) return; void variantControl.watch(subjectId); return () => { variantControl.watch(null); }; }, [variantControl, watching, subjectId, variantState?.scope, variantState?.projectId]);
  useEffect(() => { variantControl?.setVisible(interaction.visible); }, [variantControl, interaction.visible]);
  const frame = (content: ReactNode): ReactElement => <aside className="inspector subject-inspector" data-testid="subject-inspector" aria-label={t('subjects.inspector.label')}>{content}</aside>;
  if (!state || !controller) return frame(<p className="subject-inspector-status" role="status">{t('subjects.library.loading')}</p>);
  if (!subject) return frame(<p className="subject-inspector-status" role="status">{t('subjects.inspector.unavailable')}</p>);
  const view = state, control = controller, scope = state.scope, admit = interaction.admit;
  const disabled = !interaction.visible || !scope || blocked || restored || Boolean(state.saving || state.uncertain);
  const versions = view.versions[subjectId], uses = view.uses[subjectId];
  const known: Record<string, SubjectVersionResponse> = { ...(versions?.known || {}), [subject.headVersion.id]: subject.headVersion };
  const items = versions?.items ?? [];
  const selected = (chosen?.subjectId === subjectId ? known[chosen.versionId] : undefined) ?? subject.headVersion;
  // A count is shown only for a complete single page; paged lists show the pager.
  const complete = versions?.phase === 'ready' && !versions.nextCursor && !versions.history.length;
  const kind = renderMessage(subjectKindDescriptor(subject.kind));
  const tag = (version: SubjectVersionResponse): string | null => { const parts = subjectVariantTagParts(version.variant); return parts ? parts.map(part => renderMessage(part)).join(' · ') : null; };
  const date = (value: string): string => { const at = new Date(value); return at.toDateString() === new Date().toDateString() ? t('subjects.inspector.today', { time: formatDate(at, { hour: '2-digit', minute: '2-digit' }) }) : formatDate(at, { month: 'numeric', day: 'numeric' }); };
  const images = assets.filter(asset => subjectImage(asset, view.projectId ?? null));
  const formOpen = adding === subjectId || Boolean(versionDraft?.assetId);
  const staleVersionDraft = Boolean(versionDraft?.assetId && versionDraft.expectedRevision !== subject.revision);
  const order = [...shots].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  // Usage follows storyboard order; bindings whose shot is not loaded go last.
  const position = (shotId: string): number => { const index = order.findIndex(item => item.id === shotId); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const active = [...activeSubjectBindings(uses)].sort((a, b) => position(a.shotId) - position(b.shotId));
  const selectedTag = tag(selected), selectedHead = selected.id === subject.headVersionId;
  // Batches: the newest and any unfinished one. Their images without a version
  // yet stand in the grid after the versions, on the list's last page.
  const batches = variantState ? shownSubjectVariantBatches(variantState.lists[subjectId], variantState.live) : [];
  const variantList = variantState?.lists[subjectId];
  const variantDisabled = disabled || !variantState || !variantControl || Boolean(variantState.busy || variantState.pending);
  const submittingBatch = variantState?.busy?.startsWith('submit:') ? variantState.busy.slice('submit:'.length) : null;
  const fresh = new Set(batches[0]?.items.flatMap(item => item.versionId ? [item.versionId] : []) ?? []);
  const placeholders = !versions?.nextCursor ? [...batches].reverse().flatMap(batch => batch.items.filter(item => item.status !== 'undone' && (item.status !== 'succeeded' || !known[item.versionId ?? ''])).map(item => ({ batch, item }))) : [];
  const variantReason = !variantKind ? t('subjects.variants.kindOnly') : variantState?.pending ? t('subjects.variants.pendingBlock') : variantState?.busy ? t('subjects.variants.busy') : null;
  const variantEntryId = `subject-variant-reason-${subjectId}`;
  const variantButton = <Button variant="ghost" size="sm" data-testid="subject-variant-open" aria-describedby={variantReason ? variantEntryId : undefined} disabled={!variantKind || variantDisabled} onClick={() => admit(() => { variantControl?.clearNotice(); setVariantDialog({ subjectId, sourceId: selected.id }); })}><Camera size={12} aria-hidden="true" />{t('subjects.inspector.variantAngle')}</Button>;
  const variantEntry = variants ? (variantReason ? <WorkbenchTooltip content={variantReason}><span className="subject-variant-entry">{variantButton}<span id={variantEntryId} className="sr-only">{variantReason}</span></span></WorkbenchTooltip> : <span className="subject-variant-entry">{variantButton}</span>) : null;
  const dialogVersions = [...new Map([subject.headVersion, ...items].map(version => [version.id, version])).values()].sort((a, b) => a.number - b.number);
  return frame(<>
    <header className="inspector-heading subject-inspector-heading"><span className="subject-kind-chip">{kind}</span><strong title={subject.name}>{t('subjects.inspector.title', { name: subject.name })}</strong>{complete && <span className="subject-inspector-count">{t('subjects.inspector.versionCount', { count: items.length })}</span>}</header>
    <ScrollArea style={{ flex: 1, minHeight: 0 }}><div className="inspector-scroll subject-inspector-scroll">
      <SubjectNotice state={state} onShowTasks={onShowTasks} admit={admit} />
      <BoardInspectorGroup key={`basics:${subjectId}`} title={t('subjects.inspector.basics')}>
        <dl className="subject-basics"><dt>{t('subjects.create.name')}</dt><dd>{subject.name}</dd><dt>{t('subjects.create.kind')}</dt><dd>{kind}</dd></dl>
        <p className="subject-readonly-hint"><Lock size={11} aria-hidden="true" />{t('subjects.inspector.readOnly')}</p>
      </BoardInspectorGroup>
      <BoardInspectorGroup key={`versions:${subjectId}`} title={t('subjects.inspector.versions')} meta={complete ? items.length : undefined}
        actions={<>{variantEntry}<WorkbenchTooltip content={t('subjects.version.addImage')}><Button variant="ghost" size="sm" className="icon-button" aria-label={t('subjects.version.addImage')} aria-expanded={formOpen} data-testid="subject-version-add-open" disabled={!interaction.visible || restored} onClick={() => admit(() => setAdding(formOpen && !versionDraft?.assetId ? null : subjectId))}><Upload size={14} /></Button></WorkbenchTooltip></>}>
        {variantState && variantControl && <SubjectVariantNotice state={variantState} controller={variantControl} disabled={disabled} admit={admit} />}
        {variantList?.phase === 'error' && variantList.error && <div className="subject-variant-notice"><p role="alert" className="subject-warning">{renderMessage(variantList.error)}</p><div className="subject-actions"><Button variant="ghost" size="sm" data-testid="subject-variant-list-reread" disabled={!interaction.visible} onClick={() => admit(() => variantControl?.readSubject(subjectId))}>{t('subjects.variants.reconcile')}</Button></div></div>}
        {variantState && variantControl && batches.map(batch => <SubjectVariantBatchRow key={batch.id} batch={batch} shots={shots} submitting={submittingBatch === batch.id} issues={variantState.issues} controller={variantControl} versions={known} disabled={variantDisabled} admit={admit} onShowTasks={onShowTasks} />)}
        {formOpen && <AgentEditingBoundary disabled={restored} projectId={view.projectId} targets={[{ kind: 'subject', id: subject.id, revision: subject.revision }]} canRelease={() => { const current = control.getState(); return !current.versionDrafts[subject.id]?.assetId && !current.saving && !current.uncertain; }} onDiscard={() => { const current = control.getState(); if (current.scope === scope && !current.saving && !current.uncertain) control.updateVersion(subject.id, '', scope); }}>
          <div className="subject-form"><Label htmlFor="subject-version-image">{t('subjects.version.addImage')}</Label><ImageChoice id="subject-version-image" value={versionDraft?.assetId || ''} assets={images} disabled={disabled || view.list.phase !== 'ready'} onChange={assetId => admit(() => control.updateVersion(subject.id, assetId, scope))} />{versionDraft?.assetId && <SubjectImage version={{ assetId: versionDraft.assetId, projectId: view.projectId }} assets={assets} label={t('subjects.version.selectedImage')} />}{staleVersionDraft && <p className="subject-warning" role="alert">{t('subjects.version.staleDraft')}</p>}<div className="subject-actions"><Button size="sm" data-testid="subject-add-version" disabled={disabled || view.list.phase !== 'ready' || staleVersionDraft || !images.some(asset => asset.id === versionDraft?.assetId)} onClick={() => admit(() => control.addVersion(subject.id, scope))}>{t('subjects.version.add')}</Button>{versionDraft?.assetId && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => admit(() => control.updateVersion(subject.id, '', scope))}>{t('subjects.version.discard')}</Button>}</div><p className="subject-helper">{t('subjects.version.retained')}</p></div>
        </AgentEditingBoundary>}
        {versions?.phase === 'loading' && <p role="status">{t('subjects.version.loading')}</p>}
        {versions?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(versions.error)}</p>}
        <div className="subject-version-grid" role="list" aria-label={t('subjects.version.heading')}>{items.map(version => {
          const head = version.id === subject.headVersionId, label = tag(version), current = version.id === selected.id;
          return <div key={version.id} className="subject-version-tile" role="listitem"><Button variant="ghost" className={`subject-version-thumb${current ? ' selected' : ''}`} data-testid={`subject-version-${version.id}`} aria-pressed={current} aria-label={t('subjects.inspector.viewVersion', { number: version.number })} disabled={!interaction.visible} onClick={() => admit(() => setChosen({ subjectId, versionId: version.id }))}><SubjectImage version={version} assets={assets} label={`${subject.name} V${version.number}`} /><span className="subject-version-number">V{version.number}</span>{head && <span className="subject-version-default" aria-hidden="true"><Check size={10} /></span>}{fresh.has(version.id) && <span className="subject-version-new">{t('subjects.variants.newBadge')}</span>}</Button>
            <span className={`subject-version-label${label ? ' is-tag' : ''}`}>{label ? <>{version.variant?.kind === 'light' ? <Sun size={10} aria-hidden="true" /> : <Camera size={10} aria-hidden="true" />}{label}</> : head ? t('subjects.inspector.defaultVersion') : renderMessage(subjectVersionOriginDescriptor(version))}</span></div>;
        })}{variantState && variantControl && placeholders.map(({ batch, item }) => <SubjectVariantItemTile key={`${batch.id}:${item.position}`} batch={batch} item={item} submitting={submittingBatch === batch.id} controller={variantControl} versions={known} disabled={variantDisabled} admit={admit} />)}</div>
        {versions && (versions.history.length > 0 || versions.nextCursor) && <SubjectPager label={t('subjects.pager.versions')} entry={versions} disabled={!interaction.visible || versions.phase !== 'ready'} onPage={direction => admit(() => control.versionPage(subjectId, direction, scope))} />}
        <div className="subject-version-detail" data-testid="subject-version-detail">
          <div className="subject-version-detail-title"><strong>V{selected.number}{selectedTag ? ` · ${selectedTag}` : ''}</strong>{selectedHead ? <span className="subject-badge">{t('subjects.inspector.defaultVersion')}</span> : selected.variant ? <span className="subject-badge is-variant">{selected.variant.kind === 'light' ? t('subjects.inspector.variantLight') : t('subjects.inspector.variantAngle')}</span> : null}</div>
          <p className="subject-version-meta">{renderMessage(subjectVersionOriginDescriptor(selected))} · {selected.width}×{selected.height} · {date(selected.createdAt)}</p>
          {selected.variant?.kind === 'light' && <p className="subject-version-meta">{t('subjects.light.detail', { azimuth: selected.variant.azimuth, elevation: selected.variant.elevation, kelvin: selected.variant.kelvin })}</p>}
          {selected.variant && <p className="subject-helper">{t('subjects.inspector.variantNote', { number: subject.headVersion.number, name: subject.name })}</p>}
        </div>
      </BoardInspectorGroup>
      <BoardInspectorGroup key={`usage:${subjectId}`} title={t('subjects.inspector.usage')} meta={uses?.phase === 'ready' && !uses.nextCursor ? active.length : undefined}>
        <p className="subject-local-note">{t('subjects.library.planningNote')}</p>
        {uses?.phase === 'loading' && <p role="status">{t('subjects.binding.loading')}</p>}
        {uses?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(uses.error)}</p>}
        {uses?.phase === 'ready' && !active.length && <p className="subject-helper">{t('subjects.binding.noneLoaded')}</p>}
        {active.length > 0 && <ul className="subject-usage" aria-label={t('subjects.binding.heading')}>{active.map(binding => {
          const shot = shots.find(item => item.id === binding.shotId), index = order.findIndex(item => item.id === binding.shotId);
          const pinned = binding.subjectVersionId ? known[binding.subjectVersionId] : undefined, pinnedTag = pinned ? tag(pinned) : null;
          return <li key={binding.id}><Button variant="ghost" className="subject-usage-row" data-testid={`subject-use-${binding.id}`} disabled={!interaction.visible || !shot || !onInspectShot} onClick={() => admit(() => onInspectShot?.(binding.shotId))}><span className="subject-usage-index">{index >= 0 ? String(index + 1).padStart(2, '0') : '—'}</span><span className="subject-usage-title">{shot?.title || t('subjects.binding.shotMissing')}</span><span className={`subject-usage-version${binding.needsReview ? ' needs-review' : ''}`}>{binding.needsReview ? t('subjects.inspector.needsReview') : pinned ? `V${pinned.number}${pinnedTag ? ` · ${pinnedTag}` : ''}` : t('subjects.binding.pinnedLoading')}</span></Button></li>;
        })}</ul>}
        {uses?.nextCursor && <Button variant="ghost" size="sm" disabled={!interaction.visible || uses.phase !== 'ready'} onClick={() => admit(() => control.readUses(subjectId, scope, true))}>{t('subjects.binding.loadMore')}</Button>}
      </BoardInspectorGroup>
    </div></ScrollArea>
    {variantDialog?.subjectId === subjectId && variantKind && variantControl && <SubjectVariantDialog subject={subject} versions={dialogVersions} initialSourceId={variantDialog.sourceId} assets={assets} controller={variantControl} blocked={variantDisabled} notice={variantState?.notice ?? null} onClose={() => setVariantDialog(null)} />}
  </>);
}
