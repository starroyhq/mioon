import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createSequenceInspectionService} from '../packages/business/src/format5-sequence-inspection.ts';
import {agentTaskToolCatalogProfile, FORMAT5_UNAVAILABLE_OPERATIONS} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {createAgentTaskTools, listAgentTaskTools, listAgentTaskToolsForChannel} from '../packages/business/src/agent/task-tools-v2.ts';
import {sequenceInspectionSchemas} from '../packages/contracts/src/sequence-inspection.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {operationEffects} from '../packages/contracts/src/operation-effects.ts';
import {TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {mediaReferenceFixture} from './helpers/media-reference-fixtures.ts';
import {createHash} from 'node:crypto';

const at = '2026-01-01T00:00:00.000Z';
const id = (n: number): string => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), root = id(2), shotA = id(3), shotB = id(4), image = id(5), video = id(60), audio = id(61);
const assetA = id(10), imageAsset = id(11), versionA = id(20), clipA = id(30), clipB = id(31), imageClip = id(32);
const groupA = id(40), groupB = id(41), groupImage = id(42), timelineId = id(50);
const image2 = id(6), subjectId = id(90), subjectVersion = id(91);
const sha = (letter: string): string => letter.repeat(64);

export function fixture(t: test.TestContext): ProjectStore {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mt-read-'));
  const store = createProjectStore({projectId, projectFile: path.join(rootDir, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(rootDir, 'records'), cacheDir: path.join(rootDir, 'cache'), tempDir: path.join(rootDir, 'temp')})});
  t.after(() => {store.close(); rmSync(rootDir, {recursive: true, force: true});});
  const mediaBytes = Buffer.from('format5-mio-fixture-media');
  const mediaSha = createHash('sha256').update(mediaBytes).digest('hex');
  mkdirSync(path.join(rootDir, 'media'), {recursive: true});
  writeFileSync(path.join(rootDir, 'media/a.mp4'), mediaBytes);
  writeFileSync(path.join(rootDir, 'media/i.png'), mediaBytes);
  const mediaRef = mediaReferenceFixture('media/a.mp4', mediaBytes.length, mediaSha);
  const imageRef = mediaReferenceFixture('media/i.png', mediaBytes.length, mediaSha);
  const node = (nodeId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({id: nodeId, projectId, type, position: {x: 0, y: 0}, createdAt: at, ...extra});
  const tracks = [{id: video, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
    {id: audio, name: 'A1', kind: 'audio', orderIndex: 1, hidden: false, muted: false}];
  const clips = [
    {id: clipA, trackId: video, name: 'A', startFrame: 0, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: assetA, versionId: versionA, shotId: shotA,
      sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotA, segmentGroupId: groupA, versionMode: 'follow'}},
    {id: clipB, trackId: video, name: 'B', startFrame: 30, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: null, versionId: null, jobId: null,
      sourceState: 'placeholder', sequenceSource: {kind: 'shot', nodeId: shotB, segmentGroupId: groupB, versionMode: 'follow'}},
    {id: imageClip, trackId: video, name: 'Image', startFrame: 60, durationFrames: 30, sourceInFrame: 0,
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId: imageAsset, sourceState: 'ready',
      sequenceSource: {kind: 'media', nodeId: image, segmentGroupId: groupImage}},
  ];
  const timeline = {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 90,
    createdAt: at, updatedAt: at, mainTrack: {trackId: video, sequenceNodeId: root}, tracks, clips};
  const baseline = {version: 1, board: [{nodeId: shotA, kind: 'shot', selectedVersionId: versionA},
    {nodeId: shotB, kind: 'shot', selectedVersionId: null}, {nodeId: image, kind: 'media', assetId: imageAsset}],
    track: [{nodeId: shotA, segmentGroupId: groupA, clipId: clipA, kind: 'shot', versionMode: 'follow', appliedVersionId: versionA},
      {nodeId: shotB, segmentGroupId: groupB, clipId: clipB, kind: 'shot', versionMode: 'follow', appliedVersionId: null},
      {nodeId: image, segmentGroupId: groupImage, clipId: imageClip, kind: 'media', assetId: imageAsset}]};
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'MT read fixture', createdAt: at, updatedAt: at, revision: 1});
    store.put('assets', {id: assetA, projectId, name: 'a.mp4', mimeType: 'video/mp4', duration: 2, sha256: mediaSha,
      sizeBytes: mediaBytes.length, reference: mediaRef, referenceRevision: 1});
    store.put('assets', {id: imageAsset, projectId, name: 'i.png', mimeType: 'image/png', duration: null, sha256: mediaSha,
      sizeBytes: mediaBytes.length, reference: imageRef, referenceRevision: 1});
    store.put('jobs', {id: id(71), projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: shotA,
      versionId: versionA, createdAt: at, updatedAt: at});
    store.put('versions', {id: versionA, projectId, jobId: id(71), shotId: shotA, number: 1, assetId: assetA, sha256: mediaSha, createdAt: at});
    store.put('shots', {id: shotA, projectId, title: '镜头 A', orderIndex: 0, selectedVersionId: versionA, duration: 2, revision: 1, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotB, projectId, title: '镜头 B', orderIndex: 1, selectedVersionId: null, duration: 1, revision: 1, createdAt: at, updatedAt: at});
    store.put('nodes', node(root, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(image, 'image', {assetId: imageAsset}));
    // MT-5: a second material source and a subject for the new bounded actions.
    store.put('nodes', node(image2, 'image', {assetId: imageAsset, position: {x: 600, y: 0}}));
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(subjectId, projectId, 'character', '阿琦', 1, subjectVersion, at, at);
    store.db.prepare(`INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)`)
      .run(subjectVersion, projectId, subjectId, 1, imageAsset, JSON.stringify({id: subjectVersion, projectId,
        subjectId, number: 1, assetId: imageAsset, sha256: mediaSha, mimeType: 'image/png', width: 1080,
        height: 1920, createdAt: at, provenance: {kind: 'user-import', versionId: null, shotId: null, jobId: null}}));
    store.put('edges', {id: id(80), projectId, kind: 'sequence', source: root, target: shotA, createdAt: at});
    store.put('edges', {id: id(81), projectId, kind: 'sequence', source: shotA, target: shotB, createdAt: at});
    store.put('edges', {id: id(82), projectId, kind: 'sequence', source: shotB, target: image, createdAt: at});
    store.put('timelines', timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, root, 1, JSON.stringify(baseline));
  });
  return store;
}

