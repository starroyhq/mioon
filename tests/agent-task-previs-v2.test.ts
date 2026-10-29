import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {AGENT_TASK_OPERATION_ADMISSION,createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {agentTaskToolGroupForName} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {projectAgentTaskChangeDisplay,projectAgentTaskStepDisplay} from '../packages/business/src/agent/task-display-v2.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {defaultPrevisScene,previsFramedElements,previsLookAt,roundPrevisNumber} from '@mioon/contracts';
import type {PrevisNodeRecord,PrevisScene} from '@mioon/contracts';
import type {AgentTaskChange,AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';

type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// A canvas-style JPEG container (see tests/previs.test.ts); only the container is checked.
const jpeg=(width:number,height:number):Buffer=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00]),
 Buffer.from([0xff,0xc0,0x00,0x11,0x08,height>>8,height&255,width>>8,width&255,0x03,0x01,0x22,0x00,0x02,0x11,0x01,0x03,0x11,0x01]),
 Buffer.from([0xff,0xda,0x00,0x0c,0x03,0x01,0x00,0x02,0x11,0x03,0x11,0x00,0x3f,0x00,0x12,0x34,0xff,0xd9])]);
const eye=(focalLength:number,x=0,z=4)=>({position:[x,1.6,z] as [number,number,number],yaw:0,pitch:-4,focalLength});
async function fixture(t:TestContext){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-task-previs-')),store=openStore(root),services=createServices(store,new Map());
 const call=async<T=Row>(operation:string,input:unknown):Promise<T>=>await services.call(operation,input) as T;
 const projectId=(await call<{id:string}>('project.create',{name:'Previs tools'})).id;
 const journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services});
 const run=journal.create({requestId:randomUUID(),projectId,text:'synthetic previs task',configuration:{}}).run;
 t.after(async()=>{tools.dispose();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const name=(operation:string)=>tools.list().find(tool=>tool.operation===operation)!.name;
 async function execute(operation:string,input:Row){
  const prepared=tools.prepare({projectId,operation:name(operation),input});
  const step=journal.beginStep(run.id,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:name(operation),arguments:JSON.parse(JSON.stringify(input)) as AgentTaskJson}});
  journal.markDispatch(run.id,step.id);
  const outcome=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,beforeEffect:()=>journal.assertTargets(projectId,prepared.targets),
   recordInside:(result,changes)=>journal.completeStepInside(run.id,step.id,{result,changes}),appendChangesInside:changes=>journal.appendChangesInside(run.id,step.id,changes)});
  if(!outcome.recorded)journal.completeStep(run.id,step.id,{result:outcome.result,changes:outcome.changes});
  return {result:journal.step(step.id).result,changes:journal.snapshot(run.id).changes.filter(change=>change.stepId===step.id),stepId:step.id};
 }
 const undo=(change:AgentTaskChange)=>tools.undo(change,{beforeEffect:()=>{},recordInside:item=>{journal.markChangeRevertedInside(item.id);},retainInside:(item,reason)=>{journal.markChangeRetainedInside(item.id,reason);}});
 async function asset():Promise<string>{
  const bytes=await renderMockImagePng({width:64,height:96}),id=randomUUID(),relativePath=`media/${id}.png`;
  store.put('assets',{id,projectId,name:'K1.png',mimeType:'image/png',provenance:'user-import',sha256:createHash('sha256').update(bytes).digest('hex'),width:64,height:96,sizeBytes:bytes.length,relativePath,url:`/media/${id}`,createdAt:new Date().toISOString()});
  await writeFile(path.join(root,relativePath),bytes,{mode:0o600});return id;
 }
 const node=(id:string)=>store.get('nodes',id) as PrevisNodeRecord;
 const save=(current:PrevisNodeRecord,scene:PrevisScene)=>call<PrevisNodeRecord>('previs.scene.set',{projectId,nodeId:current.id,expectedSceneRevision:current.sceneRevision,scene,requestId:randomUUID()});
 const thumbnail=(current:PrevisNodeRecord,slot:string)=>call('previs.thumbnail.set',{projectId,nodeId:current.id,slot,sceneRevision:current.sceneRevision,dataBase64:jpeg(216,384).toString('base64')});
 const slots=async(current:PrevisNodeRecord)=>(await call<{items:{slot:string}[]}>('previs.thumbnail.get',{projectId,nodeId:current.id,slots:['card',...current.scene.keyframes.map(item=>item.id),'k1','k2','k3'].filter((slot,index,all)=>all.indexOf(slot)===index)})).items.map(item=>item.slot);
 // A rainy corner: 林夏 at the origin, 周屿 holding an umbrella beside her, a shop door behind.
 async function rainyCorner(){
  const created=await call<PrevisNodeRecord>('previs.create',{projectId,label:'雨夜街口',position:{x:40,y:60},requestId:randomUUID()}),image=await asset();
  const scene:PrevisScene={...defaultPrevisScene(),
   figures:[{id:'f1',name:'林夏',visible:true,position:[0,0,0],rotation:0,pose:'stand',held:null},{id:'f2',name:'周屿',visible:true,position:[0.8,0,-1.2],rotation:-35,pose:'hold',held:{propId:'p1',hand:'right'}}],
   props:[{id:'p1',kind:'umbrella',name:'伞',visible:true,position:[0,0,0],rotation:0,size:[1,0.9,1]},{id:'p2',kind:'panel',name:'便利店门',visible:true,position:[-3,0,-6],rotation:0,size:[1.2,2.1,0.05]}],
   keyframes:[{id:'k1',name:'',camera:eye(24),exports:[image]},{id:'k2',name:'',camera:eye(85,0.8,1.5),exports:[]}],activeKeyframeId:'k1'};
  const saved=await save(created,scene);
  const shot=await call<{id:string;revision:number}>('shot.create',{projectId,title:'周屿撑伞等候'});
  await call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{referenceAssetIds:[image]},requestId:randomUUID()});
  return {node:saved,image,shotId:shot.id};
 }
 return {store,services,call,projectId,journal,tools,run,execute,undo,asset,node,save,thumbnail,slots,rainyCorner};
}
/** Mio's view of a scene: what it reads is what it writes back. */
const modelScene=(scene:PrevisScene)=>({figures:scene.figures,props:scene.props,light:scene.light,camera:scene.camera,keyframes:scene.keyframes.map(({id,name,camera})=>({id,name,camera})),activeKeyframeId:scene.activeKeyframeId});
function walk(value:unknown,visit:(item:Row)=>void):void{if(Array.isArray(value)){for(const item of value)walk(item,visit);return;}if(!record(value))return;visit(value);for(const item of Object.values(value))walk(item,visit);}

