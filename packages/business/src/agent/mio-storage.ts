import type {DatabaseSync} from 'node:sqlite';
import {MIO_STORAGE_TABLES, mioStorageSnapshotSchema} from '../../../contracts/src/mio-storage.ts';
import type {MioStorageSnapshot, MioStorageTable} from '../../../contracts/src/mio-storage.ts';
import {isProjectDatabase} from '../project-file/connection.ts';
import {MIO_STORAGE_LIMITS} from '../project-file/schema/domains/mio.ts';

// This inventory deliberately mirrors the kernel quota's UTF-8 column formula.
// Integers, SQLite pages/indexes and referenced blob contents are not charged a
// second time; each retained blob row contributes its own content exactly once.
const byteColumns: Readonly<Record<MioStorageTable, readonly string[]>> = {
  mio_conversations: ['id', 'projectId', 'createdAt', 'updatedAt'],
  mio_runs: ['id', 'projectId', 'conversationId', 'requestId', 'digest', 'status', 'locale', 'configurationBlobHash', 'rulesSnapshotHash', 'usageSummary', 'createdAt', 'updatedAt'],
  mio_entries: ['id', 'projectId', 'conversationId', 'runId', 'kind', 'payloadJson', 'payloadBlobHash', 'createdAt'],
  mio_blobs: ['sha256', 'content', 'createdAt'],
  mio_steps: ['id', 'runId', 'projectId', 'kind', 'status', 'tier', 'currentRequestId', 'sourceEntryId', 'resultEntryId', 'partialText', 'data', 'createdAt', 'updatedAt'],
  mio_requests: ['id', 'stepId', 'protocol', 'bodySha256', 'state', 'originalBody', 'inputManifest', 'firstEntry', 'lastEntry', 'assembledAt', 'dispatchStartedAt', 'completedAt', 'previousRequestId', 'assemblyReason'],
  mio_changes: ['id', 'runId', 'stepId', 'projectId', 'data'],
  mio_controls: ['requestId', 'runId', 'projectId', 'digest', 'data'],
  mio_control_states: ['requestId', 'runId', 'projectId', 'data'],
  mio_imports: ['id', 'projectId', 'requestId', 'name', 'mimeType', 'relativePath', 'sha256', 'status', 'assetId', 'resourceId', 'createdAt'],
  mio_job_origins: ['kind', 'jobId', 'runId', 'stepId', 'projectId', 'requestId', 'operation'],
  mio_edit_claims: ['id', 'projectId', 'ownerId', 'kind', 'targetId', 'state', 'createdAt', 'updatedAt'],
  mio_edit_owners: ['ownerId', 'projectId'],
  mio_edit_receipts: ['requestId', 'projectId', 'ownerId', 'digest', 'data'],
  mio_conversation_policies: ['conversationId', 'projectId', 'data'],
  mio_conversation_policy_requests: ['requestId', 'projectId', 'conversationId', 'inputHash', 'response'],
  mio_events: ['runId', 'createdAt'],
  mio_process_target_revisions: ['projectId', 'kind', 'targetId'],
};
const rowOnlyTables: readonly MioStorageTable[] = ['mio_edit_claims', 'mio_edit_owners', 'mio_edit_receipts', 'mio_process_target_revisions'];
const inventorySql = MIO_STORAGE_TABLES.map(name => `SELECT '${name}' AS name,count(*) AS rows,COALESCE(sum(${byteColumns[name].map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) AS bytes FROM main.${name}`).join(' UNION ALL ');

function safeCount(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Mio storage counters must be safe nonnegative integers');
  return Number(value);
}

/** A SQL-only snapshot of a live kernel-owned project's retained Mio records.
 * No caller-supplied identity or SQLite marker can select the project profile.
 * Querying all tables in one statement also keeps their counters consistent,
 * without starting a transaction or invoking any write fences/observers. */
export function readMioStorage(db: DatabaseSync): MioStorageSnapshot {
  if (!isProjectDatabase(db)) throw new TypeError('Mio storage requires a live kernel project database');
  const identity = db.prepare('SELECT projectId FROM main.history_state WHERE singleton=1').get();
  const statement = db.prepare(inventorySql);
  statement.setReadBigInts(true);
  const rows = statement.all();
  const tables = MIO_STORAGE_TABLES.map((name, index) => {
    const row = rows[index];
    if (row?.name !== name) throw new TypeError('Mio storage inventory is inconsistent');
    return {name, rows: safeCount(row.rows), bytes: safeCount(row.bytes), countedBytes: true as const,
      countedRows: name !== 'mio_edit_receipts', quotaGuard: rowOnlyTables.includes(name) ? 'row_only' as const : 'execution' as const};
  });
  const bytes = safeCount(tables.reduce((total, table) => total + BigInt(table.bytes), 0n));
  const countedRows = safeCount(tables.reduce((total, table) => total + (table.countedRows ? BigInt(table.rows) : 0n), 0n));
  const retainedRows = safeCount(tables.reduce((total, table) => total + BigInt(table.rows), 0n));
  const limits = MIO_STORAGE_LIMITS;
  const status = bytes >= limits.bytes || countedRows >= limits.rows ? 'full'
    : bytes >= limits.bytes * .9 || countedRows >= limits.rows * .9 ? 'near_limit' : 'available';
  return mioStorageSnapshotSchema.parse({version: 2, scope: 'project', projectId: identity?.projectId, format: 'mio_records', status, limits,
    usage: {bytes, rows: countedRows}, retained: {bytes, rows: retainedRows},
    remaining: {bytes: Math.max(0, limits.bytes - bytes), rows: Math.max(0, limits.rows - countedRows)},
    independentLimits: {editReceiptDataBytes: 65536, editReceiptTotalBytes: null, editReceiptTotalRows: null}, tables});
}
