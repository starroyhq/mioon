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
import { schemas, isTimelineRecord, isTimelineMutationResponse, isTimelineRenderRecord, isEditTaskEnvelope, isEditTaskListEnvelope } from '@mioon/contracts';
import { createEditTaskClient } from './edit-task-client.ts';
import { createOpacityCandidateApplication } from './opacity-candidate-application.ts';
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

declare const __MIOON_INTERNAL_OPACITY_CANDIDATE__: boolean;
type ApiErrorWithDefinitive = ApiError & {readonly definitive?: unknown};
interface NativeAppProps {
  opacityApplication?: unknown;
  nativeWindow?: {context: ProjectWindowContext; bridge: ProjectWindowBridge};
  nativeProjectEntry?: NativeProjectEntryActions;
}
const NativeApp = App as unknown as (props: NativeAppProps) => React.ReactElement;

const frame = desktopFrame(navigator.userAgent);
if (frame) document.documentElement.dataset.desktopFrame = frame;

const launcherContracts: LauncherContractChecks = { parseCreateInput: (value: unknown) => schemas['project.create'].parse(value), parseWorkspaceInspection: (value: unknown) => workspaceRestoreInspectionSchema.parse(value), isDefinitiveCreateRejection: (error: unknown) => error instanceof ApiError && (error as ApiErrorWithDefinitive).definitive === true };
const launcherRpc = rpc as unknown as LauncherRpc;
// Vite replaces this literal with false for every ordinary build. The isolated
// internal build is the only entry that creates the module-owned capability.
const opacityApplication = __MIOON_INTERNAL_OPACITY_CANDIDATE__ ? createOpacityCandidateApplication({ rpc, createEditTaskClient: createEditTaskClient as unknown as Parameters<typeof createOpacityCandidateApplication>[0]['createEditTaskClient'],
  schemas, isTimelineRecord, isTimelineMutationResponse, isTimelineRenderRecord, isEditTaskEnvelope, isEditTaskListEnvelope }) : null;
const renderConnections = (props: LauncherSettingsProps) => <SettingsConnectionForms {...(props as unknown as React.ComponentProps<typeof SettingsConnectionForms>)} />;
function LocalizedApplication() {
  const { t, renderMessage } = useI18n();
  return <UiLanguageProvider labels={{ close: t('common.close') }}><TooltipProvider delay={350}><ConfirmationProvider labels={{ title: t('common.confirmTitle'), cancel: t('common.cancel'), continue: t('common.continue') }} renderMessage={renderMessage}><UiPreferencesProvider><ReactFlowProvider>{opacityApplication ? <NativeApp opacityApplication={opacityApplication} /> : <DesktopRoot rpc={launcherRpc} contractChecks={launcherContracts} renderWeb={() => <NativeApp />} renderEditor={(context, bridge, entry) => <NativeApp nativeWindow={{ context, bridge }} nativeProjectEntry={entry} />} renderSettings={renderConnections} />}</ReactFlowProvider></UiPreferencesProvider></ConfirmationProvider></TooltipProvider></UiLanguageProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nProvider><LocalizedApplication /></I18nProvider></React.StrictMode>);
