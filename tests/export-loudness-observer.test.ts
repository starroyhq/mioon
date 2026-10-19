import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {loudnessOperation as operation,loudnessInput as input} from './fixtures/export-loudness-fixtures.ts';
interface Deferred<T = void> {promise: Promise<T>; resolve: (value: T) => void}
const deferred=<T = void>(): Deferred<T>=>{let resolve!: (value: T) => void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const observe=(req: EventEmitter, res: EventEmitter, service: Parameters<typeof callObservedRpc>[2], op = operation, body: unknown = input, context: Record<string, unknown> = {}): Promise<unknown> =>
  callObservedRpc(req as unknown as IncomingMessage, res as unknown as ServerResponse, service, op, body, context);
for(const trigger of ['aborted','close'])test(`loudness ${trigger} cancels only its explicit observer and detaches listeners`,async()=>{
  const req=new EventEmitter(),res=new EventEmitter(),entered=deferred(),stopped=deferred();let signal!: AbortSignal;let calls=0;
  const context={expectedWorkspaceOrigin:'synthetic-origin'};
  const promise=observe(req,res,{call:async(op: string,body: unknown,options?: Record<string, unknown>)=>{calls++;assert.equal(op,operation);assert.deepEqual(body,input);
    assert.equal(options?.expectedWorkspaceOrigin,context.expectedWorkspaceOrigin);signal=options?.signal as AbortSignal;
    signal.addEventListener('abort',()=>stopped.resolve(),{once:true});entered.resolve();await stopped.promise;return {stopped:true};}},operation,input,context);
  await entered.promise;assert.equal(signal.aborted,false);(trigger==='aborted'?req:res).emit(trigger);
  assert.deepEqual(await promise,{stopped:true});assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('already-disconnected loudness is aborted before service entry and cleanup survives rejection',async()=>{
  const req=new EventEmitter(),res=new EventEmitter();(res as unknown as {destroyed: boolean}).destroyed=true;
  await assert.rejects(observe(req,res,{call:async(_op: string,_input: unknown,serviceContext?: Record<string, unknown>)=>{assert.equal((serviceContext?.signal as AbortSignal).aborted,true);throw Error('Stopped');}}),/Stopped/);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('finished response and post-settlement close do not cancel loudness',async()=>{
  const req=new EventEmitter(),res=new EventEmitter();let signal!: AbortSignal;
  const result=await observe(req,res,{call:async(_op: string,_input: unknown,options?: Record<string, unknown>)=>{signal=options?.signal as AbortSignal;(res as unknown as {writableFinished: boolean}).writableFinished=true;res.emit('close');return 1;}});
  assert.equal(result,1);assert.equal(signal.aborted,false);(res as unknown as {writableFinished: boolean}).writableFinished=false;res.emit('close');req.emit('aborted');assert.equal(signal.aborted,false);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
for(const other of ['timeline.render','export.create','project.list','asset.waveform.request','future.operation'])
  test(`${other} keeps its old observation behavior`,async()=>{
    const req=new EventEmitter(),res=new EventEmitter(),context: Record<string, unknown>={sentinel:true};let seen: Record<string, unknown> | undefined;
    assert.equal(await observe(req,res,{call:async(op: string,_input: unknown,options?: Record<string, unknown>)=>{assert.equal(op,other);seen=options;req.emit('aborted');res.emit('close');return 2;}},other,{},context),2);
    assert.equal(seen,context);assert.equal(seen?.signal,undefined);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
  });

test('simultaneous observers cancel independently and leave prior advisory operations unchanged',async()=>{
  const active: Array<{current: string; req: EventEmitter; res: EventEmitter; finished: Deferred; promise: Promise<unknown>; signal: AbortSignal}>=[];
  for(const current of [operation,'timeline.export.samplePeak','timeline.export.preflight','timeline.export.capabilities']){
    const req=new EventEmitter(),res=new EventEmitter(),finished=deferred();let signal!: AbortSignal;
    const promise=observe(req,res,{call:async(_op: string,_body: unknown,serviceContext?: Record<string, unknown>)=>{signal=serviceContext?.signal as AbortSignal;await finished.promise;return current;}},current,input);
    active.push({current,req,res,finished,promise,signal});
    assert.equal(signal.aborted,false);
  }
  active[0].req.emit('aborted');assert.equal(active[0].signal.aborted,true);
  for(const item of active.slice(1))assert.equal(item.signal.aborted,false);
  for(const item of active){item.finished.resolve();assert.equal(await item.promise,item.current);
    assert.equal(item.req.listenerCount('aborted'),0);assert.equal(item.res.listenerCount('close'),0);}
});
