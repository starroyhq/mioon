import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,renameSync,rmSync,readdirSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopWindowAppearance,WINDOW_BACKGROUNDS} from '../apps/desktop/src/window-appearance.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import {readPrivateFile,validatePrivateDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.ts';

function fixture(t,{realWatch=false}={}) {
  const root=mkdtempSync(path.join(tmpdir(),'mioon-native-appearance-')),db=path.join(root,'workbench.sqlite'),file=path.join(root,'ui-preferences-v1.json');
  writeFileSync(db,'synthetic identity only',{mode:0o600});
  const storage={readPrivateFile,validatePrivateDirectory,validateManagedFile},controller=new AbortController();
  const nativeTheme=Object.assign(new EventEmitter(),{shouldUseDarkColors:true});
  Object.defineProperty(nativeTheme,'themeSource',{get:()=> 'system',set:()=>assert.fail('Renderer OS queries must not be overridden')});
  const window=()=>({destroyed:false,owned:true,colors:[],isDestroyed(){return this.destroyed;},setBackgroundColor(value){this.colors.push(value);}});
  const windows=[window(),window(),window()];windows[1].destroyed=true;windows[2].owned=false;
  let current=true,notification,closed=0;
  const watcher=Object.assign(new EventEmitter(),{close(){closed++;}});
  const scope=()=>calculateWorkspaceScope({root,channel:'development',directory:statSync(root),db:statSync(db)});
  const record=theme=>({version:1,workspaceScope:scope(),revision:1,preferences:{...DEFAULT_UI_PREFERENCES,theme},recentOpened:{}});
  const save=theme=>writeFileSync(file,JSON.stringify(record(theme)),{mode:0o600});
  const options={root,channel:'development',storage,nativeTheme,signal:controller.signal,isCurrent:()=>current,
    getWindows:()=>windows,ownsWindow:window=>window.owned,
    ...(!realWatch?{watchDirectory:(directory,listener)=>{assert.equal(directory,root);notification=listener;return watcher;}}:{})};
  const appearance=createDesktopWindowAppearance(options);
  t.after(()=>{appearance.dispose();rmSync(root,{recursive:true,force:true});});
  return {root,db,file,scope,record,save,nativeTheme,appearance,windows,watcher,controller,options,
    notify:name=>notification(name),notification:()=>notification,closed:()=>closed,current:value=>{current=value;}};
}

test('fixed saved sidecar controls only native fill and never writes files or forces OS appearance',t=>{
  const f=fixture(t);assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
  f.save('light');const before=readFileSync(f.file),files=readdirSync(f.root);
  f.notify('ui-preferences-v1.json');assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);
  assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readdirSync(f.root),files);
  assert.equal(readFileSync(f.db,'utf8'),'synthetic identity only');
  assert.equal(f.nativeTheme.themeSource,'system');assert.deepEqual(f.windows[1].colors,[]);assert.deepEqual(f.windows[2].colors,[]);
});

test('saved system appearance follows real OS updates while explicit light and dark stay fixed',t=>{
  const f=fixture(t);f.save('system');assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
  f.nativeTheme.shouldUseDarkColors=false;f.nativeTheme.emit('updated');assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.light);
  f.save('dark');f.notify(null);assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
  f.save('light');f.notify(Buffer.from('ui-preferences-v1.json'));f.nativeTheme.shouldUseDarkColors=true;f.nativeTheme.emit('updated');
  assert.equal(f.windows[0].colors.at(-1),WINDOW_BACKGROUNDS.light);
});

test('missing, bad, unknown-version, invalid-theme and foreign-scope sidecars fall back without repair',t=>{
  const f=fixture(t);
  const malformed=['{',Buffer.from([0xff]),JSON.stringify({...f.record('light'),version:2}),JSON.stringify({...f.record('light'),workspaceScope:'a'.repeat(64)}),JSON.stringify(f.record('sepia'))];
  for(const bytes of malformed){writeFileSync(f.file,bytes,{mode:0o600});const before=readFileSync(f.file);assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);assert.deepEqual(readFileSync(f.file),before);}
  const recovered=f.record('light');recovered.preferences.scalePercent=999;writeFileSync(f.file,JSON.stringify(recovered),{mode:0o600});
  assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light,'invalid unrelated legacy fields normalize independently');
  rmSync(f.file);assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
});

