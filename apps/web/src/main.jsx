import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.jsx';
import '@xyflow/react/dist/style.css';
import '@mioon/ui/globals.css';
import './styles.css';
import { TooltipProvider } from '@mioon/ui/components/tooltip';
import { desktopFrame } from './desktop-frame.ts';

document.documentElement.classList.add('dark');
const frame = desktopFrame(navigator.userAgent);
if (frame) document.documentElement.dataset.desktopFrame = frame;

createRoot(document.getElementById('root')).render(<React.StrictMode><TooltipProvider delay={350}><ConfirmationProvider><ReactFlowProvider><App /></ReactFlowProvider></ConfirmationProvider></TooltipProvider></React.StrictMode>);
