import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools, agentTaskExplicitTargets} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {AGENT_TASK_TOOL_SCHEMAS} from '../packages/business/src/agent/task-tool-schemas-v2.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import type {OperationName} from '../packages/contracts/src/index.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {timelineMixLoudnessInputSchema} from '../packages/contracts/src/timeline-mix-loudness.ts';
import {readyMixLoudness} from './fixtures/timeline-mix-loudness-fixtures.ts';

const target = {integratedLufs: -16, truePeakCeilingDbtp: -1.5};
const profiles = {mixProfile: 'timeline-float-mix-v1', measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1'};
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-loudness-target-v2-'));
  const store = openStore(root), services = createServices(store, new Map());
  let disposeTools = () => {};
  t.after(async () => {disposeTools(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true});});
  async function project(name: string) {
    const projectId = String(record(await services.call('project.create', {name})).id);
    const node = record(await services.call('node.create', {projectId, type: 'text', text: 'Synthetic note', position: {x: 0, y: 0}}));
    const shot = record(await services.call('shot.create', {projectId, title: 'Synthetic shot'}));
    const baseTimeline = record(await services.call('timeline.get', {projectId}));
    const assetId = randomUUID(), exportId = randomUUID(), hash = 'a'.repeat(64);
    store.put('assets', {id: assetId, projectId, name: 'Synthetic.wav', mimeType: 'audio/wav', relativePath: 'media/synthetic-never-decoded.wav', sha256: hash, sizeBytes: 100, duration: 2, hasAudio: true, hasVideo: false, provenance: 'user-import'});
    const track = record(await services.call('timeline.track.add', {projectId, requestId: randomUUID(), expectedRevision: baseTimeline.revision, kind: 'audio'}));
    const timeline = track;
    const tracks = timeline.tracks as Array<Record<string, unknown>>;
    const added = record(await services.call('timeline.clip.add', {projectId, requestId: randomUUID(), expectedRevision: timeline.revision, assetId, trackId: tracks.at(-1)!.id, startFrame: 0, durationFrames: 30}));
    const saved = added, clips = saved.clips as Array<Record<string, unknown>>;
    store.put('timelines', {...saved, revision: 17});
    // Only identity is observed by prepare; no artifact is opened or decoded.
    store.put('exports', {id: exportId, projectId, status: 'succeeded', assetId});
    return {projectId, nodeId: String(node.id), shotId: String(shot.id), timelineId: String(saved.id), clipId: String(clips[0]!.id), exportId, hash};
  }
  const own = await project('Owned synthetic project'), foreign = await project('Foreign synthetic project');
  const calls: Array<{operation: string; input: unknown}> = [];
  const localServices = {...services, async call(operation: string, input: unknown, context?: Parameters<typeof services.call>[2]) {
    if (operation === 'timeline.loudness.prepare') {
      // Exercise actual Agent preparation/execution and shared schema hydration;
      // isolate the decoder boundary with a clearly synthetic read-only result.
      assert.equal(schemas[operation].safeParse(input).success, true);
      calls.push({operation, input: structuredClone(input)});
      return readyMixLoudness(timelineMixLoudnessInputSchema.parse(input));
    }
    return services.call(operation, input, context);
  }};
  const tools = createAgentTaskTools({store, services: localServices}), journal = createAgentTaskJournal(store);
  disposeTools = () => tools.dispose();
  const run = journal.create({projectId: own.projectId, requestId: randomUUID(), text: 'Synthetic loudness target regression', configuration: {}}).run;
  const inputs: Record<string, Record<string, unknown>> = {
    'timeline.loudness.prepare': {expectedRevision: 17, ...profiles, target},
    'timeline.loudness.apply': {expectedRevision: 17, ...profiles, target, snapshotSha256: own.hash, candidateDigest: `timeline-loudness-candidate-v1:${own.hash}`},
    'timeline.export.loudness': {exportId: own.exportId, expectedArtifactSha256: own.hash, measurementProfile: profiles.measurementProfile, target},
    'timeline.clip.loudness': {timelineId: own.timelineId, expectedRevision: 17, clipId: own.clipId, expectedAssetSha256: own.hash, measurementProfile: profiles.measurementProfile, target},
  };
  return {store, services, own, foreign, tools, journal, run, inputs, calls};
}

test('all loudness target objects prepare as configuration while preserving export and clip ownership', async t => {
  const f = await fixture(t);
  for (const [operation, input] of Object.entries(f.inputs)) {
    const before = structuredClone(input), referenced: Array<{kind: string; id: string}> = [];
    const prepared = f.tools.prepare({projectId: f.own.projectId, operation, input, beforeTargetRead: value => referenced.push(value)});
    assert.deepEqual(prepared.input.target, target); assert.deepEqual(input, before);
    assert.ok(referenced.every(value => value.id !== '[object Object]'));
    assert.ok(!referenced.some(value => value.kind === 'node' || value.kind === 'shot'));
    if (operation !== 'timeline.loudness.apply') assert.equal(prepared.risk, 'read_only');
  }
  for (const [operation, input] of [
    ['timeline.export.loudness', {...f.inputs['timeline.export.loudness'], exportId: f.foreign.exportId}],
    ['timeline.clip.loudness', {...f.inputs['timeline.clip.loudness'], clipId: f.foreign.clipId}],
  ] as const) assert.throws(() => f.tools.prepare({projectId: f.own.projectId, operation, input}), {code: 'AGENT_TASK_INVALID_TARGET'});
});

