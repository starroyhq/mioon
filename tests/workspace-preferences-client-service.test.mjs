import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore,createServices,createWorkspacePreferences as createService} from '@mioon/business';
import {createWorkspacePreferences as createClient,durableWorkspaceState} from '../apps/web/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
const copy=value=>structuredClone(value);
async function fixture(t,{workspace={restored:false},loseFirstAck=false}={}){
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'preferences-wire-')),store=openStore(root),services=createServices(store,new Map());
  const project=await services.call('project.create',{name:'Synthetic preference client/service'}),service=createService(store),writes=[],accepted=[];let currentWorkspace=workspace,lost=false;
  const client=createClient({storage:{getItem:()=>null,setItem(){}},getWorkspace:()=>currentWorkspace,requestTimeoutMs:0,delayMs:60000,retryDelays:[],fetchImpl:async(_url,options)=>{
    if(options.method==='GET')return Response.json({ok:true,data:service.get(project.id)});
    const wire=JSON.parse(options.body);writes.push(copy(wire));
    try{
      // The HTTP route separates the origin invocation from the strict domain body.
      const {expectedWorkspaceOrigin,...input}=wire;
      const data=await service.put(project.id,input,expectedWorkspaceOrigin===undefined?{}:{expectedWorkspaceOrigin});accepted.push(copy(data));
      if(loseFirstAck&&!lost){lost=true;throw Object.assign(new Error('Synthetic response lost after commit'),{lostAck:true});}
      return Response.json({ok:true,data});
    }catch(error){if(error.lostAck)throw error;return Response.json({ok:false,error:{code:error.code,message:error.message,details:error.details}},{status:error.status??400});}
  }});
  t.after(async()=>{await client.dispose({flush:false});store.close();await rm(root,{recursive:true,force:true});});
  return{project,client,service,writes,accepted,setWorkspace:value=>{currentWorkspace=value;}};
}
test('the actual preference client sends the strict service DTO and reloads confirmed view changes',async t=>{
  const f=await fixture(t);await f.client.load(f.project.id);const state=defaultWorkspaceState();state.canvas.viewport={x:160,y:316,zoom:1};state.layout.canvas.assetsWidth=288;
  f.client.update(f.project.id,state,{immediate:true});await f.client.flush();
  assert.deepEqual(Object.keys(f.writes[0]).sort(),['expectedRevision','state']);assert.equal(f.client.getStatus(f.project.id).phase,'saved');assert.equal(f.service.get(f.project.id).revision,1);assert.deepEqual(f.service.get(f.project.id).state,durableWorkspaceState(state));
  const reload=await f.client.load(f.project.id,{reload:true});assert.equal(reload.layout.canvas.assetsWidth,288);assert.deepEqual(reload.canvas.viewport,state.canvas.viewport);
});
test('a lost acknowledgment replays the same strict CAS body before saving later view changes through the actual service',async t=>{
  const f=await fixture(t,{loseFirstAck:true});await f.client.load(f.project.id);const first=defaultWorkspaceState();first.editing.playhead=71;f.client.update(f.project.id,first,{immediate:true});await f.client.flush();
  assert.equal(f.client.hasUnsaved(),true);assert.equal(f.service.get(f.project.id).revision,1);
  const second=copy(first);second.editing.playhead=72;f.client.update(f.project.id,second);await f.client.flush();
  assert.deepEqual(f.writes[0],f.writes[1]);assert.deepEqual(Object.keys(f.writes[1]).sort(),['expectedRevision','state']);assert.deepEqual(f.accepted.map(item=>item.revision),[1,1,2]);assert.equal(f.service.get(f.project.id).state.editing.playhead,72);assert.equal(f.client.hasUnsaved(),false);
});
test('origin-pinned queued preference retries project only the original origin and never adopt another restored branch',async t=>{
  const original={restored:true,workspaceOrigin:crypto.randomUUID()},other={restored:true,workspaceOrigin:crypto.randomUUID()},f=await fixture(t,{workspace:original,loseFirstAck:true});await f.client.load(f.project.id);const state=defaultWorkspaceState();state.editing.playhead=85;
  f.client.update(f.project.id,state,{immediate:true,expectedWorkspaceOrigin:original.workspaceOrigin});await f.client.flush();assert.equal(f.service.get(f.project.id).revision,1);
  f.setWorkspace(other);await f.client.flush();assert.equal(f.writes.length,1,'A pending origin is never repinned during another workspace observation');f.setWorkspace(original);await f.client.flush();
  assert.deepEqual(f.writes[0],f.writes[1]);assert.deepEqual(Object.keys(f.writes[1]).sort(),['expectedRevision','expectedWorkspaceOrigin','state']);assert.equal(f.writes[1].expectedWorkspaceOrigin,original.workspaceOrigin);assert.deepEqual(f.accepted.map(item=>item.revision),[1,1]);assert.equal(f.client.hasUnsaved(),false);
});
