// Additive only. The caller owns the synchronous migration transaction and its
// schema marker. No old table, receipt, sequence, trigger, or row is rewritten.
export function migrateImageReviewSchema(db) {
  if (!db.isTransaction) throw new Error('Image review migration requires a transaction');
  db.exec(IMAGE_REVIEW_SCHEMA_17_SQL);
}

const IMAGE_REVIEW_SCHEMA_17_SQL = `
    CREATE TABLE IF NOT EXISTS image_reviews(
      id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36),
      projectId TEXT NOT NULL REFERENCES projects(id),
      requestId TEXT NOT NULL UNIQUE CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
      inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
      canonicalInput TEXT NOT NULL CHECK(json_valid(canonicalInput) AND json_type(canonicalInput)='object' AND length(CAST(canonicalInput AS BLOB)) BETWEEN 1 AND 24576),
      intentHash TEXT NOT NULL CHECK(length(intentHash)=64 AND intentHash NOT GLOB '*[^a-f0-9]*'),
      canonicalIntent TEXT NOT NULL CHECK(json_valid(canonicalIntent) AND json_type(canonicalIntent)='object' AND length(CAST(canonicalIntent AS BLOB)) BETWEEN 1 AND 32768),
      state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','dispatched')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 3),
      taskId TEXT UNIQUE REFERENCES image_tasks(id) DEFERRABLE INITIALLY DEFERRED,
      postAttempts INTEGER NOT NULL CHECK(typeof(postAttempts)='integer' AND postAttempts IN (0,1)),
      createdAt TEXT NOT NULL CHECK(length(createdAt) BETWEEN 1 AND 40),
      updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
      approvedAt TEXT CHECK(approvedAt IS NULL OR length(approvedAt) BETWEEN 1 AND 40),
      rejectedAt TEXT CHECK(rejectedAt IS NULL OR length(rejectedAt) BETWEEN 1 AND 40),
      dispatchedAt TEXT CHECK(dispatchedAt IS NULL OR length(dispatchedAt) BETWEEN 1 AND 40),
      CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId AND json_extract(canonicalInput,'$.providerId') IS 'openai'),
      CHECK(json_extract(canonicalIntent,'$.schemaVersion') IS 1 AND json_extract(canonicalIntent,'$.reviewId') IS id AND json_extract(canonicalIntent,'$.input') IS json(canonicalInput)),
      CHECK(json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/generations' AND json_extract(canonicalIntent,'$.settingsRevision')>=1),
      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts') IS 1 AND json_extract(canonicalIntent,'$.policy.automaticRetry') IS 0),
      CHECK((taskId IS NOT NULL)=(state IN ('approved','dispatched')) AND (approvedAt IS NOT NULL)=(state IN ('approved','dispatched'))),
      CHECK((rejectedAt IS NOT NULL)=(state='rejected') AND (dispatchedAt IS NOT NULL)=(state='dispatched')),
      CHECK(postAttempts=(state='dispatched') AND revision=CASE state WHEN 'pending' THEN 1 WHEN 'dispatched' THEN 3 ELSE 2 END),
      CHECK(length(CAST(canonicalInput AS BLOB))+length(CAST(canonicalIntent AS BLOB))+length(CAST(requestId AS BLOB))+512<=65536)
    );
    CREATE INDEX IF NOT EXISTS image_reviews_project_page ON image_reviews(projectId,createdAt DESC,id DESC);
    CREATE TRIGGER IF NOT EXISTS immutable_image_review_identity BEFORE UPDATE ON image_reviews
      WHEN NEW.id IS NOT OLD.id OR NEW.projectId IS NOT OLD.projectId OR NEW.requestId IS NOT OLD.requestId OR
        NEW.inputHash IS NOT OLD.inputHash OR NEW.canonicalInput IS NOT OLD.canonicalInput OR
        NEW.intentHash IS NOT OLD.intentHash OR NEW.canonicalIntent IS NOT OLD.canonicalIntent OR NEW.createdAt IS NOT OLD.createdAt OR
        (OLD.taskId IS NOT NULL AND NEW.taskId IS NOT OLD.taskId) OR
        (OLD.approvedAt IS NOT NULL AND NEW.approvedAt IS NOT OLD.approvedAt) OR
        (OLD.rejectedAt IS NOT NULL AND NEW.rejectedAt IS NOT OLD.rejectedAt) OR
        (OLD.dispatchedAt IS NOT NULL AND NEW.dispatchedAt IS NOT OLD.dispatchedAt) OR NEW.postAttempts<OLD.postAttempts
      BEGIN SELECT RAISE(ABORT,'image review identity and reservation are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_review_state_transitions BEFORE UPDATE ON image_reviews
      WHEN NEW.revision IS NOT OLD.revision+1 OR NOT (
        (OLD.state='pending' AND NEW.state IN ('approved','rejected')) OR
        (OLD.state='approved' AND NEW.state='dispatched'))
      BEGIN SELECT RAISE(ABORT,'invalid image review transition'); END;
    CREATE TRIGGER IF NOT EXISTS image_review_task_binding BEFORE UPDATE ON image_reviews
      WHEN NEW.taskId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM image_tasks WHERE id=NEW.taskId AND projectId=NEW.projectId AND requestId=NEW.requestId AND inputHash=NEW.inputHash AND input=NEW.canonicalInput)
      BEGIN SELECT RAISE(ABORT,'image review task binding mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS image_review_insert_pending BEFORE INSERT ON image_reviews
      WHEN NEW.state IS NOT 'pending' OR NEW.revision IS NOT 1 OR NEW.taskId IS NOT NULL OR NEW.postAttempts IS NOT 0
      BEGIN SELECT RAISE(ABORT,'image reviews must start pending'); END;
    CREATE TRIGGER IF NOT EXISTS retain_image_reviews BEFORE DELETE ON image_reviews
      BEGIN SELECT RAISE(ABORT,'image reviews must be retained'); END;
    CREATE TRIGGER IF NOT EXISTS reject_image_review_replacement BEFORE INSERT ON image_reviews
      WHEN EXISTS(SELECT 1 FROM image_reviews WHERE id=NEW.id OR requestId=NEW.requestId)
      BEGIN SELECT RAISE(ABORT,'image reviews cannot be replaced'); END;
`;

