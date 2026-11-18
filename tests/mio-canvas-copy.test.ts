import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore, openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createMioCanvasCopy} from '../packages/business/src/canvas-mio-copy.ts';
import {CANVAS_CLIPBOARD_LIMITS} from '../packages/contracts/src/canvas-editing.ts';
import {mioCanvasCopySchemas} from '../packages/contracts/src/mio-canvas-copy.ts';
import {readCanvasRow} from '../packages/business/src/canvas-patch.ts';
import type {CanvasTarget} from '../packages/contracts/src/canvas-editing.ts';

const viewport = {x: 0, y: 0, width: 3000, height: 3000};
function fixture(t: TestContext, format4 = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mio-copy-'));
  const projectFile = path.join(root, 'film.mioon');
  mkdirSync(path.join(root, 'local'), {mode: 0o700});
  const options = {projectFile, locate: () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')}),
    ...(format4 ? {format4: {}} : {})};
  let store = createProjectStore(options), time = Date.parse('2026-11-18T00:00:00.000Z');
  store.put('projects', {id: store.projectId, name: 'Mio canvas copy', revision: 1});
  let tools = createMioCanvasCopy(store, {time: () => time});
  t.after(() => {tools.dispose(); store.close(); rmSync(root, {recursive: true, force: true});});
  const node = (extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    store.put('nodes', {id, projectId: store.projectId, type: 'text', label: 'Source', text: 'Whitelisted text', position: {x: 0, y: 0},
      revision: 1, createdAt: new Date(time).toISOString(), ...extra});
    return {kind: 'node', id} as const;
  };
  const shot = () => {
    const id = randomUUID();
    store.put('shots', {id, projectId: store.projectId, title: 'Original shot', prompt: 'Synthetic camera movement', aspectRatio: '9:16', duration: 4,
      parameters: {}, referenceAssetIds: [], position: {x: 400, y: 0}, orderIndex: 0, revision: 1, selectedVersionId: null,
      createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString()});
    return {kind: 'shot', id} as const;
  };
  const copy = (targets: CanvasTarget[]) => store.tx(() => tools.apply(tools.prepare('canvas.copy.snapshot', {targets})));
  const duplicate = (targets: CanvasTarget[]) => store.tx(() => tools.apply(tools.prepare('canvas.duplicate', {targets, viewport})));
  return {get store() {return store;}, get tools() {return tools;}, node, shot, copy, duplicate,
    read(target: CanvasTarget) {return readCanvasRow(store, target).data;},
    advance(ms: number) {time += ms;}, reopen() {
      tools.dispose(); store.close(); store = openProjectStore(options); tools = createMioCanvasCopy(store, {time: () => time});
    }};
}

test('Mio canvas inputs reject host ownership, replay fields, raw fields and unsupported viewport bounds', () => {
  const targets = [{kind: 'node', id: randomUUID()}];
  assert.equal(mioCanvasCopySchemas['canvas.copy.snapshot'].safeParse({targets}).success, true);
  for (const field of ['projectId', 'documentId', 'requestId', 'historyRevision', 'dataBase64']) {
    assert.equal(mioCanvasCopySchemas['canvas.copy.snapshot'].safeParse({targets, [field]: randomUUID()}).success, false, field);
  }
  assert.equal(mioCanvasCopySchemas['canvas.copy.snapshot'].safeParse({targets: [...targets, ...targets]}).success, false);
  assert.equal(mioCanvasCopySchemas['canvas.paste'].safeParse({snapshotId: randomUUID(), viewport: {...viewport, width: 0}}).success, false);
});