test('Mio previs tools are canvas tools with reviewed tiers and parameters every provider accepts',async t=>{
 const f=await fixture(t),tools=f.tools.list(),find=(name:string)=>tools.find(tool=>tool.name===name);
 assert.deepEqual(['mioon_previs_inspect','mioon_previs_create','mioon_previs_scene_set'].map(name=>[find(name)?.risk,agentTaskToolGroupForName(name)]),
  [['read_only','canvas'],['local_irreversible','canvas'],['local_reversible','canvas']]);
 assert.equal(tools.some(tool=>tool.operation.startsWith('previs.thumbnail.')),false);
 for(const operation of ['previs.thumbnail.set','previs.thumbnail.get'])assert.equal((AGENT_TASK_OPERATION_ADMISSION as Record<string,{allowed:boolean}>)[operation]?.allowed,false);
 const parameters=find('mioon_previs_scene_set')!.parameters;
 walk(parameters,item=>{
  assert.equal(Array.isArray(item.items),false,'arrays use one item schema, never a tuple');
  if(record(item.properties))for(const field of ['exports','schemaVersion','projectId','requestId'])assert.equal(Object.hasOwn(item.properties,field),false,field);
  if(typeof item.pattern==='string')assert.doesNotMatch(item.pattern,/\\u[dD][89a-fA-F]/u,'no surrogate range patterns');
 });
 assert.match(find('mioon_previs_scene_set')!.description,/米、度、毫米/u);
 assert.deepEqual(find('mioon_previs_inspect')!.parameters,{type:'object',properties:{nodeId:{type:'string',format:'uuid'}},required:['nodeId'],additionalProperties:false});
});

