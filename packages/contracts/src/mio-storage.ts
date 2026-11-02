import {z} from 'zod';

/** Version 2 is the per-project Mio-records profile. The legacy workspace
 * profile remains in agent-task-storage.ts and retains its version 1 shape. */
export const MIO_STORAGE_TABLES = Object.freeze([
  'mio_conversations', 'mio_runs', 'mio_entries', 'mio_blobs', 'mio_steps', 'mio_requests',
  'mio_changes', 'mio_controls', 'mio_control_states', 'mio_imports', 'mio_job_origins',
  'mio_edit_claims', 'mio_edit_owners', 'mio_edit_receipts', 'mio_conversation_policies',
  'mio_conversation_policy_requests', 'mio_events', 'mio_process_target_revisions',
] as const);
export type MioStorageTable = typeof MIO_STORAGE_TABLES[number];
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counters = z.object({bytes: count, rows: count}).strict();
const rowOnlyTables: readonly MioStorageTable[] = ['mio_edit_claims', 'mio_edit_owners', 'mio_edit_receipts', 'mio_process_target_revisions'];

export const mioStorageSnapshotSchema = z.object({
  version: z.literal(2), scope: z.literal('project'), projectId: z.string().uuid(), format: z.literal('mio_records'),
  status: z.enum(['available', 'near_limit', 'full']),
  limits: z.object({bytes: z.literal(268435456), rows: z.literal(20000), rowBytes: z.literal(2097152)}).strict(),
  usage: counters, retained: counters, remaining: counters,
  // Receipts bypass the execution quota's write guard, but are independently
  // bounded per payload; there is no separate aggregate receipt allowance.
  independentLimits: z.object({editReceiptDataBytes: z.literal(65536), editReceiptTotalBytes: z.null(), editReceiptTotalRows: z.null()}).strict(),
  tables: z.array(z.object({
    name: z.enum(MIO_STORAGE_TABLES), bytes: count, rows: count,
    countedBytes: z.literal(true), countedRows: z.boolean(), quotaGuard: z.enum(['execution', 'row_only']),
  }).strict()).length(MIO_STORAGE_TABLES.length),
}).strict().refine(value => {
  if (new Set(value.tables.map(table => table.name)).size !== MIO_STORAGE_TABLES.length) return false;
  const safe = (number: number): boolean => Number.isSafeInteger(number) && number >= 0;
  if (![value.usage, value.retained, value.remaining, ...value.tables].every(item => safe(item.bytes) && safe(item.rows))) return false;
  let bytes = 0n, rows = 0n, retainedRows = 0n;
  for (const table of value.tables) {
    if (table.countedRows !== (table.name !== 'mio_edit_receipts') || table.quotaGuard !== (rowOnlyTables.includes(table.name) ? 'row_only' : 'execution')) return false;
    bytes += BigInt(table.bytes); retainedRows += BigInt(table.rows);
    if (table.countedRows) rows += BigInt(table.rows);
  }
  // BigInt sums prevent unsafe rounded totals from satisfying the equations.
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (bytes > max || rows > max || retainedRows > max) return false;
  if (BigInt(value.usage.bytes) !== bytes || BigInt(value.usage.rows) !== rows || BigInt(value.retained.bytes) !== bytes || BigInt(value.retained.rows) !== retainedRows) return false;
  if (value.remaining.bytes !== Math.max(0, value.limits.bytes - Number(bytes)) || value.remaining.rows !== Math.max(0, value.limits.rows - Number(rows))) return false;
  const status = bytes >= BigInt(value.limits.bytes) || rows >= BigInt(value.limits.rows) ? 'full'
    : bytes * 10n >= BigInt(value.limits.bytes) * 9n || rows * 10n >= BigInt(value.limits.rows) * 9n ? 'near_limit' : 'available';
  return value.status === status;
}, {message: 'Mio storage counters must match the complete bounded project inventory.'});
export type MioStorageSnapshot = z.infer<typeof mioStorageSnapshotSchema>;
