import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createClient} from '../packages/client/src/index.mjs';
import {GENERATION_INPUT_PROFILES,isSubjectGenerationResponse} from '@mioon/contracts';
import * as contracts from '@mioon/contracts';
import * as submissions from '../apps/web/src/submissions.js';
import * as mutations from '../apps/web/src/mutation-submissions.js';
import {ApiError} from '../apps/web/src/api.js';
import {prepareSubmission,readPending,writePending,reconcilePending} from '../apps/web/src/submissions.js';

const id=n=>`97000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const profile=()=>GENERATION_INPUT_PROFILES.find(p=>p.providerId==='mock');
function records(){
 const version={id:id(3),projectId:id(1),subjectId:id(2),number:1,assetId:id(4),sha256:'a'.repeat(64),mimeType:'image/png',width:512,height:512,
  provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:'2026-10-11T22:00:00.000Z'};
 const reference={subjectVersionId:version.id,subjectName:'青色纸盒',subjectKind:'product',subjectVersion:version};
 const input={shotId:id(5),expectedRevision:3,requestId:'subject-generation-original-key',providerId:'mock',model:profile().model,subjectVersionId:version.id};
 const snapshot={shotId:input.shotId,shotRevision:3,title:'主体参考',prompt:'Keep the package on a plain table',referenceAssetIds:[version.assetId],
  referenceAssets:[{id:version.assetId,role:'subject_reference',mimeType:version.mimeType,sha256:version.sha256,width:512,height:512,sizeBytes:128}],
  referenceBindings:[{role:'subject_reference',assetId:version.assetId,sha256:version.sha256}],referenceConnections:[],subjectReference:reference,
  aspectRatio:'9:16',duration:4,providerId:'mock',model:input.model,parameters:{},capabilities:{mock:true},
  inputProfileVersion:profile().profileVersion,inputProfileId:profile().profileId,providerRegion:profile().regions[0]};
 const job={id:id(6),projectId:id(1),shotId:input.shotId,requestId:input.requestId,providerId:'mock',model:input.model,revision:1,status:'queued',phase:'waiting',progress:0,
  snapshot,providerJobId:null,submissionCount:0,error:null,createdAt:version.createdAt,updatedAt:version.createdAt,versionId:null,cancelScope:null,retryOfJobId:null,allowedActions:['cancel']};
 const entry={projectId:id(1),key:`generate:${input.shotId}`,operation:'generation.submit',input,createdAt:version.createdAt,expectedSubjectReference:reference};
 return {entry,job,reference};
}
function storage(t){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),values=new Map();
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{get length(){return values.size;},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)}});
 t.after(()=>previous?Object.defineProperty(globalThis,'sessionStorage',previous):delete globalThis.sessionStorage);
 return values;
}
const copy=value=>structuredClone(value);

test('explicit subject submission persists the complete reviewed source before dispatch and preserves original identity',t=>{
 storage(t);const {entry}=records(),original=copy(entry);
 assert.deepEqual(prepareSubmission(entry),original);
 entry.expectedSubjectReference.subjectVersion.sha256='b'.repeat(64);
 entry.input.subjectVersionId=id(99);entry.input.requestId='replacement-key-not-authorized';
 assert.deepEqual(readPending(original.projectId,original.key),original);
 assert.deepEqual(prepareSubmission(entry),original,'a later draft or second renderer cannot replace the original key or source pin');
});

test('missing, foreign or changed subject pin stops before dispatch and never destroys the existing record',t=>{
 storage(t);const {entry}=records();
 for(const mutate of [x=>delete x.expectedSubjectReference,x=>{x.expectedSubjectReference.subjectVersion.projectId=id(99);},x=>{x.expectedSubjectReference.subjectVersionId=id(98);}]){
  const invalid=copy(entry);mutate(invalid);
  assert.throws(()=>prepareSubmission(invalid),{code:'SUBJECT_SUBMISSION_MISMATCH'});
  assert.equal(readPending(entry.projectId,entry.key),null);
 }
 const broken=copy(entry);delete broken.expectedSubjectReference;writePending(broken);
 assert.throws(()=>prepareSubmission(entry),{code:'SUBJECT_SUBMISSION_MISMATCH'});
 assert.deepEqual(readPending(entry.projectId,entry.key),broken);
});

test('reconciliation needs a unique exact subject acknowledgement, not matching key alone or newer current head',t=>{
 storage(t);const {entry,job}=records();prepareSubmission(entry);
 assert.equal(isSubjectGenerationResponse(entry.operation,entry.input,job,{projectId:entry.projectId,subjectReference:entry.expectedSubjectReference}),true);
 const alterations=[x=>{delete x.snapshot.subjectReference;},x=>{x.projectId=id(99);},x=>{x.shotId=id(99);},x=>{x.snapshot.shotRevision++;},
  x=>{x.snapshot.subjectReference.subjectVersionId=id(99);x.snapshot.subjectReference.subjectVersion.id=id(99);},
  x=>{x.snapshot.subjectReference.subjectVersion.sha256='b'.repeat(64);x.snapshot.referenceAssets[0].sha256='b'.repeat(64);x.snapshot.referenceBindings[0].sha256='b'.repeat(64);},
  x=>{x.snapshot.referenceBindings[0].role='first_frame';},x=>{x.providerId='ark';},x=>{x.retryOfJobId=id(99);},x=>{x.snapshot.prompt={changed:true};}];
 for(const mutate of alterations){const invalid=copy(job);mutate(invalid);reconcilePending(entry.projectId,{jobs:[invalid]});assert.deepEqual(readPending(entry.projectId,entry.key),entry);}
 for(const jobs of [[{requestId:entry.input.requestId}],[job,job],[],[{...job,requestId:'other'}]]){
  reconcilePending(entry.projectId,{jobs});assert.deepEqual(readPending(entry.projectId,entry.key),entry);
 }
 const other={...copy(entry),projectId:id(91),expectedSubjectReference:{...copy(entry.expectedSubjectReference),subjectVersion:{...copy(entry.expectedSubjectReference.subjectVersion),projectId:id(91)}}};prepareSubmission(other);
 reconcilePending(entry.projectId,{jobs:[job],subjects:[{id:id(2),headVersionId:id(99)}]});
 assert.equal(readPending(entry.projectId,entry.key),null);assert.deepEqual(readPending(other.projectId,other.key),other);
});

test('corrupt stored subject pin cannot be replaced from read data, while omitted legacy behaviour stays compatible',t=>{
 storage(t);const {entry,job}=records(),broken=copy(entry);delete broken.expectedSubjectReference;writePending(broken);
 reconcilePending(entry.projectId,{jobs:[job]});assert.deepEqual(readPending(entry.projectId,entry.key),broken);
 const legacy={...copy(entry),key:'legacy-generate',input:{shotId:id(7),requestId:'legacy-request'}};delete legacy.expectedSubjectReference;prepareSubmission(legacy);
 reconcilePending(entry.projectId,{jobs:[{requestId:'legacy-request'}]});assert.equal(readPending(entry.projectId,legacy.key),null);
 assert.deepEqual(readPending(entry.projectId,entry.key),broken);
});

test('shared client rejects malformed subject success as unknown with original key and never retries',async()=>{
 const {entry,job}=records();let calls=0,current=job;
 const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:32109',MIOON_TOKEN:'synthetic-subject-ack-token'},fetchImpl:async(_url,options)=>{
  calls++;assert.deepEqual(JSON.parse(options.body),{operation:entry.operation,input:entry.input});return new Response(JSON.stringify({ok:true,data:current}),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.deepEqual(await client.rpc(entry.operation,entry.input),job);assert.equal(calls,1);
 for(const mutate of [x=>{delete x.snapshot.subjectReference;},x=>{x.requestId='different';},x=>{x.snapshot.referenceBindings[0].sha256='c'.repeat(64);},x=>{x.snapshot.subjectReference.subjectVersion.projectId=id(99);}]){
  current=copy(job);mutate(current);const before=calls;
  await assert.rejects(client.rpc(entry.operation,entry.input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.requestId===entry.input.requestId&&error.details.submissionMayHaveSucceeded===true);
  assert.equal(calls,before+1,'no implicit POST retry');
 }
});

function appHarness(t,dispatch,jobs=[]){
 storage(t);const source=readFileSync(new URL('../apps/web/src/App.jsx',import.meta.url),'utf8');
 const start=source.indexOf('async function runSession('),end=source.indexOf('async function inspect(',start);
 assert.ok(start>=0&&end>start);const actual=source.slice(start,end);
 const currentProject={current:id(1)},busy=new Set(),state={epoch:0,calls:[],notices:[],refreshes:[],pending:[],showJobs:false};
 const scope={...contracts,...submissions,...mutations,currentProject,
  context:()=>({projectId:currentProject.current,epoch:state.epoch}),isCurrent:captured=>captured.projectId===currentProject.current&&captured.epoch===state.epoch,
  isBusy:(key,project)=>busy.has(project+key),markBusy:(project,key,value)=>value?busy.add(project+key):busy.delete(project+key),
  rpc:async(operation,input)=>{state.calls.push({operation,input:copy(input)});return dispatch(operation,input);},
  setPending:items=>{state.pending=items;},setShowJobs:value=>{state.showJobs=value;},setAuth:()=>{},
  refresh:async project=>{state.refreshes.push(project);},notify:(text,type)=>state.notices.push({text,type}),readableError:error=>error.message,
  requestCounter:{current:0},dataRef:{current:{project:{id:id(1)},shots:[],nodes:[],jobs}},setData:()=>{}};
 const run=Function(...Object.keys(scope),`${actual};return runSession;`)(...Object.values(scope));
 return {run,state,currentProject,busy};
}

test('actual session runner retains lost ACK and every unbound 4xx, then accepts only exact original subject replay',async t=>{
 const {entry,job}=records();let outcome=Error('lost response');
 const h=appHarness(t,async()=>{if(outcome instanceof Error)throw outcome;return outcome;});
 const send=(input=entry.input,options={})=>h.run(entry.key,entry.operation,input,'Confirmed',{expectedSubjectReference:entry.expectedSubjectReference,...options});
 assert.equal(await send(),null);const original=readPending(entry.projectId,entry.key);assert.ok(original);assert.deepEqual(original.expectedSubjectReference,entry.expectedSubjectReference);
 assert.equal(await send({...entry.input,requestId:'new-click-must-not-submit',subjectVersionId:id(99)}),null);assert.equal(h.state.calls.length,1);
 for(const error of [new ApiError('Forbidden','UNAUTHORIZED',{},true,401),new ApiError('Changed','IDEMPOTENCY_CONFLICT',{},true,409),new ApiError('Invalid','VALIDATION_ERROR',{},true,400)]){
  outcome=error;await send(entry.input,{replay:true});assert.deepEqual(readPending(entry.projectId,entry.key),original);
 }
 outcome=copy(job);outcome.snapshot.subjectReference.subjectName='Wrong frozen label';await send(entry.input,{replay:true});assert.deepEqual(readPending(entry.projectId,entry.key),original);
 outcome=job;assert.deepEqual(await send(entry.input,{replay:true}),job);assert.equal(readPending(entry.projectId,entry.key),null);
 assert.ok(h.state.calls.every(call=>JSON.stringify(call.input)===JSON.stringify(entry.input)));assert.equal(h.busy.size,0);
});

test('actual late subject ACK cannot refresh or notify a replacement project, while preserving its confirmed original key outcome',async t=>{
 const {entry,job}=records();let resolve;const held=new Promise(r=>{resolve=r;});
 const h=appHarness(t,()=>held);const pending=h.run(entry.key,entry.operation,entry.input,'Old project message',{expectedSubjectReference:entry.expectedSubjectReference});
 assert.equal(h.state.calls.length,1);h.currentProject.current=id(99);h.state.epoch++;
 resolve(job);assert.equal(await pending,null);assert.deepEqual(h.state.refreshes,[]);assert.equal(h.state.notices.length,0);
 assert.equal(readPending(entry.projectId,entry.key),null);assert.equal(h.busy.size,0);
});

function retryRecords(){
 const {entry:original,job:parent,reference}=records();
 const input={jobId:parent.id,requestId:'subject-retry-original-key'};
 const job={...copy(parent),id:id(7),requestId:input.requestId,retryOfJobId:parent.id};
 const entry={projectId:parent.projectId,key:`retry:${parent.id}`,operation:'job.retry',input,createdAt:parent.createdAt,
  subjectRetry:true,expectedSubjectReference:copy(reference),expectedRetrySnapshot:copy(parent.snapshot)};
 return {entry,job,parent,reference};
}
test('subject retry reconciliation requires original full snapshot, including when every local marker is lost',t=>{
 storage(t);const {entry,job,parent}=retryRecords();prepareSubmission(entry);
 for(const mutate of [x=>{x.retryOfJobId=id(99);},x=>{x.id=parent.id;},x=>{x.snapshot.prompt='Changed prompt';},x=>{x.snapshot.parameters={seed:1};},x=>{delete x.snapshot.subjectReference;}]){
  const invalid=copy(job);mutate(invalid);reconcilePending(entry.projectId,{jobs:[parent,invalid]});assert.deepEqual(readPending(entry.projectId,entry.key),entry);
 }
 reconcilePending(entry.projectId,{jobs:[job,job]});assert.deepEqual(readPending(entry.projectId,entry.key),entry);
 const broken=copy(entry);delete broken.subjectRetry;delete broken.expectedSubjectReference;delete broken.expectedRetrySnapshot;writePending(broken);
 for(const jobs of [[parent,job],[job]]){reconcilePending(entry.projectId,{jobs});assert.deepEqual(readPending(entry.projectId,entry.key),broken,'available subject identity demands missing proof, never recreates it');}
 writePending(entry);reconcilePending(entry.projectId,{jobs:[job]});assert.equal(readPending(entry.projectId,entry.key),null);
 const legacy={projectId:entry.projectId,key:'legacy-retry',operation:'job.retry',input:{jobId:id(99),requestId:'legacy-retry-key'}};writePending(legacy);
 reconcilePending(entry.projectId,{jobs:[{requestId:legacy.input.requestId}]});assert.equal(readPending(entry.projectId,legacy.key),null);
});
test('actual subject retry holds lost, malformed and rejected outcomes until exact original snapshot ACK',async t=>{
 const {entry,job,parent}=retryRecords();let outcome=Error('retry response lost');
 const h=appHarness(t,async()=>{if(outcome instanceof Error)throw outcome;return outcome;},[parent]);
 const send=(input=entry.input,options={})=>h.run(entry.key,entry.operation,input,'Confirmed',{subjectRetry:true,expectedSubjectReference:entry.expectedSubjectReference,expectedRetrySnapshot:entry.expectedRetrySnapshot,...options});
 await send();const original=readPending(entry.projectId,entry.key);assert.deepEqual(original.expectedRetrySnapshot,parent.snapshot);
 await send({...entry.input,requestId:'new-click'});assert.equal(h.state.calls.length,1);
 for(const error of [new ApiError('Forbidden','UNAUTHORIZED',{},true,401),new ApiError('Changed','IDEMPOTENCY_CONFLICT',{},true,409)]){
  outcome=error;await send(entry.input,{replay:true});assert.deepEqual(readPending(entry.projectId,entry.key),original);
 }
 for(const mutate of [x=>{x.retryOfJobId=id(99);},x=>{x.snapshot.prompt='Different';},x=>{x.snapshot.parameters={seed:123};},x=>{delete x.snapshot.subjectReference;}]){
  outcome=copy(job);mutate(outcome);await send(entry.input,{replay:true});assert.deepEqual(readPending(entry.projectId,entry.key),original);
 }
 outcome=job;assert.deepEqual(await send(entry.input,{replay:true}),job);assert.equal(readPending(entry.projectId,entry.key),null);
 assert.ok(h.state.calls.every(call=>JSON.stringify(call.input)===JSON.stringify(entry.input)));
 const before=h.state.calls.length;await send(entry.input,{replay:true});assert.equal(h.state.calls.length,before,'stale task callback cannot recreate a cleared receipt');assert.equal(readPending(entry.projectId,entry.key),null);
});
test('actual known-subject retry cannot use stripped metadata or an absent receipt as legacy authority',async t=>{
 const {entry,job,parent}=retryRecords();const h=appHarness(t,()=>job,[parent]);const broken=copy(entry);
 delete broken.subjectRetry;delete broken.expectedSubjectReference;delete broken.expectedRetrySnapshot;writePending(broken);
 await h.run(entry.key,entry.operation,entry.input,'Recovered',{replay:true});assert.equal(h.state.calls.length,0);assert.deepEqual(readPending(entry.projectId,entry.key),broken);
 submissions.clearPending(entry.projectId,entry.key);await h.run(entry.key,entry.operation,entry.input,'Recovered',{replay:true});assert.equal(h.state.calls.length,0);assert.equal(readPending(entry.projectId,entry.key),null);
});
test('shared client validates subject-bearing retry ACK without broadening the legacy wire',async()=>{
 const {entry,job}=retryRecords();let current=job,calls=0;
 const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:32109',MIOON_TOKEN:'synthetic-subject-retry-token'},fetchImpl:async(_url,options)=>{
  calls++;assert.deepEqual(JSON.parse(options.body),{operation:'job.retry',input:entry.input});return new Response(JSON.stringify({ok:true,data:current}),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.deepEqual(await client.rpc('job.retry',entry.input),job);
 for(const mutate of [x=>{x.retryOfJobId=id(99);},x=>{x.requestId='changed';},x=>{x.snapshot.referenceBindings[0].sha256='c'.repeat(64);},x=>{delete x.snapshot.subjectReference;}]){
  current=copy(job);mutate(current);const before=calls;
  await assert.rejects(client.rpc('job.retry',entry.input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details.requestId===entry.input.requestId&&error.details.submissionMayHaveSucceeded===true);assert.equal(calls,before+1);
 }
});
