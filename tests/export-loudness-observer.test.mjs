import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {callObservedRpc} from '../apps/server/src/rpc-observation.mjs';
import {loudnessOperation as operation,loudnessInput as input} from './fixtures/export-loudness-fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
for(const trigger of ['aborted','close'])test(`loudness ${trigger} cancels only its explicit observer and detaches listeners`,async()=>{
  const req=new EventEmitter(),res=new EventEmitter(),entered=deferred(),stopped=deferred();let signal,calls=0;
  const context={expectedWorkspaceOrigin:'synthetic-origin'};
  const promise=callObservedRpc(req,res,{call:async(op,body,options)=>{calls++;assert.equal(op,operation);assert.deepEqual(body,input);
    assert.equal(options.expectedWorkspaceOrigin,context.expectedWorkspaceOrigin);signal=options.signal;
    signal.addEventListener('abort',()=>stopped.resolve(),{once:true});entered.resolve();await stopped.promise;return {stopped:true};}},operation,input,context);
  await entered.promise;assert.equal(signal.aborted,false);(trigger==='aborted'?req:res).emit(trigger);
  assert.deepEqual(await promise,{stopped:true});assert.equal(signal.aborted,true);assert.equal(calls,1);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('already-disconnected loudness is aborted before service entry and cleanup survives rejection',async()=>{
  const req=new EventEmitter(),res=new EventEmitter();res.destroyed=true;
  await assert.rejects(callObservedRpc(req,res,{call:async(_op,_input,{signal})=>{assert.equal(signal.aborted,true);throw Error('Stopped');}},operation,input),/Stopped/);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
test('finished response and post-settlement close do not cancel loudness',async()=>{
  const req=new EventEmitter(),res=new EventEmitter();let signal;
  const result=await callObservedRpc(req,res,{call:async(_op,_input,options)=>{signal=options.signal;res.writableFinished=true;res.emit('close');return 1;}},operation,input);
  assert.equal(result,1);assert.equal(signal.aborted,false);res.writableFinished=false;res.emit('close');req.emit('aborted');assert.equal(signal.aborted,false);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
for(const other of ['timeline.render','export.create','project.list','asset.waveform.request','future.operation'])
  test(`${other} keeps its old observation behavior`,async()=>{
    const req=new EventEmitter(),res=new EventEmitter(),context={sentinel:true};let seen;
    assert.equal(await callObservedRpc(req,res,{call:async(op,_input,options)=>{assert.equal(op,other);seen=options;req.emit('aborted');res.emit('close');return 2;}},other,{},context),2);
    assert.equal(seen,context);assert.equal(seen.signal,undefined);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
  });

test('simultaneous observers cancel independently and leave prior advisory operations unchanged',async()=>{
  const active=[];
  for(const current of [operation,'timeline.export.samplePeak','timeline.export.preflight','timeline.export.capabilities']){
    const req=new EventEmitter(),res=new EventEmitter(),finished=deferred();let signal;
    const promise=callObservedRpc(req,res,{call:async(_op,_body,context)=>{signal=context.signal;await finished.promise;return current;}},current,input);
    active.push({current,req,res,finished,promise,signal});
    assert.equal(signal.aborted,false);
  }
  active[0].req.emit('aborted');assert.equal(active[0].signal.aborted,true);
  for(const item of active.slice(1))assert.equal(item.signal.aborted,false);
  for(const item of active){item.finished.resolve();assert.equal(await item.promise,item.current);
    assert.equal(item.req.listenerCount('aborted'),0);assert.equal(item.res.listenerCount('close'),0);}
});
