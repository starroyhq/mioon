import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {captureProjectDocumentInside, canonicalJson, PROJECT_SNAPSHOT_TABLES, rowKey, validateProjectDocument} from '../packages/business/src/project-versions/document.ts';
import type {ProjectDocument, ProjectSnapshotTable, SnapshotRow} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan, previewDifferences, projectVersionDifferenceForDisplay} from '../packages/business/src/project-versions/preview.ts';
import {PROJECT_VERSION_DIFFERENCE_REASON_CODES, projectVersionDifferenceSchema} from '../packages/contracts/src/project-version-operations.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';

const now = '2026-11-03T00:00:00.000Z';
const secret = 'PRIVATE_PREVIEW_BODY_MUST_NOT_ESCAPE';
type Tables = Record<ProjectSnapshotTable, SnapshotRow[]>;
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'project-version-preview-')), store = openStore(path.join(root, 'project'));
  store.put('projects', {id: store.projectId, name: 'Saved project', revision: 1, updatedAt: now});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const capture = () => store.tx(() => captureProjectDocumentInside(store));
  const preview = (saved: ProjectDocument, current: ProjectDocument, boundary = 0, at = now) => store.tx(() => previewDifferences(store, saved, current, boundary, at));
  return {store, capture, preview};
}
function revise(doc: ProjectDocument, apply: (tables: Tables) => void): ProjectDocument {
  const result = structuredClone(doc); apply(result.tables as Tables);
  for (const table of PROJECT_SNAPSHOT_TABLES) (result.tables as Tables)[table].sort((a, b) => rowKey(table, a) < rowKey(table, b) ? -1 : rowKey(table, a) > rowKey(table, b) ? 1 : 0);
  return validateProjectDocument(result);
}
function fullDocument(base: ProjectDocument) {
  const projectId = base.projectId;
  const ids = Object.fromEntries(['asset','imageAsset','shot','node','edge','version','job','timeline','subject','subjectVersion','binding','group','imageVersion','imageTask','scene','sceneTask','lut'].map(key => [key, randomUUID()])) as Record<string, string>;
  const json = (value: Record<string, unknown>) => canonicalJson(value);
  const document = revise(base, tables => {
    tables.projects = [{id: projectId, data: json({id: projectId, name: 'Current project', note: secret})}];
    tables.assets = [ids.asset, ids.imageAsset].map(id => ({id, projectId, data: json({id, projectId, name: secret})}));
    tables.shots = [{id: ids.shot, projectId, data: json({id: ids.shot, projectId, title: secret, selectedVersionId: null, versionIds: [ids.version]})}];
    tables.nodes = [{id: ids.node, projectId, data: json({id: ids.node, projectId, type: 'note', text: secret})}];
    tables.edges = [{id: ids.edge, projectId, data: json({id: ids.edge, projectId, from: ids.node, to: ids.node})}];
    tables.versions = [{id: ids.version, projectId, jobId: ids.job, data: json({id: ids.version, projectId, jobId: ids.job, shotId: ids.shot, assetId: ids.asset})}];
    tables.timelines = [{id: ids.timeline, projectId, data: json({id: ids.timeline, projectId, clips: [], tracks: []})}];
    tables.asset_annotations = [{assetId: ids.asset, projectId, revision: 1, tags: '["tag"]', note: secret}];
    tables.asset_dispositions = [{assetId: ids.asset, projectId, revision: 1, disposition: 'favorite'}];
    tables.asset_ranges = [{assetId: ids.asset, projectId, revision: 1, inFrame: 0, outFrame: 30}];
    tables.subjects = [{id: ids.subject, projectId, kind: 'character', name: 'Subject', revision: 1, headVersionId: ids.subjectVersion, createdAt: now, updatedAt: now}];
    tables.subject_versions = [{id: ids.subjectVersion, projectId, subjectId: ids.subject, number: 1, assetId: ids.asset,
      data: json({id: ids.subjectVersion, projectId, subjectId: ids.subject, number: 1, assetId: ids.asset})}];
    tables.subject_bindings = [{id: ids.binding, projectId, shotId: ids.shot, subjectId: ids.subject, role: 'subject', revision: 1,
      subjectVersionId: ids.subjectVersion, reviewedHeadVersionId: ids.subjectVersion, createdAt: now, updatedAt: now}];
    tables.image_groups = [{id: ids.group, projectId, name: 'Images', revision: 1, headVersionId: ids.imageVersion, activeTaskId: null, createdAt: now, updatedAt: now}];
    tables.image_versions = [{id: ids.imageVersion, projectId, groupId: ids.group, taskId: ids.imageTask, number: 1, assetId: ids.imageAsset,
      data: json({id: ids.imageVersion, projectId, groupId: ids.group, taskId: ids.imageTask, number: 1, assetId: ids.imageAsset})}];
    tables.scene_results = [{id: ids.scene, projectId, assetId: ids.asset, position: 1, sourceHash: 'a'.repeat(64), origin: 'detected', taskId: ids.sceneTask,
      basedOnResultId: null, requestId: null, profileId: 'scene-profile', fps: 30, frameCount: 30, options: '{}', cuts: '[0]', createdAt: now}];
    tables.project_lut_resources = [{id: ids.lut, projectId, name: 'LUT', sha256: 'b'.repeat(64), sizeBytes: 1, profile: 'mioon-cube3d-normalized-tetrahedral-v1', metadata: '{}', content: {type: 'blob', base64: 'eA=='}, createdAt: now}];
  });
  return {ids, document};
}

