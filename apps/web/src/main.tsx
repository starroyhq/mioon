import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import { UiPreferencesProvider } from './UiPreferencesProvider.tsx';
import React from 'react';
import { I18nProvider, useI18n } from './i18n/I18nProvider.tsx';
import { UiLanguageProvider } from '../../../packages/ui/src/components/ui-language.tsx';
import './i18n/language.css';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App, { SettingsConnectionForms } from './App.tsx';
import DesktopRoot from './DesktopRoot.tsx';
import { ApiError, rpc } from './api.ts';
import { schemas } from '@mioon/contracts';
import { workspaceRestoreInspectionSchema } from '../../../packages/contracts/src/workspace-restore.ts';
import '@xyflow/react/dist/style.css';
import '@mioon/ui/globals.css';
import './styles.css';
import './project-home.css';
import './settings-center.css';
import './viewport-scale.css';
import { TooltipProvider } from '@mioon/ui/components/tooltip';
import { desktopFrame } from './desktop-frame.ts';
import type { LauncherSettingsProps } from './LauncherRoot.tsx';
import type { LauncherContractChecks, LauncherRpc } from './launcher-state.ts';
import type { NativeProjectEntryActions } from './native-project-entry.ts';
import type { ProjectWindowBridge, ProjectWindowContext } from './desktop-window-client.ts';

type ApiErrorWithDefinitive = ApiError & {readonly definitive?: unknown};
interface NativeAppProps {
  nativeWindow?: {context: ProjectWindowContext; bridge: ProjectWindowBridge};
  nativeProjectEntry?: NativeProjectEntryActions;
}
const NativeApp = App as unknown as (props: NativeAppProps) => React.ReactElement;

const frame = desktopFrame(navigator.userAgent);
if (frame) document.documentElement.dataset.desktopFrame = frame;

const launcherContracts: LauncherContractChecks = { parseCreateInput: (value: unknown) => schemas['project.create'].parse(value), parseWorkspaceInspection: (value: unknown) => workspaceRestoreInspectionSchema.parse(value), isDefinitiveCreateRejection: (error: unknown) => error instanceof ApiError && (error as ApiErrorWithDefinitive).definitive === true };
const launcherRpc = rpc as unknown as LauncherRpc;
const renderConnections = (props: LauncherSettingsProps) => <SettingsConnectionForms {...(props as unknown as React.ComponentProps<typeof SettingsConnectionForms>)} />;
function LocalizedApplication() {
  const { t, renderMessage } = useI18n();
  return <UiLanguageProvider labels={{ close: t('common.close') }}><TooltipProvider delay={350}><ConfirmationProvider labels={{ title: t('common.confirmTitle'), cancel: t('common.cancel'), continue: t('common.continue') }} renderMessage={renderMessage}><UiPreferencesProvider><ReactFlowProvider><DesktopRoot rpc={launcherRpc} contractChecks={launcherContracts} renderWeb={() => <NativeApp />} renderEditor={(context, bridge, entry) => <NativeApp nativeWindow={{ context, bridge }} nativeProjectEntry={entry} />} renderSettings={renderConnections} /></ReactFlowProvider></UiPreferencesProvider></ConfirmationProvider></TooltipProvider></UiLanguageProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider><LocalizedApplication /></I18nProvider></React.StrictMode>);
