import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { Plus, RefreshCw, Search } from '@mioon/ui/components/workbench-icons';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { assetUrl } from './api.ts';
import { createSubjectController, subjectKinds, subjectKindDescriptor, subjectImage, filterSubjects } from './subject-state.ts';
import type { SubjectState } from './subject-state.ts';
import { useSubjectInteraction } from './use-subjects.ts';
import type { UseSubjectsResult } from './use-subjects.ts';
import './subjects.css';

export interface SubjectAssetView { id?: string; projectId?: string; name?: string; mimeType?: string; [key: string]: unknown }
export interface SubjectVersionLike { id?: string; assetId?: string; projectId?: string | null; number?: number; width?: number; height?: number }
export type SubjectsController = ReturnType<typeof createSubjectController>;
export type SubjectsBundle = UseSubjectsResult;
export interface SubjectInteraction { visible: boolean; admit: (action: () => unknown) => unknown }
export interface SubjectPagerEntry { history: (string | null)[]; items: readonly unknown[]; nextCursor: string | null }

export function SubjectImage({ version, assets, label = '' }: { version?: SubjectVersionLike | null; assets: readonly SubjectAssetView[]; label?: string }): ReactElement {
  const { t, renderMessage } = useI18n();
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version?.projectId);
  const [failed, setFailed] = useState<string | null>(null);
  if (!version || !asset || failed === version.assetId) return <span className="subject-image-missing" role="status">{version ? t('subjects.image.missing') : t('subjects.version.notLoaded')}</span>;
  return <img className="subject-image" src={assetUrl(asset)} alt={label || asset.name} loading="lazy" onError={() => setFailed(version.assetId ?? null)} />;
}
export function SubjectNotice({ state, onShowTasks, admit = action => action() }: { state?: SubjectState | null; onShowTasks?: () => unknown; admit?: (action: () => unknown) => unknown }): ReactElement {
  const { t, renderMessage } = useI18n();
  return <>{state?.mutationError && <p className="subject-warning" role="alert">{renderMessage(state.mutationError)}</p>}{state?.uncertain && <div className="subject-warning" role="status"><p>{t('subjects.mutation.pending')}</p><Button variant="ghost" size="sm" onClick={() => admit(() => onShowTasks?.())}>{t('subjects.mutation.showRequest')}</Button></div>}</>;
}
export function SubjectPager({ entry, onPage, disabled, label }: { entry?: SubjectPagerEntry | null; onPage: (direction: 'previous' | 'next') => unknown; disabled?: boolean; label?: string }): ReactElement {
  const { t, renderMessage } = useI18n();
  return <div className="subject-pagination" data-text-selectable={false} aria-label={t('subjects.pager.label', { label: label || t('subjects.pager.subjects') })}><Button variant="ghost" size="sm" disabled={disabled || !entry?.history?.length} onClick={() => onPage('previous')}>{t('subjects.pager.previous')}</Button><span>{t('subjects.pager.status', { page: (entry?.history?.length || 0) + 1, count: entry?.items.length || 0 })}</span><Button variant="ghost" size="sm" disabled={disabled || !entry?.nextCursor} onClick={() => onPage('next')}>{t('subjects.pager.next')}</Button></div>;
}
export function ImageChoice({ id, value, assets, disabled, onChange }: { id: string; value: string; assets: readonly SubjectAssetView[]; disabled: boolean; onChange: (assetId: string) => unknown }): ReactElement {
  const { t, renderMessage } = useI18n();
  const missing = Boolean(value && !assets.some(asset => asset.id === value));
  return <><WorkbenchSelect id={id} data-testid={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">{t('subjects.image.choose')}</option>{missing && <option value={value} disabled>{t('subjects.image.selectedMissing')}</option>}{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</WorkbenchSelect>{missing && <p className="subject-warning" role="status">{t('subjects.image.chooseAnother')}</p>}</>;
}

export interface SubjectLibraryProps {
  subjects?: SubjectsBundle | null;
  assets?: readonly SubjectAssetView[];
  shots?: readonly { id: string; title?: string; [key: string]: unknown }[];
  blocked?: boolean;
  restored?: boolean;
  onShowTasks?: () => unknown;
  onInspectShot?: (shotId: string) => unknown;
  /** Shows the subject in the properties pane. Without a host the card only selects it. */
  onInspectSubject?: (subjectId: string) => unknown;
  /** The subject the properties pane currently shows; undefined falls back to the selection. */
  inspectedSubjectId?: string | null;
}
interface SubjectFilters { scope: string | null | undefined; kind: string; search: string }
// The library lists subjects and creates them. A chosen subject's versions,
// variants and shot usage live in the properties pane (SubjectInspector).
export default function SubjectLibrary({ subjects, assets = [], blocked = false, onShowTasks, onInspectSubject, inspectedSubjectId }: SubjectLibraryProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const state = subjects?.state, controller = subjects?.controller;
  const [filters, setFilters] = useState<SubjectFilters>({ scope: null, kind: 'all', search: '' });
  const [creation, setCreation] = useState<{ scope: string | null | undefined; open: boolean }>({ scope: null, open: false });
  const local = filters.scope === state?.scope ? filters : { kind: 'all', search: '' };
  const draft = state?.createDraft;
  const interaction = useSubjectInteraction(state?.scope, controller, `${state?.selectedSubjectId}:${draft?.serial}`);
  // The hook withholds the previous project's state until its new context is
  // installed. This mounted (possibly hidden) pane must handle that transition.
  if (!state || !controller) return <section className="subject-library" data-testid="subject-library" aria-label={t('subjects.library.label')}><p role="status">{t('subjects.library.loading')}</p></section>;
  const view = state, control = controller;
  const admit = interaction.admit, scope = state.scope;
  const disabled = !interaction.visible || !scope || blocked || Boolean(state.saving || state.uncertain);
  const images = assets.filter(asset => subjectImage(asset, state.projectId ?? null));
  const visible = filterSubjects(state.list.items || [], local);
  const highlighted = inspectedSubjectId === undefined ? state.selectedSubjectId : inspectedSubjectId;
  const createOpen = creation.scope === scope && creation.open || Boolean(draft?.name || draft?.assetId || draft?.kind !== 'character' && draft?.kind);
  const changeFilter = (patch: Partial<Pick<SubjectFilters, 'kind' | 'search'>>): unknown => admit(() => setFilters({ scope, ...local, ...patch }));
  const kindChoices: [string, string][] = [['all', t('subjects.library.allChip')], ...subjectKinds.map(([kind]): [string, string] => [kind, renderMessage(subjectKindDescriptor(kind))])];
  const paged = Boolean(view.list.history.length || view.list.nextCursor);
  return <section className="subject-library" data-testid="subject-library" aria-label={t('subjects.library.label')}>
    <div className="subject-library-toolbar" data-text-selectable={false}><Button variant="outline" size="sm" className="subject-new" disabled={disabled} data-testid="subject-new" aria-expanded={createOpen} onClick={() => admit(() => setCreation({ scope, open: !createOpen }))}><Plus size={14} />{t('subjects.library.new')}</Button></div>
    <div className="subject-search"><span className="subject-search-field"><Search size={13} aria-hidden="true" /><Input aria-label={t('subjects.library.search')} placeholder={t('subjects.library.searchPlaceholder')} value={local.search} disabled={!interaction.visible} onChange={event => changeFilter({ search: event.target.value })} /></span>
      <div className="subject-kind-chips" role="group" aria-label={t('subjects.library.kindFilter')} data-text-selectable={false}>{kindChoices.map(([kind, label]) => <Button key={kind} variant="ghost" size="sm" className="subject-kind-chip" data-testid={`subject-kind-${kind}`} aria-pressed={local.kind === kind} disabled={!interaction.visible} onClick={() => changeFilter({ kind })}>{label}</Button>)}</div></div>
    <div className="subject-library-status" data-text-selectable={false}><span role="status">{view.list.phase === 'ready' ? t('subjects.library.count', { count: visible.length }) : ''}</span><Button variant="ghost" size="sm" className="icon-button" aria-label={t('subjects.library.refresh')} title={t('subjects.library.refresh')} data-testid="subject-refresh" disabled={!interaction.visible || !scope || Boolean(state.saving) || state.list.phase === 'loading'} onClick={() => admit(() => control.read())}><RefreshCw size={13} /></Button></div>
    <ScrollArea className="subject-scroll-area"><div className="subject-library-scroll">
      <SubjectNotice state={state} onShowTasks={onShowTasks} admit={admit} />
      {createOpen && draft && <section className="subject-form" aria-label={t('subjects.library.new')}><h3>{t('subjects.create.heading')}</h3><Label htmlFor="subject-name">{t('subjects.create.name')}</Label><Input id="subject-name" data-testid="subject-name" value={draft.name} maxLength={120} disabled={disabled} onChange={event => admit(() => control.updateCreate({ name: event.target.value }, scope))} /><Label htmlFor="subject-kind">{t('subjects.create.kind')}</Label><WorkbenchSelect id="subject-kind" value={draft.kind} disabled={disabled} onChange={event => admit(() => control.updateCreate({ kind: event.target.value }, scope))}>{subjectKinds.map(([kind]) => <option key={kind} value={kind}>{renderMessage(subjectKindDescriptor(kind))}</option>)}</WorkbenchSelect><Label htmlFor="subject-create-image">{t('subjects.create.firstImage')}</Label><ImageChoice id="subject-create-image" value={draft.assetId} assets={images} disabled={disabled} onChange={assetId => admit(() => control.updateCreate({ assetId }, scope))} />{draft.assetId && <SubjectImage version={{ assetId: draft.assetId, projectId: view.projectId }} assets={assets} label={t('subjects.create.selectedImage')} />}{!images.length && <p className="subject-empty">{t('subjects.create.importFirst')}</p>}<p className="subject-helper">{t('subjects.create.retained')}</p><div className="subject-actions"><Button size="sm" data-testid="subject-create" disabled={disabled || !draft.name.trim() || !images.some(asset => asset.id === draft.assetId)} onClick={() => admit(() => control.create(scope))}>{state.saving === 'subject.create' ? t('subjects.create.saving') : t('subjects.create.submit')}</Button><Button variant="ghost" size="sm" disabled={Boolean(state.saving) || !interaction.visible} onClick={() => admit(() => { control.resetCreate(scope); setCreation({ scope, open: false }); })}>{t('subjects.create.discard')}</Button></div></section>}
      {view.list.phase === 'loading' && <p role="status">{t('subjects.library.loading')}</p>}
      {view.list.phase === 'error' && <p className="subject-warning" role="alert">{renderMessage(view.list.error)} {t('subjects.library.staleRead')}</p>}
      {view.list.phase === 'ready' && !visible.length && <p className="subject-empty">{view.list.items.length ? t('subjects.library.noMatches') : t('subjects.library.empty')}</p>}
      <div className="subject-cards">{visible.map(subject => <Button variant="ghost" key={subject.id} className={`subject-card ${highlighted === subject.id ? 'selected' : ''}`} data-testid={`subject-card-${subject.id}`} aria-pressed={highlighted === subject.id} disabled={!interaction.visible || view.list.phase !== 'ready'} onClick={() => admit(() => onInspectSubject ? onInspectSubject(subject.id) : control.selectSubject(subject.id, scope))}><SubjectImage version={subject.headVersion} assets={assets} label={subject.name} /><span className="subject-card-text"><span className="subject-card-title"><strong>{subject.name}</strong><small>{renderMessage(subjectKindDescriptor(subject.kind))}</small></span><small>{t('subjects.library.defaultVersion', { number: subject.headVersion.number })}</small></span></Button>)}</div>
      {paged && <SubjectPager entry={state.list} disabled={!interaction.visible || !scope || state.list.phase === 'loading'} onPage={direction => admit(() => control.subjectPage(direction, scope))} />}
    </div></ScrollArea>
  </section>;
}