test('all seventeen content tables produce complete stable DTOs without body/BLOB leakage or process writes', t => {
  const f = fixture(t), saved = f.capture(), {ids, document: current} = fullDocument(saved);
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  const differences = f.preview(saved, current);
  assert.deepEqual([...new Set(differences.map(row => row.table))].sort(), [...PROJECT_SNAPSHOT_TABLES].sort());
  assert.ok(differences.every(row => projectVersionDifferenceSchema.safeParse(row).success));
  assert.ok(differences.every(row => row.source === 'user-or-other'));
  assert.equal(JSON.stringify(differences).includes(secret), false);
  assert.equal(JSON.stringify(differences).includes('eA=='), false);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  const change = (table: ProjectSnapshotTable, id: string) => differences.find(row => row.table === table && row.key === rowKey(table, current.tables[table].find(item => item.id === id || item.assetId === id)!))!;
  for (const [table, id] of [['subject_versions',ids.subjectVersion],['image_versions',ids.imageVersion],['scene_results',ids.scene],['project_lut_resources',ids.lut],['image_groups',ids.group]] as const) assert.equal(change(table,id).action, 'keep-current');
  for (const [table, id] of [['subject_versions',ids.subjectVersion],['image_versions',ids.imageVersion],['scene_results',ids.scene],['project_lut_resources',ids.lut],['image_groups',ids.group]] as const) assert.equal(change(table,id).reasonCode, 'PROJECT_VERSION_PROTECTED_RESULT_CURRENT');
  assert.equal(change('subject_bindings',ids.binding).action, 'change'); assert.deepEqual(change('subject_bindings',ids.binding).fields, ['subjectVersionId']);
  assert.equal(change('asset_annotations',ids.asset).action, 'change'); assert.deepEqual(change('asset_annotations',ids.asset).fields, ['tags','note']);
  assert.equal(change('shots',ids.shot).action, 'keep-current', 'retained binding protects its shot owner');
  assert.equal(change('versions',ids.version).action, 'keep-current', 'the retained shot top-level versionIds protect its generated result');
  assert.equal(change('assets',ids.asset).action, 'keep-current');
  assert.equal(change('subject_bindings',ids.binding).reasonCode, 'PROJECT_VERSION_BINDING_TOMBSTONE_CURRENT');
  assert.equal(change('asset_annotations',ids.asset).reasonCode, 'PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT');
  assert.equal(change('shots',ids.shot).reasonCode, 'PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT');
  assert.equal(change('versions',ids.version).reasonCode, 'PROJECT_VERSION_CONTENT_REFERENCE_CURRENT');
  assert.equal(change('nodes',ids.node).action, 'remove'); assert.equal(change('edges',ids.edge).action, 'remove');
  assert.deepEqual(f.preview(saved,current), differences);
});

