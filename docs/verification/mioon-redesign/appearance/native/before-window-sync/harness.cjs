const {app,BrowserWindow,nativeTheme}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.dirname(__dirname),output=path.join(root,'native-observation.json');
require('./main.cjs');
let sampling=false;
const sample=async()=>{if(sampling)return;sampling=true;try{
const windows=[];
for(const w of BrowserWindow.getAllWindows()){
 if(w.isDestroyed())continue;
 const state={id:w.id,bounds:w.getBounds(),backgroundColor:w.getBackgroundColor(),trafficLightPosition:process.platform==='darwin'?w.getWindowButtonPosition():null,visible:w.isVisible(),focused:w.isFocused()};
 try{state.document=await w.webContents.executeJavaScript(`(()=>{const root=document.documentElement;return {url:location.pathname+location.search,appearance:root.dataset.appearance,theme:root.dataset.theme,classes:root.className,colorScheme:root.style.colorScheme,background:getComputedStyle(root).getPropertyValue('--wb-bg').trim(),systemDark:matchMedia('(prefers-color-scheme: dark)').matches,workbench:!!document.querySelector('[data-testid="workspace-canvas"]'),settings:!!document.querySelector('[data-testid="appearance-theme"]')};})()`);}catch{}
 windows.push(state);
}
fs.writeFileSync(output,JSON.stringify({timestamp:new Date().toISOString(),pid:process.pid,nativeTheme:{themeSource:nativeTheme.themeSource,shouldUseDarkColors:nativeTheme.shouldUseDarkColors},windows},null,2),{mode:0o600});
}catch{}finally{sampling=false;}};
app.whenReady().then(()=>{const timer=setInterval(()=>void sample(),250);app.once('before-quit',()=>clearInterval(timer));});
