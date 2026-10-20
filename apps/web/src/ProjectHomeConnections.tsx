import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import LanguageControl from './LanguageControl.tsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.tsx';
import { isSettingsConnectionPage } from './settings-window-state.ts';
import type { SettingsPage } from './settings-window-state.ts';
import { SettingsAbout, SettingsModelServices, SettingsShortcuts } from './SettingsExtraPages.tsx';

export type HomeConnectionSlot = 'agent' | 'official' | 'custom' | 'comfy';
const slots: readonly { id: HomeConnectionSlot; label: 'shell.agentLabel' | 'shell.openaiImage' | 'shell.compatibleImage' | 'shell.localComfy' }[] = [
  { id: 'agent', label: 'shell.agentLabel' }, { id: 'official', label: 'shell.openaiImage' },
  { id: 'custom', label: 'shell.compatibleImage' }, { id: 'comfy', label: 'shell.localComfy' },
];
const categories = ['general', 'workspace', 'video-tools', 'models', 'agent', 'extensions', 'shortcuts', 'about'] as const;
type Category = typeof categories[number];
const categoryIconNames: Partial<Record<Category, string>> = { general: 'settings', workspace: 'folder', 'video-tools': 'film', models: 'sparkle', about: 'info' };
const categoryIconPaths: Partial<Record<Category, ReactNode>> = {
  agent: <><rect x="5" y="7" width="14" height="13" rx="3" /><path d="M12 3v4M2 12h3m14 0h3M9 12v2m6-2v2m-6 3h6" /></>,
  extensions: <path d="M9 3H4v6a3 3 0 1 1 0 6v6h6a3 3 0 1 0 6 0h5v-6a3 3 0 1 1 0-6V3h-6a3 3 0 1 1-6 0Z" />,
  shortcuts: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8" /></>,
};
function SettingsCategoryIcon({ category }: { category: Category }) {
  const path = categoryIconPaths[category];
  return path ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg> : <Icon name={categoryIconNames[category] ?? 'info'} size={16} strokeWidth={1.5} />;
}
const categoryFor = (page: SettingsPage): Category => page === 'official' ? 'models' : page === 'custom' || page === 'comfy' ? 'extensions' : page;
const connectionCategory = (page: SettingsPage) => ['agent', 'models', 'extensions', 'official', 'custom', 'comfy'].includes(page);

/** Retained form owners keep their original identity and admission. Categories
 * are local presentation; native connection-slot messages remain unchanged. */
export default function ProjectHomeConnections({ selected, page = selected, onSelect, onPage, panes, general, connectionsAvailable = true, active = true, workspace, videoTools }: {
  selected: HomeConnectionSlot; page?: SettingsPage; onSelect: (slot: HomeConnectionSlot) => void; onPage?: (page: SettingsPage) => void;
  panes: Readonly<Record<HomeConnectionSlot, ReactNode>>; general?: ReactNode; connectionsAvailable?: boolean; active?: boolean;
  workspace?: ReactNode; videoTools?: ReactNode;
}) {
  const { t, formatNumber } = useI18n();
  const heading = useId(), opened = useRef(new Set<HomeConnectionSlot>());
  if (isSettingsConnectionPage(page)) opened.current.add(page);
  const category = categoryFor(page);
  const selectPage = (next: SettingsPage) => { if (connectionCategory(next) && !connectionsAvailable) return; if (onPage) onPage(next); else if (isSettingsConnectionPage(next)) onSelect(next); };
  const categoryLabel = (id: Category) => t(id === 'general' ? 'settings.general' : `redesign.settings.${id}`);
  const hints = { general: 'settings.generalHint', workspace: 'redesign.settings.workspaceHint', 'video-tools': 'redesign.settings.videoHint', models: 'redesign.settings.modelsHint', agent: 'redesign.settings.agentHint', extensions: 'redesign.settings.extensionsHint', shortcuts: 'redesign.settings.shortcutsHint', about: 'redesign.settings.aboutHint' } as const;
  const modelSlots = category === 'extensions' ? slots.filter(slot => slot.id === 'custom' || slot.id === 'comfy') : [];
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
      <section hidden={page !== 'models'} inert={page !== 'models'}><SettingsModelServices active={active && page === 'models' && connectionsAvailable} onOpenOfficial={()=>selectPage('official')} /></section>
      {page==='official'&&<Button className="settings-service-back" type="button" variant="ghost" onClick={()=>selectPage('models')}>{t('redesign.settings.models')}</Button>}
      <section hidden={page !== 'shortcuts'} inert={page !== 'shortcuts'}><SettingsShortcuts /></section>
      <section hidden={page !== 'about'} inert={page !== 'about'}><SettingsAbout active={active && page === 'about'} /></section>
      <nav hidden={!modelSlots.length} inert={!modelSlots.length} className="settings-service-nav" aria-label={t('shell.connectionType')}>
        {modelSlots.map(slot => <Button key={slot.id} type="button" variant="ghost" disabled={!connectionsAvailable} aria-current={page === slot.id ? 'page' : undefined} data-testid={`settings-service-${slot.id}`} onClick={() => selectPage(slot.id)}>{t(slot.label)}</Button>)}
      </nav>
      <div className="settings-connection-panes" hidden={!isSettingsConnectionPage(page)} inert={!isSettingsConnectionPage(page)}>
        <WorkspaceVisibilityProvider visible={active && isSettingsConnectionPage(page)}>
          {slots.filter(slot => opened.current.has(slot.id)).map(slot => <React.Fragment key={slot.id}>{panes[slot.id]}</React.Fragment>)}
        </WorkspaceVisibilityProvider>
      </div>
    </div>
  </section>;
}
