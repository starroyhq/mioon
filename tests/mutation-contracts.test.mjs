import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {jsonSchema} from '@mioon/client';
import {parse,schemas,LOCAL_MUTATION_OPERATIONS,operationEffects,effectAnnotations} from '@mioon/contracts';

const projectId=randomUUID(),shotId=randomUUID(),nodeId=randomUUID(),versionId=randomUUID();
const inputs={
 'shot.create':{projectId,title:'A shot'},
 'shot.update':{shotId,expectedRevision:1,patch:{prompt:'A prompt'}},
 'shot.reorder':{projectId,expectedRevision:1,shotIds:[shotId]},
 'node.create':{projectId,type:'text',position:{x:0,y:0}},
 'node.update':{nodeId,expectedRevision:1,patch:{}},
 'version.select':{shotId,versionId,expectedRevision:1},
};

test('exactly six existing local schemas accept an optional stable replay key without filling defaults',()=>{
 assert.deepEqual(LOCAL_MUTATION_OPERATIONS,[...Object.keys(inputs),'asset.range.set']);assert.ok(Object.isFrozen(LOCAL_MUTATION_OPERATIONS));
 for(const [operation,input] of Object.entries(inputs)){
  assert.deepEqual(parse(operation,input),input);
  for(const requestId of ['a'.repeat(8),randomUUID(),'b'.repeat(200)])
   assert.deepEqual(parse(operation,{...input,requestId}),{requestId,...input});
  for(const requestId of ['', 'a'.repeat(7), 'a'.repeat(201), null, 42, {}])
   assert.throws(()=>parse(operation,{...input,requestId}),{code:'VALIDATION_ERROR'});
  assert.throws(()=>parse(operation,{...input,requestId:randomUUID(),extra:true}),{code:'VALIDATION_ERROR'});
 }
 const absent=parse('shot.create',inputs['shot.create']);
 assert.ok(!Object.hasOwn(absent,'prompt'));assert.ok(!Object.hasOwn(absent,'referenceAssetIds'));
 assert.ok(!Object.hasOwn(absent,'requestId'));
 assert.deepEqual(parse('shot.create',{...absent,prompt:'',referenceAssetIds:[]}),{...absent,prompt:'',referenceAssetIds:[]});
});

test('local replay remains explicitly opt-in in discovery and unconditional idempotent hints remain false',()=>{
 for(const operation of Object.keys(inputs)){
  const schema=jsonSchema(schemas[operation]);
  assert.equal(schema.properties.requestId.minLength,8);assert.equal(schema.properties.requestId.maxLength,200);
  assert.ok(!schema.required.includes('requestId'));assert.match(schema.properties.requestId.description,/Optional stable replay key/);
  assert.equal(operationEffects[operation].idempotent,false);assert.equal(effectAnnotations(operationEffects[operation]).idempotentHint,false);
  assert.equal(operationEffects[operation].databaseWrite,true);
  for(const field of ['fileWrite','externalIO','localProcess','paidGeneration'])assert.equal(operationEffects[operation][field],false);
  assert.match(operationEffects[operation].notes,/optional stable requestId/);
 }
});

test('project, edge and import operations do not gain optional local replay keys',()=>{
 const cases={
  'project.create':{name:'Still keyless'},
  'edge.create':{projectId,source:nodeId,target:shotId},
  'edge.delete':{edgeId:randomUUID()},
  'asset.import':{projectId,name:'Fixture',mimeType:'image/png',dataBase64:'AA=='},
 };
 for(const [operation,input] of Object.entries(cases))
  assert.throws(()=>parse(operation,{...input,requestId:randomUUID()}),{code:'VALIDATION_ERROR'});
 assert.equal(operationEffects['generation.submit'].idempotent,true);
 assert.equal(operationEffects['reference.attach'].idempotent,true);
 assert.equal(operationEffects['timeline.clip.add'].idempotent,true);
});
