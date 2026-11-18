import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { isLocale } from '../../../packages/i18n/src/locale.ts';
import { SETTINGS_DIAGNOSTICS_CHANNEL, parseSettingsDiagnosticRequest } from './settings-diagnostics-protocol.ts';
import type { SettingsDiagnosticsBridge } from './settings-diagnostics-protocol.ts';
import { DESKTOP_CHROME_SCALE_EVENT, DESKTOP_FULLSCREEN_EVENT, DESKTOP_TITLEBAR_COLOR_EVENT, isDesktopChromeScale,
  isDesktopTitleBarColor } from '../../../packages/contracts/src/desktop-window-chrome.ts';
// Marker remains available if any later bridge setup fails.
contextBridge.exposeInMainWorld('__mioonDesktop', true);
// Windows: the page owns the rendered appearance, so it reports the color behind
// the system caption band; only a validated bounded CSS color can be sent.
if (process.platform === 'win32') {
  contextBridge.exposeInMainWorld('__mioonWindowChrome', Object.freeze({
    setTitleBarColor(color: unknown): void {
      if (isDesktopTitleBarColor(color)) ipcRenderer.send(DESKTOP_TITLEBAR_COLOR_EVENT, color);
    },
  }));
}
if (process.isMainFrame && process.platform === 'darwin') {
  let fullscreen = false;
  let lastScale: number | undefined;
  let scaleObserver: MutationObserver | undefined;
  const applyFullscreen = () => {
    if (document.documentElement) document.documentElement.dataset.desktopFullscreen = String(fullscreen);
  };
  const publishScale = () => {
    const root = document.documentElement;
    if (!root) return;
    const scale = Number(root.style.getPropertyValue('--mioon-ui-scale') || '1');
    if (!isDesktopChromeScale(scale) || scale === lastScale) return;
    lastScale = scale;
    ipcRenderer.send(DESKTOP_CHROME_SCALE_EVENT, scale);
  };
  const ready = () => {
    applyFullscreen();
    if (!document.documentElement || scaleObserver) return;
    scaleObserver = new MutationObserver(publishScale);
    scaleObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['style']});
    publishScale();
  };
  const receiveFullscreen = (_event: unknown, value: unknown) => {
    if (typeof value !== 'boolean') return;
    fullscreen = value;
    applyFullscreen();
  };
  ipcRenderer.on(DESKTOP_FULLSCREEN_EVENT, receiveFullscreen);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once: true});
  else ready();
  window.addEventListener('unload', () => {
    ipcRenderer.removeListener(DESKTOP_FULLSCREEN_EVENT, receiveFullscreen);
    document.removeEventListener('DOMContentLoaded', ready);
    scaleObserver?.disconnect();
  }, {once: true});
  applyFullscreen();
}
// Display metadata for shortening paths already present in the project list.
if (process.isMainFrame) {
  const prefix = '--mioon-home-directory=';
  const homeDirectory = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
  if (homeDirectory) contextBridge.exposeInMainWorld('__mioonHomeDirectory', homeDirectory);
  const locale = process.argv.find(argument => argument.startsWith('--mioon-settings-locale='))?.slice('--mioon-settings-locale='.length);
  const theme = process.argv.find(argument => argument.startsWith('--mioon-settings-theme='))?.slice('--mioon-settings-theme='.length);
  if (isLocale(locale) && (theme === 'light' || theme === 'dark')) {
    contextBridge.exposeInMainWorld('__mioonSettingsBootAppearance', Object.freeze({locale, theme}));
  }
}
const markSettings = (value: unknown): Promise<boolean> => {
  const request = parseSettingsDiagnosticRequest(value);
  return request ? ipcRenderer.invoke(SETTINGS_DIAGNOSTICS_CHANNEL, request).then(result => result === true, () => false) : Promise.resolve(false);
};
const settingsDiagnosticsBridge: SettingsDiagnosticsBridge = Object.freeze({
  markClick: (eventAt: number) => { void markSettings({kind: 'click', eventAt, handledAt: Date.now()}); },
  markBoot: (phase: Parameters<SettingsDiagnosticsBridge['markBoot']>[0]) => markSettings({kind: 'boot', phase, at: Date.now()}),
  markRead: (page: Parameters<SettingsDiagnosticsBridge['markRead']>[0], phase: 'start' | 'end', requestId: number, at: number) => {
    void markSettings({kind: 'read', page, phase, requestId, at});
  },
});
contextBridge.exposeInMainWorld('__mioonSettingsDiagnostics', settingsDiagnosticsBridge);
import {createProjectEntriesDesktopBridge} from './project-entry-desktop-preload.ts';
import { createProjectWindowBridge } from './project-window-preload.ts';
const projectWindowBridge=createProjectWindowBridge({
  invoke:(channel,request)=>ipcRenderer.invoke(channel,request),
  on:(channel,listener)=>{ipcRenderer.on(channel,listener);},
  removeListener:(channel,listener)=>{ipcRenderer.removeListener(channel,listener);},
});
contextBridge.exposeInMainWorld('__mioonProjectEntries',createProjectEntriesDesktopBridge((channel,request)=>ipcRenderer.invoke(channel,request),{
  on:(channel,listener)=>{ipcRenderer.on(channel,listener);},
  removeListener:(channel,listener)=>{ipcRenderer.removeListener(channel,listener);},
  context:()=>projectWindowBridge.context(),
}));
import {createNativeAssetMediaBridge} from './asset-relink-preload.ts';
contextBridge.exposeInMainWorld('__mioonAssetMediaNative',createNativeAssetMediaBridge((channel,request)=>ipcRenderer.invoke(channel,request)));
import {createWorkspaceNativeBridges} from './workspace-native-preload.ts';
const workspaceNative=createWorkspaceNativeBridges((channel,request)=>ipcRenderer.invoke(channel,request));
contextBridge.exposeInMainWorld('__mioonWorkspaceNative',workspaceNative.native);
contextBridge.exposeInMainWorld('__mioonExportFiles',workspaceNative.exports);
contextBridge.exposeInMainWorld('__mioonProjectPackages',workspaceNative.projectPackages);
contextBridge.exposeInMainWorld('__mioonProjectBackups',workspaceNative.projectBackups);
import {createWorkspaceToolsBridge} from './workspace-tools-preload.ts';
contextBridge.exposeInMainWorld('__mioonWorkspaceTools',createWorkspaceToolsBridge((channel,request)=>ipcRenderer.invoke(channel,request)));
import { createDesktopLutRecoveryBridge } from './lut-recovery-preload.ts';
contextBridge.exposeInMainWorld('__mioonLutRecovery', createDesktopLutRecoveryBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
}));
// Sandboxed, context-isolated, fixed window-only bridge. Business access stays
// on the existing authenticated same-origin HTTP services.
contextBridge.exposeInMainWorld('__mioonProjectWindow',projectWindowBridge);

import {createMenuCommandBridge} from './menu-command-preload.ts';
contextBridge.exposeInMainWorld('__mioonMenuCommands', createMenuCommandBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => { ipcRenderer.on(channel, listener); },
  removeListener: (channel, listener) => { ipcRenderer.removeListener(channel, listener); },
}));

import {CANVAS_CLIPBOARD_CHANNEL, installCanvasClipboardBridge} from './canvas-clipboard.ts';
if (process.isMainFrame) contextBridge.exposeInMainWorld('__mioonCanvasClipboard', installCanvasClipboardBridge(
  window, () => ipcRenderer.invoke(CANVAS_CLIPBOARD_CHANNEL),
));

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

import {createDesktopUpdateBridge} from './desktop-update-preload.ts';
if (process.isMainFrame) contextBridge.exposeInMainWorld('mioonDesktopUpdate', createDesktopUpdateBridge({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => {ipcRenderer.on(channel, listener);},
  removeListener: (channel, listener) => {ipcRenderer.removeListener(channel, listener);},
}));
