import {DatabaseSync} from 'node:sqlite';
import type {ConvertedTempTrigger} from '../../packages/business/src/project-file/cross-file/converted-triggers.ts';
import {installRestoreScopeFunction} from '../../packages/business/src/project-file/cross-file/restore-admission.ts';

interface TempGuardProbe {
  readonly name: string;
  readonly setup: readonly string[];
  readonly allowed: string;
  readonly denied: string;
  readonly error: string;
}
export interface ProbeTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly {readonly name: string; readonly type: string}[];
}
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

// Independent behavioral examples for every current converted guard. Stand-in
// tables retain native column names/affinities but intentionally omit other
// constraints: a different trigger or FK must not hide a disabled guard.
const TEMP_GUARD_PROBES: readonly TempGuardProbe[] = [
  {
    "name": "reject_legacy_frame_asset_owner",
    "setup": [
      "INSERT INTO main.frame_tasks(id,projectId,assetId) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102')"
    ],
    "allowed": "INSERT INTO project.versions(id,data) VALUES('00000000-0000-4000-8000-000000000103','{\"assetId\":\"00000000-0000-4000-8000-000000000104\"}')",
    "denied": "INSERT INTO project.versions(id,data) VALUES('00000000-0000-4000-8000-000000000104','{\"assetId\":\"00000000-0000-4000-8000-000000000102\"}')",
    "error": "frame asset already has an owner"
  },
  {
    "name": "subject_variant_version_binding",
    "setup": [
      "INSERT INTO main.subject_variant_batches(id,projectId,subjectId,state,kind,sourceVersionId) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','active','angle','00000000-0000-4000-8000-000000000102')"
    ],
    "allowed": "INSERT INTO project.subject_versions(id,projectId,subjectId,data) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','{\"variant\":{\"batchId\":\"00000000-0000-4000-8000-000000000101\",\"kind\":\"angle\",\"sourceVersionId\":\"00000000-0000-4000-8000-000000000102\"}}')",
    "denied": "INSERT INTO project.subject_versions(id,projectId,subjectId,data) VALUES('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103','{\"variant\":{\"batchId\":\"00000000-0000-4000-8000-000000000101\",\"kind\":\"angle\",\"sourceVersionId\":\"00000000-0000-4000-8000-000000000104\"}}')",
    "error": "subject variant versions must belong to an active batch"
  },
  {
    "name": "reject_image_frame_asset_owner",
    "setup": [
      "INSERT INTO main.frame_tasks(id,projectId,assetId,stagedReceipt) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001',NULL,'{\"assetId\":\"00000000-0000-4000-8000-000000000102\"}')"
    ],
    "allowed": "INSERT INTO project.image_versions(id,projectId,assetId) VALUES('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000104')",
    "denied": "INSERT INTO project.image_versions(id,projectId,assetId) VALUES('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102')",
    "error": "frame asset already has an owner"
  },
  {
    "name": "scene_result_identity",
    "setup": [
      "INSERT INTO project.assets(id,projectId) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001')",
      "INSERT INTO main.scene_tasks(id,projectId,kind,sourceAssetId,input,snapshot,state,resultId) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','detect','00000000-0000-4000-8000-000000000101','{\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}','{\"profileId\":\"scene-cuts-v1\"}','running',NULL)"
    ],
    "allowed": "INSERT INTO project.scene_results(id,projectId,assetId,position,origin,taskId,sourceHash,profileId,frameCount,cuts) VALUES('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',1,'detected','00000000-0000-4000-8000-000000000102','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','scene-cuts-v1',12,'[]')",
    "denied": "INSERT INTO project.scene_results(id,projectId,assetId,position,origin,taskId,sourceHash,profileId,frameCount,cuts) VALUES('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',2,'detected','00000000-0000-4000-8000-000000000102','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','scene-cuts-v1',12,'[]')",
    "error": "scene result must bind its detection or base result"
  },
  {
    "name": "scene_request_identity",
    "setup": [
      "INSERT INTO main.scene_tasks(id,projectId,requestId,kind,sourceAssetId,input,inputHash,snapshot,state,revision,started,errorCode,createdAt,updatedAt,resultId) VALUES('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000102','detect','00000000-0000-4000-8000-000000000101','{\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{\"profileId\":\"scene-cuts-v1\"}','running',3,1,NULL,'2026-11-03T00:00:00.000Z','2026-11-03T00:00:01.000Z',NULL)"
    ],
    "allowed": "INSERT INTO main.scene_requests(requestId,projectId,taskId,resultId,operation,inputHash,canonicalInput,response) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103',NULL,'scene.detect','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}','{\"requestId\":\"00000000-0000-4000-8000-000000000102\",\"kind\":\"detect\",\"sourceAssetId\":\"00000000-0000-4000-8000-000000000101\",\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"state\":\"running\",\"revision\":3,\"started\":1,\"errorCode\":null,\"createdAt\":\"2026-11-03T00:00:00.000Z\",\"updatedAt\":\"2026-11-03T00:00:01.000Z\"}')",
    "denied": "INSERT INTO main.scene_requests(requestId,projectId,taskId,resultId,operation,inputHash,canonicalInput,response) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000103',NULL,'scene.detect','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}','{\"requestId\":\"00000000-0000-4000-8000-000000000102\",\"kind\":\"detect\",\"sourceAssetId\":\"00000000-0000-4000-8000-000000000101\",\"sourceHash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"state\":\"running\",\"revision\":4,\"started\":1,\"errorCode\":null,\"createdAt\":\"2026-11-03T00:00:00.000Z\",\"updatedAt\":\"2026-11-03T00:00:01.000Z\"}')",
    "error": "scene request must bind its original acknowledgement"
  },
  {
    "name": "previs_request_identity",
    "setup": [
      "INSERT INTO project.nodes(id,projectId,data) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','{\"type\":\"previs\",\"sceneRevision\":7}')"
    ],
    "allowed": "INSERT INTO main.previs_requests(requestId,projectId,nodeId,sceneRevision) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',7)",
    "denied": "INSERT INTO main.previs_requests(requestId,projectId,nodeId,sceneRevision) VALUES('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000101',8)",
    "error": "previs requests must bind their saved node"
  },
  {
    "name": "frame_asset_project",
    "setup": [
      "INSERT INTO project.assets(id,projectId) VALUES('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001')",
      "INSERT INTO project.assets(id,projectId) VALUES('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000002')",
      "INSERT INTO main.frame_tasks(id,projectId,assetId) VALUES('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000001',NULL)"
    ],
    "allowed": "UPDATE main.frame_tasks SET assetId='00000000-0000-4000-8000-000000000101' WHERE id='00000000-0000-4000-8000-000000000103'",
    "denied": "UPDATE main.frame_tasks SET assetId='00000000-0000-4000-8000-000000000102' WHERE id='00000000-0000-4000-8000-000000000103'",
    "error": "frame result must belong to its task project"
  },
  {
    "name": "reject_frame_mixed_asset_owner",
    "setup": [
      "INSERT INTO main.frame_tasks(id,projectId,assetId,stagedReceipt) VALUES('frame-task','11111111-1111-4111-8111-111111111111',NULL,NULL)",
      "INSERT INTO project.versions(id,projectId,data) VALUES('legacy-version','11111111-1111-4111-8111-111111111111','{\"assetId\":\"66666666-6666-4666-8666-666666666666\"}')"
    ],
    "allowed": "UPDATE main.frame_tasks SET assetId='55555555-5555-4555-8555-555555555555',stagedReceipt='{\"assetId\":\"55555555-5555-4555-8555-555555555555\"}' WHERE id='frame-task'",
    "denied": "UPDATE main.frame_tasks SET assetId='66666666-6666-4666-8666-666666666666',stagedReceipt='{\"assetId\":\"66666666-6666-4666-8666-666666666666\"}' WHERE id='frame-task'",
    "error": "frame asset already has an owner"
  },
  {
    "name": "scene_task_insert_identity",
    "setup": [
      "INSERT INTO project.assets(id,projectId) VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111')",
      "INSERT INTO project.assets(id,projectId) VALUES('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222')"
    ],
    "allowed": "INSERT INTO main.scene_tasks(id,projectId,sourceAssetId,state,revision,started,resultId,stagedReceipt,outcome,errorCode,createdAt,updatedAt) VALUES('scene-accepted','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','queued',1,0,NULL,NULL,NULL,NULL,'2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z')",
    "denied": "INSERT INTO main.scene_tasks(id,projectId,sourceAssetId,state,revision,started,resultId,stagedReceipt,outcome,errorCode,createdAt,updatedAt) VALUES('scene-foreign-source','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','queued',1,0,NULL,NULL,NULL,NULL,'2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z')",
    "error": "scene tasks must be accepted before execution"
  },
  {
    "name": "scene_task_result_binding",
    "setup": [
      "INSERT INTO main.scene_tasks(id,projectId,sourceAssetId,resultId) VALUES('scene-task','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333',NULL)",
      "INSERT INTO project.scene_results(id,taskId,projectId,assetId) VALUES('own-result','scene-task','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')",
      "INSERT INTO project.scene_results(id,taskId,projectId,assetId) VALUES('other-task-result','other-task','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333')"
    ],
    "allowed": "UPDATE main.scene_tasks SET resultId='own-result' WHERE id='scene-task'",
    "denied": "UPDATE main.scene_tasks SET resultId='other-task-result' WHERE id='scene-task'",
    "error": "scene task result must be its own detection"
  },
  {
    "name": "subject_variant_batch_insert_identity",
    "setup": [
      "INSERT INTO project.subjects(id,projectId,kind) VALUES('character-subject','11111111-1111-4111-8111-111111111111','character')",
      "INSERT INTO project.subjects(id,projectId,kind) VALUES('location-subject','11111111-1111-4111-8111-111111111111','location')"
    ],
    "allowed": "INSERT INTO main.subject_variant_batches(id,projectId,subjectId,state,revision,createdAt,updatedAt) VALUES('character-batch','11111111-1111-4111-8111-111111111111','character-subject','active',1,'2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z')",
    "denied": "INSERT INTO main.subject_variant_batches(id,projectId,subjectId,state,revision,createdAt,updatedAt) VALUES('location-batch','11111111-1111-4111-8111-111111111111','location-subject','active',1,'2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z')",
    "error": "subject variant batches must start active for a character or product"
  },
  {
    "name": "subject_variant_item_version",
    "setup": [
      "INSERT INTO main.subject_variant_batches(id,projectId,subjectId) VALUES('subject-batch','11111111-1111-4111-8111-111111111111','character-subject')",
      "INSERT INTO main.subject_variant_items(batchId,projectId,position,versionId) VALUES('subject-batch','11111111-1111-4111-8111-111111111111',1,NULL)",
      "INSERT INTO project.subject_versions(id,projectId,subjectId,data) VALUES('own-subject-version','11111111-1111-4111-8111-111111111111','character-subject','{\"variant\":{\"batchId\":\"subject-batch\"}}')",
      "INSERT INTO project.subject_versions(id,projectId,subjectId,data) VALUES('other-batch-version','11111111-1111-4111-8111-111111111111','character-subject','{\"variant\":{\"batchId\":\"other-batch\"}}')"
    ],
    "allowed": "UPDATE main.subject_variant_items SET versionId='own-subject-version' WHERE batchId='subject-batch' AND position=1",
    "denied": "UPDATE main.subject_variant_items SET versionId='other-batch-version' WHERE batchId='subject-batch' AND position=1",
    "error": "subject variant item version must be its own result"
  },
  {
    "name": "previs_thumbnail_insert_identity",
    "setup": [
      "INSERT INTO project.nodes(id,projectId,data) VALUES('previs-node','11111111-1111-4111-8111-111111111111','{\"type\":\"previs\",\"sceneRevision\":2,\"scene\":{\"keyframes\":[{\"id\":\"k1\"}]}}')"
    ],
    "allowed": "INSERT INTO cache.previs_thumbnails(nodeId,projectId,sceneRevision,slot) VALUES('previs-node','11111111-1111-4111-8111-111111111111',2,'k1')",
    "denied": "INSERT INTO cache.previs_thumbnails(nodeId,projectId,sceneRevision,slot) VALUES('previs-node','11111111-1111-4111-8111-111111111111',1,'k1')",
    "error": "previs thumbnails belong to the current scene"
  },
  {
    "name": "previs_thumbnail_update_identity",
    "setup": [
      "INSERT INTO project.nodes(id,projectId,data) VALUES('previs-node','11111111-1111-4111-8111-111111111111','{\"type\":\"previs\",\"sceneRevision\":2,\"scene\":{\"keyframes\":[{\"id\":\"k1\"},{\"id\":\"k2\"}]}}')",
      "INSERT INTO cache.previs_thumbnails(nodeId,projectId,sceneRevision,slot) VALUES('previs-node','11111111-1111-4111-8111-111111111111',1,'k1')"
    ],
    "allowed": "UPDATE cache.previs_thumbnails SET sceneRevision=2 WHERE nodeId='previs-node' AND slot='k1'",
    "denied": "UPDATE cache.previs_thumbnails SET slot='k2' WHERE nodeId='previs-node' AND slot='k1'",
    "error": "previs thumbnails belong to the current scene"
  }
];

