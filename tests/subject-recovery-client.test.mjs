import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '@mioon/client';
import {isSubjectMutationResponse,hasRequestNotAppliedProof,isEditTaskEnvelope} from '@mioon/contracts';
import {createEditTaskController} from '../apps/web/src/edit-task-controller.ts';
import {createEditTaskClient,validateTaskEnvelope} from '../apps/web/src/edit-task-client.ts';
const stamp='2026-10-10T00:00:00.000Z';
function fixture(operation='subject.create'){
 const projectId=randomUUID(),subjectId=randomUUID(),assetId=randomUUID(),headVersionId=randomUUID(),shotId=randomUUID();
 const input={projectId,requestId:randomUUID(),...(operation==='subject.create'?{kind:'character',name:'Hero',assetId}:operation==='subject.version.add'?{subjectId,expectedRevision:1,assetId}:{shotId,subjectId,role:'subject',subjectVersionId:headVersionId,expectedRevision:0,expectedSubjectRevision:1})};
 const revision=operation==='subject.version.add'?2:1;
 const result=operation==='subject.binding.set'?{id:randomUUID(),projectId,shotId,subjectId,role:'subject',revision:1,subjectVersionId:headVersionId,reviewedHeadVersionId:headVersionId,headVersionId,subjectRevision:1,needsReview:false,createdAt:stamp,updatedAt:stamp}
 :{id:subjectId,projectId,kind:'character',name:'Hero',revision,headVersionId,headVersion:{id:headVersionId,projectId,subjectId,number:revision,assetId,sha256:'a'.repeat(64),mimeType:'image/png',width:64,height:64,provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:stamp},createdAt:stamp,updatedAt:stamp};
 const task={id:randomUUID(),projectId,operation,input,requestId:input.requestId,digest:'a'.repeat(64),lane:'subject:mutation',status:'prepared',revision:1,createdAt:stamp,updatedAt:stamp,acknowledged:false,origin:'new'};
 return {projectId,operation,input,result,task,instanceId:randomUUID()};
}
const env={MIOON_TOKEN:'synthetic-subject-recovery-token'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const proof=(f)=>({mutationOutcome:'not_applied',operation:f.operation,projectId:f.projectId,requestId:f.input.requestId});

for(const operation of ['subject.create','subject.version.add','subject.binding.set'])test(`${operation} strict client ACK retains exact key on malformed success without retries`,async()=>{
 const f=fixture(operation);assert.ok(isSubjectMutationResponse(operation,f.input,f.result));
 let calls=0,value=f.result;
 const client=createClient({env,fetchImpl:async(_url,options)=>{calls++;assert.deepEqual(JSON.parse(options.body),{operation,input:f.input});return response({ok:true,data:value});}});
 assert.deepEqual(await client.rpc(operation,f.input),f.result);
 const invalid=[null,{},[],{...f.result,projectId:randomUUID()},{...f.result,revision:999},{...f.result,extra:true}];
 if(operation==='subject.create')invalid.push({...f.result,name:'Different name'});
 if(operation==='subject.version.add')invalid.push({...f.result,id:randomUUID()});
 if(operation==='subject.binding.set')invalid.push({...f.result,subjectVersionId:null},{...f.result,needsReview:true},{...f.result,subjectRevision:2});
 for(const malformed of invalid){value=malformed;const before=calls;
  await assert.rejects(client.rpc(operation,f.input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.requestId===f.input.requestId&&error.details.operation===operation&&error.details.submissionMayHaveSucceeded===true);
  assert.equal(calls,before+1);assert.equal(isEditTaskEnvelope({task:{...f.task,status:'applied'},instanceId:f.instanceId,result:malformed}),false);
 }
});

test('subject rollback requires operation/project/key and subject-specific code; ambiguous errors retain identity',async()=>{
 const f=fixture('subject.version.add'),exact=proof(f),allowed=['REVISION_CONFLICT','SUBJECT_NO_CHANGE','SUBJECT_REVISION_LIMIT','SUBJECT_BINDING_LIMIT','SUBJECT_ROLE_MISMATCH'];
 const cases=[...allowed.map(code=>[409,code,exact,true]),[409,'REVISION_CONFLICT',{},false],
  ...Object.keys(exact).map(key=>{const incomplete={...exact};delete incomplete[key];return [409,'REVISION_CONFLICT',incomplete,false];}),
  [409,'REVISION_CONFLICT',{...exact,projectId:randomUUID()},false],[409,'REVISION_CONFLICT',{...exact,operation:'reference.attach'},false],
  [409,'REVISION_CONFLICT',{...exact,requestId:randomUUID()},false],[401,'REVISION_CONFLICT',exact,false],[403,'REVISION_CONFLICT',exact,false],
  [500,'REVISION_CONFLICT',exact,false],[404,'NOT_FOUND',exact,false],[409,'INVALID_SUBJECT_RECORD',exact,false],[409,'IDEMPOTENCY_CONFLICT',exact,false],[400,'INVALID_CLIP_TYPE',exact,false]];
 for(const [status,code,details,proven] of cases){
  assert.equal(hasRequestNotAppliedProof({status,code,details},f.input,{operation:f.operation}),proven);
  let calls=0;const client=createClient({env,fetchImpl:async()=>{calls++;return response({ok:false,error:{code,message:'Synthetic failure',details}},status);}});
  await assert.rejects(client.rpc(f.operation,f.input),error=>{assert.equal(error.details.submissionMayHaveSucceeded,!proven);assert.equal(error.details.requestId,f.input.requestId);assert.equal(Object.hasOwn(error.details,'mutationOutcome'),proven);return true;});assert.equal(calls,1);
 }
});

function controllerFixture(){
 const f=fixture(),calls=[];let task=null,nonce=f.instanceId,losePrepare=false,loseExecute=false,badExecute=false;
 const envelope=()=>({task:structuredClone(task),instanceId:nonce});
 const client={
  async list(){calls.push('list');return {items:task&&!task.acknowledged?[structuredClone(task)]:[],nextCursor:null,instanceId:nonce};},
  async prepare(input){calls.push('prepare');task??=structuredClone(f.task);if(losePrepare)throw Error('Lost prepare');return envelope();},
  async get(){calls.push('get');return envelope();},
  async execute(){calls.push('execute');if(badExecute)return {...envelope(),task:{...task,status:'applied',revision:3},result:{}};task={...task,status:'applied',revision:3};if(loseExecute)throw Error('Lost execute');return {...envelope(),result:f.result};},
  async reconcile(){calls.push('reconcile');return {...envelope(),...(task.status==='applied'?{result:f.result}:{})};},
  async acknowledge(input){calls.push('acknowledge');assert.equal(input.expectedRevision,task.revision);task={...task,acknowledged:true,revision:task.revision+1};return envelope();},
 };
 return {...f,client,calls,get saved(){return task;},losePrepare(){losePrepare=true;},loseExecute(){loseExecute=true;},badExecute(){badExecute=true;},restart(){nonce=randomUUID();},async controller(){const c=createEditTaskController({client});await c.load(f.projectId);return c;}};
}

test('subject controller prepares before dispatch and blocks only its explicit third lane until acknowledgement',async()=>{
 const f=controllerFixture(),c=await f.controller(),input=structuredClone(f.input),result=await c.submit({projectId:f.projectId,operation:f.operation,input});
 input.name='Changed draft';assert.deepEqual(f.calls,['list','prepare','execute']);assert.deepEqual(result.task.input,f.input);
 assert.equal(c.blocked(f.projectId,'subject:mutation'),true);assert.equal(c.blocked(f.projectId,'reference:mutation'),false);assert.equal(c.blocked(f.projectId,'timeline:mutation'),false);
 await assert.rejects(c.submit({projectId:f.projectId,operation:f.operation,input:{...f.input,requestId:randomUUID()}}),{code:'MUTATION_PENDING'});
 await c.acknowledge(result.task);assert.equal(c.blocked(f.projectId,'subject:mutation'),false);
});

test('lost preparation survives controller replacement and backend restart with no automatic execution',async()=>{
 const f=controllerFixture(),first=await f.controller();f.losePrepare();
 await assert.rejects(first.submit({projectId:f.projectId,operation:f.operation,input:f.input}),/Lost prepare/);
 assert.equal(first.getState(f.projectId).phase,'error');f.restart();const second=await f.controller();
 assert.deepEqual(f.calls,['list','prepare','list']);assert.equal(second.getState(f.projectId).items[0].requestId,f.input.requestId);
 const recovered=await second.recover(second.getState(f.projectId).items[0]);assert.equal(recovered.task.status,'applied');assert.deepEqual(f.calls.slice(-2),['get','execute']);
});

test('two window rediscovery and malformed ACK retain the persisted subject request instead of new draft values',async()=>{
 const f=controllerFixture(),first=await f.controller(),second=await f.controller();f.badExecute();
 await assert.rejects(first.submit({projectId:f.projectId,operation:f.operation,input:f.input}),{code:'BACKEND_PROTOCOL_ERROR'});
 assert.equal(first.blocked(f.projectId,'subject:mutation'),true);assert.deepEqual(first.getState(f.projectId).uncertain,[f.task.id]);
 await second.load(f.projectId);assert.equal(second.blocked(f.projectId,'subject:mutation'),true);assert.deepEqual(second.getState(f.projectId).items[0].input,f.input);
 await assert.rejects(second.submit({projectId:f.projectId,operation:f.operation,input:{...f.input,name:'Different window draft',requestId:randomUUID()}}),{code:'MUTATION_PENDING'});
 assert.equal(f.calls.filter(value=>value==='execute').length,1);
});

test('subject task HTTP client rejects wrong-lane and malformed 200 without retrying prepare',async()=>{
 const f=fixture();let payload={ok:true,data:{task:f.task,instanceId:f.instanceId}},calls=0;
 const client=createEditTaskClient({fetcher:async()=>{calls++;return response(payload);}});
 assert.ok(validateTaskEnvelope(payload.data));await client.prepare({projectId:f.projectId,operation:f.operation,input:f.input,origin:'new'});
 for(const lane of ['reference:mutation','timeline:mutation','future:mutation']){payload={ok:true,data:{task:{...f.task,lane},instanceId:f.instanceId}};await assert.rejects(client.prepare({projectId:f.projectId,operation:f.operation,input:f.input,origin:'new'}),{code:'BACKEND_PROTOCOL_ERROR'});}
 assert.equal(calls,4);
});
