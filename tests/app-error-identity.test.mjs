import test from 'node:test';
import assert from 'node:assert/strict';
import {AppError as leaf} from '../packages/contracts/src/app-error.ts';
import {AppError as barrel,parse} from '../packages/contracts/src/index.mjs';
import {volumeEnvelopeMutationError} from '../packages/business/src/timeline-volume-envelope-admission.ts';
// Exact prior constructor, kept only as a test oracle.
class PriorAppError extends Error {constructor(code,message,status=400,details={}){super(message);this.code=code;this.status=status;this.details=details;}}
test('typed error is the one canonical constructor through both import paths',()=>{
 assert.equal(leaf,barrel);
 const error=volumeEnvelopeMutationError('TIMELINE_VOLUME_ENVELOPE_LIMIT',{actualBytes:262145});
 assert.ok(error instanceof leaf);assert.ok(error instanceof barrel);assert.ok(error instanceof Error);
 assert.throws(()=>parse('unknown.operation',{}),e=>e instanceof leaf&&e.code==='UNKNOWN_OPERATION'&&e.status===404);
});
test('AppError type-only extraction preserves field order, defaults, details identity and serialization',()=>{
 for(const args of [[],['CODE'],['CODE','message'],['CODE','message',undefined,undefined],['CODE','message',409,{x:1}],['CODE','message',0,null]]){
  const actual=new leaf(...args),before=new PriorAppError(...args);
  assert.deepEqual(Object.getOwnPropertyNames(actual),Object.getOwnPropertyNames(before));
  assert.deepEqual(Object.keys(actual),Object.keys(before));
  assert.equal(actual.name,before.name);assert.equal(Object.hasOwn(actual,'name'),false);
  assert.equal(actual.message,before.message);assert.equal(actual.code,before.code);assert.equal(actual.status,before.status);
  assert.deepEqual(actual.details,before.details);assert.equal(JSON.stringify(actual),JSON.stringify(before));
  if(args.length===4&&args[3]!==undefined)assert.equal(actual.details,args[3]);
  for(const key of Object.getOwnPropertyNames(actual).filter(key=>key!=='stack'))assert.deepEqual(Object.getOwnPropertyDescriptor(actual,key),Object.getOwnPropertyDescriptor(before,key));
 }
 assert.notEqual(new leaf('CODE','message').details,new leaf('CODE','message').details);
 assert.equal(leaf.name,'AppError');assert.equal(new leaf('CODE','message').constructor,leaf);
});
