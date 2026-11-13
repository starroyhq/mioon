import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectStore, openStore} from '../packages/business/src/project-file/index.ts';
import {schemaObjects} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {tokenizeSql} from './helpers/sql-tokenizer.ts';
import type {SqlToken} from './helpers/sql-tokenizer.ts';

type Catalog = ReturnType<typeof schemaObjects>;
const lower = (value: string): string => value.replace(/[A-Z]/gu, char => char.toLowerCase());
const word = (token: SqlToken | undefined, value: string): boolean => token?.kind === 'word' && token.value.toUpperCase() === value;
const punct = (token: SqlToken | undefined, value: string): boolean => token?.kind === 'punct' && token.value === value;
function identifier(token: SqlToken | undefined): string {
  assert.ok(token?.kind === 'word' || token?.kind === 'quoted', 'Unrecognised write target or trigger table');
  return lower(token.value);
}
function relation(tokens: readonly SqlToken[], at: number): {schema?: string; table: string} {
  const first = identifier(tokens[at]);
  return punct(tokens[at + 1], '.') ? {schema: first, table: identifier(tokens[at + 2])} : {table: first};
}
function statements(tokens: readonly SqlToken[]): SqlToken[][] {
  const result: SqlToken[][] = []; let current: SqlToken[] = [], depth = 0;
  for (const token of tokens) {
    if (punct(token, '(')) depth++;
    if (punct(token, ')')) depth--;
    assert.ok(depth >= 0, 'Unbalanced trigger body');
    if (punct(token, ';') && depth === 0) {if (current.length) result.push(current); current = [];}
    else current.push(token);
  }
  assert.equal(depth, 0, 'Unbalanced trigger body');
  if (current.length) result.push(current);
  return result;
}

/** Analyse the installed SQL, including TEMP cross-file triggers. Unsupported
 * syntax fails the guard rather than silently omitting a possible write edge. */
function assertTriggerGraph(catalog: Catalog) {
  const tables = new Set(catalog.filter(row => row.type === 'table' || row.type === 'view').map(row => `${lower(row.schema)}.${lower(row.name)}`));
  const graph = new Map<string, Set<string>>(); let writers = 0;
  function resolve(ref: ReturnType<typeof relation>, schema: string): string {
    if (ref.schema !== undefined || schema !== 'temp') {
      const name = `${ref.schema ?? schema}.${ref.table}`;
      assert.ok(tables.has(name), `Unknown trigger relation ${name}`); return name;
    }
    // Kernel TEMP writers currently use unique names. A future ambiguous name
    // needs an explicit resolution review before recursive execution is safe.
    const candidates = [...tables].filter(name => name.slice(name.indexOf('.') + 1) === ref.table);
    assert.equal(candidates.length, 1, `Ambiguous or unknown TEMP relation ${ref.table}: ${candidates.join(', ')}`);
    return candidates[0]!;
  }
  for (const row of catalog) {
    if (row.type !== 'table' && row.type !== 'index' && row.type !== 'trigger') continue;
    if (row.sql === null) {assert.equal(row.type, 'index'); continue;}
    const tokens = tokenizeSql(row.sql), label = `${row.schema}.${row.name}`;
    if (row.type !== 'trigger') {
      assert.ok(!tokens.some((token, index) => word(token, 'ON') && word(tokens[index + 1], 'CONFLICT') && word(tokens[index + 2], 'REPLACE')), `${label}: ON CONFLICT REPLACE is unsafe with recursive triggers`);
      continue;
    }
    const begin = tokens.findIndex(token => word(token, 'BEGIN'));
    let end = tokens.length - 1; while (punct(tokens[end], ';')) end--;
    assert.ok(begin >= 0 && word(tokens[end], 'END'), `${label}: Unsupported trigger body`);
    const on = tokens.findIndex((token, index) => index < begin && word(token, 'ON'));
    assert.ok(on >= 0, `${label}: Missing trigger source`);
    const sourceRef = relation(tokens, on + 1), schema = lower(row.schema);
    assert.equal(sourceRef.table, lower(row.tbl_name), `${label}: Trigger source disagrees with SQLite`);
    if (schema !== 'temp' && sourceRef.schema !== undefined) assert.equal(sourceRef.schema, schema);
    const source = resolve(sourceRef, schema), body = tokens.slice(begin + 1, end);
    assert.ok(!body.some(token => word(token, 'REPLACE')), `${label}: REPLACE in trigger body`);
    let writes = false;
    for (const statement of statements(body)) {
      if (word(statement[0], 'SELECT')) continue;
      let at = 1;
      if (word(statement[0], 'INSERT') || word(statement[0], 'UPDATE')) {
        if (word(statement[at], 'OR')) {
          assert.ok(['ABORT', 'FAIL', 'IGNORE', 'ROLLBACK'].some(value => word(statement[at + 1], value)), `${label}: Unknown conflict policy`);
          at += 2;
        }
        if (word(statement[0], 'INSERT')) {assert.ok(word(statement[at], 'INTO'), `${label}: Missing INTO`); at++;}
      } else if (word(statement[0], 'DELETE')) {assert.ok(word(statement[at], 'FROM'), `${label}: Missing FROM`); at++;}
      else assert.fail(`${label}: Unsupported trigger statement ${statement[0]?.text}`);
      // Only the statement's leading DML owns the edge. UPSERT's later
      // DO UPDATE SET is part of INSERT and has no separate target table.
      const target = resolve(relation(statement, at), schema);
      assert.notEqual(source, target, `${label}: Trigger writes its own table ${source}`);
      const edges = graph.get(source) ?? new Set<string>(); edges.add(target); graph.set(source, edges); writes = true;
    }
    if (writes) writers++;
  }
  const visiting = new Set<string>(), done = new Set<string>();
  function visit(table: string, path: readonly string[]): void {
    assert.ok(!visiting.has(table), `Trigger write cycle: ${[...path, table].join(' -> ')}`);
    if (done.has(table)) return;
    visiting.add(table);
    for (const next of graph.get(table) ?? []) visit(next, [...path, table]);
    visiting.delete(table); done.add(table);
  }
  for (const table of graph.keys()) visit(table, []);
  return {graph, writers};
}

