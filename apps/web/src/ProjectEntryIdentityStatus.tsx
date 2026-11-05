import React from 'react';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {ProjectEntryIdentityOwner, ProjectEntryIdentityState} from './project-entry-identity.ts';

/** Reading a directory has no pending write or persisted-selection status. */
export default function ProjectEntryIdentityStatus({owner, state = owner.getState()}: {
  readonly owner: ProjectEntryIdentityOwner; readonly state?: ProjectEntryIdentityState;
}) {
  const {t} = useI18n();
  return <section data-testid="project-entry-identity-status" data-phase={state.phase} aria-label={t('projectFile.home.title')}>
    <span role="status" aria-live="polite">{t(state.phase === 'loading' ? 'projectFile.home.loading' : state.phase === 'error' || state.phase === 'blocked' ? 'projectFile.home.error' : 'projectFile.home.title')}</span>
    {state.identityBlocked && <p role="alert">{t('projects.locatorKeepWindow')}</p>}
    {state.phase === 'error' && !state.identityBlocked && <Button type="button" variant="ghost" size="sm" data-testid="project-entry-identity-retry" onClick={() => {void owner.refresh();}}>{t('projectFile.common.retry')}</Button>}
  </section>;
}