export function verifyTempGuardBehavior(triggers: readonly ConvertedTempTrigger[], tables: readonly ProbeTable[]): void {
  const probes = new Map(TEMP_GUARD_PROBES.map(probe => [probe.name, probe]));
  for (const trigger of triggers) if (!probes.has(trigger.name)) throw new Error(`Missing independent TEMP behavior probe ${trigger.name}`);
  const byName = new Map(triggers.map(trigger => [trigger.name, trigger]));
  for (const probe of TEMP_GUARD_PROBES) {
    const trigger = byName.get(probe.name);
    if (!trigger) throw new Error(`Missing TEMP trigger ${probe.name}`);
    const db = new DatabaseSync(':memory:');
    try {
      installRestoreScopeFunction(db);
      db.exec("ATTACH DATABASE ':memory:' AS project; ATTACH DATABASE ':memory:' AS cache");
      for (const table of tables) db.exec(`CREATE TABLE ${quote(table.schema)}.${quote(table.name)}(${table.columns.map(column => `${quote(column.name)} ${column.type}`).join(',')})`);
      for (const sql of probe.setup) db.exec(sql);
      db.exec(trigger.sql);
      db.exec(probe.allowed);
      const snapshot = (): string => JSON.stringify(tables.map(table => [table.schema, table.name,
        db.prepare(`SELECT * FROM ${quote(table.schema)}.${quote(table.name)} ORDER BY rowid`).all()]));
      const before = snapshot(), changes = db.prepare('SELECT total_changes() AS n').get()!.n;
      let caught: unknown;
      try { db.exec(probe.denied); } catch (error) { caught = error; }
      if (!(caught instanceof Error)) throw new Error(`TEMP trigger ${probe.name} accepted forbidden write`);
      if (caught.message !== probe.error || (caught as Error & {errcode?: number}).errcode !== 1811) throw new Error(`TEMP trigger ${probe.name} did not reject with its expected constraint`, {cause:caught});
      if (snapshot() !== before || db.prepare('SELECT total_changes() AS n').get()!.n !== changes) throw new Error(`TEMP trigger ${probe.name} changed rows while rejecting a write`);
    } finally { db.close(); }
  }
}
