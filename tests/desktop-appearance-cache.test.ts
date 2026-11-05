import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,renameSync,chmodSync,symlinkSync,linkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDesktopAppearanceCache,DESKTOP_APPEARANCE_CACHE_FILENAME,DESKTOP_APPEARANCE_CACHE_MAX_BYTES} from '../apps/desktop/src/desktop-appearance-cache.ts';
import type {DesktopAppearanceCacheStorage} from '../apps/desktop/src/desktop-appearance-cache.ts';
import {validatePrivateDirectory,validateManagedFile,readPrivateFile,writePrivateFileAtomic} from '../packages/contracts/src/private-storage.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';

function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-appearance-cache-')),dataRoot=path.join(root,'data'),database=path.join(dataRoot,'app-library.db'),file=path.join(root,DESKTOP_APPEARANCE_CACHE_FILENAME),appId='app.starroy.mioon.dev',channel='development' as const;
 mkdirSync(dataRoot,{mode:0o700});writeFileSync(database,'synthetic application library identity',{mode:0o600});let writes=0;
 const storage:DesktopAppearanceCacheStorage={validatePrivateDirectory,validateManagedFile,readPrivateFile:(target,options)=>{assert.equal(target,file,'only the independent cache may be opened');return readPrivateFile(target,options);},writePrivateFileAtomic:(...args)=>{writes++;return writePrivateFileAtomic(...args);}};
 const options={root,dataRoot,appId,channel,storage},cache=createDesktopAppearanceCache(options);
 const scope=()=>calculateWorkspaceScope({root:dataRoot,channel,directory:statSync(dataRoot),db:statSync(database)});
 const record=(theme='light')=>({version:1,appId,channel,appLibraryScope:scope(),theme});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 return {root,dataRoot,database,file,cache,options,scope,record,writes:()=>writes};
}
test('first cache miss is read-only and authenticated rebuilding writes only the strict independent hint',t=>{
 const f=fixture(t),before=readdirSync(f.root);assert.equal(f.cache.read(),null);assert.equal(f.writes(),0);assert.deepEqual(readdirSync(f.root),before);
 assert.equal(f.cache.write('light',f.scope(),()=>true),true);
 assert.deepEqual(JSON.parse(readFileSync(f.file,'utf8')),f.record());assert.ok(readFileSync(f.file).length<=DESKTOP_APPEARANCE_CACHE_MAX_BYTES);assert.equal(statSync(f.file).mode&0o777,0o600);
 assert.equal(readFileSync(f.database,'utf8'),'synthetic application library identity');
 assert.deepEqual(createDesktopAppearanceCache(f.options).read(),{appLibraryScope:f.scope(),theme:'light'},'a separate cold start can use the same application identity');
 assert.equal(f.cache.write('light',f.scope(),()=>true),true);assert.equal(f.writes(),1,'an unchanged hint does not rewrite disk');
 assert.equal(f.cache.write('dark',f.scope(),()=>true),true);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).theme,'dark');
});
test('exact 4 KiB cache byte boundary accepts no oversized entry or extra field',t=>{
 const f=fixture(t),json=JSON.stringify(f.record()),exact=json+' '.repeat(DESKTOP_APPEARANCE_CACHE_MAX_BYTES-Buffer.byteLength(json));
 writeFileSync(f.file,exact,{mode:0o600});assert.equal(f.cache.read()?.theme,'light');
 writeFileSync(f.file,exact+' ');const before=readFileSync(f.file);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);assert.deepEqual(readFileSync(f.file),before);assert.equal(f.writes(),0);
 writeFileSync(f.file,JSON.stringify({...f.record(),preferences:{theme:'light'}}));assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);
});
test('bad UTF8, malformed, unknown versions, invalid values and foreign identities are misses without repair',t=>{
 const f=fixture(t);
 for(const value of ['{',Buffer.from([255]),JSON.stringify({...f.record(),version:2}),JSON.stringify(f.record('sepia')),JSON.stringify({...f.record(),theme:['light']}),JSON.stringify({...f.record(),channel:['development']}),JSON.stringify({...f.record(),appId:'app.other'}),JSON.stringify({...f.record(),channel:'production'}),JSON.stringify({...f.record(),appLibraryScope:'f'.repeat(64)}),JSON.stringify({...f.record(),unexpected:1})]){
  writeFileSync(f.file,value,{mode:0o600});const before=readFileSync(f.file);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);assert.deepEqual(readFileSync(f.file),before);
 }
 assert.equal(f.writes(),0);
});
test('private cache policy preserves symlinks, hard links and unsafe permissions',t=>{
 const f=fixture(t),outside=path.join(f.root,'unrelated.json');writeFileSync(outside,JSON.stringify(f.record()),{mode:0o600});
 symlinkSync(outside,f.file);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);assert.equal(JSON.parse(readFileSync(outside,'utf8')).theme,'light');rmSync(f.file);
 linkSync(outside,f.file);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);assert.equal(JSON.parse(readFileSync(outside,'utf8')).theme,'light');rmSync(f.file);
 writeFileSync(f.file,JSON.stringify(f.record()),{mode:0o600});chmodSync(f.file,0o644);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',f.scope(),()=>true),false);assert.equal(statSync(f.file).mode&0o777,0o644);assert.equal(f.writes(),0);
});
test('replaced application library identity cannot inherit or overwrite this start context',t=>{
 const f=fixture(t);assert.equal(f.cache.write('light',f.scope(),()=>true),true);const bytes=readFileSync(f.file),scope=f.scope();
 renameSync(f.database,f.database+'.old');writeFileSync(f.database,'new identity',{mode:0o600});assert.equal(f.cache.scope(),null);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('dark',scope,()=>true),false);assert.deepEqual(readFileSync(f.file),bytes);
 const restart=createDesktopAppearanceCache(f.options);assert.notEqual(restart.scope(),scope);assert.equal(restart.read(),null);assert.equal(restart.write('dark',restart.scope()!,()=>true),false,'foreign old identity is preserved rather than repaired');assert.deepEqual(readFileSync(f.file),bytes);
});
test('missing application library, stale scope and invalidated owner cannot mint a cache',t=>{
 const f=fixture(t);assert.equal(f.cache.write('light','f'.repeat(64),()=>true),false);assert.equal(f.cache.write('light',f.scope(),()=>false),false);assert.equal(f.writes(),0);
 rmSync(f.database);assert.equal(f.cache.scope(),null);assert.equal(f.cache.read(),null);assert.equal(f.cache.write('light',f.cache.scope()??'',()=>true),false);assert.deepEqual(readdirSync(f.root),['data']);
});
test('owner and library scope are checked again after the cache read before publication',t=>{
 const f=fixture(t);let current=true;
 const storage={...f.options.storage,readPrivateFile:(...args:Parameters<typeof readPrivateFile>)=>{const value=readPrivateFile(...args);current=false;return value;}};
 const cache=createDesktopAppearanceCache({...f.options,storage});assert.equal(cache.write('light',f.scope(),()=>current),false);assert.equal(f.writes(),0);
 const replacing={...f.options.storage,readPrivateFile:(...args:Parameters<typeof readPrivateFile>)=>{const value=readPrivateFile(...args);renameSync(f.database,f.database+'.old');writeFileSync(f.database,'replacement',{mode:0o600});return value;}};
 const replaced=createDesktopAppearanceCache({...f.options,storage:replacing});assert.equal(replaced.write('light',f.scope(),()=>true),false);assert.equal(f.writes(),0);
});
