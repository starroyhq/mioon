import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog';
import ProjectHome from './ProjectHome.tsx';
import type { ProjectEntryController } from './project-entry-state.ts';
import type { ProjectWindowSettingsSlot } from './desktop-window-client.ts';

/** A scoped workspace catalog and new-project form. It remains mounted when
 * hidden so its inputs and unknown request always retain their exact owner. */
export default function ProjectEntry({ controller, status, onSettings, editor = false }: {
  readonly controller: ProjectEntryController; readonly status?: ReactNode; readonly editor?: boolean;
  readonly onSettings: (slot: ProjectWindowSettingsSlot) => void;
}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const state = controller.getState(), context = controller.getContext();
  const disabled = context.quitting ? t('projects.quittingCreate')
    : state.createUnknown ? t('projects.previousCreateUnknown')
      : state.openUnknown ? t('projects.checkOpenResult')
        : !state.workspace ? t('projects.workspaceNotChecked')
          : state.workspace.restored ? t('projects.restoredCreateUnavailable') : '';
  const contents = <>
    {editor && <div className="project-entry-dialog-heading"><DialogTitle id="native-project-entry-heading">{state.mode === 'new' ? t('projects.createNew') : t('projects.openWorkspace')}</DialogTitle>
      <DialogDescription>{t('projects.separateWindow')}</DialogDescription>
      <Button type="button" variant="ghost" disabled={state.creating || state.sealed || state.createUnknown || state.openUnknown} onClick={() => { void controller.dismiss(); }}>{t('projects.closeSelection')}</Button></div>}
    {state.openUnknown && <div className="project-home-notice" role="status"><p>{t('projects.checkOriginalOpen')}</p><Button type="button" variant="outline" onClick={() => { void controller.reconcileOpen(); }}>{t('projects.checkWindow')}</Button></div>}
    <ProjectHome projects={state.projects} phase={state.phase} openingName={state.projects.find(project => project.id === state.openingProjectId)?.name}
      error={state.error} notice={state.notice} busy={state.creating || state.sealed || context.quitting} listBusy={state.listBusy} listError={state.listError}
      page="projects" onPage={page => { if (page === 'settings') onSettings('agent'); }} onOpen={id => { void controller.open(id); }}
      onRetry={() => { if (state.openUnknown) void controller.reconcileOpen(); else if (state.openingProjectId) void controller.open(state.openingProjectId); }}
      onRefresh={() => { controller.interacted(); void controller.refresh(); }} onCreate={controller.create} settings={null} status={status}
      createDisabledReason={disabled} onCreateStateChange={controller.reportCreate} canMutateEntry={controller.canMutate} createIntentVersion={state.formIntent} />
  </>;
  if (!editor) return contents;
  return <Dialog open={state.shown} onOpenChange={(open, details) => {
    if (open) return;
    // Escape/backdrop are requests, never permission to discard or unmount.
    // The controlled owner changes open only after its exact guard succeeds.
    details.cancel(); void controller.dismiss();
  }}>
    <DialogContent keepMounted showCloseButton={false} hidden={!state.shown} inert={!state.shown}
      className="modal project-entry-dialog" style={{ width: 'min(980px, 94vw)', maxWidth: 'min(980px, 94vw)', maxHeight: '90vh', overflow: 'auto', ...(!state.shown ? { display: 'none' } : {}) }}>{contents}</DialogContent>
  </Dialog>;
}
