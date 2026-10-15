import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@mioon/ui/components/dialog';
import { Button } from '@mioon/ui/components/button';
import { useConfirmation } from '@mioon/ui/components/workbench-confirm';
import { useI18n } from './i18n/I18nProvider.tsx';
import type { ReactNode } from 'react';
import type { SettingsRenderProps } from './SettingsRoot.tsx';
import type { SettingsPage } from './settings-window-state.ts';
import type { SettingsNavigationRegistry } from './settings-navigation-state.ts';
import { createWebSettingsNavigation } from './web-settings-navigation.ts';

/** Mounted at the same keyed root position in home and editor. The existing retained dialog
 * provides focus containment/background inertness without unmounting the editor.
 * Closing the dialog hides retained owners; it does not dispose their sessions. */
export default function WebSettingsCenter({ request, registry, onOpenChange, renderSettings, connectionsAvailable = true }: { request: { page: SettingsPage; resolve?: (accepted: boolean) => void } | null; registry: SettingsNavigationRegistry; connectionsAvailable?: boolean; onOpenChange: (open: boolean) => void; renderSettings: (props: SettingsRenderProps) => ReactNode }) {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation();
  const closeButton = useRef<HTMLButtonElement>(null), callbacks = useRef({ onOpenChange });
  callbacks.current = { onOpenChange };
  const [, rerender] = useState(0);
  const [navigation] = useState(() => createWebSettingsNavigation({ registry, confirm, onChange: () => rerender(value => value + 1) }));
  useEffect(() => { navigation.activate(); return () => navigation.dispose(); }, [navigation]);
  useEffect(() => { if (request) void navigation.open(connectionsAvailable ? request.page : 'general').then(accepted => request.resolve?.(accepted)); }, [request, navigation, connectionsAvailable]);
  useEffect(() => { callbacks.current.onOpenChange(navigation.opened); }, [navigation.opened]);
  return <Dialog open={navigation.opened} onOpenChange={open => { if (!open) void navigation.close(); }}>
    <DialogContent keepMounted showCloseButton={false} initialFocus={closeButton} className="web-settings-dialog project-home" data-testid="web-settings-dialog" hidden={!navigation.opened} inert={!navigation.opened} aria-describedby={undefined}>
    <header className="project-home-header"><span className="project-home-brand">mioon.</span><DialogTitle className="project-home-header-label">{t('settings.title')}</DialogTitle><Button ref={closeButton} type="button" variant="ghost" className="settings-back" data-testid="settings-center-close" onClick={() => { void navigation.close(); }}>{t('settings.back')}</Button></header>
    <div className="web-settings-scroll">
      {navigation.notice && <p role="status" className="project-home-notice">{renderMessage(navigation.notice)}</p>}
      {renderSettings({ selected: navigation.selected, page: navigation.page, visible: navigation.opened, registry, connectionsAvailable, general: undefined,
        onSelect: slot => { if (connectionsAvailable) void navigation.selectPage(slot); }, onPage: page => { if (connectionsAvailable || page === 'general') void navigation.selectPage(page); },
        beforeClose: async () => { void navigation.close(); return false; }, onClose: () => {} })}
    </div>
  </DialogContent></Dialog>;
}
