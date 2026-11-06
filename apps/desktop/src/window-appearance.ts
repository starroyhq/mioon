import {uiPreferencesResponseSchema} from '../../../packages/contracts/src/ui-preferences.ts';
import type {DesktopAppearanceCache,DesktopAppearanceTheme} from './desktop-appearance-cache.ts';

export const WINDOW_BACKGROUNDS=Object.freeze({dark:'#0B0C0E',light:'#F6F6F6'});
interface Window {isDestroyed():boolean;setBackgroundColor(color:string):void}
interface Theme {
 readonly shouldUseDarkColors:boolean;
 on(event:'updated',listener:()=>void):unknown;
 removeListener(event:'updated',listener:()=>void):unknown;
}
interface Options<W extends Window> {
 cache:DesktopAppearanceCache;nativeTheme:Theme;signal:AbortSignal;
 /** Only an authenticated backend port may supply authoritative preferences. */
 readPreferences():Promise<unknown>;
 isCurrent():boolean;getWindows():readonly W[];ownsWindow(window:W):boolean;
}
/** Also usable by backend-before-start tool/progress windows. A cache miss
 * follows the current OS appearance rather than a saved preference default. */
export function desktopWindowBackground(theme:DesktopAppearanceTheme|null|undefined,nativeTheme:Pick<Theme,'shouldUseDarkColors'>):string {
 return WINDOW_BACKGROUNDS[!theme||theme==='system'?(nativeTheme.shouldUseDarkColors?'dark':'light'):theme];
}
/** Native fill only. The renderer and its OS media query remain authoritative;
 * nativeTheme.themeSource is never modified. */
export function createDesktopWindowAppearance<W extends Window>(options:Options<W>) {
 const {cache,nativeTheme,signal}=options,initial=cache.read();
 let active=true,appTheme:DesktopAppearanceTheme=initial?.theme??'system',themeScope:string|null=initial?.appLibraryScope??null,reading:Promise<void>|undefined;
 let background=desktopWindowBackground(appTheme,nativeTheme);
 const current=()=>active&&!signal.aborted&&options.isCurrent();
 function apply():void {
  if(!current())return;
  const scope=cache.scope();
  background=desktopWindowBackground(scope!==null&&scope===themeScope?appTheme:'system',nativeTheme);
  for(const window of options.getWindows()){
   if(!current())return;
   try{if(options.ownsWindow(window)&&!window.isDestroyed())window.setBackgroundColor(background);}catch{/* A closed native window cannot block the remaining owned windows. */}
  }
 }
 function readPreferences():Promise<void> {
  if(!current())return Promise.resolve();if(reading)return reading;
  reading=(async()=>{
   const before=cache.scope();if(!before)return;
   try{
    const parsed=uiPreferencesResponseSchema.safeParse(await options.readPreferences());
    if(!current()||cache.scope()!==before||!parsed.success)return;
    appTheme=parsed.data.preferences.theme;themeScope=before;
    cache.write(appTheme,before,current);
   }catch{/* Keep the last good cache/authority value when the backend fails. */}
   if(current())apply();
  })().finally(()=>{reading=undefined;});
  return reading;
 }
 function refresh():void {if(!current())return;apply();void readPreferences();}
 function dispose():void {if(!active)return;active=false;nativeTheme.removeListener('updated',refresh);signal.removeEventListener('abort',dispose);}
 if(current()){apply();nativeTheme.on('updated',refresh);signal.addEventListener('abort',dispose,{once:true});}
 return Object.freeze({backgroundColor():string{refresh();return background;},refresh,ready:readPreferences,dispose});
}
