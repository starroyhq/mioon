import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTaskSession,agentTaskNewConversationBlock} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskClient,AgentTaskPending,AgentTaskProjectSnapshot,AgentTaskReceiptStore,AgentTaskSessionState} from '../apps/web/src/agent-tasks-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskConversation,AgentTaskConversationPage,AgentTaskControlInput,AgentTaskReceipt,AgentTaskRun,AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createAgentTaskCloseReporter} from '../apps/web/src/native-close-sources.ts';
import {createNativeCloseRegistry,createNativeCloseAdmission} from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';

const id=(value:number)=>`00000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const projectId=id(1),conversationA=id(10),conversationB=id(11),conversationC=id(12),time=Date.parse('2026-10-22T00:00:00.000Z');
const timestamp=(offset:number)=>new Date(time+offset*1000).toISOString();
function snapshot(runId:string,conversationId:string,text:string,offset:number,status:AgentTaskRun['status']='completed',revision=1):AgentTaskSnapshot {
  return {run:{id:runId,conversationId,projectId,requestId:`request-${runId}`,text,status,revision,stepLimit:30,budget:30,stepsUsed:1,configuration:{},createdAt:timestamp(offset),updatedAt:timestamp(offset)},steps:[],changes:[]};
}
function conversation(rounds:AgentTaskSnapshot[]):AgentTaskConversation {
  const first=rounds[0]!.run,last=rounds.at(-1)!.run;
  return {id:first.conversationId!,projectId,title:first.text,createdAt:first.createdAt,updatedAt:last.updatedAt,lastRunId:last.id,lastRunStatus:last.status,runCount:rounds.length,changeCount:rounds.reduce((sum,item)=>sum+item.changes.length,0)};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function acceptedNote(before:AgentTaskSnapshot,input:AgentTaskControlInput):AgentTaskSnapshot {assert.equal(input.action,'note');if(input.action!=='note')throw new Error('Not a note');return {...before,run:{...before.run,revision:before.run.revision+1,notes:[...before.run.notes??[],{requestId:input.requestId,text:input.text,createdAt:timestamp(20)}]}};}
function controlReceipt(input:AgentTaskControlInput,result:AgentTaskReceipt['result']):AgentTaskReceipt{return{requestId:input.requestId,runId:input.runId,action:input.action,revision:input.expectedRevision,result};}
function file(name:string){const bytes=new ArrayBuffer(3);new Uint8Array(bytes).set([1,2,3]);return {name,type:'video/mp4',size:3,arrayBuffer:async()=>bytes.slice(0)};}
function fixture(t:TestContext,initial:AgentTaskSnapshot[]=[],patch:Partial<AgentTaskClient>={},options:{pending?:AgentTaskPending;authorized?:boolean;recentRuns?:AgentTaskRun[];onChange?:(state:AgentTaskSessionState)=>void}={}){
  const runs=new Map(initial.map(value=>[value.run.id,structuredClone(value)])),receipts=new Map<string,AgentTaskPending>();
  if(options.pending)receipts.set(projectId,options.pending);
  const store:AgentTaskReceiptStore={read:key=>receipts.get(key)??null,write(key,value){if(value)receipts.set(key,value);else receipts.delete(key);}};
  let authorized=options.authorized!==false,uploadSerial=100;
  const posts:{send:Parameters<AgentTaskClient['send']>[1][];action:Parameters<AgentTaskClient['action']>[1][];upload:Parameters<AgentTaskClient['upload']>[1][];authorize:number}={send:[],action:[],upload:[],authorize:0};
  const reads:{run:string[];conversation:{id:string;cursor:string|null}[];lookup:AgentTaskPending[]}={run:[],conversation:[],lookup:[]};
  const project=():AgentTaskProjectSnapshot=>({version:2,instanceId:id(2),projectId,runs:options.recentRuns??[...runs.values()].map(value=>value.run).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),policy:structuredClone(DEFAULT_AGENT_TASK_POLICY),authorization:{revision:authorized?2:1,scopes:authorized?['project_agent']:[]},settings:{revision:0,configuration:{presetId:'openai',platformId:'global',baseUrl:'https://example.invalid/v1',model:'synthetic',protocol:'responses'},secret:{configured:false,storage:'none'},storage:{persistentAvailable:false,sessionScope:'server',reasonCode:null},presets:[],scope:'settings_only',verification:'not_tested'}});
  const defaults:AgentTaskClient={
    list:async()=>project(),
    history:async()=>{const grouped=new Map<string,AgentTaskSnapshot[]>();for(const value of runs.values()){const key=value.run.conversationId!;grouped.set(key,[...grouped.get(key)??[],value]);}return {conversations:[...grouped.values()].map(conversation),nextCursor:null};},
    conversation:async(_,key)=>{const rounds=[...runs.values()].filter(value=>value.run.conversationId===key);if(!rounds.length)throw new Error('No synthetic conversation');return {conversation:conversation(rounds),runs:rounds.map(value=>value.run),nextCursor:null};},
    read:async(_,key)=>{const value=runs.get(key);if(!value)throw new Error('No synthetic run');return structuredClone(value);},
    send:async()=>{throw new Error('Unexpected model submission');},
    action:async()=>{throw new Error('Unexpected control submission');},
    lookup:async()=>({found:false}),
    upload:async(_,input)=>({id:id(uploadSerial++),name:input.name,mimeType:input.mimeType,status:'staged'}),
    authorize:async()=>{authorized=true;},
    stream:async(_,__,___,signal)=>{if(signal.aborted)return;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));},
    policy:async()=>({policy:structuredClone(DEFAULT_AGENT_TASK_POLICY),readOnly:false}),
    savePolicy:async input=>({policy:{revision:input.revision,stepLimit:input.stepLimit,modes:input.modes},readOnly:false}),
    lookupPolicy:async()=>({found:false,readOnly:false}),
    conversationPolicy: async (projectId, conversationId) => ({policy:{projectId,conversationId,revision:0,override:null,global:structuredClone(DEFAULT_AGENT_TASK_POLICY),effective:structuredClone(DEFAULT_AGENT_TASK_POLICY.modes)},readOnly:false}), setConversationPolicy: async (projectId, conversationId, input) => ({policy:{projectId,conversationId,revision:input.expectedRevision+1,override:input.modes,global:structuredClone(DEFAULT_AGENT_TASK_POLICY),effective:structuredClone(input.modes??DEFAULT_AGENT_TASK_POLICY.modes)},readOnly:false}),
  };
  const methods:AgentTaskClient={...defaults,...patch};
  const client:AgentTaskClient={...methods,
    read:async(project,key)=>{reads.run.push(key);return methods.read(project,key);},
    conversation:async(project,key,cursor=null)=>{reads.conversation.push({id:key,cursor});return methods.conversation(project,key,cursor);},
    lookup:async(project,pending)=>{reads.lookup.push(structuredClone(pending));return methods.lookup(project,pending);},
    send:async(project,input)=>{posts.send.push(structuredClone(input));const value=await methods.send(project,input);runs.set(value.run.id,structuredClone(value));return value;},
    action:async(project,input)=>{posts.action.push(structuredClone(input));const value=await methods.action(project,input);runs.set(value.run.id,structuredClone(value));return value;},
    upload:async(project,input)=>{posts.upload.push(structuredClone(input));return methods.upload(project,input);},
    authorize:async(value,requestId)=>{posts.authorize++;return methods.authorize(value,requestId);},
  };
  const session=createAgentTaskSession({projectId,client,receipts:store,getLocale:()=> 'en',onChange:options.onChange});t.after(()=>session.dispose());
  return {session,runs,receipts,posts,reads,project,client};
}

test('new conversation is local until first send and later sends use only the server-assigned identity',async t=>{
  const a=snapshot(id(20),conversationA,'Existing first message',1);let sends=0;
  const f=fixture(t,[a],{send:async(_,input)=>snapshot(id(30+sends++),conversationB,input.text,10+sends)});
  await f.session.load();f.session.edit('Unsent original draft');assert.equal(f.session.newConversation(),true);
  assert.deepEqual(f.session.getState().rounds,[]);assert.equal(f.session.getState().snapshot,null);assert.equal(f.session.getState().conversationId,null);
  assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,0);assert.equal(f.posts.upload.length,0);assert.equal(f.posts.authorize,0);
  f.session.edit('First message in the new conversation');assert.equal(await f.session.send(),true);
  assert.equal(Object.hasOwn(f.posts.send[0]!,'conversationId'),false);assert.equal(f.session.getState().conversationId,conversationB);
  f.session.edit('A follow-up');assert.equal(await f.session.send(),true);
  assert.equal(f.posts.send[1]?.conversationId,conversationB);assert.equal(f.session.getState().rounds.length,2);assert.equal(f.session.getState().conversation?.title,'First message in the new conversation');
  assert.equal(await f.session.selectConversation(conversationA),true);assert.equal(f.session.getState().draft,'Unsent original draft');
});

test('conversation selection loads every page and preserves server order despite clock reversal',async t=>{
  const rounds=[snapshot(id(40),conversationA,'The first title',3),snapshot(id(41),conversationA,'Second message',1),snapshot(id(42),conversationA,'Third message',2)],metadata=conversation(rounds);
  const f=fixture(t,rounds,{conversation:async(_,key,cursor=null)=>{assert.equal(key,conversationA);return {conversation:metadata,runs:cursor?[rounds[2]!.run]:[rounds[0]!.run,rounds[1]!.run],nextCursor:cursor?null:'later-page'};}},{recentRuns:[rounds[2]!.run]});
  await f.session.load();assert.deepEqual(f.session.getState().rounds.map(value=>value.run.id),rounds.map(value=>value.run.id));assert.equal(f.session.getState().conversation?.title,'The first title');
  assert.deepEqual(f.reads.conversation,[{id:conversationA,cursor:null},{id:conversationA,cursor:'later-page'}]);assert.equal(f.posts.send.length,0);
});

test('conversation drafts and selected files restore into their own buckets',async t=>{
  const a=snapshot(id(50),conversationA,'Conversation A',1),b=snapshot(id(51),conversationB,'Conversation B',2),f=fixture(t,[a,b]);await f.session.load();
  await f.session.selectConversation(conversationA);f.session.edit('Draft only for A');assert.equal(await f.session.upload(file('a.mp4')),true);const uploadedA=f.session.getState().uploads[0]!.id;
  await f.session.selectConversation(conversationB);assert.equal(f.session.getState().draft,'');assert.deepEqual(f.session.getState().uploads,[]);f.session.edit('Draft only for B');assert.equal(await f.session.upload(file('b.mp4')),true);const uploadedB=f.session.getState().uploads[0]!.id;
  await f.session.selectConversation(conversationA);assert.equal(f.session.getState().draft,'Draft only for A');assert.deepEqual(f.session.getState().uploads.map(value=>value.id),[uploadedA]);
  await f.session.selectConversation(conversationB);assert.equal(f.session.getState().draft,'Draft only for B');assert.deepEqual(f.session.getState().uploads.map(value=>value.id),[uploadedB]);assert.notEqual(uploadedA,uploadedB);assert.equal(f.posts.send.length,0);
});

test('approval cards and stale approval handlers cannot cross a conversation selection',async t=>{
  const a=snapshot(id(60),conversationA,'Conversation A',1),b=snapshot(id(61),conversationB,'Needs a decision',2,'awaiting_approval'),stepId=id(62);
  b.steps=[{id:stepId,runId:b.run.id,position:1,kind:'tool',status:'awaiting_approval',createdAt:b.run.createdAt,updatedAt:b.run.updatedAt,tier:'read_only',approvalRequired:true,toolCall:{id:'synthetic-read',name:'mioon_project_inspect',arguments:{projectId}}}];
  const f=fixture(t,[a,b]);await f.session.load();assert.equal(f.session.getState().snapshot?.steps[0]?.id,stepId);assert.equal(agentTaskNewConversationBlock(f.session.getState()),'running');assert.equal(f.session.newConversation(),false);
  await f.session.selectConversation(conversationA);assert.ok(f.session.getState().rounds.every(value=>value.run.conversationId===conversationA));assert.ok(f.session.getState().rounds.every(value=>value.steps.length===0));
  assert.equal(await f.session.action('approve',{stepId},b.run.id),false);assert.equal(f.posts.action.length,0);
});

test('a late conversation read cannot replace a newer selection or its new draft',async t=>{
  const a=snapshot(id(70),conversationA,'Conversation A',1),b=snapshot(id(71),conversationB,'Conversation B',2),c=snapshot(id(72),conversationC,'Conversation C',3),held=deferred<AgentTaskConversationPage>();
  const f=fixture(t,[a,b,c],{conversation:async(_,key)=>key===conversationB?held.promise:{conversation:conversation(key===conversationA?[a]:[c]),runs:[key===conversationA?a.run:c.run],nextCursor:null}});await f.session.load();
  const old=f.session.selectConversation(conversationB);assert.equal(f.session.getState().phase,'loading');assert.equal(await f.session.selectConversation(conversationC),true);f.session.edit('Keep this latest draft');
  held.resolve({conversation:conversation([b]),runs:[b.run],nextCursor:null});assert.equal(await old,false);assert.equal(f.session.getState().conversationId,conversationC);assert.equal(f.session.getState().draft,'Keep this latest draft');assert.deepEqual(f.session.getState().rounds.map(value=>value.run.id),[c.run.id]);
});

test('closing history cancels a pending selection and a late read cannot replace the current draft',async t=>{
  const a=snapshot(id(73),conversationA,'Conversation A',1),b=snapshot(id(74),conversationB,'Conversation B',2),held=deferred<AgentTaskConversationPage>();
  const f=fixture(t,[a,b],{conversation:async(_,key)=>key===conversationB?held.promise:{conversation:conversation([a]),runs:[a.run],nextCursor:null}},{recentRuns:[a.run]});await f.session.load();f.session.edit('Keep the current draft');
  const selecting=f.session.selectConversation(conversationB);assert.equal(f.session.getState().phase,'loading');f.session.cancelSelection();assert.equal(f.session.getState().phase,'ready');
  held.resolve({conversation:conversation([b]),runs:[b.run],nextCursor:null});assert.equal(await selecting,false);assert.equal(f.session.getState().conversationId,conversationA);assert.equal(f.session.getState().draft,'Keep the current draft');assert.deepEqual(f.session.getState().rounds.map(value=>value.run.id),[a.run.id]);assert.equal(f.posts.send.length,0);
});

test('stale input and attachment callbacks cannot change another selected conversation',async t=>{
  const a=snapshot(id(76),conversationA,'Conversation A',1),b=snapshot(id(77),conversationB,'Conversation B',2),f=fixture(t,[a,b]);await f.session.load();await f.session.selectConversation(conversationA);const staleKey=f.session.getState().selectionKey;f.session.edit('Draft A');
  await f.session.selectConversation(conversationB);f.session.edit('Draft B');assert.equal(await f.session.upload(file('belongs-to-b.mp4')),true);const selectedUpload=f.session.getState().uploads[0]!.id;
  f.session.edit('Stale A keystroke',staleKey);f.session.removeUpload(selectedUpload,staleKey);assert.equal(await f.session.upload(file('stale-a-file.mp4'),staleKey),false);
  assert.equal(f.session.getState().draft,'Draft B');assert.deepEqual(f.session.getState().uploads.map(value=>value.id),[selectedUpload]);assert.equal(f.posts.upload.length,1);
  f.session.edit('Current B keystroke',f.session.getState().selectionKey);f.session.removeUpload(selectedUpload,f.session.getState().selectionKey);assert.equal(f.session.getState().draft,'Current B keystroke');assert.deepEqual(f.session.getState().uploads,[]);
  await f.session.selectConversation(conversationA);assert.equal(f.session.getState().draft,'Draft A');assert.equal(f.posts.send.length,0);
});

test('a mismatched conversation read fails closed while retaining the selected conversation draft',async t=>{
  const a=snapshot(id(75),conversationA,'Conversation A',1),f=fixture(t,[a],{conversation:async()=>({conversation:conversation([a]),runs:[a.run],nextCursor:null})});await f.session.load();f.session.edit('Keep the selected draft');
  assert.equal(await f.session.selectConversation(conversationB),false);assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().conversationId,conversationA);assert.equal(f.session.getState().draft,'Keep the selected draft');assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,0);
});

test('file selection during a pending conversation lookup cannot attach a file to the destination',async t=>{
  const a=snapshot(id(80),conversationA,'Conversation A',1),b=snapshot(id(81),conversationB,'Conversation B',2),held=deferred<AgentTaskConversationPage>();
  const f=fixture(t,[a,b],{conversation:async(_,key)=>key===conversationB?held.promise:{conversation:conversation([a]),runs:[a.run],nextCursor:null}},{recentRuns:[a.run]});await f.session.load();
  const selecting=f.session.selectConversation(conversationB);assert.equal(await f.session.upload(file('belongs-to-a.mp4')),false);assert.equal(f.posts.upload.length,0);
  held.resolve({conversation:conversation([b]),runs:[b.run],nextCursor:null});assert.equal(await selecting,true);assert.deepEqual(f.session.getState().uploads,[]);
});

test('an unresolved send blocks new conversation and only queries its stable receipt',async t=>{
  const a=snapshot(id(90),conversationA,'Conversation A',1),f=fixture(t,[a],{send:async()=>{throw new Error('lost response');}});await f.session.load();f.session.edit('Send once');assert.equal(await f.session.send(),false);const pending=f.session.getState().pending;assert.ok(pending);
  assert.equal(f.session.newConversation(),false);assert.equal(await f.session.selectConversation(conversationB),false);for(let n=0;n<3;n++)assert.equal(await f.session.reconcile(),false);
  assert.equal(f.posts.send.length,1);assert.equal(f.posts.action.length,0);assert.deepEqual(f.reads.lookup,[pending,pending,pending]);assert.equal(f.session.getState().draft,'Send once');assert.deepEqual(f.session.getState().pending,pending);
});

for(const action of ['send','approve'] as const)test(`restoring a second-round ${action} receipt restores the first round and original title without replay`,async t=>{
  const a=snapshot(id(110),conversationA,'The original title',1),b=snapshot(id(111),conversationA,'Second-round request',2,'completed',3),pending:AgentTaskPending={requestId:id(112),runId:action==='send'?null:b.run.id,action,conversationId:conversationA};
  const f=fixture(t,[a,b],{lookup:async()=>({found:true,snapshot:b})},{pending});await f.session.load();
  assert.deepEqual(f.session.getState().rounds.map(value=>value.run.id),[a.run.id,b.run.id]);assert.equal(f.session.getState().conversation?.title,'The original title');assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().phase,'ready');assert.equal(f.reads.lookup.length,1);assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,0);
});

test('a failed history GET after a confirmed receipt remains a read error and later reload does not query or replay the write',async t=>{
  const a=snapshot(id(120),conversationA,'Original title',1),b=snapshot(id(121),conversationA,'Second round',2),pending:AgentTaskPending={requestId:id(122),runId:b.run.id,action:'approve',conversationId:conversationA};let fail=true;
  const f=fixture(t,[a,b],{lookup:async()=>({found:true,snapshot:b}),conversation:async()=>{if(fail)throw new Error('offline history');return {conversation:conversation([a,b]),runs:[a.run,b.run],nextCursor:null};}},{pending});await f.session.load();
  assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().snapshot?.run.id,b.run.id);fail=false;await f.session.load();
  assert.deepEqual(f.session.getState().rounds.map(value=>value.run.id),[a.run.id,b.run.id]);assert.equal(f.reads.lookup.length,1);assert.equal(f.posts.action.length,0);assert.equal(f.posts.send.length,0);
});

test('a confirmed newer receipt is not downgraded by older conversation reads',async t=>{
  const a=snapshot(id(130),conversationA,'Original title',1),old=snapshot(id(131),conversationA,'Second round',2,'completed',1),latest={...old,run:{...old.run,revision:5}},pending:AgentTaskPending={requestId:id(132),runId:old.run.id,action:'approve',conversationId:conversationA};
  const f=fixture(t,[a,old],{lookup:async()=>({found:true,snapshot:latest})},{pending});await f.session.load();assert.equal(f.session.getState().rounds[1]?.run.revision,5);assert.equal(f.session.getState().snapshot?.run.revision,5);assert.equal(f.posts.action.length,0);
});

for(const content of ['draft','attachment'] as const)test(`hidden ${content} in another conversation still needs native close confirmation`,async t=>{
  const registry=createNativeCloseRegistry(),reporter=createAgentTaskCloseReporter(registry),a=snapshot(id(140),conversationA,'Conversation A',1),b=snapshot(id(141),conversationB,'Conversation B',2);
  const f=fixture(t,[a,b],{},{onChange:state=>reporter.publish(state)});reporter.publish(f.session.getState());
  const admission=createNativeCloseAdmission({registry,settings:createSettingsNavigationRegistry(),readScope:()=>projectId,readDocumentURL:()=>`http://127.0.0.1/?project=${projectId}`,now:()=>1000});t.after(()=>{reporter.release();admission.dispose();});await f.session.load();await f.session.selectConversation(conversationA);
  if(content==='draft')f.session.edit('LOCAL_PRIVATE_DRAFT_SENTINEL');else assert.equal(await f.session.upload(file('private-source.mp4')),true);
  await f.session.selectConversation(conversationB);assert.equal(f.session.getState().draft,'');assert.deepEqual(f.session.getState().uploads,[]);assert.equal(f.session.getState().draftDirty,true);f.session.setVisible(false);
  const ticket=admission.inspect();assert.equal(ticket.disposition,'dirty');assert.equal(admission.commit(ticket.token,{discardDirty:false,allowDrainFailure:false,expiresAt:1500}),false);assert.doesNotMatch(JSON.stringify(registry.capture()),/LOCAL_PRIVATE_DRAFT_SENTINEL|private-source/u);assert.equal(f.posts.send.length,0);
});

