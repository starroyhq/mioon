import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_SOURCE_HANDLE, REFERENCE_TARGET_HANDLE, VISUAL_SOURCE_HANDLE, VISUAL_TARGET_HANDLE,
  isReferenceEdge, referenceForShot, isReferenceOperation, hasPendingReference,
  isImageReferenceNode, referenceAttachIssue, canvasEdge,
} from '../apps/web/src/reference-connections.ts';
import { prepareSubmission, readPending, clearPending, pendingForProject, reconcilePending } from '../apps/web/src/submissions.ts';
import { generationSelection } from '../apps/web/src/generation-settings.ts';
import {type TestContext} from 'node:test';

interface ReferenceAsset {id: string; projectId: string; mimeType: string; url: string; [key: string]: unknown}
interface ReferenceNode {id: string; projectId: string; type: string; assetId: string; revision: number; [key: string]: unknown}
interface ReferenceShot {id: string; projectId: string; referenceAssetIds: string[]; revision: number; [key: string]: unknown}
interface ReferenceEdge {id: string; projectId: string; kind: string; role: string; source: string; target: string; sourceAssetId: string; [key: string]: unknown}
interface ReferenceOverrides {[key: string]: unknown}

const projectId = 'project-a';
const asset: ReferenceAsset = { id: 'image-a', projectId, mimeType: 'image/png', url: '/media/image-a' };
const source: ReferenceNode = { id: 'node-a', projectId, type: 'image', assetId: asset.id, revision: 2 };
const shot: ReferenceShot = { id: 'shot-a', projectId, referenceAssetIds: [], revision: 4 };
const edge: ReferenceEdge = { id: 'edge-a', projectId, kind: 'reference', role: 'first_frame', source: source.id, target: shot.id, sourceAssetId: asset.id };
const issue = (overrides: ReferenceOverrides = {}) => referenceAttachIssue({ source, shot, assets: [asset], edges: [], projectId, ...overrides } as never);

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: unknown) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
function storageFixture(t: TestContext, storage = new MemoryStorage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
  return storage;
}
function request(operation: string = 'reference.attach'): {projectId: string; key: string; operation: string; createdAt: string; input: Record<string, unknown>} {
  return { projectId, key: 'reference:mutation', operation, createdAt: '2026-10-09T13:00:00.000Z', input: operation === 'reference.attach'
    ? { projectId, sourceNodeId: source.id, targetShotId: shot.id, role: 'first_frame', expectedSourceRevision: 2, expectedShotRevision: 4, requestId: 'original-reference-request' }
    : { projectId, edgeId: edge.id, expectedShotRevision: 5, requestId: 'original-reference-request' } };
}

test('only project-owned image nodes with a matching image asset offer first-frame binding', () => {
  assert.equal(isImageReferenceNode(source, [asset], projectId), true);
  assert.equal(issue({}), '');
  for (const type of ['text', 'video', 'audio', 'shot']) assert.equal(isImageReferenceNode({ ...source, type }, [asset], projectId), false);
  for (const assets of [[], [{ ...asset, mimeType: 'video/mp4' }], [{ ...asset, projectId: 'other-project' }]]) assert.equal(isImageReferenceNode(source, assets, projectId), false);
  assert.equal(isImageReferenceNode({ ...source, projectId: 'other-project' }, [asset], projectId), false);
  assert.match(issue({ source: undefined }), /图片节点/);
  assert.match(issue({ shot: undefined }), /目标镜头/);
  assert.match(issue({ shot: { ...shot, projectId: 'other-project' } }), /目标镜头/);
});

test('manual references, including the same image, must be explicitly cleared and saved', () => {
  for (const referenceAssetIds of [[asset.id], ['different-image'], [asset.id, 'different-image']]) {
    const manual = { ...shot, referenceAssetIds };
    const before = structuredClone(manual);
    assert.match(issue({ shot: manual }), /手动选择参考图.*清除手动参考图并保存/);
    assert.deepEqual(manual, before);
  }
});

test('typed connection lookup ignores decorative edges and explains duplicate or occupied targets', () => {
  const visual = { id: 'visual-a', source: source.id, target: shot.id };
  assert.equal(isReferenceEdge(visual), false);
  assert.equal(referenceForShot([visual, edge], shot.id), edge);
  assert.equal(referenceForShot([edge], 'other-shot'), undefined);
  assert.equal(issue({ edges: [visual] }), '');
  assert.match(issue({ edges: [edge] }), /已连接/);
  assert.match(issue({ edges: [{ ...edge, source: 'another-node' }] }), /已有首帧连接.*断开/);
});