test('mutable row and JSON top-level revision/updatedAt evidence never becomes a restore difference', t => {
  const f = fixture(t), {document: saved} = fullDocument(f.capture());
  const protectedTables = new Set(['versions','subject_versions','image_versions','scene_results','project_lut_resources']);
  const current = revise(saved, tables => {for (const table of PROJECT_SNAPSHOT_TABLES) if (!protectedTables.has(table)) tables[table] = tables[table].map(row => {
    const copy = {...row}; if ('revision' in row) copy.revision = Number(row.revision)+1;
    if ('updatedAt' in row) copy.updatedAt = '2026-11-04T00:00:00.000Z';
    if (typeof row.data === 'string') copy.data = canonicalJson({...JSON.parse(row.data), revision: 100, updatedAt: '2026-11-05T00:00:00.000Z'});
    return copy;
  });});
  for (const table of PROJECT_SNAPSHOT_TABLES) if (protectedTables.has(table)) assert.deepEqual(current.tables[table],saved.tables[table]);
  assert.deepEqual(f.preview(saved,current), []);
});

test('missing current entities are added with true row keys and no synthetic tasks', t => {
  const f = fixture(t), current = f.capture(), {document: saved} = fullDocument(current);
  const changes = f.preview(saved,current);
  assert.ok(changes.filter(row=>row.table!=='projects').every(row=>row.action==='add'));
  for (const table of PROJECT_SNAPSHOT_TABLES) for (const row of saved.tables[table]) assert.ok(changes.some(change=>change.table===table&&change.key===rowKey(table,row)));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.jobs').get()?.n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.mio_changes').get()?.n, 0);
});

test('same-ID immutable payload conflicts reject the entire preview without modifying content', t => {
  const f = fixture(t), {document: saved} = fullDocument(f.capture());
  for (const table of ['versions','subject_versions','image_versions','scene_results','project_lut_resources'] as const) {
    const current = revise(saved, tables => {const row = {...tables[table][0]};
      if (typeof row.data==='string') row.data=canonicalJson({...JSON.parse(row.data), fixturePayload:'different'});
      else if(table==='scene_results') row.cuts='[0,10]';
      else row.content={type:'blob',base64:'eQ=='};
      tables[table]=[row];
    });
    assert.throws(()=>f.preview(saved,current),{code:'PROJECT_VERSION_IMMUTABLE_CONFLICT'});
  }
  const metadataOnly = revise(saved, tables => {const row={...tables.versions[0]};
    row.data=canonicalJson({...JSON.parse(String(row.data)),updatedAt:'2026-11-03T02:00:00.000Z'}); tables.versions=[row];});
  assert.throws(()=>f.preview(saved,metadataOnly),{code:'PROJECT_VERSION_IMMUTABLE_CONFLICT'},'immutable payload metadata cannot be silently ignored');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project.assets').get()?.n,0);
});