test('an unknown round remains a native close and new-conversation barrier after selecting a completed conversation',async t=>{
  const unknown=snapshot(id(150),conversationA,'Unresolved older run',1,'interrupted'),done=snapshot(id(151),conversationB,'Completed conversation',2);unknown.steps=[{id:id(152),runId:unknown.run.id,position:1,kind:'model',status:'unknown',createdAt:unknown.run.createdAt,updatedAt:unknown.run.updatedAt}];
  const registry=createNativeCloseRegistry(),reporter=createAgentTaskCloseReporter(registry),f=fixture(t,[unknown,done],{},{recentRuns:[done.run],onChange:state=>reporter.publish(state)});reporter.publish(f.session.getState());
  const admission=createNativeCloseAdmission({registry,settings:createSettingsNavigationRegistry(),readScope:()=>projectId,readDocumentURL:()=>`http://127.0.0.1/?project=${projectId}`,now:()=>1000});t.after(()=>{reporter.release();admission.dispose();});await f.session.load();await f.session.selectConversation(conversationA);await f.session.selectConversation(conversationB);assert.equal(f.session.newConversation(),false);f.session.setVisible(false);
  assert.equal(f.session.getState().snapshot?.run.status,'completed');assert.equal(f.session.getState().unknownOutcome,true);assert.equal(agentTaskNewConversationBlock(f.session.getState()),'interrupted');assert.equal(admission.inspect().disposition,'blocked');assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,0);
});

