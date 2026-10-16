/** Explicit offline ordinary40 -> ordinary42 copy validation. This leaf never
 * opens a path, initializes a legacy database, changes a task, or grants a store.
 * The caller must own a private unpublished copy and its publication fence. */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import {classifyWorkspaceSchema42} from './workspace-schema-v42.ts';
import {validateOpacityWorkspaceRows} from './workspace-opacity-validation.ts';
import {isOpacityRenderRecord} from '../../contracts/src/timeline-opacity-render-candidate.ts';
import {isOpacityApplicationTask} from '../../contracts/src/timeline-opacity-persistence.ts';
import {timelineRenderDeliveryFields} from '../../contracts/src/timeline-delivery.ts';
import {assertFloatTimelineExportRead} from './timeline-float-outcome.ts';

const require = createRequire(import.meta.url);
type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const MAX_BYTES = 512 * 1024 * 1024, MAX_ROWS = 100000;
export type OpacityUpgradeDatabaseCode = 'SOURCE_INVALID' | 'SOURCE_UNSUPPORTED' | 'UNRESOLVED_TASKS' | 'UNSUPPORTED_ASSET' | 'UNSUPPORTED_EXPORT' | 'PRESERVATION_FAILED';
const messages: Readonly<Record<OpacityUpgradeDatabaseCode, string>> = Object.freeze({
  SOURCE_INVALID: 'The ordinary40 source database cannot be verified.',
  SOURCE_UNSUPPORTED: 'This source contains a historical task family that this offline upgrade does not support.',
  UNRESOLVED_TASKS: 'Resolve pending tasks and acknowledge their outcomes in the original40 workspace before upgrading.',
  UNSUPPORTED_ASSET: 'This upgrade supports only canonical managed user imports. Keep this project in its original40 workspace.',
  UNSUPPORTED_EXPORT: 'This upgrade cannot verify a historical export for the ordinary42 application. Keep the original40 workspace.',
  PRESERVATION_FAILED: 'The copied database did not retain its original raw row evidence.',
});
export class OpacityUpgradeDatabaseError extends Error {
  readonly code: OpacityUpgradeDatabaseCode;
  constructor(code: OpacityUpgradeDatabaseCode) {super(messages[code]); this.name = 'OpacityUpgradeDatabaseError'; this.code = code;}
}
function fail(code: OpacityUpgradeDatabaseCode = 'SOURCE_INVALID'): never {throw new OpacityUpgradeDatabaseError(code);}
function invoke(moduleName: string, name: string, args: unknown[]): unknown {
  const module: unknown = require(moduleName);
  if (!object(module) || typeof module[name] !== 'function') return fail();
  return Reflect.apply(module[name], module, args) as unknown;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => object(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function settings(db: DatabaseSync, transaction: boolean): void {
  if (!db.isOpen || db.isTransaction !== transaction || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
      db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0 || db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints !== 0) fail();
  const pages = db.prepare('PRAGMA main.page_count').get()?.page_count, size = db.prepare('PRAGMA main.page_size').get()?.page_size;
  if (typeof pages !== 'number' || typeof size !== 'number' || !Number.isSafeInteger(pages) || !Number.isSafeInteger(size) || pages < 0 || size < 1 || pages * size > MAX_BYTES) fail();
}
function* dataRows(db: DatabaseSync, table: string, maximum = 131072): Generator<Value> {
  const owned = table !== 'projects';
  let count = 0;
  const source = db.prepare(`SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=36 THEN id END AS id,${owned ? "CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId," : ''}CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${maximum} THEN data END AS data,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${maximum} AND json_valid(data) THEN EXISTS(SELECT 1 FROM json_tree(data) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END AS duplicates FROM main.${quote(table)} LIMIT ${MAX_ROWS + 1}`);
  for (const row of source.iterate()) {
    if (++count > MAX_ROWS || !uuid(row.id) || owned && !uuid(row.projectId) || typeof row.data !== 'string' || row.duplicates !== 0) fail();
    let value: unknown; try {value = JSON.parse(row.data) as unknown;} catch {return fail();}
    if (!object(value) || value.id !== row.id || owned && value.projectId !== row.projectId) fail();
    yield value;
  }
}
function checkTasks(db: DatabaseSync, tables: Set<string>): void {
  const columnStates = [
    ['edit_tasks', 'status', ['applied', 'not_applied']],
    ['image_tasks', 'state', ['succeeded', 'failed', 'cancelled_before_dispatch']],
    ['frame_tasks', 'state', ['succeeded', 'failed', 'cancelled_before_start']],
    ['image_remote_runs', 'state', ['completed', 'failed']],
    ['image_remote_observations', 'state', ['finished']],
    ['image_reviews', 'state', ['rejected', 'dispatched']],
    ['agent_chat_runs', 'status', ['completed', 'failed', 'stopped', 'interrupted']],
    ['agent_chat_steps', 'status', ['completed']],
    ['agent_edit_proposals', 'status', ['applied', 'failed', 'rejected', 'cancelled']],
    ['waveform_cache', 'status', ['ready', 'error', 'unsupported']],
  ] as const;
  for (const [table, column, states] of columnStates) if (tables.has(table) && db.prepare(`SELECT 1 FROM main.${quote(table)} WHERE typeof(${quote(column)})!='text' OR ${quote(column)} NOT IN (${states.map(() => '?').join(',')}) LIMIT 1`).get(...states)) fail('UNRESOLVED_TASKS');
  if (db.prepare('SELECT 1 FROM main.edit_tasks LIMIT 1 OFFSET 4096').get()) fail('SOURCE_UNSUPPORTED');
  if (db.prepare('SELECT 1 FROM main.edit_tasks WHERE acknowledged IS NOT 1 LIMIT 1').get()) fail('UNRESOLVED_TASKS');
  // These families have no ordinary42 product operations or restart observer.
  // Preserve their source, rather than inferring that a terminal column proves
  // a recoverable result, remote observation, approval, or Agent step payload.
  for (const table of ['image_tasks', 'frame_tasks', 'image_remote_runs', 'image_remote_observations', 'image_reviews',
    'agent_chat_runs', 'agent_chat_steps', 'agent_edit_proposals', 'mock_provider_tasks', 'mock_provider_submissions'])
    if (tables.has(table) && db.prepare(`SELECT 1 FROM main.${quote(table)} LIMIT 1`).get()) fail('SOURCE_UNSUPPORTED');
  for (const row of db.prepare('SELECT * FROM main.edit_tasks LIMIT 100001').iterate()) {
    if (typeof row.input !== 'string') fail();
    let input: unknown; try {input = JSON.parse(row.input) as unknown;} catch {return fail();}
    if (!object(input)) fail();
    const task = {id: row.id, projectId: row.projectId, operation: row.operation, input, requestId: row.requestId,
      digest: row.digest, lane: row.lane, status: row.status, revision: row.revision, createdAt: row.createdAt,
      updatedAt: row.updatedAt, acknowledged: true, origin: row.origin, ...(row.errorCode === null ? {} : {errorCode: row.errorCode})};
    if (invoke('../../contracts/src/index.mjs', 'isEditTask', [task]) !== true || row.digest !== hash({operation: row.operation, input})) fail();
    // A terminal ACK does not make an old operation readable by the fixed42
    // application's task coordinator. Preserve such projects in40 instead of
    // publishing a copy whose task history fails get/list after reopening.
    if (!isOpacityApplicationTask(task)) fail('SOURCE_UNSUPPORTED');
    const family = row.lane === 'timeline:mutation' ? ['timeline-recovery.mjs', 'readTimelineReceipt', 'createTimelineRecoveryBoundary']
      : row.lane === 'reference:mutation' ? ['reference-recovery.mjs', 'readReferenceReceipt', 'createReferenceRecoveryBoundary']
      : row.lane === 'subject:mutation' ? ['subject-recovery.mjs', 'readSubjectReceipt', 'createSubjectRecoveryBoundary'] : fail();
    const module = './' + family[0], receipt = invoke(module, family[1]!, [db, input, row.operation]) ?? null;
    if (row.status === 'not_applied') {
      if (receipt !== null || row.receiptDigest !== null || invoke('../../contracts/src/index.mjs', 'hasRequestNotAppliedProof', [{code: row.errorCode, status: 409, details: {mutationOutcome: 'not_applied', operation: row.operation, projectId: row.projectId, requestId: row.requestId}}, input, {operation: row.operation}]) !== true) fail();
    } else {
      if (!object(receipt) || receipt.requestHash !== row.digest) fail();
      const boundary = invoke(row.lane === 'subject:mutation' ? './subjects.mjs' : module, family[2]!, [db, input]);
      if (!object(boundary) || typeof boundary.replay !== 'function') fail();
      const result: unknown = Reflect.apply(boundary.replay, boundary, [row.operation, receipt.response]);
      if (row.receiptDigest !== hash(result)) fail();
    }
  }
}
function checkExports(db: DatabaseSync, values: Iterable<Value>): void {
  const identity = (value: Value): string => canonical(Object.fromEntries(['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'orderedVersionIds', 'snapshot', 'createdAt'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  for (const value of values) {
    if (!['succeeded', 'failed', 'cancelled'].includes(String(value.status))) fail('UNRESOLVED_TASKS');
    if (value.mode !== 'timeline' || !object(value.snapshot)) fail('UNSUPPORTED_EXPORT');
    const input = {projectId: value.projectId, requestId: value.requestId, expectedRevision: value.timelineRevision,
      purpose: value.purpose, ...timelineRenderDeliveryFields(value.snapshot)};
    if (!isOpacityRenderRecord(value, input)) fail('UNSUPPORTED_EXPORT');
    const receipt = db.prepare("SELECT requestHash,CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304 THEN response END AS response FROM main.timeline_requests WHERE requestId=?").get(String(value.requestId));
    let saved: unknown; try {saved = typeof receipt?.response === 'string' ? JSON.parse(receipt.response) as unknown : undefined;} catch {return fail('UNSUPPORTED_EXPORT');}
    if (!hex(receipt?.requestHash) || !object(saved) || saved.status !== 'queued' || saved.assetId !== null || saved.url !== null ||
        !isOpacityRenderRecord(saved, input) || identity(saved) !== identity(value)) fail('UNSUPPORTED_EXPORT');
    assertFloatTimelineExportRead(db, value, {isTimelineRenderRecord: isOpacityRenderRecord,
      readOwnedAsset: (projectId, id) => invoke('./timeline-sources.mjs', 'readOwnedTimelineAsset', [db, projectId, id])});
  }
}
function eligible(db: DatabaseSync, transaction: boolean): void {
  settings(db, transaction);
  const classification = invoke('./db.mjs', 'classifyCurrentWorkspaceSchema', [db]);
  if (!object(classification) || classification.schemaVersion !== 40 || classification.profile !== 'ordinary') fail();
  if (Object.values(db.prepare('PRAGMA quick_check(1)').get() ?? {})[0] !== 'ok' || db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').get()) fail();
  const tables = new Set(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all().map(row => String(row.name)));
  checkTasks(db, tables);
  for (const table of ['projects', 'shots', 'nodes', 'edges', 'versions', 'jobs']) {
    for (const value of dataRows(db, table, table === 'projects' ? 16384 : 131072))
      if (table === 'jobs' && !['succeeded', 'failed', 'cancelled'].includes(String(value.status))) fail('UNRESOLVED_TASKS');
  }
  const extensions: Readonly<Record<string, string>> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'};
  for (const asset of dataRows(db, 'assets')) {
    const extension = typeof asset.mimeType === 'string' ? extensions[asset.mimeType] : undefined;
    if (!extension || asset.provenance !== 'user-import' || asset.relativePath !== `media/${String(asset.id)}.${extension}` ||
        !hex(asset.sha256) || typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1) fail('UNSUPPORTED_ASSET');
    const owned = invoke('./timeline-sources.mjs', 'readOwnedTimelineAsset', [db, asset.projectId, asset.id]);
    if (!object(owned) || canonical(owned) !== canonical(asset)) fail('UNSUPPORTED_ASSET');
    if (db.prepare("SELECT 1 FROM main.exports WHERE CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=? LIMIT 1").get(String(asset.id))) fail('UNSUPPORTED_ASSET');
  }
  checkExports(db, dataRows(db, 'exports', 4194304));
  for (const row of db.prepare("SELECT CASE WHEN typeof(projectId)='text' AND length(CAST(projectId AS BLOB))=36 THEN projectId END AS projectId,CASE WHEN typeof(state)='text' AND length(CAST(state AS BLOB)) BETWEEN 1 AND 16384 THEN state END AS state FROM main.workspace_preferences LIMIT 100001").iterate()) {
    if (!uuid(row.projectId) || typeof row.state !== 'string') fail();
    let value: unknown; try {value = JSON.parse(row.state) as unknown;} catch {return fail();}
    invoke('./workspace-preferences.mjs', 'parseWorkspacePreferencesState', [value]);
  }
  validateOpacityWorkspaceRows(db, {schemaVersion: 42});
}
/** Read-only admission; connection PRAGMAs and database rows remain unchanged. */
export function requireEligibleOrdinary40(db: DatabaseSync): void {
  try {eligible(db, false);} catch (error) {if (error instanceof OpacityUpgradeDatabaseError) throw error; fail();}
}
export interface OrdinaryUpgradeTablePreservation {readonly columns: readonly string[]; readonly digest: string; readonly rows: number}
export type OrdinaryUpgradePreservation = ReadonlyMap<string, OrdinaryUpgradeTablePreservation>;
/** Raw SQLite cells are hashed in bounded chunks. JSON is never reserialized;
 * rowid, NULL, storage class, text/BLOB bytes and sequence high-water survive. */
export function captureOrdinaryUpgradePreservation(db: DatabaseSync, omitNew42Marker = false): OrdinaryUpgradePreservation {
  const result = new Map<string, OrdinaryUpgradeTablePreservation>(); let totalRows = 0, totalBytes = 0;
  const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name LIMIT 257").all();
  if (tables.length > 256) fail('PRESERVATION_FAILED');
  for (const table of tables) {
    if (typeof table.name !== 'string' || table.name.length > 128) fail('PRESERVATION_FAILED');
    const name = table.name, columns = db.prepare(`PRAGMA main.table_info(${quote(name)})`).all().map(row => {
      if (typeof row.name !== 'string' || row.name.length > 128) return fail('PRESERVATION_FAILED'); return row.name;
    });
    const digest = createHash('sha256'); let rows = 0;
    const identities = db.prepare(`SELECT rowid AS id FROM main.${quote(name)}${omitNew42Marker && name === 'schema_version' ? ' WHERE version!=42' : ''} ORDER BY rowid`); identities.setReadBigInts(true);
    for (const row of identities.iterate()) {
      if (typeof row.id !== 'bigint' || ++totalRows > MAX_ROWS) fail('PRESERVATION_FAILED');
      rows++; digest.update(String(row.id) + '\0');
      for (const column of columns) {
        const cell = db.prepare(`SELECT typeof(${quote(column)}) AS type,length(CAST(${quote(column)} AS BLOB)) AS bytes FROM main.${quote(name)} WHERE rowid=?`).get(row.id);
        if (!cell || typeof cell.type !== 'string' || cell.bytes !== null && typeof cell.bytes !== 'number') fail('PRESERVATION_FAILED');
        totalBytes += typeof cell.bytes === 'number' ? cell.bytes : 0;
        if (totalBytes > MAX_BYTES) fail('PRESERVATION_FAILED');
        digest.update(column + '\0' + cell.type + '\0' + String(cell.bytes) + '\0');
        const expression = cell.type === 'real' ? `CAST(printf('%!.26g',${quote(column)}) AS BLOB)` : `CAST(${quote(column)} AS BLOB)`;
        const read = db.prepare(`SELECT substr(${expression},?,1048576) AS value FROM main.${quote(name)} WHERE rowid=?`);
        for (let offset = 1;; offset += 1048576) {
          const value = read.get(offset, row.id)?.value;
          if (value === null || value instanceof Uint8Array && value.length === 0) break;
          if (!(value instanceof Uint8Array)) fail('PRESERVATION_FAILED'); digest.update(value);
        }
      }
    }
    result.set(name, Object.freeze({columns: Object.freeze(columns), digest: digest.digest('hex'), rows}));
  }
  return result;
}
function sameEvidence(before: OrdinaryUpgradePreservation, after: OrdinaryUpgradePreservation): boolean {
  return before.size === after.size && [...before].every(([table, value]) => canonical(value) === canonical(after.get(table)));
}
/** Only the unpublished copy changes. Exact40 classification and all admission
 * gates run inside the same transaction as the marker and preservation proof. */
export function upgradeCopiedDatabase40To42(db: DatabaseSync): void {
  settings(db, false);
  db.exec('BEGIN IMMEDIATE');
  try {
    eligible(db, true);
    const before = captureOrdinaryUpgradePreservation(db);
    db.exec('INSERT INTO main.schema_version(version) VALUES(42)');
    classifyWorkspaceSchema42(db);
    if (!sameEvidence(before, captureOrdinaryUpgradePreservation(db, true))) fail('PRESERVATION_FAILED');
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error instanceof OpacityUpgradeDatabaseError) throw error; fail();
  }
}