test('inspect reads a scene without host fields and estimates what each camera frames',async t=>{
 const f=await fixture(t),{node,image,shotId}=await f.rainyCorner();
 const {result,changes}=await f.execute('previs.inspect',{nodeId:node.id});
 assert.deepEqual(changes,[]);assert.ok(record(result));
 const aspect=1080/1920,framed=(camera:PrevisScene['camera'])=>previsFramedElements(node.scene,camera,aspect);
 assert.deepEqual(result,{nodeId:node.id,label:'雨夜街口',revision:node.revision,sceneRevision:node.sceneRevision,frame:{width:1080,height:1920,ratio:'9:16'},
  scene:modelScene(node.scene),framing:{camera:framed(node.scene.camera),keyframes:[
   {id:'k1',label:'K1',...framed(node.scene.keyframes[0]!.camera),exportedImages:1,shotFrames:[{shotId,frame:'first'}]},
   {id:'k2',label:'K2',...framed(node.scene.keyframes[1]!.camera),exportedImages:0,shotFrames:[]}]}});
 assert.equal(JSON.stringify(result).includes(image),false,'exported image IDs stay with the host');
 assert.deepEqual(framed(node.scene.keyframes[0]!.camera),{figures:['f1','f2'],props:['p1','p2']},'the wide keyframe frames everyone');
 assert.deepEqual(framed(node.scene.keyframes[1]!.camera).figures,['f2'],'the close keyframe frames 周屿 only');
 const text=await f.call<{id:string}>('node.create',{projectId:f.projectId,type:'text',text:'雨夜',position:{x:0,y:0},requestId:randomUUID()});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_inspect',input:{nodeId:text.id}}),{code:'PREVIS_NODE_REQUIRED'});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_inspect',input:{nodeId:node.id,slots:['card']}}),{code:'VALIDATION_ERROR'});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_inspect',input:{nodeId:node.id,projectId:f.projectId}}),{code:'AGENT_TASK_INVALID_TOOL'});
 const other=await f.call<{id:string}>('project.create',{name:'Other'}),foreign=await f.call<PrevisNodeRecord>('previs.create',{projectId:other.id,position:{x:0,y:0},requestId:randomUUID()});
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_inspect',input:{nodeId:foreign.id}}),{code:'AGENT_TASK_INVALID_TARGET'});
 const skipped:Array<{kind:string;id:string}>=[];
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_inspect',input:{nodeId:node.id},beforeTargetRead:target=>{skipped.push(target);throw Object.assign(Error('skipped'),{code:'AGENT_TASK_TARGET_SKIPPED'});}}),{code:'AGENT_TASK_TARGET_SKIPPED'});
 assert.deepEqual(skipped,[{kind:'node',id:node.id}]);
});

