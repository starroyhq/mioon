import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,descriptions,ASSET_DISPOSITIONS,ASSET_DISPOSITION_BATCH_LIMIT,isAssetDispositionResponse,isAssetDispositionListResponse,LOCAL_MUTATION_OPERATIONS,isLocalMutationResponse,operationEffects,effectAnnotations} from '@mioon/contracts';
import {jsonSchema} from '@mioon/client';

const projectId=randomUUID(),assetId=randomUUID();
const input={projectId,assetId,expectedRevision:0,requestId:randomUUID(),disposition:'favorite'};
const response={id:assetId,assetId,projectId,revision:1,disposition:'favorite'};

test('disposition schemas require a strict explicit bounded unique batch and stable keyed enum writes',()=>{
 assert.deepEqual(ASSET_DISPOSITIONS,['neutral','favorite','rejected']);assert.ok(Object.isFrozen(ASSET_DISPOSITIONS));
 assert.equal(ASSET_DISPOSITION_BATCH_LIMIT,100);
 for(const size of [1,100]){
  const value={projectId,assetIds:Array.from({length:size},()=>randomUUID())};
  assert.deepEqual(parse('asset.disposition.list',value),value);
 }
 for(const assetIds of [undefined,null,[],[assetId,assetId],Array.from({length:101},()=>randomUUID()),[null],['invalid'],assetId])
  assert.throws(()=>parse('asset.disposition.list',{projectId,assetIds}),{code:'VALIDATION_ERROR'});
 for(const value of [undefined,null,'invalid',1]){
  assert.throws(()=>parse('asset.disposition.list',{projectId:value,assetIds:[assetId]}),{code:'VALIDATION_ERROR'});
  for(const field of ['projectId','assetId'])assert.throws(()=>parse('asset.disposition.set',{...input,[field]:value}),{code:'VALIDATION_ERROR'});
 }
 for(const disposition of ASSET_DISPOSITIONS)assert.deepEqual(parse('asset.disposition.set',{...input,disposition}),{...input,disposition});
 for(const disposition of [undefined,null,'liked','Favorite','',true,{}])assert.throws(()=>parse('asset.disposition.set',{...input,disposition}),{code:'VALIDATION_ERROR'});
 for(const requestId of [undefined,null,'a'.repeat(7),'a'.repeat(201),1])assert.throws(()=>parse('asset.disposition.set',{...input,requestId}),{code:'VALIDATION_ERROR'});
 for(const requestId of ['😀'.repeat(4),'😀'.repeat(100)])assert.equal(parse('asset.disposition.set',{...input,requestId}).requestId,requestId);
 for(const expectedRevision of [-1,.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'0',null])
  assert.throws(()=>parse('asset.disposition.set',{...input,expectedRevision}),{code:'VALIDATION_ERROR'});
 assert.equal(parse('asset.disposition.set',{...input,expectedRevision:Number.MAX_SAFE_INTEGER}).expectedRevision,Number.MAX_SAFE_INTEGER);
 const operationCases: [string, Record<string, unknown>][] = [['asset.disposition.list',{projectId,assetIds:[assetId]}],['asset.disposition.set',input]];
 for(const [operation,value] of operationCases)
  assert.throws(()=>parse(operation as never,{...value,extra:true} as never),{code:'VALIDATION_ERROR'});
});

test('acknowledgements bind exact disposition identity and accepted revision while allowing historical replay',()=>{
 assert.ok(isAssetDispositionResponse({...response,revision:0,disposition:'neutral'}));
 assert.ok(isAssetDispositionResponse(response));assert.ok(isLocalMutationResponse('asset.disposition.set',input,response,{projectId}));
 for(const patch of [{id:randomUUID()},{assetId:randomUUID()},{projectId:randomUUID()},{revision:0},{revision:2},
  {revision:Number.MAX_SAFE_INTEGER+1},{revision:.5},{revision:Infinity},{disposition:'neutral'},{disposition:'rejected'},
  {disposition:'unknown'},{extra:'private'}])assert.equal(isLocalMutationResponse('asset.disposition.set',input,{...response,...patch}),false);
 for(const value of [null,[],{}, {...response,assetId:'bad',id:'bad'}, {...response,projectId:'bad'}, {...response,revision:0}])
  assert.equal(isAssetDispositionResponse(value),false);
 assert.equal(isLocalMutationResponse('asset.disposition.set',input,response,{projectId:randomUUID()}),false);
 assert.equal(isLocalMutationResponse('asset.disposition.list',input,response),false);
 const reset={...input,expectedRevision:4,disposition:'neutral'};
 assert.ok(isLocalMutationResponse('asset.disposition.set',reset,{...response,revision:5,disposition:'neutral'}));
});

