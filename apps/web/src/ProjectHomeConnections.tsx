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

export type HomeConnectionSlot = SettingsConnectionPage;
const categories = ['general', 'workspace', 'video-tools', 'models', 'agent', 'shortcuts', 'about'] as const;
type Category = typeof categories[number];
const categoryIconNames: Partial<Record<Category, string>> = { general: 'settings', workspace: 'folder', 'video-tools': 'film', models: 'sparkle', about: 'info' };
const categoryIconPaths: Partial<Record<Category, ReactNode>> = {
  agent: <><rect x="5" y="7" width="14" height="13" rx="3" /><path d="M12 3v4M2 12h3m14 0h3M9 12v2m6-2v2m-6 3h6" /></>,
  shortcuts: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8" /></>,
};
function SettingsCategoryIcon({ category }: { category: Category }) {
  const path = categoryIconPaths[category];
  return path ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg> : <Icon name={categoryIconNames[category] ?? 'info'} size={16} strokeWidth={1.5} />;
}
const categoryFor = (page: SettingsPage): Category => page === 'official' || page === 'custom' || page === 'comfy' || page === 'extensions' ? 'models' : page;
const connectionCategory = (page: SettingsPage) => ['agent', 'models', 'extensions', 'official', 'custom', 'comfy'].includes(page);

/** Retained form owners keep their original identity and admission. Fixed
 * native page intentions never grant a category its own connection identity. */
export default function ProjectHomeConnections({ selected, page: requestedPage = selected, onSelect, onPage, panes, general, connectionsAvailable = true, active = true, workspace, videoTools, generationServices }: {
  selected: HomeConnectionSlot; page?: SettingsPage; onSelect: (slot: HomeConnectionSlot) => void; onPage?: (page: SettingsPage) => void;
  panes: Readonly<Partial<Record<HomeConnectionSlot, ReactNode>>>; general?: ReactNode; connectionsAvailable?: boolean; active?: boolean;
  workspace?: ReactNode; videoTools?: ReactNode; generationServices?: ReactNode;
}) {
  const { t, formatNumber } = useI18n();
  const page = normalizeSettingsPage(requestedPage);
  const heading = useId(), opened = useRef({ agent: false, generation: false });
  const category = categoryFor(page);
  if (connectionsAvailable && page === 'agent') opened.current.agent = true;
  if (connectionsAvailable && category === 'models') opened.current.generation = true;
  const selectPage = (next: SettingsPage) => { next = normalizeSettingsPage(next); if (connectionCategory(next) && !connectionsAvailable) return; if (onPage) onPage(next); else if (isSettingsConnectionPage(next)) onSelect(next); };
  const categoryLabel = (id: Category) => t(id === 'general' ? 'settings.general' : `redesign.settings.${id}`);
  const hints = { general: 'settings.generalHint', workspace: 'redesign.settings.workspaceHint', 'video-tools': 'redesign.settings.videoHint', models: 'redesign.settings.modelsHint', agent: 'redesign.settings.agentHint', shortcuts: 'redesign.settings.shortcutsHint', about: 'redesign.settings.aboutHint' } as const;
  return <section className="settings-center" data-testid="settings-center" data-page={page} aria-label={t('settings.title')}>
    <nav className="settings-center-nav" aria-label={t('settings.categories')}>
      <span className="settings-center-nav-label">{t('settings.title')}</span>
      {categories.map(id => <Button key={id} type="button" variant="ghost" data-testid={`settings-category-${id}`} disabled={connectionCategory(id) && !connectionsAvailable} aria-current={category === id ? 'page' : undefined} onClick={() => selectPage(id)}><span className="settings-category-icon" data-testid={`settings-category-icon-${id}`}><SettingsCategoryIcon category={id} /></span><span>{categoryLabel(id)}</span></Button>)}
      <p className="settings-local-status"><Icon name="lock" size={12} />{t('redesign.settings.localPreferences')}</p>
    </nav>
    <div className="settings-center-content" aria-labelledby={heading}>
      <header className="settings-center-heading"><h1 id={heading}>{categoryLabel(category)}</h1><p>{t(hints[category])}</p></header>
      <section hidden={page !== 'general'} inert={page !== 'general'} className="settings-general" data-testid="settings-general">
        <h2 className="settings-section-title">{t('redesign.settings.languageSection')}</h2>
        <div className="settings-preference"><div><h3>{t('language.label')}</h3><p>{t('settings.languageHint')}</p></div><LanguageControl visible={active && page === 'general'} /></div>
        <div className="settings-preference settings-number-format" data-testid="settings-number-format"><div><h3 id={`${heading}-number-format`}>{t('redesign.settings.numberFormat')}</h3><p>{t('redesign.settings.followLanguage')}</p></div><output aria-labelledby={`${heading}-number-format`} data-testid="settings-number-format-example">{formatNumber(12345.6)}</output></div>{general}
      </section>
      <section hidden={page !== 'workspace'} inert={page !== 'workspace'}>{workspace}</section>
      <section hidden={page !== 'video-tools'} inert={page !== 'video-tools'}>{videoTools}</section>
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