test('a scene write keeps exports by keyframe ID, aims lookAt cameras, rounds numbers and reads back like inspect',async t=>{
 const f=await fixture(t),{node,image}=await f.rainyCorner();
 await f.thumbnail(node,'card');await f.thumbnail(node,'k1');await f.thumbnail(node,'k2');
 const scene=modelScene(node.scene),target:[number,number,number]=[0.4,1.2,-0.6];
 const written={...scene,
  figures:scene.figures.map(item=>item.id==='f1'?{...item,position:[-0.123456,0,0.98765] as [number,number,number]}:item),
  keyframes:[{id:'k1',name:'双人',camera:{position:[2,1.5,4] as [number,number,number],lookAt:target,focalLength:35}},{id:'k3',name:'',camera:eye(50)}]};
 delete (written as Row).activeKeyframeId;
 const {result,changes}=await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:written});
 const saved=f.node(node.id),look=previsLookAt([2,1.5,4],target);
 assert.deepEqual(saved.scene.keyframes,[{id:'k1',name:'双人',camera:{position:[2,1.5,4],yaw:roundPrevisNumber(look.yaw),pitch:roundPrevisNumber(look.pitch),focalLength:35},exports:[image]},{id:'k3',name:'',camera:eye(50),exports:[]}]);
 assert.deepEqual(saved.scene.figures[0]!.position,[-0.123,0,0.988]);
 assert.equal(saved.scene.schemaVersion,1);assert.equal(saved.scene.activeKeyframeId,'k1','an omitted selection keeps the one still present');
 assert.deepEqual([saved.sceneRevision,saved.label,saved.position],[node.sceneRevision+1,node.label,node.position]);
 assert.deepEqual(result,(await f.execute('previs.inspect',{nodeId:node.id})).result,'the write returns the view Mio reads');
 assert.equal(changes.length,1);const change=changes[0]!;
 assert.deepEqual([change.operation,change.reversible,change.targets.map(item=>[item.kind,item.id])],['previs.scene.set',true,[['node',node.id]]]);
 assert.deepEqual(projectAgentTaskChangeDisplay(change).fields.map(field=>[field.property,field.before,field.after]),[],'counts unchanged: two figures, two props, two keyframes');
 assert.deepEqual(await f.slots(saved),['card'],'k1 now looks elsewhere and k2 is gone; the card keeps its older picture');
 // An explicit selection is honoured, an unknown one falls back to the current keyframe.
 await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:saved.sceneRevision,scene:{...modelScene(saved.scene),activeKeyframeId:null}});
 assert.equal(f.node(node.id).scene.activeKeyframeId,null);
 await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:f.node(node.id).sceneRevision,scene:{...modelScene(f.node(node.id).scene),activeKeyframeId:'k3'}});
 await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:f.node(node.id).sceneRevision,scene:{...modelScene(f.node(node.id).scene),activeKeyframeId:'k9',figures:[]}});
 const last=f.node(node.id);assert.equal(last.scene.activeKeyframeId,'k3');
 const counts=f.journal.snapshot(f.run.id).changes.at(-1)!;
 assert.deepEqual(projectAgentTaskChangeDisplay(counts).fields.map(field=>[field.property,field.before,field.after]),[['figureCount',2,0]]);
 // Before it runs (a confirmation or a conflict), a scene save names its node only: whole-scene counts are no plan.
 const planned=projectAgentTaskStepDisplay(f.journal.step(counts.stepId),target=>target.kind==='node'?f.node(target.id) as unknown as Row:undefined,true);
 assert.deepEqual([planned?.operation,planned?.targets.map(item=>[item.kind,item.name]),planned?.fields],['previs.scene.set',[['node','雨夜街口']],[]]);
});

test('undo saves the earlier scene as a new scene revision the editor can save after, and stops once the node changed',async t=>{
 const f=await fixture(t),{node}=await f.rainyCorner();
 await f.thumbnail(node,'card');await f.thumbnail(node,'k1');await f.thumbnail(node,'k2');
 const scene=modelScene(node.scene),moved={...scene,keyframes:scene.keyframes.map(item=>item.id==='k2'?{...item,camera:eye(85,-0.4,1.5)}:item)};
 const first=(await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:moved})).changes[0]!,after=f.node(node.id);
 assert.deepEqual(await f.slots(after),['card','k1'],'only k2 changed its camera');
 // The editor opened meanwhile and drew k2 for the new camera.
 await f.thumbnail(after,'k2');
 const undone=f.undo(first);assert.equal(undone.retained,undefined);
 const restored=f.node(node.id);
 assert.deepEqual(restored.scene,node.scene);
 assert.deepEqual([restored.sceneRevision,restored.revision],[after.sceneRevision+1,after.revision+1],'a new scene revision, never an old number');
 assert.deepEqual(await f.slots(restored),['card','k1'],'k2 looks elsewhere again');
 assert.equal(f.journal.snapshot(f.run.id).changes.find(change=>change.id===first.id)?.status,'reverted');
 // The editor saves on from the restored revision; the earlier receipts never collide.
 const edited=await f.save(restored,{...restored.scene,light:{...restored.scene.light,intensity:0.8}});
 assert.equal(edited.sceneRevision,restored.sceneRevision+1);
 // A Mio change the user edited over is kept.
 const second=(await f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:edited.sceneRevision,scene:{...modelScene(edited.scene),figures:[]}})).changes[0]!;
 await f.save(f.node(node.id),{...f.node(node.id).scene,light:{...edited.scene.light,intensity:1.2}});
 assert.throws(()=>f.undo(second),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.equal(f.node(node.id).scene.figures.length,0);
});

