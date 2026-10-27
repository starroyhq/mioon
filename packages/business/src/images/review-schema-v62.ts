import type {DatabaseSync} from 'node:sqlite';

// Schema62 adds edit intent v5: an output size from the model's edit profile and
// a PNG, JPEG or WebP source within the widened local bounds. The exact size
// rule and model limits are checked by the review contract before insert; this
// CHECK keeps the stored shape bounded. The v4 branch and every retained row are
// kept as they are. Like schema23 this rebuild needs the isolated startup
// foreign-key guard, and copies raw values and rowids before swapping tables.
// The frozen schema23 module stays untouched; its separation text is repeated
// here exactly and must be found exactly once.
const IMAGE_EDIT_REVIEW_V23_SEPARATION = `      CONSTRAINT image_review_edit_separation_v23 CHECK(
        json_extract(canonicalIntent,'$.schemaVersion') IS 4 OR
        (json_type(canonicalInput,'$.purpose') IS NULL AND json_type(canonicalInput,'$.inputImage') IS NULL AND json_type(canonicalIntent,'$.sourceImage') IS NULL)),`;
const IMAGE_EDIT_REVIEW_V62_SEPARATION = `      CONSTRAINT image_review_edit_separation_v62 CHECK(
        json_extract(canonicalIntent,'$.schemaVersion') IS 4 OR json_extract(canonicalIntent,'$.schemaVersion') IS 5 OR
        (json_type(canonicalInput,'$.purpose') IS NULL AND json_type(canonicalInput,'$.inputImage') IS NULL AND json_type(canonicalIntent,'$.sourceImage') IS NULL)),`;
const IMAGE_EDIT_REVIEW_V62_BRANCH = `
        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 5
          AND json_extract(canonicalInput,'$.providerId') IS 'openai'
          AND json_extract(canonicalInput,'$.model') IS 'gpt-image-2.5-flare-2026-09-08'
          AND json_extract(canonicalInput,'$.purpose') IS 'edit'
          AND json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/edits'
          AND json_type(canonicalIntent,'$.configuration') IS NULL AND json_type(canonicalIntent,'$.execution') IS NULL
          AND json_remove(canonicalIntent,'$.schemaVersion','$.reviewId','$.input','$.settingsRevision','$.destination','$.policy','$.sourceImage') IS '{}'
          AND json_type(canonicalIntent,'$.policy') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.policy'),'$.maxPostAttempts','$.automaticRetry','$.price','$.promptStorage') IS '{}'
          AND json_type(canonicalIntent,'$.policy.maxPostAttempts') IS 'integer' AND json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1
          AND json_type(canonicalIntent,'$.policy.automaticRetry') IS 'false'
          AND json_extract(canonicalIntent,'$.policy.price') IS 'usage-based-unknown' AND json_extract(canonicalIntent,'$.policy.promptStorage') IS 'local-plaintext'
          AND json_remove(canonicalInput,'$.projectId','$.requestId','$.name','$.providerId','$.model','$.prompt','$.options','$.groupId','$.expectedRevision','$.purpose','$.inputImage') IS '{}'
          AND json_type(canonicalInput,'$.inputImage') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.inputImage'),'$.assetId','$.sha256') IS '{}'
          AND json_type(canonicalInput,'$.inputImage.assetId') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.assetId')) IS 36
          AND json_type(canonicalInput,'$.inputImage.sha256') IS 'text' AND length(json_extract(canonicalInput,'$.inputImage.sha256')) IS 64
          AND json_extract(canonicalInput,'$.inputImage.sha256') NOT GLOB '*[^a-f0-9]*'
          AND json_type(canonicalInput,'$.options') IS 'object'
          AND json_remove(json_extract(canonicalInput,'$.options'),'$.size','$.quality','$.outputFormat','$.background','$.n') IS '{}'
          AND json_type(canonicalInput,'$.options.size') IS 'text' AND length(json_extract(canonicalInput,'$.options.size')) BETWEEN 7 AND 9
          AND json_extract(canonicalInput,'$.options.size') GLOB '[1-9]*x[1-9]*' AND json_extract(canonicalInput,'$.options.size') NOT GLOB '*[^0-9x]*' AND json_extract(canonicalInput,'$.options.quality') IS 'low'
          AND json_extract(canonicalInput,'$.options.outputFormat') IS 'png' AND json_extract(canonicalInput,'$.options.background') IS 'opaque'
          AND json_type(canonicalInput,'$.options.n') IS 'integer' AND json_extract(canonicalInput,'$.options.n') IS 1
          AND json_type(canonicalIntent,'$.sourceImage') IS 'object'
          AND json_remove(json_extract(canonicalIntent,'$.sourceImage'),'$.assetId','$.sha256','$.mimeType','$.byteLength','$.width','$.height','$.name','$.origin') IS '{}'
          AND json_extract(canonicalIntent,'$.sourceImage.assetId') IS json_extract(canonicalInput,'$.inputImage.assetId')
          AND json_extract(canonicalIntent,'$.sourceImage.sha256') IS json_extract(canonicalInput,'$.inputImage.sha256')
          AND json_extract(canonicalIntent,'$.sourceImage.mimeType') IN ('image/png','image/jpeg','image/webp')
          AND json_type(canonicalIntent,'$.sourceImage.byteLength') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.byteLength') BETWEEN 1 AND 52428799
          AND json_type(canonicalIntent,'$.sourceImage.width') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.width') BETWEEN 1 AND 4096
          AND json_type(canonicalIntent,'$.sourceImage.height') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.height') BETWEEN 1 AND 4096
          AND json_extract(canonicalIntent,'$.sourceImage.width')*json_extract(canonicalIntent,'$.sourceImage.height')<=16777216
          AND json_type(canonicalIntent,'$.sourceImage.name') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.name')) BETWEEN 1 AND 200
          AND length(trim(json_extract(canonicalIntent,'$.sourceImage.name')))>0
          AND length(CAST(json_extract(canonicalIntent,'$.sourceImage.name') AS BLOB)) BETWEEN 1 AND 800
          AND json_type(canonicalIntent,'$.sourceImage.origin') IS 'object'
          AND (
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'user-import'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind') IS '{}')
            OR
            ((json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'generated' OR json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'synthetic-mock')
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.imageSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource'),'$.imageGroupId','$.imageTaskId','$.imageVersionId') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageGroupId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.imageSource.imageVersionId')) IS 36)
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'extracted-frame'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.frameSource') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource'),'$.frameTaskId','$.sourceAssetId','$.sourceHash','$.sourceFrame','$.fps','$.profileId','$.selectionRule') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.frameTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceAssetId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash')) IS 64
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceHash') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.sourceFrame') BETWEEN 0 AND 9007199254740991
              AND json_type(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.fps') IS 30
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.profileId') IS 'local-png-1024-v1'
              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.selectionRule') IS 'first-pts-at-or-after-v1')
          ))`;

export function migrateSizedImageEditReviewSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Sized image edit review migration requires a transaction');
  const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql: string} | undefined;
  if (!existing) throw new Error('Sized image edit review migration requires schema23');
  if (existing.sql.includes('image_review_intent_v62')) return;
  const boundary = `\n      ),\n${IMAGE_EDIT_REVIEW_V23_SEPARATION}`;
  if (!existing.sql.includes('image_review_intent_v23') || existing.sql.split(boundary).length !== 2) throw new Error('Sized image edit review migration requires schema23');
  if ((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys: number}).foreign_keys !== 0) throw new Error('Image edit review rebuild requires the isolated startup foreign-key guard');
  const objectQuery = "SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END AS sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name LIMIT 129";
  const retainedObjects = db.prepare(objectQuery).all() as {sql: string | null; name: string}[];
  // SQLite validates trigger bodies during RENAME, including triggers owned by
  // other tables. Remove only references to the briefly absent parent, then
  // restore their exact original SQL inside this same rollback boundary.
  const externalTriggerQuery = "SELECT type,name,tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END AS sql FROM sqlite_schema WHERE type='trigger' AND tbl_name!='image_reviews' AND instr(lower(sql),'image_reviews')>0 ORDER BY name LIMIT 129";
  const externalTriggers = db.prepare(externalTriggerQuery).all() as {sql: string | null; name: string}[];
  if (retainedObjects.length > 128 || externalTriggers.length > 128 || [...retainedObjects, ...externalTriggers].some(object => object.sql === null || Buffer.byteLength(object.name) > 1024)) throw new Error('Image review SQL objects exceed migration bounds');
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(image_reviews)').all();
  const create = existing.sql.replace(/^CREATE TABLE\s+(?:"image_reviews"|image_reviews)\s*\(/, 'CREATE TABLE image_reviews_v62(')
    .replace('CONSTRAINT image_review_intent_v23', 'CONSTRAINT image_review_intent_v62')
    .replace(boundary, `${IMAGE_EDIT_REVIEW_V62_BRANCH}\n      ),\n${IMAGE_EDIT_REVIEW_V62_SEPARATION}`);
  if (!create.startsWith('CREATE TABLE image_reviews_v62(') || !create.includes('image_review_intent_v62') || !create.includes('image_review_edit_separation_v62')) throw new Error('Unrecognized image review table');
  db.exec(create);
  const columns = (db.prepare('PRAGMA table_info(image_reviews)').all() as {name: string}[]).map(row => row.name);
  const shape = `rowid,${columns.map(name => `"${name}"`).join(',')}`;
  db.exec(`INSERT INTO image_reviews_v62(${shape}) SELECT ${shape} FROM image_reviews ORDER BY rowid`);
  for (const [left, right] of [['image_reviews', 'image_reviews_v62'], ['image_reviews_v62', 'image_reviews']]) {
    if (db.prepare(`SELECT 1 FROM (SELECT ${shape} FROM ${left} EXCEPT SELECT ${shape} FROM ${right}) LIMIT 1`).get())
      throw new Error('Sized image edit review migration changed retained rows');
  }
  for (const trigger of externalTriggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v62 RENAME TO image_reviews;');
  for (const object of [...retainedObjects, ...externalTriggers]) db.exec(object.sql!);
  if (JSON.stringify(db.prepare(objectQuery).all()) !== JSON.stringify(retainedObjects) || JSON.stringify(db.prepare(externalTriggerQuery).all()) !== JSON.stringify(externalTriggers)) throw new Error('Sized image edit review migration changed SQL objects');
  if (JSON.stringify(db.prepare('PRAGMA foreign_key_list(image_reviews)').all()) !== JSON.stringify(foreignKeys)) throw new Error('Sized image edit review migration changed foreign keys');
  // .get() reads at most the first violation; do not collect unbounded corrupt rows.
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Sized image edit review migration failed foreign key verification');
}
