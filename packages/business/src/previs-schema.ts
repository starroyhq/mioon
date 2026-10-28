import type {DatabaseSync} from 'node:sqlite';

// Schema64 camera previs: save receipts, the thumbnail cache and bounds on
// previs node rows. Every bound is a literal because restore profiles compare
// this exact SQL. Receipts carry the project-deletion exemption of schema48.
// Autosave writes a scene often, so a scene save receipt may also be deleted
// once three newer scene saves of the same node are retained: the service does
// that just before it records the next save, keeping the newest four. Create
// receipts are never pruned. Thumbnails are a disposable, evictable cache.
const NODE_TYPE=(row: string)=>`CASE WHEN json_valid(${row}.data) THEN json_extract(${row}.data,'$.type') END`;
const NODE_BOUNDS=`(length(CAST(NEW.data AS BLOB))>24576 OR json_type(NEW.data,'$.scene') IS NOT 'object' OR json_extract(NEW.data,'$.scene.schemaVersion') IS NOT 1
 OR json_extract(NEW.data,'$.text') IS NOT '' OR json_type(NEW.data,'$.assetId') IS NOT NULL)`;
const CURRENT_SCENE=`EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.nodeId AND n.projectId=NEW.projectId AND json_valid(n.data)
 AND json_extract(n.data,'$.type') IS 'previs' AND json_extract(n.data,'$.sceneRevision') IS NEW.sceneRevision
 AND (NEW.slot='card' OR EXISTS(SELECT 1 FROM json_each(n.data,'$.scene.keyframes') k WHERE json_extract(k.value,'$.id') IS NEW.slot)))`;
const PREVIS_SCHEMA_64_SQL=`
CREATE TABLE previs_requests(
 requestId TEXT PRIMARY KEY NOT NULL CHECK(length(requestId) BETWEEN 8 AND 200 AND length(CAST(requestId AS BLOB))<=800),
 operation TEXT NOT NULL CHECK(operation IN ('previs.create','previs.scene.set')),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 nodeId TEXT NOT NULL REFERENCES nodes(id) CHECK(length(CAST(nodeId AS BLOB))=36),
 sceneRevision INTEGER NOT NULL CHECK(typeof(sceneRevision)='integer' AND sceneRevision BETWEEN 1 AND 9007199254740991),
 inputHash TEXT NOT NULL CHECK(length(inputHash)=64 AND inputHash NOT GLOB '*[^a-f0-9]*'),
 response TEXT NOT NULL CHECK(json_valid(response) AND json_type(response)='object' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 24576),
 UNIQUE(nodeId,operation,sceneRevision),
 CHECK(json_extract(response,'$.id') IS nodeId AND json_extract(response,'$.projectId') IS projectId AND json_extract(response,'$.type') IS 'previs'
 AND json_extract(response,'$.sceneRevision') IS sceneRevision AND json_type(response,'$.scene') IS 'object'),
 CHECK(operation!='previs.create' OR (sceneRevision=1 AND json_extract(response,'$.revision') IS 1))
);
CREATE TABLE previs_thumbnails(
 nodeId TEXT NOT NULL REFERENCES nodes(id) CHECK(length(CAST(nodeId AS BLOB))=36),
 slot TEXT NOT NULL CHECK(slot='card' OR (length(slot) BETWEEN 2 AND 5 AND slot GLOB 'k[1-9]*' AND substr(slot,2) NOT GLOB '*[^0-9]*')),
 projectId TEXT NOT NULL REFERENCES projects(id) CHECK(length(CAST(projectId AS BLOB))=36),
 sceneRevision INTEGER NOT NULL CHECK(typeof(sceneRevision)='integer' AND sceneRevision BETWEEN 1 AND 9007199254740991),
 width INTEGER NOT NULL CHECK(typeof(width)='integer' AND width BETWEEN 1 AND 384),
 height INTEGER NOT NULL CHECK(typeof(height)='integer' AND height BETWEEN 1 AND 384),
 bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND 65536),
 updatedAt TEXT NOT NULL CHECK(length(updatedAt) BETWEEN 1 AND 40),
 PRIMARY KEY(nodeId,slot)
);
CREATE INDEX previs_requests_project ON previs_requests(projectId,operation);
CREATE INDEX previs_thumbnails_project_age ON previs_thumbnails(projectId,updatedAt);
CREATE INDEX previs_thumbnails_age ON previs_thumbnails(updatedAt);
CREATE TRIGGER previs_request_identity BEFORE INSERT ON previs_requests
 WHEN NOT EXISTS(SELECT 1 FROM nodes WHERE id=NEW.nodeId AND projectId=NEW.projectId AND json_valid(data)
 AND json_extract(data,'$.type') IS 'previs' AND json_extract(data,'$.sceneRevision') IS NEW.sceneRevision)
 BEGIN SELECT RAISE(ABORT,'previs requests must bind their saved node');END;
CREATE TRIGGER immutable_previs_requests BEFORE UPDATE ON previs_requests
 BEGIN SELECT RAISE(ABORT,'previs request responses are immutable');END;
CREATE TRIGGER retain_previs_requests BEFORE DELETE ON previs_requests
 WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='previs_requests' AND rowId=OLD.rowid)
 AND NOT (OLD.operation='previs.scene.set' AND (SELECT count(*) FROM previs_requests r
 WHERE r.nodeId=OLD.nodeId AND r.operation='previs.scene.set' AND r.sceneRevision>OLD.sceneRevision)>=3)
 BEGIN SELECT RAISE(ABORT,'previs request responses must be retained');END;
CREATE TRIGGER reject_previs_request_replacement BEFORE INSERT ON previs_requests
 WHEN EXISTS(SELECT 1 FROM previs_requests WHERE requestId=NEW.requestId OR (nodeId=NEW.nodeId AND operation=NEW.operation AND sceneRevision=NEW.sceneRevision))
 BEGIN SELECT RAISE(ABORT,'previs request responses cannot be replaced');END;
CREATE TRIGGER previs_request_capacity BEFORE INSERT ON previs_requests
 WHEN (SELECT count(*) FROM previs_requests WHERE nodeId=NEW.nodeId)>=5 OR (SELECT count(*) FROM previs_requests)>=8192
 OR (NEW.operation='previs.create' AND ((SELECT count(*) FROM previs_requests WHERE projectId=NEW.projectId AND operation='previs.create')>=256
 OR (SELECT count(*) FROM previs_requests WHERE operation='previs.create')>=1024))
 BEGIN SELECT RAISE(ABORT,'previs request capacity exceeded');END;
CREATE TRIGGER previs_thumbnail_insert_identity BEFORE INSERT ON previs_thumbnails
 WHEN NOT ${CURRENT_SCENE}
 BEGIN SELECT RAISE(ABORT,'previs thumbnails belong to the current scene');END;
CREATE TRIGGER previs_thumbnail_update_identity BEFORE UPDATE ON previs_thumbnails
 WHEN NEW.nodeId IS NOT OLD.nodeId OR NEW.slot IS NOT OLD.slot OR NEW.projectId IS NOT OLD.projectId OR NOT ${CURRENT_SCENE}
 BEGIN SELECT RAISE(ABORT,'previs thumbnails belong to the current scene');END;
CREATE TRIGGER previs_thumbnail_capacity BEFORE INSERT ON previs_thumbnails
 WHEN (SELECT count(*) FROM previs_thumbnails WHERE nodeId=NEW.nodeId)>=25 OR (SELECT count(*) FROM previs_thumbnails WHERE projectId=NEW.projectId)>=1000
 OR (SELECT count(*) FROM previs_thumbnails)>=2048
 BEGIN SELECT RAISE(ABORT,'previs thumbnail capacity exceeded');END;
CREATE TRIGGER previs_node_insert_bounds BEFORE INSERT ON nodes
 WHEN ${NODE_TYPE('NEW')} IS 'previs' AND ${NODE_BOUNDS}
 BEGIN SELECT RAISE(ABORT,'previs nodes must stay bounded');END;
CREATE TRIGGER previs_node_update_bounds BEFORE UPDATE ON nodes
 WHEN (${NODE_TYPE('OLD')} IS 'previs') IS NOT (${NODE_TYPE('NEW')} IS 'previs') OR (${NODE_TYPE('NEW')} IS 'previs' AND ${NODE_BOUNDS})
 BEGIN SELECT RAISE(ABORT,'previs nodes must stay bounded');END;
`;