test('arbitrary parameters and user metadata with reference-like keys never protect unrelated owners', t => {
  const f = fixture(t), saved=f.capture(), {ids,document: full}=fullDocument(saved), freeAsset=randomUUID(), freeVersion=randomUUID(), freeNode=randomUUID();
  const current=revise(full,tables=>{
    for(const table of PROJECT_SNAPSHOT_TABLES)if(!['projects','assets','image_groups','image_versions'].includes(table))tables[table]=[];
    tables.assets=tables.assets.filter(row=>row.id===ids.imageAsset);
    tables.assets.push({id:freeAsset,projectId:saved.projectId,data:canonicalJson({id:freeAsset,projectId:saved.projectId})});
    tables.versions=[{id:freeVersion,projectId:saved.projectId,jobId:randomUUID(),data:canonicalJson({id:freeVersion,projectId:saved.projectId})}];
    tables.nodes=[{id:freeNode,projectId:saved.projectId,data:canonicalJson({id:freeNode,projectId:saved.projectId,type:'note',text:'plain'})}];
    const row=tables.image_versions[0]; tables.image_versions[0]={...row,data:canonicalJson({...JSON.parse(String(row.data)),parameters:{assetId:freeAsset,versionId:freeVersion},metadata:{sourceNodeId:freeNode}})};
  });
  const changes=f.preview(saved,current);
  for(const [table,id]of[['assets',freeAsset],['versions',freeVersion],['nodes',freeNode]]as const)assert.equal(changes.find(change=>change.table===table&&change.key===canonicalJson([id]))?.action,'remove');
  assert.equal(changes.find(change=>change.table==='assets'&&change.key===canonicalJson([ids.imageAsset]))?.action,'keep-current');
});

test('a real cross-file process reference protects its owner and the owners reached through its content', t => {
  const f=fixture(t),saved=f.capture(),projectId=f.store.projectId,nodeId=randomUUID(),assetId=randomUUID();
  const scene=defaultPrevisScene();scene.keyframes.push({id:'k1',name:'',camera:scene.camera,exports:[assetId]});
  const node={id:nodeId,projectId,type:'previs',text:'',scene,sceneRevision:1,revision:1};
  f.store.tx(()=>{
    f.store.put('assets',{id:assetId,projectId,name:secret});f.store.put('nodes',node);
    f.store.db.prepare('INSERT INTO main.previs_requests VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'previs.create',projectId,nodeId,1,'a'.repeat(64),JSON.stringify(node));
  });
  const current=f.capture(),before=f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
  const changes=f.preview(saved,current);
  assert.equal(changes.find(change=>change.table==='nodes')?.action,'keep-current');
  assert.match(changes.find(change=>change.table==='nodes')!.reason!,/previs_requests/);
  assert.equal(changes.find(change=>change.table==='nodes')?.reasonCode,'PROJECT_VERSION_PROCESS_REFERENCE_CURRENT');
  assert.equal(changes.find(change=>change.table==='assets')?.action,'keep-current','previs keyframe exported asset is a real domain reference');
  assert.equal(changes.find(change=>change.table==='assets')?.reasonCode,'PROJECT_VERSION_CONTENT_REFERENCE_CURRENT');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n,before);
});

function changeRecord(store:ProjectStore, targets:{kind:string;id:string;revision:number;revisionAfter?:number}[], options:{reverted?:boolean;at?:string;revertedAt?:string}={}) {
  const conversationId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),id=randomUUID(),at=options.at??now;
  store.tx(()=>{
    store.db.prepare('INSERT INTO main.mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)').run(conversationId,store.projectId,at,at);
    store.db.prepare("INSERT INTO main.mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,createdAt,updatedAt) VALUES(?,?,?,?,?,'completed',1,5,5,1,'zh-Hans',?,?)").run(runId,store.projectId,conversationId,randomUUID(),'a'.repeat(64),at,at);
    store.db.prepare("INSERT INTO main.mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt) VALUES(?,?,?,1,'tool','completed',?,?)").run(stepId,runId,store.projectId,at,at);
    store.db.prepare('INSERT INTO main.mio_changes(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(id,runId,stepId,store.projectId,JSON.stringify({id,runId,stepId,projectId:store.projectId,operation:'shot.update',targets,before:{},after:{},reversible:true,status:options.reverted?'reverted':'applied',createdAt:at,
      ...(options.reverted?{revertedAt:options.revertedAt??'2026-11-03T00:00:01.000Z',revertedTargets:targets.map(target=>({...target,revision:3,revisionAfter:3}))}:{})}));
  });
  return Number(store.db.prepare('SELECT rowid FROM main.mio_changes WHERE id=?').get(id)?.rowid);
}