test('semantic and visual edges use separate labelled handles even with identical endpoints', () => {
  const typed = canvasEdge(edge, true);
  const visual = canvasEdge({ ...edge, id: 'visual-a', kind: undefined, role: undefined });
  assert.equal(typed.sourceHandle, REFERENCE_SOURCE_HANDLE);
  assert.equal(typed.targetHandle, REFERENCE_TARGET_HANDLE);
  assert.equal(visual.sourceHandle, VISUAL_SOURCE_HANDLE);
  assert.equal(visual.targetHandle, VISUAL_TARGET_HANDLE);
  assert.notEqual(typed.sourceHandle, visual.sourceHandle);
  assert.notEqual(typed.targetHandle, visual.targetHandle);
  assert.equal(typed.label, '首帧参考');
  assert.match(visual.label, /视觉连线.*不参与生成/);
  assert.equal(typed.selected, true);
  assert.equal(visual.selected, false);
  assert.ok(visual.style.strokeDasharray);
  assert.equal(typed.style.strokeDasharray, undefined);
  assert.equal(edge.label, undefined, 'presentation never mutates the server edge');
});

test('attached reference forces image mode while retaining the selected provider and model', () => {
  const provider = { id: 'p', enabled: true, configured: true, models: ['image-model'], inputModes: ['text', 'image'], aspectRatios: ['9:16'], durations: [2] };
  const options = { providerId: 'p', model: 'image-model', inputMode: 'text' };
  const selected = generationSelection([provider], options, { ...shot, referenceAssetIds: [asset.id] });
  assert.equal(selected.inputMode, 'image');
  assert.equal(selected.provider, provider);
  assert.equal(selected.model, 'image-model');
  assert.equal(options.inputMode, 'text', 'provider preferences remain client-side and unchanged');
});

for (const operation of ['reference.attach', 'reference.detach']) {
  test(`${operation} persists and replays the original operation, revisions and request ID`, t => {
    storageFixture(t);
    const original = request(operation);
    assert.deepEqual(prepareSubmission(original), original);
    assert.deepEqual(readPending(projectId, original.key), original);
    const replacement = request(operation === 'reference.attach' ? 'reference.detach' : 'reference.attach');
    replacement.input = { ...replacement.input, expectedShotRevision: 999, requestId: 'must-not-replace' };
    assert.deepEqual(prepareSubmission(replacement), original);
    assert.equal(hasPendingReference(pendingForProject(projectId)), true);
    clearPending(projectId, original.key);
    assert.equal(hasPendingReference(pendingForProject(projectId)), false);
  });

  test(`${operation} cannot be reconciled by a coincident job/export ID or a changed project graph`, t => {
    storageFixture(t);
    const original = request(operation); prepareSubmission(original);
    reconcilePending(projectId, { jobs: [{ requestId: original.input.requestId }], exports: [{ requestId: original.input.requestId }], edges: [edge], shots: [{ ...shot, revision: 999, referenceAssetIds: [asset.id] }] });
    assert.deepEqual(readPending(projectId, original.key), original);
  });
}

test('reference pending guards are specific and remain isolated by project', t => {
  storageFixture(t);
  assert.equal(isReferenceOperation('reference.attach'), true);
  assert.equal(isReferenceOperation('reference.detach'), true);
  assert.equal(isReferenceOperation('edge.create'), false);
  assert.equal(hasPendingReference([{ operation: 'generation.submit' }]), false);
  prepareSubmission(request());
  assert.equal(hasPendingReference(pendingForProject('other-project')), false);
  assert.equal(hasPendingReference(pendingForProject(projectId)), true);
});

test('unavailable durable storage prevents dispatching a connection mutation', t => {
  const storage = new MemoryStorage(); storage.setItem = () => { throw new Error('storage unavailable'); };
  storageFixture(t, storage);
  let dispatched = false;
  assert.throws(() => { prepareSubmission(request()); dispatched = true; }, /无法保存请求恢复记录/);
  assert.equal(dispatched, false);
});
