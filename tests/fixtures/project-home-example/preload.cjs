const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('projectHomeFixture', {trash: input => ipcRenderer.invoke('project-home-fixture:trash', input)});