// Only this table needs replacement: schema17 pins official OpenAI in CHECKs.
// The owner commits the new schema marker in the same transaction. Existing
// identity/CAS triggers are restored verbatim after historical states are copied.
export function migrateCustomImageReviewSchema(db) {
  if (!db.isTransaction) throw new Error('Custom image review migration requires a transaction');
  const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get();
  if (!existing) throw new Error('Custom image review migration requires schema17');
  if (existing.sql.includes('image_review_intent_v18')) return;
  const retainedObjects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  const columns = ['id','projectId','requestId','inputHash','canonicalInput','intentHash','canonicalIntent','state','revision','taskId','postAttempts','createdAt','updatedAt','approvedAt','rejectedAt','dispatchedAt'];
  const shape = `rowid,${columns.join(',')}`;
  const intentChecks = `
      CHECK(json_extract(canonicalInput,'$.projectId') IS projectId AND json_extract(canonicalInput,'$.requestId') IS requestId),
      CHECK(json_extract(canonicalIntent,'$.reviewId') IS id AND json_extract(canonicalIntent,'$.input') IS json(canonicalInput)),
      CHECK(json_type(canonicalIntent,'$.settingsRevision') IS 'integer' AND json_extract(canonicalIntent,'$.settingsRevision') BETWEEN 1 AND 9007199254740991),
      CONSTRAINT image_review_intent_v18 CHECK(
        (json_extract(canonicalIntent,'$.schemaVersion') IS 1 AND json_extract(canonicalInput,'$.providerId') IS 'openai'
          AND json_extract(canonicalInput,'$.model') IS 'gpt-image-2.5-flare-2026-09-08'
          AND json_extract(canonicalIntent,'$.destination') IS 'https://api.openai.com/v1/images/generations'
          AND json_type(canonicalIntent,'$.configuration') IS NULL)
        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 2 AND json_extract(canonicalInput,'$.providerId') IS 'openai-compatible'
          AND json_type(canonicalIntent,'$.configuration') IS 'object'
          AND json_type(canonicalIntent,'$.configuration.enabled') IS 'true'
          AND json_extract(canonicalIntent,'$.configuration.providerId') IS 'openai-compatible'
          AND json_extract(canonicalIntent,'$.configuration.connectionId') IS 'custom'
          AND json_extract(canonicalIntent,'$.configuration.profileId') IS 'openai-images-json-png-v1'
          AND json_type(canonicalIntent,'$.configuration.baseUrl') IS 'text'
          AND length(json_extract(canonicalIntent,'$.configuration.baseUrl')) BETWEEN 1 AND 2029
          AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),1,8) IS 'https://'
          AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),-1,1) IS NOT '/'
          AND json_type(canonicalInput,'$.model') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.model') AS BLOB)) BETWEEN 1 AND 120
          AND json_extract(canonicalInput,'$.model') NOT GLOB '*[^!-~]*'
          AND json_extract(canonicalIntent,'$.configuration.model') IS json_extract(canonicalInput,'$.model')
          AND json_type(canonicalIntent,'$.configuration.options') IS 'object'
          AND json_extract(canonicalIntent,'$.configuration.options') IS json_extract(canonicalInput,'$.options')
          AND json_extract(canonicalIntent,'$.destination') IS json_extract(canonicalIntent,'$.configuration.baseUrl')||'/images/generations')
      ),`;
  const originalChecks = /      CHECK\(json_extract\(canonicalInput,'\$\.projectId'\)[\s\S]*?      CHECK\(json_extract\(canonicalIntent,'\$\.policy.maxPostAttempts'\)/;
  const create = IMAGE_REVIEW_SCHEMA_17_SQL.slice(0, IMAGE_REVIEW_SCHEMA_17_SQL.indexOf('    CREATE INDEX'))
    .replace('CREATE TABLE IF NOT EXISTS image_reviews(', 'CREATE TABLE image_reviews_v18(')
    .replace(originalChecks, `${intentChecks}\n      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts')`);
  if (!create.includes('image_review_intent_v18')) throw new Error('Invalid custom image review migration');
  db.exec(create);
  db.exec(`INSERT INTO image_reviews_v18(${shape}) SELECT ${shape} FROM image_reviews ORDER BY rowid`);
  // Compare every SQL value, including all original text bytes and hidden rowids,
  // before removing the old table. No JSON parse/stringify or state replay occurs.
  for (const [left,right] of [['image_reviews','image_reviews_v18'],['image_reviews_v18','image_reviews']]) {
    if (db.prepare(`SELECT 1 FROM (SELECT ${shape} FROM ${left} EXCEPT SELECT ${shape} FROM ${right}) LIMIT 1`).get())
      throw new Error('Image review migration did not preserve historical rows');
  }
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v18 RENAME TO image_reviews;');
  for (const object of retainedObjects) db.exec(object.sql);
  const afterObjects = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  if (JSON.stringify(afterObjects) !== JSON.stringify(retainedObjects)) throw new Error('Image review migration did not preserve SQL objects');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Image review migration failed foreign key verification');
}

// Extend only the named v18 intent CHECK. Copy raw SQL values and rowids, then
// restore all preexisting indexes/triggers verbatim within the caller's tx.
export function migrateComfyImageReviewSchema(db) {
  if(!db.isTransaction)throw new Error('Comfy image review migration requires a transaction');
  const existing=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='image_reviews'").get();
  if(!existing)throw new Error('Comfy image review migration requires schema18');
  if(existing.sql.includes('image_review_intent_v19'))return;
  if(!existing.sql.includes('image_review_intent_v18'))throw new Error('Comfy image review migration requires schema18');
  const retainedObjects=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  const boundary="      ),\n      CHECK(json_extract(canonicalIntent,'$.policy.maxPostAttempts')";
  const localBranch=`
        OR
        (json_extract(canonicalIntent,'$.schemaVersion') IS 3 AND json_extract(canonicalInput,'$.providerId') IS 'comfy-local'
          AND json_type(canonicalIntent,'$.configuration') IS 'object'
          AND json_type(canonicalIntent,'$.configuration.enabled') IS 'true'
          AND json_extract(canonicalIntent,'$.configuration.providerId') IS 'comfy-local'
          AND json_extract(canonicalIntent,'$.configuration.connectionId') IS 'comfy-local'
          AND json_extract(canonicalIntent,'$.configuration.profileId') IS 'comfy-t2i-png-v1'
          AND json_extract(canonicalIntent,'$.configuration.comfyVersion') IS '0.39.0'
          AND json_type(canonicalIntent,'$.configuration.baseUrl') IS 'text'
          AND ((json_extract(canonicalIntent,'$.configuration.baseUrl') GLOB 'http://127.0.0.1:[1-9]*'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),18) NOT GLOB '*[^0-9]*'
            AND CAST(substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),18) AS INTEGER) BETWEEN 1 AND 65535)
            OR (substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),1,13) IS 'http://[::1]:'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14,1) GLOB '[1-9]'
            AND substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14) NOT GLOB '*[^0-9]*'
            AND CAST(substr(json_extract(canonicalIntent,'$.configuration.baseUrl'),14) AS INTEGER) BETWEEN 1 AND 65535))
          AND json_type(canonicalInput,'$.model') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.model') AS BLOB)) BETWEEN 1 AND 240
          AND json_extract(canonicalIntent,'$.configuration.model') IS json_extract(canonicalInput,'$.model')
          AND json_type(canonicalIntent,'$.configuration.options') IS 'object'
          AND json_extract(canonicalIntent,'$.configuration.options') IS json_extract(canonicalInput,'$.options')
          AND json_extract(canonicalInput,'$.options.size') IS '512x512'
          AND json_extract(canonicalInput,'$.options.steps') IS 20 AND json_extract(canonicalInput,'$.options.cfg') IS 8
          AND json_extract(canonicalInput,'$.options.sampler') IS 'euler' AND json_extract(canonicalInput,'$.options.scheduler') IS 'normal'
          AND json_extract(canonicalInput,'$.options.denoise') IS 1 AND json_extract(canonicalInput,'$.options.n') IS 1
          AND json_extract(canonicalIntent,'$.destination') IS json_extract(canonicalIntent,'$.configuration.baseUrl')||'/prompt'
          AND json_extract(canonicalIntent,'$.policy.price') IS 'local-compute-unknown'
          AND json_extract(canonicalIntent,'$.policy.promptStorage') IS 'local-plaintext'
          AND json_type(canonicalIntent,'$.execution') IS 'object'
          AND json_extract(canonicalIntent,'$.execution.workflowId') IS 'comfy-t2i-png-v1'
          AND json_extract(canonicalIntent,'$.execution.workflowVersion') IS 1
          AND json_extract(canonicalIntent,'$.execution.comfyVersion') IS '0.39.0'
          AND json_type(canonicalIntent,'$.execution.seed') IS 'integer'
          AND json_extract(canonicalIntent,'$.execution.seed') BETWEEN 0 AND 9007199254740991
          AND length(json_extract(canonicalIntent,'$.execution.promptId')) IS 36
          AND length(json_extract(canonicalIntent,'$.execution.clientId')) IS 36
          AND length(json_extract(canonicalIntent,'$.execution.outputNonce')) IS 36
          AND json_extract(canonicalIntent,'$.execution.filenamePrefix') IS 'mioon_'||json_extract(canonicalIntent,'$.execution.outputNonce')
          AND length(json_extract(canonicalIntent,'$.execution.graphHash')) IS 64
          AND json_type(canonicalIntent,'$.execution.graph') IS 'object'
          AND length(CAST(json_extract(canonicalIntent,'$.execution.graph') AS BLOB)) BETWEEN 1 AND 32768
          AND json_extract(canonicalIntent,'$.execution.graph."1".inputs.ckpt_name') IS json_extract(canonicalInput,'$.model')
          AND json_extract(canonicalIntent,'$.execution.graph."3".inputs.text') IS json_extract(canonicalInput,'$.prompt')
          AND json_extract(canonicalIntent,'$.execution.graph."5".inputs.seed') IS json_extract(canonicalIntent,'$.execution.seed')
          AND json_extract(canonicalIntent,'$.execution.graph."7".inputs.filename_prefix') IS json_extract(canonicalIntent,'$.execution.filenamePrefix'))
${boundary}`;
  if(!existing.sql.includes(boundary))throw new Error('Unrecognized schema18 image review shape');
  const create=existing.sql.replace(/^CREATE TABLE\s+(?:"image_reviews"|image_reviews)\s*\(/,'CREATE TABLE image_reviews_v19(')
    .replace('CONSTRAINT image_review_intent_v18','CONSTRAINT image_review_intent_v19').replace(boundary,localBranch);
  if(!create.startsWith('CREATE TABLE image_reviews_v19('))throw new Error('Unrecognized image review table');
  db.exec(create);
  const columns=db.prepare('PRAGMA table_info(image_reviews)').all().map(row=>row.name);
  const shape=`rowid,${columns.map(name=>`"${name}"`).join(',')}`;
  db.exec(`INSERT INTO image_reviews_v19(${shape}) SELECT ${shape} FROM image_reviews ORDER BY rowid`);
  for(const [left,right] of [['image_reviews','image_reviews_v19'],['image_reviews_v19','image_reviews']])
    if(db.prepare(`SELECT 1 FROM (SELECT ${shape} FROM ${left} EXCEPT SELECT ${shape} FROM ${right}) LIMIT 1`).get())throw new Error('Comfy image review migration changed retained rows');
  db.exec('DROP TABLE image_reviews; ALTER TABLE image_reviews_v19 RENAME TO image_reviews;');
  for(const object of retainedObjects)db.exec(object.sql);
  const after=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='image_reviews' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  if(JSON.stringify(after)!==JSON.stringify(retainedObjects))throw new Error('Comfy image review migration changed SQL objects');
  if(db.prepare('PRAGMA foreign_key_check').get())throw new Error('Comfy image review migration failed foreign key verification');
}