for(const hidden of [false,true])test(`an unknown result in a terminal ${hidden?'hidden':'selected'} conversation blocks send and approval review until explicitly resolved`,async t=>{
  const unknown=snapshot(id(153),conversationA,'Terminal unknown result',1,'stopped'),done=snapshot(id(154),conversationB,'Completed conversation',2),stepId=id(155);
  unknown.steps=[{id:stepId,runId:unknown.run.id,position:1,kind:'model',status:'unknown',createdAt:unknown.run.createdAt,updatedAt:unknown.run.updatedAt}];
  const resolved={...unknown,run:{...unknown.run,revision:2},steps:[{...unknown.steps[0]!,status:'rejected' as const}]};let submitted=0;
  const f=fixture(t,[unknown,done],{action:async(_,input)=>{assert.equal(input.action,'resolve_unknown');assert.equal(input.stepId,stepId);assert.equal(input.resolution,'discard');return resolved;},send:async(_,input)=>snapshot(id(156+submitted++),conversationA,input.text,3),lookup:async()=>({found:true,snapshot:resolved})});
  await f.session.load();await f.session.selectConversation(conversationA);if(hidden)await f.session.selectConversation(conversationB);f.session.edit('Continue only after explicit resolution');
  assert.equal(f.session.authorizationReview(),null);assert.equal(await f.session.send(),false);assert.equal(f.posts.send.length,0);assert.equal(f.posts.authorize,0);assert.equal(agentTaskNewConversationBlock(f.session.getState()),'interrupted');
  if(hidden)await f.session.selectConversation(conversationA);assert.equal(await f.session.action('resolve_unknown',{stepId,resolution:'discard'},unknown.run.id),true);assert.equal(f.session.getState().unknownOutcome,false);f.session.edit('A deliberate follow-up after resolution');assert.ok(f.session.authorizationReview());assert.equal(await f.session.send(),true);assert.equal(f.posts.send.length,1);
});

