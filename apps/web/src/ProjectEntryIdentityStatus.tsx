import React from 'react';
import {Button} from '@mioon/ui/components/button';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {SettingsWorkspaceIdentityOwner} from './project-entry-identity.ts';

export default function ProjectEntryIdentityStatus({owner, state = owner.getState(), workspace = false}: {
  readonly owner: Pick<SettingsWorkspaceIdentityOwner, 'getState' | 'refresh'>;
  readonly state?: ReturnType<SettingsWorkspaceIdentityOwner['getState']>;
  readonly workspace?: boolean;
}) {
  const {t} = useI18n();
  const labels = workspace
    ? {pending: 'shell.checkingWorkspace', failed: 'shell.workspaceUnconfirmed', ready: 'shell.workspaceVerified'} as const
    : {pending: 'projectFile.home.loading', failed: 'projectFile.home.error', ready: 'projectFile.home.title'} as const;
  const label = state.phase === 'error' || state.phase === 'blocked' ? labels.failed
    : state.phase === 'loading' || workspace && state.phase === 'idle' ? labels.pending : labels.ready;
  return <section data-testid="project-entry-identity-status" data-phase={state.phase} aria-label={t(workspace ? 'settings.workspaceStatus' : 'projectFile.home.title')}>
    <span role="status" aria-live="polite">{t(label)}</span>
    {state.identityBlocked && <p role="alert">{t('projects.locatorKeepWindow')}</p>}
    {state.phase === 'error' && !state.identityBlocked && <Button type="button" variant="ghost" size="sm" data-testid="project-entry-identity-retry" onClick={() => {void owner.refresh();}}>{t('projectFile.common.retry')}</Button>}
  </section>;
}
