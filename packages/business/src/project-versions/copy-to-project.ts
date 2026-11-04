import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {isNormalizedAbsolutePath} from '../../../contracts/src/media-reference.ts';
import {HISTORY_TABLES} from '../project-file/schema/tables.ts';
import {rewriteProjectCopyRow, relocateProjectCopyReference} from '../project-file/copy-values.ts';
import {canonicalJson, primaryKeys, PROJECT_SNAPSHOT_TABLES, validateProjectDocument} from './document.ts';
import type {ProjectDocument, SnapshotRow} from './document.ts';
import {decodeProjectDocument, encodeProjectDocument} from './codec.ts';
import type {EncodedProjectDocument} from './codec.ts';
import {PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES, PROJECT_SNAPSHOT_MAX_RAW_BYTES} from './limits.ts';
import {versionSummary} from './repository.ts';

export interface CopyProjectVersionsToNewProjectOptions {
  readonly sourceProjectId: string;
  readonly projectId: string;
  readonly sourceProjectDir: string;
  readonly targetProjectDir: string;
}
const versionTables = ['project_version_blobs', 'project_versions', 'project_version_requests', 'project_version_capture_marks'];
const processKinds = new Set(['job', 'export', 'image_task', 'frame_task']);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const invalid = (reason: string, versionId?: string): AppError => new AppError('PROJECT_VERSION_RECORD_INVALID', '无法完整复制本机项目版本。', 422,
  {reason, ...(versionId ? {versionId} : {})});

function rebindDocument(document: ProjectDocument, options: CopyProjectVersionsToNewProjectOptions): ProjectDocument {
  const rewrite = (table: string, row: SnapshotRow): Record<string, unknown> => {
    const result = rewriteProjectCopyRow(table, row, options.sourceProjectId, options.projectId);
    if (typeof result.data === 'string') {
      const data: unknown = JSON.parse(result.data);
      if (table === 'assets') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('asset-json');
        relocateProjectCopyReference(data as Record<string, unknown>, options.sourceProjectDir, options.targetProjectDir);
      }
      result.data = canonicalJson(data);
    }
    return result;
  };
  const ordered = (table: typeof PROJECT_SNAPSHOT_TABLES[number] | 'agent_task_target_revisions_v2', rows: readonly SnapshotRow[]) => {
    const keys = primaryKeys(table), key = (row: Record<string, unknown>) => canonicalJson(keys.map(column => row[column]));
    return rows.map(row => rewrite(table, row)).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  };
  return validateProjectDocument({...document, projectId: options.projectId,
    tables: Object.fromEntries(PROJECT_SNAPSHOT_TABLES.map(table => [table, ordered(table, document.tables[table])])),
    evidence: {...document.evidence, targetRevisions: ordered('agent_task_target_revisions_v2', document.evidence.targetRevisions.filter(row => !processKinds.has(String(row.kind))))}});
}

/** S5 receives an independently captured, closed-source history as main.
 * The caller owns target rollback/publication. No source migration, old ACK,
 * execution record or archive is produced by this cross-project conversion. */
