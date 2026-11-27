import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import LanguageControl from './LanguageControl.tsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { isSettingsConnectionPage, normalizeSettingsPage } from './settings-window-state.ts';
import type { SettingsConnectionPage, SettingsPage } from './settings-window-state.ts';
import { SettingsAbout, SettingsShortcuts } from './SettingsExtraPages.tsx';
import { settingsCategoryFor, visibleSettingsCategories } from './settings-categories.ts';
import type { SettingsCategory as Category } from './settings-categories.ts';

export type HomeConnectionSlot = SettingsConnectionPage;
const categoryIconNames: Partial<Record<Category, string>> = { general: 'settings', workspace: 'folder', 'video-tools': 'film', agent: 'sparkle', about: 'info' };
const categoryIconPaths: Partial<Record<Category, ReactNode>> = {
  models: <><rect width="16" height="16" x="4" y="4" rx="2" /><rect width="6" height="6" x="9" y="9" rx="1" /><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" /></>,
  'external-agents': <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  shortcuts: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8" /></>,
};
function SettingsCategoryIcon({ category }: { category: Category }) {
  const path = categoryIconPaths[category];
  return path ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg> : <Icon name={categoryIconNames[category] ?? 'info'} size={16} strokeWidth={1.5} />;
}
const connectionCategory = (page: SettingsPage) => ['agent', 'models', 'extensions', 'official', 'custom', 'comfy'].includes(page);

/** Retained form owners keep their original identity and admission. Fixed
 * native page intentions never grant a category its own connection identity. */
export default function ProjectHomeConnections({ selected, page: requestedPage = selected, onSelect, onPage, panes, general, connectionsAvailable = true, active = true, workspace, videoTools, generationServices, externalAgents, externalAgentsAvailable = Boolean(externalAgents) }: {
  selected: HomeConnectionSlot; page?: SettingsPage; onSelect: (slot: HomeConnectionSlot) => void; onPage?: (page: SettingsPage) => void;
  panes: Readonly<Partial<Record<HomeConnectionSlot, ReactNode>>>; general?: ReactNode; connectionsAvailable?: boolean; active?: boolean;
  workspace?: ReactNode; videoTools?: ReactNode; generationServices?: ReactNode; externalAgents?: ReactNode; externalAgentsAvailable?: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const normalizedPage = normalizeSettingsPage(requestedPage);
  const page: SettingsPage = normalizedPage === 'external-agents' && !externalAgentsAvailable ? 'general' : normalizedPage;
  const heading = useId(), opened = useRef({ agent: false, generation: false });
  const category = settingsCategoryFor(page);
  const categories = visibleSettingsCategories(externalAgentsAvailable);
  if (connectionsAvailable && page === 'agent') opened.current.agent = true;
  if (connectionsAvailable && category === 'models') opened.current.generation = true;
  const selectPage = (next: SettingsPage) => { next = normalizeSettingsPage(next); if (next === 'external-agents' && !externalAgentsAvailable) return; if (connectionCategory(next) && !connectionsAvailable) return; if (onPage) onPage(next); else if (isSettingsConnectionPage(next)) onSelect(next); };
  const categoryLabel = (id: Category) => t(id === 'general' ? 'settings.general' : `redesign.settings.${id}`);
  return <section className="settings-center" data-testid="settings-center" data-page={page} aria-label={t('settings.title')}>
    <nav className="settings-center-nav" aria-label={t('settings.categories')}>
      <span className="settings-center-nav-label">{t('settings.title')}</span>
      {categories.map(id => <Button key={id} type="button" variant="ghost" data-testid={`settings-category-${id}`} disabled={connectionCategory(id) && !connectionsAvailable} aria-current={category === id ? 'page' : undefined} onClick={() => selectPage(id)}><span className="settings-category-icon" data-testid={`settings-category-icon-${id}`}><SettingsCategoryIcon category={id} /></span><span>{categoryLabel(id)}</span></Button>)}
    </nav>
    <div className="settings-center-content" aria-labelledby={heading}>
      <header className="settings-center-heading">
        <h1 id={heading}>{categoryLabel(category)}</h1>
        {category === 'external-agents' && <p className="settings-center-subtitle" data-testid="settings-external-agents-subtitle">{t('externalAgents.subtitle')}</p>}
      </header>
      <section hidden={page !== 'general'} inert={page !== 'general'} className="settings-general" data-testid="settings-general">
        <h2 className="settings-section-title">{t('redesign.settings.languageSection')}</h2>
        <div className="settings-preference"><h3>{t('language.label')}</h3><LanguageControl visible={active && page === 'general'} /></div>
        <div className="settings-preference settings-number-format" data-testid="settings-number-format"><h3 id={`${heading}-number-format`}>{t('redesign.settings.numberFormat')}</h3><output aria-labelledby={`${heading}-number-format`} data-testid="settings-number-format-example">{formatNumber(12345.6)}</output></div>{general}
      </section>
      <section hidden={page !== 'workspace'} inert={page !== 'workspace'}>
        <WorkspaceVisibilityProvider visible={active && page === 'workspace'}>{workspace}</WorkspaceVisibilityProvider>
      </section>
      <section hidden={page !== 'video-tools'} inert={page !== 'video-tools'}>{videoTools}</section>
      {externalAgentsAvailable && <section hidden={page !== 'external-agents'} inert={page !== 'external-agents'} data-testid="settings-external-agents">
        <WorkspaceVisibilityProvider visible={active && page === 'external-agents'}>{externalAgents}</WorkspaceVisibilityProvider>
      </section>}
      <section hidden={page !== 'shortcuts'} inert={page !== 'shortcuts'}><SettingsShortcuts /></section>
      <section hidden={page !== 'about'} inert={page !== 'about'}><SettingsAbout active={active && page === 'about'} /></section>
      <div className="settings-connection-panes" hidden={!connectionCategory(page)} inert={!connectionCategory(page)}>
        <WorkspaceVisibilityProvider visible={active && connectionsAvailable && category === 'models'}>
          {opened.current.generation && generationServices}
        </WorkspaceVisibilityProvider>
        <WorkspaceVisibilityProvider visible={active && connectionsAvailable && page === 'agent'}>
          {opened.current.agent && panes.agent}
        </WorkspaceVisibilityProvider>
      </div>
    </div>
  </section>;
}
