import {watch} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {calculateWorkspaceScope} from '../../../packages/contracts/src/workspace-scope.ts';
import {DEFAULT_UI_PREFERENCES, UI_PREFERENCES_LIMITS, normalizeUiPreferences, uiPreferencesDiskSchema} from '../../../packages/contracts/src/ui-preferences.ts';
import type {UiPreferences} from '../../../packages/contracts/src/ui-preferences.ts';

export const WINDOW_BACKGROUNDS = Object.freeze({dark:'#0B0C0E',light:'#F6F6F6'});
const filename = 'ui-preferences-v1.json';
interface Window {
  isDestroyed():boolean;
  setBackgroundColor(color:string):void;
}
interface Storage {
  validatePrivateDirectory(root:string):Stats|null;
  validateManagedFile(file:string,options:{root:string}):Stats|null;
  readPrivateFile(file:string,options:{root:string;private:true;allowMissing:true;maxBytes:number}):Buffer|null;
}
interface Theme {
  readonly shouldUseDarkColors:boolean;
  on(event:'updated',listener:()=>void):unknown;
  removeListener(event:'updated',listener:()=>void):unknown;
}
interface Watcher {close():void;on(event:'error',listener:()=>void):unknown}
interface Options<W extends Window> {
  root:string;channel:'development'|'production';storage:Storage;nativeTheme:Theme;signal:AbortSignal;
  isCurrent():boolean;getWindows():readonly W[];ownsWindow(window:W):boolean;
  watchDirectory?:(root:string,listener:(filename:string|Buffer|null)=>void)=>Watcher;
}

/** Read-only native fill for blank/loading edges. Renderer drafts remain the
 * document's authority; never override nativeTheme.themeSource, which would
 * also override the renderer's real OS prefers-color-scheme query. */
export function createDesktopWindowAppearance<W extends Window>(options:Options<W>) {
  const {root,channel,storage,nativeTheme,signal}=options;
  let active=true,establishedScope:string|undefined,background:string=WINDOW_BACKGROUNDS.dark,watcher:Watcher|undefined;
  const current=()=>active&&!signal.aborted&&options.isCurrent();
  function scope():string {
    if(!path.isAbsolute(root))throw new Error('Invalid workspace path.');
    const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)throw new Error('Workspace unavailable.');
    const value=calculateWorkspaceScope({root,channel,directory,db});
    if(establishedScope!==undefined&&value!==establishedScope)throw new Error('Workspace changed.');
    establishedScope=value;return value;
  }
  function savedTheme():UiPreferences['theme'] {
    try {
      const before=scope(),bytes=storage.readPrivateFile(path.join(root,filename),{root,private:true,allowMissing:true,maxBytes:UI_PREFERENCES_LIMITS.fileBytes});
      if(before!==scope())return DEFAULT_UI_PREFERENCES.theme;
      if(bytes===null)return DEFAULT_UI_PREFERENCES.theme;
      const parsed=uiPreferencesDiskSchema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
      return parsed.success&&parsed.data.workspaceScope===before?normalizeUiPreferences(parsed.data.preferences).theme:DEFAULT_UI_PREFERENCES.theme;
    } catch {return DEFAULT_UI_PREFERENCES.theme;}
  }
  function refresh():void {
    if(!current())return;
    const theme=savedTheme(),resolved=theme==='system'?(nativeTheme.shouldUseDarkColors?'dark':'light'):theme;
    if(!current())return;
    background=WINDOW_BACKGROUNDS[resolved];
    for(const window of options.getWindows()) {
      if(!current())return;
      try {if(options.ownsWindow(window)&&!window.isDestroyed())window.setBackgroundColor(background);}
      catch {/* A closed native window cannot prevent other owned windows refreshing. */}
    }
  }
  function dispose():void {
    if(!active)return;
    active=false;watcher?.close();watcher=undefined;nativeTheme.removeListener('updated',refresh);signal.removeEventListener('abort',dispose);
  }
  if(current()) {
    refresh();nativeTheme.on('updated',refresh);signal.addEventListener('abort',dispose,{once:true});
    try {
      // Watch the fixed private directory: atomic companion writes rename the
      // file, so watching an individual inode would lose subsequent updates.
      const watchDirectory=options.watchDirectory??((directory,listener)=>watch(directory,{persistent:false},(_event,name)=>listener(name)));
      watcher=watchDirectory(root,name=>{if(name===null||name.toString()===filename)refresh();});
      watcher.on('error',()=>{if(!active)return;watcher?.close();watcher=undefined;refresh();});
    } catch {/* Creation/activation and OS updates still re-read safely if watching is unavailable. */}
  }
  return Object.freeze({
    backgroundColor():string {refresh();return background;},
    refresh,
    dispose,
  });
}
