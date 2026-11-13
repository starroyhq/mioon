import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {TestContext} from 'node:test';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {workspaceConfigurationSchemas,workspaceSettingsSchema,workspaceSettingsUpdateSchema} from '../packages/contracts/src/workspace-configuration.ts';

const FILE='workspace-settings-v1.json';
const retired=['liveGeneration','automaticBackup','backupIntervalHours','backupLocation','backupDirectory','selectedDirectory'] as const;
const code=(expected:string)=>(error:unknown)=>(error as {code?:string})?.code===expected;
function fixture(t:TestContext,source:'app'|'file'='app') {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-live-settings-'));
  const library=openAppLibrary({dataDir:root}),file=path.join(root,FILE);
  const documents=source==='app'?library.documents:undefined;
  const env={MIOON_ENABLE_LIVE_PROVIDER:'0',SYNTHETIC_PRIVATE_SECRET:'not-public'};
  const configuration=createWorkspaceConfiguration({root,env,...(documents?{documents}:{})});
  t.after(()=>{library.close();fs.rmSync(root,{recursive:true,force:true});});
  const read=()=>documents?documents.read(FILE):fs.readFileSync(file,'utf8');
  const write=(text:string)=>{if(documents)documents.write(FILE,text);else fs.writeFileSync(file,text,{mode:0o600});};
  return {root,library,configuration,documents,env,read,write};
}

test('legacy workspace RPC keeps the revision without changing adapter admission or persisting the retired flag',t=>{
  const f=fixture(t),before=process.env.MIOON_ENABLE_LIVE_PROVIDER,environment=f.configuration.environment();
  assert.deepEqual(f.configuration.get(),{formatVersion:1,revision:0,liveGeneration:true});
  assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER,'0');
  const saved=f.configuration.set({expectedRevision:0,liveGeneration:true});
  assert.deepEqual(saved,{formatVersion:1,revision:1,liveGeneration:true});
  assert.equal(f.configuration.environment().MIOON_ENABLE_LIVE_PROVIDER,'0');
  assert.equal(process.env.MIOON_ENABLE_LIVE_PROVIDER,before);
  assert.throws(()=>f.configuration.set({expectedRevision:0,liveGeneration:false}),code('WORKSPACE_SETTINGS_CONFLICT'));
  const reopened=createWorkspaceConfiguration({root:f.root,env:{MIOON_ENABLE_LIVE_PROVIDER:'1'},documents:f.library.documents});
  assert.deepEqual(reopened.get(),saved);
  assert.deepEqual(reopened.set({expectedRevision:1,liveGeneration:false}),{formatVersion:1,revision:2,liveGeneration:true});
  assert.equal(reopened.environment().MIOON_ENABLE_LIVE_PROVIDER,'1');
  assert.doesNotMatch(JSON.stringify(saved),/not-public|SYNTHETIC_PRIVATE_SECRET/);
  assert.deepEqual(JSON.parse(String(f.read())),{formatVersion:1,revision:2});
});

test('public settings reject all retired keys and arbitrary paths without accepting old backup operations',()=>{
  assert.deepEqual(Object.keys(workspaceConfigurationSchemas).sort(),['workspace.settings.get','workspace.settings.set']);
  for(const key of retired.filter(key=>key!=='liveGeneration')){
    assert.equal(workspaceSettingsUpdateSchema.safeParse({expectedRevision:0,liveGeneration:true,[key]:'/tmp/arbitrary'}).success,false,key);
    assert.equal(workspaceSettingsSchema.safeParse({formatVersion:1,revision:0,liveGeneration:true,[key]:'/tmp/arbitrary'}).success,false,key);
  }
  assert.equal(workspaceSettingsUpdateSchema.safeParse({expectedRevision:0}).success,false);
  assert.equal(workspaceSettingsUpdateSchema.safeParse({expectedRevision:0,liveGeneration:undefined}).success,false);
  assert.equal(workspaceSettingsUpdateSchema.safeParse({expectedRevision:0,liveGeneration:true,unknown:true}).success,false);
  assert.equal(workspaceSettingsUpdateSchema.safeParse({expectedRevision:0,liveGeneration:true}).success,true);
});

test('retired setting names are ignored on read and never reach the next saved document',t=>{
  for(const source of ['app','file'] as const){
    const f=fixture(t,source),old=JSON.stringify({formatVersion:1,revision:7,liveGeneration:false,
      automaticBackup:{unusable:'discard'},backupIntervalHours:'discard',backupLocation:null,
      backupDirectory:'/synthetic/do-not-create',selectedDirectory:'../../do-not-follow'});
    f.write(old);const files=fs.readdirSync(f.root).sort();
    assert.deepEqual(f.configuration.get(),{formatVersion:1,revision:7,liveGeneration:true});
    assert.equal(f.read(),old,'read must not acknowledge an unsolicited persistence rewrite');
    assert.deepEqual(fs.readdirSync(f.root).sort(),files,'retired directory values have no filesystem effect');
    const result=f.configuration.set({expectedRevision:7,liveGeneration:false});
    assert.deepEqual(result,{formatVersion:1,revision:8,liveGeneration:true});
    assert.deepEqual(JSON.parse(String(f.read())),{formatVersion:1,revision:8});
    assert.doesNotMatch(String(f.read()),/automaticBackup|backupIntervalHours|backupLocation|backupDirectory|selectedDirectory|do-not-/);
  }
});

test('each retired key can be read independently but unrelated keys and malformed current fields remain INVALID',t=>{
  for(const source of ['app','file'] as const){
    const f=fixture(t,source),current={formatVersion:1,revision:2};
    for(const key of retired){f.write(JSON.stringify({...current,[key]:null}));assert.deepEqual(f.configuration.get(),{...current,liveGeneration:true},key);}
    for(const key of ['unknown','backupDirectories','selectedDirectoryExtra','__proto__','constructor']){
      const raw=JSON.stringify({...current,[key]:true});f.write(raw);
      assert.throws(()=>f.configuration.get(),code('WORKSPACE_SETTINGS_INVALID'),key);
      assert.equal(f.read(),raw,'refused settings remain untouched');
    }
    for(const patch of [{formatVersion:2},{revision:-1},{revision:1.5}]){
      const raw=JSON.stringify({...current,...patch});f.write(raw);
      assert.throws(()=>f.configuration.get(),code('WORKSPACE_SETTINGS_INVALID'));assert.equal(f.read(),raw);
    }
  }
});

test('stale or invalid setting updates cannot clean up a legacy document or notify listeners',t=>{
  const f=fixture(t),raw=JSON.stringify({formatVersion:1,revision:3,liveGeneration:false,selectedDirectory:'discard'});f.write(raw);
  let notifications=0;const unsubscribe=f.configuration.subscribe(()=>notifications++);
  assert.throws(()=>f.configuration.set({expectedRevision:2,liveGeneration:true}),code('WORKSPACE_SETTINGS_CONFLICT'));
  assert.equal(f.read(),raw);assert.equal(notifications,0);
  assert.throws(()=>f.configuration.set({expectedRevision:3,liveGeneration:'true'} as never));
  assert.equal(f.read(),raw);assert.equal(notifications,0);
  f.configuration.set({expectedRevision:3,liveGeneration:true});assert.equal(notifications,1);unsubscribe();
  f.configuration.set({expectedRevision:4,liveGeneration:false});assert.equal(notifications,1);
  assert.deepEqual(JSON.parse(String(f.read())),{formatVersion:1,revision:5});
});