for(const hidden of [false,true])test(`a completed ${hidden?'hidden':'selected'} conversation with background work blocks new dialogue and send until a durable read confirms completion`,async t=>{
  const waiting={...snapshot(id(157),conversationA,'Completed model with background work',1),backgroundPending:true},done=snapshot(id(158),conversationB,'Another completed conversation',2),f=fixture(t,[waiting,done],{send:async(_,input)=>snapshot(id(159),conversationA,input.text,3)});
  await f.session.load();await f.session.selectConversation(conversationA);if(hidden)await f.session.selectConversation(conversationB);f.session.edit('Wait for the background result');
  assert.equal(f.session.getState().backgroundPending,true);assert.equal(agentTaskNewConversationBlock(f.session.getState()),'running');assert.equal(f.session.newConversation(),false);assert.equal(f.session.authorizationReview(),null);assert.equal(await f.session.send(),false);assert.equal(f.posts.send.length,0);
  f.runs.set(waiting.run.id,{...waiting,run:{...waiting.run,revision:2},backgroundPending:false});await f.session.selectConversation(conversationA);assert.equal(f.session.getState().backgroundPending,false);assert.equal(agentTaskNewConversationBlock(f.session.getState()),null);f.session.edit('Continue after the durable background completion');assert.ok(f.session.authorizationReview());assert.equal(await f.session.send(),true);assert.equal(f.posts.send.length,1);
});

