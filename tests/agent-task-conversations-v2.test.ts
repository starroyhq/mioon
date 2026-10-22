import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {classifyWorkspaceSchemaV52V53} from '../packages/business/src/workspace-restore-schema-v53.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';

function fixture(){const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-conversation-')),store=openStore(root),projectId=randomUUID();store.put('projects',{id:projectId,name:'Conversation fixture',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});const journal=createAgentTaskJournal(store);return {root,store,projectId,journal,close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function completed(f:ReturnType<typeof fixture>,text:string,conversationId?:string){const run=f.journal.create({requestId:randomUUID(),projectId:f.projectId,text,configuration:{},...(conversationId?{conversationId}:{})}).run;return f.journal.transition(run.id,run.revision,'completed');}
function downgrade52(root:string){const db=new DatabaseSync(join(root,'workbench.sqlite'));try{db.exec("DROP INDEX agent_task_conversation_v2;DROP TRIGGER agent_task_conversation_identity_v2;DROP TRIGGER agent_task_conversation_required_v2;UPDATE agent_task_runs_v2 SET data=json_remove(data,'$.conversationId');DELETE FROM schema_version WHERE version=54");assert.deepEqual(classifyWorkspaceSchemaV52V53(db),{schemaVersion:52,profile:'ordinary'});}finally{db.close();}}

test('conversation creation is host-owned, fail-closed for unknown/foreign IDs and grouped with exact counts',()=>{const f=fixture();try{
 const first=completed(f,'  First line\n\u202esecond line  '),next=completed(f,'Next prompt',first.conversationId);assert.ok(first.conversationId);assert.equal(next.conversationId,first.conversationId);assert.notEqual(first.conversationId,first.id);
 const foreign=randomUUID();f.store.put('projects',{id:foreign,name:'Other',revision:1});const before=f.journal.list(f.projectId).length;
 for(const [projectId,conversationId] of [[f.projectId,randomUUID()],[foreign,first.conversationId]] as const)assert.throws(()=>f.journal.create({requestId:randomUUID(),projectId,conversationId,text:'must not create',configuration:{}}),{code:'AGENT_TASK_NOT_FOUND'});
 assert.equal(f.journal.list(f.projectId).length,before);const history=f.journal.history(f.projectId);assert.equal(history.conversations.length,1);const group=history.conversations[0]!;assert.equal(group.title,'First line second line');assert.equal(group.lastRunId,next.id);assert.equal(group.lastRunStatus,'completed');assert.equal(group.runCount,2);assert.equal(group.changeCount,0);
 assert.throws(()=>f.store.db.prepare("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.conversationId',?) WHERE id=?").run(randomUUID(),first.id),/conversation identity is immutable/u);
}finally{f.close();}});

test('conversation history and member pages use scoped cursors without overlap; diagnostics never join either',()=>{const f=fixture();try{
 const first=completed(f,'First group'),second=completed(f,'Second group');for(let index=0;index<4;index++)completed(f,`First continuation ${index}`,first.conversationId);
 const diagnostic=f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'Private diagnostic',configuration:{},diagnostic:{profile:'text'}}).run;f.journal.transition(diagnostic.id,diagnostic.revision,'completed');
 assert.equal(f.journal.history(f.projectId).conversations.length,2);assert.throws(()=>f.journal.conversation(f.projectId,diagnostic.conversationId!),{code:'AGENT_TASK_NOT_FOUND'});
 const page=f.journal.history(f.projectId,{limit:1});assert.ok(page.nextCursor);const older=f.journal.history(f.projectId,{limit:1,cursor:page.nextCursor});assert.equal(older.nextCursor,null);assert.equal(new Set([...page.conversations,...older.conversations].map(item=>item.id)).size,2);
 const members=f.journal.conversation(f.projectId,first.conversationId!,{limit:2});assert.ok(members.nextCursor);const middle=f.journal.conversation(f.projectId,first.conversationId!,{limit:2,cursor:members.nextCursor});assert.ok(middle.nextCursor);const last=f.journal.conversation(f.projectId,first.conversationId!,{limit:2,cursor:middle.nextCursor});assert.equal(last.nextCursor,null);assert.equal(new Set([...members.runs,...middle.runs,...last.runs].map(run=>run.id)).size,5);
 assert.throws(()=>f.journal.conversation(f.projectId,second.conversationId!,{cursor:members.nextCursor!}),{code:'AGENT_TASK_INVALID'});assert.throws(()=>f.journal.history(randomUUID(),{cursor:page.nextCursor!}),{code:'AGENT_TASK_INVALID'});
}finally{f.close();}});

