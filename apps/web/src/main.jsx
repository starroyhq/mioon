import { ConfirmationProvider } from '@mioon/ui/components/workbench-confirm';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.jsx';
import '@xyflow/react/dist/style.css';
import '@mioon/ui/globals.css';
import './styles.css';
import { TooltipProvider } from '@mioon/ui/components/tooltip';

document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')).render(<React.StrictMode><TooltipProvider delay={350}><ConfirmationProvider><ReactFlowProvider><App /></ReactFlowProvider></ConfirmationProvider></TooltipProvider></React.StrictMode>);