import {previewMioSequenceAction, commitMioSequenceAction, prepareMioSequenceUndo, applyMioSequenceUndo} from '../packages/business/src/format5-mio-sequence.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {readSequenceEditHistory} from '../packages/business/src/sequence-edit.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import {mioSequenceEditSchemas} from '../packages/contracts/src/mio-sequence.ts';
import {defaultPrevisScene, PREVIS_SCENE_SCHEMA_VERSION} from '../packages/contracts/src/previs.ts';
import {MIO_DEFERRED_OPERATIONS} from '../packages/business/src/agent/task-operation-parity-v2.ts';

type LiveEdge = {id: string; data: Record<string, any>};
const liveEdges = (store: ProjectStore): LiveEdge[] => store.db.prepare(
  "SELECT id,data FROM project.edges WHERE projectId=? AND archivedAt IS NULL").all(projectId)
  .flatMap((row: any) => { try { return [{id: String(row.id), data: JSON.parse(String(row.data))}]; } catch { return []; } });
const materialEdges = (store: ProjectStore, shotId: string): LiveEdge[] => liveEdges(store)
  .filter(edge => edge.data.kind === 'reference' && edge.data.target === shotId
    && typeof edge.data.sourceAssetId === 'string')
  .sort((left, right) => Number(left.data.orderIndex ?? 0) - Number(right.data.orderIndex ?? 0));
const cardCount = (store: ProjectStore): number => store.db.prepare(`SELECT count(*) AS n FROM project.nodes
  WHERE projectId=? AND archivedAt IS NULL AND json_valid(data) AND json_extract(data,'$.type')='subject_card'`)
  .get(projectId)!.n as number;
const previsNode = (store: ProjectStore) => store.db.prepare(`SELECT id,data FROM project.nodes
  WHERE projectId=? AND archivedAt IS NULL AND json_valid(data) AND json_extract(data,'$.type')='previs'`)
  .all(projectId).flatMap((row: any) => { try { return [{id: String(row.id), value: JSON.parse(String(row.data))}]; } catch { return []; } });

const req=(n:number)=>`mt-write-request-${String(n).padStart(4,'0')}`;

test('Mio write actions preview and commit the server-built envelope with origin mio', t => {
  const store=fixture(t);
  const plan=previewMioSequenceAction(store,projectId,req(1),{kind:'disconnect',fromId:shotB,toId:image});
  assert.equal(plan.envelope.origin,'mio');
  assert.equal(plan.envelope.originSide,'board');
  assert.ok(plan.planDigest.length===64);
  assert.ok(plan.summary.affected.length>=1);
  const receipt=commitMioSequenceAction(store,plan);
  assert.equal(receipt.status,'applied');
  assert.equal(receipt.projectId,projectId);
  const history=readSequenceEditHistory(store,'mio');
  assert.equal(history.undo?.actionId,receipt.actionId);
  assert.equal(history.undo?.origin,'mio');
  // D5: Mio undo addresses its own action only while it is the cursor top.
  const undo=prepareMioSequenceUndo(store,projectId,req(2),receipt.actionId);
  const undone=applyMioSequenceUndo(store,undo);
  assert.equal(undone.status,'applied');
  assert.equal(readSequenceEditHistory(store,'mio').undo,null);
});