test('conversation member pagination retains rounds older than the project recent100 snapshot',()=>{const f=fixture();try{
 const first=completed(f,'The first of 103 rounds'),ids=[first.id];for(let index=1;index<103;index++)ids.push(completed(f,`Round ${index+1}`,first.conversationId).id);
 assert.equal(f.journal.list(f.projectId).length,100);assert.ok(f.journal.list(f.projectId).every(run=>run.id!==first.id));
 const initial=f.journal.conversation(f.projectId,first.conversationId!,{limit:100});assert.equal(initial.runs.length,100);assert.ok(initial.nextCursor);const final=f.journal.conversation(f.projectId,first.conversationId!,{limit:100,cursor:initial.nextCursor});assert.equal(final.runs.length,3);assert.equal(final.nextCursor,null);assert.deepEqual([...initial.runs,...final.runs].map(run=>run.id),ids);assert.equal(final.conversation.runCount,103);
}finally{f.close();}});

test('schema52 migrates each previous v2 run into a distinct conversation without rewriting evidence or request digests',()=>{const f=fixture();try{
 const a=completed(f,'Old A'),b=completed(f,'Old B');f.store.close();downgrade52(f.root);const db=new DatabaseSync(join(f.root,'workbench.sqlite')),before=db.prepare('SELECT id,digest FROM agent_task_runs_v2 ORDER BY id').all(),events=db.prepare('SELECT data FROM agent_task_events_v2 ORDER BY rowid').all();db.close();
 const upgraded=openStore(f.root);try{assert.deepEqual(classifyCurrentWorkspaceSchema(upgraded.db),{schemaVersion:54,profile:'ordinary'});const journal=createAgentTaskJournal(upgraded),groups=journal.history(f.projectId).conversations;assert.deepEqual(new Set(groups.map(item=>item.id)),new Set([a.id,b.id]));assert.ok(groups.every(item=>item.runCount===1));assert.deepEqual(upgraded.db.prepare('SELECT id,digest FROM agent_task_runs_v2 ORDER BY id').all(),before);assert.deepEqual(upgraded.db.prepare('SELECT data FROM agent_task_events_v2 ORDER BY rowid').all(),events);}finally{upgraded.close();}
}finally{f.close();}});

test('frozen schema52 classification rejects a conversation field without reviewed54 schema objects',async()=>{const f=fixture(),backup=f.root+'-rejected-backup';try{
 const previous=completed(f,'Historical strict record');f.store.close();downgrade52(f.root);const db=new DatabaseSync(join(f.root,'workbench.sqlite'));
 try{db.prepare("UPDATE agent_task_runs_v2 SET data=json_set(data,'$.conversationId',?) WHERE id=?").run(randomUUID(),previous.id);assert.throws(()=>classifyWorkspaceSchemaV52V53(db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});}finally{db.close();}
 await assert.rejects(createWorkspaceBackup({source:f.root,destination:backup}));
}finally{f.close();rmSync(backup,{recursive:true,force:true});}});