test('a first-send authorization review from another conversation cannot authorize or send its draft',async t=>{
  const a=snapshot(id(160),conversationA,'Conversation A',1),b=snapshot(id(161),conversationB,'Conversation B',2),f=fixture(t,[a,b],{send:async(_,input)=>snapshot(id(162),conversationB,input.text,3)},{authorized:false});await f.session.load();await f.session.selectConversation(conversationA);f.session.edit('Draft A');const review=f.session.authorizationReview();assert.ok(review);assert.equal(review.conversationId,conversationA);
  await f.session.selectConversation(conversationB);f.session.edit('Draft B');assert.equal(await f.session.authorizeAndSend(review),false);assert.equal(f.posts.authorize,0);assert.equal(f.posts.send.length,0);assert.equal(f.session.getState().draft,'Draft B');
  const current=f.session.authorizationReview();assert.ok(current);assert.equal(await f.session.authorizeAndSend(current),true);assert.equal(f.posts.authorize,1);assert.equal(f.posts.send.length,1);assert.equal(f.posts.send[0]?.conversationId,conversationB);assert.equal(f.posts.send[0]?.text,'Draft B');
});

for(const status of ['running','awaiting_approval','paused'] as const)test(`a ${status} round accepts a note without sending a new round or consuming staged attachments`,async t=>{
  const a=snapshot(id(180),conversationA,'The active request',1,status,4),f=fixture(t,[a],{action:async(_,input)=>acceptedNote(a,input)});
  await f.session.load();assert.equal(await f.session.upload(file('next-round.mp4')),true);const uploads=f.session.getState().uploads;
  f.session.edit('Keep the title A/B, and do not change its timing.');assert.equal(await f.session.note(),true);
  assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,1);const input=f.posts.action[0]!;assert.equal(input.action,'note');assert.equal(input.runId,a.run.id);assert.equal(input.expectedRevision,4);
  assert.ok(input.requestId.length>=8);assert.equal('text'in input&&input.text,'Keep the title A/B, and do not change its timing.');assert.equal(Object.hasOwn(input,'uploads'),false);assert.equal(Object.hasOwn(input,'conversationId'),false);
  assert.equal(f.session.getState().conversationId,conversationA);assert.equal(f.session.getState().rounds.length,1);assert.equal(f.session.getState().draft,'');assert.deepEqual(f.session.getState().uploads,uploads);assert.equal(f.session.getState().snapshot?.run.notes?.[0]?.requestId,input.requestId);assert.equal(f.session.getState().pending,null);
});