test('Mio puts one library asset into the main track with server-expanded ids and one undo step', t => {
  const store = fixture(t);
  const clipsBefore = store.db.prepare('SELECT count(*) AS n FROM project.timeline_clips').get()!.n as number;
  const nodesBefore = store.db.prepare('SELECT count(*) AS n FROM project.nodes WHERE projectId=? AND archivedAt IS NULL').get(projectId)!.n as number;
  const plan = previewMioSequenceAction(store, projectId, req(20), {kind: 'insert-asset', assetId: imageAsset, trackId: video, startFrame: 0});
  assert.equal(plan.envelope.origin, 'mio');
  assert.equal(plan.envelope.intents[0]!.operation.kind, 'track');
  const edit = (plan.envelope.intents[0]!.operation as {kind: 'track'; edit: {kind: string; nodeAssetId?: string}}).edit;
  assert.equal(edit.kind, 'add');
  assert.equal(edit.nodeAssetId, imageAsset);
  assert.ok(plan.envelope.allocation.clips.length >= 1, 'server allocates the node and clip ids');
  const receipt = commitMioSequenceAction(store, plan);
  assert.equal(receipt.status, 'applied');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.timeline_clips').get()!.n as number, clipsBefore + 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.nodes WHERE projectId=? AND archivedAt IS NULL').get(projectId)!.n as number, nodesBefore + 1);
  assert.equal(readSequenceEditHistory(store, 'mio').undo?.operation, 'timeline.clip.add');
  const undo = prepareMioSequenceUndo(store, projectId, req(21), receipt.actionId);
  assert.equal(applyMioSequenceUndo(store, undo).status, 'applied');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.timeline_clips').get()!.n as number, clipsBefore);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project.nodes WHERE projectId=? AND archivedAt IS NULL').get(projectId)!.n as number, nodesBefore);
});

test('Mio undo refuses a user-origin action and a stale cursor', t => {
  const store=fixture(t);
  const service=createFormat5SequenceEditService(store);
  const preview=service.preview({projectId,requestId:req(3),origin:'user',
    intents:[sequenceSyncIntent({kind:'clip-version',clipId:clipA,versionId:versionA,mode:'locked'})]}) as any;
  const receipt=service.commit({projectId,envelope:preview.envelope,expectedPlanDigest:preview.planDigest}) as any;
  assert.equal(receipt.status,'applied');
  assert.throws(()=>prepareMioSequenceUndo(store,projectId,req(4),receipt.actionId),{code:'SEQUENCE_EDIT_HISTORY_CONFLICT'});
});

test('split action allocates the right clip server-side and reports bounded impact', t => {
  const store=fixture(t);
  const plan=previewMioSequenceAction(store,projectId,req(5),{kind:'split',clipId:clipA,offsetFrames:10});
  assert.equal(plan.envelope.origin,'mio');
  assert.equal((plan.envelope as any).intents.length,1);
  assert.ok(plan.summary.counts.clips>=1);
  assert.ok(!JSON.stringify(plan.summary).includes('envelope'));
});

test('FR-A clip properties are opened as a Mio action through the same envelope', t => {
  const store=fixture(t);
  const plan=previewMioSequenceAction(store,projectId,req(6),{kind:'clip-properties',
    edits:[{clipId:clipA,patch:{name:'Mio 属性改名'}}]});
  assert.equal(plan.envelope.origin,'mio');
  assert.equal((plan.envelope as any).propertiesIntent.operation.kind,'clip-properties');
  assert.equal(plan.summary.counts.clips,1);
  const receipt=commitMioSequenceAction(store,plan);
  assert.equal(receipt.status,'applied');
  const timeline=store.get('timelines',timelineId) as any;
  assert.equal(timeline.clips.find((clip: any)=>clip.id===clipA).name,'Mio 属性改名');
  assert.equal(readSequenceEditHistory(store,'mio').undo?.origin,'mio');
  const undone=applyMioSequenceUndo(store,prepareMioSequenceUndo(store,projectId,req(7),receipt.actionId));
  assert.equal(undone.status,'applied');
  assert.equal((store.get('timelines',timelineId) as any).clips.find((clip: any)=>clip.id===clipA).name,'A');
});

