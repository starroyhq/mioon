import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {schemas,operationEffect} from '../packages/contracts/src/index.ts';
import {lutImportInputSchema,lutResourceSchema,lutListResponseSchema,lutRestorePolicy,LUT_RESOURCE_LIMITS} from '../packages/contracts/src/lut-resources.ts';
import {isLutRpcResponse} from '../packages/client/src/lut-resources.ts';
import {createClient,discoverSchema} from '../packages/client/src/index.ts';
import {ReadBuffer,STDIO_DEFAULT_MAX_BUFFER_SIZE} from '../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js';
interface DiscoveryView { toolName: string; command: string; requiresRequestId?: boolean; effects: { paidGeneration: boolean; localProcess: boolean; externalIO: boolean } }
interface OperationEffectView { idempotent?: boolean; databaseWrite?: boolean; readOnly?: boolean }
interface RpcFailureDetails { requestId?: string; operation?: string; submissionMayHaveSucceeded?: boolean }
interface RpcFailure { code?: string; details?: RpcFailureDetails }
const projectId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const input={projectId,requestId:'shared-client-lut-request',name:'look.cube',dataBase64:bytes.toString('base64')};
const resource={id,projectId,name:input.name,kind:'cube3d',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,
 profile:'mioon-cube3d-normalized-tetrahedral-v1',metadata:{profileId:'mioon-cube3d-normalized-tetrahedral-v1',size:2,title:null,domainMin:[0,0,0],domainMax:[1,1,1],rowCount:8,rowOrder:'red-fastest',interpolation:'tetrahedral',numericPrecision:'float64'},createdAt:'2026-10-14T00:00:00.000Z',colourCompatibility:'unverified',renderBinding:'not_implemented'};