for(const editedText of ['A later instruction','The submitted instruction'] as const)test(`note acknowledgement preserves a draft edited while in flight (${editedText})`,async t=>{
  const a=snapshot(id(181),conversationA,'An active request',1,'running',2),held=deferred<AgentTaskSnapshot>(),f=fixture(t,[a],{action:async()=>held.promise});await f.session.load();f.session.edit('The submitted instruction');
  const writing=f.session.note();assert.equal(await f.session.note(),false);assert.equal(await f.session.send(),false);assert.equal(await f.session.selectConversation(conversationB),false);assert.equal(f.posts.action.length,1);
  f.session.edit('Intermediate text');f.session.edit(editedText);held.resolve(acceptedNote(a,f.posts.action[0]!));assert.equal(await writing,true);assert.equal(f.session.getState().draft,editedText);assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,1);
});

test('a lost note response only looks up the original operation, clears the exact draft on evidence and keeps its attachments',async t=>{
  const a=snapshot(id(182),conversationA,'An active request',1,'running',2);let durable:AgentTaskSnapshot|undefined,receipt:AgentTaskReceipt|undefined,ready=false;
  const f=fixture(t,[a],{action:async(_,input)=>{durable=acceptedNote(a,input);receipt=controlReceipt(input,{state:'completed',noteRequestId:input.requestId});f.runs.set(a.run.id,durable);throw new Error('Lost acknowledgement');},lookup:async()=>ready?{found:true,snapshot:durable,receipt}:{found:false}});
  await f.session.load();await f.session.upload(file('keep.mp4'));const uploads=f.session.getState().uploads;f.session.edit('Use two short captions');assert.equal(await f.session.note(),false);const pending=f.session.getState().pending;assert.ok(pending);assert.equal(pending.action,'note');assert.equal(await f.session.reconcile(),false);assert.equal(f.session.getState().draft,'Use two short captions');ready=true;
  assert.equal(await f.session.reconcile(),true);assert.equal(f.posts.action.length,1);assert.equal(f.posts.send.length,0);assert.deepEqual(f.reads.lookup,[pending,pending]);assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().draft,'');assert.deepEqual(f.session.getState().uploads,uploads);assert.equal(f.session.getState().snapshot?.run.notes?.length,1);
});

