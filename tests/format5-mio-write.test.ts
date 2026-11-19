import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {createSequenceInspectionService} from '../packages/business/src/format5-sequence-inspection.ts';
import {agentTaskToolCatalogProfile, FORMAT5_UNAVAILABLE_OPERATIONS} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {listAgentTaskTools, listAgentTaskToolsForChannel} from '../packages/business/src/agent/task-tools-v2.ts';
import {sequenceInspectionSchemas} from '../packages/contracts/src/sequence-inspection.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {operationEffects} from '../packages/contracts/src/operation-effects.ts';

const at = '2026-01-01T00:00:00.000Z';
const id = (n: number): string => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), root = id(2), shotA = id(3), shotB = id(4), image = id(5), video = id(60), audio = id(61);
const assetA = id(10), imageAsset = id(11), versionA = id(20), clipA = id(30), clipB = id(31), imageClip = id(32);
const groupA = id(40), groupB = id(41), groupImage = id(42), timelineId = id(50);
const sha = (letter: string): string => letter.repeat(64);

function fixture(t: test.TestContext): ProjectStore {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mt-read-'));
  const store = createProjectStore({projectId, projectFile: path.join(rootDir, 'project.mioon'), format5: true,
    locate: () => ({localDir: path.join(rootDir, 'records'), cacheDir: path.join(rootDir, 'cache'), tempDir: path.join(rootDir, 'temp')})});
  t.after(() => {store.close(); rmSync(rootDir, {recursive: true, force: true});});
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
    store.put('assets', {id: assetA, projectId, name: 'a.mp4', mimeType: 'video/mp4', duration: 2, sha256: sha('a')});
    store.put('assets', {id: imageAsset, projectId, name: 'i.png', mimeType: 'image/png', duration: null, sha256: sha('b')});
    store.put('jobs', {id: id(71), projectId, status: 'succeeded', phase: 'done', providerId: 'mock', model: 'mock', shotId: shotA, createdAt: at, updatedAt: at});
    store.put('versions', {id: versionA, projectId, jobId: id(71), shotId: shotA, number: 1, assetId: assetA, sha256: sha('a'), createdAt: at});
    store.put('shots', {id: shotA, projectId, title: '镜头 A', orderIndex: 0, selectedVersionId: versionA, duration: 2, createdAt: at, updatedAt: at});
    store.put('shots', {id: shotB, projectId, title: '镜头 B', orderIndex: 1, selectedVersionId: null, duration: 1, createdAt: at, updatedAt: at});
    store.put('nodes', node(root, 'sequence_root', {name: 'Film'}));
    store.put('nodes', node(image, 'image', {assetId: imageAsset}));
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

test('write actions are bounded and reject generated ids supplied as envelopes', () => {
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'connect',fromId:projectId,toId:root}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'connect',fromId:projectId,toId:root,envelope:{}}).success,false);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'split',clipId:projectId,offsetFrames:0}).success,false);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-shot-append',name:'New shot'}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-layout-move',moves:[{nodeId:projectId,x:1,y:2}]}).success,true);
  assert.equal(mioSequenceEditSchemas['sequence.tool.edit'].safeParse({kind:'board-layout-move',moves:[{nodeId:projectId,x:1_000_001,y:2}]}).success,false);
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
