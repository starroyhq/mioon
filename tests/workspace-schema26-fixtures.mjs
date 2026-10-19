import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

export const golden = JSON.parse(readFileSync(new URL('./fixtures/workspace-schema-profiles/golden.json', import.meta.url), 'utf8'));
export const quote = name => '"' + name.replaceAll('"', '""') + '"';
export const columns = ['position','id','projectId','operation','input','requestId','digest','lane','origin','status','revision','acknowledged','claim','claimInstance','receiptDigest','errorCode','createdAt','updatedAt','bytes'];
export const operations24 = ['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','timeline.format.set','subject.create','subject.version.add','subject.binding.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'];
export const open = filename => {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  return db;
};
export function snapshot(db, schema = 'main') {
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema ORDER BY type,name`).all().map(value => ({...value}));
  const tables = Object.fromEntries(objects.filter(value => value.type === 'table').map(({name}) => {
    const fields = db.prepare(`PRAGMA ${schema}.table_info(${quote(name)})`).all().map(value => value.name);
    const expressions = fields.flatMap(field => [`typeof(${quote(field)})`, `CASE WHEN typeof(${quote(field)})='real' THEN printf('%!.26g',${quote(field)}) ELSE hex(CAST(${quote(field)} AS BLOB)) END`]);
    const statement = db.prepare(`SELECT CAST(rowid AS TEXT),${expressions.join(',')} FROM ${schema}.${quote(name)} ORDER BY rowid`);
    statement.setReturnArrays(true);
    return [name, {fields, rows: statement.all()}];
  }));
  return {objects, tables};
}
export function resetLastInsertRowid(db) {
 // Node 26 node:sqlite converts sqlite3_last_insert_rowid() on every run(); a
 // large preserved rowid would make unrelated cleanup run() calls throw.
 // One tiny temp-table insert restores a safe last-insert rowid without
 // touching main-schema rows, rowids, sequence high-water marks or bytes.
 db.exec('CREATE TEMP TABLE IF NOT EXISTS last_insert_rowid_reset(value);INSERT INTO last_insert_rowid_reset(rowid,value) VALUES(1,1);DELETE FROM last_insert_rowid_reset;DROP TABLE last_insert_rowid_reset;');
}
function decode(type, value) {
  if (type === 'null') return null;
  if (type === 'real') return Number(value);
  const bytes = Buffer.from(value, 'hex');
  if (type === 'blob') return bytes;
  if (type === 'integer') return BigInt(bytes.toString('utf8'));
  assert.equal(type, 'text');
  return bytes.toString('utf8');
}
export function fixture(db, name = 'ordinary-24-seeded') {
  const profile = golden.profiles[name];
  const objects = profile.schema.map(id => golden.definitions[id]);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN');
  try {
    for (const object of objects) if (object.type === 'table' && object.name !== 'sqlite_sequence') db.exec(object.sql);
    for (const [table, {fields, rows}] of Object.entries(profile.tables)) {
      if (table === 'sqlite_sequence') continue;
      const statement = db.prepare(`INSERT INTO ${quote(table)}(rowid,${fields.map(quote).join(',')}) VALUES(${Array(fields.length + 1).fill('?').join(',')})`);
      statement.setReadBigInts(true);
      for (const row of rows) statement.run(BigInt(row[0]), ...fields.map((_, index) => decode(row[1 + 2 * index], row[2 + 2 * index])));
    }
    db.exec('DELETE FROM sqlite_sequence');
    const sequenceInsert = db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)');
    sequenceInsert.setReadBigInts(true);
    for (const row of profile.tables.sqlite_sequence?.rows ?? []) sequenceInsert.run(BigInt(row[0]), decode(row[1],row[2]), decode(row[3],row[4]));
    for (const object of objects) if (object.type !== 'table' && object.sql !== null) db.exec(object.sql);
    db.exec('COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  resetLastInsertRowid(db);
  assert.deepEqual(snapshot(db), {objects, tables: profile.tables}, 'independent committed profile, including raw SQLite values and sequence rowids');
}
export function insert(db, table, row) {
  const entries = Object.entries(row);
  const statement = db.prepare(`INSERT INTO main.${quote(table)}(${entries.map(([name]) => quote(name)).join(',')}) VALUES(${entries.map(() => '?').join(',')})`);
  statement.setReadBigInts(true);
  return statement.run(...entries.map(([, value]) => value));
}
export function task(db, {operation = 'timeline.loudness.apply', status = 'prepared', acknowledged = 0, origin = 'new', ...overrides} = {}) {
  const projectId = randomUUID(), requestId = randomUUID();
  insert(db, 'projects', {id: projectId, data: ' \n{"legacy": "\\u754c", "value": 2.00}\n '});
  const claimed = status === 'dispatching' || status === 'not_applied' || (status !== 'prepared' && origin === 'new');
  return {position: null, id: randomUUID(), projectId, operation,
    input: ' \n' + JSON.stringify({requestId, note: '界 \u0000 raw', projectId, expectedRevision: 1}, null, '\t') + '\n ',
    requestId, digest: 'a'.repeat(64), lane: operation.startsWith('timeline.') ? 'timeline:mutation' : operation.startsWith('reference.') ? 'reference:mutation' : 'subject:mutation', origin, status,
    revision: status === 'prepared' ? 1 : status === 'dispatching' ? 2 : acknowledged ? 4 : 3, acknowledged,
    claim: claimed ? randomUUID() : null, claimInstance: claimed ? randomUUID() : null,
    receiptDigest: status === 'applied' ? 'b'.repeat(64) : null, errorCode: status === 'not_applied' ? 'RETAINED_ERROR' : null,
    createdAt: 'at', updatedAt: 'later', bytes: 16384, ...overrides};
}
export function populate(db) {
  let position = 101;
  for (const operation of operations24) for (const [status, acknowledged, origin] of [
    ['prepared',0,'new'],['dispatching',0,'new'],['unknown',0,'new'],['unknown',0,'legacy_session'],['applied',0,'new'],['applied',1,'legacy_session'],['not_applied',0,'new'],['not_applied',1,'new'],
  ]) {
    const value = task(db, {operation, status, acknowledged, origin, position});
    if (position % 2) {
      value.input = Buffer.from(value.input);
      value.digest = Buffer.alloc(64, 0x64);
      value.createdAt = Buffer.from('raw-界');
    }
    insert(db, 'edit_tasks', value);
    position += 7;
  }
  insert(db, 'edit_tasks', task(db, {operation: 'timeline.undo', position: 9007199254740993n}));
  const sequenceUpdate=db.prepare("UPDATE sqlite_sequence SET rowid=9007199254741099,seq=9007199254741999 WHERE name='edit_tasks'");
  sequenceUpdate.setReadBigInts(true);sequenceUpdate.run();
  resetLastInsertRowid(db);
}
export function preserved(db, before) {
  const after = snapshot(db);
  for (const [name, value] of Object.entries(before.tables)) {
    const current = name === 'schema_version' ? {...after.tables[name], rows: after.tables[name].rows.filter(row => row[0] !== '26')} : after.tables[name];
    assert.deepEqual(current, value, `${name}: exact types, raw bytes and rowids`);
  }
  assert.equal(after.objects.length, before.objects.length);
  for (const object of before.objects) {
    const current = after.objects.find(value => value.type === object.type && value.name === object.name);
    const expected = object.type === 'table' && object.name === 'edit_tasks' ? {...object, sql: object.sql.replace("'timeline.subtitle.remove'))", "'timeline.subtitle.remove','timeline.loudness.apply'))")} : object;
    assert.deepEqual(current, expected, `${object.type} ${object.name}: no incidental SQL change`);
  }
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(value => value.version), [...Array.from({length:24}, (_,index) => index+1),26]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}
export function probe(db, fn) {
  db.exec('SAVEPOINT schema26_probe');
  try { return fn(); } finally { db.exec('ROLLBACK TO schema26_probe; RELEASE schema26_probe'); }
}
// Native operations are executed first unless the test's before hook throws.
// Both production SQL and real native statements are still exercised.
export function facade(db, hook) {
  let index = 0;
  const invoke = (sql, fn) => {
    const item = {index: ++index, sql};
    hook({...item, phase:'before'});
    const result = fn();
    hook({...item, phase:'after'});
    return result;
  };
  return {
    get isTransaction() { return db.isTransaction; },
    exec(sql) { return /^(?:ROLLBACK|PRAGMA)/.test(sql) ? db.exec(sql) : invoke(sql, () => db.exec(sql)); },
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!/^(?:INSERT INTO|DELETE FROM) main\.sqlite_sequence/.test(sql)) return statement;
      return new Proxy(statement, {get(target, key) {
        if (key === 'run') return (...args) => invoke(sql, () => target.run(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    },
  };
}

export function assertBoundedSequenceProjection(initialize) {
  for (const [kind, expression] of [['blob','zeroblob(8388608)'],['text','CAST(zeroblob(8388608) AS TEXT)']]) {
    const db = open(':memory:');
    try {
      fixture(db);
      db.exec(`UPDATE sqlite_sequence SET seq=${expression} WHERE name='edit_tasks'`);
      const projected = [], effects = [], checked = facade(db, value => effects.push(value));
      const prepare = checked.prepare;
      checked.prepare = sql => {
        const statement = prepare(sql);
        if (!/^SELECT .*FROM main\.sqlite_sequence/.test(sql)) return statement;
        return new Proxy(statement, {get(target, key) {
          if (key === 'all') return (...args) => {
            const rows = target.all(...args);
            projected.push(...rows.map(value => ({kind:value.kind, seqIsNull:value.seq === null, seqType:typeof value.seq})));
            return rows;
          };
          const value = Reflect.get(target,key,target);
          return typeof value === 'function' ? value.bind(target) : value;
        }});
      };
      assert.throws(() => initialize(checked), {code:'RESTORE_SCHEMA_UNSUPPORTED'});
      assert.deepEqual(projected,[{kind,seqIsNull:true,seqType:'object'}], 'non-integer sequence payload must be SQL-masked before native all() returns to JavaScript');
      assert.ok(effects.every(value => value.sql === 'BEGIN IMMEDIATE'), 'no mutation is attempted');
      assert.equal(db.isTransaction,false);
      assert.equal(db.prepare(`SELECT seq IS ${expression} AS unchanged FROM sqlite_sequence WHERE name='edit_tasks'`).get().unchanged,1);
      assert.equal(db.prepare('SELECT max(version) AS version FROM schema_version').get().version,24);
    } finally { db.close(); }
  }
}
