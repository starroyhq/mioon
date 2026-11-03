import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {assertProjectStore,ownsStoreLock,registerStoreTransactionFence,registerStoreTransactionObserver} from '../packages/business/src/store-runtime.ts';

test('the current ownership seam requires the exact live kernel and refuses foreign/closed connections',t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-current-store-'));
  const store=openStore(root),foreign=new DatabaseSync(':memory:');
  t.after(()=>{store.close();foreign.close();rmSync(root,{recursive:true,force:true});});
  assert.equal(ownsStoreLock(store),true);
  for(const copied of[{...store},{db:store.db,root:store.root},{db:foreign,root:store.root}]){assert.equal(ownsStoreLock(copied),false);assert.throws(()=>assertProjectStore(copied),{name:'TypeError',code:'PROJECT_STORE_UNVERIFIED'});}
  for(const register of[()=>registerStoreTransactionFence(foreign,()=>{}),()=>registerStoreTransactionObserver(foreign,()=>{})])assert.throws(register,{name:'TypeError',message:'Transaction hooks require a live project connection'});
  store.close();assert.equal(ownsStoreLock(store),false);
  assert.throws(()=>assertProjectStore(store),{name:'TypeError',code:'PROJECT_STORE_UNVERIFIED'});
  assert.throws(()=>registerStoreTransactionFence(store.db,()=>{}),{name:'TypeError',message:'Transaction hooks require a live project connection'});
  assert.throws(()=>registerStoreTransactionObserver(store.db,()=>{}),{name:'TypeError',message:'Transaction hooks require a live project connection'});
});

test('current hooks retain in-transaction ordering, rollback and removal without weakening synchronous tx rules',t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-current-hooks-')),store=openStore(root);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const events:string[]=[];
  const removeFence=registerStoreTransactionFence(store.db,()=>{assert.equal(store.db.isTransaction,true);events.push('fence');});
  const removeObserver=registerStoreTransactionObserver(store.db,result=>{assert.equal(store.db.isTransaction,true);events.push(String(result));if(result==='rollback')throw new Error('observer refused');});
  assert.equal(store.tx(()=>{events.push('body');store.put('projects',{id:store.projectId,name:'Committed'});return 'commit';}),'commit');
  assert.deepEqual(events,['fence','body','commit']);
  assert.throws(()=>store.tx(()=>{store.put('projects',{id:store.projectId,name:'Lost'});return 'rollback';}),{message:'observer refused'});
  assert.deepEqual(store.get('projects',store.projectId),{id:store.projectId,name:'Committed'});
  assert.equal(store.db.isTransaction,false);
  removeFence();removeObserver();events.length=0;
  store.tx(()=>events.push('after removal'));assert.deepEqual(events,['after removal']);
  assert.throws(()=>store.tx(async()=>1),{name:'TypeError',message:'Transactions require a synchronous callback'});
  assert.throws(()=>store.tx(()=>({then(){}})),{name:'TypeError',message:'Transactions require a synchronous result'});
  assert.equal(store.db.isTransaction,false);
});
