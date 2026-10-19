import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createClient} from '../packages/client/src/index.ts';
import {canonicalImageInput} from '../packages/contracts/src/images.ts';
import {errorView, type ErrorView} from './helpers/test-error.ts';

interface ObservationInput {projectId: string; taskId: string; expectedRevision: number; requestId: string; [key: string]: unknown}
interface Ack {id: string; projectId: string; taskId: string; requestId: string; state: string; revision: number; remoteRevision: number; createdAt: string}
interface Fixture {input: ObservationInput; ack: Ack}
interface ResponseView {ok: boolean; status: number; json: () => Promise<unknown>}
interface ErrorPayload {code: string; message: string; details: {observation?: Record<string, unknown>}}
const clientFailure = (cause: unknown): ErrorView & {details: {submissionMayHaveSucceeded?: boolean; requestId?: string; observation?: {inputHash?: string}}} => errorView(cause) as ErrorView & {details: {submissionMayHaveSucceeded?: boolean; requestId?: string; observation?: {inputHash?: string}}};
const env={MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:'synthetic-comfy-client-token'};
const at='2026-10-10T00:00:00.000Z',operation='image.task.observeRemote';
function fixture(): Fixture {const input={projectId:randomUUID(),taskId:randomUUID(),expectedRevision:3,requestId:randomUUID()};return {input,ack:{id:randomUUID(),projectId:input.projectId,taskId:input.taskId,requestId:input.requestId,state:'queued',revision:1,remoteRevision:4,createdAt:at}};}
function harness(respond: (call: number) => ResponseView | Promise<ResponseView>): {client: ReturnType<typeof createClient>; calls: {operation: string; input: unknown}[]} {const calls: {operation: string; input: unknown}[] = [],client=createClient({env,fetchImpl:(async(_url: string,options: RequestInit)=>{calls.push(JSON.parse(String(options.body)));return respond(calls.length);}) as unknown as typeof fetch});return {client,calls};}
const response=(data: unknown,status=200): ResponseView=>({ok:status>=200&&status<300,status,json:async()=>data});
const okay=(data: unknown): ResponseView=>response({ok:true,data});
function proof(input: ObservationInput): Record<string, unknown> {return {outcome:'not_accepted',operation,projectId:input.projectId,taskId:input.taskId,requestId:input.requestId,inputHash:createHash('sha256').update(canonicalImageInput(input)).digest('hex')};}
test('Comfy client validates exact admission identity and never retries invalid/lost acknowledgements',async()=>{
 const {input,ack}=fixture(),original=structuredClone(input);
 for(const value of [null,{}, {...ack,remoteRevision:3},{...ack,requestId:randomUUID()},{...ack,taskId:randomUUID()},{...ack,projectId:randomUUID()},{...ack,state:'finished'},{...ack,revision:2},{...ack,extra:true}]){
  const f=harness(()=>okay(value));await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>{const failure=clientFailure(cause);return failure.code==='BACKEND_PROTOCOL_ERROR'&&failure.details.submissionMayHaveSucceeded===true&&failure.details.requestId===input.requestId;});
  assert.deepEqual(f.calls,[{operation,input:original}]);assert.deepEqual(input,original);
 }
 const f=harness(()=>{throw new Error('lost acknowledgement');});await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>{const failure=clientFailure(cause);return failure.code==='BACKEND_UNAVAILABLE'&&failure.details.submissionMayHaveSucceeded===true;});assert.equal(f.calls.length,1);
 const valid=harness(()=>okay(ack));assert.deepEqual(await valid.client.rpc(operation,input),ack);assert.deepEqual(await valid.client.rpc(operation,input),ack);assert.deepEqual(valid.calls,[{operation,input:original},{operation,input:original}]);
});
test('only exact operation/project/task/key/input-hash rejection proof establishes nonadmission',async()=>{
 const {input}=fixture(),base: ErrorPayload={code:'COMFY_REMOTE_REVISION_CONFLICT',message:'Remote record changed',details:{observation:proof(input)}};
 for(const mutate of [(e: ErrorPayload)=>{e.details.observation!.projectId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.taskId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.requestId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.operation='image.generate';},(e: ErrorPayload)=>{e.details.observation!.inputHash='0'.repeat(64);},(e: ErrorPayload)=>{e.details.observation!.inputHash=createHash('sha256').update(canonicalImageInput({...input,expectedRevision:4})).digest('hex');},(e: ErrorPayload)=>{e.details.observation!.outcome='rejected';},(e: ErrorPayload)=>{e.code='COMFY_REMOTE_CONFLICT';},(e: ErrorPayload)=>{delete e.details.observation;}]){
  const error=structuredClone(base);mutate(error);const f=harness(()=>response({ok:false,error},409));
  await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>{const failure=clientFailure(cause);return failure.details.submissionMayHaveSucceeded===true&&failure.details.requestId===input.requestId&&!Object.hasOwn(failure.details,'observation');});assert.equal(f.calls.length,1);
 }
 for(const status of [400,403,500]){const f=harness(()=>response({ok:false,error:base},status));await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>clientFailure(cause).details.submissionMayHaveSucceeded===true);}
 for(const [code,status] of [['COMFY_MODULE_UNAVAILABLE',503],['COMFY_REMOTE_STATE',409],['COMFY_REMOTE_REVISION_CONFLICT',409],['COMFY_REMOTE_BUSY',409],['COMFY_REMOTE_CAPACITY',507]] as const){
  const f=harness(()=>response({ok:false,error:{...base,code}},status));await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>{const failure=clientFailure(cause);return failure.details.submissionMayHaveSucceeded===false&&failure.details.observation?.inputHash===proof(input).inputHash;});assert.equal(f.calls.length,1);
 }
});
test('Comfy local remote read rejects malformed or foreign ownership without accepting it as a result',async()=>{
 const {input}=fixture();for(const data of [null,{}, {projectId:input.projectId,taskId:input.taskId,remote:{},observation:null}]){const f=harness(()=>okay(data));await assert.rejects(f.client.rpc('image.task.remote.get',{projectId:input.projectId,taskId:input.taskId}),{code:'BACKEND_PROTOCOL_ERROR'});assert.equal(f.calls.length,1);}
});

test('unavailable module status alone cannot manufacture observation nonadmission',async()=>{
 const {input}=fixture(),base={code:'COMFY_MODULE_UNAVAILABLE',message:'Module unavailable',details:{observation:proof(input)}};
 for(const mutate of [(e: ErrorPayload)=>{e.details.observation!.projectId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.taskId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.requestId=randomUUID();},(e: ErrorPayload)=>{e.details.observation!.operation='image.generate';},(e: ErrorPayload)=>{e.details.observation!.inputHash='0'.repeat(64);},(e: ErrorPayload)=>{e.details.observation!.outcome='unknown';},(e: ErrorPayload)=>{delete e.details.observation;}]){
  const error=structuredClone(base);mutate(error);const f=harness(()=>response({ok:false,error},503));
  await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>{const failure=clientFailure(cause);return failure.details.submissionMayHaveSucceeded===true&&!Object.hasOwn(failure.details,'observation');});assert.equal(f.calls.length,1);
 }
 for(const status of [400,409,500]){const f=harness(()=>response({ok:false,error:base},status));await assert.rejects(f.client.rpc(operation,input),(cause: unknown)=>clientFailure(cause).details.submissionMayHaveSucceeded===true);}
});
