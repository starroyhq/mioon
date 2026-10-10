import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,SUBJECT_MUTATION_OPERATIONS,SUBJECT_LIMITS,operationEffects,isSubjectResponse,isSubjectBindingResponse,isSubjectMutationResponse,isSubjectListResponse} from '@mioon/contracts';
import {jsonSchema} from '@mioon/client';
const projectId=randomUUID(),subjectId=randomUUID(),assetId=randomUUID(),shotId=randomUUID(),versionId=randomUUID(),requestId=randomUUID();
const inputs={
 'subject.create':{projectId,kind:'character',name:'Character',assetId,requestId},
 'subject.version.add':{projectId,subjectId,assetId,expectedRevision:1,requestId},
 'subject.binding.set':{projectId,subjectId,shotId,role:'subject',subjectVersionId:versionId,expectedRevision:0,expectedSubjectRevision:1,requestId},
};
const version={id:versionId,projectId,subjectId,number:1,assetId,sha256:'a'.repeat(64),mimeType:'image/png',width:100,height:100,provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null},createdAt:'2026-10-10T00:00:00Z'};
const subject={id:subjectId,projectId,kind:'character',name:'Character',revision:1,headVersionId:versionId,headVersion:version,createdAt:version.createdAt,updatedAt:version.createdAt};
const binding={id:randomUUID(),projectId,subjectId,shotId,role:'subject',revision:1,subjectVersionId:versionId,reviewedHeadVersionId:versionId,headVersionId:versionId,subjectRevision:1,needsReview:false,createdAt:version.createdAt,updatedAt:version.createdAt};

test('all subject mutations use strict bounded required-key inputs and explicit metadata-only effects',()=>{
 assert.deepEqual(SUBJECT_MUTATION_OPERATIONS,Object.keys(inputs));assert.equal(SUBJECT_LIMITS.inputBytes,8192);
 for(const [operation,input] of Object.entries(inputs)){
  assert.deepEqual(parse(operation,input),input);assert.ok(jsonSchema(schemas[operation]).required.includes('requestId'));
  const {requestId,...keyless}=input;assert.throws(()=>parse(operation,keyless),{code:'VALIDATION_ERROR'});
  for(const requestId of ['', 'x'.repeat(7),'x'.repeat(201),null])assert.throws(()=>parse(operation,{...input,requestId}),{code:'VALIDATION_ERROR'});
  for(const extra of [{url:'https://example.test'},{path:'/tmp/a'},{dataBase64:'AA=='},{provenance:'user-import'},{providerId:'mock'}])assert.throws(()=>parse(operation,{...input,...extra}),{code:'VALIDATION_ERROR'});
  const effect=operationEffects[operation];assert.equal(effect.databaseWrite,true);assert.equal(effect.idempotent,true);assert.equal(effect.readOnly,false);
  for(const field of ['fileWrite','externalIO','localProcess','paidGeneration','openWorld'])assert.equal(effect[field],false);
 }
 for(const name of ['',' '.repeat(5),'x'.repeat(121)])assert.throws(()=>parse('subject.create',{...inputs['subject.create'],name}),{code:'VALIDATION_ERROR'});
 for(const role of ['first_frame','last_frame','motion','character'])assert.throws(()=>parse('subject.binding.set',{...inputs['subject.binding.set'],role}),{code:'VALIDATION_ERROR'});
 assert.equal(parse('subject.binding.set',{...inputs['subject.binding.set'],subjectVersionId:null}).subjectVersionId,null);
});

test('strict acknowledgements bind intent and frozen ownership without claiming freshness',()=>{
 assert.equal(isSubjectResponse(subject),true);assert.equal(isSubjectMutationResponse('subject.create',inputs['subject.create'],subject),true);
 assert.equal(isSubjectBindingResponse(binding),true);assert.equal(isSubjectMutationResponse('subject.binding.set',inputs['subject.binding.set'],binding),true);
 for(const patch of [{projectId:randomUUID()},{revision:2},{name:'Wrong'},{headVersion:{...version,assetId:randomUUID()}},{extra:true}])assert.equal(isSubjectMutationResponse('subject.create',inputs['subject.create'],{...subject,...patch}),false);
 for(const patch of [{subjectId:randomUUID()},{shotId:randomUUID()},{role:'style'},{revision:2},{subjectVersionId:null},{subjectRevision:2},{needsReview:true},{headVersionId:randomUUID()},{extra:true}])assert.equal(isSubjectMutationResponse('subject.binding.set',inputs['subject.binding.set'],{...binding,...patch}),false);
 const updated={...subject,revision:2,headVersion:{...version,number:2}};assert.equal(isSubjectMutationResponse('subject.version.add',inputs['subject.version.add'],updated),true);
 assert.equal(isSubjectResponse({...subject,headVersion:{...version,provenance:{...version.provenance,jobId:randomUUID()}}}),false);
});

test('read contracts require one binding filter, bounded pages and exact response identities',()=>{
 for(const operation of ['subject.list','subject.version.list','subject.binding.list']){
  assert.equal(operationEffects[operation].readOnly,true);assert.equal(operationEffects[operation].databaseWrite,false);
  const input={projectId,...(operation==='subject.version.list'?{subjectId}:operation==='subject.binding.list'?{shotId}:{})};
  assert.equal(isSubjectListResponse(operation,input,{projectId,items:[],nextCursor:null}),true);
  for(const limit of [0,51,1.5])assert.throws(()=>parse(operation,{...input,limit}),{code:'VALIDATION_ERROR'});
 }
 for(const input of [{projectId},{projectId,shotId,subjectId}])assert.throws(()=>parse('subject.binding.list',input),{code:'VALIDATION_ERROR'});
 const input={projectId,shotId},result={projectId,items:[binding],nextCursor:null};assert.equal(isSubjectListResponse('subject.binding.list',input,result),true);
 assert.equal(isSubjectListResponse('subject.binding.list',{...input,shotId:randomUUID()},result),false);assert.equal(isSubjectListResponse('subject.binding.list',input,{...result,items:[binding,binding]}),false);
});
