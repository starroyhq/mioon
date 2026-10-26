import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parse,schemas,descriptions,sourceFrameCount,SOURCE_RANGE_FPS,isSourceRangeResponse,LOCAL_MUTATION_OPERATIONS,isLocalMutationResponse,operationEffects,effectAnnotations} from '@mioon/contracts';
import {jsonSchema} from '@mioon/client';

const projectId=randomUUID(),assetId=randomUUID();
const input={projectId,assetId,expectedRevision:0,requestId:randomUUID(),inFrame:0,outFrame:30};
const response={id:assetId,assetId,projectId,revision:1,range:{inFrame:0,outFrame:30},sourceFrameCount:60,fps:30};
test('source range schemas are strict, require stable keys, and use safe independent frame/revision bounds',()=>{
 assert.deepEqual(parse('asset.range.get',{projectId,assetId}),{projectId,assetId});
 assert.deepEqual(parse('asset.range.set',input),input);
 for(const field of ['projectId','assetId'])for(const value of [null,42,'invalid',undefined])
  assert.throws(()=>parse('asset.range.get',{projectId,assetId,[field]:value}),{code:'VALIDATION_ERROR'});
 for(const requestId of [undefined,null,'a'.repeat(7),'a'.repeat(201),123])
  assert.throws(()=>parse('asset.range.set',{...input,requestId}),{code:'VALIDATION_ERROR'});
 for(const field of ['inFrame','outFrame','expectedRevision'])for(const value of [-1,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'1',null])
  assert.throws(()=>parse('asset.range.set',{...input,[field]:value}),{code:'VALIDATION_ERROR'});
 for(const range of [{inFrame:1,outFrame:1},{inFrame:2,outFrame:1},{inFrame:0,outFrame:0}])
  assert.throws(()=>parse('asset.range.set',{...input,...range}),{code:'VALIDATION_ERROR'});
 for(const operation of ['asset.range.get','asset.range.set'] as const)
  assert.throws(()=>parse(operation,{...(operation.endsWith('get')?{projectId,assetId}:input),extra:true}),{code:'VALIDATION_ERROR'});
 const maximum={...input,expectedRevision:Number.MAX_SAFE_INTEGER,inFrame:Number.MAX_SAFE_INTEGER-1,outFrame:Number.MAX_SAFE_INTEGER};
 assert.deepEqual(parse('asset.range.set',maximum),maximum);
 assert.equal(parse('asset.range.set',{...input,outFrame:18001}).outFrame,18001);
});
test('shared source frame conversion handles whole-frame tolerance and rejects unknown or unsafe duration',()=>{
 assert.equal(SOURCE_RANGE_FPS,30);
 for(const [duration,frames] of [[1/30,1],[2,60],[2.001,60],[2-1e-10,60],[1.999,59],[1000,30000]])assert.equal(sourceFrameCount(duration),frames);
 for(const duration of [undefined,null,'2',NaN,Infinity,-Infinity,-1,0,0.001,Number.MAX_VALUE,Number.MAX_SAFE_INTEGER])assert.equal(sourceFrameCount(duration),null);
});
test('source-range acknowledgement binds exact asset, project, range, and accepted revision without requiring latest state',()=>{
 assert.ok(LOCAL_MUTATION_OPERATIONS.includes('asset.range.set'));
 assert.ok(isSourceRangeResponse({...response,revision:0,range:null}));
 assert.ok(isSourceRangeResponse(response));
 assert.ok(isLocalMutationResponse('asset.range.set',input,response,{projectId}));
 const invalid=[{...response,id:randomUUID()},{...response,assetId:randomUUID()},{...response,projectId:randomUUID()},
  {...response,revision:0,range:null},{...response,revision:2},{...response,revision:Number.MAX_SAFE_INTEGER+1},
  {...response,range:{inFrame:1,outFrame:30}},{...response,range:{inFrame:0,outFrame:29}},
  {...response,range:{inFrame:0,outFrame:30,extra:true}},{...response,sourceFrameCount:29},
  {...response,fps:29.97},{...response,range:null},{...response,extra:'unsafe'},
  {...response,sourceFrameCount:Infinity}];
 for(const value of invalid)assert.equal(isLocalMutationResponse('asset.range.set',input,value),false);
 assert.equal(isLocalMutationResponse('asset.range.set',input,response,{projectId:randomUUID()}),false);
 assert.equal(isLocalMutationResponse('asset.range.get',input,response),false);
});
test('discovery describes required-key metadata-only save and noncreating read accurately',()=>{
 const get=operationEffects['asset.range.get'],set=operationEffects['asset.range.set'];
 assert.equal(get.readOnly,true);assert.equal(get.databaseWrite,false);assert.equal(get.idempotent,true);
 assert.equal(set.readOnly,false);assert.equal(set.databaseWrite,true);assert.equal(set.idempotent,true);
 for(const effects of [get,set])for(const field of ['fileWrite','externalIO','localProcess','paidGeneration','openWorld'] as const)assert.equal(effects[field],false);
 assert.equal(effectAnnotations(set).idempotentHint,true);
 const schema=jsonSchema(schemas['asset.range.set']) as {required: string[]; properties: {requestId: {minLength: number; maxLength: number; description: string}}};
 assert.ok(schema.required.includes('requestId'));assert.equal(schema.properties.requestId.minLength,8);assert.equal(schema.properties.requestId.maxLength,200);
 assert.match(schema.properties.requestId.description,/Required stable replay key/);assert.match(set.notes!,/Requires a stable requestId/);
 assert.ok(descriptions['asset.range.get']);assert.ok(descriptions['asset.range.set']);
 // Existing optional-key operation effects and keyless schemas remain intact.
 for(const operation of ['shot.create','shot.update','shot.reorder','node.create','node.update','version.select'] as const){
  assert.equal(operationEffects[operation].idempotent,false);assert.ok(!(jsonSchema(schemas[operation]).required as string[]).includes('requestId'));
 }
});
