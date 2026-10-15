import { contextBridge, ipcRenderer } from 'electron';
// Marker remains available if any later bridge setup fails.
contextBridge.exposeInMainWorld('__mioonDesktop', true);
import { createDesktopLutRecoveryBridge } from './lut-recovery-preload.ts';
contextBridge.exposeInMainWorld('__mioonLutRecovery', createDesktopLutRecoveryBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
}));
import { createProjectWindowBridge } from './project-window-preload.ts';
// Sandboxed, context-isolated, fixed window-only bridge. Business access stays
// on the existing authenticated same-origin HTTP services.
contextBridge.exposeInMainWorld('__mioonProjectWindow', createProjectWindowBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => { ipcRenderer.on(channel, listener); },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
}));

import { createNativeAudioPreviewBridge } from './native-audio-preview-preload.ts';
contextBridge.exposeInMainWorld('__mioonNativeAudioPreview', createNativeAudioPreviewBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => { ipcRenderer.on(channel, listener); },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
}));

import { createAppLanguageBridge } from './app-language-preload.ts';
contextBridge.exposeInMainWorld('__mioonAppLanguage', createAppLanguageBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => { ipcRenderer.on(channel, listener); },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
}));
