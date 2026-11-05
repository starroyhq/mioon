import { contextBridge, ipcRenderer, webUtils } from 'electron';
// Marker remains available if any later bridge setup fails.
contextBridge.exposeInMainWorld('__mioonDesktop', true);
import {createProjectEntriesDesktopBridge} from './project-entry-desktop-preload.ts';
contextBridge.exposeInMainWorld('__mioonProjectEntries',createProjectEntriesDesktopBridge((channel,request)=>ipcRenderer.invoke(channel,request)));
import {createNativeAssetMediaBridge} from './asset-relink-preload.ts';
contextBridge.exposeInMainWorld('__mioonAssetMediaNative',createNativeAssetMediaBridge((channel,request)=>ipcRenderer.invoke(channel,request)));
import {createWorkspaceNativeBridges} from './workspace-native-preload.ts';
const workspaceNative=createWorkspaceNativeBridges((channel,request)=>ipcRenderer.invoke(channel,request));
contextBridge.exposeInMainWorld('__mioonWorkspaceNative',workspaceNative.native);
contextBridge.exposeInMainWorld('__mioonExportFiles',workspaceNative.exports);
contextBridge.exposeInMainWorld('__mioonProjectPackages',workspaceNative.projectPackages);
import {createWorkspaceToolsBridge} from './workspace-tools-preload.ts';
contextBridge.exposeInMainWorld('__mioonWorkspaceTools',createWorkspaceToolsBridge((channel,request)=>ipcRenderer.invoke(channel,request)));
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

import {createMenuCommandBridge} from './menu-command-preload.ts';
contextBridge.exposeInMainWorld('__mioonMenuCommands', createMenuCommandBridge({
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

import {createAssetImportBridge} from './asset-import-preload.ts';
contextBridge.exposeInMainWorld('__mioonAssetImport',createAssetImportBridge({invoke:(channel,input)=>ipcRenderer.invoke(channel,input),pathForFile:file=>webUtils.getPathForFile(file)}));
