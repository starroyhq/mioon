import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {canvasEditErrorCode, createCanvasEditingController} from '../apps/web/src/canvas-editing-state.ts';
import type {CanvasEditingContext, CanvasEditRpc} from '../apps/web/src/canvas-editing-state.ts';
import {createCanvasEditing} from '../packages/business/src/canvas-editing.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {createProjectStore, readProjectContentStamp} from '../packages/business/src/project-file/index.ts';
import {canvasEditingSchemas, createCanvasRequestId, readCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import type {CanvasTarget, CanvasTargetExpectation} from '../packages/contracts/src/canvas-editing.ts';
import type {CanvasLayoutInput, CanvasLayoutShot} from '../packages/contracts/src/canvas-tidy-layout.ts';

const date = '2026-11-13T01:02:03.000Z';

function fixture(t: TestContext, enabled = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-canvas-controller-'));
  mkdirSync(path.join(root, 'project'), {mode: 0o700});
  const store = createProjectStore({
    projectFile: path.join(root, 'project', 'canvas.mioon'), format4: {},
    locate: () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')}),
  });
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const {projectId} = store;
  store.put('projects', {id: projectId, name: 'Canvas controller test', revision: 1});
  const time = () => Date.parse(date);
  const cb = createCanvasEditing(store, {now: () => date, time});
  const errors: string[] = [], archivedSelections: CanvasTarget[][] = [];
  const shots: CanvasLayoutShot[] = [], targets: CanvasTarget[] = [];
  const calls: {operation: string; input: unknown}[] = [];
  let decorate: (next: CanvasEditRpc) => CanvasEditRpc = next => next;
  let pageLimit = 100;
  const archived = ({kind, id}: CanvasTarget): boolean => Boolean(store.db
    .prepare(`SELECT archivedAt FROM project.${kind === 'shot' ? 'shots' : 'nodes'} WHERE id=?`).get(id)?.archivedAt);
  const withRevision = (target: CanvasTarget): CanvasTargetExpectation =>
    ({...target, revision: readMioTargetRevision(store.db, projectId, target.kind, target.id)!});
  const context = (): CanvasEditingContext => ({scope: projectId, projectId, enabled, writable: true, base: {
    ...readProjectContentStamp(store.db), targets: targets.filter(target => !archived(target)).map(withRevision),
  }});
  const controller = createCanvasEditingController({
    rpc: (operation, input) => {
      calls.push({operation, input: structuredClone(input)});
      return decorate(async (op, parameters) => {
        try {
          if (op === 'canvas.archive.list') {
            const list = canvasEditingSchemas[op].parse(parameters);
            return cb.call(op, {...list, limit: Math.min(list.limit ?? 100, pageLimit)});
          }
          return cb.call(op, parameters);
        } catch (failure) {
          // Web api.ts marks 4xx with a validated error envelope as definitive.
          throw Object.assign(failure as Error, {definitive: true});
        }
      })(operation, input);
    },
    refresh: async () => controller.setContext(context()), now: time,
    onError: failure => errors.push(canvasEditErrorCode(failure)),
    onArchived: selection => archivedSelections.push(selection.map(({kind,id}) => ({kind,id}))),
  });
  function addNode(text = '') {
    const target = {kind: 'node' as const, id: randomUUID()};
    store.put('nodes', {id: target.id, projectId, type: 'text', label: 'Node', text, revision: 1, position: {x: 0, y: 0}});
    targets.push(target);
    return target;
  }
  function addShot(position: CanvasLayoutShot['position']) {
    const target = {kind: 'shot' as const, id: randomUUID()};
    const layout = {id: target.id, position, orderIndex: shots.length, width: 240, height: 200};
    store.put('shots', {id: target.id, projectId, position, orderIndex: layout.orderIndex, title: 'Shot', prompt: '', aspectRatio: '9:16',
      duration: 2, referenceAssetIds: [], selectedVersionId: null, revision: 1});
    shots.push(layout);
    targets.push(target);
    return target;
  }
  function positions() {
    return shots.map(({id}) => (store.get('shots', id) as {position: CanvasLayoutShot['position']}).position);
  }
  function layout(selectedIds?: ReadonlySet<string>): CanvasLayoutInput {
    const saved = positions();
    return {shots: shots.map((shot, index) => ({...shot, position: saved[index]!})), nodes: [], edges: [], selectedIds};
  }
  function addClipEvidence(shot: CanvasTarget, version: boolean, clip: boolean) {
    const assetId = randomUUID(), versionId = randomUUID(), jobId = randomUUID(), trackId = randomUUID();
    const timeline = {id: randomUUID(), projectId, fps: 30, width: 1920, height: 1080, revision: 1,
      durationFrames: 30, createdAt: date, updatedAt: date,
      tracks: [{id: trackId, name: 'Track', kind: 'video', orderIndex: 0, hidden: true, muted: false}],
      clips: [{id: randomUUID(), trackId, assetId, shotId: shot.id, name: 'Retained', startFrame: 0, durationFrames: 30,
        sourceInFrame: 0, gain: 1, rect: {x: 0, y: 0, width: 1920, height: 1080}}],
    };
    store.put('assets', {id: assetId, projectId, name: 'Video'});
    if (version) store.put('versions', {id: versionId, jobId, projectId, shotId: shot.id, assetId, sha256: 'a'.repeat(64)});
    if (clip) store.put('timelines', timeline);
    return () => { if (clip) assert.deepEqual(store.get('timelines', timeline.id), timeline); };
  }
  return {
    controller, context, errors, calls, archived, archivedSelections, addNode, addShot, addClipEvidence, layout, positions,
    activate() {controller.setContext(context());},
    decorateRpc(hook: (next: CanvasEditRpc) => CanvasEditRpc) {decorate = hook;},
    smallPages() {pageLimit = 2;},
    writeCount: () => calls.filter(call => call.operation === 'canvas.apply').length,
    receiptCount: () => store.db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n,
    externalMove(target: CanvasTarget) {
      assert.notEqual(target.kind, 'edge');
      const {revision, requestAfter, requestEpoch} = cb.call('canvas.history.get', {projectId}) as {
        revision: number; requestAfter: number; requestEpoch: string;
      };
      cb.call('canvas.apply', {projectId, operation: 'move', historyRevision: revision,
        requestId: createCanvasRequestId(requestEpoch, randomUUID(), Math.max(time(), requestAfter + 1)),
        moves: [{...withRevision(target), position: {x: 370, y: 678}}]});
    },
  };
}

test('simple archive writes once, reports the selected count and restores single and multi-page items', async t => {
  const f = fixture(t), nodes = [f.addNode('one'), f.addNode('two'), f.addNode('three'), f.addNode('four')];
  const {controller} = f;
  f.smallPages();
  f.activate();
  assert.equal(await controller.archiveSelection(nodes), true);
  assert.equal(f.writeCount(), 1);
  assert.equal(controller.getSnapshot().review, null);
  assert.deepEqual(nodes.map(f.archived), [true, true, true, true]);
  assert.deepEqual(f.archivedSelections.map(selection => selection.map(target => target.id).sort()), [nodes.map(node => node.id).sort()]);
  assert.equal(controller.getSnapshot().toast?.count, 4);
  assert.equal(controller.getSnapshot().canUndoToast, true);
  assert.deepEqual([controller.getSnapshot().archive.count, controller.getSnapshot().archive.hasMore], [4, true]);
  await controller.loadMoreArchive();
  assert.equal(controller.getSnapshot().archive.items.length, 4);
  assert.equal(controller.getSnapshot().archive.hasMore, false);
  assert.equal(await controller.restore(controller.getSnapshot().archive.items[0]!), true);
  assert.equal(controller.getSnapshot().archive.count, 3);
  assert.equal(await controller.restoreAll(), true);
  assert.equal(f.writeCount(), 3);
  assert.deepEqual(nodes.map(f.archived), [false, false, false, false]);
  assert.equal(controller.getSnapshot().archive.count, 0);
  assert.deepEqual(f.errors, []);
});

for (const [withVersion, withClip] of [[true, true], [true, false], [false, true]] as const) {
  const evidence = [withVersion ? 'a generated version' : null, withClip ? 'a timeline clip' : null].filter(Boolean).join(' and ');
  test(`archive reviews a mixed selection once when a shot has ${evidence}`, async t => {
    const f = fixture(t), shot = f.addShot({x: 900, y: 400}), node = f.addNode();
    const compareTimeline = f.addClipEvidence(shot, withVersion, withClip);
    const {controller} = f;
    f.activate();
    assert.equal(await controller.archiveSelection([shot, node]), false);
    assert.deepEqual(controller.getSnapshot().review, {count: 2, versions: Number(withVersion), clips: Number(withClip)});
    assert.equal(f.writeCount(), 0);
    assert.deepEqual([f.archived(shot), f.archived(node)], [false, false]);
    controller.cancelArchive();
    assert.equal(controller.getSnapshot().review, null);
    assert.equal(await controller.archiveSelection([shot, node]), false);
    assert.equal(await controller.confirmArchive(), true);
    assert.equal(f.writeCount(), 1);
    assert.deepEqual([f.archived(shot), f.archived(node)], [true, true]);
    assert.notEqual(controller.getSnapshot().toast, null);
    compareTimeline();
  });
}

test('layout all and layout selected are each one atomic write with independent undo and redo', async t => {
  const f = fixture(t);
  const first = f.addShot({x: 700, y: 900}), second = f.addShot({x: 1400, y: 1200}), third = f.addShot({x: 2000, y: 2100});
  const {controller} = f;
  f.activate();
  const original = f.positions();
  assert.equal(await controller.tidy(f.layout()), true);
  assert.equal(controller.getSnapshot().toast?.count, 3);
  assert.equal(f.writeCount(), 1);
  assert.notDeepEqual(f.positions(), original);
  assert.equal(await controller.undoToast(), true);
  assert.deepEqual(f.positions(), original);
  assert.equal(await controller.redo(), true);
  const group = [first, second, third];
  assert.deepEqual(f.positions().map((point, i) => point.x !== original[i]!.x), [true, true, true]);
  assert.equal(await controller.undo(), true);
  assert.equal(await controller.tidy(f.layout(new Set(group.slice(1).map(card => card.id)))), true);
  assert.equal(f.writeCount(), 2);
  assert.equal(controller.getSnapshot().toast?.count, 2);
  assert.deepEqual(f.positions()[0], original[0]);
  assert.notDeepEqual(f.positions().slice(1), original.slice(1));
  assert.equal(await controller.undoToast(), true);
  assert.deepEqual(f.positions(), original);
  assert.deepEqual(f.errors, []);
});

test('a lost response replays only the exact request and an older toast cannot undo a later edit', async t => {
  const f = fixture(t), node = f.addNode(), other = f.addNode('active');
  const {controller} = f;
  f.activate();
  let interrupted = false;
  f.decorateRpc(next => async (op,input) => {
    const result = await next(op,input);
    if (op === 'canvas.apply' && !interrupted) {
      interrupted = true;
      throw new TypeError('Synthetic lost response after commit');
    }
    return result;
  });
  assert.equal(await controller.archiveSelection([node]), true);
  assert.ok(f.archived(node));
  const edits = f.calls.filter(call => call.operation === 'canvas.apply').map(call => canvasEditingSchemas['canvas.apply'].parse(call.input));
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[0], edits[1]);
  assert.ok(readCanvasRequestId(edits[0]!.requestId));
  assert.equal(f.receiptCount(), 1);
  f.externalMove(other);
  assert.equal(await controller.undoToast(), false);
  assert.equal(f.errors.at(-1), 'CANVAS_UI_UNDO_CONFLICT');
  assert.equal(f.calls.some(call => call.operation === 'canvas.history.undo'), false);
  assert.ok(f.archived(node));
  assert.equal(controller.getSnapshot().canUndoToast, false);
});

test('restore all rejects a different paginated snapshot, and a disabled canvas never makes an RPC', async t => {
  const f = fixture(t), nodes = [f.addNode(), f.addNode(), f.addNode()];
  const {controller} = f;
  f.smallPages();
  f.activate();
  assert.equal(await controller.archiveSelection(nodes), true);
  f.decorateRpc(next => async (op, input) => {
    const value = await next(op, input);
    if (op !== 'canvas.archive.list' || !canvasEditingSchemas[op].parse(input).after) return value;
    return {...value as object, contentToken: '1'.repeat(32)};
  });
  assert.equal(await controller.restoreAll(), false);
  assert.equal(f.errors.at(-1), 'CANVAS_EDIT_CONFLICT');
  assert.equal(f.writeCount(), 1);
  assert.deepEqual(nodes.map(f.archived), [true, true, true]);

  f.calls.length = 0;
  controller.setContext({...f.context(), enabled: false});
  await controller.loadHistory();
  await controller.loadArchive();
  assert.equal(await controller.restoreAll(), false);
  assert.equal(await controller.tidy(f.layout()), false);
  assert.deepEqual(f.calls, []);
});
