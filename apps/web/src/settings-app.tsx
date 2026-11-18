import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import { TooltipProvider } from '@mioon/ui/components/tooltip';
import { UiLanguageProvider } from '../../../packages/ui/src/components/ui-language.tsx';
import { UiPreferencesProvider } from './UiPreferencesProvider.tsx';
import { I18nProvider, useI18n } from './i18n/I18nProvider.tsx';
import SettingsRoot from './SettingsRoot.tsx';
import type { SettingsRenderProps } from './SettingsRoot.tsx';
import { SettingsConnectionForms } from './SettingsConnectionForms.tsx';
import { readDesktopWindowBridge } from './desktop-window-client.ts';
import { applyDesktopFrame } from './desktop-frame.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';
import type { SettingsBootView } from './settings-boot.ts';
import './i18n/language.css';
import '@mioon/ui/globals.css';
import './styles.css';
import './project-home.css';
import './settings-center.css';
import './viewport-scale.css';

const identityContracts = {};
const renderSettings = (props: SettingsRenderProps) => <SettingsConnectionForms {...props} />;

function LocalizedSettings({ context, bridge, boot }: { context: ProjectWindowContext; bridge: ProjectWindowBridge; boot: SettingsBootView }) {
  const { t, renderMessage } = useI18n();
  return <UiLanguageProvider labels={{ close: t('common.close') }}>
    <TooltipProvider delay={350}>
      <ConfirmationProvider labels={{ title: t('common.confirmTitle'), cancel: t('common.cancel'), continue: t('common.continue') }} renderMessage={renderMessage}>
        <UiPreferencesProvider>
          <SettingsRoot context={context} bridge={bridge} boot={boot} contractChecks={identityContracts} renderSettings={renderSettings} />
        </UiPreferencesProvider>
      </ConfirmationProvider>
    </TooltipProvider>
  </UiLanguageProvider>;
}

/** This entry runs after the native settings ACK. Its import graph has no
 * editor, project launcher, or canvas instance. */
export function mountSettings(container: HTMLElement, context: ProjectWindowContext, boot: SettingsBootView): void {
  const bridge = readDesktopWindowBridge(window);
  if (!bridge || context.role !== 'settings') throw new Error('Active settings owner is unavailable.');
  applyDesktopFrame(document.documentElement, navigator.userAgent);
  createRoot(container, { onUncaughtError: () => boot.failed() }).render(
    <React.StrictMode><I18nProvider><LocalizedSettings context={context} bridge={bridge} boot={boot} /></I18nProvider></React.StrictMode>
  );
}
