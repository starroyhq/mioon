import React from 'react';
import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@mioon/ui/components/tabs';

export type DeliveryWorkspacePage = 'compose' | 'history';
export interface DeliveryWorkspaceProps {
  page: DeliveryWorkspacePage;
  onPage: (page: DeliveryWorkspacePage) => void;
  children: ReactNode;
}

/** Presentation only. App supplies its existing keep-mounted AgentDockPane
 * children and owns page visibility, project fences, drafts and requests. */
export default function DeliveryWorkspace({ page, onPage, children }: DeliveryWorkspaceProps) {
  return <section className="delivery-workspace" data-testid="delivery-workspace" data-page={page} aria-labelledby="delivery-workspace-heading">
    <header className="delivery-workspace-heading">
      <h2 id="delivery-workspace-heading">{page === 'history' ? '导出记录' : '成片交付'}</h2>
      <p>{page === 'history'
        ? '每个文件使用创建时的固定快照。已命名成片保留原名称，后续修改不会覆盖旧文件。'
        : '填写本次名称、检查已保存的时间线，再确认导出。切换到记录不会清除草稿。'}</p>
    </header>
    <Tabs className="delivery-workspace-tabs" value={page} onValueChange={value => { if (value === 'compose' || value === 'history') onPage(value); }}>
      <TabsList className="delivery-workspace-tablist" aria-label="成片交付页面">
        <TabsTrigger id="delivery-compose-tab" value="compose" aria-controls="delivery-compose-pane" data-testid="delivery-page-compose">本次导出</TabsTrigger>
        <TabsTrigger id="delivery-history-tab" value="history" aria-controls="delivery-history-pane" data-testid="delivery-page-history">导出记录</TabsTrigger>
      </TabsList>
      <div className="delivery-workspace-content" data-testid="delivery-workspace-content">{children}</div>
    </Tabs>
  </section>;
}
