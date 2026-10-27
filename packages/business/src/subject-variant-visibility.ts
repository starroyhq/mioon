import type {DatabaseSync} from 'node:sqlite';

// Versions of an undone angle or lighting batch are hidden: kept for history,
// left out of version lists and refused for new bindings and generations.
// Workspaces without the schema62 tables have no hidden versions.
const tables=['subject_variant_batches','subject_variant_items','subject_variant_requests'];
export function subjectVariantSchemaPresent(db: DatabaseSync): boolean {
 return Number((db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN (${tables.map(name=>`'${name}'`).join(',')})`).get() as {n: number}).n)===tables.length;
}
export const HIDDEN_SUBJECT_VERSION_SQL="EXISTS(SELECT 1 FROM subject_variant_items i JOIN subject_variant_batches b ON b.id=i.batchId AND b.projectId=i.projectId WHERE i.versionId=subject_versions.id AND b.state='undone')";
export function isSubjectVersionHidden(db: DatabaseSync,versionId: string): boolean {
 if(!subjectVariantSchemaPresent(db))return false;
 return Boolean(db.prepare("SELECT 1 FROM subject_variant_items i JOIN subject_variant_batches b ON b.id=i.batchId AND b.projectId=i.projectId WHERE i.versionId=? AND b.state='undone' LIMIT 1").get(versionId));
}