test('D5: user undo sees the Mio stack as blocked and Mio undo cannot cross a user action', t => {
  const store=fixture(t);
  const service=createFormat5SequenceEditService(store);
  const userFirst=service.preview({projectId,requestId:req(20),origin:'user',
    propertiesIntent:{side:'timeline',operation:{kind:'clip-properties',edits:[{clipId:clipA,patch:{name:'User below'}}]}}}) as any;
  const userFirstReceipt=service.commit({projectId,envelope:userFirst.envelope,expectedPlanDigest:userFirst.planDigest}) as any;
  const mioPlan=previewMioSequenceAction(store,projectId,req(21),{kind:'set-mode',clipId:clipA,mode:'locked',versionId:versionA});
  const mioReceipt=commitMioSequenceAction(store,mioPlan);
  const userView=readSequenceEditHistory(store,'user');
  assert.equal(userView.undo?.actionId,userFirstReceipt.actionId);
  assert.equal(userView.undoBlockedBy,'mio');
  assert.throws(()=>service.undo({projectId,requestId:req(22),actionId:userFirstReceipt.actionId,
    expected:{position:userView.position,revision:userView.revision},origin:'user'}),
  {code:'SEQUENCE_EDIT_HISTORY_CONFLICT'});
  const mioView=readSequenceEditHistory(store,'mio');
  assert.equal(mioView.undo?.actionId,mioReceipt.actionId);
  assert.equal(mioView.undoBlockedBy,null);
  // A real user action above the Mio action makes the user stack top again,
  // while the Mio stack is now blocked by a later user action.
  const userTopPreview=service.preview({projectId,requestId:req(23),origin:'user',
    propertiesIntent:{side:'timeline',operation:{kind:'clip-properties',edits:[{clipId:clipA,patch:{name:'User above'}}]}}}) as any;
  service.commit({projectId,envelope:userTopPreview.envelope,expectedPlanDigest:userTopPreview.planDigest});
  const blockedMio=readSequenceEditHistory(store,'mio');
  assert.equal(blockedMio.undoBlockedBy,'user');
  assert.throws(()=>prepareMioSequenceUndo(store,projectId,req(24),mioReceipt.actionId),{code:'SEQUENCE_EDIT_HISTORY_CONFLICT'});
  const userTop=readSequenceEditHistory(store,'user');
  assert.equal(userTop.undoBlockedBy,null);
  assert.equal(userTop.undo?.origin,undefined);
});

test('MT-4 board actions are bounded server-side previews and commits', t => {
  const store=fixture(t);
  const beforeShots=(store.db.prepare('SELECT count(*) AS n FROM project.shots').get() as {n:number}).n;
  const append=previewMioSequenceAction(store,projectId,req(30),{kind:'board-shot-append',name:'Appended shot'});
  assert.equal(append.envelope.origin,'mio');
  const appendReceipt=commitMioSequenceAction(store,append);
  assert.equal(appendReceipt.status,'applied');
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM project.shots').get() as {n:number}).n,beforeShots+1);
  const layout=previewMioSequenceAction(store,projectId,req(31),{kind:'board-layout-move',
    moves:[{nodeId:shotA,x:123,y:456}]});
  assert.equal(commitMioSequenceAction(store,layout).status,'applied');
  assert.deepEqual((store.get('shots',shotA) as any).position,{x:123,y:456});
  const tools=listAgentTaskTools(false,true);
  assert.equal(tools.find(tool=>tool.operation==='sequence.board.get')?.name,'mioon_sequence_board_get');
});

test('FR-B2 format change freezes layouts, commits one step and undoes the header', t => {
  const store=fixture(t);
  store.put('timelines',{...(store.get('timelines',timelineId) as any),subtitles:{profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues:[]}});
  assert.throws(()=>previewMioSequenceAction(store,projectId,req(39),{kind:'format-set',presetId:'portrait_1080'}),
    {code:'TIMELINE_FORMAT_TIER_MISMATCH'});
  const plan=previewMioSequenceAction(store,projectId,req(40),{kind:'format-set',presetId:'landscape_720'});
  assert.equal(plan.envelope.origin,'mio');
  assert.equal((plan.envelope as any).formatIntent.operation.presetId,'landscape_720');
  const before=store.get('timelines',timelineId) as any;
  assert.equal(before.width,720); assert.equal(before.height,1280);
  assert.ok(before.clips.every((clip:any)=>clip.layout===undefined));
  const receipt=commitMioSequenceAction(store,plan);
  assert.equal(receipt.status,'applied');
  const replay=commitMioSequenceAction(store,plan);
  assert.equal(replay.status,'applied');
  assert.equal(replay.actionId,receipt.actionId);
  assert.equal((store.get('timelines',timelineId) as any).revision,receipt.timelineRevision);
  const after=store.get('timelines',timelineId) as any;
  assert.equal(after.width,1280); assert.equal(after.height,720);
  assert.equal(after.subtitles.profileId,TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID);
  assert.equal(after.subtitles.basisPresetId,'portrait_720');
  assert.ok(after.clips.every((clip:any)=>clip.layout?.basisPresetId==='portrait_720'));
  // User stack can undo the Mio format action only after it is the top Mio action.
  const view=readSequenceEditHistory(store,'mio');
  assert.equal(view.undoBlockedBy,null);
  assert.equal(applyMioSequenceUndo(store,prepareMioSequenceUndo(store,projectId,req(41))).status,'applied');
  const restored=store.get('timelines',timelineId) as any;
  assert.equal(restored.width,720); assert.equal(restored.height,1280);
  assert.equal(restored.subtitles.profileId,TIMELINE_SUBTITLE_PROFILE_ID);
  assert.ok(restored.clips.every((clip:any)=>clip.layout===undefined));
  assert.throws(()=>previewMioSequenceAction(store,projectId,req(42),{kind:'format-set',presetId:'portrait_720'}),
    {code:'SEQUENCE_EDIT_NOOP'});
});

