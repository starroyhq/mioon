import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@mioon/ui/components/dialog';
import ProjectHome from './ProjectHomeDirectoryScreen.tsx';
import type { ProjectEntryController } from './project-entry-state.ts';
import type { ProjectWindowSettingsSlot } from './desktop-window-client.ts';
import type {MenuHelpControl} from './desktop-menu-client.ts';
import {readProjectEntryIdentity} from './project-entry-identity.ts';
import type {NativeProjectDesktopController} from './native-project-desktop-state.ts';
import {NativeProjectEntryDialogs} from './NativeProjectEntryDialogs.tsx';
import {browserRpc} from './browser-rpc.ts';

/** A scoped workspace catalog and new-project form. It remains mounted when
 * hidden so its inputs and unknown request always retain their exact owner. */
export default function ProjectEntry({ controller, status, help, onSettings, editor = false, onRegisterMenuHelp, onMenuHelpStateChange }: {
  readonly controller: ProjectEntryController & {readonly desktop?: NativeProjectDesktopController | null}; readonly status?: ReactNode; readonly help?: ReactNode; readonly editor?: boolean;
  readonly onSettings: (slot: ProjectWindowSettingsSlot) => void;
  readonly onRegisterMenuHelp?: (control: MenuHelpControl) => () => void; readonly onMenuHelpStateChange?: () => void;
}) {
  const { t, renderMessage, formatDate, formatNumber } = useI18n();
  const state = controller.getState(), context = controller.getContext();
  const identity = controller.identity;
  const desktop = controller.desktop ?? null, native = desktop?.getState(), capability = native?.capabilities;
  const disabled = context.quitting ? t('projects.quittingCreate')
    : desktop && (!capability?.ready || !capability.create) ? t('projects.listUnavailable')
    : state.createUnknown ? t('projects.previousCreateUnknown')
      : state.openUnknown ? t('projects.checkOpenResult')
        : !state.catalogReady ? t('projects.listUnavailable') : '';
  const contents = <>
    {editor && <div className="project-entry-dialog-heading"><DialogTitle id="native-project-entry-heading">{state.mode === 'new' ? t('projects.createNew') : t('projects.openWorkspace')}</DialogTitle>
      <DialogDescription>{t('projects.separateWindow')}</DialogDescription>
      <Button type="button" variant="ghost" disabled={state.creating || state.sealed || state.createUnknown || state.openUnknown || Boolean(native?.busy || desktop?.readCloseSnapshot().unknown)} onClick={() => { void controller.dismiss(); }}>{t('projects.closeSelection')}</Button></div>}
    {state.openUnknown && <div className="project-home-notice" role="status"><p>{t('projects.checkOriginalOpen')}</p><Button type="button" variant="outline" onClick={() => { void controller.reconcileOpen(); }}>{t('projects.checkWindow')}</Button></div>}
    <ProjectHome parentGuardsDeparture catalogReady={() => controller.getState().catalogReady && !identity?.getState().identityBlocked}
      entryIdentity={identity ? () => {
        const owner = identity.getState();
        return !owner.identityBlocked && owner.appLibraryScope && owner.instanceId
          ? {appLibraryScope: owner.appLibraryScope, instanceId: owner.instanceId} : null;
      } : undefined}
      readDirectory={identity ? () => readProjectEntryIdentity(identity) : undefined}
      onRegisterMenuHelp={onRegisterMenuHelp} onMenuHelpStateChange={onMenuHelpStateChange} presentation={editor ? 'embedded' : 'page'} active={state.shown && !context.quitting} summaryScope={identity?.getVerifiedScope() ?? undefined} projects={state.projects} phase={state.phase} openingProjectId={state.openingProjectId} openingName={state.projects.find(project => project.id === state.openingProjectId)?.name}
      error={state.error} notice={state.notice} busy={state.creating || state.sealed || context.quitting || Boolean(native?.busy || native?.blocked || desktop?.readCloseSnapshot().unknown)} listBusy={state.listBusy} listError={state.listError}
      onRequestCreate={desktop ? () => {void controller.show('new');} : undefined}
      onOpenFile={capability?.ready && capability.open ? () => {void desktop?.openFile();} : undefined}
      onHelpAccess={capability?.ready && capability.help ? () => {void desktop?.openPrivacySettings();} : undefined}
      openedProjectIds={context.role === 'editor' && context.editorProjectId ? [context.editorProjectId] : []}
      onCopy={context.role === 'launcher' && capability?.ready && capability.duplicate ? id => {void desktop?.duplicate(id);} : undefined}
      onReveal={capability?.ready && capability.reveal ? id => {void desktop?.reveal(id);} : undefined}
      onNativeActionStateChange={controller.reportNativeAction}
      onPrepareNativeAction={controller.prepareHomeNativeDeparture}
      onPrepareNativeRecheck={controller.prepareHomeNativeRecheck}
      onOpenNativeResult={controller.openNativeResult}
      nativeActions={desktop && capability?.ready ? {trash: input => browserRpc('project.delete', input),
        ...(capability.templates?.length && desktop.bridge.instantiateTemplate ? {example: {bridge: desktop.bridge, templates: capability.templates}} : {})} : undefined}
      page="projects" onPage={page => { if (page === 'settings') onSettings('agent'); }} onOpen={id => controller.open(id)}
      onRetry={async () => { if (state.openUnknown) {await controller.reconcileOpen(); return !controller.getState().openUnknown;} return state.openingProjectId ? controller.open(state.openingProjectId) : false; }}
      onRefresh={async () => { controller.interacted(); const ready = await controller.refresh(); if (ready) await desktop?.initialize(editor); return ready; }} onCreate={controller.create} settings={null} status={status} help={help}
      createDisabledReason={disabled} onCreateStateChange={controller.reportCreate} canMutateEntry={controller.canMutate} createIntentVersion={desktop ? 0 : state.formIntent} />
    <NativeProjectEntryDialogs desktop={desktop} formIntent={state.formIntent} />
  </>;
  if (!editor) return contents;
  return <Dialog open={state.shown} onOpenChange={(open, details) => {
    if (open) return;
    // Escape/backdrop are requests, never permission to discard or unmount.
    // The controlled owner changes open only after its exact guard succeeds.
    details.cancel(); void controller.dismiss();
  }}>
    <DialogContent keepMounted showCloseButton={false} hidden={!state.shown} inert={!state.shown}
      className="modal project-entry-dialog" data-testid="project-entry-dialog" style={!state.shown ? { display: 'none' } : undefined}>{contents}</DialogContent>
  </Dialog>;
}
