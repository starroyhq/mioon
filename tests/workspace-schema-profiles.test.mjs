import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import * as fixedInputs from '../packages/business/src/workspace-schema-v24-constants.ts';
import {mkdtempSync, realpathSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore, getWorkspaceRestoreContext, classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {initializeLegacyWorkspaceSchema, initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {classifyWorkspaceSchema, installWorkspaceRestoreSchema, validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';

// Independent, committed outputs of fixed 0343 source, never regenerated from
// the implementation under test. See the manifest for extraction provenance and
// the deliberately synthetic marker1 boundary in the initial trusted SQL batch.
const fixtureRoot = new URL('./fixtures/workspace-schema-profiles/', import.meta.url);
const fixtureBytes = readFileSync(new URL('golden.json', fixtureRoot));
const golden = JSON.parse(fixtureBytes);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureRoot), 'utf8'));
// The manifest records provenance of the pre-migration `.mjs` sources. Its
// historical hashes stay authoritative and are never re-baselined; this map
// renames every legacy key to the migrated `.ts` source and pins a
// deterministic esbuild type-erased hash of the current body, so later edits
// remain detectable without rewriting the recorded historical values.
const migrationSourceMap = JSON.parse(readFileSync(new URL('ts-migration-map.json', fixtureRoot), 'utf8'));
// Reviewed snapshot of the current ordinary schema delta beyond the independent
// ordinary24 golden: project-lifecycle48 additions and lifecycle-aware
// retention guards. Frozen once from reviewed migration output; exact
// definitions and catalog hashes make later schema edits fail until reviewed.
const currentOrdinaryDelta = JSON.parse(readFileSync(new URL('current-ordinary-48-delta.json', fixtureRoot), 'utf8'));
const legacyCurrentPath = legacy => migrationSourceMap.mapping[legacy]?.currentPath ?? migrationSourceMap.dependencyDeclarations[legacy]?.currentPath ?? legacy.replace(/\.mjs$/, '.ts');
const currentSourceOf = legacy => readFileSync(new URL('../' + legacyCurrentPath(legacy), import.meta.url), 'utf8');
const erasedSourceOf = legacy => transformSync(currentSourceOf(legacy), {loader: 'ts', format: 'esm', target: 'es2022'}).code;
const closureStatementsOf = (legacy, code) => {
  const ast = ts.createSourceFile(legacy, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ast.statements.filter(statement => !(ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement))
    && statement.getText(ast) !== 'export const initializeWorkspaceSchemaThrough24=initializeLegacyWorkspaceSchema;').map(statement => statement.getText(ast));
};
const dependencyDeclarationsOf = (legacy, code) => {
  const ast = ts.createSourceFile(legacy, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ast.statements.filter(statement => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
    || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)).map(statement => statement.getText(ast));
};
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profile = name => ({
  objects: golden.profiles[name].schema.map(id => golden.definitions[id]),
  tables: golden.profiles[name].tables,
});

