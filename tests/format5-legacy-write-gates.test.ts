import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {isMcpOperationAllowed} from '../apps/mcp/src/tool-policy.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {
  FORMAT5_LEGACY_WRITE_USES, FORMAT5_LEGACY_WRITE_COMMANDS, assertFormat5LegacyWriteAllowed, assertLegacyCanvasWriteAllowed,
  format5LegacyWriteUse,
} from '../packages/business/src/sequence-edit.ts';
import {operationDefinition, schemas} from '../packages/client/src/index.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import {sequencePreviewResponseSchema} from '../packages/contracts/src/sequence-edit-rpc.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';

interface OperationSchema {
  safeParse(input: unknown): {success: true; data: unknown} | {success: false; error: {message: string}};
}
const operationSchemas: Readonly<Partial<Record<string, OperationSchema>>> = schemas;

const EXPECTED: Readonly<Record<string, string>> = Object.freeze({
  'timeline.get': 'sequence.preview/commit',
  'timeline.track.add': 'sequence.preview/commit', 'timeline.track.update': 'sequence.preview/commit',
  'timeline.clip.add': 'sequence.preview/commit', 'timeline.clip.update': 'sequence.preview/commit',
  'timeline.clip.replaceSource': 'sequence.preview/commit', 'timeline.clip.remove': 'sequence.preview/commit',
  'timeline.clip.rippleRemove': 'sequence.preview/commit', 'timeline.clip.split': 'sequence.preview/commit',
  'timeline.clip.splitAtScenes': 'sequence.preview/commit', 'timeline.clip.crossfade': 'sequence.preview/commit',
  'timeline.clip.setGains': 'sequence.preview/commit', 'timeline.clip.setTransform': 'sequence.preview/commit',
  'timeline.clip.setTransition': 'sequence.preview/commit', 'timeline.loudness.apply': 'sequence.preview/commit',
  'timeline.subtitle.add': 'sequence.preview/commit', 'timeline.subtitle.update': 'sequence.preview/commit',
  'timeline.subtitle.remove': 'sequence.preview/commit', 'timeline.seed': 'not_yet_available',
  'timeline.shots.append': 'not_yet_available', 'timeline.clip.refreshSources': 'not_yet_available',
  'timeline.format.set': 'sequence.preview/commit',
  'timeline.history.get': 'sequence.history.get', 'timeline.undo': 'sequence.undo', 'timeline.redo': 'sequence.redo',
  'canvas.apply': 'sequence.preview/commit',
  'canvas.history.get': 'sequence.history.get', 'canvas.history.undo': 'sequence.undo', 'canvas.history.redo': 'sequence.redo',
  'edge.create': 'sequence.preview/commit', 'edge.delete': 'sequence.preview/commit',
  'shot.reorder': 'sequence.preview/commit', 'version.select': 'sequence.preview/commit',
  'shot.create': 'sequence.preview/commit', 'shot.update': 'sequence.preview/commit',
  'node.create': 'sequence.preview/commit', 'node.update': 'sequence.preview/commit',
  'reference.attach': 'sequence.preview/commit', 'reference.detach': 'sequence.preview/commit',
  'previs.create': 'sequence.preview/commit', 'previs.scene.set': 'sequence.preview/commit',
  'subject.binding.set': 'sequence.preview/commit',
});
const READ_ONLY = ['timeline.inspect', 'timeline.format.get', 'timeline.clip.loudness', 'timeline.loudness.prepare',
  'canvas.archive.preview', 'canvas.archive.list', 'canvas.copy.snapshot', 'subject.list', 'subject.binding.list',
  'previs.thumbnail.get', 'previs.inspect', 'shot.inspect', 'node.inspect', 'edge.inspect'];

