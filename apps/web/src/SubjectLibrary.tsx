import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { ScrollArea } from '@mioon/ui/components/scroll-area';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { assetUrl } from './api.ts';
import { subjectKinds, subjectKindDescriptor, subjectImage, filterSubjects, activeSubjectBindings } from './subject-state.ts';
import { useSubjectInteraction } from './use-subjects.ts';
import './subjects.css';

export function SubjectImage({ version, assets, label = '' }) {
  const { t, renderMessage } = useI18n();
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version.projectId);
  const [failed, setFailed] = useState(null);
  if (!version || !asset || failed === version.assetId) return <span className="subject-image-missing" role="status">{version ? t('subjects.image.missing') : t('subjects.version.notLoaded')}</span>;
  return <img className="subject-image" src={assetUrl(asset)} alt={label || asset.name} loading="lazy" onError={() => setFailed(version.assetId)} />;
}
export function SubjectNotice({ state, onShowTasks, admit = action => action() }) {
  const { t, renderMessage } = useI18n();
  return <>{state?.mutationError && <p className="subject-warning" role="alert">{renderMessage(state.mutationError)}</p>}{state?.uncertain && <div className="subject-warning" role="status"><p>{t('subjects.mutation.pending')}</p><Button variant="ghost" size="sm" onClick={() => admit(() => onShowTasks?.())}>{t('subjects.mutation.showRequest')}</Button></div>}</>;
}
export function SubjectPager({ entry, onPage, disabled, label }) {
  const { t, renderMessage } = useI18n();
  return <div className="subject-pagination" aria-label={t('subjects.pager.label', { label: label || t('subjects.pager.subjects') })}><Button variant="ghost" size="sm" disabled={disabled || !entry?.history?.length} onClick={() => onPage('previous')}>{t('subjects.pager.previous')}</Button><span>{t('subjects.pager.status', { page: (entry?.history?.length || 0) + 1, count: entry?.items.length || 0 })}</span><Button variant="ghost" size="sm" disabled={disabled || !entry?.nextCursor} onClick={() => onPage('next')}>{t('subjects.pager.next')}</Button></div>;
}
function ImageChoice({ id, value, assets, disabled, onChange }) {
  const { t, renderMessage } = useI18n();
  const missing = Boolean(value && !assets.some(asset => asset.id === value));
  return <><WorkbenchSelect id={id} data-testid={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">{t('subjects.image.choose')}</option>{missing && <option value={value} disabled>{t('subjects.image.selectedMissing')}</option>}{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</WorkbenchSelect>{missing && <p className="subject-warning" role="status">{t('subjects.image.chooseAnother')}</p>}</>;
}

export default function SubjectLibrary({ subjects, assets = [], shots = [], blocked = false, onShowTasks, onInspectShot }) {
  const { t, renderMessage } = useI18n();
  const state = subjects?.state, controller = subjects?.controller;
  const [filters, setFilters] = useState({ scope: null, kind: 'all', search: '' });
  const [creation, setCreation] = useState({ scope: null, open: false });
  const local = filters.scope === state?.scope ? filters : { kind: 'all', search: '' };
  const selected = state?.subjects[state.selectedSubjectId], draft = state?.createDraft;
  const interaction = useSubjectInteraction(state?.scope, controller, `${state?.selectedSubjectId}:${draft?.serial}:${state?.versionDrafts[state?.selectedSubjectId]?.assetId || ''}:${state?.versionDrafts[state?.selectedSubjectId]?.expectedRevision || ''}`);
  const admit = interaction.admit, scope = state?.scope;
  const disabled = !interaction.visible || !scope || blocked || Boolean(state?.saving || state?.uncertain);
  const images = assets.filter(asset => subjectImage(asset, state?.projectId));
  const visible = filterSubjects(state?.list.items || [], local), versions = selected && state.versions[selected.id], uses = selected && state.uses[selected.id];
  const versionDraft = selected && state.versionDrafts[selected.id];
  const createOpen = creation.scope === scope && creation.open || Boolean(draft?.name || draft?.assetId || draft?.kind !== 'character' && draft?.kind);
  const changeFilter = patch => admit(() => setFilters({ scope, ...local, ...patch }));
  const reset = () => admit(() => { setFilters({ scope, kind: 'all', search: '' }); void controller.subjectPage('first', scope); });
  const staleVersionDraft = Boolean(versionDraft?.assetId && versionDraft.expectedRevision !== selected?.revision);
  return <section className="subject-library" data-testid="subject-library" aria-label={t('subjects.library.label')}>
    <div className="subject-library-toolbar"><Button variant="outline" size="sm" disabled={disabled} data-testid="subject-new" onClick={() => admit(() => setCreation({ scope, open: !createOpen }))}>{t('subjects.library.new')}</Button><Button variant="ghost" size="sm" disabled={!interaction.visible || !scope || Boolean(state?.saving) || state?.list.phase === 'loading'} onClick={() => admit(() => controller.read())}>{t('subjects.library.refresh')}</Button><Button variant="ghost" size="sm" disabled={!interaction.visible || !scope} onClick={reset}>{t('subjects.library.reset')}</Button></div>
    <p className="subject-local-note">{t('subjects.library.planningNote')}</p>
    <div className="subject-search"><Input aria-label={t('subjects.library.search')} placeholder={t('subjects.library.searchPlaceholder')} value={local.search} disabled={!interaction.visible} onChange={event => changeFilter({ search: event.target.value })} /><WorkbenchSelect aria-label={t('subjects.library.kindFilter')} value={local.kind} disabled={!interaction.visible} onChange={event => changeFilter({ kind: event.target.value })}><option value="all">{t('subjects.library.allKinds')}</option>{subjectKinds.map(([kind]) => <option key={kind} value={kind}>{renderMessage(subjectKindDescriptor(kind))}</option>)}</WorkbenchSelect></div>
    <SubjectPager entry={state?.list} disabled={!interaction.visible || !scope || state?.list.phase === 'loading'} onPage={direction => admit(() => controller.subjectPage(direction, scope))} />
    <ScrollArea className="subject-scroll-area"><div className="subject-library-scroll">
      <SubjectNotice state={state} onShowTasks={onShowTasks} admit={admit} />
      {createOpen && draft && <section className="subject-form" aria-label={t('subjects.library.new')}><h3>{t('subjects.create.heading')}</h3><Label htmlFor="subject-name">{t('subjects.create.name')}</Label><Input id="subject-name" data-testid="subject-name" value={draft.name} maxLength={120} disabled={disabled} onChange={event => admit(() => controller.updateCreate({ name: event.target.value }, scope))} /><Label htmlFor="subject-kind">{t('subjects.create.kind')}</Label><WorkbenchSelect id="subject-kind" value={draft.kind} disabled={disabled} onChange={event => admit(() => controller.updateCreate({ kind: event.target.value }, scope))}>{subjectKinds.map(([kind]) => <option key={kind} value={kind}>{renderMessage(subjectKindDescriptor(kind))}</option>)}</WorkbenchSelect><Label htmlFor="subject-create-image">{t('subjects.create.firstImage')}</Label><ImageChoice id="subject-create-image" value={draft.assetId} assets={images} disabled={disabled} onChange={assetId => admit(() => controller.updateCreate({ assetId }, scope))} />{draft.assetId && <SubjectImage version={{ assetId: draft.assetId, projectId: state.projectId }} assets={assets} label={t('subjects.create.selectedImage')} />}{!images.length && <p className="subject-empty">{t('subjects.create.importFirst')}</p>}<p className="subject-helper">{t('subjects.create.retained')}</p><div className="subject-actions"><Button size="sm" data-testid="subject-create" disabled={disabled || !draft.name.trim() || !images.some(asset => asset.id === draft.assetId)} onClick={() => admit(() => controller.create(scope))}>{state.saving === 'subject.create' ? t('subjects.create.saving') : t('subjects.create.submit')}</Button><Button variant="ghost" size="sm" disabled={Boolean(state.saving) || !interaction.visible} onClick={() => admit(() => { controller.resetCreate(scope); setCreation({ scope, open: false }); })}>{t('subjects.create.discard')}</Button></div></section>}
      {state?.list.phase === 'loading' && <p role="status">{t('subjects.library.loading')}</p>}
      {state?.list.phase === 'error' && <p className="subject-warning" role="alert">{renderMessage(state.list.error)} {t('subjects.library.staleRead')}</p>}
      {state?.list.phase === 'ready' && !visible.length && <p className="subject-empty">{state.list.items.length ? t('subjects.library.noMatches') : t('subjects.library.empty')}</p>}
      <div className="subject-cards">{visible.map(subject => <Button variant="ghost" key={subject.id} className={`subject-card ${selected?.id === subject.id ? 'selected' : ''}`} data-testid={`subject-card-${subject.id}`} aria-pressed={selected?.id === subject.id} disabled={!interaction.visible || state.list.phase !== 'ready'} onClick={() => admit(() => controller.selectSubject(subject.id, scope))}><SubjectImage version={subject.headVersion} assets={assets} label={subject.name} /><span><strong>{subject.name}</strong><small>{renderMessage(subjectKindDescriptor(subject.kind))} · V{subject.headVersion.number}</small></span></Button>)}</div>
      {selected && <section className="subject-detail" aria-label={t('subjects.version.detailLabel', { name: selected.name })}><header><div><h3>{selected.name}</h3><p>{t('subjects.version.currentSummary', { kind: renderMessage(subjectKindDescriptor(selected.kind)), number: selected.headVersion.number })}</p></div></header>{!visible.some(item => item.id === selected.id) && <p className="subject-helper">{t('subjects.version.outsideFilter')}</p>}
        <div className="subject-form"><Label htmlFor="subject-version-image">{t('subjects.version.addImage')}</Label><ImageChoice id="subject-version-image" value={versionDraft?.assetId || ''} assets={images} disabled={disabled || state?.list.phase !== 'ready'} onChange={assetId => admit(() => controller.updateVersion(selected.id, assetId, scope))} />{versionDraft?.assetId && <SubjectImage version={{ assetId: versionDraft.assetId, projectId: state.projectId }} assets={assets} label={t('subjects.version.selectedImage')} />}{staleVersionDraft && <p className="subject-warning" role="alert">{t('subjects.version.staleDraft')}</p>}<div className="subject-actions"><Button size="sm" data-testid="subject-add-version" disabled={disabled || state.list.phase !== 'ready' || staleVersionDraft || !images.some(asset => asset.id === versionDraft?.assetId)} onClick={() => admit(() => controller.addVersion(selected.id, scope))}>{t('subjects.version.add')}</Button>{versionDraft?.assetId && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => admit(() => controller.updateVersion(selected.id, '', scope))}>{t('subjects.version.discard')}</Button>}</div><p className="subject-helper">{t('subjects.version.retained')}</p></div>
        <h4>{t('subjects.version.heading')}</h4>{versions?.phase === 'loading' && <p role="status">{t('subjects.version.loading')}</p>}{versions?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(versions.error)}</p>}<div className="subject-version-grid">{(versions?.items || []).map(version => <div key={version.id} className="subject-version"><SubjectImage version={version} assets={assets} label={`${selected.name} V${version.number}`} /><strong>V{version.number}{version.id === selected.headVersionId ? t('subjects.version.currentSuffix') : ''}</strong><span>{version.width} × {version.height}</span></div>)}</div><SubjectPager label={t('subjects.pager.versions')} entry={versions} disabled={!interaction.visible || versions?.phase !== 'ready'} onPage={direction => admit(() => controller.versionPage(selected.id, direction, scope))} />
        <h4>{t('subjects.binding.heading')}</h4>{uses?.phase === 'loading' && <p role="status">{t('subjects.binding.loading')}</p>}{uses?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(uses.error)}</p>}{uses?.phase === 'ready' && !activeSubjectBindings(uses).length && <p className="subject-helper">{t('subjects.binding.noneLoaded')}</p>}{activeSubjectBindings(uses).map(binding => { const shot = shots.find(item => item.id === binding.shotId); return <div className="subject-use" key={binding.id}><span>{shot?.title || t('subjects.binding.shotMissing')}{binding.needsReview ? t('subjects.binding.reviewSuffix') : t('subjects.binding.pinnedSuffix')}</span><Button variant="ghost" size="sm" disabled={!interaction.visible || !shot || !onInspectShot} onClick={() => admit(() => onInspectShot?.(binding.shotId))}>{t('subjects.binding.viewShot')}</Button></div>; })}{uses?.nextCursor && <Button variant="ghost" size="sm" disabled={!interaction.visible || uses.phase !== 'ready'} onClick={() => admit(() => controller.readUses(selected.id, scope, true))}>{t('subjects.binding.loadMore')}</Button>}
      </section>}
    </div></ScrollArea>
  </section>;
}
