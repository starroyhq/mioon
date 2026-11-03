/** Local logical versions. No process transcript or source-media bytes. */
const integer = (name: string, maximum = 9007199254740991) => `${name} INTEGER NOT NULL CHECK(typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${maximum})`;
const project = "projectId TEXT NOT NULL CHECK(typeof(projectId)='text' AND length(projectId)=36)";
const hash = "hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64 AND hash NOT GLOB '*[^a-f0-9]*')";
const immutable = (table: string, key: string): string[] => [
  `CREATE TRIGGER immutable_${table} BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END`,
  `CREATE TRIGGER reject_${table}_replacement BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${key} OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END`,
];
export const VERSION_TABLES = Object.freeze(['project_version_blobs','project_versions','project_version_requests','project_version_capture_marks'] as const);
export const VERSION_SCHEMA: readonly string[] = Object.freeze([
  `CREATE TABLE project_version_blobs(${hash},profile INTEGER NOT NULL CHECK(profile=1),codec TEXT NOT NULL CHECK(codec='gzip'),${integer('rawBytes',134217728)},${integer('compressedBytes',67108864)},payload BLOB NOT NULL CHECK(typeof(payload)='blob' AND length(payload)=compressedBytes AND compressedBytes>0))`,
  ...immutable('project_version_blobs','hash=NEW.hash'),
  `CREATE TABLE project_versions(id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),${project},trigger TEXT NOT NULL CHECK(trigger IN ('manual','mio-turn','bulk-change','restore','daily-open')),name TEXT CHECK(name IS NULL OR (length(name) BETWEEN 1 AND 150)),mioRunId TEXT,${integer('contentSequence')},createdAt TEXT NOT NULL CHECK(length(createdAt)=24),blobHash TEXT NOT NULL REFERENCES project_version_blobs(hash),${integer('mioChangeRowid')},FOREIGN KEY(projectId,mioRunId) REFERENCES mio_runs(projectId,id),CHECK(trigger='manual' OR name IS NULL),CHECK((trigger='mio-turn' AND mioRunId IS NOT NULL) OR (trigger<>'mio-turn' AND mioRunId IS NULL)),UNIQUE(projectId,id))`,
  'CREATE INDEX project_versions_page ON project_versions(projectId,createdAt DESC,id DESC)',
  "CREATE UNIQUE INDEX project_versions_run ON project_versions(projectId,mioRunId) WHERE mioRunId IS NOT NULL",
  ...immutable('project_versions','id=NEW.id'),
  "CREATE TRIGGER retain_manual_project_versions BEFORE DELETE ON project_versions WHEN OLD.trigger='manual' BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_MANUAL_RETAINED');END",
  `CREATE TABLE project_version_requests(${project},requestId TEXT NOT NULL CHECK(length(requestId)=36),operation TEXT NOT NULL CHECK(operation IN ('project.version.save','project.version.restore')),inputDigest TEXT NOT NULL CHECK(length(inputDigest)=64 AND inputDigest NOT GLOB '*[^a-f0-9]*'),response TEXT NOT NULL CHECK(json_valid(response) AND length(CAST(response AS BLOB)) BETWEEN 1 AND 65536),PRIMARY KEY(projectId,requestId))`,
  ...immutable('project_version_requests','(projectId=NEW.projectId AND requestId=NEW.requestId)'),
  "CREATE TRIGGER retain_project_version_requests BEFORE DELETE ON project_version_requests BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END",
  `CREATE TABLE project_version_capture_marks(${project},kind TEXT NOT NULL CHECK(kind IN ('mio-turn','daily-open')),key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 200),createdAt TEXT NOT NULL,PRIMARY KEY(projectId,kind,key))`,
  ...immutable('project_version_capture_marks','(projectId=NEW.projectId AND kind=NEW.kind AND key=NEW.key)'),
  "CREATE TRIGGER retain_project_version_capture_marks BEFORE DELETE ON project_version_capture_marks BEGIN SELECT RAISE(ABORT,'PROJECT_VERSION_IMMUTABLE');END",
]);