test('loudness prepare reaches the local execution boundary with its complete target and no business mutations', async t => {
  const f = await fixture(t), input = f.inputs['timeline.loudness.prepare']!;
  const prepared = f.tools.prepare({projectId: f.own.projectId, operation: 'mioon_timeline_loudness_prepare', input});
  const step = f.journal.beginStep(f.run.id, {kind: 'tool', tier: prepared.risk, targets: prepared.targets, toolCall: {id: randomUUID(), name: 'mioon_timeline_loudness_prepare', arguments: input as AgentTaskJson}});
  f.journal.markDispatch(f.run.id, step.id);
  const timeline = structuredClone(record(f.store.get('timelines', f.own.timelineId)));
  const result = await f.tools.execute(prepared, {runId: f.run.id, stepId: step.id, requestId: step.id, beforeEffect: () => f.journal.assertTargets(f.own.projectId, prepared.targets), recordInside: (result, changes) => f.journal.completeStepInside(f.run.id, step.id, {result, changes})});
  if (!result.recorded) f.journal.completeStep(f.run.id, step.id, {result: result.result, changes: result.changes});
  assert.equal(f.calls.length, 1); assert.deepEqual(record(f.calls[0]!.input).target, target); assert.equal(record(f.calls[0]!.input).projectId, f.own.projectId);
  assert.deepEqual(record(result.result).target, target); assert.deepEqual(result.changes, []); assert.deepEqual(f.store.get('timelines', f.own.timelineId), timeline);
  assert.equal(f.journal.step(step.id).status, 'completed'); assert.deepEqual(f.journal.snapshot(f.run.id).changes, []);
  assert.equal(f.store.list('jobs', f.own.projectId).length, 0);
});

test('edge endpoints retain exact entity ownership and invalid endpoint schemas are rejected', async t => {
  const f = await fixture(t), input = {source: f.own.nodeId, target: f.own.shotId};
  const prepared = f.tools.prepare({projectId: f.own.projectId, operation: 'edge.create', input});
  assert.deepEqual(prepared.targets.map(value => [value.kind, value.id]), [['node', f.own.nodeId], ['shot', f.own.shotId]]);
  for (const invalid of [{...input, target}, {...input, source: 17}, {...input, target: 'not-a-uuid'}]) {
    assert.throws(() => f.tools.prepare({projectId: f.own.projectId, operation: 'edge.create', input: invalid}), {code: 'VALIDATION_ERROR'});
  }
  for (const foreign of [{...input, source: f.foreign.nodeId}, {...input, target: f.foreign.shotId}, {...input, source: randomUUID()}, {...input, target: randomUUID()}]) {
    assert.throws(() => f.tools.prepare({projectId: f.own.projectId, operation: 'edge.create', input: foreign}), {code: 'AGENT_TASK_INVALID_TARGET'});
  }
});

test('explicit skip references only interpret source and target as identities for edge creation', () => {
  const projectId = randomUUID(), source = randomUUID(), destination = randomUUID();
  const operations = Object.entries(AGENT_TASK_TOOL_SCHEMAS).filter(([, schema]) => {
    const properties = record(schema).properties;
    return properties !== undefined && ('source' in record(properties) || 'target' in record(properties));
  }).map(([operation]) => operation).sort();
  assert.deepEqual(operations, ['edge.create', 'timeline.clip.loudness', 'timeline.export.loudness', 'timeline.loudness.apply', 'timeline.loudness.prepare']);
  for (const operation of operations.filter(value => value !== 'edge.create')) {
    assert.deepEqual(agentTaskExplicitTargets(operation, {target}, projectId), []);
    assert.deepEqual(agentTaskExplicitTargets(operation, {source, target: destination}, projectId), []);
  }
  const references = agentTaskExplicitTargets('mioon_edge_create', {source, target: destination}, projectId);
  assert.ok(references.some(value => value.id === source)); assert.ok(references.some(value => value.id === destination));
});

test('every loudness operation still rejects invalid target types, bounds and unknown configuration fields', async t => {
  const f = await fixture(t);
  for (const [operation, input] of Object.entries(f.inputs)) {
    assert.equal(Object.hasOwn(schemas, operation as OperationName), true);
    for (const invalid of [f.own.nodeId, {integratedLufs: -100, truePeakCeilingDbtp: -1.5}, {...target, entityId: f.own.nodeId}, {integratedLufs: -16, truePeakCeilingDbtp: 'wrong'}]) {
      assert.throws(() => f.tools.prepare({projectId: f.own.projectId, operation, input: {...input, target: invalid}}), {code: 'VALIDATION_ERROR'});
    }
  }
});
