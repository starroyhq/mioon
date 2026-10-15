import { useI18n } from './i18n/I18nProvider.tsx';
import React, { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@mioon/ui/components/button';
import LanguageControl from './LanguageControl.tsx';
import { WorkspaceVisibilityProvider } from './workspace-visibility.jsx';
import type { SettingsPage } from './settings-window-state.ts';

export type HomeConnectionSlot = 'agent' | 'official' | 'custom' | 'comfy';
const slots: readonly { id: HomeConnectionSlot; label: 'shell.agentLabel' | 'shell.openaiImage' | 'shell.compatibleImage' | 'shell.localComfy' }[] = [
  { id: 'agent', label: 'shell.agentLabel' }, { id: 'official', label: 'shell.openaiImage' },
  { id: 'custom', label: 'shell.compatibleImage' }, { id: 'comfy', label: 'shell.localComfy' },
];

/** This shell owns presentation only. Slot owners retain their component identity,
 * navigation registration and drafts; the existing visibility contract hides
 * interaction and clears transient secret inputs, never saves/discards a draft. */
export default function ProjectHomeConnections({ selected, page = selected, onSelect, onPage, panes, general, connectionsAvailable = true }: {
  selected: HomeConnectionSlot;
  page?: SettingsPage;
  onSelect: (slot: HomeConnectionSlot) => void;
  onPage?: (page: SettingsPage) => void;
  panes: Readonly<Record<HomeConnectionSlot, ReactNode>>;
  general?: ReactNode;
  connectionsAvailable?: boolean;
}) {
  const { t } = useI18n();
  const heading = useId();
  const opened = useRef(new Set<HomeConnectionSlot>());
  const lastModel = useRef<HomeConnectionSlot>('agent');
  if (page !== 'general') opened.current.add(page);
  if (page !== 'general' && page !== 'comfy') lastModel.current = page;
  const category = page === 'general' ? 'general' : page === 'comfy' ? 'extensions' : 'models';
  const selectPage = (next: SettingsPage) => { if (next !== 'general' && !connectionsAvailable) return; if (onPage) onPage(next); else if (next !== 'general') onSelect(next); };
  return <section className="settings-center" data-testid="settings-center" data-page={page} aria-label={t('settings.title')}>
    <nav className="settings-center-nav" aria-label={t('settings.categories')}>
      <span className="settings-center-nav-label">{t('settings.title')}</span>
      <Button type="button" variant="ghost" data-testid="settings-category-general" aria-current={category === 'general' ? 'page' : undefined} onClick={() => selectPage('general')}>{t('settings.general')}</Button>
      <Button type="button" variant="ghost" data-testid="settings-category-models" disabled={!connectionsAvailable} aria-current={category === 'models' ? 'page' : undefined} onClick={() => selectPage(lastModel.current)}>{t('settings.models')}</Button>
      <Button type="button" variant="ghost" data-testid="settings-category-extensions" disabled={!connectionsAvailable} aria-current={category === 'extensions' ? 'page' : undefined} onClick={() => selectPage('comfy')}>{t('settings.extensions')}</Button>
      <p>{t('settings.scope')}</p>
    </nav>
    <div className="settings-center-content" aria-labelledby={heading}>
      <header className="settings-center-heading"><h1 id={heading}>{t(category === 'general' ? 'settings.general' : category === 'models' ? 'settings.models' : 'settings.extensions')}</h1><p>{t(category === 'general' ? 'settings.generalHint' : category === 'models' ? 'settings.modelsHint' : 'settings.extensionsHint')}</p></header>
      <section hidden={page !== 'general'} inert={page !== 'general'} className="settings-general" data-testid="settings-general">
        <div className="settings-preference"><div><h2>{t('language.label')}</h2><p>{t('settings.languageHint')}</p></div><LanguageControl /></div>
        {general}
      </section>
      <nav hidden={category !== 'models'} inert={category !== 'models'} className="settings-service-nav" aria-label={t('shell.connectionType')}>
        {slots.filter(slot => slot.id !== 'comfy').map(slot => <Button key={slot.id} type="button" variant="ghost" aria-current={page === slot.id ? 'page' : undefined} data-testid={`settings-service-${slot.id}`} onClick={() => selectPage(slot.id)}>{t(slot.label)}</Button>)}
      </nav>
      <div className="settings-connection-panes" hidden={page === 'general'} inert={page === 'general'}>
        <WorkspaceVisibilityProvider visible={page !== 'general'}>
          {slots.filter(slot => opened.current.has(slot.id)).map(slot => <React.Fragment key={slot.id}>{panes[slot.id]}</React.Fragment>)}
        </WorkspaceVisibilityProvider>
      </div>
    </div>
  </section>;
}
