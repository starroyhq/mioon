import { contextBridge, ipcRenderer } from 'electron';
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
