import React, {useEffect, useRef, useState} from 'react';
import type {NativeProjectDesktopController} from './native-project-desktop-state.ts';
import {projectLocationRisks} from './native-project-desktop-state.ts';
import {NewProjectFileDialog} from './project-file/NewProjectFileDialog.tsx';
import {ProjectOpenFailureDialog} from './project-file/ProjectOpenFailureDialog.tsx';
import {ProjectLocationRiskBanner} from './project-file/ProjectLocationRisk.tsx';

function useDesktop(desktop: NativeProjectDesktopController | null) {
  const [, update] = useState(0);
  useEffect(() => desktop?.subscribe(() => update(value => value + 1)), [desktop]);
  return desktop?.getState() ?? null;
}
export function NativeProjectLocationRisk({desktop}: {readonly desktop: NativeProjectDesktopController | null}) {
  const state = useDesktop(desktop);
  return state && desktop ? <ProjectLocationRiskBanner risks={state.risks} onDismiss={desktop.dismissRisk} /> : null;
}
export function NativeProjectEntryDialogs({desktop, formIntent = 0}: {readonly desktop: NativeProjectDesktopController | null; readonly formIntent?: number}) {
  const state = useDesktop(desktop);
  const handledFormIntent = useRef(0);
  useEffect(() => {
    if (desktop && formIntent > handledFormIntent.current && desktop.showCreate()) handledFormIntent.current = formIntent;
  }, [desktop, formIntent, state?.capabilities?.ready, state?.capabilities?.create]);
  if (!state || !desktop) return null;
  const capabilities = state.capabilities, enabled = Boolean(capabilities?.ready) && !state.blocked;
  const failure = state.failure;
  return <>
    <NewProjectFileDialog interactionBlocked={state.blocked} open={state.createOpen} values={state.values} onChange={desktop.change} state={state.createState}
      location={{display: state.selection?.displayPath ?? '', status: state.selection ? 'ready' : 'unselected', risks: state.selection ? projectLocationRisks(state.selection.facts) : []}}
      onChooseLocation={enabled && capabilities?.create ? () => {void desktop.chooseLocation();} : undefined}
      onSubmit={() => {void desktop.create();}} onClose={desktop.closeCreate}
      onRecheck={() => {void desktop.recheck();}} onRetryOpen={() => {void desktop.retryOpen();}} />
    {failure && <ProjectOpenFailureDialog interactionBlocked={state.blocked} open failure={failure.issue} projectName={failure.name} platform="mac" action={state.action}
      onClose={desktop.closeFailure}
      onOpenSystemSettings={enabled && capabilities?.help ? () => {void desktop.openPrivacySettings();} : undefined}
      onChooseLocation={failure.issue.code === 'PROJECT_ACCESS_DENIED' && 'context' in failure.issue && failure.issue.context === 'create' && enabled && capabilities?.create ? () => {void desktop.chooseLocation();} : undefined}
      onRetry={enabled ? () => {void desktop.retryFailure();} : undefined}
      onReveal={enabled && capabilities?.reveal && (failure.token || failure.projectId) ? () => {void desktop.reveal(failure.projectId);} : undefined}
      onOpenOriginal={enabled && capabilities?.openOriginal && failure.token && failure.issue.code === 'PROJECT_FILE_COPY' && failure.issue.originalProjectFile ? () => {void desktop.openOriginal();} : undefined}
      onAdoptCopy={enabled && capabilities?.adoptCopy && failure.token && failure.issue.code === 'PROJECT_FILE_COPY' ? () => {void desktop.adoptCopy();} : undefined}
      onCopyTo={enabled && capabilities?.copyTo && failure.token && (failure.issue.code === 'NETWORK_LOCATION' || failure.issue.code === 'PROJECT_INVALID' && failure.issue.reason === 'read-only') ? () => {void desktop.copyTo();} : undefined}
      onRecheck={() => {void desktop.recheck();}} />}
  </>;
}
