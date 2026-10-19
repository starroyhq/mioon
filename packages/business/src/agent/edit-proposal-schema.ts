import type {DatabaseSync} from 'node:sqlite';

// A real target discriminator is needed: legacy shotId was NOT NULL. Never
// repurpose that column or rewrite retained JSON to admit a timeline proposal.
export function migrateAgentEditProposalSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Agent edit proposal migration requires a transaction');
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_edit_proposals_v24'").get()) throw new Error('Agent proposal staging table already exists');
  const old = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='agent_edit_proposals'").get() as {sql?: unknown} | undefined;
  if (!old || typeof old.sql !== 'string' || old.sql.includes('agent_edit_target_v24')) throw new Error('Agent edit proposal migration requires schema10');
  const objectsQuery = "SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END AS sql FROM sqlite_schema WHERE tbl_name='agent_edit_proposals' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name LIMIT 129";
  const externalQuery = "SELECT type,name,tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END AS sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='agent_edit_proposals' AND instr(lower(sql),'agent_edit_proposals')>0 ORDER BY name LIMIT 129";
  type SqlObject = {name: string; sql?: string | null};
  const objects = db.prepare(objectsQuery).all() as SqlObject[], external = db.prepare(externalQuery).all() as SqlObject[];
  if (objects.length > 128 || external.length > 128 || [...objects,...external].some(value => typeof value.sql !== 'string' || Buffer.byteLength(value.name) > 1024)) throw new Error('Agent proposal SQL objects exceed migration bounds');
  const sequence = db.prepare("SELECT rowid,seq FROM sqlite_sequence WHERE name='agent_edit_proposals'").get() as {rowid: number; seq: number} | undefined;
  const columns = (db.prepare('PRAGMA table_info(agent_edit_proposals)').all() as Array<{name: string}>).map(row => row.name);
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(agent_edit_proposals)').all();
  if (!old.sql.includes('shotId TEXT NOT NULL,') || columns.includes('targetKind')) throw new Error('Unrecognized agent proposal schema');
  const create = old.sql.replace(/^CREATE TABLE\s+(?:"agent_edit_proposals"|agent_edit_proposals)\s*\(/u, 'CREATE TABLE agent_edit_proposals_v24(')
    .replace('shotId TEXT NOT NULL,', `shotId TEXT,
 targetKind TEXT NOT NULL DEFAULT 'shot',clipId TEXT,timelineId TEXT,`)
    .replace(/\)\s*$/u, `,CONSTRAINT agent_edit_target_v24 CHECK(
 (targetKind='shot' AND typeof(shotId)='text' AND clipId IS NULL AND timelineId IS NULL) OR
 (targetKind='timeline_clip' AND shotId IS NULL AND typeof(clipId)='text' AND typeof(timelineId)='text')))`);
  if (!create.startsWith('CREATE TABLE agent_edit_proposals_v24(')) throw new Error('Unrecognized agent proposal table');
  db.exec(create);
  const fields = columns.map(name => `"${name.replaceAll('"','""')}"`).join(',');
  db.exec(`INSERT INTO agent_edit_proposals_v24(${fields}) SELECT ${fields} FROM agent_edit_proposals ORDER BY position`);
  for (const [left,right] of [['agent_edit_proposals','agent_edit_proposals_v24'],['agent_edit_proposals_v24','agent_edit_proposals']])
    if (db.prepare(`SELECT 1 FROM (SELECT ${fields} FROM ${left} EXCEPT SELECT ${fields} FROM ${right}) LIMIT 1`).get()) throw new Error('Agent proposal migration changed retained bytes');
  for (const trigger of external) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"','""')}"`);
  db.exec('DROP TABLE agent_edit_proposals; ALTER TABLE agent_edit_proposals_v24 RENAME TO agent_edit_proposals;');
  for (const object of [...objects,...external]) if (typeof object.sql === 'string') db.exec(object.sql);
  if (JSON.stringify(db.prepare(objectsQuery).all()) !== JSON.stringify(objects) || JSON.stringify(db.prepare(externalQuery).all()) !== JSON.stringify(external)) throw new Error('Agent proposal migration changed SQL objects');
  db.prepare("DELETE FROM sqlite_sequence WHERE name='agent_edit_proposals'").run();
  if (sequence) db.prepare("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,'agent_edit_proposals',?)").run(sequence.rowid,sequence.seq);
  if (JSON.stringify(db.prepare("SELECT rowid,seq FROM sqlite_sequence WHERE name='agent_edit_proposals'").get()) !== JSON.stringify(sequence)) throw new Error('Agent proposal migration changed sequence');
  if (JSON.stringify(db.prepare('PRAGMA foreign_key_list(agent_edit_proposals)').all()) !== JSON.stringify(foreignKeys) || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Agent proposal migration changed foreign keys');
  db.exec(`CREATE TRIGGER immutable_agent_edit_target_v24 BEFORE UPDATE ON agent_edit_proposals
 WHEN NEW.targetKind IS NOT OLD.targetKind OR NEW.clipId IS NOT OLD.clipId OR NEW.timelineId IS NOT OLD.timelineId
 BEGIN SELECT RAISE(ABORT,'agent edit targets are immutable');END;`);
}