test('a lost note acknowledgement does not consume a later draft while its original receipt is queried',async t=>{
  const a=snapshot(id(183),conversationA,'An active request',1,'paused',2);let durable:AgentTaskSnapshot|undefined;
  const f=fixture(t,[a],{action:async(_,input)=>{durable=acceptedNote(a,input);f.runs.set(a.run.id,durable);throw new Error('Lost acknowledgement');},lookup:async()=>({found:true,snapshot:durable})});await f.session.load();f.session.edit('The saved note');assert.equal(await f.session.note(),false);f.session.edit('Another unsent note');assert.equal(await f.session.reconcile(),true);
  assert.equal(f.session.getState().draft,'Another unsent note');assert.equal(f.session.getState().snapshot?.run.notes?.[0]?.text,'The saved note');assert.equal(f.posts.action.length,1);assert.equal(f.posts.send.length,0);
});

test('a confirmed note consumes its captured draft even when later conversation refresh fails, and reload only reads',async t=>{
  const a=snapshot(id(190),conversationA,'An active request',1,'running',2);let durable:AgentTaskSnapshot|undefined,failRead=false;
  const f=fixture(t,[a],{action:async(_,input)=>{durable=acceptedNote(a,input);f.runs.set(a.run.id,durable);throw new Error('Lost acknowledgement');},lookup:async()=>({found:true,snapshot:durable}),conversation:async()=>{if(failRead)throw new Error('Synthetic conversation read failure');const value=durable??a;return{conversation:conversation([value]),runs:[value.run],nextCursor:null};}});await f.session.load();f.session.edit('Save this instruction once');assert.equal(await f.session.note(),false);failRead=true;assert.equal(await f.session.reconcile(),false);
  assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().draft,'');failRead=false;await f.session.load();assert.equal(f.session.getState().phase,'ready');assert.equal(f.reads.lookup.length,1);assert.equal(f.posts.action.length,1);assert.equal(f.posts.send.length,0);
});

