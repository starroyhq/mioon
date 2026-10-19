import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {createUiPreferences,UI_PREFERENCES_FILENAME} from '../packages/business/src/ui-preferences.ts';
import {DEFAULT_UI_PREFERENCES,uiPreferencesResponseSchema} from '../packages/contracts/src/ui-preferences.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.ts';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'mioon-ui-preferences-')),store=openStore(root),projectId=randomUUID();let readOnly=false;
  const options={root,storage:{readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile},
    guards:{ownsLock:()=>ownsStoreLock(store),isReadOnly:()=>readOnly,hasProject:id=>id===projectId},now:()=> '2026-10-19T01:00:00.000Z'};
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {root,store,projectId,options,service:createUiPreferences(options),file:path.join(root,UI_PREFERENCES_FILENAME),readOnly:value=>{readOnly=value;}};
}
test('workspace preferences are noncreating reads, strictly persisted and independent of project opens',async t=>{
  const f=await fixture(t),before=await readdir(f.root),initial=f.service.get();
  assert.ok(uiPreferencesResponseSchema.safeParse(initial).success);assert.deepEqual(initial.preferences,DEFAULT_UI_PREFERENCES);
  assert.deepEqual(await readdir(f.root),before);
  const input={expectedRevision:0,requestId:randomUUID(),preferences:{...initial.preferences,theme:'system',scalePercent:125,density:'compact',timecodeFormat:'seconds',reduceMotion:true,homeSort:'name',homeView:'list'}};
  const saved=f.service.put(input);assert.equal(saved.revision,1);assert.deepEqual(saved.preferences,input.preferences);
  const bytes=await readFile(f.file);assert.deepEqual(f.service.put(input),saved);assert.deepEqual(await readFile(f.file),bytes);
  f.service.markOpened(f.projectId);assert.equal(f.service.get().revision,1,'navigation does not invalidate an appearance draft');
  assert.equal(f.service.get().recentOpened[f.projectId],'2026-10-19T01:00:00.000Z');
  const restarted=createUiPreferences(f.options);assert.deepEqual(restarted.get(),f.service.get());
  assert.throws(()=>restarted.put({...input,requestId:randomUUID()}),e=>e.code==='UI_PREFERENCES_CONFLICT');
  assert.throws(()=>restarted.put({...input,preferences:{...input.preferences,scalePercent:90}}),e=>e.code==='UI_PREFERENCES_CONFLICT');
  assert.throws(()=>f.service.markOpened(randomUUID()),e=>e.code==='UI_PREFERENCES_VALIDATION');
  restarted.removeProject(f.projectId);assert.deepEqual(restarted.get().recentOpened,{});
  assert.deepEqual(restarted.get().preferences,input.preferences);assert.equal(restarted.get().revision,1);
});
test('invalid stored fields fall back independently without rewriting old preferences',async t=>{
  const f=await fixture(t);f.service.put({expectedRevision:0,requestId:randomUUID(),preferences:{...DEFAULT_UI_PREFERENCES}});
  const disk=JSON.parse(await readFile(f.file,'utf8'));
  disk.preferences={...disk.preferences,scalePercent:999,density:'compact',theme:'contrast',homeSort:'updated'};
  writePrivateFileAtomic(f.file,JSON.stringify(disk),{root:f.root,maxBytes:1024*1024});const before=await readFile(f.file);
  const result=f.service.get();assert.equal(result.recoveredDefaults,true);assert.equal(result.preferences.scalePercent,100);assert.equal(result.preferences.theme,'dark');
  assert.equal(result.preferences.density,'compact');assert.equal(result.preferences.homeSort,'updated');assert.deepEqual(await readFile(f.file),before);
  disk.version=2;writePrivateFileAtomic(f.file,JSON.stringify(disk),{root:f.root,maxBytes:1024*1024});
  assert.throws(()=>f.service.get(),e=>e.code==='UI_PREFERENCES_UNAVAILABLE');
});
test('invalid writes, getters, foreign scope and read-only workspaces cannot mutate the companion',async t=>{
  const f=await fixture(t),good={expectedRevision:0,requestId:randomUUID(),preferences:{...DEFAULT_UI_PREFERENCES}};
  for(const preferences of [{...DEFAULT_UI_PREFERENCES,scalePercent:89},{...DEFAULT_UI_PREFERENCES,scalePercent:125.5},{...DEFAULT_UI_PREFERENCES,theme:'contrast'},{...DEFAULT_UI_PREFERENCES,unknown:true},{...DEFAULT_UI_PREFERENCES,reduceMotion:'false'}])
    assert.throws(()=>f.service.put({...good,preferences}),e=>e.code==='UI_PREFERENCES_VALIDATION');
  let invoked=false;const malicious={...good};Object.defineProperty(malicious,'preferences',{enumerable:true,get(){invoked=true;return good.preferences;}});
  assert.throws(()=>f.service.put(malicious),e=>e.code==='UI_PREFERENCES_VALIDATION');assert.equal(invoked,false);
  f.readOnly(true);assert.equal(f.service.get().writable,false);assert.throws(()=>f.service.put(good),e=>e.code==='UI_PREFERENCES_READ_ONLY');f.readOnly(false);
  f.service.put(good);const disk=JSON.parse(await readFile(f.file,'utf8'));disk.workspaceScope='a'.repeat(64);
  writePrivateFileAtomic(f.file,JSON.stringify(disk),{root:f.root,maxBytes:1024*1024});const before=await readFile(f.file);
  assert.throws(()=>f.service.get(),e=>e.code==='UI_PREFERENCES_SCOPE_MISMATCH');assert.deepEqual(await readFile(f.file),before);
});
test('light, dark and system persist through independent preference readers',async t=>{
  const f=await fixture(t);
  for(const theme of ['light','dark','system']){
    const before=f.service.get();
    const saved=f.service.put({expectedRevision:before.revision,requestId:randomUUID(),preferences:{...before.preferences,theme}});
    assert.equal(saved.preferences.theme,theme);
    assert.equal(createUiPreferences(f.options).get().preferences.theme,theme);
  }
});
