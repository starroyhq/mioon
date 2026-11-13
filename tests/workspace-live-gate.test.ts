import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createJsonRequest,liveConfiguration} from '../packages/business/src/providers/live-common.ts';
import {createRunwayProvider} from '../packages/business/src/providers/runway.ts';

test('environment adapters admit credentials independently of retired workspace and environment flags',async t=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-live-gate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const credentials={ARK_API_KEY:'synthetic-key',RUNWAYML_API_SECRET:'synthetic-key'};
 const env={...credentials,MIOON_ENABLE_LIVE_PROVIDER:'0'};
 const configuration=createWorkspaceConfiguration({root,env});
 writeFileSync(path.join(root,'workspace-settings-v1.json'),JSON.stringify({formatVersion:1,revision:4,liveGeneration:false}),{mode:0o600});
 assert.equal(configuration.get().liveGeneration,true);
 let calls=0;
 const request=(environment:NodeJS.ProcessEnv)=>createJsonRequest({api:'https://synthetic.invalid',headers:{},fetchImpl:async()=>{calls++;return new Response('{}');},
  ensureEnabled:liveConfiguration(environment,'ARK_API_KEY','ARK').ensureEnabled,name:'Synthetic'});
 const runway=(environment:NodeJS.ProcessEnv)=>createRunwayProvider({root,env:environment,fetchImpl:async()=>assert.fail('capability reads must never contact a provider')});
 assert.equal(runway(configuration.environment()).capabilities.enabled,true);
 assert.equal(runway({MIOON_ENABLE_LIVE_PROVIDER:'1'}).capabilities.enabled,false);
 await assert.rejects(request({MIOON_ENABLE_LIVE_PROVIDER:'1'})('/task',{method:'POST'}),{code:'PROVIDER_DISABLED'});
 assert.equal(calls,0);
 await request(configuration.environment())('/task',{method:'POST',context:{beforeSubmit:()=>configuration.set({expectedRevision:4,liveGeneration:false})}});
 assert.equal(calls,1);
 env.MIOON_ENABLE_LIVE_PROVIDER='1';
 await request(env)('/task',{method:'POST',context:{beforeSubmit:()=>{env.MIOON_ENABLE_LIVE_PROVIDER='0';}}});
 assert.equal(calls,2);
 const controller=new AbortController();
 await assert.rejects(request(env)('/task',{method:'POST',context:{signal:controller.signal,beforeSubmit:()=>controller.abort()}}),
  {code:'OPERATION_CANCELLED',beforeDispatch:true});
 assert.equal(calls,2);
});