test('Mio copy returns a document-owned handle and paste copies only the same whitelist used by canvas clipboard', t => {
  const f = fixture(t), source = f.node({privateDebugData: 'must-not-copy', secret: 'must-not-copy'});
  const before = f.store.db.prepare('SELECT count(*) AS total FROM project.nodes').get()!.total;
  const copied = f.copy([source]);
  assert.equal(copied.undo, null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes').get()!.total, before);
  assert.deepEqual(Object.keys(copied.result).sort(), ['count', 'snapshotId']);
  const snapshotId = (copied.result as {snapshotId: string}).snapshotId;
  const prepared = f.tools.prepare('canvas.paste', {snapshotId, viewport});
  const pasted = f.store.tx(() => f.tools.apply(prepared));
  const result = pasted.result as {created: CanvasTarget[]; count: number};
  assert.equal(result.count, 1);
  const created = f.read(result.created[0]!);
  assert.equal(created.text, 'Whitelisted text'); assert.equal(created.label, 'Source');
  assert.equal(created.privateDebugData, undefined); assert.equal(created.secret, undefined);
  assert.notEqual(created.id, source.id);
  f.tools.validateUndo(pasted.undo, pasted.targets);
  f.store.tx(() => f.tools.undo(pasted.undo, pasted.targets));
  const archived = f.store.db.prepare('SELECT archiveReason FROM project.nodes WHERE id=?').get(result.created[0]!.id)!;
  assert.equal(archived.archiveReason, 'undo-create');
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes WHERE archivedAt IS NULL').get()!.total, 1);
});

test('a duplicate keeps its source and linked cards while one compensation removes the complete copied group', t => {
  const f = fixture(t), node = f.node(), shot = f.shot(), edgeId = randomUUID();
  f.store.put('edges', {id: edgeId, projectId: f.store.projectId, source: node.id, target: shot.id, kind: 'decorative'});
  const prepared = f.tools.prepare('canvas.duplicate', {targets: [node, shot], viewport});
  assert.equal(prepared.targets.length, 3);
  assert.ok(prepared.targets.some(target => target.kind === 'edge' && target.id === edgeId));
  const copied = f.duplicate([node, shot]);
  const result = copied.result as {created: CanvasTarget[]; count: number};
  assert.equal(result.count, 2); assert.equal(copied.targets.length, 3);
  const newShot = result.created.find(target => target.kind === 'shot')!;
  assert.equal(f.read(newShot).selectedVersionId, null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.edges WHERE archivedAt IS NULL').get()!.total, 2);
  f.tools.validateUndo(copied.undo, copied.targets);
  f.store.tx(() => f.tools.undo(copied.undo, copied.targets));
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.shots WHERE archivedAt IS NULL').get()!.total, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes WHERE archivedAt IS NULL').get()!.total, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.edges WHERE archivedAt IS NULL').get()!.total, 1);
  assert.equal(f.read(shot).title, 'Original shot');
});

test('a changed source rejects a prepared duplicate before creation and caller rollback leaves zero new rows', t => {
  const f = fixture(t), source = f.node();
  const prepared = f.tools.prepare('canvas.duplicate', {targets: [source], viewport});
  f.store.put('nodes', {...f.store.get('nodes', source.id)!, text: 'Changed', revision: 2});
  assert.throws(() => f.store.tx(() => f.tools.apply(prepared)), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes').get()!.total, 1);
  const current = f.tools.prepare('canvas.duplicate', {targets: [source], viewport});
  assert.throws(() => f.store.tx(() => {f.tools.apply(current); throw new Error('Synthetic receipt failure');}), /Synthetic receipt failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes').get()!.total, 1);
});

test('later edits block compensation instead of discarding the user change', t => {
  const f = fixture(t), copied = f.duplicate([f.node()]);
  const id = (copied.result as {created: CanvasTarget[]}).created[0]!.id;
  f.store.put('nodes', {...f.store.get('nodes', id)!, text: 'User modification', revision: 3});
  assert.throws(() => f.tools.validateUndo(copied.undo, copied.targets), {code: 'CANVAS_EDIT_CONFLICT'});
  assert.equal(f.read({kind: 'node', id}).text, 'User modification');
});

for (const reason of ['expired', 'new owner', 'reopen'] as const) test(`clipboard handles are unavailable after ${reason}`, t => {
  const f = fixture(t), copied = f.copy([f.node()]);
  const input = {snapshotId: (copied.result as {snapshotId: string}).snapshotId, viewport};
  if (reason === 'expired') f.advance(CANVAS_CLIPBOARD_LIMITS.lifetimeMs);
  if (reason === 'reopen') f.reopen();
  const tools = reason === 'new owner' ? createMioCanvasCopy(f.store) : f.tools;
  assert.throws(() => tools.prepare('canvas.paste', input), {code: 'CANVAS_CLIPBOARD_UNAVAILABLE'});
  assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM project.nodes').get()!.total, 1);
});

test('Mio canvas copy refuses format 3 and foreign target identities', t => {
  const legacy = fixture(t, false), current = fixture(t), foreign = legacy.node();
  assert.throws(() => legacy.tools.prepare('canvas.copy.snapshot', {targets: [foreign]}), {code: 'UNKNOWN_OPERATION'});
  assert.throws(() => current.tools.prepare('canvas.copy.snapshot', {targets: [foreign]}), {code: 'CANVAS_EDIT_CONFLICT'});
});
