import { useI18n } from './i18n/I18nProvider.tsx';
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
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  return <section className="delivery-workspace" data-testid="delivery-workspace" data-page={page} aria-labelledby="delivery-workspace-heading">
    <header className="delivery-workspace-heading">
      <h2 id="delivery-workspace-heading">{page === 'history' ? t('export.workspace.history') : t('export.workspace.delivery')}</h2>
      <p>{page === 'history'
        ? t('export.workspace.historyHelp')
        : t('export.workspace.composeHelp')}</p>
    </header>
    <Tabs className="delivery-workspace-tabs" value={page} onValueChange={value => { if (value === 'compose' || value === 'history') onPage(value); }}>
      <TabsList className="delivery-workspace-tablist" aria-label={t('export.workspace.pages')}>
        <TabsTrigger id="delivery-compose-tab" value="compose" aria-controls="delivery-compose-pane" data-testid="delivery-page-compose">{t('export.workspace.compose')}</TabsTrigger>
        <TabsTrigger id="delivery-history-tab" value="history" aria-controls="delivery-history-pane" data-testid="delivery-page-history"><span data-testid="export-history">{t('export.workspace.history')}</span></TabsTrigger>
      </TabsList>
      <div className="delivery-workspace-content" data-testid="delivery-workspace-content">{children}</div>
    </Tabs>
  </section>;
}
