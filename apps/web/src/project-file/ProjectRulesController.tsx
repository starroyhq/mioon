import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {WorkbenchAlert, WorkbenchButton} from '@mioon/ui/components/workbench-controls';
import {PROJECT_RULES_FILE} from '../../../../packages/contracts/src/project-file.ts';
import {createProjectRulesState} from '../project-rules-state.ts';
import {useI18n} from '../i18n/I18nProvider.tsx';
import {folderOf} from './format.ts';
import {ProjectRulesDialog} from './ProjectRules.tsx';

export interface ProjectRulesControllerProps { readonly open: boolean; readonly projectId: string; readonly projectFile?: string | null; readonly onClose: () => void }
export function projectRulesDisplayPath(projectFile?: string | null): string {
  if (!projectFile || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(projectFile)) || !projectFile.endsWith('.mioon')) return PROJECT_RULES_FILE;
  const directory = folderOf(projectFile), separator = projectFile.includes('\\') && !projectFile.includes('/') ? '\\' : '/';
  return `${directory}${directory.endsWith(separator) ? '' : separator}${PROJECT_RULES_FILE}`;
}
function OpenProjectRules({projectId, projectFile, onClose}: Omit<ProjectRulesControllerProps, 'open'>) {
  const {t} = useI18n();
  const [controller] = useState(() => createProjectRulesState({projectId}));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), snapshot = state.snapshot;
  useEffect(() => { controller.connect(); void controller.load(); return () => controller.dispose(); }, [controller]);
  const working = state.mutation === 'working', unknown = state.pending !== null, unavailable = snapshot?.trust === 'unavailable' || snapshot?.readError !== null && snapshot?.readError !== undefined;
  const submittingWrite = working && (state.action === 'save' || state.action === 'enable');
  const blocked = working || unknown || snapshot?.pendingWrites === true || unavailable || state.receiptBlocked;
  const notice = state.receiptBlocked ? <WorkbenchAlert tone="danger">{t('projectRules.runtime.receiptError')}</WorkbenchAlert>
    : unknown && !submittingWrite ? <WorkbenchAlert tone="warning" data-testid="pf-rules-unknown" actions={<>
      <WorkbenchButton size="compact" data-testid="pf-rules-lookup" disabled={working} loading={working && state.action === 'lookup'} onClick={() => {void controller.lookup();}}>{t('projectRules.runtime.check')}</WorkbenchButton>
      {state.lookup?.status === 'uncertain' && <WorkbenchButton size="compact" data-testid="pf-rules-reconcile" disabled={working} loading={working && state.action === 'reconcile'} onClick={() => {void controller.reconcile();}}>{t('projectRules.runtime.reconcile')}</WorkbenchButton>}
    </>}>{t('projectRules.runtime.unknown')}</WorkbenchAlert>
    : snapshot?.pendingWrites ? <WorkbenchAlert tone="warning" actions={<WorkbenchButton size="compact" onClick={() => {void controller.load();}}>{t('projectRules.runtime.refresh')}</WorkbenchButton>}>{t('projectRules.runtime.pending')}</WorkbenchAlert>
    : unavailable ? <WorkbenchAlert tone="warning">{t('projectRules.runtime.unavailable')}</WorkbenchAlert>
    : state.lookup?.status === 'not_applied' ? <WorkbenchAlert tone="neutral">{t('projectRules.runtime.notApplied')}</WorkbenchAlert> : null;
  return <ProjectRulesDialog open state={state.phase === 'loading' ? {kind: 'loading'} : state.phase === 'error' ? {kind: 'error', retryable: true} : {kind: 'ready', value: {text: snapshot?.text ?? '', exists: snapshot?.exists ?? false}}}
    draft={state.draft} onDraftChange={controller.setDraft} maxBytes={snapshot?.maxBytes ?? 8192} trust={unknown ? 'pending' : snapshot?.trust ?? 'unavailable'} path={projectRulesDisplayPath(projectFile)}
    save={working ? {kind: 'working', action: state.action === 'enable' ? 'enable' : 'save'} : state.mutation === 'error' && !state.receiptBlocked ? {kind: 'error', action: state.action === 'enable' ? 'enable' : 'save'} : {kind: 'idle'}}
    blocked={blocked} notice={notice} conflict={state.mutation === 'conflict'} onSave={() => {void controller.save();}} onEnable={() => {void controller.enable();}}
    onLoadLatest={() => {void controller.loadLatest();}} onRetry={() => {void controller.load();}} onClose={onClose} />;
}
export function ProjectRulesController({open, ...props}: ProjectRulesControllerProps) { return open ? <OpenProjectRules key={props.projectId} {...props} /> : null; }
