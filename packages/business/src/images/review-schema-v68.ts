import type {DatabaseSync} from 'node:sqlite';

// Schema68 lets a storyboard keyframe be the source of an edit (intent v5).
// Its origin names the finished scene task that captured it, the reference
// video and that video's hash, the segment and the captured source frame; the
// edit-source resolver proves that ownership before a review is written. Every
// retained row is kept as it is. Like schema62 this rebuild needs the isolated
// startup foreign-key guard, and copies raw values and rowids before swapping
// tables. The v4 and v5 branches end with the same extracted-frame alternative;
// only v5, the intent every new edit uses, gains the keyframe alternative, so the
// tail is anchored on the separation constraint that follows the v5 branch and
// must be found exactly once.
const V5_END = `
      ),
      CONSTRAINT image_review_edit_separation_v62 CHECK(`;
const EXTRACTED_FRAME_TAIL = `              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.selectionRule') IS 'first-pts-at-or-after-v1')
          ))`;
const SCENE_KEYFRAME_TAIL = `              AND json_extract(canonicalIntent,'$.sourceImage.origin.frameSource.selectionRule') IS 'first-pts-at-or-after-v1')
            OR
            (json_extract(canonicalIntent,'$.sourceImage.origin.kind') IS 'scene-keyframe'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin'),'$.kind','$.sceneKeyframe') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe') IS 'object'
              AND json_remove(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe'),'$.sceneTaskId','$.sourceAssetId','$.sourceHash','$.segment','$.sourceFrame') IS '{}'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sceneTaskId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sceneTaskId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceAssetId') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceAssetId')) IS 36
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash') IS 'text' AND length(json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash')) IS 64
              AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceHash') NOT GLOB '*[^a-f0-9]*'
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.segment') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.segment') BETWEEN 1 AND 1501
              AND json_type(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceFrame') IS 'integer' AND json_extract(canonicalIntent,'$.sourceImage.origin.sceneKeyframe.sourceFrame') BETWEEN 0 AND 18000)
          ))`;

export function migrateSceneKeyframeEditReviewSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error('Storyboard keyframe edit review migration requires a transaction');
  const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get() as {sql: string} | undefined;
  if (!existing) throw new Error('Storyboard keyframe edit review migration requires schema62');
  if (existing.sql.includes('image_review_intent_v68')) return;
  if (!existing.sql.includes('image_review_intent_v62') || existing.sql.split(EXTRACTED_FRAME_TAIL + V5_END).length !== 2) throw new Error('Storyboard keyframe edit review migration requires schema62');
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
  const create = existing.sql.replace(/^CREATE TABLE\s+(?:"image_reviews"|image_reviews)\s*\(/, 'CREATE TABLE image_reviews_v68(')
    .replace('CONSTRAINT image_review_intent_v62', 'CONSTRAINT image_review_intent_v68')
    .replace(EXTRACTED_FRAME_TAIL + V5_END, SCENE_KEYFRAME_TAIL + V5_END);
  if (!create.startsWith('CREATE TABLE image_reviews_v68(') || !create.includes('image_review_intent_v68') || !create.includes("IS 'scene-keyframe'")) throw new Error('Unrecognized image review table');
  db.exec(create);
  const columns = (db.prepare('PRAGMA table_info(image_reviews)').all() as {name: string}[]).map(row => row.name);
  const shape = `rowid,${columns.map(name => `"${name}"`).join(',')}`;
  db.exec(`INSERT INTO image_reviews_v68(${shape}) SELECT ${shape} FROM image_reviews ORDER BY rowid`);
  for (const [left, right] of [['image_reviews', 'image_reviews_v68'], ['image_reviews_v68', 'image_reviews']]) {
    if (db.prepare(`SELECT 1 FROM (SELECT ${shape} FROM ${left} EXCEPT SELECT ${shape} FROM ${right}) LIMIT 1`).get())
      throw new Error('Storyboard keyframe edit review migration changed retained rows');
  }
  for (const trigger of externalTriggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v68 RENAME TO image_reviews;');
  for (const object of [...retainedObjects, ...externalTriggers]) db.exec(object.sql!);
  if (JSON.stringify(db.prepare(objectQuery).all()) !== JSON.stringify(retainedObjects) || JSON.stringify(db.prepare(externalTriggerQuery).all()) !== JSON.stringify(externalTriggers)) throw new Error('Storyboard keyframe edit review migration changed SQL objects');
  if (JSON.stringify(db.prepare('PRAGMA foreign_key_list(image_reviews)').all()) !== JSON.stringify(foreignKeys)) throw new Error('Storyboard keyframe edit review migration changed foreign keys');
  // .get() reads at most the first violation; do not collect unbounded corrupt rows.
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Storyboard keyframe edit review migration failed foreign key verification');
}
