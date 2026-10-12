import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {ownQaChild} from './agent-timeline-move-qa-native.mjs';

test('native QA ownership records an error but only close confirms termination',async()=>{
 const child=new EventEmitter(),signals=[];child.kill=signal=>{signals.push(signal);queueMicrotask(()=>child.emit('close',null,signal));return true;};
 const owned=ownQaChild(child);child.emit('error',Object.assign(Error('synthetic kill failure'),{code:'EPERM'}));
 assert.equal(owned.closed,false);
 const result=await owned.stop();assert.equal(owned.closed,true);assert.deepEqual(signals,['SIGTERM']);
 assert.deepEqual(result,{code:null,signal:'SIGTERM',error:{code:'EPERM',message:'synthetic kill failure'}});
 await owned.stop();assert.deepEqual(signals,['SIGTERM'],'closed identity is never signalled again');
});

test('native QA observes an actual nonexistent executable without an unhandled error',async()=>{
 const child=spawn('/mioon-synthetic-nonexistent/fixture',[],{stdio:'ignore'}),owned=ownQaChild(child);
 const result=await owned.done;assert.equal(result.error.code,'ENOENT');assert.equal(owned.closed,true);assert.notEqual(result.code,0);
});

test('native QA observes actual fast normal exit through immediately attached listeners',async()=>{
 const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'}),owned=ownQaChild(child);
 assert.deepEqual(await owned.done,{code:0,signal:null});assert.equal(owned.closed,true);
});
