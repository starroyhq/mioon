import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@mioon/ui/components/dialog';
import { WorkbenchIcon } from '@mioon/ui/components/workbench-icons';
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
export default function WebSettingsCenter({ request, registry, onOpenChange, renderSettings, connectionsAvailable = true, interactionBlocked = false }: { request: { page: SettingsPage; resolve?: (accepted: boolean) => void } | null; registry: SettingsNavigationRegistry; connectionsAvailable?: boolean; interactionBlocked?: boolean; onOpenChange: (open: boolean) => void; renderSettings: (props: SettingsRenderProps) => ReactNode }) {
  const { t, renderMessage } = useI18n();
  const confirm = useConfirmation();
  const closeButton = useRef<HTMLButtonElement>(null), callbacks = useRef({ onOpenChange, interactionBlocked, connectionsAvailable });
  callbacks.current = { onOpenChange, interactionBlocked, connectionsAvailable };
  const requests = useRef(new WeakMap<NonNullable<typeof request>, {serial: number; settled: boolean}>()), previousBlocked = useRef(interactionBlocked);
  const [, rerender] = useState(0);
  const [entryVersion, setEntryVersion] = useState(0);
  const [navigation] = useState(() => {
    const owner = createWebSettingsNavigation({ registry, confirm, onChange: () => rerender(value => value + 1) });
    if (interactionBlocked) owner.dispose();
    return owner;
  });
  // Revoke an already-pending confirmation before passive effects or stale
  // callbacks can commit it. Disposing presentation intent keeps forms,
  // secrets, page and unknown request owners mounted and unchanged.
  if (previousBlocked.current !== interactionBlocked) {
    previousBlocked.current = interactionBlocked; navigation.dispose();
    if (!interactionBlocked) navigation.activate();
  }
  useEffect(() => { if (!callbacks.current.interactionBlocked) navigation.activate(); return () => navigation.dispose(); }, [navigation]);
  useEffect(() => {
    let current = true;
    if (!request) return;
    let owner = requests.current.get(request);
    if (!owner) {owner = {serial: 0, settled: false}; requests.current.set(request, owner);}
    const ticket = owner, serial = ++ticket.serial;
    const settle = (accepted: boolean) => {if (!ticket.settled) {ticket.settled = true; request.resolve?.(accepted);}};
    if (!ticket.settled) {
      if (callbacks.current.interactionBlocked) settle(false);
      else void navigation.open(connectionsAvailable ? request.page : 'general').then(accepted => {
        if (!current || ticket.serial !== serial || ticket.settled) return;
        const admitted = !callbacks.current.interactionBlocked && accepted;
        if (admitted) setEntryVersion(version => version + 1);
        settle(admitted);
      });
    }
    // StrictMode may immediately reattach this same request. Only a retired
    // subscription with no replacement settles its caller as cancelled.
    return () => { current = false; void Promise.resolve().then(() => {if (ticket.serial === serial) settle(false);}); };
  }, [request, navigation, connectionsAvailable, interactionBlocked]);
  useEffect(() => { callbacks.current.onOpenChange(navigation.opened); }, [navigation.opened]);
  const blockInteraction = (event: React.SyntheticEvent) => {if (callbacks.current.interactionBlocked) {event.preventDefault(); event.stopPropagation();}};
  const close = () => {if (!callbacks.current.interactionBlocked) void navigation.close();};
  return <Dialog open={navigation.opened} onOpenChange={(open, details) => { if (!open) {if (callbacks.current.interactionBlocked) details?.cancel(); else close();} }}>
    <DialogContent keepMounted showCloseButton={false} initialFocus={closeButton} className="web-settings-dialog project-home" data-testid="web-settings-dialog" hidden={!navigation.opened} inert={!navigation.opened} aria-describedby={undefined}>
    <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle><Button ref={closeButton} type="button" variant="ghost" className="settings-center-close" aria-label={t('common.close')} data-testid="settings-center-close" disabled={interactionBlocked} onClick={close}><WorkbenchIcon name="close" /></Button>
    {interactionBlocked && <p role="alert" className="project-home-notice" data-testid="web-settings-identity-blocked">{t('projects.locatorKeepWindow')}</p>}
    <div className="web-settings-scroll" data-testid="web-settings-body" inert={interactionBlocked} onClickCapture={blockInteraction} onSubmitCapture={blockInteraction} onInputCapture={blockInteraction} onChangeCapture={blockInteraction} onKeyDownCapture={blockInteraction} onPointerDownCapture={blockInteraction}>
      {navigation.notice && <p role="status" className="project-home-notice">{renderMessage(navigation.notice)}</p>}
      {renderSettings({ selected: navigation.selected, page: navigation.page, entryVersion, visible: navigation.opened, registry, connectionsAvailable, general: undefined,
        onSelect: slot => { if (!callbacks.current.interactionBlocked && callbacks.current.connectionsAvailable) void navigation.selectPage(slot); }, onPage: page => { if (!callbacks.current.interactionBlocked && (callbacks.current.connectionsAvailable || !['agent', 'models', 'extensions', 'official', 'custom', 'comfy'].includes(page))) void navigation.selectPage(page); },
        beforeClose: async () => { close(); return false; }, onClose: () => {} })}
    </div>
  </DialogContent></Dialog>;
}
