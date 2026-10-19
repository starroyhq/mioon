import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
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
const categoryFor = (page: SettingsPage): Category => page === 'official' ? 'models' : page === 'custom' || page === 'comfy' ? 'extensions' : page;
const connectionCategory = (page: SettingsPage) => ['agent', 'models', 'extensions', 'official', 'custom', 'comfy'].includes(page);

/** Retained form owners keep their original identity and admission. Categories
 * are local presentation; native connection-slot messages remain unchanged. */
export default function ProjectHomeConnections({ selected, page = selected, onSelect, onPage, panes, general, connectionsAvailable = true, active = true, workspace, videoTools }: {
  selected: HomeConnectionSlot; page?: SettingsPage; onSelect: (slot: HomeConnectionSlot) => void; onPage?: (page: SettingsPage) => void;
  panes: Readonly<Record<HomeConnectionSlot, ReactNode>>; general?: ReactNode; connectionsAvailable?: boolean; active?: boolean;
  workspace?: ReactNode; videoTools?: ReactNode;
}) {
  const { t } = useI18n();
  const heading = useId(), opened = useRef(new Set<HomeConnectionSlot>());
  if (isSettingsConnectionPage(page)) opened.current.add(page);
  const category = categoryFor(page);
  const selectPage = (next: SettingsPage) => { if (connectionCategory(next) && !connectionsAvailable) return; if (onPage) onPage(next); else if (isSettingsConnectionPage(next)) onSelect(next); };
  const categoryLabel = (id: Category) => t(id === 'general' ? 'settings.general' : `redesign.settings.${id}`);
  const hints = { general: 'settings.generalHint', workspace: 'redesign.settings.workspaceHint', 'video-tools': 'redesign.settings.videoHint', models: 'redesign.settings.modelsHint', agent: 'redesign.settings.agentHint', extensions: 'redesign.settings.extensionsHint', shortcuts: 'redesign.settings.shortcutsHint', about: 'redesign.settings.aboutHint' } as const;
  const modelSlots = category === 'models' ? slots.filter(slot => slot.id === 'official') : category === 'extensions' ? slots.filter(slot => slot.id === 'custom' || slot.id === 'comfy') : [];
  return <section className="settings-center" data-testid="settings-center" data-page={page} aria-label={t('settings.title')}>
    <nav className="settings-center-nav" aria-label={t('settings.categories')}>
      <span className="settings-center-nav-label">{t('settings.title')}</span>
      {categories.map(id => <Button key={id} type="button" variant="ghost" data-testid={`settings-category-${id}`} disabled={connectionCategory(id) && !connectionsAvailable} aria-current={category === id ? 'page' : undefined} onClick={() => selectPage(id)}>{categoryLabel(id)}</Button>)}
      <p>{t('settings.scope')}</p>
    </nav>
    <div className="settings-center-content" aria-labelledby={heading}>
      <header className="settings-center-heading"><h1 id={heading}>{categoryLabel(category)}</h1><p>{t(hints[category])}</p></header>
      <section hidden={page !== 'general'} inert={page !== 'general'} className="settings-general" data-testid="settings-general">
        <div className="settings-preference"><div><h2>{t('language.label')}</h2><p>{t('settings.languageHint')}</p></div><LanguageControl /></div>{general}
      </section>
      <section hidden={page !== 'workspace'} inert={page !== 'workspace'}>{workspace}</section>
      <section hidden={page !== 'video-tools'} inert={page !== 'video-tools'}>{videoTools}</section>
      <section hidden={page !== 'models'} inert={page !== 'models'}><SettingsModelServices active={active && page === 'models' && connectionsAvailable} /></section>
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
