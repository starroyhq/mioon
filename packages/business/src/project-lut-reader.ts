import type {DatabaseSync} from 'node:sqlite';
import type {LutResource} from '../../contracts/src/lut-resources.ts';
import {LUT_RESOURCE_LIMITS} from '../../contracts/src/lut-resources.ts';
import {assertProjectDatabase} from './store-runtime.ts';
import {LUT_RESOURCE_COLUMNS, lutResourceError, lutResourceFromRow, lutHash, parseLutBytes} from './lut-resource-validation.ts';

/** Live project reader using the same strict metadata, hash and Cube validators. */
export function readLutResource(db: DatabaseSync, projectId: string, lutId: string, verifyBytes = false): LutResource {
  assertProjectDatabase(db);
  const row = db.prepare(`SELECT ${LUT_RESOURCE_COLUMNS} FROM project.project_lut_resources WHERE projectId=? AND id=?`).get(projectId, lutId);
  if (!row) throw lutResourceError('LUT_NOT_FOUND', 404);
  const resource = lutResourceFromRow(row);
  if (resource.projectId !== projectId || resource.id !== lutId) throw lutResourceError();
  if (verifyBytes) {
    const cell = db.prepare(`SELECT CASE WHEN typeof(content)='blob' AND length(content) BETWEEN 1 AND ${LUT_RESOURCE_LIMITS.sourceBytes} THEN content END AS content FROM project.project_lut_resources WHERE projectId=? AND id=?`).get(projectId, lutId);
    const content = cell?.content;
    if (!(content instanceof Uint8Array) || content.length !== resource.sizeBytes || lutHash(content) !== resource.sha256) throw lutResourceError();
    const parsed = parseLutBytes(content);
    if (JSON.stringify(parsed.metadata) !== JSON.stringify(resource.metadata)) throw lutResourceError();
  }
  return resource;
}
