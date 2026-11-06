import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalRecordsController} from '../apps/web/src/local-records-state.ts';
import {LocalRecordsRequestError} from '../apps/web/src/local-records-client.ts';
import type {LocalRecordsClient} from '../apps/web/src/local-records-client.ts';
import type {LocalRecordsDeleteInput,LocalRecordsListResponse} from '../packages/contracts/src/local-record-operations.ts';
const flush=()=>new Promise(setImmediate);
function fixture(){
  let value:LocalRecordsListResponse={version:1,appLibraryScope:'a'.repeat(64),instanceId:randomUUID(),records:[{projectId:randomUUID(),name:'one',projectFile:null,sizeBytes:0,automaticBackups:{count:0,sizeBytes:0},hasSuperJournal:false,hasUnfinishedTasks:false}]};
  const calls:string[]=[],deletes:LocalRecordsDeleteInput[]=[];let fail:Error|null=null;
  const client:LocalRecordsClient={list:async()=>{calls.push('list');return value;},delete:async(input)=>{calls.push('delete');deletes.push(input);if(fail)throw fail;return {projectId:input.projectId,deleted:true,appLibraryScope:input.expectedAppLibraryScope,instanceId:input.expectedInstanceId};}};
  const controller=createLocalRecordsController(client);
  return {client,controller,calls,deletes,get value(){return value;},set value(next:LocalRecordsListResponse){value=next;},fail(error:Error){fail=error;}};
}
test('selection and cancellation perform no delete; only an explicit confirm uses the original list identity',async()=>{
  const f=fixture();f.controller.activate(true);await flush();f.controller.select(f.value.records[0]!.projectId);assert.equal(f.deletes.length,0);f.controller.cancel();await f.controller.confirm();assert.equal(f.deletes.length,0);
  f.controller.select(f.value.records[0]!.projectId);const identity=f.value;await f.controller.confirm();
  assert.deepEqual(f.deletes,[{projectId:identity.records[0]!.projectId,expectedAppLibraryScope:identity.appLibraryScope,expectedInstanceId:identity.instanceId}]);assert.deepEqual(f.calls,['list','delete','list']);assert.equal(f.controller.getSnapshot().notice?.code,'DELETED');f.controller.dispose();
});
test('both independent flags, hidden panels and loading snapshots prohibit a confirmation',async()=>{
  const f=fixture();f.controller.activate(true);await flush();
  for(const flags of [{hasSuperJournal:true,hasUnfinishedTasks:false},{hasSuperJournal:false,hasUnfinishedTasks:true},{hasSuperJournal:true,hasUnfinishedTasks:true}]){f.value={...f.value,records:[{...f.value.records[0]!,...flags}]};await f.controller.refresh();f.controller.select(f.value.records[0]!.projectId);await f.controller.confirm();assert.equal(f.controller.getSnapshot().selected,null);}
  f.controller.activate(false);await f.controller.refresh();await f.controller.confirm();assert.equal(f.deletes.length,0);assert.equal(f.calls.length,4);f.controller.dispose();
});
test('refresh or hiding revokes the old confirmation; a new server identity requires a fresh user selection',async()=>{
  const f=fixture();f.controller.activate(true);await flush();f.controller.select(f.value.records[0]!.projectId);f.value={...f.value,instanceId:randomUUID()};await f.controller.refresh();await f.controller.confirm();assert.equal(f.deletes.length,0);
  f.controller.select(f.value.records[0]!.projectId);f.controller.activate(false);f.controller.activate(true);await flush();await f.controller.confirm();assert.equal(f.deletes.length,0);f.controller.select(f.value.records[0]!.projectId);await f.controller.confirm();assert.equal(f.deletes[0]!.expectedInstanceId,f.value.instanceId);f.controller.dispose();
});
test('all delete errors trigger a fresh list while preserving exact guards and unknown outcomes',async()=>{
  for(const code of ['LOCAL_RECORDS_IN_USE','LOCAL_RECORDS_SUPER_JOURNAL','LOCAL_RECORDS_NOT_FOUND','LOCAL_RECORDS_IDENTITY_CHANGED','LOCAL_RECORDS_DELETE_UNCERTAIN']){
    const f=fixture();f.controller.activate(true);await flush();f.fail(new LocalRecordsRequestError(code,code==='LOCAL_RECORDS_DELETE_UNCERTAIN'));f.controller.select(f.value.records[0]!.projectId);await f.controller.confirm();
    assert.deepEqual(f.calls,['list','delete','list']);assert.deepEqual(f.controller.getSnapshot().notice,{code,outcomeUnknown:code==='LOCAL_RECORDS_DELETE_UNCERTAIN'});assert.equal(f.controller.getSnapshot().selected,null);await f.controller.confirm();assert.equal(f.deletes.length,1);f.controller.dispose();
  }
});
test('unknown outcomes are not inferred from an absent row or retried on reopen or refresh',async()=>{
  const f=fixture();f.controller.activate(true);await flush();f.controller.select(f.value.records[0]!.projectId);f.fail(new LocalRecordsRequestError('TIMEOUT',true));f.value={...f.value,records:[]};await f.controller.confirm();
  assert.equal(f.controller.getSnapshot().list?.records.length,0);assert.equal(f.controller.getSnapshot().notice?.outcomeUnknown,true);f.controller.activate(false);f.controller.activate(true);await flush();await f.controller.refresh();await f.controller.confirm();assert.equal(f.controller.getSnapshot().notice?.outcomeUnknown,true);assert.equal(f.deletes.length,1);f.controller.dispose();
});
test('a delete remains single flight across hide/reopen and its completion refreshes only the active owner',async()=>{
  const f=fixture(),pending=Promise.withResolvers<Awaited<ReturnType<LocalRecordsClient['delete']>>>();f.client.delete=async(input)=>{f.deletes.push(input);return pending.promise;};f.controller.activate(true);await flush();f.controller.select(f.value.records[0]!.projectId);const operation=f.controller.confirm();f.controller.cancel();f.controller.activate(false);f.controller.activate(true);await f.controller.confirm();assert.equal(f.deletes.length,1);assert.equal(f.controller.getSnapshot().deleting,true);
  pending.resolve({projectId:f.deletes[0]!.projectId,deleted:true,appLibraryScope:f.value.appLibraryScope,instanceId:f.value.instanceId});await operation;assert.equal(f.controller.getSnapshot().deleting,false);assert.equal(f.controller.getSnapshot().notice,null,'late success does not publish into the reopened owner');assert.equal(f.calls.filter(call=>call==='list').length,2);f.controller.dispose();
});
test('late reads cannot publish into a new visible epoch or after disposal',async()=>{
  const f=fixture(),first=Promise.withResolvers<LocalRecordsListResponse>(),second=Promise.withResolvers<LocalRecordsListResponse>();let reads=0;const signals:AbortSignal[]=[];
  f.client.list=async(options)=>{signals.push(options!.signal!);return ++reads===1?first.promise:second.promise;};f.controller.activate(true);f.controller.activate(false);assert.equal(signals[0]!.aborted,true);f.controller.activate(true);const latest={...f.value,instanceId:randomUUID()};second.resolve(latest);await flush();first.resolve(f.value);await flush();assert.equal(f.controller.getSnapshot().list?.instanceId,latest.instanceId);
  let updates=0;f.controller.subscribe(()=>updates++);f.controller.dispose();f.controller.activate(true);await f.controller.refresh();assert.equal(updates,0);
});

test('an uncertain completion is shown only when a fresh list proves its original library and instance',async()=>{
  for(const changed of [false,true]){const f=fixture(),pending=Promise.withResolvers<never>();f.client.delete=async()=>pending.promise;f.controller.activate(true);await flush();f.controller.select(f.value.records[0]!.projectId);const attempt=f.controller.confirm();f.controller.activate(false);if(changed)f.value={...f.value,appLibraryScope:'b'.repeat(64),instanceId:randomUUID()};f.controller.activate(true);pending.reject(new LocalRecordsRequestError('TIMEOUT',true));await attempt;assert.equal(f.controller.getSnapshot().notice?.outcomeUnknown??false,!changed);assert.equal(f.controller.getSnapshot().list?.instanceId,f.value.instanceId);f.controller.dispose();}
});