export function copyProjectVersionsToNewProjectInside(source: DatabaseSync, target: DatabaseSync,
  options: CopyProjectVersionsToNewProjectOptions): {versions: number; blobs: number; compressedBytes: number} {
  const {sourceProjectId, projectId} = options;
  if (source === target || !target.isTransaction || !isProjectId(sourceProjectId) || !isProjectId(projectId) || sourceProjectId === projectId
    || !isNormalizedAbsolutePath(options.sourceProjectDir) || !isNormalizedAbsolutePath(options.targetProjectDir))
    throw new TypeError('Version rebinding requires distinct project IDs, absolute project directories and a target transaction');
  for (const [db, owner] of [[source, sourceProjectId], [target, projectId]] as const) {
    const rows = db.prepare('SELECT projectId FROM main.history_state').all();
    if (rows.length !== 1 || rows[0].projectId !== owner) throw new AppError('PROJECT_ID_MISMATCH', '版本复制与源或目标项目身份不一致。', 400);
  }
  for (const table of HISTORY_TABLES) if (table !== 'mio_storage_counters' && target.prepare(`SELECT 1 FROM main.${quote(table)} LIMIT 1`).get())
    throw invalid('target-not-empty');
  const counters = target.prepare('SELECT bytes,rows FROM main.mio_storage_counters').all();
  if (counters.length !== 1 || counters[0].bytes !== 0 || counters[0].rows !== 1 || target.prepare('SELECT 1 FROM main.project_history_resolution LIMIT 1').get())
    throw invalid('target-not-empty');

  const ownRead = !source.isTransaction;
  if (ownRead) source.exec('BEGIN');
  try {
    const present = new Set(source.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all().map(row => String(row.name)));
    const domain = versionTables.filter(table => present.has(table));
    if (!domain.length) return {versions: 0, blobs: 0, compressedBytes: 0};
    if (domain.length !== versionTables.length) throw invalid('incomplete-source-version-domain');
    const columns = (db: DatabaseSync) => db.prepare('PRAGMA main.table_info(project_versions)').all().map(row => String(row.name));
    const versionColumns = columns(target);
    if (canonicalJson(columns(source)) !== canonicalJson(versionColumns)) throw invalid('source-version-columns');
    if (source.prepare('SELECT 1 FROM main.project_version_blobs b WHERE NOT EXISTS(SELECT 1 FROM main.project_versions v WHERE v.blobHash=b.hash) LIMIT 1').get())
      throw invalid('orphan-source-blob');
    const insertVersion = target.prepare(`INSERT INTO main.project_versions(${versionColumns.map(quote).join(',')}) VALUES(${versionColumns.map(() => '?').join(',')})`);
    const insertBlob = target.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,?,?,?,?,?)');
    const rebound = new Map<string, {hash: string; contentSequence: number}>(), stored = new Set<string>();
    let versions = 0, compressedBytes = 0;
    for (const row of source.prepare('SELECT * FROM main.project_versions ORDER BY id').iterate()) {
      const version = versionSummary(row);
      if (version.projectId !== sourceProjectId || !Number.isSafeInteger(row.mioChangeRowid) || Number(row.mioChangeRowid) < 0)
        throw invalid('source-version-owner-or-boundary', version.id);
      const hash = String(row.blobHash);
      let converted = rebound.get(hash);
      if (!converted) {
        const metadata = source.prepare('SELECT hash,profile,codec,rawBytes,compressedBytes,length(payload) AS payloadBytes FROM main.project_version_blobs WHERE hash=?').get(hash);
        if (!metadata) throw invalid('missing-source-blob', version.id);
        if (Number(metadata.rawBytes) > PROJECT_SNAPSHOT_MAX_RAW_BYTES || Number(metadata.compressedBytes) > PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES)
          throw new AppError('PROJECT_VERSION_SNAPSHOT_LIMIT', '版本正文超出有界转换容量。', 413, {versionId: version.id});
        if (!Number.isSafeInteger(metadata.payloadBytes) || Number(metadata.payloadBytes) < 1 || Number(metadata.payloadBytes) > PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES
          || metadata.payloadBytes !== metadata.compressedBytes) throw invalid('source-blob-size', version.id);
        const payload = source.prepare('SELECT payload FROM main.project_version_blobs WHERE hash=?').get(hash)!.payload;
        let document: ProjectDocument;
        try {document = decodeProjectDocument({...metadata, payload} as unknown as EncodedProjectDocument);}
        catch (error) {
          if (error instanceof AppError) {
            const details = error.details !== null && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {};
            throw new AppError(error.code, error.message, error.status, {...details, versionId: version.id});
          }
          throw error;
        }
        if (document.projectId !== sourceProjectId) throw invalid('source-blob-owner', version.id);
        const blob = encodeProjectDocument(rebindDocument(document, options));
        if (!stored.has(blob.hash)) {
          insertBlob.run(blob.hash, blob.profile, blob.codec, blob.rawBytes, blob.compressedBytes, blob.payload);
          stored.add(blob.hash); compressedBytes += blob.compressedBytes;
          if (!Number.isSafeInteger(compressedBytes)) throw invalid('copied-size-overflow', version.id);
        }
        converted = {hash: blob.hash, contentSequence: document.evidence.contentSequence}; rebound.set(hash, converted);
      }
      if (converted.contentSequence !== version.contentSequence) throw invalid('source-version-sequence', version.id);
      const result: Record<string, SQLInputValue> = {...row, projectId, blobHash: converted.hash, mioChangeRowid: 0};
      insertVersion.run(...versionColumns.map(column => result[column])); versions++;
    }
    if (target.prepare('PRAGMA main.foreign_key_check(project_versions)').get()
      || Number(target.prepare('SELECT count(*) n FROM main.project_versions').get()!.n) !== versions
      || Number(target.prepare('SELECT count(*) n FROM main.project_version_blobs').get()!.n) !== stored.size)
      throw invalid('target-integrity-or-count');
    return {versions, blobs: stored.size, compressedBytes};
  } finally {if (ownRead) source.exec('ROLLBACK');}
}
