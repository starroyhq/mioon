import {CURRENT_ORDINARY_SCHEMA} from './helpers/workspace-schema-current.ts';
import {reviewedCatalogAt} from './helpers/reviewed-schema-layers.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
function withoutReviewedCurrentAgentObjects(objects: Parameters<typeof withoutReviewedConversationObjects>[0]){return reviewedCatalogAt(52,objects);}
// Causal boundary tests only. Existing independent goldens and their six
// current-open expectations remain untouched. TEXT is a separate initial input
// dataset; its before snapshot is a preservation oracle, not an independent
// golden for the fixed25 constructor or its capture algorithm.
import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, realpathSync, readFileSync, rmSync, chmodSync, readdirSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {openStore, getWorkspaceRestoreContext, classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {classifyWorkspaceSchema, installWorkspaceRestoreSchema, validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {open, fixture, snapshot, golden, quote} from './workspace-schema26-fixtures.mjs';
import {currentOrdinary52Delta} from './helpers/current-schema-delta.ts';
import {withoutReviewedConversationObjects} from './helpers/current-schema54-delta.ts';
import type { WithImplicitCoercion } from 'buffer';
import type { PathOrFileDescriptor } from 'fs';

let forbiddenEffects = 0;
const forbidden = () => {forbiddenEffects++; throw Error('No provider, child, listener or network in BLOB admission boundary tests');};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(cp, name, forbidden);
mock.method(net.Server.prototype, 'listen', forbidden); mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
const mediaEvents: unknown[] = [], offMedia = onMediaProcess(event => mediaEvents.push(event));
after(() => {offMedia(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenEffects, 0); assert.deepEqual(mediaEvents, []);});

const textValue = {retained: true, name: '界', n: 2};
const textReceipt = ' \n' + JSON.stringify(textValue, null, '\t').replaceAll('界', '\\u754c').replace('"n": 2', '"n": 2.00') + '\n ';
const hexadecimal = (bytes: Iterable<number>|ArrayLike<number>) => Array.from(bytes, byte => '0123456789ABCDEF'[byte >> 4] + '0123456789ABCDEF'[byte & 15]).join('');
const textHex = hexadecimal(new TextEncoder().encode(textReceipt));
const decode = (type: unknown, value: WithImplicitCoercion<string>) => {
  if (type === 'null') return null;
  if (type === 'real') return Number(value);
  const bytes = Buffer.from(value, 'hex');
  if (type === 'blob') return bytes; // Opaque historical cells remain binary.
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (type === 'integer') return BigInt(text);
  assert.equal(type, 'text'); return text;
};
function rawRows(db: import('node:sqlite').DatabaseSync, table: string, fields: readonly unknown[], where = '') {
  // CAST is read-only raw SQLite evidence, never a response conversion/write.
  const expressions = fields.flatMap((field: unknown) => [`typeof(${quote(field)})`, `CASE WHEN typeof(${quote(field)})='real' THEN printf('%!.26g',${quote(field)}) ELSE hex(CAST(${quote(field)} AS BLOB)) END`]);
  const statement = db.prepare(`SELECT CAST(rowid AS TEXT),${expressions.join(',')} FROM main.${quote(table)} ${where} ORDER BY rowid`);
  statement.setReturnArrays(true); return {fields, rows: statement.all()};
}
function preserveOriginalRows(db: DatabaseSync, before: import('./helpers/strict-workspace-boundary-types.ts').SchemaSnapshot) {
  for (const [table, expected] of Object.entries(before.tables)) {
    const where = table === 'schema_version' ? 'WHERE version<=24' : '';
    assert.deepEqual(rawRows(db, table, ((expected.fields) as unknown as Parameters<typeof rawRows>[2]), where), expected, table + ': original SQLite types, raw bytes, rowids and sequence');
  }
}
function textInput(db: DatabaseSync, mockLedger: boolean) {
  const name = `ordinary-24${mockLedger ? '-mock' : ''}-seeded`;
  const input = {objects: (golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).profiles[name].schema.map((id) => (golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).definitions[id]), tables: structuredClone((golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).profiles[name].tables)};
  const row = input.tables.timeline_requests.rows[0] as string[];
  assert.equal(input.tables.timeline_requests.rows.length, 1); assert.equal(row[0], '88');
  assert.equal(row[5], 'blob'); assert.equal(row[6], '00FF0D0A');
  // New TEXT exists before the very first INSERT. No BLOB is coerced or
  // inserted and then UPDATEd; original golden values are never modified.
  row[5] = 'text'; row[6] = textHex;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN');
  try {
    for (const object of input.objects) if (object.type === 'table' && object.name !== 'sqlite_sequence') db.exec(object.sql!);
    for (const [table, {fields, rows}] of Object.entries(input.tables)) {
      if (table === 'sqlite_sequence') continue;
      const insert = db.prepare(`INSERT INTO main.${quote(table)}(rowid,${fields.map(quote).join(',')}) VALUES(${Array(fields.length + 1).fill('?').join(',')})`);
      insert.setReadBigInts(true);
      for (const value of rows) insert.run(BigInt(value[0]), ...fields.map((_, i) => decode(value[1 + i * 2], value[2 + i * 2])));
    }
    db.exec('DELETE FROM sqlite_sequence');
    const sequenceInsert = db.prepare('INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)');sequenceInsert.setReadBigInts(true);
    for (const value of input.tables.sqlite_sequence.rows)
      sequenceInsert.run(BigInt(value[0]), decode(value[1], value[2]), decode(value[3], value[4]));
    for (const object of input.objects) if (object.type !== 'table' && object.sql !== null) db.exec(object.sql);
    db.exec('COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {if (db.isTransaction) db.exec('ROLLBACK'); throw error;}
  assert.deepEqual(snapshot(db), input, 'the separate initial TEXT dataset was inserted exactly');
  assertText(db); return snapshot(db);
}
function assertText(db: DatabaseSync) {
  const receipt = db.prepare('SELECT rowid,typeof(response) AS type,hex(response) AS bytes,response FROM timeline_requests').get();
  assert.equal(receipt!.rowid, 88); assert.equal(receipt!.type, 'text'); assert.equal(receipt!.bytes, textHex);
  assert.equal(receipt!.response, textReceipt); assert.deepEqual(JSON.parse((receipt!.response as string)), textValue);
  assert.match(receipt!.response, /\\u754c/); assert.match(receipt!.response, /2\.00/); assert.match(receipt!.response, /^ \n/);
}
function assertBlob(db: DatabaseSync) {
  const receipt = db.prepare('SELECT rowid,typeof(response) AS type,hex(response) AS bytes,response FROM timeline_requests').get();
  assert.equal(receipt!.rowid, 88); assert.equal(receipt!.type, 'blob'); assert.equal(receipt!.bytes, '00FF0D0A');
  assert.deepEqual(receipt!.response, new Uint8Array([0, 255, 13, 10]));
}
function historicalBlobProof(mockLedger: boolean) {
  const db = open(':memory:');
  try {
    fixture(db, `ordinary-24${mockLedger ? '-mock' : ''}-seeded`); assertBlob(db);
    const before = snapshot(db); installWorkspaceRestoreSchema(db, (golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).metadata); preserveOriginalRows(db, before);
    const captured = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.equal((validateWorkspaceRestoreSchema(db) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata).sourceSchema, 24);
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes); assert.deepEqual(snapshot(db), captured); assertBlob(db);
    const hold = db.prepare("SELECT capturedRowid,rowHash FROM workspace_restore_holds WHERE kind='timeline_requests'").get();
    assert.equal(hold!.capturedRowid, 88); assert.equal(hold!.rowHash, '0b6f727cd3bf2697d576c454ef851f04c4ad7a9f08d2cd092ee03c18ea79d7cd');
  } finally {db.close();}
}
function ownedFile(t: { after: (arg0: () => void) => void; }) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-blob-admission-boundary-'));
  assert.equal(realpathSync(root), root); t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'workbench.sqlite'), db = open(file); chmodSync(file, 0o600);
  // Match the current runtime journal policy from initial construction. The
  // subsequent zero-write oracle includes the closed SQLite file header.
  db.exec('PRAGMA journal_mode=WAL'); return {root, file, db};
}
function breakMarkers(db: DatabaseSync, repair: string) {
  db.exec(repair === 'known-marker-gap' ? 'DELETE FROM schema_version WHERE version=7' : 'DELETE FROM schema_version WHERE version<=14');
  const before = snapshot(db);
  assert.throws(() => classifyWorkspaceSchema(db), {code: 'RESTORE_SCHEMA_UNSUPPORTED'}); assert.deepEqual(snapshot(db), before);
}
function observeCold(db: DatabaseSync, file: PathOrFileDescriptor) {
  const before = snapshot(db); db.close(); return {before, bytes: readFileSync(file)};
}
function inspectClosedCopy(t:test.TestContext, file:Parameters<typeof copyFileSync>[0], inspect:(db:DatabaseSync)=>unknown) {
  // SQLite readOnly may create WAL/SHM beside its input. Audit a disposable
  // byte-identical copy so the observation itself cannot touch the source.
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-blob-boundary-observation-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const copy = path.join(root, 'workbench.sqlite'); copyFileSync(file, copy); chmodSync(copy, 0o600);
  assert.deepEqual(readFileSync(copy), readFileSync(file));
  const inspected = new DatabaseSync(copy, {readOnly: true});
  try {inspect(inspected);} finally {inspected.close();}
}
function positiveOrdinary(t: test.TestContext, {mockLedger = false, repair}: {mockLedger?:boolean;repair?:Parameters<typeof breakMarkers>[1]} = {}) {
  const {root, file, db} = ownedFile(t), input = textInput(db, mockLedger);
  assert.deepEqual(classifyWorkspaceSchema(db), {schemaVersion: 24, profile: 'ordinary'});
  if (repair) breakMarkers(db, repair);
  db.close(); let store;
  try {
    store = (openStore(root) as unknown as FixtureStore); assert.deepEqual(classifyCurrentWorkspaceSchema(store.db), {schemaVersion: CURRENT_ORDINARY_SCHEMA, profile: 'ordinary'});
    const currentObjects = withoutReviewedCurrentAgentObjects(snapshot(store.db).objects), current52Names = new Set(currentOrdinary52Delta.objectNames);
    assert.deepEqual(currentObjects.filter(object => current52Names.has(object.name)), currentOrdinary52Delta.objects, 'exact reviewed schema52 catalog additions');
    preserveOriginalRows(store.db, input); assertText(store.db); assert.equal((getWorkspaceRestoreContext(store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null), null);
    const beforeColdReopen = snapshot(store.db); store.close(); store = (openStore(root) as unknown as FixtureStore);
    assert.deepEqual(snapshot(store.db), beforeColdReopen); assertText(store.db); assert.equal((getWorkspaceRestoreContext(store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null), null);
  } finally {if (store?.db.isOpen) store.close();}
}
function positiveRestored(t: test.TestContext, mockLedger: boolean) {
  const {root, file, db} = ownedFile(t), original = textInput(db, mockLedger);
  installWorkspaceRestoreSchema(db, (golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).metadata); preserveOriginalRows(db, original);
  assert.equal((validateWorkspaceRestoreSchema(db) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata).sourceSchema, 24); assertText(db);
  const {before} = observeCold(db, file); let store;
  try {
    store = (openStore(root) as unknown as FixtureStore); assert.deepEqual(snapshot(store.db), before); assertText(store.db);
    assert.equal((getWorkspaceRestoreContext(store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata|null)!.workspaceOrigin, (golden as unknown as import('./helpers/strict-workspace-frozen-types.ts').GoldenFixture).metadata.workspaceOrigin);
    assert.equal((validateWorkspaceRestoreSchema(store.db) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata).sourceSchema, 24);
    store.close(); store = (openStore(root) as unknown as FixtureStore); assert.deepEqual(snapshot(store.db), before); assertText(store.db);
  } finally {if (store?.db.isOpen) store.close();}
}
function negativeBlob(t: test.TestContext, {mockLedger = false, restored = false, repair}: {mockLedger?:boolean;restored?:boolean;repair?:Parameters<typeof breakMarkers>[1]} = {}) {
  historicalBlobProof(mockLedger);
  const {root, file, db} = ownedFile(t), name = `${restored ? 'restored-25' : 'ordinary-24'}${mockLedger ? '-mock' : ''}-seeded`;
  fixture(db, name); assertBlob(db);
  if (restored) {
    const before = snapshot(db); assert.equal((validateWorkspaceRestoreSchema(db) as unknown as import('./helpers/strict-workspace-boundary-types.ts').RestoreMetadata).sourceSchema, 24); assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT rowHash FROM workspace_restore_holds WHERE kind='timeline_requests'").get()!.rowHash, '0b6f727cd3bf2697d576c454ef851f04c4ad7a9f08d2cd092ee03c18ea79d7cd');
  } else assert.deepEqual(classifyWorkspaceSchema(db), {schemaVersion: 24, profile: 'ordinary'});
  if (repair) breakMarkers(db, repair);
  const {before, bytes} = observeCold(db, file), entries = readdirSync(root).sort();
  assert.throws(() => (openStore(root) as unknown as FixtureStore), error => (error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code === 'RESTORE_SCHEMA_UNSUPPORTED' && (error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).message === 'Volume envelopes require an exact supported workspace profile.');
  assert.deepEqual(readFileSync(file), bytes, 'current refusal preserves every SQLite file byte');
  assert.deepEqual(readdirSync(root).sort(), entries, 'refusal leaves no lock, media directory or SQLite sidecar');
  inspectClosedCopy(t, file, (inspected) => {assert.deepEqual(snapshot(inspected), before); assertBlob((inspected as unknown as Parameters<typeof assertBlob>[0]));});
  assert.deepEqual(readFileSync(file), bytes); assert.deepEqual(readdirSync(root).sort(), entries, 'no lock, media directory or SQLite sidecar remains');
}

for (const mockLedger of [false, true] as const) {
  test(`separate initial TEXT ordinary24${mockLedger ? '-mock' : ''} enters54 and cold reopens without changing original typed rows`, t => positiveOrdinary(t, {mockLedger}));
  test(`separate initial TEXT source captured by fixed25${mockLedger ? '-mock' : ''} cold reopens with its complete snapshot unchanged`, t => positiveRestored(t, mockLedger));
  test(`original golden BLOB ordinary24${mockLedger ? '-mock' : ''} remains historically valid and current admission refuses without writes`, t => negativeBlob(t, {mockLedger}));
  test(`original golden BLOB restored25${mockLedger ? '-mock' : ''} retains its fixed capture evidence and current admission refuses without writes`, t => negativeBlob(t, {mockLedger, restored: true}));
}
for (const repair of ['known-marker-gap', 'initial-markers-absent'] as const) {
  test(`separate initial TEXT ${repair} admits ordinary58 while preserving original rows and cold reopen`, t => positiveOrdinary(t, (({repair}) as unknown as Parameters<typeof positiveOrdinary>[1])));
  test(`original golden BLOB ${repair} is refused by current admission without snapshot or file-byte changes`, t => negativeBlob(t, (({repair}) as unknown as Parameters<typeof negativeBlob>[1])));
}