test('Mio attribution follows new rowids and later undo evidence, including virtual project-level timeline targets',t=>{
  const f=fixture(t),{ids,document:base}=fullDocument(f.capture());
  // This pre-capture asset change is already represented by the captured
  // persistent target ledger, even though its rows are synthetic preview data.
  const evidence=structuredClone(base.evidence);
  (evidence.targetRevisions as SnapshotRow[]).push({projectId:base.projectId,kind:'asset',targetId:ids.asset,revision:1});
  (evidence.targetRevisions as SnapshotRow[]).sort((a,b)=>rowKey('agent_task_target_revisions_v2',a)<rowKey('agent_task_target_revisions_v2',b)?-1:1);
  const saved=validateProjectDocument({...base,evidence});
  const current=revise(saved,tables=>{
    for(const table of ['assets','shots','timelines']as const)tables[table]=tables[table].map(row=>({...row,data:canonicalJson({...JSON.parse(String(row.data)),fixtureValue:'changed'})}));
  });
  const old=changeRecord(f.store,[{kind:'asset',id:ids.asset,revision:1,revisionAfter:1}]);
  changeRecord(f.store,[{kind:'timeline',id:f.store.projectId,revision:1,revisionAfter:2}]);
  let changes=f.preview(saved,current,old);
  assert.equal(changes.find(change=>change.table==='timelines')?.source,'mio');
  assert.equal(changes.find(change=>change.table==='assets'&&change.key===canonicalJson([ids.asset]))?.source,'user-or-other');
  assert.equal(changes.find(change=>change.table==='shots')?.source,'user-or-other');
  const undo=changeRecord(f.store,[{kind:'asset',id:ids.asset,revision:1,revisionAfter:1}],{reverted:true});
  changes=f.preview(saved,current,undo);
  assert.equal(changes.find(change=>change.table==='assets'&&change.key===canonicalJson([ids.asset]))?.source,'mio','old row undone after snapshot remains attributable even below rowid boundary');
  assert.equal(changes.find(change=>change.table==='shots')?.source,'user-or-other');
});

test('timeline child targets and equal-time undo revision evidence retain accurate Mio labels',t=>{
  const f=fixture(t),{ids,document:base}=fullDocument(f.capture()),cueId=randomUUID();
  const saved=revise(base,tables=>{
    const row=tables.timelines[0];tables.timelines[0]={...row,data:canonicalJson({...JSON.parse(String(row.data)),subtitles:{cues:[{id:cueId,text:'old'}]}})};
  });
  const current=revise(saved,tables=>{
    const row=tables.timelines[0];tables.timelines[0]={...row,data:canonicalJson({...JSON.parse(String(row.data)),subtitles:{cues:[{id:cueId,text:'changed'}]}})};
    tables.assets=tables.assets.map(row=>({...row,data:canonicalJson({...JSON.parse(String(row.data)),name:'changed'})}));
  });
  const subtitle=changeRecord(f.store,[{kind:'timeline_subtitle',id:cueId,revision:1,revisionAfter:2}]);
  assert.equal(f.preview(saved,current,subtitle-1).find(row=>row.table==='timelines')?.source,'mio');
  const undo=changeRecord(f.store,[{kind:'asset',id:ids.asset,revision:1,revisionAfter:1}],{reverted:true,revertedAt:now});
  assert.equal(f.preview(saved,current,undo).find(row=>row.table==='assets'&&row.key===canonicalJson([ids.asset]))?.source,'mio','equal wall clock timestamps still have higher undo target revision evidence');
  const seen=structuredClone(saved);(seen.evidence.targetRevisions as SnapshotRow[]).push({projectId:saved.projectId,kind:'asset',targetId:ids.asset,revision:3});
  (seen.evidence.targetRevisions as SnapshotRow[]).sort((a,b)=>rowKey('agent_task_target_revisions_v2',a)<rowKey('agent_task_target_revisions_v2',b)?-1:1);
  assert.equal(f.preview(validateProjectDocument(seen),current,undo).find(row=>row.table==='assets'&&row.key===canonicalJson([ids.asset]))?.source,'user-or-other','an undo already captured by the ledger is not attributed as a later Mio edit');
});

