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
import {MIO_SEQUENCE_ACTION_COUNT, MIO_SEQUENCE_GROUP_OPERATIONS, mioSequenceActionKindsForOperation, mioSequenceEditSchemas} from '../packages/contracts/src/mio-sequence.ts';
import {FORMAT5_INPUT_LIMITS} from '../packages/contracts/src/project-format5.ts';
import {SEQUENCE_GENERATION_INPUT_LIMITS} from '../packages/contracts/src/sequence-inspection.ts';
import {AGENT_TASK_FORMAT5_TOOLS_LOAD_DESCRIPTIONS} from '../packages/business/src/agent/task-tool-groups-v2.ts';
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
  const store = createProjectStore({projectId, projectFile: path.join(rootDir, 'project.mioon'), targetFormat: 5,
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

test('sequence.inspect is a registered read operation with one format-5 tool', () => {
  assert.equal(sequenceInspectionSchemas['sequence.inspect'].safeParse({projectId, limit: 5}).success, true);
  assert.equal(schemas['sequence.inspect'].safeParse({projectId, limit: 5}).success, true);
  assert.equal(schemas['sequence.inspect'].safeParse({projectId, limit: 51}).success, false);
  assert.equal(operationEffects['sequence.inspect'].readOnly, true);
  const format5Tools = listAgentTaskTools(false, true);
  const tool = format5Tools.find(item => item.operation === 'sequence.inspect');
  assert.ok(tool);
  assert.equal(tool.risk, 'read_only');
  assert.equal(agentTaskToolCatalogProfile(format5Tools), 'format5');
  // C+A: the format-5 directory no longer lists legacy entries the gate rejects;
  // the reviewed unavailable table stays for parity and discovery reasons.
  assert.equal(format5Tools.some(item => item.operation === 'timeline.seed'), false);
  assert.equal(format5Tools.some(item => item.operation === 'timeline.shots.append'), false);
  assert.equal(format5Tools.some(item => item.operation === 'previs.scene.set'), false);
  assert.match(FORMAT5_UNAVAILABLE_OPERATIONS['timeline.seed']!, /sequence\.preview\/commit/);
  assert.match(FORMAT5_UNAVAILABLE_OPERATIONS['shot.reorder']!, /明确链顺序/);
  // G line: the previs scene projection inside the loadable previs group is the
  // only one that accepts mannequin/prop subject references.
  assert.match(FORMAT5_UNAVAILABLE_OPERATIONS['previs.scene.set']!, /previs-scene-set/);
  assert.equal(FORMAT5_UNAVAILABLE_OPERATIONS['previs.create'] !== undefined, true);
  // The previs thumbnail is a rebuildable cache written outside the unified
  // history (scene-revision CAS), so its existing tool stays available.
  assert.equal(FORMAT5_UNAVAILABLE_OPERATIONS['previs.thumbnail.set'], undefined);
  assert.equal(format5Tools.some(item => item.operation === 'previs.thumbnail.set'), true);
  const previsSceneParameters = (parameters: unknown): {figure: Record<string, unknown>; prop: Record<string, unknown>} => {
    const branches = (parameters as {anyOf: {properties: {kind: {const: string}; scene: {properties: {
      figures: {items: {properties: Record<string, unknown>}}; props: {items: {properties: Record<string, unknown>}}}}}}[]}).anyOf;
    const branch = branches.find(item => item.properties.kind.const === 'previs-scene-set');
    assert.ok(branch);
    return {figure: branch.properties.scene.properties.figures.items.properties,
      prop: branch.properties.scene.properties.props.items.properties};
  };
  const previsGroup = format5Tools.find(item => item.operation === 'sequence.tool.previs');
  assert.ok(previsGroup);
  assert.equal('subject' in previsSceneParameters(previsGroup.parameters).figure, true);
  assert.equal('subject' in previsSceneParameters(previsGroup.parameters).prop, true);
  const nativeTools = listAgentTaskTools(false, false);
  assert.equal(nativeTools.some(item => item.operation === 'sequence.inspect'), false);
  const nativePrevis = nativeTools.find(item => item.operation === 'previs.scene.set')!.parameters as {
    properties: {scene: {properties: {figures: {items: {properties: Record<string, unknown>}}}}}};
  assert.equal('subject' in nativePrevis.properties.scene.properties.figures.items.properties, false);
  // C+A: the core sequence tool keeps only the nine high-frequency actions; ED's
  // insert-asset rides the on-demand timeline group.
  const actionKinds = (operation: string): string[] => [...mioSequenceActionKindsForOperation(
    operation as Parameters<typeof mioSequenceActionKindsForOperation>[0])];
  assert.deepEqual(actionKinds('sequence.tool.edit').sort(), ['connect', 'copy-move', 'delete-node', 'disconnect',
    'insert', 'remove', 'reorder', 'set-mode', 'split']);
  assert.equal(actionKinds('sequence.tool.edit').includes('board-shot-append'), false);
  assert.deepEqual(actionKinds('sequence.tool.board').sort(), ['board-duplicate', 'board-layout-move',
    'board-node-create', 'board-node-update', 'board-restore', 'board-root-create', 'board-shot-append',
    'board-shot-update']);
  assert.deepEqual(actionKinds('sequence.tool.reference'), ['reference-attach', 'reference-set-role',
    'reference-detach', 'reference-reorder']);
  assert.deepEqual(actionKinds('sequence.tool.subject').sort(), ['subject-binding', 'subject-card-create',
    'subject-card-delete']);
  assert.deepEqual(actionKinds('sequence.tool.previs').sort(), ['previs-create', 'previs-scene-set']);
  assert.deepEqual(actionKinds('sequence.tool.timeline').sort(), ['dialogue', 'format-set', 'generate', 'insert-asset',
    'separate-sound', 'split-at-scenes', 'subtitles', 'track-add', 'track-update']);
  assert.deepEqual(actionKinds('sequence.tool.clip'), ['clip-properties', 'replace-source', 'copy-as-new-shot']);
  // Every bounded action lives in exactly one tool.
  const uniqueKinds = new Set(MIO_SEQUENCE_GROUP_OPERATIONS.flatMap(operation => actionKinds(operation)));
  assert.equal(uniqueKinds.size, MIO_SEQUENCE_GROUP_OPERATIONS.flatMap(operation => actionKinds(operation)).length);
  assert.equal(uniqueKinds.size, MIO_SEQUENCE_ACTION_COUNT);
  assert.equal(uniqueKinds.size, 38);
  const groupTools = format5Tools.filter(item => item.operation.startsWith('sequence.tool.')
    && item.operation !== 'sequence.tool.edit' && item.operation !== 'sequence.tool.undo');
  assert.deepEqual(groupTools.map(item => item.name).sort(), ['mioon_sequence_board_edit',
    'mioon_sequence_clip_edit', 'mioon_sequence_previs_edit', 'mioon_sequence_reference_edit',
    'mioon_sequence_subject_edit', 'mioon_sequence_timeline_edit']);
  assert.ok(groupTools.every(item => item.risk === 'local_reversible'));
  assert.equal(format5Tools.filter(item => item.risk !== 'read_only' && item.operation.startsWith('sequence.tool.')).length, 8);
  assert.equal(nativeTools.some(item => item.operation.startsWith('sequence.tool.')), false);
  const loaded = listAgentTaskToolsForChannel(true, {format5: true}).find(item => item.name === 'mioon_tools_load');
  assert.ok(loaded);
  // MT-5: the generation-input projection is a bounded format-5 read tool only.
  const generationInputs = format5Tools.find(item => item.operation === 'sequence.generation-inputs.get');
  assert.equal(generationInputs?.name, 'mioon_sequence_generation_inputs_get');
  assert.equal(generationInputs?.risk, 'read_only');
  assert.equal(generationInputs?.unavailableReason, undefined);
  assert.equal(nativeTools.some(item => item.operation === 'sequence.generation-inputs.get'), false);
  const generationParameters = generationInputs?.parameters as {required: string[]; additionalProperties: boolean};
  assert.deepEqual(generationParameters.required, ['shotId']);
  assert.equal(generationParameters.additionalProperties, false);
  assert.match(FORMAT5_UNAVAILABLE_OPERATIONS['previs.create']!, /previs-create/);
  assert.match(FORMAT5_UNAVAILABLE_OPERATIONS['previs.scene.set']!, /previs-scene-set/);
  // The format-5 loader enum lists the loadable group tools and still omits
  // every reviewed-unavailable legacy entry.
  const loadParameters = loaded.parameters as {properties: {names: {items: {enum: string[]}; maxItems: number}}};
  const loadNames = loadParameters.properties.names.items.enum;
  for (const name of groupTools.map(item => item.name)) assert.ok(loadNames.includes(name), name);
  assert.equal(loadNames.includes('mioon_sequence_edit'), false);
  for (const operation of Object.keys(FORMAT5_UNAVAILABLE_OPERATIONS)) {
    const unavailableName = `mioon_${operation.replaceAll('.', '_')}`;
    assert.equal(loadNames.includes(unavailableName), false, operation);
  }
  assert.equal(loadParameters.properties.names.maxItems, loadNames.length);
  // One shot's read-only projection is bounded by the three service-side caps.
  assert.deepEqual(Object.values(FORMAT5_INPUT_LIMITS), [48, 8, 32]);
  assert.equal(FORMAT5_INPUT_LIMITS.previsSceneSubjects, 32);
  assert.equal(SEQUENCE_GENERATION_INPUT_LIMITS.entries, 88);
  assert.equal(generationInputs?.description.includes(`最多 ${SEQUENCE_GENERATION_INPUT_LIMITS.entries} 条`), true);
  // The loader description tells the model which group holds which domain.
  for (const name of groupTools.map(item => item.name)) {
    assert.ok(AGENT_TASK_FORMAT5_TOOLS_LOAD_DESCRIPTIONS['zh-Hans'].includes(name), name);
  }
  assert.ok(AGENT_TASK_FORMAT5_TOOLS_LOAD_DESCRIPTIONS['zh-Hans'].includes('台词'));
});

test('sequence inspection pages the chain against one frozen snapshot', t => {
  const store = fixture(t);
  const service = createSequenceInspectionService(store);
  const first = service.handlers['sequence.inspect']!({projectId, limit: 1}) as any;
  assert.equal(first.total, 3);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].nodeId, shotA);
  assert.equal(first.items[0].kind, 'shot');
  assert.equal(first.items[0].clips[0].appliedVersionId, versionA);
  assert.equal(first.items[0].clips[0].boardVersionId, versionA);
  assert.equal(first.items[0].inSync, true);
  assert.equal(first.freeNodeIds.length, 0);
  assert.ok(first.snapshotId.length === 64);
  assert.ok(first.nextCursor);
  const second = service.handlers['sequence.inspect']!({projectId, limit: 2, cursor: first.nextCursor}) as any;
  assert.equal(second.items.length, 2);
  assert.deepEqual(second.items.map((item: any) => item.nodeId), [shotB, image]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.items[0].clips[0].sourceState, 'placeholder');
  // A cursor from another snapshot cannot stitch two reads together.
  store.tx(() => {
    const timeline = store.get('timelines', timelineId) as Record<string, unknown>;
    store.put('timelines', {...timeline, revision: 2});
  });
  assert.throws(() => service.handlers['sequence.inspect']!({projectId, limit: 1, cursor: first.nextCursor}),
    {code: 'INVALID_CURSOR'});
});

test('a board change appears as a chain difference without writing anything', t => {
  const store = fixture(t);
  store.tx(() => store.put('shots', {...(store.get('shots', shotA) as object), selectedVersionId: null}));
  const page = createSequenceInspectionService(store).handlers['sequence.inspect']!({projectId}) as any;
  const segment = page.items.find((item: any) => item.nodeId === shotA);
  assert.equal(segment.clips[0].boardVersionId, null);
  assert.equal(segment.clips[0].appliedVersionId, versionA);
  assert.equal(segment.inSync, false);
  assert.ok(page.differences.some((diff: any) => diff.id === shotA && diff.reason === 'selected_version_changed'));
});