test('a stale scene revision fails as not applied, an editing claim stops the write, and an unknown save is checked against previs receipts',async t=>{
 const f=await fixture(t),{node}=await f.rainyCorner(),scene=modelScene(node.scene);
 await assert.rejects(f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:node.sceneRevision-1,scene}),
  (error:{code?:string;details?:Row})=>error.code==='REVISION_CONFLICT'&&error.details?.mutationOutcome==='not_applied');
 const target={kind:'node',id:node.id,revision:f.journal.targetRevision(f.projectId,'node',node.id)},ownerId=randomUUID();
 f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 await assert.rejects(f.execute('previs.scene.set',{nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:{...scene,figures:[]}}),{code:'AGENT_TASK_TARGET_CLAIMED'});
 assert.deepEqual(f.node(node.id),node,'nothing was saved while the editor held the node');
 f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
 const input={nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene},prepared=f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_scene_set',input});
 const step=f.journal.beginStep(f.run.id,{kind:'tool',tier:prepared.risk,targets:prepared.targets,toolCall:{id:randomUUID(),name:'mioon_previs_scene_set',arguments:input as unknown as AgentTaskJson}});
 f.journal.markDispatch(f.run.id,step.id);f.journal.updateStep(f.run.id,step.id,{status:'unknown'});
 assert.deepEqual(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),{outcome:'not_applied',reason:'atomic_receipt_absent'});
 await f.call('previs.scene.set',{projectId:f.projectId,nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:node.scene,requestId:step.id});
 assert.equal(f.tools.recoverLocalUnknown(prepared,{runId:f.run.id,stepId:step.id,requestId:step.id}),null,'a retained save receipt keeps the step for inspection');
});

test('a refused scene names the failing fields without echoing values, and nothing is prepared',async t=>{
 const f=await fixture(t),{node}=await f.rainyCorner(),scene=modelScene(node.scene),secret='SECRET-PROP-NAME';
 const bad={nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene:{...scene,
  figures:[{...scene.figures[0]!,position:[120,0,0]},{...scene.figures[1]!,held:{propId:'p2',hand:'left'}}],
  props:[{...scene.props[0]!,[secret]:true},scene.props[1]!],camera:{...scene.camera,lookAt:'there'}}};
 assert.throws(()=>f.tools.prepare({projectId:f.projectId,operation:'mioon_previs_scene_set',input:bad}),{code:'VALIDATION_ERROR'});
 const feedback=await f.tools.parameterFeedback({projectId:f.projectId,operation:'mioon_previs_scene_set',input:bad});
 assert.ok(feedback);
 const fields=feedback.issues.map(issue=>issue.field);
 for(const field of ['scene.figures.0.position.0','scene.props.0','scene.camera.lookAt'])assert.ok(fields.includes(field),field);
 assert.equal(JSON.stringify(feedback).includes(secret),false);assert.equal(JSON.stringify(feedback).includes('there'),false);
 const holding=await f.tools.parameterFeedback({projectId:f.projectId,operation:'mioon_previs_scene_set',input:{...bad,scene:{...scene,figures:[scene.figures[0]!,{...scene.figures[1]!,held:{propId:'p2',hand:'left'}}]}}});
 assert.match(holding?.message??'',/只能拿伞、手机、包或杯/u);
 assert.equal(await f.tools.parameterFeedback({projectId:f.projectId,operation:'mioon_previs_scene_set',input:{nodeId:node.id,expectedSceneRevision:node.sceneRevision,scene}}),null);
 assert.equal(f.node(node.id).sceneRevision,node.sceneRevision);
});

test('creating a previs is local and irreversible and reads back like inspect',async t=>{
 const f=await fixture(t);
 const {result,changes}=await f.execute('previs.create',{label:'雨夜街口',position:{x:120,y:80}});
 assert.ok(record(result)&&typeof result.nodeId==='string');
 const created=f.node(result.nodeId);
 assert.deepEqual([created.type,created.label,created.sceneRevision],['previs','雨夜街口',1]);
 assert.deepEqual(record(result)&&result.scene,modelScene(defaultPrevisScene()));
 assert.equal(changes.length,1);assert.deepEqual([changes[0]!.operation,changes[0]!.reversible],['previs.create',false]);
 assert.throws(()=>f.undo(changes[0]!),{code:'AGENT_TASK_NOT_REVERSIBLE'});
});
