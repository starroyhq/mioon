import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.mjs';
import {migrateAgentEditProposalSchema} from '../packages/business/src/agent/edit-proposal-schema.ts';
const legacy=readFileSync(new URL('./fixtures/agent-edit-legacy-schema10.sql',import.meta.url),'utf8');
const columns=['position','id','projectId','runId','shotId','digest','definition','status','approval','outcome','createdAt','updatedAt','bytes'];
const statuses=['pending','approved','dispatching','unknown','applied','failed','rejected','cancelled'];
const raw=value=>' \n'+JSON.stringify(value,null,'\t').replaceAll('界','\\u754c')+'\n ';
const objects=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
const sequence=db=>db.prepare('SELECT rowid,* FROM sqlite_sequence ORDER BY name').all();
const rows=db=>db.prepare(`SELECT ${columns.join(',')},hex(CAST(definition AS BLOB)) AS definitionHex,hex(CAST(approval AS BLOB)) AS approvalHex,hex(CAST(outcome AS BLOB)) AS outcomeHex FROM agent_edit_proposals ORDER BY position`).all();
const snapshot=db=>({objects:objects(db),sequence:sequence(db),rows:rows(db),versions:db.prepare('SELECT * FROM schema_version').all()});
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
function database(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE agent_chat_runs(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(23);');
 db.exec(legacy);
 const projectId=randomUUID();db.prepare('INSERT INTO projects VALUES(?)').run(projectId);
 for(const [index,status] of statuses.entries()){
  const runId=randomUUID(),proposalId=randomUUID();db.prepare('INSERT INTO agent_chat_runs VALUES(?,?)').run(runId,raw({id:runId}));
  const approval=['pending','rejected','cancelled'].includes(status)?null:raw({status:'approval',keyOrder:1,name:'界'}),outcome=['applied','failed'].includes(status)?raw({status,keyOrder:2,name:'界'}):null;
  db.prepare(`INSERT INTO agent_edit_proposals(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(index*7+3,proposalId,projectId,runId,randomUUID(),'d'.repeat(64),raw({version:1,name:'界',status}),status,approval,outcome,'2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.001Z',1024);
 }
 db.exec("UPDATE sqlite_sequence SET seq=9001 WHERE name='agent_edit_proposals'; CREATE INDEX custom_agent_edit_order ON agent_edit_proposals(updatedAt,position); CREATE TRIGGER custom_external_proposal_reference BEFORE DELETE ON agent_chat_runs WHEN EXISTS(SELECT 1 FROM agent_edit_proposals WHERE runId=OLD.id) BEGIN SELECT RAISE(ABORT,'retained proposal'); END;");
 return db;
}
function migrate(db){transaction(db,()=>{migrateAgentEditProposalSchema(db);db.exec('INSERT INTO schema_version VALUES(24)');});}

test('schema24 retains every legacy byte, column, status, position, sequence rowid/high-water and SQL protection',t=>{
 const db=database(t),before=snapshot(db);migrate(db);
 assert.deepEqual(rows(db),before.rows);assert.deepEqual(sequence(db),before.sequence);
 for(const value of before.objects.filter(value=>!(value.type==='table'&&value.name==='agent_edit_proposals')))assert.deepEqual(objects(db).find(other=>other.type===value.type&&other.name===value.name),value);
 assert.equal(db.prepare('PRAGMA table_info(agent_edit_proposals)').all().find(value=>value.name==='shotId').notnull,0);
 assert.deepEqual(db.prepare('SELECT targetKind,clipId,timelineId FROM agent_edit_proposals').all().map(value=>({...value})),statuses.map(()=>({targetKind:'shot',clipId:null,timelineId:null})));
 const proposal=before.rows[0];
 for(const [field,value] of [['targetKind','timeline_clip'],['clipId',randomUUID()],['timelineId',randomUUID()],['shotId',randomUUID()],['definition','{}'],['position',999],['bytes',100]])assert.throws(()=>db.prepare(`UPDATE agent_edit_proposals SET ${field}=? WHERE id=?`).run(value,proposal.id),/immutable/);
 assert.throws(()=>db.prepare('DELETE FROM agent_edit_proposals WHERE id=?').run(proposal.id),/retained/);
 assert.throws(()=>db.prepare("UPDATE agent_edit_proposals SET status='unknown' WHERE id=?").run(proposal.id),/transition/);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('schema24 has a genuine target XOR; no clip can masquerade as a legacy shot',t=>{
 const db=database(t);migrate(db);const projectId=db.prepare('SELECT id FROM projects').get().id;
 function insert(targetKind,shotId,clipId,timelineId){const runId=randomUUID();db.prepare('INSERT INTO agent_chat_runs VALUES(?,?)').run(runId,'{}');return db.prepare("INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,definition,status,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,?,'digest','{}','pending','at','at',1)").run(randomUUID(),projectId,runId,shotId,targetKind,clipId,timelineId);}
 for(const values of [['shot',null,null,null],['shot',randomUUID(),randomUUID(),null],['timeline_clip',randomUUID(),randomUUID(),randomUUID()],['timeline_clip',null,null,randomUUID()],['invented',null,null,null]])assert.throws(()=>insert(...values),/constraint/i);
 insert('timeline_clip',null,randomUUID(),randomUUID());assert.equal(db.prepare('SELECT max(position) n FROM agent_edit_proposals').get().n,9002);
});

test('every rebuild stage rolls back without marker or changed old rows/triggers/sequence',t=>{
 for(const match of [/CREATE TABLE agent_edit_proposals_v24/,/INSERT INTO agent_edit_proposals_v24/,/DROP TABLE agent_edit_proposals/,/CREATE INDEX/,/CREATE TRIGGER immutable_agent_edit_target_v24/]){
  const db=database(t),before=snapshot(db);let failed=false;
  const wrapper={get isTransaction(){return db.isTransaction;},prepare:db.prepare.bind(db),exec(sql){const result=db.exec(sql);if(!failed&&match.test(sql)){failed=true;throw Error('synthetic migration crash');}return result;}};
  assert.throws(()=>transaction(db,()=>{migrateAgentEditProposalSchema(wrapper);db.exec('INSERT INTO schema_version VALUES(24)');}),/synthetic migration crash/);
  assert.equal(failed,true);assert.deepEqual(snapshot(db),before);assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_edit_proposals_v24'").get(),undefined);
  migrate(db);assert.deepEqual(rows(db),before.rows);assert.deepEqual(sequence(db),before.sequence);
 }
});

test('fresh startup and upgraded startup converge and reopen never rewrites legacy data',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-agent-migration24-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const current=openStore(path.join(root,'fresh-current'));
 const fresh=current.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='agent_edit_proposals' ORDER BY type,name").all();current.close();
 let store=openLegacyWorkspaceStore(root);
 store.db.exec('DROP TABLE agent_edit_proposals;DELETE FROM schema_version WHERE version=24;');store.db.exec(legacy);store.close();
 store=openStore(root);assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...Array.from({length:24},(_,index)=>index+1),26]);
 assert.deepEqual(store.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='agent_edit_proposals' ORDER BY type,name").all(),fresh);const after=snapshot(store.db);store.close();
 store=openStore(root);assert.deepEqual(snapshot(store.db),after);store.close();
});
