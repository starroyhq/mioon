import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.tsx';
import { activeSubjectBindings, subjectKindDescriptor } from './subject-state.ts';
import type { SubjectState } from './subject-state.ts';
import { useSubjectInteraction } from './use-subjects.ts';
import { SubjectImage, SubjectNotice, SubjectPager } from './SubjectLibrary.tsx';
import type { SubjectAssetView, SubjectInteraction, SubjectsBundle, SubjectsController } from './SubjectLibrary.tsx';
import type { SubjectBindingResponse, SubjectResponse, SubjectVersionResponse } from '../../../packages/contracts/src/subjects.ts';

const useInteraction = useSubjectInteraction as unknown as (scope: string | null | undefined, controller: SubjectsController | null | undefined, target: unknown) => SubjectInteraction;
export interface BoundSubjectProps {
  binding: SubjectBindingResponse;
  state: SubjectState;
  controller: SubjectsController;
  assets: readonly SubjectAssetView[];
  disabled: boolean;
  scope: string | null;
}
export interface ShotSubjectBindingsProps {
  shot?: { id: string; [key: string]: unknown } | null;
  subjects?: SubjectsBundle | null;
  assets?: readonly SubjectAssetView[];
  blocked?: boolean;
  onShowTasks?: () => unknown;
}

export function BoundSubject({ binding, state, controller, assets, disabled, scope }: BoundSubjectProps): ReactElement {
  const { t, renderMessage } = useI18n();
  const interaction = useInteraction(scope, controller, binding);
  const subject = state.subjects[binding.subjectId], versions = state.versions[binding.subjectId];
  const pinned = subject?.headVersion.id === binding.subjectVersionId ? subject.headVersion : versions?.known?.[binding.subjectVersionId ?? ''];
  const head = subject?.headVersionId === binding.headVersionId ? subject.headVersion : versions?.known?.[binding.headVersionId];
  useEffect(() => { if (interaction.visible && (!versions || !head)) void controller.readVersions(binding.subjectId, scope); }, [binding.subjectId, binding.headVersionId, scope, interaction.visible, controller]);
  const label = subject?.name || t('subjects.binding.subjectFallback', { id: binding.subjectId.slice(0, 8) });
  const act = (versionId: string | null): unknown => interaction.admit(() => controller.reviewBinding(binding, versionId, scope));
  const locked = disabled || !interaction.visible;
  return <article className="shot-subject-binding" data-testid={`shot-subject-binding-${binding.id}`}><div className="shot-subject-heading">{!binding.needsReview && <SubjectImage version={pinned} assets={assets} label={label} />}<div><strong>{label}</strong><span>{binding.role === 'style' ? t('subjects.binding.styleReference') : t('subjects.binding.subjectReference')} · {pinned ? t('subjects.binding.pinnedVersion', { number: pinned.number }) : t('subjects.binding.pinnedLoading')}</span><small>{t('subjects.binding.revision', { revision: binding.revision })}</small></div></div>{versions?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(versions.error)}</p>}{(!pinned || !head) && <div className="subject-actions"><Button variant="ghost" size="sm" disabled={!interaction.visible || versions?.phase === 'loading'} onClick={() => interaction.admit(() => controller.readVersions(binding.subjectId, scope))}>{t('subjects.version.reload')}</Button>{versions?.nextCursor && <Button variant="ghost" size="sm" disabled={!interaction.visible || versions.phase !== 'ready'} onClick={() => interaction.admit(() => controller.versionPage(binding.subjectId, 'next', scope))}>{t('subjects.version.loadMore')}</Button>}</div>}{binding.needsReview && <div className="subject-review" role="status"><div className="subject-review-images"><div data-testid={`subject-review-pinned-${binding.id}`}><span>{pinned ? t('subjects.binding.currentPinned', { number: pinned.number }) : t('subjects.binding.currentPinnedUnknown')}</span><SubjectImage version={pinned} assets={assets} label={t('subjects.binding.imageLabel', { name: label, status: pinned ? t('subjects.binding.currentPinned', { number: pinned.number }) : t('subjects.binding.currentPinnedUnknown') })} /></div><div data-testid={`subject-review-head-${binding.id}`}><span>{head ? t('subjects.binding.candidate', { number: head.number }) : t('subjects.binding.candidateUnknown')}</span><SubjectImage version={head} assets={assets} label={t('subjects.binding.imageLabel', { name: label, status: head ? t('subjects.binding.candidate', { number: head.number }) : t('subjects.binding.candidateUnknown') })} /></div></div><p>{t('subjects.binding.reviewSummary', { head: head ? `V${head.number}` : t('subjects.binding.newVersion'), pinned: pinned ? `V${pinned.number}` : t('subjects.binding.oldVersion') })}</p><div className="subject-actions"><Button size="sm" data-testid={`subject-use-head-${binding.id}`} disabled={locked || !head || !pinned} onClick={() => act(binding.headVersionId)}>{t('subjects.binding.useVersion', { version: head ? `V${head.number}` : t('subjects.binding.newVersion') })}</Button><Button variant="outline" size="sm" data-testid={`subject-keep-version-${binding.id}`} disabled={locked || !pinned} onClick={() => act(binding.subjectVersionId)}>{t('subjects.binding.keepVersion', { version: pinned ? `V${pinned.number}` : t('subjects.binding.oldVersion') })}</Button></div></div>}<Button variant="ghost" size="sm" data-testid={`subject-unlink-${binding.id}`} disabled={locked} onClick={() => act(null)}>{t('subjects.binding.unlink')}</Button></article>;
}

