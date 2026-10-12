import assert from 'node:assert/strict';

// Independently pinned schema24 additions. Normalize only these reviewed bytes;
// all remaining table SQL, old columns, indexes, triggers and receipts must
// still compare exactly with the independently frozen historical fixtures.
const TARGET_COLUMNS_SQL = `shotId TEXT,
 targetKind TEXT NOT NULL DEFAULT 'shot',clipId TEXT,timelineId TEXT,`;
const TARGET_CHECK_SQL = `,CONSTRAINT agent_edit_target_v24 CHECK(
 (targetKind='shot' AND typeof(shotId)='text' AND clipId IS NULL AND timelineId IS NULL) OR
 (targetKind='timeline_clip' AND shotId IS NULL AND typeof(clipId)='text' AND typeof(timelineId)='text'))`;
const TARGET_TRIGGER_SQL = `CREATE TRIGGER immutable_agent_edit_target_v24 BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.targetKind IS NOT OLD.targetKind OR NEW.clipId IS NOT OLD.clipId OR NEW.timelineId IS NOT OLD.timelineId
 BEGIN SELECT RAISE(ABORT,'agent edit targets are immutable');END`;

export function normalizeAgentEditProposalObject(row) {
 assert.equal(row.type,'table');assert.equal(row.name,'agent_edit_proposals');
 assert.equal(row.sql.split(TARGET_COLUMNS_SQL).length,2,'exactly the reviewed target columns and shot nullability');
 assert.equal(row.sql.split(TARGET_CHECK_SQL).length,2,'exactly the reviewed target XOR CHECK');
 assert.ok(row.sql.endsWith(TARGET_CHECK_SQL+')'),'target CHECK is the exact final table constraint');
 const quoted='CREATE TABLE "agent_edit_proposals"(';
 assert.ok(row.sql.startsWith(quoted),'SQLite quotes only the rebuilt table name');
 const sql='CREATE TABLE agent_edit_proposals('+row.sql.slice(quoted.length)
  .replace(TARGET_COLUMNS_SQL,'shotId TEXT NOT NULL,').replace(TARGET_CHECK_SQL,'');
 return Object.assign(Object.create(Object.getPrototypeOf(row)),row,{sql});
}

export function legacyAgentEditProposalRows(rows) {
 return rows.map(row=>{
  assert.equal(row.targetKind,'shot','every historical proposal defaults to a shot target');
  assert.equal(row.clipId,null,'historical proposals acquire no clip identity');
  assert.equal(row.timelineId,null,'historical proposals acquire no timeline identity');
  const legacy=Object.assign(Object.create(Object.getPrototypeOf(row)),row);
  delete legacy.targetKind;delete legacy.clipId;delete legacy.timelineId;
  return legacy;
 });
}

export function assertAgentEditTargetTrigger(objects) {
 const added=objects.filter(row=>row.name==='immutable_agent_edit_target_v24');
 assert.equal(added.length,1,'exactly one new target immutability trigger');
 assert.deepEqual({...added[0]},{type:'trigger',name:'immutable_agent_edit_target_v24',tbl_name:'agent_edit_proposals',sql:TARGET_TRIGGER_SQL});
}