for(const code of ['AGENT_TASK_NOTE_LIMIT','AGENT_TASK_NOTE_CAPACITY'])test(`a rejected ${code} note receipt preserves its draft, attachments and localized error code`,async t=>{
  const a=snapshot(id(184),conversationA,'An active request',1,'awaiting_approval',2);let receipt:AgentTaskReceipt|undefined;
  const f=fixture(t,[a],{action:async(_,input)=>{receipt=controlReceipt(input,{state:'rejected',code});throw Object.assign(new Error('Synthetic queue rejection'),{code,definitive:true});},lookup:async()=>({found:true,snapshot:a,receipt})});await f.session.load();await f.session.upload(file('keep.mp4'));const uploads=f.session.getState().uploads;f.session.edit('Do not lose this rejected instruction');assert.equal(await f.session.note(),false);
  assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().phase,'ready');assert.equal(f.session.getState().error,code);assert.equal(f.session.getState().draft,'Do not lose this rejected instruction');assert.deepEqual(f.session.getState().uploads,uploads);assert.equal(f.session.getState().snapshot?.run.notes?.length??0,0);assert.equal(f.reads.lookup.length,1);assert.equal(f.posts.action.length,1);assert.equal(f.posts.send.length,0);
});

test('a server-completed note race refreshes the original round and only a later explicit send starts another round',async t=>{
  const a=snapshot(id(185),conversationA,'An active request',1,'running',2),done={...a,run:{...a.run,status:'completed' as const,revision:3}};let receipt:AgentTaskReceipt|undefined;
  const f=fixture(t,[a],{action:async(_,input)=>{f.runs.set(a.run.id,done);receipt=controlReceipt(input,{state:'rejected',code:'AGENT_TASK_STATE'});throw Object.assign(new Error('Already completed'),{code:'AGENT_TASK_STATE',definitive:true});},lookup:async()=>({found:true,snapshot:done,receipt}),send:async(_,input)=>snapshot(id(186),conversationA,input.text,4)});await f.session.load();f.session.edit('A note submitted at completion');assert.equal(await f.session.note(),false);
  assert.equal(f.session.getState().snapshot?.run.status,'completed');assert.equal(f.session.getState().draft,'A note submitted at completion');assert.equal(f.session.getState().error,'AGENT_TASK_STATE');assert.equal(f.posts.send.length,0);assert.equal(f.posts.action.length,1);assert.equal(f.session.getState().pending,null);
  assert.equal(await f.session.send(),true);assert.equal(f.posts.send.length,1);assert.equal(f.posts.send[0]?.conversationId,conversationA);assert.equal(f.posts.send[0]?.text,'A note submitted at completion');assert.notEqual(f.posts.send[0]?.requestId,f.posts.action[0]?.requestId);assert.equal(f.session.getState().rounds.length,2);
});

test('a note acknowledgement without matching persisted note evidence stays unknown and is never replayed',async t=>{
  const a=snapshot(id(187),conversationA,'An active request',1,'running',2),f=fixture(t,[a],{action:async()=>a,lookup:async()=>({found:true,snapshot:a})});await f.session.load();f.session.edit('Require durable note evidence');assert.equal(await f.session.note(),false);assert.equal(f.session.getState().phase,'unknown');const pending=f.session.getState().pending;assert.ok(pending);assert.equal(await f.session.reconcile(),false);assert.equal(f.session.getState().draft,'Require durable note evidence');assert.deepEqual(f.session.getState().pending,pending);assert.equal(f.posts.action.length,1);assert.equal(f.posts.send.length,0);
});

for(const action of ['skip','note'] as const)test(`a restored ${action} receipt is queried once without replaying the control`,async t=>{
  const a=snapshot(id(188),conversationA,'The original request',1,'running',3),pending:AgentTaskPending={requestId:id(189),runId:a.run.id,action,conversationId:conversationA};if(action==='note')a.run.notes=[{requestId:pending.requestId,text:'A saved instruction',createdAt:timestamp(2)}];
  const f=fixture(t,[a],{lookup:async()=>({found:true,snapshot:a})},{pending});await f.session.load();assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().phase,'ready');assert.equal(f.reads.lookup.length,1);assert.equal(f.posts.action.length,0);assert.equal(f.posts.send.length,0);assert.equal(f.session.getState().conversationId,conversationA);
});