// Current ordinary40 retains the reviewed26 task CHECK and adds markers28 through40 plus
// the separately pinned LUT and annotation catalogs below. Keep the independent24 golden intact;
// historical constructors and profiles still compare against its original bytes.
function currentOrdinaryProfile(name = 'ordinary-24') {
  const expected = structuredClone(profile(name));
  for (const object of expected.objects) {
    const reviewed = currentOrdinaryDelta.objectSql[object.name];
    if (typeof reviewed === 'string') object.sql = reviewed;
  }
  expected.tables.schema_version.rows.push(['26', 'integer', '3236'], ['28', 'integer', '3238'], ['30', 'integer', '3330'], ['32', 'integer', '3332'], ['34', 'integer', '3334'], ['36', 'integer', '3336'], ['38', 'integer', '3338'], ['40', 'integer', '3430'], ...currentOrdinaryDelta.schemaVersionRows);
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

// Reviewed schema28/36 additions, pinned independently rather than imported from
// the implementation under test. Unknown objects and changed SQL still fail.
function currentOrdinarySnapshot(db) {
  const actual = snapshot(db), lutTables = new Set(['project_lut_resources', 'lut_import_requests']);
  const lutObjects = actual.objects.filter(object => lutTables.has(object.tbl_name));
  assert.equal(lutObjects.length, currentOrdinaryDelta.lutCatalog.count);
  assert.equal(sha(JSON.stringify(lutObjects)), currentOrdinaryDelta.lutCatalog.sha256, 'exact reviewed LUT table/index/protection catalog');
  assert.deepEqual(actual.tables.project_lut_resources, {fields: ['id','projectId','name','sha256','sizeBytes','profile','metadata','content','createdAt'], rows: []});
  assert.deepEqual(actual.tables.lut_import_requests, {fields: ['requestId','projectId','inputHash','resourceId'], rows: []});
  actual.objects = actual.objects.filter(object => !lutTables.has(object.tbl_name));
  for (const table of lutTables) delete actual.tables[table];
  // Independent reviewed36 pin already retained by workspace-schema-dispatch.test.mjs.
  // Include reverse request guards on historical tables before stripping the additions.
  const annotationObjects = actual.objects.filter(object => /annotation/.test(object.name));
  assert.equal(annotationObjects.length, currentOrdinaryDelta.annotationCatalog.count);
  assert.equal(sha(JSON.stringify(annotationObjects)), currentOrdinaryDelta.annotationCatalog.sha256, 'exact reviewed annotation table/index/protection catalog');
  assert.deepEqual(actual.tables.asset_annotations, {fields: ['assetId','projectId','revision','tags','note'], rows: []});
  assert.deepEqual(actual.tables.asset_annotation_requests, {fields: ['requestId','operation','projectId','canonicalInput','response'], rows: []});
  actual.objects = actual.objects.filter(object => !/annotation/.test(object.name));
  for (const table of ['asset_annotations','asset_annotation_requests']) delete actual.tables[table];
  // Reviewed current-schema delta: project-lifecycle48 catalogs stay pinned
  // independently of the implementation under test.
  const lifecycleNames = new Set(currentOrdinaryDelta.lifecycleObjects.map(object => object.name));
  const lifecycleObjects = actual.objects.filter(object => lifecycleNames.has(object.name));
  assert.equal(lifecycleObjects.length, currentOrdinaryDelta.lifecycleCatalog.count);
  assert.equal(sha(JSON.stringify(lifecycleObjects)), currentOrdinaryDelta.lifecycleCatalog.sha256, 'exact reviewed project-lifecycle table/index/protection catalog');
  assert.deepEqual(lifecycleObjects, currentOrdinaryDelta.lifecycleObjects, 'reviewed project-lifecycle definitions');
  for (const [name, expected] of Object.entries(currentOrdinaryDelta.lifecycleTables)) {
    assert.deepEqual(actual.tables[name], {fields: expected.fields, rows: []}, `${name}: reviewed empty lifecycle rows`);
    delete actual.tables[name];
  }
  actual.objects = actual.objects.filter(object => !lifecycleNames.has(object.name));
  return actual;
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
      statement.setReadBigInts(true);
      for (const row of rows) statement.run(BigInt(row[0]), ...fields.map((_, i) => decode(row[1 + 2 * i], row[2 + 2 * i])));
    }
    if (expected.tables.sqlite_sequence) {
      db.exec('DELETE FROM sqlite_sequence');
      const sequenceInsert = db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)');sequenceInsert.setReadBigInts(true);
      for (const row of expected.tables.sqlite_sequence.rows) {
        sequenceInsert.run(BigInt(row[0]), decode(row[1], row[2]), decode(row[3], row[4]));
      }
    }
    // Node 26 node:sqlite converts the connection's last-insert rowid on every
    // run(); preserved >MAX_SAFE_INTEGER rowids must not leak into later
    // read-only classification. This temp insert changes no main-schema state.
    db.exec('CREATE TEMP TABLE IF NOT EXISTS last_insert_rowid_reset(value);INSERT INTO last_insert_rowid_reset(rowid,value) VALUES(1,1);DELETE FROM last_insert_rowid_reset;DROP TABLE last_insert_rowid_reset;');
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
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-schema-profile-golden-'));
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
  // Recorded values stay exactly as captured before the source rename; the map
  // documents the resumable current `.ts` body hash after deterministic type erasure.
  for (const [legacy, recorded] of Object.entries(manifest.constructorSources)) {
    const mapped = migrationSourceMap.mapping[legacy];
    assert.ok(mapped, `${legacy}: documented legacy path mapping`);
    assert.equal(mapped.legacyPath, legacy, `${legacy}: legacy path is unchanged`);
    assert.equal(mapped.legacyConstructorSha256, recorded, `${legacy}: historical constructor hash is not re-baselined`);
    assert.equal(sha(erasedSourceOf(legacy)), mapped.typeErasedSha256, `${legacy}: deterministic type-erased current body`);
  }
  for (let version = 1; version <= 24; version++) assert.ok(golden.profiles[`ordinary-${version}`]);
  for (const profile of Object.values(golden.profiles)) for (const id of profile.schema) assert.ok(golden.definitions[id]);
});

