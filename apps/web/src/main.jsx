import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.jsx';
import DesktopRoot from './DesktopRoot.tsx';
import ProjectHomeConnections from './ProjectHomeConnections.tsx';
import SettingsNavigationSlot from './SettingsNavigationSlot.tsx';
import { AgentDockPane } from './AgentWorkspace.jsx';
import AgentSettings from './AgentSettings.jsx';
import ImageSettings from './ImageSettings.jsx';
import ComfyImageSettings from './ComfyImageSettings.jsx';
import { ApiError, rpc } from './api.js';
import { schemas } from '@mioon/contracts';
import { workspaceRestoreInspectionSchema } from '../../../packages/contracts/src/workspace-restore.mjs';
import '@xyflow/react/dist/style.css';
import '@mioon/ui/globals.css';
import './styles.css';
import './project-home.css';
import { TooltipProvider } from '@mioon/ui/components/tooltip';
import { desktopFrame } from './desktop-frame.ts';

document.documentElement.classList.add('dark');
const frame = desktopFrame(navigator.userAgent);
if (frame) document.documentElement.dataset.desktopFrame = frame;

const launcherContracts = { parseCreateInput: value => schemas['project.create'].parse(value), parseWorkspaceInspection: value => workspaceRestoreInspectionSchema.parse(value), isDefinitiveCreateRejection: error => error instanceof ApiError && error.definitive === true };
const renderConnections = ({ selected, visible, registry, onSelect, beforeClose, onClose }) => <ProjectHomeConnections selected={selected} onSelect={onSelect} panes={{
  agent: <AgentDockPane visible={visible && selected === 'agent'}><SettingsNavigationSlot registry={registry} slot="home:agent">{report => <AgentSettings closeLabel="关闭设置窗口" beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  official: <AgentDockPane visible={visible && selected === 'official'}><SettingsNavigationSlot registry={registry} slot="home:official">{report => <ImageSettings active={visible && selected === 'official'} contextKey="native-settings" closeLabel="关闭设置窗口" slot="official" onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  custom: <AgentDockPane visible={visible && selected === 'custom'}><SettingsNavigationSlot registry={registry} slot="home:custom">{report => <ImageSettings active={visible && selected === 'custom'} contextKey="native-settings" closeLabel="关闭设置窗口" slot="custom" onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
  comfy: <AgentDockPane visible={visible && selected === 'comfy'}><SettingsNavigationSlot registry={registry} slot="home:comfy">{report => <ComfyImageSettings active={visible && selected === 'comfy'} contextKey="native-settings" closeLabel="关闭设置窗口" onSelectSlot={onSelect} onRequestSelectSlot={onSelect} beforeClose={beforeClose} onClose={onClose} onNavigationStateChange={report} />}</SettingsNavigationSlot></AgentDockPane>,
}} />;
createRoot(document.getElementById('root')).render(<React.StrictMode><TooltipProvider delay={350}><ConfirmationProvider><ReactFlowProvider><DesktopRoot rpc={rpc} contractChecks={launcherContracts} renderWeb={() => <App />} renderEditor={(context, bridge, entry) => <App nativeWindow={{ context, bridge }} nativeProjectEntry={entry} />} renderSettings={renderConnections} /></ReactFlowProvider></ConfirmationProvider></TooltipProvider></React.StrictMode>);