for(const sourceVersion of [52,54] as const)test(`schema${sourceVersion} backup restores the exact historical or new profile and retains conversation reads`,async()=>{const f=fixture(),backup=f.root+'-backup',restored=f.root+'-restored';try{
 const a=completed(f,'Saved A'),b=completed(f,'Saved B');f.store.close();if(sourceVersion===52)downgrade52(f.root);
 const created=await createWorkspaceBackup({source:f.root,destination:backup});assert.equal(created.databaseSchemaVersion,sourceVersion);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const result=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(result.databaseSchemaVersion,sourceVersion===52?53:55);const store=openStore(restored);try{assert.equal(classifyCurrentWorkspaceSchema(store.db).schemaVersion,sourceVersion===52?53:55);const journal=createAgentTaskJournal(store),history=journal.history(f.projectId);assert.equal(history.conversations.length,2);assert.deepEqual(new Set(history.conversations.map(item=>item.lastRunId)),new Set([a.id,b.id]));assert.equal(journal.conversation(f.projectId,history.conversations[0]!.id).runs.length,1);assert.throws(()=>journal.create({requestId:randomUUID(),projectId:f.projectId,text:'no writes',configuration:{}}),/RESTORE_OPERATION_UNAVAILABLE|RESTORED_RECORD_HELD/u);}finally{store.close();}
}finally{f.close();rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}});

test('conversation metadata counts actual Changes and rejects identity edits before row publication',()=>{const f=fixture();try{
 const created=f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'One durable change',configuration:{}}),step=f.journal.beginStep(created.run.id,{kind:'model'});
 f.journal.completeStep(created.run.id,step.id,{result:{done:true},change:{projectId:f.projectId,operation:'local.test',targets:[],before:null,after:null,reversible:false}});const latest=f.journal.run(created.run.id);f.journal.transition(latest.id,latest.revision,'completed');
 const group=f.journal.history(f.projectId).conversations[0]!;assert.equal(group.changeCount,1);assert.equal(group.runCount,1);
 const old=f.journal.run(created.run.id);assert.throws(()=>f.store.db.prepare('INSERT INTO agent_task_runs_v2(id,projectId,requestId,digest,status,revision,data) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),f.projectId,randomUUID(),'a'.repeat(64),'completed',1,JSON.stringify({...old,id:randomUUID(),conversationId:undefined})),/conversation identity is required/u);assert.equal(f.journal.list(f.projectId).length,1);
}finally{f.close();}});

test('same-millisecond sends and clock rollback retain first/last, pagination, context and receipt identity after schema54 backup restores55',async t=>{const f=fixture(),backup=f.root+'-backup',restored=f.root+'-restored';try{
 const wall=Date.parse('2026-10-21T01:00:00.000Z');t.mock.timers.enable({apis:['Date'],now:wall});
 const first=completed(f,'First logical round'),second=completed(f,'Same millisecond',first.conversationId);
 t.mock.timers.setTime(wall-60_000);const third=completed(f,'Clock rolled backward',first.conversationId);
 t.mock.timers.setTime(wall-120_000);const fourth=completed(f,'Still behind',first.conversationId);
 const expected=[first,second,third,fourth];assert.deepEqual(expected.map(run=>run.createdAt),[0,1,2,3].map(offset=>new Date(wall+offset).toISOString()));assert.ok(expected.every(run=>run.updatedAt>=run.createdAt));
 const check=(journal:ReturnType<typeof createAgentTaskJournal>)=>{
  const group=journal.history(f.projectId).conversations[0]!;assert.equal(group.title,first.text);assert.equal(group.lastRunId,fourth.id);assert.equal(group.lastRunStatus,'completed');
  const page=journal.conversation(f.projectId,first.conversationId!,{limit:2});assert.ok(page.nextCursor);const last=journal.conversation(f.projectId,first.conversationId!,{limit:2,cursor:page.nextCursor});assert.equal(last.nextCursor,null);assert.deepEqual([...page.runs,...last.runs].map(run=>run.id),expected.map(run=>run.id));
  assert.deepEqual(journal.contextRuns(f.projectId,first.conversationId!).map(run=>run.id),expected.toReversed().map(run=>run.id));assert.equal(journal.requestConversationId(first.id),undefined);assert.equal(journal.requestConversationId(second.id),first.conversationId);
 };
 check(f.journal);t.mock.timers.reset();f.store.close();const created=await createWorkspaceBackup({source:f.root,destination:backup});assert.equal(created.databaseSchemaVersion,54);const result=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(result.databaseSchemaVersion,55);
 const recovered=openStore(restored);try{check(createAgentTaskJournal(recovered));}finally{recovered.close();}
}finally{t.mock.timers.reset();f.close();rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}});