test('forward-only image heads and prohibited variant subject heads are explicitly retained',t=>{
  const f=fixture(t),{ids,document:base}=fullDocument(f.capture()),imageAsset=randomUUID(),imageVersion=randomUUID(),subjectVersion=randomUUID();
  const saved=revise(base,tables=>{const row=tables.subject_versions[0];tables.subject_versions[0]={...row,data:canonicalJson({...JSON.parse(String(row.data)),variant:{kind:'pose'}})};});
  const current=revise(saved,tables=>{
    tables.assets.push({id:imageAsset,projectId:saved.projectId,data:canonicalJson({id:imageAsset,projectId:saved.projectId})});
    const prior=tables.image_versions[0],taskId=randomUUID();
    tables.image_versions.push({...prior,id:imageVersion,number:2,taskId,assetId:imageAsset,data:canonicalJson({id:imageVersion,projectId:saved.projectId,groupId:ids.group,taskId,number:2,assetId:imageAsset})});
    tables.image_groups[0]={...tables.image_groups[0],revision:2,headVersionId:imageVersion};
    tables.subject_versions.push({...tables.subject_versions[0],id:subjectVersion,number:2,data:canonicalJson({id:subjectVersion,projectId:saved.projectId,subjectId:ids.subject,number:2,assetId:ids.asset})});
    tables.subjects[0]={...tables.subjects[0],revision:2,headVersionId:subjectVersion};
  });
  const changes=f.preview(saved,current);
  assert.equal(changes.find(change=>change.table==='image_groups')?.action,'keep-current');
  assert.match(changes.find(change=>change.table==='image_groups')!.reason!,/只能向前/);
  assert.equal(changes.find(change=>change.table==='image_groups')?.reasonCode,'PROJECT_VERSION_IMAGE_GROUP_FORWARD_ONLY');
  assert.equal(changes.find(change=>change.table==='subjects')?.action,'keep-current');
  assert.match(changes.find(change=>change.table==='subjects')!.reason!,/变体过程/);
  assert.equal(changes.find(change=>change.table==='subjects')?.reasonCode,'PROJECT_VERSION_SUBJECT_VARIANT_HEAD');
  assert.equal(changes.find(change=>change.table==='image_versions')?.action,'keep-current');
});

test('retained identities that conflict with snapshot uniqueness reject the whole plan',t=>{
  const f=fixture(t),{document:saved}=fullDocument(f.capture());
  const current=revise(saved,tables=>{tables.subject_bindings[0]={...tables.subject_bindings[0],id:randomUUID()};});
  assert.throws(()=>f.preview(saved,current),{code:'PROJECT_VERSION_DEPENDENCY_CONFLICT'});
});

test('complete row keys remain collision-free and all differences beyond one page survive',t=>{
  const f=fixture(t),saved=f.capture(),prefix='identity-'.repeat(40);
  const current=revise(saved,tables=>{tables.nodes=Array.from({length:250},(_,index)=>{
    const id=index<2?prefix+index:randomUUID();return{id,projectId:saved.projectId,data:canonicalJson({id,projectId:saved.projectId,type:'note',text:secret})};
  });});
  const changes=f.preview(saved,current);
  assert.equal(changes.length,250);assert.equal(new Set(changes.map(change=>change.key)).size,250);
  assert.ok(changes.some(change=>change.key===canonicalJson([prefix+'0'])));
  assert.ok(changes.some(change=>change.key===canonicalJson([prefix+'1'])));
  assert.equal(JSON.stringify(changes).includes(secret),false);
  const oversized=revise(saved,tables=>{const id='x'.repeat(5000);tables.nodes=[{id,projectId:saved.projectId,data:canonicalJson({id,projectId:saved.projectId,type:'note'})}];});
  assert.throws(()=>f.preview(saved,oversized),{code:'PROJECT_VERSION_PREVIEW_LIMIT'});
});

