import {contextBridge,ipcRenderer} from 'electron';
import {createNativeAudioPreviewBridge} from '../../../apps/desktop/src/native-audio-preview-preload.ts';
contextBridge.exposeInMainWorld('__mioonNativeAudioPreview',createNativeAudioPreviewBridge({
  invoke:(channel,value)=>ipcRenderer.invoke(channel,value),
  on:(channel,listener)=>{ipcRenderer.on(channel,listener);},
  removeListener:(channel,listener)=>{ipcRenderer.removeListener(channel,listener);},
}));
contextBridge.exposeInMainWorld('__continuousFixture',Object.freeze({
  config:()=>ipcRenderer.invoke('continuous-fixture:config'),
  report:(result:unknown)=>ipcRenderer.invoke('continuous-fixture:report',result),
  capture:(value:unknown)=>ipcRenderer.invoke('continuous-fixture:capture',value),
}));
