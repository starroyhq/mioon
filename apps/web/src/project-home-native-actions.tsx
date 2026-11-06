import React from 'react';
import type {ReactElement} from 'react';
import {Dialog} from '@mioon/ui/components/dialog';
import {WorkbenchAlert, WorkbenchButton, WorkbenchDialogContent} from '@mioon/ui/components/workbench-controls';
import {useI18n} from './i18n/I18nProvider.tsx';
import type {ProjectHomeNativeActionState} from './project-home-native-actions-state.ts';
import './project-file/project-file-common.css';
import './project-file/project-file-home.css';
import './project-home-native-actions.css';

export interface ProjectHomeNativeActionsViewProps {
  readonly state: ProjectHomeNativeActionState;
  readonly onClose: () => void;
  readonly onConfirmTrash: () => void;
  readonly onRecheck: () => void;
  readonly onRefresh?: () => void;
  readonly onRetryOpen: () => void;
  readonly onDismissNotice: () => void;
  readonly onOpenProject?: (projectId: string) => void;
  readonly onHelpAccess?: () => void;
  /** Actual host windows only; availability.open can also be background work. */
  readonly openedProjectIds?: readonly string[];
}

/** 12-22/22b use only the service's safe reason code or explicit host windows.
 * Neither a missing file nor zero indexed tasks establishes a trash receipt. */
export function ProjectHomeNativeActionsView(props: ProjectHomeNativeActionsViewProps): ReactElement {
  const {t}=useI18n(),state=props.state,project=state.project;
  const name=project?.name??state.exampleName??t('projects.project');
  const unknown=state.kind==='trash-unknown'||state.kind==='example-unknown';
  const working=['checking','working-trash','choosing-example','working-example','opening-example'].includes(state.kind);
  const example=state.kind.includes('example')||state.exampleName!==null;
  const open=state.kind!=='idle'&&!state.dialogHidden;
  const lockedUnknown=state.kind==='trash-unknown';
  const title=example?t(state.kind==='example-blocked'?'projectHomeNative.example.blockedTitle':'projectHomeNative.example'):state.kind==='trash-blocked'?t('projectHomeNative.trash.blockedTitle',{name}):t('projectHomeNative.trash.title',{name});
  const actualWindow=project!==null&&props.openedProjectIds?.includes(project.projectId)===true;
  const body=unknown?t(example?'projectHomeNative.example.unknown':'projectHomeNative.trash.unknown')
    :state.kind==='example-created'?t('projectHomeNative.example.created')
      :state.kind==='example-blocked'?t(state.reason==='selection'?'projectHomeNative.example.selectAgain':'projectHomeNative.example.unavailable')
        :state.kind==='trash-blocked'?t(state.reason==='facts'?'projectHomeNative.trash.factsUnavailable':state.reason==='denied'?'projectHomeNative.trash.denied':state.reason==='busy'?(actualWindow?'projectHomeNative.trash.open':'projectHomeNative.trash.busy'):'projectHomeNative.trash.unavailable')
        :example?t('projectHomeNative.example.working')
          :<span className="pf-open-copy">{project&&<span className="pf-open-path" data-testid="project-home-trash-path">{project.projectFile}</span>}<span>{t('projectHomeNative.trash.fileOnly')}</span><span>{t('projectHomeNative.trash.records')}</span></span>;
  return <>
    {state.notice&&<WorkbenchAlert tone={state.notice.kind==='success'?'success':'neutral'} className="project-home-native-notice" data-testid="project-home-native-notice" actions={<WorkbenchButton size="compact" onClick={props.onDismissNotice}>{t('common.close')}</WorkbenchButton>}>
      {t(state.notice.kind==='success'?'projectHomeNative.trash.success':'projectHomeNative.trash.changed',{name:state.notice.name})}
    </WorkbenchAlert>}
    <Dialog open={open} onOpenChange={next=>{if(!next&&!working&&!lockedUnknown)props.onClose();}}>
      <WorkbenchDialogContent title={title} description={body} size="confirm" showCloseButton={false} className="pf-dialog pf-open-dialog" data-testid="project-home-native-dialog" data-state={state.kind}
        footer={<>
          {state.kind==='trash-blocked'&&state.reason==='denied'&&props.onHelpAccess&&<WorkbenchButton variant="ghost" data-testid="project-home-trash-help" onClick={props.onHelpAccess}>{t('projectFile.open.access.settings')}</WorkbenchButton>}
          {state.kind==='trash-blocked'&&state.reason==='busy'&&project&&props.onOpenProject&&<WorkbenchButton variant="ghost" data-testid="project-home-trash-open" onClick={()=>props.onOpenProject?.(project.projectId)}>{t('projectFile.home.menu.open')}</WorkbenchButton>}
          <WorkbenchButton disabled={working||lockedUnknown} data-testid="project-home-native-close" onClick={props.onClose}>{t(state.kind==='confirm-trash'?'common.cancel':'common.close')}</WorkbenchButton>
          {(state.kind==='confirm-trash'||state.kind==='working-trash')&&<WorkbenchButton variant="danger" disabled={working} loading={state.kind==='working-trash'} data-testid="project-home-trash-confirm" onClick={props.onConfirmTrash}>{t(state.kind==='working-trash'?'projectHomeNative.trash.working':'projectHomeNative.trash.confirm')}</WorkbenchButton>}
          {state.kind==='trash-unknown'&&<WorkbenchButton variant="primary" data-testid="project-home-native-recheck" onClick={props.onRecheck}>{t('projectHomeNative.trash.recheck')}</WorkbenchButton>}
          {state.kind==='example-unknown'&&props.onRefresh&&<WorkbenchButton variant="primary" data-testid="project-home-example-refresh" onClick={props.onRefresh}>{t('projectHomeNative.example.refresh')}</WorkbenchButton>}
          {state.kind==='example-created'&&<WorkbenchButton variant="primary" data-testid="project-home-example-open" onClick={props.onRetryOpen}>{t('projectFile.home.menu.open')}</WorkbenchButton>}
        </>} />
    </Dialog>
  </>;
}
