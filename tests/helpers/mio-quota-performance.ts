import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {MIO_QUOTA_BYTES_SQL, MIO_QUOTA_ROWS_SQL} from '../../packages/business/src/project-file/schema/domains/mio.ts';

const baselineRef = '6d433c23603db0d08289e426bc48440b16d795bf';
const schemaPath = 'packages/business/src/project-file/schema/domains/mio.ts';
const at = '2026-11-02T00:00:00.000Z';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const createPrefix = /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) /u;
const baselineTables = ['mio_conversations', 'mio_runs', 'mio_entries', 'mio_blobs', 'mio_steps', 'mio_requests', 'mio_changes', 'mio_controls', 'mio_control_states', 'mio_imports', 'mio_job_origins', 'mio_edit_claims', 'mio_edit_owners', 'mio_edit_receipts', 'mio_conversation_policies', 'mio_conversation_policy_requests', 'mio_events', 'mio_process_target_revisions'];
export type QuotaBenchmarkProfile = 'baseline' | 'current';
export interface QuotaBenchmarkPoint {label: string; retainedBytes: number; rowBytes: number}
export const quotaBenchmarkPoints: readonly QuotaBenchmarkPoint[] = Object.freeze([
  ...[0, 31, 63, 128, 191, 250].map(mib => ({label: `${mib}MiB-large`, retainedBytes: mib * 1024 * 1024, rowBytes: 2 * 1024 * 1024})),
  {label: '40000-rows-2752B', retainedBytes: 40_000 * 2752, rowBytes: 2752},
]);
interface BaselineSchema {MIO_SCHEMA: readonly string[]; MIO_QUOTA_BYTES_SQL: string; MIO_QUOTA_ROWS_SQL: string}

/** Only private disposable benchmark domains use this old profile. Its scan
 * algorithm is unchanged; the row budget alone is aligned with65536 so the
 * 40k-row case measures a successful write instead of the former20k rejection. */
async function loadBaseline(root: string) {
  const original = execFileSync('git', ['-C', process.cwd(), 'show', `${baselineRef}:${schemaPath}`], {encoding: 'utf8'});
  assert.ok(original.includes('rows:20000'));
  let source = original.replace("import {HISTORY_TABLES_BY_DOMAIN} from '../tables.ts';", `const HISTORY_TABLES_BY_DOMAIN = {mio: ${JSON.stringify(baselineTables)}};`).replace('rows:20000', 'rows:65536');
  source = source.replaceAll("'../../../../../contracts/src/agent-tasks-v2.ts'", JSON.stringify(resolve('packages/contracts/src/agent-tasks-v2.ts'))).replaceAll("'../../../../../contracts/src/mio-records.ts'", JSON.stringify(resolve('packages/contracts/src/mio-records.ts')));
  const modulePath = join(root, 'baseline-schema.ts'); writeFileSync(modulePath, source);
  const module = await import(pathToFileURL(modulePath).href) as BaselineSchema;
  return {module, originalSourceSha256: hash(original), privateModuleSha256: hash(source), privateSchemaSha256: hash(JSON.stringify(module.MIO_SCHEMA))};
}

function rebuildPrivateBaseline(store: ProjectStore, schema: readonly string[]): readonly string[] {
  const names = schema.flatMap(sql => /^CREATE TRIGGER ([a-z_0-9]+) /u.exec(sql)?.[1] ?? []);
  const postponed = schema.filter(sql => /^CREATE TRIGGER quota_mio_/u.test(sql));
  store.tx(() => {
    // DROP never runs the row-retention triggers. All original FK, identity,
    // row and evidence guards are restored before any timed protected write.
    const triggers = store.db.prepare("SELECT name,tbl_name FROM main.sqlite_schema WHERE type='trigger'").all();
    for (const trigger of triggers) if (String(trigger.tbl_name).startsWith('mio_') || names.includes(String(trigger.name))) store.db.exec(`DROP TRIGGER main.${String(trigger.name)}`);
    const tables = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name GLOB 'mio_*' ORDER BY rowid DESC").all();
    for (const table of tables) store.db.exec(`DROP TABLE main.${String(table.name)}`);
    for (const sql of schema) if (!postponed.includes(sql)) store.db.exec(sql.replace(createPrefix, 'CREATE $1 main.'));
  });
  return postponed;
}

