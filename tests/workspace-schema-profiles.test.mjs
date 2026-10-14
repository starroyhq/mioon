import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import * as fixedInputs from '../packages/business/src/workspace-schema-v24-constants.ts';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore, getWorkspaceRestoreContext, classifyCurrentWorkspaceSchema} from '../packages/business/src/db.mjs';
import {initializeLegacyWorkspaceSchema, initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {createMockProvider} from '../packages/business/src/providers/mock.mjs';
import {classifyWorkspaceSchema, installWorkspaceRestoreSchema, validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';

// Independent, committed outputs of fixed 0343 source, never regenerated from
// the implementation under test. See the manifest for extraction provenance and
// the deliberately synthetic marker1 boundary in the initial trusted SQL batch.
const fixtureRoot = new URL('./fixtures/workspace-schema-profiles/', import.meta.url);
const fixtureBytes = readFileSync(new URL('golden.json', fixtureRoot));
const golden = JSON.parse(fixtureBytes);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'));
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profile = name => ({
  objects: golden.profiles[name].schema.map(id => golden.definitions[id]),
  tables: golden.profiles[name].tables,
});

// Runtime26 has exactly two reviewed differences from the independent24
// golden. Derive that expectation from frozen bytes, never from the migration
// under test; all other SQL, indexes, triggers, raw rows and sequences stay exact.
function currentOrdinaryProfile(name = 'ordinary-24') {
  const expected = structuredClone(profile(name));
  const tasks = expected.objects.find(object => object.name === 'edit_tasks');
  const oldCheck = "'timeline.subtitle.remove'))";
  assert.equal(tasks.sql.split(oldCheck).length, 2);
  tasks.sql = tasks.sql.replace(oldCheck, "'timeline.subtitle.remove','timeline.loudness.apply'))");
  expected.tables.schema_version.rows.push(['26', 'integer', '3236']);
  return expected;
}

function objects(db) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all().map(row => ({...row}));
}

function rawTable(db, name, fields, where = '') {
  const expressions = fields.flatMap(column => [
    `typeof(${quote(column)})`,
    `CASE WHEN typeof(${quote(column)})='real' THEN printf('%!.26g',${quote(column)}) ELSE hex(CAST(${quote(column)} AS BLOB)) END`,
  ]);
  const statement = db.prepare(`SELECT CAST(rowid AS TEXT),${expressions.join(',')} FROM ${quote(name)} ${where} ORDER BY rowid`);
  statement.setReturnArrays(true);
  return {fields, rows: statement.all()};
}

function snapshot(db) {
  const definitions = objects(db);
  return {
    objects: definitions,
    tables: Object.fromEntries(definitions.filter(row => row.type === 'table').map(({name}) => {
      const fields = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name);
      return [name, rawTable(db, name, fields)];
    })),
  };
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

// Only this repository-owned frozen fixture supplies SQL to this loader.
// No production constructor or classifier supplies its expected definitions.
function loadFixture(db, name) {
  const expected = profile(name);
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=OFF; BEGIN');
  try {
    for (const object of expected.objects) {
      if (object.type === 'table' && object.name !== 'sqlite_sequence') db.exec(object.sql);
    }
    for (const [table, {fields, rows}] of Object.entries(expected.tables)) {
      if (table === 'sqlite_sequence') continue;
      const statement = db.prepare(`INSERT INTO ${quote(table)}(rowid,${fields.map(quote).join(',')}) VALUES(${Array(fields.length + 1).fill('?').join(',')})`);
      for (const row of rows) statement.run(BigInt(row[0]), ...fields.map((_, i) => decode(row[1 + 2 * i], row[2 + 2 * i])));
    }
    if (expected.tables.sqlite_sequence) {
      db.exec('DELETE FROM sqlite_sequence');
      for (const row of expected.tables.sqlite_sequence.rows) {
        db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)').run(BigInt(row[0]), decode(row[1], row[2]), decode(row[3], row[4]));
      }
    }
    for (const object of expected.objects) {
      if (object.type !== 'table' && object.sql !== null) db.exec(object.sql);
    }
    db.exec('COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  assert.deepEqual(snapshot(db), expected, `${name}: frozen fixture reconstructed exactly`);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function inMemory(t, name) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  if (name) loadFixture(db, name);
  else db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF');
  return db;
}

function onDisk(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-schema-profile-golden-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  if (name) {
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    try { loadFixture(db, name); } finally { db.close(); }
  }
  return root;
}

function assertPreserved(db, before, maximumMarker = 24) {
  for (const [name, expected] of Object.entries(before.tables)) {
    const where = name === 'schema_version' ? `WHERE version<=${maximumMarker}` : '';
    assert.deepEqual(rawTable(db, name, expected.fields, where), expected, `${name}: raw columns, types, rowids and bytes`);
  }
}

function captureConstructor(db) {
  const captured = new Map();
  const capture = () => {
    if (db.isTransaction || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='schema_version'").get()) return;
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version;
    if (Number.isInteger(version)) captured.set(version, snapshot(db));
  };
  const facade = {
    get isTransaction() { return db.isTransaction; },
    prepare: db.prepare.bind(db),
    exec(sql) {
      const marker = 'INSERT OR IGNORE INTO schema_version VALUES(2);';
      if (sql.includes(marker)) {
        const at = sql.indexOf(marker);
        db.exec(sql.slice(0, at));
        capture();
        db.exec(sql.slice(at));
      } else db.exec(sql);
      capture();
    },
  };
  initializeWorkspaceSchemaThrough24(facade);
  capture();
  return captured;
}

function constraints(db, {restored, mock}) {
  const before = snapshot(db);
  for (const [sql, error] of [
    ["UPDATE timeline_requests SET response='rewritten'", /immutable|RESTORED_RECORD_HELD/],
    ["UPDATE timeline_history SET afterSnapshot='rewritten'", /immutable/],
    ['DELETE FROM edit_tasks', /retained|RESTORED_RECORD_HELD/],
    ["INSERT INTO assets VALUES('new-asset','missing-project','{}')", /FOREIGN KEY/],
    [`INSERT INTO workspace_preferences VALUES('${golden.ids.project}',0,'{}')`, /CHECK/],
    ['INSERT INTO idempotency SELECT * FROM idempotency', /UNIQUE|RESTORED_RECORD_HELD/],
  ]) assert.throws(() => db.exec(sql), error, sql);
  if (restored) {
    for (const sql of [
      'UPDATE jobs SET data=data',
      'INSERT OR REPLACE INTO jobs SELECT * FROM jobs',
      'DELETE FROM workspace_restore_holds',
      'DELETE FROM workspace_restoration',
      'INSERT OR IGNORE INTO schema_version VALUES(1)',
      'INSERT INTO schema_version VALUES(26)',
      'INSERT INTO schema_version VALUES(27)',
      "UPDATE edit_tasks SET executionEpoch='forged'",
    ]) assert.throws(() => db.exec(sql), /RESTORE|RESTORED/, sql);
    if (mock) {
      for (const table of ['mock_provider_tasks', 'mock_provider_submissions', 'workspace_restore_mock_evidence']) {
        for (const sql of [`DELETE FROM ${table}`, `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`]) {
          assert.throws(() => db.exec(sql), /RESTORE|RESTORED/, sql);
        }
      }
    }
  }
  assert.deepEqual(snapshot(db), before, 'all rejected writes leave the complete fixture unchanged');
}

test('independent schema goldens pin fixed baseline provenance, exact bytes and every supported profile', () => {
  assert.equal(manifest.sourceCommit, '0343ed390a85c319210b5f179180cf9c8c3985c2');
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.fixtures['golden.json'].sha256, sha(fixtureBytes));
  assert.equal(manifest.fixtures['golden.json'].bytes, fixtureBytes.byteLength);
  assert.equal(manifest.fixtures['golden.json'].profiles, 31);
  assert.equal(Object.keys(golden.profiles).length, 31);
  assert.equal(Object.keys(golden.definitions).length, manifest.fixtures['golden.json'].definitions);
  assert.equal(manifest.constructorSources['packages/business/src/workspace-fixed-schema.mjs'], '9751e2f2d74b64c1cbd070d61e11941d1eba135ca8748bbdc20bd20ebab05bab');
  assert.equal(manifest.constructorSources['packages/business/src/workspace-restore-schema.mjs'], '9b3861b3e0ec72b0ab1d1b676657205f5b3a934342abf308a4cc394307c3670b');
  for (let version = 1; version <= 24; version++) assert.ok(golden.profiles[`ordinary-${version}`]);
  for (const profile of Object.values(golden.profiles)) for (const id of profile.schema) assert.ok(golden.definitions[id]);
});

test('through24 schema-only dependency bodies stay byte-frozen independently of constructor output', () => {
  for (const [name, expected] of Object.entries(manifest.closureStatements)) {
    const source = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const statements = ast.statements.filter(statement => {
      if (ts.isImportDeclaration(statement)) return false;
      // The sole allowed additional executable declaration is the public alias.
      return statement.getText(ast) !== 'export const initializeWorkspaceSchemaThrough24=initializeLegacyWorkspaceSchema;';
    }).map(statement => statement.getText(ast));
    assert.equal(statements.length, expected.statements, `${name}: fixed closure statement count`);
    assert.equal(sha(JSON.stringify(statements)), expected.sha256, `${name}: fixed function/SQL definition bodies`);
  }
  // Regression ownership only: this is not a runtime tamper-proofing claim.
  // The reviewed role detector changed; all v25 construction and validation,
  // literal SQL, family/Mock descriptors and caches remain baseline-owned.
  const expected = manifest.restore25Closure;
  const source = readFileSync(new URL('../' + expected.file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(expected.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statements = ast.statements.filter(statement => !ts.isImportDeclaration(statement)
    && !(ts.isFunctionDeclaration(statement) && statement.name?.text === expected.excludedFunction))
    .map(statement => {
      let body = statement.getText(ast);
      for (const [current, baseline] of Object.entries(expected.allowedIdentifierRenames)) {
        body = body.replaceAll(new RegExp('\\b' + current + '\\b', 'g'), baseline);
      }
      return body;
    });
  assert.equal(statements.length, expected.statements, 'v25 fixed closure statement count');
  assert.equal(sha(JSON.stringify(statements)), expected.sha256, 'v25 construction/evidence/validation/cache closure');
});

test('fixed schema dependency imports and re-exports cannot reconnect to active runtime constants', () => {
  const requiredFiles = [
    ...Object.keys(manifest.closureStatements),
    manifest.restore25Closure.file,
    'packages/business/src/workspace-schema-v24-constants.ts',
  ];
  assert.deepEqual(Object.keys(manifest.dependencyDeclarations).sort(), requiredFiles.sort());
  for (const [name, expected] of Object.entries(manifest.dependencyDeclarations)) {
    const source = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
      name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const declarations = ast.statements.filter(statement => ts.isImportDeclaration(statement)
      || ts.isImportEqualsDeclaration(statement)
      || (ts.isExportDeclaration(statement) && statement.moduleSpecifier))
      .map(statement => statement.getText(ast));
    assert.deepEqual(declarations, expected, `${name}: fixed dependency declarations`);
    const dynamicDependencies = [];
    const visit = node => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        dynamicDependencies.push(node.getText(ast));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.deepEqual(dynamicDependencies, [], `${name}: no dynamic dependency escape`);
  }
});

test('through24 interpolation values remain the independent fixed-baseline values', () => {
  const requiredFrameFields = [
    'inputBytes', 'snapshotBytes', 'receiptBytes', 'taskBytes', 'requestBytes', 'responseBytes',
    'queuedPerProject', 'queuedGlobal', 'tasksPerProject', 'tasksGlobal', 'requestsPerTask',
    'resultBytes', 'resultMaxEdge',
  ];
  const expected = {
    ...manifest.interpolationInputs,
    FRAME_LIMITS: Object.fromEntries(requiredFrameFields.map(name => [name, manifest.interpolationInputs.FRAME_LIMITS[name]])),
  };
  assert.deepEqual({...fixedInputs}, expected);
  assert.equal(Object.isFrozen(fixedInputs.INSPECTION_ROW_LIMITS), true);
  assert.equal(Object.isFrozen(fixedInputs.FRAME_LIMITS), true);
});

test('through24 constructor keeps every ordinary1–24 trusted SQL/default-row checkpoint and the legacy alias', t => {
  assert.equal(initializeLegacyWorkspaceSchema, initializeWorkspaceSchemaThrough24);
  const db = inMemory(t);
  const actual = captureConstructor(db);
  assert.deepEqual([...actual.keys()], Array.from({length: 24}, (_, i) => i + 1));
  for (const [version, value] of actual) assert.deepEqual(value, profile(`ordinary-${version}`), `ordinary${version}`);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
});

for (let version = 1; version <= 24; version++) {
  test(`frozen ordinary${version} classifies without mutation and runtime opens with only the reviewed ordinary26 delta`, t => {
    const name = `ordinary-${version}`;
    const root = onDisk(t, name);
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    try {
      assert.deepEqual(classifyWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
      assert.deepEqual(snapshot(db), profile(name));
    } finally { db.close(); }
    const store = openStore(root);
    try {
      assert.deepEqual(snapshot(store.db), currentOrdinaryProfile());
      assertPreserved(store.db, profile(name), version);
      assert.equal(getWorkspaceRestoreContext(store), null);
    } finally { store.close(); }
  });
}

test('fresh runtime construction has only the reviewed ordinary26 delta and no restoration authority', t => {
  const store = openStore(onDisk(t));
  try {
    assert.deepEqual(snapshot(store.db), currentOrdinaryProfile());
    assert.equal(getWorkspaceRestoreContext(store), null);
  } finally { store.close(); }
});

test('real Mock ledger constructor keeps the frozen optional ordinary24 table/index SQL and empty sequence absence', t => {
  const db = inMemory(t);
  initializeWorkspaceSchemaThrough24(db);
  createMockProvider({db, root: '/synthetic-unused-root', now: () => 0});
  assert.deepEqual(snapshot(db), profile('ordinary-24-mock'));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='mock_provider_submissions'").get(), undefined);
});

for (const mock of [false, true]) for (const seeded of [false, true]) {
  const suffix = (mock ? '-mock' : '') + (seeded ? '-seeded' : '');
  test(`frozen ordinary24${suffix} reopens with only the reviewed26 schema delta, preserving raw rows, receipts and sequence`, t => {
    const name = `ordinary-24${suffix}`;
    const store = openStore(onDisk(t, name));
    try {
      assert.deepEqual(snapshot(store.db), currentOrdinaryProfile(name));
      assertPreserved(store.db, profile(name));
      assert.deepEqual(classifyCurrentWorkspaceSchema(store.db), {schemaVersion: 26, profile: 'ordinary'});
      if (seeded) constraints(store.db, {restored: false, mock});
      assert.deepEqual(snapshot(store.db), currentOrdinaryProfile(name));
    } finally { store.close(); }
  });

  test(`restore25 construction from independent ordinary24${suffix} matches frozen SQL and capture evidence`, t => {
    const db = inMemory(t, `ordinary-24${suffix}`);
    const before = profile(`ordinary-24${suffix}`);
    const restored = installWorkspaceRestoreSchema(db, golden.metadata);
    assert.equal(restored.workspaceOrigin, golden.metadata.workspaceOrigin);
    assertPreserved(db, before);
    assert.deepEqual(snapshot(db), profile(`restored-25${suffix}`));
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    assert.equal(validateWorkspaceRestoreSchema(db).workspaceOrigin, golden.metadata.workspaceOrigin);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes, 'validation performs no data writes');
    assert.deepEqual(snapshot(db), profile(`restored-25${suffix}`));
  });

  test(`independent frozen restored25${suffix} opens and validates without ordinary bootstrap or evidence rewrites`, t => {
    const name = `restored-25${suffix}`;
    const store = openStore(onDisk(t, name));
    try {
      assert.deepEqual(snapshot(store.db), profile(name));
      assert.equal(getWorkspaceRestoreContext(store).workspaceOrigin, golden.metadata.workspaceOrigin);
      assert.deepEqual(classifyWorkspaceSchema(store.db), {schemaVersion: 25, profile: 'restored-local-v1'});
      assert.equal(validateWorkspaceRestoreSchema(store.db).sourceSchema, 24);
      if (seeded) constraints(store.db, {restored: true, mock});
      assert.deepEqual(snapshot(store.db), profile(name));
    } finally { store.close(); }
  });
}

for (const repair of ['known-marker-gap', 'initial-markers-absent', 'marker-table-absent']) {
  test(`ordinary runtime retains baseline repair eligibility for ${repair}; offline classification stays strict`, t => {
    const initial = repair === 'marker-table-absent' ? 'ordinary-13' : 'ordinary-24-seeded';
    const root = onDisk(t, initial);
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    try {
      db.exec(repair === 'known-marker-gap' ? 'DELETE FROM schema_version WHERE version=7'
        : repair === 'initial-markers-absent' ? 'DELETE FROM schema_version WHERE version<=14'
          : 'DROP TABLE schema_version');
      const before = snapshot(db);
      assert.throws(() => classifyWorkspaceSchema(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
    const store = openStore(root);
    try {
      assert.deepEqual(snapshot(store.db), currentOrdinaryProfile(repair === 'marker-table-absent' ? 'ordinary-24' : initial));
      assert.equal(getWorkspaceRestoreContext(store), null);
    } finally { store.close(); }
  });
}

for (const version of [26, 27, 28, 29]) {
  test(`unsupported marker-only profile${version} is refused before ordinary bootstrap can execute imported SQL`, t => {
    const root = onDisk(t, 'ordinary-24-seeded');
    const file = path.join(root, 'workbench.sqlite');
    let db = new DatabaseSync(file);
    db.exec(`INSERT INTO schema_version VALUES(${version}); CREATE TRIGGER observe_bootstrap BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT,'GOLDEN_ORDINARY_BOOTSTRAP_RAN'); END`);
    const before = snapshot(db);
    db.close();
    assert.throws(() => openStore(root), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
    db = new DatabaseSync(file);
    try { assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  });
}

for (const [label, initial, mutation] of [
  ['marker25 only', 'ordinary-24-seeded', 'INSERT INTO schema_version VALUES(25)'],
  ['restore metadata only', 'ordinary-24-seeded', 'CREATE TABLE workspace_restoration(id TEXT)'],
  ['execution epoch only', 'ordinary-24-seeded', "ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT DEFAULT 'captured'"],
  ['restore guard missing', 'restored-25-seeded', 'DROP TRIGGER restore_legacy_schema_gate'],
  ['restore marker missing', 'restored-25-seeded', 'DROP TRIGGER restore_schema_marker_delete; DELETE FROM schema_version WHERE version=25'],
  ['restore Mock evidence missing', 'restored-25-mock-seeded', 'DROP TABLE workspace_restore_mock_evidence'],
]) {
  test(`${label} cannot enter ordinary bootstrap or mutate frozen captured bytes`, t => {
    const root = onDisk(t, initial);
    const file = path.join(root, 'workbench.sqlite');
    let db = new DatabaseSync(file);
    db.exec(mutation);
    db.exec("CREATE TRIGGER observe_bootstrap BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT,'GOLDEN_ORDINARY_BOOTSTRAP_RAN'); END");
    const before = snapshot(db);
    db.close();
    assert.throws(() => openStore(root), error => /^RESTORE_SCHEMA_/.test(error.code || '') && !error.message.includes('GOLDEN_ORDINARY_BOOTSTRAP_RAN'));
    db = new DatabaseSync(file);
    try { assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  });
}
