import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createJsonRequest,liveConfiguration} from '../packages/business/src/providers/live-common.ts';
import {createRunwayProvider} from '../packages/business/src/providers/runway.ts';
test('persistent live switch changes existing adapters and is checked again immediately before a submission',async t=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-live-gate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const settings=createWorkspaceConfiguration({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'0',ARK_API_KEY:'synthetic-key',RUNWAYML_API_SECRET:'synthetic-key'}}),env=settings.environment(),configuration=liveConfiguration(env,'ARK_API_KEY','ARK');let calls=0;
 const request=createJsonRequest({api:'https://synthetic.invalid',headers:{},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({id:'synthetic-result'}),{status:200});},ensureEnabled:configuration.ensureEnabled,name:'Synthetic'});
 const runway=createRunwayProvider({root,env,fetchImpl:async()=>{throw Error('must not contact a provider');}});
 assert.equal(configuration.enabled,false);assert.equal(runway.capabilities.enabled,false);await assert.rejects(request('/task',{method:'POST'}),{code:'PROVIDER_DISABLED'});assert.equal(calls,0);
 settings.set({expectedRevision:0,liveGeneration:true});assert.equal(configuration.enabled,true);assert.equal(runway.capabilities.enabled,true);await request('/task',{method:'POST'});assert.equal(calls,1);
 await assert.rejects(request('/task',{method:'POST',context:{beforeSubmit:()=>settings.set({expectedRevision:1,liveGeneration:false})}}),{code:'PROVIDER_DISABLED'});assert.equal(calls,1,'revocation in the final submission fence sends no request');
 assert.equal(createWorkspaceConfiguration({root,env:{MIOON_ENABLE_LIVE_PROVIDER:'1'}}).liveEnabled(),false,'restart retains explicit opt-out');
});
