import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useEffect } from 'react';
import { Switch } from '@mioon/ui/components/switch';
import { Button } from '@mioon/ui/components/button';
import { Label } from '@mioon/ui/components/label';
import { WorkbenchSelect } from './WorkspaceControls.jsx';
import { SubjectPager } from './SubjectLibrary.jsx';
import { useSubjectInteraction } from './use-subjects.js';
import { subjectKindDescriptor } from './subject-state.js';
import SubjectVideoSummary from './SubjectVideoSummary.jsx';
import { subjectVideoProfileDescriptor } from './generation-settings.js';
import { subjectVideoChoice, subjectVideoConflictDescriptor, SUBJECT_VIDEO_KINDS, ARK_SUBJECT_WARNING_MESSAGE, MOCK_SUBJECT_WARNING_MESSAGE } from './subject-video.js';
import './subject-video-controls.css';

export default function SubjectVideoSelection({ shot, draft, subjects, assets = [], provider, model, options = {}, disabled, boundReference, onChange }) {
  const { t, renderMessage } = useI18n();
  const state = subjects?.state, controller = subjects?.controller, scope = state?.scope;
  const active = options.inputMode === 'subject';
  const reference = options.subjectReference;
  const subjectId = options.subjectId || reference?.subjectVersion?.subjectId || '';
  const subject = state?.subjects[subjectId];
  const versions = state?.versions[subjectId];
  const selectionKey = JSON.stringify([shot?.id, options, provider?.id, model, disabled, boundReference, shot?.revision, draft]);
  const interaction = useSubjectInteraction(scope, controller, selectionKey);
  useEffect(() => { if (interaction.visible && active && subjectId && scope && !versions) void controller.readVersions(subjectId, scope); }, [interaction.visible, active, subjectId, scope, controller, Boolean(versions)]);
  const conflict = subjectVideoConflictDescriptor(draft, { savedShot: shot, boundReference });
  const profileIssue = subjectVideoProfileDescriptor(provider, model);
  const libraryIssue = !state ? t('subjects.video.libraryLoading') : state.uncertain ? t('subjects.video.pending') : state.saving ? t('subjects.video.saving') : '';
  const locked = disabled || !interaction.visible || !state || Boolean(state?.saving || state?.uncertain);
  const chooseLocked = locked || Boolean(conflict || profileIssue);
  const choices = [...(state?.list.items || []), ...(subject && !state?.list.items.some(item => item.id === subject.id) ? [subject] : [])];
  const knownVersions = subject ? [...new Map([subject.headVersion, ...Object.values(versions?.known || {})].map(version => [version.id, version])).values()].sort((a, b) => b.number - a.number) : [];
  const pinned = reference?.subjectVersion;
  if (pinned && !knownVersions.some(version => version.id === pinned.id)) knownVersions.push(pinned);
  const change = patch => interaction.admit(() => { if (!locked) onChange(patch); });
  return <section className="subject-video-selection" data-testid="subject-video-selection" aria-label={t('subjects.video.sectionLabel')}>
    <Label className="subject-video-toggle" htmlFor="subject-video-enabled"><Switch id="subject-video-enabled" data-testid="subject-video-enabled" checked={active} disabled={locked || !active && Boolean(conflict || profileIssue)} onCheckedChange={checked => { if (active || !chooseLocked) change({ inputMode: checked ? 'subject' : 'text' }); }} /><span>{t('subjects.video.toggle')}</span></Label>
    <p className="subject-helper">{t('subjects.video.sessionNote')}</p>
    {(conflict || profileIssue || libraryIssue) && <p className="subject-warning" role="status" data-testid="subject-video-unavailable">{renderMessage(conflict || profileIssue || libraryIssue)}</p>}
    {provider?.id === 'ark' && <p className="subject-warning" data-testid="subject-video-face-warning">{renderMessage(ARK_SUBJECT_WARNING_MESSAGE)}</p>}
    {provider?.mock && <p className="subject-helper" data-testid="subject-video-mock-warning">{renderMessage(MOCK_SUBJECT_WARNING_MESSAGE)}</p>}
    {active && <div className="subject-form">
      <Label htmlFor="subject-video-subject">{t('subjects.binding.chooseLabel')}</Label>
      <WorkbenchSelect id="subject-video-subject" data-testid="subject-video-subject" value={subjectId} disabled={chooseLocked || state?.list.phase !== 'ready'} onChange={event => change({ subjectId: event.target.value, subjectReference: null })}><option value="">{t('subjects.video.choose')}</option>{choices.map(item => <option key={item.id} value={item.id} disabled={!SUBJECT_VIDEO_KINDS.includes(item.kind)}>{item.name} · {renderMessage(subjectKindDescriptor(item.kind))}{item.kind === 'look' ? t('subjects.video.planningOnlySuffix') : ''}</option>)}</WorkbenchSelect>
      <SubjectPager entry={state?.list} disabled={locked || state?.list.phase !== 'ready'} onPage={direction => interaction.admit(() => controller.subjectPage(direction, scope))} />
      {state?.list.phase === 'error' && <p className="subject-warning" role="alert">{renderMessage(state.list.error)}</p>}
      <Button variant="ghost" size="sm" disabled={locked || state?.list.phase === 'loading'} onClick={() => interaction.admit(() => controller.read())}>{t('subjects.video.refresh')}</Button>
      {subjectId && <><Label htmlFor="subject-video-version">{t('subjects.video.pinLabel')}</Label><WorkbenchSelect id="subject-video-version" data-testid="subject-video-version" value={reference?.subjectVersionId || ''} disabled={chooseLocked || !subject} onChange={event => { const chosen = knownVersions.find(version => version.id === event.target.value); change({ subjectReference: chosen ? subjectVideoChoice(subject, chosen) : null }); }}><option value="">{t('subjects.video.pinPlaceholder')}</option>{knownVersions.map(version => <option key={version.id} value={version.id}>V{version.number}{version.id === subject?.headVersionId ? t('subjects.video.currentSuffix') : t('subjects.video.historicalSuffix')}</option>)}</WorkbenchSelect>
        {versions?.phase === 'error' && <p className="subject-warning" role="alert">{renderMessage(versions.error)}</p>}
        <SubjectPager label={t('subjects.pager.versions')} entry={versions} disabled={locked || versions?.phase !== 'ready'} onPage={direction => interaction.admit(() => controller.versionPage(subjectId, direction, scope))} />
        <Button variant="ghost" size="sm" disabled={locked || versions?.phase === 'loading'} onClick={() => interaction.admit(() => controller.readVersions(subjectId, scope))}>{t('subjects.version.reload')}</Button>
      </>}
      <SubjectVideoSummary reference={reference} assets={assets} latestSubject={subject} />
      <p className="subject-helper">{t('subjects.video.constraints')}</p>
    </div>}
  </section>;
}
