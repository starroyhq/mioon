import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runHeadlessSecretOperation,isHeadlessSecretResult} from '../apps/server/src/headless-agent-secret-helper.ts';
import type {HeadlessSecretEntry,HeadlessSecretRequest} from '../apps/server/src/headless-agent-secret-helper.ts';
const input=(operation:'read'|'create'):HeadlessSecretRequest=>({version:1,id:randomUUID(),operation,service:'app.starroy.mioon.headless.agent.v1.development',account:'a'.repeat(64)});
test('headless helper reads missing/existing DEKs without writes and never rotates one',async()=>{
  let saved:string|null=null,sets=0,gets=0;
  const entry:HeadlessSecretEntry={async getPassword(){gets++;return saved;},async setPassword(value){sets++;saved=value;}};
  const missing=await runHeadlessSecretOperation(input('read'),()=>entry);assert.equal(missing.ok&&missing.key,null);assert.equal(sets,0);
  const created=await runHeadlessSecretOperation(input('create'),()=>entry);assert.equal(created.ok,true);assert.equal(sets,1);
  assert.ok(created.ok&&created.key);assert.equal(Buffer.from(created.key,'base64').length,32);
  const existing=await runHeadlessSecretOperation(input('create'),()=>entry);assert.equal(existing.ok&&existing.key,created.key);assert.equal(sets,1);assert.equal(gets,4);
});
test('headless helper rejects arbitrary namespace, malformed keys and native failures without native error text',async()=>{
  let calls=0,sets=0;
  for(const patch of [{service:'other-user-vault'},{account:'customer'},{operation:'delete'},{extra:'SYNTHETIC_SECRET_MARKER'}]){
    const result=await runHeadlessSecretOperation({...input('read'),...patch},()=>{calls++;throw Error('SYNTHETIC_SECRET_MARKER');});
    assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes('MARKER'),false);
  }
  assert.equal(calls,0);
  for(const failure of ['construct','read','malformed','write','readback']){
    let reads=0;
    const result=await runHeadlessSecretOperation(input('create'),()=>{
      if(failure==='construct')throw Error('SYNTHETIC_SECRET_MARKER');
      return {async getPassword(){reads++;if(failure==='read')throw Error('SYNTHETIC_SECRET_MARKER');return failure==='malformed'?'SYNTHETIC_SECRET_MARKER':reads>1?'incorrect':null;},async setPassword(){sets++;if(failure==='write')throw Error('SYNTHETIC_SECRET_MARKER');}};
    });
    assert.equal(result.ok,false);assert.ok(!result.ok);assert.equal(result.beforeWrite,['construct','read','malformed'].includes(failure));
    assert.equal(JSON.stringify(result).includes('MARKER'),false);
  }
  assert.equal(sets,2);
});
test('headless helper response identity and fixed DEK shape reject forged or oversized payloads',()=>{
  const id=randomUUID();
  assert.equal(isHeadlessSecretResult({version:1,id,ok:true,key:Buffer.alloc(32,7).toString('base64')},id),true);
  for(const value of [{version:1,id,ok:true,key:'x'},{version:1,id,ok:true,key:null,raw:'SYNTHETIC_SECRET_MARKER'},{version:1,id:randomUUID(),ok:true,key:null},{version:1,id,ok:false,beforeWrite:'true'}])assert.equal(isHeadlessSecretResult(value,id),false);
});