test('every FR-0 legacy writer is gated once under format 5 and stays untouched on format 4', t => {
  const world = createChainWorld(t, {
    rootId: '10000000-0000-4000-8000-000000000001',
    shots: [], versions: [], clips: [], edges: [],
  });
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fr0-gate-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  try {
    assert.deepEqual(Object.keys(FORMAT5_LEGACY_WRITE_USES).sort(), Object.keys(EXPECTED).sort());
    assert.deepEqual(Object.keys(FORMAT5_LEGACY_WRITE_COMMANDS).sort(), Object.keys(EXPECTED).sort());
    for (const [operation, use] of Object.entries(EXPECTED)) {
      assert.equal(format5LegacyWriteUse(operation), use, operation);
      const command = FORMAT5_LEGACY_WRITE_COMMANDS[operation];
      assert.ok(command, operation);
      assert.throws(() => assertFormat5LegacyWriteAllowed(world.store, operation), (error: {code?: string; details?: {use?: string; command?: string}; message?: string}) =>
        error.code === 'UNSUPPORTED_OPERATION' && error.details?.use === use && error.details.command === command &&
        Boolean(error.message?.includes(command)), operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, operation), `format 4 ${operation}`);
    }
    for (const operation of READ_ONLY) {
      assert.equal(format5LegacyWriteUse(operation), null, operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(world.store, operation), operation);
    }
    // Product decision 11-21: the subject library's create and version-add are
    // asset-library operations that write only subjects/subject_versions, never
    // the board or the timeline, so format 5 keeps them open (and format 3/4 is
    // unchanged). Binding a subject to a shot stays on the unified entry.
    for (const operation of ['subject.create', 'subject.version.add']) {
      assert.equal(format5LegacyWriteUse(operation), null, operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(world.store, operation), operation);
      assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, operation), `format 4 ${operation}`);
    }
    assert.equal(format5LegacyWriteUse('subject.binding.set'), 'sequence.preview/commit');
    assert.throws(() => assertFormat5LegacyWriteAllowed(world.store, 'subject.binding.set'),
      (error: {code?: string}) => error.code === 'UNSUPPORTED_OPERATION');
    // The previs thumbnail is a rebuildable cache, not a user edit: it writes
    // outside the unified history (scene-revision CAS) and is not gated.
    assert.equal(format5LegacyWriteUse('previs.thumbnail.set'), null);
    assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(world.store, 'previs.thumbnail.set'));
    assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, 'previs.thumbnail.set'));
    // Unlisted legacy writers that are not edits (render is handled by FR-B) stay untouched.
    for (const operation of ['timeline.render', 'project.rename', 'project.version.save', 'export.create']) {
      assert.equal(format5LegacyWriteUse(operation), null, operation);
    }
    // Existing ambiguous-canvas gates now point at the future unified entry.
    assert.throws(() => assertLegacyCanvasWriteAllowed(world.store, 'edge'), (error: {details?: {use?: string}}) =>
      error.details?.use === 'sequence.preview/commit');
    assert.doesNotThrow(() => assertLegacyCanvasWriteAllowed(format4, 'edge'));
  } finally {
    format4.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('each format-5 gate recommends CLI and MCP operations that accept the advertised fields', t => {
  const {store, projectId, rootId} = createChainWorld(t, {shots: [], clips: [], edges: []});
  const [clipId, secondClipId, trackId, assetId, versionId, shotId, nodeId, edgeId, cueId, bindingId,
    resultId, documentId, snapshotId, actionId] = Array.from({length: 14}, () => randomUUID());
  const requestId = 'legacy-gate-example';
  const position = {x: 80, y: 100};
  const replay = {requestId, actionId, expected: {position: 1, revision: 2}};
  const clipPatch = (patch: Record<string, unknown>) => ({kind: 'clip-properties', edits: [{clipId, patch}]});
  const move = {kind: 'board-layout-move', moves: [{nodeId: rootId, ...position}]};
  const plan = sequencePreviewResponseSchema.parse(createFormat5SequenceEditService(store).preview({
    projectId, requestId, intents: [{side: 'board', operation: {kind: 'board.layout.move', moves: move.moves}}],
  }));
  const proof = {envelope: plan.envelope, expectedPlanDigest: plan.planDigest};
  const previewBoardIntent = (operation: Record<string, unknown>) => ({requestId, intents: [{side: 'board', operation}]});
  const insertAsset = {kind: 'insert-asset', assetId, trackId, startFrame: 30};
  const remove = {kind: 'remove', clipId};
  const gain = clipPatch({gain: 0.8});
  const history = [['sequence.history.get', {}]] as const;
  const undo = [['sequence.undo', replay]] as const;
  const redo = [['sequence.redo', replay]] as const;
  type Example = readonly [operation: string, input: Record<string, unknown>];
  const examples: Readonly<Record<string, readonly Example[]>> = {
    'timeline.get': [['sequence.inspect', {}], ['timeline.inspect', {}]],
    'timeline.track.add': [['sequence.timeline.edit', {kind: 'track-add', trackKind: 'audio', name: 'Voice'}]],
    'timeline.track.update': [['sequence.timeline.edit', {kind: 'track-update', trackId, patch: {hidden: true, muted: true}}]],
    'timeline.clip.add': [['sequence.timeline.edit', insertAsset]],
    'timeline.clip.update': [['sequence.clip.edit', clipPatch({name: 'Opening', fadeInFrames: 8})]],
    'timeline.clip.replaceSource': [['sequence.clip.edit', {kind: 'replace-source', clipId, assetId, versionId}],
      ['sequence.action.commit', proof]],
    'timeline.clip.remove': [['sequence.action.edit', remove]],
    'timeline.clip.rippleRemove': [['sequence.action.edit', remove]],
    'timeline.clip.split': [['sequence.action.edit', {kind: 'split', clipId, offsetFrames: 10}]],
    'timeline.clip.splitAtScenes': [['sequence.timeline.edit', {kind: 'split-at-scenes', assetId, resultId}]],
    'timeline.clip.crossfade': [['sequence.clip.edit', {kind: 'clip-properties', edits: [
      {clipId, patch: {volumeEnvelope: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 20, multiplier: 1}, {frame: 30, multiplier: 0}]}}},
      {clipId: secondClipId, patch: {volumeEnvelope: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 0}, {frame: 10, multiplier: 1}]}}},
    ]}]],
    'timeline.clip.setGains': [['sequence.clip.edit', gain]],
    'timeline.clip.setTransform': [['sequence.clip.edit', clipPatch({transform: null})]],
    'timeline.clip.setTransition': [['sequence.clip.edit', clipPatch({transition: {profileId: CLIP_TRANSITION_PROFILE, kind: 'dissolve', durationFrames: 10}})]],
    'timeline.loudness.apply': [['sequence.clip.edit', gain]],
    'timeline.subtitle.add': [['sequence.timeline.edit', {kind: 'subtitles',
      edits: [{kind: 'add', cue: {text: 'Subtitle', startFrame: 0, durationFrames: 30}}]}]],
    'timeline.subtitle.update': [['sequence.timeline.edit', {kind: 'subtitles', edits: [{kind: 'update', cueId, patch: {text: 'New subtitle'}}]}]],
    'timeline.subtitle.remove': [['sequence.timeline.edit', {kind: 'subtitles', edits: [{kind: 'remove', cueId}]}]],
    'timeline.seed': [['sequence.timeline.edit', insertAsset]],
    'timeline.shots.append': [['sequence.timeline.edit', insertAsset]],
    'timeline.clip.refreshSources': [['sequence.action.edit', {kind: 'set-mode', clipId, mode: 'follow'}]],
    'timeline.format.set': [['sequence.timeline.edit', {kind: 'format-set', presetId: 'portrait_1080'}]],
    'timeline.history.get': history,
    'timeline.undo': undo,
    'timeline.redo': redo,
    'canvas.apply': [['sequence.board.edit', move],
      ['sequence.board.edit', {kind: 'board-restore', targets: [{kind: 'shot', id: shotId}]}],
      ['sequence.preview', previewBoardIntent({kind: 'board.paste', documentId, snapshotId, viewport: {...position, width: 800, height: 600}})],
      ['sequence.commit', proof]],
    'canvas.history.get': history,
    'canvas.history.undo': undo,
    'canvas.history.redo': redo,
    'edge.create': [['sequence.action.edit', {kind: 'connect', fromId: rootId, toId: shotId}]],
    'edge.delete': [['sequence.action.edit', {kind: 'disconnect', fromId: rootId, toId: shotId}]],
    'shot.reorder': [['sequence.action.edit', {kind: 'reorder', clipId, beforeClipId: secondClipId}]],
    'version.select': [['sequence.preview', previewBoardIntent({kind: 'board-version', nodeId: shotId, version: {id: versionId, sourceFrames: null}})],
      ['sequence.commit', proof]],
    'shot.create': [['sequence.board.edit', {kind: 'board-shot-append', name: 'Opening', position}]],
    'shot.update': [['sequence.board.edit', {kind: 'board-shot-update', shotId, expectedRevision: 1,
      patch: {title: 'Opening', prompt: 'At dawn', duration: 4, aspectRatio: '9:16', position}}]],
    'node.create': [['sequence.board.edit', {kind: 'board-node-create', type: 'text', name: 'Note', position, text: 'Opening'}]],
    'node.update': [['sequence.board.edit', {kind: 'board-node-update', nodeId, expectedRevision: 1, patch: {name: 'Note'}}]],
    'reference.attach': [['sequence.reference.edit', {kind: 'reference-attach', shotId, sourceNodeId: nodeId, role: 'first_frame'}]],
    'reference.detach': [['sequence.reference.edit', {kind: 'reference-detach', shotId, edgeId}]],
    'previs.create': [['sequence.previs.edit', {kind: 'previs-create', label: 'Opening', position}]],
    'previs.scene.set': [['sequence.previs.edit', {kind: 'previs-scene-set', nodeId, expectedSceneRevision: 1, scene: defaultPrevisScene()}]],
    'subject.binding.set': [['sequence.subject.edit', {kind: 'subject-binding', edit: {kind: 'set-mode', bindingId,
      bindingMode: 'locked', subjectVersionId: versionId}}]],
  };
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(FORMAT5_LEGACY_WRITE_COMMANDS).sort());
  for (const [legacy, variants] of Object.entries(examples)) {
    const hint = FORMAT5_LEGACY_WRITE_COMMANDS[legacy]!;
    const actual = [...hint.matchAll(/((?:sequence|timeline) [a-z]+(?: [a-z]+)?)(?:（(?:动作|操作) ([a-z.-]+))?/g)]
      .map(([, command, kind]) => ({command, kind}));
    const expected = variants.map(([operation, input]) => {
      const definition = operationDefinition(operation);
      assert.equal(isMcpOperationAllowed(operation), true, `${legacy}: ${definition.toolName}`);
      const schema = operationSchemas[operation];
      assert.ok(schema, `${legacy}: missing schema for ${operation}`);
      const parsed = schema.safeParse({projectId, ...input});
      assert.ok(parsed.success, `${legacy}: ${definition.command}\n${parsed.success ? '' : parsed.error.message}`);
      const data = parsed.data as {kind?: string; intents?: {operation: {kind: string}}[]};
      return {command: definition.command, kind: data.kind ?? data.intents?.[0]?.operation.kind};
    });
    assert.deepEqual(actual, expected, legacy);
    if (format5LegacyWriteUse(legacy) === 'not_yet_available') assert.match(hint, /暂无等价命令/, legacy);
  }
  const replacement = {projectId, kind: 'replace-source', clipId, assetId};
  const clipSchema = operationSchemas['sequence.clip.edit'];
  assert.ok(clipSchema);
  assert.equal(clipSchema.safeParse(replacement).success, true);
  assert.equal(clipSchema.safeParse({...replacement, assetId: undefined}).success, false);
  assert.equal(clipSchema.safeParse({...replacement, requestId}).success, false);
  const {inputSchema} = operationDefinition('sequence.clip.edit');
  const branches = inputSchema.anyOf as {properties: {kind: {const: string}; [key: string]: unknown}; required: string[]}[];
  const replaceSource = branches.find(branch => branch.properties.kind.const === 'replace-source');
  assert.ok(replaceSource);
  assert.deepEqual(Object.keys(replaceSource.properties).sort(), ['assetId', 'clipId', 'kind', 'projectId', 'versionId']);
  assert.deepEqual([...replaceSource.required].sort(), ['assetId', 'clipId', 'kind', 'projectId']);
});

test('the format-5 gate is a no-op for reads and for format-3/4 project stores', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-fr0-format4-'));
  const format4 = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  try {
    for (const operation of Object.keys(EXPECTED)) assert.doesNotThrow(() => assertFormat5LegacyWriteAllowed(format4, operation));
  } finally {format4.close(); rmSync(root, {recursive: true, force: true});}
});