test('private storage rejects symlink and oversized sidecars and pins the existing workspace database identity',t=>{
  const f=fixture(t),target=path.join(f.root,'unrelated.json');writeFileSync(target,JSON.stringify(f.record('light')),{mode:0o600});symlinkSync(target,f.file);
  assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);rmSync(f.file);
  writeFileSync(f.file,'x'.repeat(1024*1024+1),{mode:0o600});assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark);
  f.save('light');assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);
  renameSync(f.db,f.db+'.previous');writeFileSync(f.db,'replacement',{mode:0o600});f.save('light');
  assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.dark,'new inode cannot acquire this start context');
});

test('unrelated directory events do not apply and late watcher or OS callbacks cannot cross context, disposal or abort',t=>{
  for(const invalidation of ['context','dispose','abort']){
    const f=fixture(t),lateWatch=f.notification(),lateTheme=f.nativeTheme.listeners('updated')[0];f.save('light');
    const before=f.windows[0].colors.length;f.notify('other-preferences.json');assert.equal(f.windows[0].colors.length,before);
    if(invalidation==='context')f.current(false);else if(invalidation==='dispose')f.appearance.dispose();else f.controller.abort();
    lateWatch('ui-preferences-v1.json');lateTheme();assert.equal(f.windows[0].colors.length,before);
    if(invalidation!=='context'){assert.equal(f.nativeTheme.listenerCount('updated'),0);assert.equal(f.closed(),1);}
    f.appearance.dispose();assert.equal(f.closed(),1);
  }
});

test('watch errors stop their watcher; safe creation refresh remains available and skips newly destroyed windows',t=>{
  const f=fixture(t);f.watcher.emit('error');assert.equal(f.closed(),1);
  f.save('light');assert.equal(f.appearance.backgroundColor(),WINDOW_BACKGROUNDS.light);
  f.windows[0].destroyed=true;const count=f.windows[0].colors.length;f.save('dark');f.nativeTheme.emit('updated');assert.equal(f.windows[0].colors.length,count);
});

test('actual directory watch survives repeated atomic sidecar replacement without mutating the workspace',async t=>{
  const f=fixture(t,{realWatch:true});
  const until=async color=>{const deadline=Date.now()+3000;while(f.windows[0].colors.at(-1)!==color&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.windows[0].colors.at(-1),color);};
  for(const theme of ['light','dark','light']){
    const staging=path.join(f.root,'.appearance.pending');writeFileSync(staging,JSON.stringify(f.record(theme)),{mode:0o600});renameSync(staging,f.file);await until(WINDOW_BACKGROUNDS[theme]);
  }
  assert.deepEqual(readdirSync(f.root).sort(),['ui-preferences-v1.json','workbench.sqlite']);
});

test('native fills match the approved token surfaces and main keeps theme IPC and native overrides absent',()=>{
  const root=new URL('../',import.meta.url),main=readFileSync(new URL('apps/desktop/src/main.ts',root),'utf8');
  const dark=readFileSync(new URL('packages/ui/src/styles/globals.css',root),'utf8'),light=readFileSync(new URL('packages/ui/src/styles/light.css',root),'utf8');
  assert.ok(dark.includes(`--wb-bg: ${WINDOW_BACKGROUNDS.dark}`));assert.ok(light.includes(`--wb-bg: ${WINDOW_BACKGROUNDS.light}`));
  assert.match(main,/backgroundColor: context\.appearance\.backgroundColor\(\)/);
  assert.doesNotMatch(main,/nativeTheme\.themeSource\s*=/);assert.doesNotMatch(main,/ipcMain\.handle\([^\n]*(?:appearance|theme)/i);
});