export default function ShotSubjectBindings({ shot, subjects, assets = [], blocked = false, onShowTasks }: ShotSubjectBindingsProps): ReactElement | null {
  const { t, renderMessage } = useI18n();
  const state = subjects?.state, controller = subjects?.controller, scope = state?.scope;
  const entry = state?.bindings[shot?.id ?? ''], draft = state?.bindingDrafts[shot?.id ?? ''];
  const interaction = useInteraction(scope, controller, `${shot?.id}:${draft?.subjectId || ''}:${draft?.subjectVersionId || ''}:${draft?.expectedRevision ?? ''}:${draft?.expectedSubjectRevision ?? ''}`);
  useEffect(() => { if (interaction.visible && shot?.id && scope && controller) void controller.readBindings(shot.id, scope); }, [shot?.id, scope, interaction.visible, controller]);
  const subject: SubjectResponse | undefined = state?.subjects[draft?.subjectId ?? ''], versions = state?.versions[draft?.subjectId ?? ''];
  const active = activeSubjectBindings(entry), complete = entry?.phase === 'ready' && !entry.nextCursor;
  const disabled = !interaction.visible || !scope || blocked || !complete || Boolean(state?.saving || state?.uncertain);
  const existing = entry?.items.find(row => row.subjectId === draft?.subjectId);
  const draftStale = Boolean(draft && ((existing?.revision || 0) !== draft.expectedRevision || subject?.revision !== draft.expectedSubjectRevision));
  const knownVersions: SubjectVersionResponse[] = subject ? [...new Map<string, SubjectVersionResponse>([subject.headVersion, ...Object.values(versions?.known || {})].map(version => [version.id, version])).values()].sort((a, b) => b.number - a.number) : [];
  const chosenVersion = knownVersions.find(version => version.id === draft?.subjectVersionId);
  const choices = state?.list.items || [];
  const selectedOutside = subject && !choices.some(item => item.id === subject.id) ? [subject] : [];
  if (!shot || !state || !controller) return null;
  const view: SubjectState = state, control: SubjectsController = controller;
  return <section className="shot-subjects" data-testid="shot-subjects" aria-label={t('subjects.binding.sectionLabel')}><header><h3>{t('subjects.binding.title')}</h3><span>{complete ? `${active.length} / 8` : t('subjects.binding.unverified')}</span><Button variant="ghost" size="sm" disabled={!interaction.visible || Boolean(view.saving) || entry?.phase === 'loading'} onClick={() => interaction.admit(() => control.readBindings(shot.id, scope))}>{t('subjects.library.refresh')}</Button></header><p className="subject-local-note">{t('subjects.library.planningNote')}</p><SubjectNotice state={state} onShowTasks={onShowTasks} admit={interaction.admit} />{(!entry || entry.phase === 'loading') && <p role="status">{t('subjects.binding.loading')}</p>}{entry?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(entry.error)} {t('subjects.binding.unknown')}</p>}{entry?.nextCursor && <div className="subject-warning"><p>{t('subjects.binding.incomplete')}</p><Button variant="ghost" size="sm" disabled={!interaction.visible || entry.phase !== 'ready'} onClick={() => interaction.admit(() => control.readBindings(shot.id, scope, true))}>{t('subjects.binding.continue')}</Button></div>}{active.map(binding => <BoundSubject key={binding.id} binding={binding} state={view} controller={control} assets={assets} disabled={disabled} scope={view.scope} />)}{complete && !active.length && <p className="subject-empty">{t('subjects.binding.empty')}</p>}
    <div className="subject-form"><Label htmlFor="shot-subject-choice">{t('subjects.binding.chooseLabel')}</Label><WorkbenchSelect id="shot-subject-choice" data-testid="shot-subject-choice" value={draft?.subjectId || ''} disabled={disabled || view.list.phase !== 'ready'} onChange={event => interaction.admit(() => { const selected = [...choices, ...selectedOutside].find(item => item.id === event.target.value); if (selected) control.chooseBinding(shot.id, selected.id, selected.headVersionId, scope); else control.resetBinding(shot.id, scope); })}><option value="">{t('subjects.binding.choose')}</option>{[...choices, ...selectedOutside].map(item => <option key={item.id} value={item.id}>{item.name} · {renderMessage(subjectKindDescriptor(item.kind))} · V{item.headVersion.number}</option>)}</WorkbenchSelect><SubjectPager entry={state.list} disabled={!interaction.visible || view.list.phase !== 'ready'} onPage={direction => interaction.admit(() => control.subjectPage(direction, scope))} />{draft && subject && <><Label htmlFor="shot-subject-version">{t('subjects.binding.fixedImage')}</Label><WorkbenchSelect id="shot-subject-version" data-testid="shot-subject-version" value={draft.subjectVersionId} disabled={disabled} onChange={event => interaction.admit(() => controller.chooseBinding(shot.id, subject.id, event.target.value, scope))}>{knownVersions.map(version => <option key={version.id} value={version.id}>V{version.number}{version.id === subject.headVersionId ? t('subjects.version.currentSuffix') : ''}</option>)}</WorkbenchSelect><div className="subject-draft-preview" data-testid="shot-subject-selected-preview"><span>{chosenVersion ? t('subjects.binding.selectedVersion', { number: chosenVersion.number }) : t('subjects.binding.selectedUnknown')}</span><SubjectImage version={chosenVersion} assets={assets} label={t('subjects.binding.imageLabel', { name: subject.name, status: chosenVersion ? t('subjects.binding.selectedVersion', { number: chosenVersion.number }) : t('subjects.binding.selectedUnknown') })} /></div>{versions?.phase === 'error' && <p role="alert" className="subject-warning">{renderMessage(versions.error)}</p>}{versions?.nextCursor && <Button variant="ghost" size="sm" disabled={!interaction.visible || versions.phase !== 'ready'} onClick={() => interaction.admit(() => controller.versionPage(subject.id, 'next', scope))}>{t('subjects.version.loadMore')}</Button>}{draftStale && <p role="alert" className="subject-warning">{t('subjects.binding.staleDraft')}</p>}<p className="subject-helper">{subject.kind === 'look' ? t('subjects.binding.styleNote') : t('subjects.binding.subjectNote')}</p><div className="subject-actions"><Button size="sm" data-testid="shot-subject-save" disabled={disabled || draftStale || !existing?.subjectVersionId && active.length >= 8} onClick={() => interaction.admit(() => control.setBinding(shot.id, scope))}>{t('subjects.binding.save')}</Button><Button variant="ghost" size="sm" disabled={!interaction.visible || Boolean(view.saving)} onClick={() => interaction.admit(() => control.resetBinding(shot.id, scope))}>{t('subjects.binding.discard')}</Button></div></>}{active.length >= 8 && <p className="subject-helper">{t('subjects.binding.limit')}</p>}<p className="subject-helper">{t('subjects.binding.libraryHelp')}</p></div>
  </section>;
}