test('MT-5 subtitles preview, commit and one-step undo through the unified entry', t => {
  const store=fixture(t);
  const plan=previewMioSequenceAction(store,projectId,req(60),{kind:'subtitles',
    edits:[{kind:'add',cue:{text:'字幕一',startFrame:0,durationFrames:10}}]});
  assert.equal(plan.envelope.origin,'mio');
  const receipt=commitMioSequenceAction(store,plan);
  assert.equal(receipt.status,'applied');
  const changed=store.get('timelines',timelineId) as any;
  assert.equal(changed.subtitles?.cues.length,1);
  assert.equal(changed.subtitles.cues[0].text,'字幕一');
  const undone=applyMioSequenceUndo(store,prepareMioSequenceUndo(store,projectId,req(61)));
  assert.equal(undone.status,'applied');
  assert.equal((store.get('timelines',timelineId) as any).subtitles?.cues.length ?? 0,0);
});

test('write actions are bounded and reject generated ids supplied as envelopes', () => {
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'connect',fromId:projectId,toId:root}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'connect',fromId:projectId,toId:root,envelope:{}}).success,false);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'split',clipId:projectId,offsetFrames:0}).success,false);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-shot-append',name:'New shot'}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-layout-move',moves:[{nodeId:projectId,x:1,y:2}]}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-layout-move',moves:[{nodeId:projectId,x:1_000_001,y:2}]}).success,false);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'split-at-scenes',assetId:projectId,resultId:projectId}).success,true);
  const tools=listAgentTaskTools(false,true);
  assert.ok(tools.some(tool=>tool.operation==='sequence.tool.edit'&&tool.risk==='local_reversible'));
  assert.ok(tools.some(tool=>tool.operation==='sequence.tool.undo'));
  assert.equal(agentTaskToolCatalogProfile(tools),'format5');
  assert.equal(listAgentTaskTools(false,false).some(tool=>tool.operation==='sequence.tool.edit'),false);
});

test('Mio dialogue action writes the shot lines and projects their cues in one Mio step', t => {
  const store=fixture(t);
  const plan=previewMioSequenceAction(store,projectId,req(8),{kind:'dialogue',shotId:shotA,edits:[
    {kind:'add',text:'你好'},{kind:'add',text:'走吧'}]});
  assert.equal(plan.envelope.origin,'mio');
  const intent=(plan.envelope as any).dialogueIntent;
  assert.equal(intent.operation.kind,'dialogue');
  assert.equal(intent.operation.edits.length,2);
  assert.ok(intent.operation.edits.every((edit:any)=>typeof edit.line.id==='string'),'the service allocates new line ids');
  assert.ok(plan.summary.counts.other>=2,'the projected cues show up in the bounded impact');
  const receipt=commitMioSequenceAction(store,plan);
  assert.equal(receipt.status,'applied');
  let shot=store.get('shots',shotA) as any;
  assert.deepEqual(shot.dialogue.map((line:any)=>line.text),['你好','走吧']);
  const projected=()=>((store.get('timelines',timelineId) as any).subtitles?.cues??[])
    .filter((cue:any)=>cue.dialogueRef?.shotId===shotA);
  assert.equal(projected().length,2,'each line projects to a real cue');
  // Update one line through its inspected id: the cue text follows.
  const update=previewMioSequenceAction(store,projectId,req(9),{kind:'dialogue',shotId:shotA,
    edits:[{kind:'update',lineId:shot.dialogue[0].id,text:'你好啊'}]});
  commitMioSequenceAction(store,update);
  shot=store.get('shots',shotA) as any;
  assert.deepEqual(shot.dialogue.map((line:any)=>line.text),['你好啊','走吧']);
  assert.equal((projected().find((cue:any)=>cue.dialogueRef.lineId===shot.dialogue[0].id) as any).text,'你好啊');
  // Reorder through the inspected ids.
  const reorder=previewMioSequenceAction(store,projectId,req(10),{kind:'dialogue',shotId:shotA,
    edits:[{kind:'reorder',lineIds:[shot.dialogue[1].id,shot.dialogue[0].id]}]});
  commitMioSequenceAction(store,reorder);
  shot=store.get('shots',shotA) as any;
  assert.deepEqual(shot.dialogue.map((line:any)=>line.text),['走吧','你好啊']);
  // One Mio undo restores the shot lines and their cues.
  const undone=applyMioSequenceUndo(store,prepareMioSequenceUndo(store,projectId,req(11)));
  assert.equal(undone.status,'applied');
  shot=store.get('shots',shotA) as any;
  assert.deepEqual(shot.dialogue.map((line:any)=>line.text),['你好啊','走吧']);
  // Removing a line removes its cue; the reader exposes the remaining lines.
  const remove=previewMioSequenceAction(store,projectId,req(12),{kind:'dialogue',shotId:shotA,
    edits:[{kind:'remove',lineId:shot.dialogue[0].id}]});
  commitMioSequenceAction(store,remove);
  shot=store.get('shots',shotA) as any;
  assert.deepEqual(shot.dialogue.map((line:any)=>line.text),['走吧']);
  assert.equal(projected().length,1);
  const page=createSequenceInspectionService(store).handlers['sequence.inspect']({projectId}) as any;
  const segment=page.items.find((item:any)=>item.nodeId===shotA);
  assert.deepEqual(segment.dialogue.map((line:any)=>line.text),['走吧']);
});

