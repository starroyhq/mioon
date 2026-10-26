import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';

for(const terminal of ['finish','close'])test(`deletion waits for the response ${terminal} and releases both lifecycle listeners`,()=>{
  const response=new EventEmitter(),controller=new AbortController();let observer,unsubscribed=0;
  const gate=createProjectDeletionGate({signal:controller.signal,subscribeMedia:next=>{observer=next;return()=>unsubscribed++;},busy:()=>{throw Error('busy');}});
  gate.track((response as unknown as Parameters<typeof gate.track>[0]));gate.track((response as unknown as Parameters<typeof gate.track>[0]));
  assert.equal(response.listenerCount('finish'),1);assert.equal(response.listenerCount('close'),1);
  gate.rpc((response as unknown as Parameters<typeof gate.rpc>[0]),'asset.list',{projectId:'p'});assert.throws(()=>gate.assertIdle('p'),/busy/);
  response.emit(terminal);assert.doesNotThrow(()=>gate.assertIdle('p'));
  assert.equal(response.listenerCount('finish'),0);assert.equal(response.listenerCount('close'),0);
  const release=gate.hold();gate.track((response as unknown as Parameters<typeof gate.track>[0]));response.emit('close');
  assert.throws(()=>gate.assertIdle('p'),/busy/,'accepted publication still owns its lease after disconnect');
  release();release();assert.doesNotThrow(()=>gate.assertIdle('p'));
  observer!({type:'started',pid:123});assert.throws(()=>gate.assertIdle('p'),/busy/);
  observer!({type:'exited',pid:123});assert.doesNotThrow(()=>gate.assertIdle('p'));
  gate.track((response as unknown as Parameters<typeof gate.track>[0]));gate.rpc((response as unknown as Parameters<typeof gate.rpc>[0]),'project.delete',{projectId:'p'});
  assert.doesNotThrow(()=>gate.assertIdle('p'));assert.throws(()=>gate.assertIdle('other'),/busy/);
  controller.abort();assert.equal(unsubscribed,1);assert.equal(response.listenerCount('finish'),0);assert.equal(response.listenerCount('close'),0);
  gate.close();assert.equal(unsubscribed,1);assert.throws(()=>gate.assertIdle('p'),/busy/);
});