/** Trusted construction only: the schema64 migration and fixed restore
 * profiles. The caller owns the transaction and the schema marker. */
export function installPrevisDefinitions(db: DatabaseSync): void {
 if(!db.isTransaction)throw Object.assign(new Error('Previs schema installation requires a transaction'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 db.exec(PREVIS_SCHEMA_64_SQL);
}

/** Bounded row sanity for classification. The DDL itself is compared exactly
 * by the fixed profiles; record contents are verified by the readers. Previs
 * node rows themselves are ordinary canvas rows and are not judged here. */
export function validatePrevisRows(db: DatabaseSync): void {
 const invalid=(): never=>{throw Object.assign(new Error('Previs rows are invalid'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});};
 const count=(table: string,cap: number): number=>Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${cap+1})`).get()!.n);
 if(count('previs_requests',8192)>8192||count('previs_thumbnails',2048)>2048)invalid();
 const owner=(table: string)=>`SELECT 1 FROM ${table} t LEFT JOIN nodes n ON n.id=t.nodeId WHERE n.id IS NULL OR n.projectId IS NOT t.projectId OR NOT json_valid(n.data) OR json_extract(n.data,'$.type') IS NOT 'previs' LIMIT 1`;
 if(db.prepare(owner('previs_requests')).get()||db.prepare(owner('previs_thumbnails')).get())invalid();
 if(db.prepare("SELECT 1 FROM previs_requests WHERE operation='previs.scene.set' GROUP BY nodeId HAVING count(*)>4 LIMIT 1").get())invalid();
 if(db.prepare('SELECT 1 FROM previs_thumbnails GROUP BY nodeId HAVING count(*)>25 LIMIT 1').get()||db.prepare('SELECT 1 FROM previs_thumbnails GROUP BY projectId HAVING count(*)>1000 LIMIT 1').get())invalid();
}