const ack={requestId:input.requestId,resource};
test('shared strict RPC discovery separates resources from media and grading',()=>{
 for(const operation of ['lut.import','lut.list','lut.inspect']){
  assert.ok((schemas as Record<string, unknown>)[operation]);const schema=discoverSchema({operation}) as unknown as DiscoveryView;assert.equal(schema.toolName,operation.replaceAll('.','_'));assert.equal(schema.command,operation.replaceAll('.',' '));assert.equal(schema.effects.paidGeneration,false);assert.equal(schema.effects.localProcess,false);assert.equal(schema.effects.externalIO,false);
 }
 assert.equal((discoverSchema({operation:'lut.import'}) as unknown as DiscoveryView).requiresRequestId,true);assert.equal((operationEffect('lut.import') as unknown as OperationEffectView).idempotent,true);assert.equal((operationEffect('lut.import') as unknown as OperationEffectView).databaseWrite,true);
 for(const op of ['lut.list','lut.inspect'])assert.equal((operationEffect(op) as unknown as OperationEffectView).readOnly,true);
 for(const extra of [{path:'/private/x.cube'},{mimeType:'application/cube'},{strength:1},{clipId:id},{colourSpace:'sdr'},{profile:'anything'}])assert.equal(lutImportInputSchema.safeParse({...input,...extra}).success,false);
 for(const field of ['content','dataBase64','relativePath','url'])assert.equal(lutResourceSchema.safeParse({...resource,[field]:'secret'}).success,false);
});
test('Node ACK guard independently hashes submitted exact bytes, rejecting mismatched identity',()=>{
 assert.equal(isLutRpcResponse('lut.import',input,ack),true);
 for(const patch of [{sha256:'f'.repeat(64)},{sizeBytes:bytes.length+1},{projectId:id},{name:'other.cube'},{profile:'other'},{colourCompatibility:'sdr'},{renderBinding:'applied'}])
  assert.equal(isLutRpcResponse('lut.import',input,{...ack,resource:{...resource,...patch}}),false);
 assert.equal(isLutRpcResponse('lut.import',{...input,dataBase64:Buffer.concat([bytes,Buffer.from('\n')]).toString('base64')},ack),false);
 assert.equal(isLutRpcResponse('lut.import',input,{...ack,requestId:'different-request'}),false);
});
test('inspect and listing guards enforce requested scope, sorted unique page and cursor',()=>{
 assert.equal(isLutRpcResponse('lut.inspect',{projectId,lutId:id},{resource,integrity:'verified'}),true);
 assert.equal(isLutRpcResponse('lut.inspect',{projectId,lutId:projectId},{resource,integrity:'verified'}),false);
 const page={projectId,items:[resource],nextAfter:null};assert.equal(lutListResponseSchema.safeParse(page).success,true);assert.equal(isLutRpcResponse('lut.list',{projectId,limit:2},page),true);
 for(const changed of [{...page,projectId:id},{...page,items:[resource,resource]},{...page,nextAfter:id}])assert.equal(isLutRpcResponse('lut.list',{projectId,limit:2},changed),false);
});
test('full maximum MCP message including worst escaped fields remains under unchanged10MiB cap',()=>{
 // Base64 has no JSON escaping. Worst bounded names/requests contain200 ASCII
 // controls, encoded as six-byte escapes. UUID and method/envelope remain fixed.
 const largest={...input,name:'\u0001'.repeat(200),requestId:'\u0002'.repeat(200),dataBase64:Buffer.alloc(LUT_RESOURCE_LIMITS.sourceBytes,32).toString('base64')};
 assert.equal(lutImportInputSchema.safeParse(largest).success,true);
 const message={jsonrpc:'2.0',id:9007199254740991,method:'tools/call',params:{name:'lut_import',arguments:largest}};
 const wire=Buffer.from(JSON.stringify(message)+'\n');assert.equal(STDIO_DEFAULT_MAX_BUFFER_SIZE,10*1024*1024);assert.ok(wire.length<STDIO_DEFAULT_MAX_BUFFER_SIZE-512*1024);
 const buffer=new ReadBuffer();buffer.append(wire);assert.deepEqual(buffer.readMessage(),message);
 assert.ok(Buffer.byteLength(JSON.stringify({operation:'lut.import',input:largest}))<42*1024*1024);
});
test('shared client rejects bad ACK with exact request recovery, and never retries on failure',async()=>{
 let calls=0;const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:9999',MIOON_TOKEN:'a'.repeat(64)},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:true,data:{...ack,resource:{...resource,sha256:'a'.repeat(64)}}}),{status:200});}});
 await assert.rejects(client.rpc('lut.import',input),(error: unknown)=>{const failure=error as RpcFailure;return failure.code==='BACKEND_PROTOCOL_ERROR'&&failure.details?.requestId===input.requestId&&failure.details?.submissionMayHaveSucceeded===true;});assert.equal(calls,1);
 const down=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:9999',MIOON_TOKEN:'a'.repeat(64)},fetchImpl:async()=>{calls++;throw Error('Disconnected');}});
 await assert.rejects(down.rpc('lut.import',input),(error: unknown)=>{const failure=error as RpcFailure;return failure.code==='BACKEND_UNAVAILABLE'&&failure.details?.requestId===input.requestId&&failure.details?.submissionMayHaveSucceeded===true;});assert.equal(calls,2);
});
test('restored LUT disclosure is profile-specific; import is unavailable and no media/effect backdoor exists',()=>{
 for(const version of [25,27,29])for(const operation of ['lut.import','lut.list','lut.inspect'])assert.equal(lutRestorePolicy(operation,version).available,version===29&&operation!=='lut.import');
 assert.equal(schemas['asset.import'].safeParse({...input,mimeType:'application/cube'}).success,false);
 const leaf=readFileSync(new URL('../packages/business/src/lut-resources.ts',import.meta.url),'utf8');
 for(const banned of ['node:fs','node:child_process','node:http','node:https','fetch(','ffmpeg','createProviderRegistry'])assert.equal(leaf.includes(banned),false,banned);
 const contract=readFileSync(new URL('../packages/contracts/src/lut-resources.ts',import.meta.url),'utf8');assert.equal(contract.includes('node:'),false,'browser-facing contracts remain platform-neutral');
});

test('explicit uncertain server result retains exact request recovery information',async()=>{
 let calls=0;const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:9999',MIOON_TOKEN:'a'.repeat(64)},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:false,error:{code:'LUT_IMPORT_UNCERTAIN',message:'Replay exact input',details:{}}}),{status:503});}});
 await assert.rejects(client.rpc('lut.import',input),(error: unknown)=>{const failure=error as RpcFailure;return failure.code==='LUT_IMPORT_UNCERTAIN'&&failure.details?.requestId===input.requestId&&failure.details?.operation==='lut.import'&&failure.details?.submissionMayHaveSucceeded===true;});assert.equal(calls,1);
});
