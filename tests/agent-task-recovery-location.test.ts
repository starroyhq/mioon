import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_FIXED_OPTIONS,IMAGE_MODELS,createImageGenerationSession} from '../apps/web/src/image-generation.ts';
import {createFrameExtractionController} from '../apps/web/src/frame-extraction.ts';
import {parseAgentTaskRecoveryLocation,resolveAgentTaskRecoveryLocation} from '../apps/web/src/agent-task-recovery-location.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,projectId=id(1),taskId=id(2),requestId=id(3),groupId=id(4),sourceId=id(5),at='2026-10-22T00:00:00.000Z';
const image=(patch:Record<string,unknown>={})=>({id:taskId,projectId,groupId,requestId,name:'Saved image',prompt:'Saved prompt',providerId:'mock',model:IMAGE_MODELS.mock,options:{...IMAGE_FIXED_OPTIONS},state:'local_result_error',revision:3,dispatched:true,versionId:null,errorCode:'LOCAL_RESULT_ERROR',createdAt:at,updatedAt:at,...patch});
const frame=(patch:Record<string,unknown>={})=>({id:taskId,projectId,requestId,sourceAssetId:sourceId,sourceHash:'a'.repeat(64),sourceFrame:30,fps:30,profileId:'local-png-1024-v1',state:'interrupted',revision:3,started:true,result:null,errorCode:'INTERRUPTED',createdAt:at,updatedAt:at,...patch});
const group=(identity=groupId)=>({id:identity,projectId,name:'Saved group',revision:1,headVersionId:null,activeTaskId:null,createdAt:at,updatedAt:at});
const page=(items:unknown[])=>({projectId,items,nextCursor:null});
function memoryStorage():Storage {const data=new Map<string,string>();return {get length(){return data.size;},clear(){data.clear();},getItem(key){return data.get(key)??null;},key(index){return [...data.keys()][index]??null;},removeItem(key){data.delete(key);},setItem(key,value){data.set(key,value);}};}
function deferred(){let resolve:(value:unknown)=>void=()=>{};const promise=new Promise<unknown>(done=>{resolve=done;});return {promise,resolve};}

