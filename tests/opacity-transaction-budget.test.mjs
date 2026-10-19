import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {createEditTasksHttp} from '../apps/server/src/edit-tasks-http.mjs';
import {schemas,isTimelineRecord,isTimelineMutationResponse,isEditTaskEnvelope} from '../packages/contracts/src/index.mjs';
import {createTimelineOpacityCandidateContracts} from '../packages/contracts/src/timeline-opacity-candidate.ts';
import {OPACITY_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-opacity-envelope.ts';

const stamp='2026-10-16T00:00:00.000Z',operation='timeline.clip.update';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const count=value=>1+(value&&typeof value==='object'?Object.values(value).reduce((sum,child)=>sum+count(child),0):0);
const candidate=createTimelineOpacityCandidateContracts({isTimelineRecord,validateClipIntent:(name,value)=>schemas[name].safeParse(value).success});
const opacity=()=>({profileId:OPACITY_ENVELOPE_PROFILE,points:Array.from({length:7},(_,frame)=>({frame,opacity:1.2345678901234567e-100}))});
function maximumInput(projectId=id(1)){
  const hash='f'.repeat(64),profileId='jfif-ycbcr8-srgb-v1';
  // Complete lexical maximum: JPEG colour and audio automation cannot describe
  // one executable source. Preparation validates intent grammar, not that future
  // source semantics will succeed. No optional legal field is removed here.
  return {projectId,requestId:'\u0002'.repeat(200),expectedRevision:Number.MAX_SAFE_INTEGER-1,clipId:id(4),patch:{
    trackId:id(3),name:'\u0001'.repeat(200),startFrame:0,durationFrames:18000,sourceInFrame:Number.MAX_SAFE_INTEGER-18000,
    rect:{x:0,y:0,width:1280,height:720},gain:2,fadeInFrames:9000,fadeOutFrames:9000,audioRole:'human',
    volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:Array.from({length:16},(_,frame)=>({frame,multiplier:1.2345678901234567e-100}))},
    colour:{profileId:'mioon-jfif-image-clip-v1',source:{assetSha256:hash,profileId,interpretation:'srgb',declaredBy:'user',declaredAt:stamp,
      evidence:{profileId,sha256:hash,sourceByteLength:33554432,width:1920,height:1080,bitDepth:8,alphaMode:'opaque',orientation:1,colourTag:'untagged',sampling:'420',decoderPolicy:'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},
      look:{resourceId:id(1),resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}},
  }};
}
const prepare=input=>({projectId:input.projectId,operation,input,origin:'new'});

test('actual owned task prepare accepts complete old maximum and refuses opacity without any write or dispatch',async t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-opacity-transaction-budget-'));
  let store,tasks,dispatches=0;
  t.after(async()=>{await tasks?.drain();store?.close();rmSync(root,{recursive:true,force:true});});
  store=openStore(root);
  const services=createServices(store,new Map());
  const project=await services.call('project.create',{name:'Synthetic opacity budget qualification'});
  await services.call('timeline.get',{projectId:project.id});
  tasks=createEditTasks({store,services:{call(){dispatches++;throw Error('This qualification must never dispatch');}}});
  const old=maximumInput(project.id);
  assert.equal(schemas[operation].safeParse(old).success,true);
  assert.equal(count(old),99);assert.equal(count(prepare(old)),103);
  const prepared=tasks.prepare(prepare(old));
  assert.equal(prepared.task.status,'prepared');assert.equal(isEditTaskEnvelope(prepared),true);
  assert.deepEqual(prepared.task.input,old);assert.equal(dispatches,0);
  const input={...old,requestId:randomUUID(),patch:{...old.patch,opacityEnvelope:opacity()}};
  const captured=candidate.captureIntent(operation,input,{trackKind:'video',durationFrames:18000});
  assert.equal(count(input),123);assert.equal(count(prepare(input)),127);
  assert.equal(captured.nodes,123);assert.equal(captured.prepareNodes,127);
  assert.deepEqual(captured.input,input);
  const snapshot=()=>JSON.stringify(['edit_tasks','timelines','timeline_requests','timeline_history','timeline_history_cursors'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before=snapshot(),changes=store.db.prepare('SELECT total_changes() AS n').get().n;
  for(const context of [{},{expectedWorkspaceOrigin:randomUUID()}]){
    assert.throws(()=>tasks.prepare(prepare(input),context),{code:'EDIT_TASK_VALIDATION'});
    assert.equal(snapshot(),before);assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);
  }
  assert.equal(dispatches,0);assert.equal(store.db.isTransaction,false);
  t.diagnostic('127 nodes is candidate capture plus the unchanged complete prepare wrapper only; production still rejects the opacity array. No opacity transaction, execution, commit or restore profile is implemented by this test.');
});

test('real HTTP prepare separates restored-origin context before the 128-node task walker',async()=>{
  const input=maximumInput(),withOpacity={...input,patch:{...input.patch,opacityEnvelope:opacity()}};
  const wrapper=prepare(withOpacity),workspaceOrigin=randomUUID(),body={...wrapper,expectedWorkspaceOrigin:workspaceOrigin};
  assert.equal(count(wrapper),127);assert.equal(count(body),128);
  const data=Buffer.from(JSON.stringify(body)),req=Readable.from([data]);
  Object.assign(req,{url:'/api/tasks/prepare',method:'POST',headers:{'content-type':'application/json','content-length':String(data.length)}});
  let received=0;
  const handler=createEditTasksHttp({tasks:{prepare(actual,context){received++;assert.deepEqual(actual,wrapper);assert.equal(count(actual),127);assert.deepEqual(context,{expectedWorkspaceOrigin:workspaceOrigin});return {qualification:true};}}});
  const res={destroyed:false,writableEnded:false,headersSent:false,setHeader(){},writeHead(status){this.status=status;this.headersSent=true;},end(text){this.text=text;this.writableEnded=true;}};
  assert.equal(await handler(req,res,new URL('http://127.0.0.1/api/tasks/prepare')),true);
  assert.equal(res.status,200);assert.equal(received,1);
  assert.deepEqual(JSON.parse(res.text),{ok:true,data:{qualification:true}});
});

test('full historical ACK uses its record/byte contract rather than the prepare node budget',()=>{
  const input=maximumInput();input.expectedRevision=1;
  const track=(n,order)=>({id:id(n),name:'Video',kind:'video',orderIndex:order,hidden:false,muted:false});
  const response={id:id(2),projectId:input.projectId,revision:2,fps:30,width:1280,height:720,
    tracks:[track(3,0),track(10,1)],clips:[{id:input.clipId,assetId:id(5),...input.patch},{id:id(11),assetId:id(12),...input.patch,trackId:id(10)}],
    durationFrames:18000,createdAt:stamp,updatedAt:stamp};
  assert.ok(count(response)>128);assert.equal(isTimelineRecord(response),true);
  assert.equal(isTimelineMutationResponse(operation,input,response),true);
  const future=structuredClone(response);future.clips[0].opacityEnvelope=opacity();
  assert.equal(isTimelineRecord(future),false);assert.equal(isTimelineMutationResponse(operation,{...input,patch:{...input.patch,opacityEnvelope:opacity()}},future),false);
  const execute={projectId:id(1),taskId:id(2),digest:'a'.repeat(64),instanceId:id(3)};
  const acknowledge={projectId:id(1),taskId:id(2),digest:'a'.repeat(64),expectedRevision:3,status:'applied'};
  assert.equal(count(execute),5);assert.equal(count(acknowledge),6);
});

test('actual owned store cannot register or reopen42/43 through the frozen production assembly',t=>{
  for(const extra of [[42],[42,43]]){
    const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-opacity-assembly-refusal-'));
    let store;
    t.after(()=>{store?.close();rmSync(root,{recursive:true,force:true});});
    store=openStore(root);
    // Deliberately forged marker evidence in a newly created test database.
    // This is a refusal probe, not a42/43 constructor, migration or admission.
    for(const version of extra)store.db.prepare('INSERT INTO schema_version VALUES(?)').run(version);
    const before=JSON.stringify(store.db.prepare('SELECT * FROM schema_version ORDER BY version').all());
    const changes=store.db.prepare('SELECT total_changes() AS n').get().n;
    assert.throws(()=>getWorkspaceRestoreContext(store),{code:'RESTORE_STORE_UNVERIFIED'});
    assert.throws(()=>createEditTasks({store,services:{call(){throw Error('Must not dispatch');}}}),{code:'RESTORE_STORE_UNVERIFIED'});
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM schema_version ORDER BY version').all()),before);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);
    store.close();store=undefined;
    assert.throws(()=>openStore(root),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  }
});
