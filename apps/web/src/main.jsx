import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import React from 'react';
import { I18nProvider, useI18n } from './i18n/I18nProvider.tsx';
import { UiLanguageProvider } from '../../../packages/ui/src/components/ui-language.tsx';
import './i18n/language.css';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App, { SettingsConnectionForms } from './App.jsx';
import DesktopRoot from './DesktopRoot.tsx';
import { ApiError, rpc } from './api.js';
import { schemas } from '@mioon/contracts';
import { workspaceRestoreInspectionSchema } from '../../../packages/contracts/src/workspace-restore.mjs';
import '@xyflow/react/dist/style.css';
import '@mioon/ui/globals.css';
import './styles.css';
import './project-home.css';
import './settings-center.css';
import { TooltipProvider } from '@mioon/ui/components/tooltip';
import { desktopFrame } from './desktop-frame.ts';

document.documentElement.classList.add('dark');
const frame = desktopFrame(navigator.userAgent);
if (frame) document.documentElement.dataset.desktopFrame = frame;

const launcherContracts = { parseCreateInput: value => schemas['project.create'].parse(value), parseWorkspaceInspection: value => workspaceRestoreInspectionSchema.parse(value), isDefinitiveCreateRejection: error => error instanceof ApiError && error.definitive === true };
const renderConnections = props => <SettingsConnectionForms {...props} />;
function LocalizedApplication() {
  const { t, renderMessage } = useI18n();
  return <UiLanguageProvider labels={{ close: t('common.close') }}><TooltipProvider delay={350}><ConfirmationProvider labels={{ title: t('common.confirmTitle'), cancel: t('common.cancel'), continue: t('common.continue') }} renderMessage={renderMessage}><ReactFlowProvider><DesktopRoot rpc={rpc} contractChecks={launcherContracts} renderWeb={() => <App />} renderEditor={(context, bridge, entry) => <App nativeWindow={{ context, bridge }} nativeProjectEntry={entry} />} renderSettings={renderConnections} /></ReactFlowProvider></ConfirmationProvider></TooltipProvider></UiLanguageProvider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider><LocalizedApplication /></I18nProvider></React.StrictMode>);
