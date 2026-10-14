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
  const state = controller.getState(), context = controller.getContext();
  const disabled = context.quitting ? '应用正在退出，暂不能新建项目。'
    : state.createUnknown ? '上次新建结果未确认。请保留此窗口并刷新列表核对，不要重复创建。'
      : state.openUnknown ? '请先核对当前打开窗口的结果。'
        : !state.workspace ? '工作区身份尚未核对，暂不能新建项目。'
          : state.workspace.restored ? '恢复分支暂不支持新建项目。' : '';
  const contents = <>
    {editor && <div className="project-entry-dialog-heading"><DialogTitle id="native-project-entry-heading">{state.mode === 'new' ? '新建项目' : '打开工作区项目'}</DialogTitle>
      <DialogDescription>从当前工作区选择项目，将在独立编辑窗口打开；此窗口的项目与输入会保留。</DialogDescription>
      <Button type="button" variant="ghost" disabled={state.creating || state.sealed || state.createUnknown || state.openUnknown} onClick={() => { void controller.dismiss(); }}>关闭项目选择</Button></div>}
    {state.openUnknown && <div className="project-home-notice" role="status"><p>只核对原打开请求，不会重新创建项目。</p><Button type="button" variant="outline" onClick={() => { void controller.reconcileOpen(); }}>核对窗口状态</Button></div>}
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