for (const format4 of [false, true]) test(`fresh K1 ${format4 ? 'candidate' : 'released'} connection trigger writes are acyclic, never self-write and cannot implicitly REPLACE`, t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-trigger-graph-'));
  const store = format4 ? createProjectStore({projectFile: join(root, 'candidate.mioon'), format4: {},
    locate: () => ({localDir: join(root, 'records'), cacheDir: join(root, 'cache'), tempDir: join(root, 'temp')})}) : openStore(root);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  assert.equal(store.db.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 1);
  const catalog = schemaObjects(store.db), triggers = catalog.filter(row => row.type === 'trigger');
  for (const schema of ['main', 'project', 'cache', 'temp']) assert.ok(triggers.some(row => row.schema === schema), `No triggers inventoried in ${schema}`);
  assert.ok(triggers.some(row => row.schema === 'temp' && row.name === 'project_file_seen_sequence'));
  const {graph, writers} = assertTriggerGraph(catalog);
  assert.ok(writers > 0); assert.ok(graph.get('project.project_file')?.has('main.history_state'));
  t.diagnostic(`${triggers.length} installed triggers, ${writers} writers, ${[...graph.values()].reduce((sum, edges) => sum + edges.size, 0)} distinct write edges`);
});

test('the guard detects real unsafe DDL and distinguishes UPSERT, quoted names, literals and cross-file edges', () => {
  function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec("ATTACH ':memory:' AS project; ATTACH ':memory:' AS cache");
    for (const schema of ['main', 'project']) db.exec(`CREATE TABLE ${schema}.a(value INTEGER UNIQUE); CREATE TABLE ${schema}.b(value INTEGER UNIQUE)`);
    return db;
  }
  const safe = fixture();
  try {
    safe.exec(`CREATE TRIGGER main.safe AFTER INSERT ON a BEGIN
      SELECT 'REPLACE; UPDATE a; ON CONFLICT REPLACE', CASE WHEN NEW.value=1 THEN 'END' ELSE 'BEGIN' END;
      /* REPLACE INTO a */ INSERT OR IGNORE INTO "b" VALUES(NEW.value) ON CONFLICT(value) DO UPDATE SET value=excluded.value;
    END`);
    safe.exec('CREATE TRIGGER project.other AFTER INSERT ON b BEGIN DELETE FROM [a] WHERE value=NEW.value; END');
    safe.exec('CREATE TEMP TRIGGER cross_file AFTER INSERT ON project.a BEGIN UPDATE b SET value=NEW.value; END');
    // The TEMP target b is deliberately ambiguous; guessing a schema would
    // risk accepting a graph different from the actual connection's writes.
    assert.throws(() => assertTriggerGraph(schemaObjects(safe)), /Ambiguous.*TEMP relation b/u);
    safe.exec('DROP TRIGGER temp.cross_file; CREATE TABLE main.sink(value INTEGER); CREATE TEMP TRIGGER cross_file AFTER INSERT ON project.a BEGIN UPDATE sink SET value=NEW.value; END');
    const {graph} = assertTriggerGraph(schemaObjects(safe));
    assert.ok(graph.get('main.a')?.has('main.b')); assert.ok(graph.get('project.b')?.has('project.a')); assert.ok(graph.get('project.a')?.has('main.sink'));
  } finally {safe.close();}
  for (const [sql, failure] of [
    ['CREATE TRIGGER bad AFTER INSERT ON a BEGIN UPDATE a SET value=NEW.value; END', /writes its own table/u],
    ['CREATE TRIGGER forward AFTER INSERT ON a BEGIN INSERT INTO b VALUES(NEW.value); END; CREATE TRIGGER backward AFTER INSERT ON b BEGIN DELETE FROM a; END', /write cycle/u],
    ['CREATE TRIGGER bad AFTER INSERT ON a BEGIN INSERT OR REPLACE INTO b VALUES(NEW.value); END', /REPLACE in trigger body/u],
    ['CREATE TRIGGER bad AFTER INSERT ON a BEGIN REPLACE INTO b VALUES(NEW.value); END', /REPLACE in trigger body/u],
    ['CREATE TABLE bad(value INTEGER UNIQUE ON /* split */ CONFLICT REPLACE)', /ON CONFLICT REPLACE/u],
  ] as const) {
    const db = fixture();
    try {db.exec(sql); assert.throws(() => assertTriggerGraph(schemaObjects(db)), failure);} finally {db.close();}
  }
});