test('Mio dialogue schema is bounded and refuses generated envelope fields', () => {
  const parse=(input:unknown)=>mioSequenceEditSchemas['sequence.tool.edit'].safeParse(input).success;
  assert.equal(parse({kind:'dialogue',shotId:projectId,edits:[{kind:'add',text:'你好'}]}),true);
  assert.equal(parse({kind:'dialogue',shotId:projectId,edits:[{kind:'add',text:'你好',lineId:projectId}]}),false);
  assert.equal(parse({kind:'dialogue',shotId:projectId,edits:[{kind:'add',text:'字'.repeat(82)}]}),false);
  assert.equal(parse({kind:'dialogue',shotId:projectId,edits:[{kind:'update',lineId:projectId}]}),false);
  assert.equal(parse({kind:'dialogue',shotId:projectId,edits:[]}),false);
});

test('MT-5 reference reorder sets the primary image as one Mio action and undoes it', t => {
  const store = fixture(t);
  for (const [index, source] of [image, image2].entries()) {
    const plan = previewMioSequenceAction(store, projectId, req(40 + index), {kind: 'reference-attach',
      sourceNodeId: source, shotId: shotA, role: 'reference_image'});
    assert.equal(commitMioSequenceAction(store, plan).status, 'applied');
  }
  const attached = materialEdges(store, shotA);
  assert.equal(attached.length, 2);
  assert.deepEqual(attached.map(edge => edge.data.orderIndex), [0, 1]);
  const reversed = [...attached].reverse().map(edge => edge.id);
  const plan = previewMioSequenceAction(store, projectId, req(42), {kind: 'reference-reorder',
    shotId: shotA, edgeIds: reversed});
  assert.equal(plan.envelope.origin, 'mio');
  const receipt = commitMioSequenceAction(store, plan);
  assert.equal(receipt.status, 'applied');
  assert.deepEqual(materialEdges(store, shotA).map(edge => edge.id), reversed);
  assert.equal(readSequenceEditHistory(store, 'mio').undo?.origin, 'mio');
  applyMioSequenceUndo(store, prepareMioSequenceUndo(store, projectId, req(43), receipt.actionId));
  assert.deepEqual(materialEdges(store, shotA).map(edge => edge.id), attached.map(edge => edge.id));
  // A stale list (missing one current line) is rejected instead of reordered.
  assert.throws(() => previewMioSequenceAction(store, projectId, req(44), {kind: 'reference-reorder',
    shotId: shotA, edgeIds: [attached[0]!.id]}), {code: 'SEQUENCE_EDIT_REFERENCE_INVALID'});
  assert.throws(() => previewMioSequenceAction(store, projectId, req(45), {kind: 'reference-reorder',
    shotId: shotA, edgeIds: [attached[0]!.id, attached[0]!.id]}), {code: 'SEQUENCE_EDIT_REFERENCE_INVALID'});
});

test('MT-5 subject card create, bind, lock and delete ride Mio actions', t => {
  const store = fixture(t);
  const create = previewMioSequenceAction(store, projectId, req(46), {kind: 'subject-card-create', subjectId});
  assert.equal(create.envelope.origin, 'mio');
  assert.equal(commitMioSequenceAction(store, create).status, 'applied');
  const card = store.db.prepare(`SELECT id,data FROM project.nodes WHERE projectId=? AND archivedAt IS NULL
    AND json_valid(data) AND json_extract(data,'$.type')='subject_card'`).get(projectId) as any;
  assert.ok(card);
  const cardData = JSON.parse(String(card.data));
  assert.equal(cardData.subjectId, subjectId);
  assert.deepEqual(cardData.position, {x: 940, y: 120});
  assert.equal(cardCount(store), 1);
  const binding = previewMioSequenceAction(store, projectId, req(47), {kind: 'subject-binding',
    edit: {kind: 'create', shotId: shotA, subjectId, role: 'subject'}});
  assert.equal(commitMioSequenceAction(store, binding).status, 'applied');
  const locked = previewMioSequenceAction(store, projectId, req(48), {kind: 'subject-binding',
    edit: {kind: 'set-mode', bindingId: (binding.envelope as any).subjectIntent.operation.edit.bindingId,
      bindingMode: 'locked', subjectVersionId: subjectVersion}});
  assert.equal(commitMioSequenceAction(store, locked).status, 'applied');
  const remove = previewMioSequenceAction(store, projectId, req(49), {kind: 'subject-card-delete', nodeId: card.id});
  const removed = commitMioSequenceAction(store, remove);
  assert.equal(removed.status, 'applied');
  assert.equal(cardCount(store), 0);
  const detached = store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE subjectId=?').get(subjectId) as any;
  assert.equal(detached.bindingMode, 'detached');
  applyMioSequenceUndo(store, prepareMioSequenceUndo(store, projectId, req(50), removed.actionId));
  assert.equal(cardCount(store), 1);
  const restored = store.db.prepare('SELECT bindingMode FROM project.subject_bindings WHERE subjectId=?').get(subjectId) as any;
  assert.equal(restored.bindingMode, 'locked');
});

