import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {samplePeakOperation as operation,samplePeakInput as input} from './helpers/export-sample-peak-fixture.ts';
const deferred=<T = unknown>()=>{let resolve!: (value?: T | PromiseLike<T>) => void;const promise=new Promise<T>(r=>{resolve=(r as (value?: T | PromiseLike<T>) => void);});return {promise,resolve};};
for(const trigger of ['aborted','close'])test(`sample peak ${trigger} cancels only its explicit observer and detaches listeners`,async()=>{
  const req=new EventEmitter(),res=new EventEmitter() as EventEmitter & {destroyed?:boolean;writableFinished?:boolean},entered=deferred(),stopped=deferred();let signal: AbortSignal,calls=0;
  const context={expectedWorkspaceOrigin:'synthetic-origin'};
  const promise=callObservedRpc((req as unknown as Parameters<typeof callObservedRpc>[0]),(res as unknown as Parameters<typeof callObservedRpc>[1]),{call:async(op,body,options)=>{calls++;assert.equal(op,operation);assert.deepEqual(body,input);
    assert.equal(options!.expectedWorkspaceOrigin,context.expectedWorkspaceOrigin);signal=options!.signal as AbortSignal;
    signal.addEventListener('abort',()=>stopped.resolve!(),{once:true});entered.resolve!();await stopped.promise;return {stopped:true};}},operation,input,context);
  await entered.promise;assert.equal(signal!.aborted,false);(trigger==='aborted'?req:res).emit(trigger);
  assert.deepEqual(await promise,{stopped:true});assert.equal(signal!.aborted,true);assert.equal(calls,1);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('already-disconnected sample peak is aborted before service entry and cleanup survives rejection',async()=>{
  const req=new EventEmitter(),res=new EventEmitter() as EventEmitter & {destroyed?:boolean;writableFinished?:boolean};res.destroyed=true;
  await assert.rejects(callObservedRpc((req as unknown as Parameters<typeof callObservedRpc>[0]),(res as unknown as Parameters<typeof callObservedRpc>[1]),{call:(async(_op: string,_input: unknown,{signal}: {signal: AbortSignal})=>{assert.equal(signal.aborted,true);throw Error('Stopped');}) as unknown as import('../apps/server/src/rpc-observation.ts').ObservedRpcService['call']},operation,input),/Stopped/);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('finished response and post-settlement close do not cancel sample peak',async()=>{
  const req=new EventEmitter(),res=new EventEmitter() as EventEmitter & {destroyed?:boolean;writableFinished?:boolean};let signal: AbortSignal;
  const result=await callObservedRpc((req as unknown as Parameters<typeof callObservedRpc>[0]),(res as unknown as Parameters<typeof callObservedRpc>[1]),{call:async(_op,_input,options)=>{signal=options!.signal as AbortSignal;res.writableFinished=true;res.emit('close');return 1;}},operation,input);
  assert.equal(result,1);assert.equal(signal!.aborted,false);res.writableFinished=false;res.emit('close');req.emit('aborted');assert.equal(signal!.aborted,false);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
for(const other of ['timeline.render','export.create','project.list','asset.waveform.request','future.operation'])
  test(`${other} keeps its old observation behavior`,async()=>{
    const req=new EventEmitter(),res=new EventEmitter(),context={sentinel:true};let seen: Record<string, unknown> | undefined;
    assert.equal(await callObservedRpc((req as unknown as Parameters<typeof callObservedRpc>[0]),(res as unknown as Parameters<typeof callObservedRpc>[1]),{call:async(op,_input,options)=>{assert.equal(op,other);seen=options;req.emit('aborted');res.emit('close');return 2;}},other,{},context),2);
    assert.equal(seen,context);assert.equal((seen as Record<string, unknown>).signal,undefined);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
  });
