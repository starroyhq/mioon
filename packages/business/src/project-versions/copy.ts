import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {inspectProjectDocumentForCopy} from './codec.ts';
import type {EncodedProjectDocument} from './codec.ts';
import {PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES, PROJECT_SNAPSHOT_MAX_RAW_BYTES} from './limits.ts';
import {versionError, versionSummary} from './repository.ts';

/** Only these immutable source rows survive a host history replacement. The
 * caller owns target rollback and publication; no receipt, mark or execution
 * row is copied, and no snapshot is encoded again. */
export function copyProjectVersionsInside(source: DatabaseSync, target: DatabaseSync, {projectId}: {projectId: string}): {
  versions: number; blobs: number; compressedBytes: number;
} {
  if (source === target || !target.isTransaction || !isProjectId(projectId)) throw new TypeError('Version copy requires a distinct target transaction and project ID');
  for (const db of [source, target]) if (db.prepare('SELECT projectId FROM main.history_state WHERE singleton=1').get()?.projectId !== projectId)
    throw versionError('PROJECT_ID_MISMATCH', '版本复制与项目身份不一致。', 400);
  for (const table of ['project_versions', 'project_version_blobs', 'project_version_requests', 'project_version_capture_marks']) {
    if (target.prepare(`SELECT 1 FROM main.${table} LIMIT 1`).get()) throw versionError('PROJECT_VERSION_RECORD_INVALID', '版本复制目标必须是空的本机记录。', 422);
  }
  const ownRead = !source.isTransaction;
  if (ownRead) source.exec('BEGIN');
  try {
    const bodies = new Map<string, {contentSequence: number}>();
    const blobRows = source.prepare(`SELECT hash,profile,codec,rawBytes,compressedBytes,
      CASE WHEN rawBytes BETWEEN 1 AND ? AND compressedBytes BETWEEN 1 AND ? AND length(payload)=compressedBytes THEN payload END AS payload
      FROM main.project_version_blobs ORDER BY hash`);
    const insertBlob = target.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,?,?,?,?,?)');
    let compressedBytes = 0, blobs = 0, versions = 0;
    for (const row of blobRows.iterate(PROJECT_SNAPSHOT_MAX_RAW_BYTES, PROJECT_SNAPSHOT_MAX_COMPRESSED_BYTES)) {
      const document = inspectProjectDocumentForCopy(row as unknown as EncodedProjectDocument);
      if (document.projectId !== projectId) throw versionError('PROJECT_VERSION_RECORD_INVALID', '版本正文不属于待复制的项目。', 422);
      bodies.set(String(row.hash), {contentSequence: document.contentSequence});
      compressedBytes += Number(row.compressedBytes);
      if (!Number.isSafeInteger(compressedBytes)) throw versionError('PROJECT_VERSION_SNAPSHOT_LIMIT', '版本复制总容量超出安全计数上限。', 413);
      insertBlob.run(row.hash, row.profile, row.codec, row.rawBytes, row.compressedBytes, row.payload); blobs++;
    }
    const columns = ['id', 'projectId', 'trigger', 'name', 'mioRunId', 'contentSequence', 'createdAt', 'blobHash', 'mioChangeRowid'];
    const insertVersion = target.prepare(`INSERT INTO main.project_versions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    for (const row of source.prepare(`SELECT ${columns.join(',')} FROM main.project_versions ORDER BY id`).iterate()) {
      const version = versionSummary(row), body = bodies.get(String(row.blobHash));
      if (version.projectId !== projectId || !body || body.contentSequence !== version.contentSequence || !Number.isSafeInteger(row.mioChangeRowid) || Number(row.mioChangeRowid) < 0)
        throw versionError('PROJECT_VERSION_RECORD_INVALID', '版本摘要、正文或来源边界不一致。', 422);
      insertVersion.run(...columns.map(column => row[column] as SQLInputValue)); versions++;
    }
    if (target.prepare('PRAGMA main.foreign_key_check(project_versions)').get()
      || Number(target.prepare('SELECT count(*) n FROM main.project_versions').get()!.n) !== versions
      || Number(target.prepare('SELECT count(*) n FROM main.project_version_blobs').get()!.n) !== blobs)
      throw versionError('PROJECT_VERSION_RECORD_INVALID', '版本复制计数或引用检查失败。', 422);
    return {versions, blobs, compressedBytes};
  } finally {if (ownRead) source.exec('ROLLBACK');}
}