test('Mio process-only changes and retained default tombstones do not invent content rewinds',t=>{
  const f=fixture(t),saved=f.capture();
  changeRecord(f.store,[{kind:'project',id:f.store.projectId,revision:1,revisionAfter:2}]);
  assert.deepEqual(f.preview(saved,f.capture()),[]);
  const {document:full}=fullDocument(saved),current=revise(full,tables=>{
    tables.asset_annotations[0]={...tables.asset_annotations[0],tags:'[]',note:''};
    tables.subject_bindings[0]={...tables.subject_bindings[0],subjectVersionId:null};
  });
  const changes=f.preview(saved,current);
  for(const table of ['asset_annotations','subject_bindings']as const){
    const change=changes.find(row=>row.table===table)!;assert.equal(change.action,'keep-current');assert.deepEqual(change.fields,[]);assert.ok(change.reason);
  }
});

test('display reason metadata leaves the raw plan unchanged and historical human reasons are never reclassified', t => {
  const f=fixture(t),saved=f.capture(),{document:current}=fullDocument(saved);
  const plan=f.store.tx(()=>buildRestorePlan(f.store,saved,current,0,now)),raw=JSON.stringify(plan.changes);
  const displayed=plan.changes.map(projectVersionDifferenceForDisplay);
  assert.ok(displayed.some(row=>row.reasonCode==='PROJECT_VERSION_PROTECTED_RESULT_CURRENT'));
  assert.ok(displayed.every(row=>row.reason===null?row.reasonCode===undefined:PROJECT_VERSION_DIFFERENCE_REASON_CODES.includes(row.reasonCode as typeof PROJECT_VERSION_DIFFERENCE_REASON_CODES[number])));
  assert.equal(JSON.stringify(displayed.map(({reasonCode:_reasonCode,...row})=>row)),raw);
  assert.equal(JSON.stringify(plan.changes),raw);
  assert.ok(plan.changes.every(row=>!Object.hasOwn(row,'reasonCode')));
  const legacy={...displayed.find(row=>row.reasonCode==='PROJECT_VERSION_PROTECTED_RESULT_CURRENT')!};delete legacy.reasonCode;
  assert.equal(projectVersionDifferenceForDisplay(legacy),legacy);
  assert.equal(Object.hasOwn(projectVersionDifferenceForDisplay(legacy),'reasonCode'),false);
  assert.equal(projectVersionDifferenceSchema.safeParse(legacy).success,true);
  assert.equal(projectVersionDifferenceSchema.safeParse({...legacy,reasonCode:'PROJECT_VERSION_FUTURE_REASON'}).success,true);
  for(const reasonCode of ['',null,123,'PRIVATE chinese 原因','PROJECT_VERSION_'+ 'A'.repeat(97),'PROJECT_VERSION_REASON\n'])
    assert.equal(projectVersionDifferenceSchema.safeParse({...legacy,reasonCode}).success,false);
});

test('readded image groups omit old active tasks and expose only their stable display reason', t => {
  const f=fixture(t),current=f.capture(),{document}=fullDocument(current);
  const saved=revise(document,tables=>{tables.image_groups[0]={...tables.image_groups[0],activeTaskId:randomUUID()};});
  const changes=f.preview(saved,current),group=changes.find(row=>row.table==='image_groups')!;
  assert.equal(group.action,'add');assert.equal(group.reasonCode,'PROJECT_VERSION_IMAGE_GROUP_TASK_NOT_REPLAYED');
  assert.match(group.reason!,/不重建或重放本机活动任务/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.image_tasks').get()?.n,0);
});