test('MT-5 previs create and scene save ride Mio actions', t => {
  const store = fixture(t);
  const created = previewMioSequenceAction(store, projectId, req(51), {kind: 'previs-create', label: '预演 1'});
  const receipt = commitMioSequenceAction(store, created);
  assert.equal(receipt.status, 'applied');
  const node = previsNode(store)[0]!;
  assert.equal(node.value.label, '预演 1');
  assert.equal(node.value.sceneRevision, 1);
  assert.equal(node.value.scene.figures.length, 1);
  assert.ok(node.value.position.x > 0);
  const scene = defaultPrevisScene();
  scene.figures = [...scene.figures, {id: 'f2', name: '主角', visible: true, position: [0, 0, 0],
    rotation: 0, pose: 'stand', held: null, subject: {subjectId, subjectVersionId: subjectVersion}}];
  const save = previewMioSequenceAction(store, projectId, req(52), {kind: 'previs-scene-set', nodeId: node.id,
    expectedSceneRevision: 1, scene});
  assert.equal(save.envelope.origin, 'mio');
  const saved = commitMioSequenceAction(store, save);
  assert.equal(saved.status, 'applied');
  const after = previsNode(store)[0]!.value;
  assert.equal(after.sceneRevision, 2);
  assert.equal(after.scene.schemaVersion, PREVIS_SCENE_SCHEMA_VERSION);
  assert.deepEqual(after.scene.figures[1].subject, {subjectId, subjectVersionId: subjectVersion});
  applyMioSequenceUndo(store, prepareMioSequenceUndo(store, projectId, req(53), saved.actionId));
  assert.equal(previsNode(store)[0]!.value.sceneRevision, 1);
  // A stale scene revision cannot overwrite the newer scene the model read.
  assert.throws(() => previewMioSequenceAction(store, projectId, req(54), {kind: 'previs-scene-set',
    nodeId: node.id, expectedSceneRevision: 2, scene}), {code: 'SEQUENCE_EDIT_REVISION_CONFLICT'});
});

test('MT-5 exposes the bounded generation-input read tool and the new approval tiers', t => {
  const store = fixture(t);
  assert.equal(Object.hasOwn(MIO_DEFERRED_OPERATIONS, 'sequence.generation-inputs.get'), false);
  const format5Tools = listAgentTaskTools(false, true);
  const readTool = format5Tools.find(tool => tool.operation === 'sequence.generation-inputs.get');
  assert.equal(readTool?.name, 'mioon_sequence_generation_inputs_get');
  assert.equal(readTool?.risk, 'read_only');
  const parameters = readTool?.parameters as {type: string; required: string[]; additionalProperties: boolean;
    properties: Record<string, unknown>};
  assert.deepEqual(parameters.required, ['shotId']);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['configurationRevision', 'connectionId', 'modelEntryId', 'shotId']);
  assert.equal(listAgentTaskTools(false, false).some(tool => tool.operation === 'sequence.generation-inputs.get'), false);
  // The shared public schema still enforces the exact video-connection triple.
  assert.equal(schemas['sequence.generation-inputs.get'].safeParse({projectId, shotId: shotA}).success, true);
  assert.equal(schemas['sequence.generation-inputs.get'].safeParse({projectId, shotId: shotA,
    connectionId: projectId, configurationRevision: 1, modelEntryId: root}).success, true);
  assert.equal(schemas['sequence.generation-inputs.get'].safeParse({projectId, shotId: shotA,
    connectionId: projectId}).success, false);
  // Approval tiers: writes that change the board surface wait for approval.
  const tools = createAgentTaskTools({store, services: {generationAvailability: {
    mockAllowed: true, video: () => true, image: () => true, imageSelectionRequired: () => false}} as never});
  const prepare = (input: unknown) => tools.prepare({projectId, operation: 'sequence.tool.edit',
    input: input as never});
  const reference = prepare({kind: 'reference-attach', sourceNodeId: image, shotId: shotA, role: 'reference_image'});
  commitMioSequenceAction(store, reference.sequence!.plan as never);
  assert.equal(prepare({kind: 'reference-reorder', shotId: shotA,
    edgeIds: materialEdges(store, shotA).map(edge => edge.id)}).forceApproval, true);
  assert.equal(prepare({kind: 'subject-card-create', subjectId}).forceApproval, true);
  const cardPlan = prepare({kind: 'subject-card-create', subjectId});
  commitMioSequenceAction(store, cardPlan.sequence!.plan as never);
  const cardId = (store.db.prepare(`SELECT id FROM project.nodes WHERE projectId=? AND archivedAt IS NULL
    AND json_valid(data) AND json_extract(data,'$.type')='subject_card'`).get(projectId) as any).id as string;
  assert.equal(prepare({kind: 'subject-card-delete', nodeId: cardId}).forceApproval, true);
  assert.equal(prepare({kind: 'previs-create', label: '预演 2'}).forceApproval, true);
  const previsPlan = prepare({kind: 'previs-create', label: '预演 3'});
  commitMioSequenceAction(store, previsPlan.sequence!.plan as never);
  const previsId = previsNode(store)[0]!.id;
  assert.notEqual(prepare({kind: 'previs-scene-set', nodeId: previsId, expectedSceneRevision: 1,
    scene: defaultPrevisScene()}).forceApproval, true);
  // The read tool prepares as an observation without mutation targets.
  const read = tools.prepare({projectId, operation: 'sequence.generation-inputs.get', input: {shotId: shotA}});
  assert.equal(read.risk, 'read_only');
  assert.deepEqual(read.targets, []);
});

