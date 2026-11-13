import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createJsonRequest,liveConfiguration} from '../packages/business/src/providers/live-common.ts';
import {createRunwayProvider} from '../packages/business/src/providers/runway.ts';
test('retired preferences cannot enable or disable explicitly provisioned environment adapters',async t=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-live-gate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const credentials={ARK_API_KEY:'synthetic-key',RUNWAYML_API_SECRET:'synthetic-key'};
 const disabled=createWorkspaceConfiguration({root,env:{...credentials,MIOON_ENABLE_LIVE_PROVIDER:'0'}});
 const enabledEnv={...credentials,MIOON_ENABLE_LIVE_PROVIDER:'1'};
 const enabled=createWorkspaceConfiguration({root,env:enabledEnv});
 writeFileSync(path.join(root,'workspace-settings-v1.json'),JSON.stringify({formatVersion:1,revision:4,liveGeneration:false}),{mode:0o600});
 assert.equal(enabled.get().liveGeneration,true);assert.equal(disabled.get().liveGeneration,true);
 let calls=0;
 const request=(env:NodeJS.ProcessEnv)=>createJsonRequest({api:'https://synthetic.invalid',headers:{},fetchImpl:async()=>{calls++;return new Response('{}');},
  ensureEnabled:liveConfiguration(env,'ARK_API_KEY','ARK').ensureEnabled,name:'Synthetic'});
 const runway=createRunwayProvider({root,env:disabled.environment(),fetchImpl:async()=>assert.fail('must not contact a provider')});
 assert.equal(runway.capabilities.enabled,false);
 disabled.set({expectedRevision:4,liveGeneration:true});
 await assert.rejects(request(disabled.environment())('/task',{method:'POST'}),{code:'PROVIDER_DISABLED'});assert.equal(calls,0);
 await request(enabled.environment())('/task',{method:'POST',context:{beforeSubmit:()=>enabled.set({expectedRevision:5,liveGeneration:false})}});
 assert.equal(calls,1);assert.equal(enabled.environment().MIOON_ENABLE_LIVE_PROVIDER,'1');
 // The adapter's own explicit enable switch is still rechecked at dispatch.
 // A synthetic env revocation here is independent of the saved preference.
 await assert.rejects(request(enabledEnv)('/task',{method:'POST',context:{beforeSubmit:()=>{enabledEnv.MIOON_ENABLE_LIVE_PROVIDER='0';}}}),{code:'PROVIDER_DISABLED'});
 assert.equal(calls,1);
});