test('domain navigation namespaces admit only exact UUID identities',()=>{
  for(const kind of ['image','frame'])for(const suffix of ['', '-request'])assert.deepEqual(parseAgentTaskRecoveryLocation(`${kind}${suffix}:${taskId}`),{kind,identity:suffix?'request':'task',id:taskId});
  for(const value of [undefined,{},taskId,`render:${taskId}`,'image:https://private.example',`image:${taskId}/extra`,`frame-request: ${taskId}`])assert.equal(parseAgentTaskRecoveryLocation(value),null);
});
for(const kind of ['image','frame'] as const)test(`${kind}: original receipt is read before exact current task without submitting or reconciling a provider`,async()=>{
  const calls:{operation:string;input:Record<string,unknown>}[]=[],saved=kind==='image'?image():frame(),ack={...saved,state:'queued',revision:1,...(kind==='image'?{dispatched:false}:{started:false}),errorCode:null};
  const result=await resolveAgentTaskRecoveryLocation({kind,identity:'request',id:requestId},projectId,async(operation,input)=>{calls.push({operation,input});return operation.endsWith('request.get')?{projectId,requestId,operation:kind==='image'?'image.generate':'frame.extract',response:ack}:saved;},()=>true);
  assert.equal(result?.kind,kind);assert.equal(result?.task.id,taskId);assert.equal(result?.task.revision,3);assert.deepEqual(calls.map(call=>call.operation),[`${kind}.request.get`,`${kind}.task.get`]);assert.deepEqual(calls[1]?.input,{projectId,taskId});
  let reads=0;assert.equal(await resolveAgentTaskRecoveryLocation({kind,identity:'request',id:requestId},projectId,async()=>{reads++;return null;},()=>true),null);assert.equal(reads,1);
  assert.equal(await resolveAgentTaskRecoveryLocation({kind,identity:'task',id:taskId},projectId,async()=>({...saved,projectId:id(99)}),()=>true),null);
});
test('late original-record reads cannot navigate after a project, mode or visibility lifetime changes',async()=>{
  for(const phase of ['receipt','task']){
    const pending=deferred();let current=true,reads=0;
    const resolving=resolveAgentTaskRecoveryLocation({kind:'image',identity:phase==='receipt'?'request':'task',id:phase==='receipt'?requestId:taskId},projectId,async()=>{reads++;return pending.promise;},()=>current);
    current=false;pending.resolve(phase==='receipt'?{projectId,requestId,operation:'image.generate',response:image({state:'queued',revision:1,dispatched:false,errorCode:null})}:image());assert.equal(await resolving,null);assert.equal(reads,1);
  }
});
test('image reveal pins an old task and off-page group without changing a manual draft or generation target',async()=>{
  const latestGroup=id(10),latestTask=id(11),calls:string[]=[];
  const session=createImageGenerationSession({projectId,storage:memoryStorage(),setTimer:()=>0,clearTimer:()=>{},api:async(operation,input)=>{
    calls.push(operation);
    if(operation==='image.group.list')return page([group(latestGroup)]);
    if(operation==='image.group.get')return group(String(input.groupId));
    if(operation==='image.task.get')return input.taskId===taskId?image():image({id:latestTask,groupId:latestGroup});
    if(operation==='image.task.list')return page(input.groupId===latestGroup?[image({id:latestTask,groupId:latestGroup})]:[]);
    if(operation==='image.version.list'||operation==='image.review.list')return page([]);
    throw Error('Only local reads are expected');
  }});
  try{
    await session.load();assert.equal(await session.requestTarget(latestGroup),true);session.edit('prompt','Unsaved manual prompt');const before=session.getState();assert.equal(before.target?.groupId,latestGroup);
    assert.equal(await session.revealTask(taskId),true);const shown=session.getState();assert.equal(shown.selectedGroupId,groupId);assert.ok(shown.groups.some(item=>item.id===groupId));assert.ok(shown.tasks.some(item=>item.id===taskId));assert.deepEqual(shown.draft,before.draft);assert.deepEqual(shown.target,before.target);
    await session.load();assert.ok(session.getState().tasks.some(item=>item.id===taskId));assert.ok(calls.every(operation=>operation.endsWith('.get')||operation.endsWith('.list')));
  }finally{session.dispose();}
});
test('image reveal ignores stale reads and frame focus pins the original task across history paging',async()=>{
  const pending=deferred();let current=true;
  const imageSession=createImageGenerationSession({projectId,storage:memoryStorage(),setTimer:()=>0,clearTimer:()=>{},api:async()=>pending.promise});
  try{const reading=imageSession.revealTask(taskId,()=>current);current=false;pending.resolve(image());assert.equal(await reading,false);assert.equal(imageSession.getState().selectedGroupId,null);assert.equal(imageSession.getState().tasks.length,0);}finally{imageSession.dispose();}
  const calls:string[]=[],controller=createFrameExtractionController({rpc:async(operation)=>{calls.push(operation);return operation==='frame.task.get'?frame():page([]);}});
  const configuration={projectId,sourceScope:'source-1',sourceAsset:null,assets:[],visible:true,blocked:false};controller.configure(configuration);
  try{assert.ok(await controller.focusTask(taskId));await controller.refreshTasks();assert.equal(controller.getState().focusedTaskId,taskId);assert.ok(controller.getState().tasks.some(item=>item.id===taskId));assert.deepEqual(controller.getState().sourceAsset,null);assert.ok(calls.every(operation=>operation.endsWith('.get')||operation.endsWith('.list')));}finally{controller.dispose();}
});
test('busy or blocked history waits become revealable without consuming an intent or submitting work',async()=>{
  const pending=deferred(),calls:string[]=[];
  const session=createImageGenerationSession({projectId,storage:memoryStorage(),setTimer:()=>0,clearTimer:()=>{},api:async(operation)=>{calls.push(operation);return operation==='image.group.list'?pending.promise:page([]);}});
  try{const loading=session.load();assert.equal(session.canRevealTask(),false);pending.resolve(page([]));await loading;assert.equal(session.canRevealTask(),true);session.setVisible(false);assert.equal(session.canRevealTask(),false);assert.ok(calls.every(operation=>operation.endsWith('.get')||operation.endsWith('.list')));}finally{session.dispose();}
  const reads:string[]=[],controller=createFrameExtractionController({rpc:async(operation)=>{reads.push(operation);return frame();}});
  try{controller.configure({projectId,sourceScope:'source',sourceAsset:null,assets:[],visible:true,blocked:true});assert.equal(await controller.focusTask(taskId),null);assert.equal(reads.length,0);controller.configure({projectId,sourceScope:'source',sourceAsset:null,assets:[],visible:true,blocked:false});assert.ok(await controller.focusTask(taskId));assert.deepEqual(reads,['frame.task.get']);}finally{controller.dispose();}
});
