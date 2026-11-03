import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas, isEditTaskEnvelope, isEditTaskListEnvelope} from '@mioon/contracts';
const origin='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const id='20000000-0000-4000-8000-000000000001',project='30000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64),time='2026-10-12T00:00:00.000Z';
const task=()=>({id,projectId:project,operation:'timeline.clip.remove',input:{projectId:project,clipId:other,expectedRevision:1,requestId:'restore-contract-key'},requestId:'restore-contract-key',digest:hash,lane:'timeline:mutation',status:'prepared',revision:1,createdAt:time,updatedAt:time,acknowledged:false,origin:'new'});
test('retired workspace operations have no public schema',()=>{
 for(const operation of ['workspace.backup.status','workspace.backup.list','workspace.backup.create','workspace.backup.restore.stage','workspace.backup.inspect','workspace.restore.inspect'])assert.equal(Object.hasOwn(schemas,operation),false);
});
test('ordinary task and ACK shapes retain bytes and reject retired outer restore fields',()=>{
  const ordinary={task:task(),instanceId:other},bytes=JSON.stringify(ordinary);
  assert.equal(isEditTaskEnvelope(ordinary),true);assert.equal(JSON.stringify(ordinary),bytes);
  assert.equal(isEditTaskEnvelope({...ordinary,restore:{workspaceOrigin:origin,executionEpoch:'captured',held:true}}),false);
  assert.equal(isEditTaskEnvelope({...ordinary,restore:{workspaceOrigin:origin,executionEpoch:origin,held:false}}),false);
  for(const restore of [{workspaceOrigin:origin,executionEpoch:'captured',held:false},{workspaceOrigin:origin,executionEpoch:origin,held:true},
    {workspaceOrigin:origin,executionEpoch:origin,held:false,authority:true}])assert.equal(isEditTaskEnvelope({...ordinary,restore}),false);
  assert.equal(isEditTaskEnvelope({...ordinary,task:{...ordinary.task,executionEpoch:origin}}),false);
});

test('ordinary task page retains ordered identities and rejects every retired restore projection',()=>{
  const first=task(),second={...task(),id:other};
  const ordinary={items:[first,second],nextCursor:null,instanceId:origin};
  assert.equal(isEditTaskListEnvelope(ordinary),true);
  const restore={workspaceOrigin:origin,tasks:[{taskId:first.id,executionEpoch:'captured',held:true},{taskId:second.id,executionEpoch:origin,held:false}]};
  assert.equal(isEditTaskListEnvelope({...ordinary,restore}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:[...restore.tasks].reverse()}}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:restore.tasks.slice(0,1)}}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{...restore,tasks:[restore.tasks[0],restore.tasks[0]]}}),false);
  assert.equal(isEditTaskListEnvelope({...ordinary,restore:{workspaceOrigin:origin,executionEpoch:other,held:false}}),false);
});