const scalar = (value: unknown): number => {assert.equal(typeof value, 'number'); assert.ok(Number.isSafeInteger(value) && Number(value) >= 0); return value as number;};
function fullUsage(store: ProjectStore, bytes: string, rows: string) {
  const row = store.db.prepare(`SELECT ${bytes} AS bytes,${rows} AS rows`).get()!;
  return {bytes: scalar(row.bytes), rows: scalar(row.rows)};
}
function counter(store: ProjectStore) {
  if (!store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='mio_storage_counters'").get()) return null;
  const row = store.db.prepare('SELECT bytes,rows FROM mio_storage_counters WHERE singleton=1').get()!;
  return {bytes: scalar(row.bytes), rows: scalar(row.rows)};
}
function fill(store: ProjectStore, point: QuotaBenchmarkPoint): void {
  const insert = store.db.prepare('INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)');
  store.tx(() => {
    let remaining = point.retainedBytes, index = 0;
    while (remaining > 0) {
      const logicalBytes = Math.min(point.rowBytes, remaining), contentBytes = logicalBytes - 88;
      const prefix = `filler${String(index++).padStart(8, '0')}`; assert.ok(contentBytes >= prefix.length);
      const content = prefix + 'x'.repeat(contentBytes - prefix.length);
      insert.run(hash(content), contentBytes, content, at); remaining -= logicalBytes;
    }
  });
}
function distribution(values: readonly number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => ordered[Math.ceil(ordered.length * fraction) - 1]!;
  return {samples: [...values], minMs: ordered[0]!, p50Ms: percentile(.5), p90Ms: percentile(.9), maxMs: ordered.at(-1)!};
}
function sqlEvidence(store: ProjectStore, content: string) {
  const guards = store.db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='mio_blobs' ORDER BY name").all().map(row => ({name: String(row.name), sql: String(row.sql)}));
  const quota = guards.find(guard => guard.name === 'quota_mio_blobs_insert'); assert.ok(quota);
  const roots = new Map(store.db.prepare('SELECT name,rootpage FROM main.sqlite_schema WHERE rootpage>0').all().map(row => [Number(row.rootpage), String(row.name)]));
  const explain = store.db.prepare('EXPLAIN INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)').all(hash(content), Buffer.byteLength(content), content, at);
  const readTables = [...new Set(explain.filter(row => row.opcode === 'OpenRead' && row.p3 === 0).map(row => roots.get(Number(row.p2)) ?? `rootpage${row.p2}`))];
  const opcodeCounts: Record<string, number> = {};
  for (const row of explain) opcodeCounts[String(row.opcode)] = (opcodeCounts[String(row.opcode)] ?? 0) + 1;
  const guardReadTables = [...new Set([...quota.sql.matchAll(/FROM (mio_[a-z_]+)/gu)].map(match => match[1]!))];
  return {guards, quotaTrigger: quota.sql, quotaTriggerSha256: hash(quota.sql), guardReadTables, guardHasAggregate: /\b(?:sum|count)\(/iu.test(quota.sql), readTables, opcodeCounts, explainInstructionCount: explain.length};
}

export async function collectMioQuotaPerformance(options: {profile: QuotaBenchmarkProfile; points?: readonly QuotaBenchmarkPoint[]; samples?: number; warmup?: number}) {
  const samples = options.samples ?? 31, warmup = options.warmup ?? 5;
  assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 101); assert.ok(Number.isSafeInteger(warmup) && warmup >= 1 && warmup <= 20);
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-quota-performance-'));
  const sourcesBefore = {schema: hash(readFileSync(resolve(schemaPath), 'utf8')), helper: hash(readFileSync(new URL(import.meta.url), 'utf8')), lock: hash(readFileSync(resolve('pnpm-lock.yaml'), 'utf8'))};
  const baseline = options.profile === 'baseline' ? await loadBaseline(root) : null;
  const points = [];
  try {
    for (const point of options.points ?? quotaBenchmarkPoints) {
      assert.ok(point.rowBytes >= 200 && point.rowBytes <= 2097152 && point.retainedBytes >= 0 && point.retainedBytes <= 250 * 1024 * 1024);
      const projectRoot = mkdtempSync(join(root, 'project-')), store = openStore(projectRoot);
      try {
        const postponed = baseline ? rebuildPrivateBaseline(store, baseline.module.MIO_SCHEMA) : [];
        if (!baseline) assert.ok(counter(store), 'Current benchmark requires the incremental production counter');
        const fillStart = performance.now(); fill(store, point); const fillMs = performance.now() - fillStart;
        if (baseline) store.tx(() => {for (const sql of postponed) store.db.exec(sql.replace(createPrefix, 'CREATE $1 main.'));});
        const byteSql = baseline?.module.MIO_QUOTA_BYTES_SQL ?? MIO_QUOTA_BYTES_SQL, rowSql = baseline?.module.MIO_QUOTA_ROWS_SQL ?? MIO_QUOTA_ROWS_SQL;
        const before = fullUsage(store, byteSql, rowSql), counterBefore = counter(store);
        assert.equal(before.bytes, point.retainedBytes); if (counterBefore) assert.deepEqual(counterBefore, before);
        assert.equal(scalar(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys), 1);
        const content = 'p'.repeat(112), contentHash = hash(content), insert = store.db.prepare('INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)');
        assert.equal(Buffer.byteLength(content) + 64 + Buffer.byteLength(at), 200);
        const evidence = sqlEvidence(store, content), durations: number[] = [];
        if (!baseline) {assert.deepEqual(evidence.guardReadTables, ['mio_storage_counters']); assert.equal(evidence.guardHasAggregate, false);}
        // The outer transaction and SAVEPOINT/ROLLBACK/RELEASE are deliberately
        // outside the stopwatch. Each sample is exactly one prepared protected
        // INSERT, including its real row/counter/quota trigger execution.
        store.tx(() => {
          for (let index = 0; index < warmup + samples; index++) {
            store.db.exec('SAVEPOINT protected_write_probe');
            const start = performance.now(); insert.run(contentHash, 112, content, at); const elapsed = performance.now() - start;
            store.db.exec('ROLLBACK TO protected_write_probe; RELEASE protected_write_probe');
            if (index >= warmup) durations.push(elapsed);
          }
        });
        const after = fullUsage(store, byteSql, rowSql), counterAfter = counter(store);
        assert.deepEqual(after, before); assert.deepEqual(counterAfter, counterBefore);
        points.push({point, retained: before, counterBefore, counterAfter, fillMsExcluded: fillMs, warmup, writesMeasured: samples, writeLogicalBytes: 200, writeContentBytes: 112, timing: distribution(durations), sqlEvidence: evidence});
      } finally {store.close(); rmSync(projectRoot, {recursive: true, force: true});}
    }
    const sourcesAfter = {schema: hash(readFileSync(resolve(schemaPath), 'utf8')), helper: hash(readFileSync(new URL(import.meta.url), 'utf8')), lock: hash(readFileSync(resolve('pnpm-lock.yaml'), 'utf8'))};
    if (!baseline) assert.deepEqual(sourcesAfter, sourcesBefore, 'Current measurement sources changed during the run');
    return {version: 1, profile: options.profile, node: process.version, baselineRef, provenance: {sourcesBefore, sourcesAfter, ...(baseline ? {baselineOriginalSourceSha256: baseline.originalSourceSha256, privateBaselineModuleSha256: baseline.privateModuleSha256, privateBaselineSchemaSha256: baseline.privateSchemaSha256} : {})},
      measurement: {clock: 'performance.now', timed: 'One prepared mio_blobs INSERT.run only; includes all enabled production/profile guards.', excluded: 'Project/kernel creation, private baseline profile setup, fill, trigger installation, content/hash preparation, statement preparation, full inventory, counter cross-check, EXPLAIN, savepoints, rollbacks, releases and final commit.', baseline: 'Only the private disposable Mio domain is replaced with6d433c23 MIO_SCHEMA, row threshold aligned20000→65536; quota scan triggers are installed after filling. FK/evidence/identity/row guards remain, and all quota guards are present during timing. Never a production upgrade or repair path.', current: 'Unmodified live K1 schema and all production triggers remain enabled during fill and timing. Counter row0B/1row is included in retained quota.', scope: 'Hot repeated successful writes inside one transaction; not end-to-end runtime latency or durable commit/fsync latency.'}, points};
  } finally {rmSync(root, {recursive: true, force: true});}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {profile: {type: 'string', default: 'current'}, output: {type: 'string'}}});
  assert.ok(values.profile === 'baseline' || values.profile === 'current');
  const report = await collectMioQuotaPerformance({profile: values.profile});
  const json = JSON.stringify(report, null, 2) + '\n'; if (values.output) writeFileSync(resolve(values.output), json); else process.stdout.write(json);
}