test('list acknowledgements require exact ordered membership and never confirm omitted or malformed defaults',()=>{
 const otherId=randomUUID(),other={...response,id:otherId,assetId:otherId,revision:0,disposition:'neutral'};
 const query={projectId,assetIds:[assetId,otherId]},list={projectId,items:[response,other]};
 assert.ok(isAssetDispositionListResponse(list,query));assert.ok(isAssetDispositionListResponse(list));
 for(const value of [null,[],{}, {...list,extra:true},{...list,projectId:randomUUID()}, {...list,items:[]},
  {...list,items:[response]}, {...list,items:[other,response]}, {...list,items:[response,response]},
  {...list,items:[response,{...other,projectId:randomUUID()}]}, {...list,items:[response,{...other,extra:true}]},
  {...list,items:[response,{...other,disposition:'favorite'}]}])assert.equal(isAssetDispositionListResponse(value,query),false);
 assert.equal(isAssetDispositionListResponse(list,{...query,assetIds:[assetId,assetId]}),false);
});

test('discovery exposes bounded noncreating reads and required-key metadata-only writes, retaining six optional-key semantics',()=>{
 assert.ok(LOCAL_MUTATION_OPERATIONS.includes('asset.disposition.set'));assert.equal(LOCAL_MUTATION_OPERATIONS.length,12);
 const list=operationEffects['asset.disposition.list'],set=operationEffects['asset.disposition.set'];
 assert.equal(list.readOnly,true);assert.equal(list.databaseWrite,false);assert.equal(list.idempotent,true);
 assert.equal(set.readOnly,false);assert.equal(set.databaseWrite,true);assert.equal(set.idempotent,true);
 for(const effects of [list,set])for(const field of ['fileWrite','externalIO','localProcess','paidGeneration','openWorld'])assert.equal((effects as unknown as Record<string, unknown>)[field],false);
 assert.equal(effectAnnotations(set).idempotentHint,true);
 interface JsonSchemaView { required: string[]; properties: Record<string, { minLength?: number; maxLength?: number; description?: string; minItems?: number; maxItems?: number }> }
 const schema=jsonSchema(schemas['asset.disposition.set']) as unknown as JsonSchemaView,batch=jsonSchema(schemas['asset.disposition.list']) as unknown as JsonSchemaView;
 assert.ok(schema.required.includes('requestId'));assert.equal(schema.properties.requestId.minLength,8);assert.equal(schema.properties.requestId.maxLength,200);
 assert.match(String(schema.properties.requestId.description),/Required stable replay key/);assert.match(String(set.notes),/Requires a stable requestId/);
 assert.ok(batch.required.includes('assetIds'));assert.equal(batch.properties.assetIds.minItems,1);assert.equal(batch.properties.assetIds.maxItems,100);
 for(const operation of ['asset.disposition.list','asset.disposition.set'])assert.ok(descriptions[operation]);
 const effectCatalog=operationEffects as unknown as Record<string, { idempotent?: boolean }>,schemaCatalog=schemas as unknown as Record<string, unknown>;
 for(const operation of LOCAL_MUTATION_OPERATIONS.slice(0,6)){
  assert.equal(effectCatalog[operation]?.idempotent,false);assert.ok(!(jsonSchema(schemaCatalog[operation] as never) as unknown as JsonSchemaView).required.includes('requestId'));
 }
});
