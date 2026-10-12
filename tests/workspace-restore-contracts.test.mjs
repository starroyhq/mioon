import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas,operationEffect,parseExpectedWorkspaceOrigin,isWorkspaceRestoreInspection,
  workspaceRestoreTaskContextSchema,isEditTaskEnvelope,isEditTaskListEnvelope} from '@mioon/contracts';

const origin='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const id='20000000-0000-4000-8000-000000000001',project='30000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64),time='2026-10-12T00:00:00.000Z';
const task=()=>({id,projectId:project,operation:'timeline.clip.remove',input:{projectId:project,clipId:other,expectedRevision:1,requestId:'restore-contract-key'},
  requestId:'restore-contract-key',digest:hash,lane:'timeline:mutation',status:'prepared',revision:1,createdAt:time,updatedAt:time,acknowledged:false,origin:'new'});
const inspect=()=>({restored:true,schemaVersion:25,profile:'restored-local-v1',workspaceOrigin:origin,restorationId:other,createdAt:time,
  source:{backupId:id,schemaVersion:24,manifestHash:hash,dbHash:hash},heldCounts:[{kind:'jobs',count:3}],
  operationPolicy:[{operation:'project.list',available:true,reason:'AVAILABLE'},{operation:'generation.submit',available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}],
  backupCreate:{available:false,reason:'RESTORE_BACKUP_UNAVAILABLE'}});

test('restore origin is optional only by omission and never normalized or coerced',()=>{
  assert.equal(parseExpectedWorkspaceOrigin(undefined),undefined);
  assert.equal(parseExpectedWorkspaceOrigin(origin),origin);
  for(const value of [null,'',' '+origin,origin+' ',origin+'\n',origin+'\r\n',0,true,{},[],{toString:()=>origin}])
    assert.throws(()=>parseExpectedWorkspaceOrigin(value));
});

test('restore inspection is a strict non-path public read and does not grant effects',()=>{
  assert.deepEqual(schemas['workspace.restore.inspect'].parse({}),{});
  for(const value of [{path:'/tmp/target'},{destination:'target'},{expectedWorkspaceOrigin:origin},{resume:true},{projectId:project}])
    assert.equal(schemas['workspace.restore.inspect'].safeParse(value).success,false);
  const effect=operationEffect('workspace.restore.inspect');
  assert.equal(effect.readOnly,true);
  for(const key of ['databaseWrite','fileWrite','externalIO','localProcess','paidGeneration'])assert.equal(effect[key],false);
  assert.equal(isWorkspaceRestoreInspection({restored:false}),true);
  assert.equal(isWorkspaceRestoreInspection({restored:false,workspaceOrigin:origin}),false);
});

test('restore disclosure is bounded, excludes arbitrary fields and reports backup unavailable',()=>{
  assert.equal(isWorkspaceRestoreInspection(inspect()),true);
  for(const change of [value=>value.source.key='synthetic-key',value=>value.source.schemaVersion=25,
    value=>value.workspacePath='/tmp/workspace',value=>value.backupCreate.available=true,
    value=>value.heldCounts[0].count=20001,value=>value.heldCounts.push({...value.heldCounts[0]}),
    value=>value.operationPolicy.push({...value.operationPolicy[0]}),value=>value.operationPolicy[0].available=false,
    value=>value.operationPolicy[1].reason='AVAILABLE',value=>value.operationPolicy=Array.from({length:161},(_,index)=>({operation:`project.op${index}`,available:false,reason:'RESTORE_OPERATION_UNAVAILABLE'}))]){
    const value=inspect();change(value);assert.equal(isWorkspaceRestoreInspection(value),false);
  }
});

test('ordinary task and ACK shapes remain byte-identical with optional outer restored projection',()=>{
  const ordinary={task:task(),instanceId:other},bytes=JSON.stringify(ordinary);
  assert.equal(isEditTaskEnvelope(ordinary),true);assert.equal(JSON.stringify(ordinary),bytes);
  assert.equal(isEditTaskEnvelope({...ordinary,restore:{workspaceOrigin:origin,executionEpoch:'captured',held:true}}),true);
  assert.equal(isEditTaskEnvelope({...ordinary,restore:{workspaceOrigin:origin,executionEpoch:origin,held:false}}),true);
  for(const restore of [{workspaceOrigin:origin,executionEpoch:'captured',held:false},{workspaceOrigin:origin,executionEpoch:origin,held:true},
    {workspaceOrigin:origin,executionEpoch:origin,held:false,authority:true}])assert.equal(isEditTaskEnvelope({...ordinary,restore}),false);
  assert.equal(isEditTaskEnvelope({...ordinary,task:{...ordinary.task,executionEpoch:origin}}),false);
});

test('restore task page projection must match every returned identity in order',()=>{
  const first=task(),second={...task(),id:other};
  const ordinary={items:[first,second],nextCursor:null,instanceId:origin};
  assert.equal(isEditTaskListEnvelope(ordinary),true);
  const restore={workspaceOrigin:origin,tasks:[{taskId:first.id,executionEpoch:'captured',held:true},{taskId:second.id,executionEpoch:origin,held:false}]};
  assert.equal(isEditTaskListEnvelope({...ordinary,restore}),true);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:[...restore.tasks].reverse()}}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:restore.tasks.slice(0,1)}}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:[restore.tasks[0],restore.tasks[0]]}}),false);
  assert.equal(workspaceRestoreTaskContextSchema.safeParse({workspaceOrigin:origin,executionEpoch:other,held:false}).success,false);
});
