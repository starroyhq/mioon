import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopWindowAppearance,desktopWindowBackground,WINDOW_BACKGROUNDS} from '../apps/desktop/src/window-appearance.ts';
import {createDesktopAppearanceCache,DESKTOP_APPEARANCE_CACHE_FILENAME} from '../apps/desktop/src/desktop-appearance-cache.ts';
import type {DesktopAppearanceTheme} from '../apps/desktop/src/desktop-appearance-cache.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';

interface AppearanceWindow {destroyed:boolean;owned:boolean;colors:string[];isDestroyed():boolean;setBackgroundColor(value:string):void}
const response=(theme:DesktopAppearanceTheme)=>({revision:1,preferences:{...DEFAULT_UI_PREFERENCES,theme},recentOpened:{},recoveredDefaults:false,writable:true});
function fixture(t:TestContext,{cached=null,read=async()=>response('light')}:{cached?:DesktopAppearanceTheme|null;read?:()=>Promise<unknown>}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-native-appearance-')),dataRoot=path.join(root,'data'),db=path.join(dataRoot,'app-library.db'),file=path.join(root,DESKTOP_APPEARANCE_CACHE_FILENAME);
 mkdirSync(dataRoot,{mode:0o700});writeFileSync(db,'synthetic application identity',{mode:0o600});
 const cache=createDesktopAppearanceCache({root,dataRoot,appId:'app.starroy.mioon.dev',channel:'development'});if(cached)assert.equal(cache.write(cached,cache.scope()!,()=>true),true);
 const controller=new AbortController(),nativeTheme=Object.assign(new EventEmitter(),{shouldUseDarkColors:true});
 Object.defineProperty(nativeTheme,'themeSource',{get:()=> 'system',set:()=>assert.fail('Renderer OS queries must not be overridden')});
 const window=():AppearanceWindow=>({destroyed:false,owned:true,colors:[],isDestroyed(){return this.destroyed;},setBackgroundColor(value){this.colors.push(value);}}),windows=[window(),window(),window()];windows[1].destroyed=true;windows[2].owned=false;
 let current=true,calls=0,reader=read;
 const options={cache,nativeTheme,signal:controller.signal,isCurrent:()=>current,getWindows:()=>windows,ownsWindow:(window:AppearanceWindow)=>window.owned,readPreferences:()=>{calls++;return reader();}};
 const appearance=createDesktopWindowAppearance(options);
 t.after(()=>{appearance.dispose();rmSync(root,{recursive:true,force:true});});
 return {root,dataRoot,db,file,cache,controller,nativeTheme,windows,appearance,options,calls:()=>calls,current:(value:boolean)=>{current=value;},read:(value:()=>Promise<unknown>)=>{reader=value;}};
}
test('cold native fill uses only an independent same-library cache and never old preference bytes',async t=>{
 const pending=Promise.withResolvers<unknown>(),f=fixture(t,{cached:'light',read:()=>pending.promise});
 writeFileSync(path.join(f.dataRoot,'ui-preferences-v1.json'),JSON.stringify({preferences:{theme:'dark'}}),{mode:0o600});
 const before=readFileSync(f.file),files=readdirSync(f.root);assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);assert.equal(f.calls(),1);assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readdirSync(f.root),files);
 assert.deepEqual(f.windows[1].colors,[]);assert.deepEqual(f.windows[2].colors,[]);assert.equal(readFileSync(f.db,'utf8'),'synthetic application identity');
 pending.resolve(response('dark'));await f.appearance.ready();assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.dark);assert.equal(f.cache.read()?.theme,'dark');
});
test('a cache miss follows OS color and does not write until authenticated preferences succeed',async t=>{
 const pending=Promise.withResolvers<unknown>(),f=fixture(t,{read:()=>pending.promise});f.nativeTheme.shouldUseDarkColors=false;
 assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);assert.deepEqual(readdirSync(f.root),['data']);
 pending.resolve(response('dark'));await f.appearance.ready();assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.dark);assert.equal(f.cache.read()?.theme,'dark');
});
test('backend failures and invalid responses preserve the last good native theme and cache bytes',async t=>{
 const f=fixture(t,{cached:'light',read:async()=>{throw Error('backend unavailable');}}),before=readFileSync(f.file);
 await f.appearance.ready();assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);await f.appearance.ready();assert.deepEqual(readFileSync(f.file),before);
 f.read(async()=>({preferences:{theme:'dark'}}));await f.appearance.ready();assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.light);assert.deepEqual(readFileSync(f.file),before);
 f.read(async()=>response('dark'));await f.appearance.ready();assert.equal(f.cache.read()?.theme,'dark');
 f.read(async()=>{throw Error('offline again');});await f.appearance.ready();assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.dark);assert.equal(f.cache.read()?.theme,'dark');
});
test('cached and authoritative system themes follow real OS updates without forcing nativeTheme.themeSource',async t=>{
 const f=fixture(t,{cached:'system',read:async()=>response('system')});await f.appearance.ready();assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
 f.nativeTheme.shouldUseDarkColors=false;f.nativeTheme.emit('updated');assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.light);await f.appearance.ready();
 f.read(async()=>response('dark'));await f.appearance.ready();f.nativeTheme.emit('updated');assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.dark);await f.appearance.ready();
});
test('late authenticated reads cannot write cache or update windows after owner replacement, disposal or abort',async t=>{
 for(const kind of ['owner','dispose','abort']as const){
  const pending=Promise.withResolvers<unknown>(),f=fixture(t,{cached:'light',read:()=>pending.promise}),before=readFileSync(f.file),ready=f.appearance.ready(),count=f.windows[0].colors.length,late=f.nativeTheme.listeners('updated')[0];
  if(kind==='owner')f.current(false);else if(kind==='dispose')f.appearance.dispose();else f.controller.abort();
  pending.resolve(response('dark'));await ready;late!();assert.equal(f.windows[0].colors.length,count);assert.deepEqual(readFileSync(f.file),before);
  f.appearance.dispose();assert.equal(f.nativeTheme.listenerCount('updated'),0);
 }
});
test('library identity replacement while authenticated metadata is in flight cannot inherit appearance',async t=>{
 const pending=Promise.withResolvers<unknown>(),f=fixture(t,{cached:'light',read:()=>pending.promise}),before=readFileSync(f.file),ready=f.appearance.ready();
 renameSync(f.db,f.db+'.old');writeFileSync(f.db,'replacement app library',{mode:0o600});pending.resolve(response('dark'));await ready;
 f.nativeTheme.shouldUseDarkColors=false;assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light,'invalid identity uses the current OS, not a backend response');assert.deepEqual(readFileSync(f.file),before);
});
test('bad cache bytes remain untouched even when an authenticated good value controls the native fill',async t=>{
 const f=fixture(t);writeFileSync(f.file,'{',{mode:0o600});await f.appearance.ready();assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.light);assert.equal(readFileSync(f.file,'utf8'),'{');
});
test('native fill helper is usable before backend startup and retains approved token surfaces',()=>{
 assert.equal(desktopWindowBackground('light',{shouldUseDarkColors:true}),WINDOW_BACKGROUNDS.light);assert.equal(desktopWindowBackground(null,{shouldUseDarkColors:false}),WINDOW_BACKGROUNDS.light);assert.equal(desktopWindowBackground('system',{shouldUseDarkColors:true}),WINDOW_BACKGROUNDS.dark);
 const root=new URL('../',import.meta.url),source=readFileSync(new URL('apps/desktop/src/window-appearance.ts',root),'utf8'),main=readFileSync(new URL('apps/desktop/src/main.ts',root),'utf8');
 const dark=readFileSync(new URL('packages/ui/src/styles/globals.css',root),'utf8'),light=readFileSync(new URL('packages/ui/src/styles/light.css',root),'utf8');assert.ok(dark.includes(`--wb-bg: ${WINDOW_BACKGROUNDS.dark}`));assert.ok(light.includes(`--wb-bg: ${WINDOW_BACKGROUNDS.light}`));
 assert.doesNotMatch(source,/ui-preferences-v1\.json|uiPreferencesDiskSchema|watchDirectory|workbench\.sqlite/);assert.doesNotMatch(main,/nativeTheme\.themeSource\s*=/);assert.doesNotMatch(main,/ipcMain\.handle\([^\n]*(?:appearance|theme)/iu);
});