test('through24 schema-only dependency bodies stay byte-frozen independently of constructor output', () => {
  for (const [legacy, recorded] of Object.entries(manifest.closureStatements)) {
    const mapped = migrationSourceMap.mapping[legacy];
    assert.ok(mapped, `${legacy}: documented legacy path mapping`);
    assert.equal(mapped.legacyClosureSha256, recorded.sha256, `${legacy}: historical closure hash is not re-baselined`);
    const statements = closureStatementsOf(legacy, erasedSourceOf(legacy));
    assert.equal(statements.length, mapped.typeErasedClosureStatements, `${legacy}: fixed closure statement count after type erasure`);
    assert.equal(sha(JSON.stringify(statements)), mapped.typeErasedClosureSha256, `${legacy}: fixed function/SQL definition bodies after type erasure`);
  }
  // Regression ownership only: this is not a runtime tamper-proofing claim.
  // The reviewed role detector changed; all v25 construction and validation,
  // literal SQL, family/Mock descriptors and caches remain baseline-owned.
  const expected = manifest.restore25Closure;
  const mapped = migrationSourceMap.mapping[expected.file];
  assert.ok(mapped, `${expected.file}: documented legacy path mapping`);
  assert.equal(mapped.legacyClosureSha256, expected.sha256, 'v25 historical closure hash is not re-baselined');
  const ast = ts.createSourceFile(expected.file, erasedSourceOf(expected.file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statements = ast.statements.filter(statement => !(ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement))
    && !(ts.isFunctionDeclaration(statement) && statement.name?.text === expected.excludedFunction))
    .map(statement => {
      let body = statement.getText(ast);
      for (const [current, baseline] of Object.entries(expected.allowedIdentifierRenames)) {
        body = body.replaceAll(new RegExp('\\b' + current + '\\b', 'g'), baseline);
      }
      return body;
    });
  assert.equal(statements.length, mapped.typeErasedClosureStatements, 'v25 fixed closure statement count after type erasure');
  assert.equal(sha(JSON.stringify(statements)), mapped.typeErasedClosureSha256, 'v25 construction/evidence/validation/cache closure after type erasure');
});

test('fixed schema dependency imports and re-exports cannot reconnect to active runtime constants', () => {
  const requiredFiles = [
    ...Object.keys(manifest.closureStatements),
    manifest.restore25Closure.file,
    'packages/business/src/workspace-schema-v24-constants.ts',
  ];
  assert.deepEqual(Object.keys(manifest.dependencyDeclarations).sort(), requiredFiles.sort());
  for (const [legacy, recorded] of Object.entries(manifest.dependencyDeclarations)) {
    const mapped = migrationSourceMap.dependencyDeclarations[legacy];
    assert.ok(mapped, `${legacy}: documented legacy path mapping`);
    assert.equal(mapped.legacyPath, legacy, `${legacy}: legacy path is unchanged`);
    assert.deepEqual(recorded, mapped.legacyDeclarations, `${legacy}: historical declarations are not re-baselined`);
    assert.deepEqual(dependencyDeclarationsOf(legacy, erasedSourceOf(legacy)), mapped.typeErasedDeclarations, `${legacy}: current type-erased dependency declarations`);
    const source = currentSourceOf(legacy);
    const ast = ts.createSourceFile(legacy, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dynamicDependencies = [];
    const visit = node => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        dynamicDependencies.push(node.getText(ast));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.deepEqual(dynamicDependencies, [], `${legacy}: no dynamic dependency escape`);
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
  test(`frozen ordinary${version} classifies without mutation and runtime opens with only the reviewed ordinary40 delta`, t => {
    const name = `ordinary-${version}`;
    const root = onDisk(t, name);
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    try {
      assert.deepEqual(classifyWorkspaceSchema(db), {schemaVersion: version, profile: 'ordinary'});
      assert.deepEqual(snapshot(db), profile(name));
    } finally { db.close(); }
    const store = openStore(root);
    try {
      assert.deepEqual(currentOrdinarySnapshot(store.db), currentOrdinaryProfile());
      assertPreserved(store.db, profile(name), version);
      assert.equal(getWorkspaceRestoreContext(store), null);
    } finally { store.close(); }
  });
}

test('fresh runtime construction has only the reviewed ordinary40 delta and no restoration authority', t => {
  const store = openStore(onDisk(t));
  try {
    assert.deepEqual(currentOrdinarySnapshot(store.db), currentOrdinaryProfile());
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
  test(`frozen ordinary24${suffix} reopens with only the reviewed28 through40 schema delta, preserving raw rows, receipts and sequence`, t => {
    const name = `ordinary-24${suffix}`;
    const store = openStore(onDisk(t, name));
    try {
      assert.deepEqual(currentOrdinarySnapshot(store.db), currentOrdinaryProfile(name));
      assertPreserved(store.db, profile(name));
      assert.deepEqual(classifyCurrentWorkspaceSchema(store.db), {schemaVersion: 48, profile: 'ordinary'});
      if (seeded) constraints(store.db, {restored: false, mock});
      assert.deepEqual(currentOrdinarySnapshot(store.db), currentOrdinaryProfile(name));
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
    const root = onDisk(t, name);
    // Seeded goldens intentionally retain opaque historical BLOB receipts.
    // Offline classification and fixed-profile validation stay available, while
    // current admission fails closed exactly as workspace-blob-admission-boundary pins.
    const db = new DatabaseSync(path.join(root, 'workbench.sqlite'));
    try {
      assert.deepEqual(snapshot(db), profile(name));
      assert.deepEqual(classifyWorkspaceSchema(db), {schemaVersion: 25, profile: 'restored-local-v1'});
      assert.equal(validateWorkspaceRestoreSchema(db).sourceSchema, 24);
      if (seeded) constraints(db, {restored: true, mock});
      assert.deepEqual(snapshot(db), profile(name));
    } finally { db.close(); }
    if (seeded) {
      assert.throws(() => openStore(root), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
      return;
    }
    const store = openStore(root);
    try {
      assert.deepEqual(snapshot(store.db), profile(name));
      assert.equal(getWorkspaceRestoreContext(store).workspaceOrigin, golden.metadata.workspaceOrigin);
      assert.deepEqual(snapshot(store.db), profile(name));
    } finally { store.close(); }
  });
}

for (const repair of ['known-marker-gap', 'initial-markers-absent', 'marker-table-absent']) {
  test(`ordinary runtime retains baseline repair eligibility for ${repair}; offline classification stays strict`, t => {
    const initial = repair === 'marker-table-absent' ? 'ordinary-13' : 'ordinary-24';
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
      assert.deepEqual(currentOrdinarySnapshot(store.db), currentOrdinaryProfile(repair === 'marker-table-absent' ? 'ordinary-24' : initial));
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