test('Mio board management actions build the same unified envelope', t => {
  const store=fixture(t);
  const created=previewMioSequenceAction(store,projectId,req(40),{kind:'board-node-create',type:'text',
    name:'Note',position:{x:10,y:20},text:'hello'});
  assert.equal(created.envelope.origin,'mio');
  const createIntent=created.envelope.intents[0]!.operation as {kind:string;nodeType?:string;text?:string};
  assert.equal(createIntent.kind,'board.node.create');
  assert.equal(createIntent.nodeType,'text');
  commitMioSequenceAction(store,created);
  const updated=previewMioSequenceAction(store,projectId,req(41),{kind:'board-shot-update',shotId:shotA,
    expectedRevision:1,patch:{title:'Renamed shot'}});
  assert.equal((updated.envelope.intents[0]!.operation as {kind:string}).kind,'board.shot.update');
  commitMioSequenceAction(store,updated);
  const nodeId=JSON.parse(String((store.db.prepare("SELECT data FROM project.nodes WHERE json_extract(data,'$.type')='text'").get() as {data:string}).data)).id as string;
  const nodeUpdate=previewMioSequenceAction(store,projectId,req(42),{kind:'board-node-update',nodeId,expectedRevision:1,
    patch:{name:'Note 2'}});
  commitMioSequenceAction(store,nodeUpdate);
  const deleted=previewMioSequenceAction(store,projectId,req(43),{kind:'delete-node',nodeId:shotB});
  commitMioSequenceAction(store,deleted);
  const restored=previewMioSequenceAction(store,projectId,req(44),{kind:'board-restore',targets:[{kind:'shot',id:shotB}]});
  commitMioSequenceAction(store,restored);
  assert.equal((store.db.prepare('SELECT archivedAt FROM project.shots WHERE id=?').get(shotB) as {archivedAt:string|null}).archivedAt,null);
  const duplicate=previewMioSequenceAction(store,projectId,req(45),{kind:'board-duplicate',targets:[{kind:'shot',id:shotA}]});
  commitMioSequenceAction(store,duplicate);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-node-create',type:'text',name:'X',
    position:{x:0,y:0}}).success,true);
});

test('FR-D track add/update are Mio sequence actions with one-step undo', t => {
  const store = fixture(t);
  const add = previewMioSequenceAction(store, projectId, req(9), {kind: 'track-add', trackKind: 'audio', name: 'Mio 轨'});
  assert.equal(add.envelope.origin, 'mio');
  assert.equal(add.envelope.originSide, 'timeline');
  assert.ok((add.envelope as any).trackIntent);
  assert.ok(add.summary.affected.length >= 1);
  const receipt = commitMioSequenceAction(store, add);
  assert.equal(receipt.operation, 'timeline.track.add');
  const timeline = store.get('timelines', timelineId) as any;
  assert.equal(timeline.tracks.some((track: any) => track.name === 'Mio 轨' && track.kind === 'audio'), true);
  assert.equal(readSequenceEditHistory(store, 'mio').undo?.actionId, receipt.actionId);
  const undo = prepareMioSequenceUndo(store, projectId, req(10), receipt.actionId);
  assert.equal(applyMioSequenceUndo(store, undo).status, 'applied');
  assert.equal((store.get('timelines', timelineId) as any).tracks.some((track: any) => track.name === 'Mio 轨'), false);

  const update = previewMioSequenceAction(store, projectId, req(11), {kind: 'track-update', trackId: audio,
    patch: {muted: true}});
  assert.equal(commitMioSequenceAction(store, update).operation, 'timeline.track.update');
  assert.equal((store.get('timelines', timelineId) as any).tracks.find((track: any) => track.id === audio).muted, true);
});
