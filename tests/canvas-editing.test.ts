import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createClient} from '../packages/client/src/index.ts';
import {createCanvasEditing} from '../packages/business/src/canvas-editing.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {foreignKeyCheck} from '../packages/business/src/project-file/cross-file/inspect.ts';
import {createProjectStore, openProjectStore, readProjectContentStamp} from '../packages/business/src/project-file/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {layoutCanvas} from '../packages/contracts/src/canvas-tidy-layout.ts';
import {canvasEditingResponses, createCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import {CANVAS_EDIT_LIMITS} from '../packages/contracts/src/canvas-editing.ts';
import type {CanvasEditBase, CanvasEditInput, CanvasEditingOperation, CanvasEditingResponse, CanvasTarget} from '../packages/contracts/src/canvas-editing.ts';

const date = '2026-11-13T01:02:03.000Z';
const worker = fileURLToPath(new URL('./fixtures/canvas-editing-worker.ts', import.meta.url));

function fixture(t: TestContext, candidate = true) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-canvas-editing-'));
  const projectFile = path.join(root, 'project', 'film.mioon');
  mkdirSync(path.dirname(projectFile), {mode: 0o700});
  const location = {localDir: path.join(root,'local'), cacheDir: path.join(root,'cache'), tempDir: path.join(root,'tmp')};
  const openOptions = {projectFile, locate: () => location, ...(candidate ? {format4: {}} : {})};
  let store = createProjectStore(openOptions);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const {projectId} = store;
  let clock = Date.parse(date), editing = createCanvasEditing(store, {now: () => new Date(clock).toISOString(), time: () => clock});
  const call = <T extends CanvasEditingOperation>(operation: T, input: object = {}): CanvasEditingResponse<T> =>
    canvasEditingResponses[operation].parse(editing.call(operation, {projectId, ...input})) as CanvasEditingResponse<T>;
  const reopen = () => {
    store.close();
    store = openProjectStore(openOptions);
    editing = createCanvasEditing(store, {now: () => new Date(clock).toISOString(), time: () => clock});
  };
  const expectTarget = (target: CanvasTarget) => ({...target,
    revision: readMioTargetRevision(store.db, projectId, target.kind, target.id)!});
  const id = () => randomUUID();
  const requestId = () => {
    const {requestEpoch, requestAfter} = call('canvas.history.get');
    return createCanvasRequestId(requestEpoch, id(), Math.max(clock, requestAfter + 1));
  };
  const node = (type = 'text', options: object = {}) => {
    const target = {kind: 'node' as const, id: id()};
    store.put('nodes', {id: target.id, projectId, type, label: 'Card', text: '', revision: 1, position: {x: 0, y: 0}, ...options});
    return target;
  };
  const shot = (orderIndex: number, options: object = {}) => {
    const target = {kind: 'shot' as const, id: id()};
    store.put('shots', {id: target.id, projectId, title: 'Shot', prompt: '', aspectRatio: '9:16', duration: 2,
      orderIndex, position: {x: 0, y: 0}, referenceAssetIds: [], revision: 1, selectedVersionId: null, ...options});
    return target;
  };
  const edge = (source: CanvasTarget, target: CanvasTarget, options: object = {}) => {
    const item = {kind: 'edge' as const, id: id()};
    store.put('edges', {id: item.id, projectId, source: source.id, target: target.id, kind: 'decorative', ...options});
    return item;
  };
  const apply = (input: Omit<Extract<CanvasEditInput,{operation:'archive'|'restore'}>, 'projectId'>) => call('canvas.apply', input);
  const edit = (operation: 'archive' | 'restore', targets: readonly CanvasTarget[]) => {
    const selection = targets.map(expectTarget);
    const preview = call('canvas.archive.preview', {operation, targets: selection});
    assert.deepEqual(preview.blocked, []);
    return apply({operation, targets: selection, historyRevision: preview.historyRevision, requestId: requestId(), confirmation: preview.confirmation ?? undefined});
  };
  const undo = () => call('canvas.history.undo', {historyRevision: call('canvas.history.get').revision, requestId: requestId()});
  const redo = () => call('canvas.history.redo', {historyRevision: call('canvas.history.get').revision, requestId: requestId()});
  const archived = (item: CanvasTarget) => Boolean(store.db.prepare(`SELECT archivedAt FROM project.${{node:'nodes',shot:'shots',edge:'edges'}[item.kind]} WHERE id=?`)
    .get(item.id)?.archivedAt);
  const order = () => store.db.prepare("SELECT id FROM project.shots WHERE archivedAt IS NULL ORDER BY json_extract(data,'$.orderIndex'),id").all().map(row => row.id);
  store.put('projects', {id: projectId, name: 'Test canvas', revision: 1});
  return {root, projectFile, location, projectId, get store(){return store;}, call, reopen, expectTarget, id, requestId, node, shot, edge, apply, edit, undo, redo, archived, order,
    advanceTime: (ms = 200_000) => {clock += ms;}};
}

test('archive of a first-frame source preserves the manual asset and hides both types of edges, with exact undo', async t => {
  const f = fixture(t), assetId = f.id();
  f.store.put('assets', {id: assetId, projectId: f.projectId, mimeType: 'image/png', name: 'Reference', provenance: 'imported'});
  const source = f.node('image', {assetId}), shot = f.shot(0, {referenceAssetIds: [assetId]});
  const reference = f.edge(source, shot, {kind: 'reference', role: 'first_frame', sourceAssetId: assetId});
  const decoration = f.edge(source, shot), initial = f.expectTarget(shot).revision;
  const edit = f.edit('archive', [source]);
  assert.equal(edit.affected, 3);
  assert.ok(f.archived(source) && f.archived(reference) && !f.archived(decoration));
  assert.equal(f.expectTarget(shot).revision, initial + 1);
  const library = openAppLibrary({dataDir: path.join(f.root, 'app')});
  const services = createServices(f.store, new Map(), {application: createProjectServiceApplication(library)});
  try {
    const project = await services.call('project.get', {projectId: f.projectId}) as {nodes: unknown[]; edges: unknown[]; canvasEditBase: CanvasEditBase};
    assert.deepEqual(project.nodes, []);
    assert.deepEqual(project.edges, []);
    assert.deepEqual(project.canvasEditBase, {...readProjectContentStamp(f.store.db), targets: [f.expectTarget(shot)]});
    const archive = canvasEditingResponses['canvas.archive.list'].parse(await services.call('canvas.archive.list', {projectId: f.projectId}));
    assert.deepEqual(archive.items.map(item => item.id), [source.id]);
    assert.deepEqual((f.store.get('shots', shot.id) as {referenceAssetIds: string[]}).referenceAssetIds, [assetId]);
    f.undo();
    assert.equal(f.archived(source), false);
    assert.equal(f.archived(reference), false);
    f.redo();
    f.edit('restore', [source]);
    assert.equal(f.archived(source), false);
    assert.equal(f.archived(reference), true, 'explicit source restore keeps the manual slot');
    assert.equal(f.archived(decoration), false);
    assert.deepEqual(foreignKeyCheck(f.store.db), []);
  } finally { try { await services.drain(); } finally { library.close(); } }
});

test('shot archive undo restores exact story order, explicit recovery uses surviving anchors', t => {
  const f = fixture(t), shots = [f.shot(0), f.shot(1), f.shot(2), f.shot(3), f.shot(4)];
  f.edit('archive', [shots[2]!,shots[1]!]);
  assert.deepEqual(f.order(), [shots[0]!.id,shots[3]!.id,shots[4]!.id]);
  f.undo();
  assert.deepEqual(f.order(), shots.map(shot => shot.id));
  f.redo();
  f.edit('restore', [shots[2]!,shots[1]!]);
  assert.deepEqual(f.order(), shots.map(shot => shot.id));
  const decoration = f.edge(shots[0]!, shots[1]!);
  f.edit('archive', [decoration]);
  f.edit('archive', [shots[1]!]);
  assert.throws(() => f.call('canvas.archive.preview', {operation: 'restore', targets: [f.expectTarget(decoration)]}),
    {code: 'CANVAS_EDIT_CONFLICT', details: {reason: 'edge-endpoint', id: decoration.id}});
  f.edit('restore', [shots[1]!,decoration]);
  assert.equal(f.archived(decoration), false);
});

test('restoring a deletion batch requires every remaining member and keeps an archived shot source binding', t => {
  const f = fixture(t), assetId = f.id(), card = f.node(), source = f.node('image', {assetId});
  const shot = f.shot(0, {referenceAssetIds: [assetId]});
  const reference = f.edge(source, shot, {kind: 'reference', role: 'first_frame', sourceAssetId: assetId});
  f.edit('archive', [shot, card]);
  assert.equal(f.archived(reference), false);
  const listed = f.call('canvas.archive.list'), batchId = listed.items[0]!.archive.batchId;
  const selection = [shot, card].map(f.expectTarget);
  assert.throws(() => f.call('canvas.archive.preview', {operation: 'restore', batchId, targets: selection.slice(1)}),
    {code: 'CANVAS_EDIT_CONFLICT', details: {reason: 'archive-batch'}});
  const preview = f.call('canvas.archive.preview', {operation: 'restore', batchId, targets: selection});
  f.call('canvas.apply', {operation: 'restore', batchId, targets: selection, requestId: f.requestId(), historyRevision: preview.historyRevision});
  assert.equal(f.archived(shot), false);
  assert.equal(f.archived(card), false);
  assert.equal(f.archived(reference), false);
  assert.deepEqual((f.store.get('shots', shot.id) as {referenceAssetIds: string[]}).referenceAssetIds, [assetId]);
});

test('a decorative edge added after undo prevents redo from hiding a new connection', t => {
  const f = fixture(t), card = f.node(), second = f.node();
  f.edit('archive', [card]);
  f.undo();
  f.edge(card, second);
  assert.equal(f.call('canvas.history.get').conflict, true);
  assert.throws(f.redo, {code: 'CANVAS_EDIT_CONFLICT', details: {reason: 'history-dependencies'}});
  assert.equal(f.archived(card), false);
});

test('a replacement decorative edge invalidates undo of an explicit edge deletion', t => {
  const f = fixture(t), card = f.node(), second = f.node(), decoration = f.edge(card, second);
  f.edit('archive', [decoration]);
  const replacement = f.edge(card, second);
  assert.equal(f.call('canvas.history.get').conflict, true);
  assert.throws(f.undo, {code: 'CANVAS_EDIT_CONFLICT'});
  assert.equal(f.archived(decoration), true);
  assert.equal(f.archived(replacement), false);
});

test('moves share one durable cursor, layout is atomic, and exact replay survives reopen', t => {
  const f = fixture(t), card = f.node(), other = f.node();
  const position = (item: CanvasTarget) => (f.store.get('nodes',item.id) as {position: {x:number;y:number}}).position;
  const move = (x: number) => f.call('canvas.apply', {operation: 'move', historyRevision: f.call('canvas.history.get').revision,
    requestId: f.requestId(), moves: [{...f.expectTarget(card), position: {x,y:0}}]});
  move(12);
  move(24);
  f.undo();
  assert.equal(position(card).x, 12);
  f.undo();
  assert.equal(position(card).x, 0);
  f.redo();
  f.redo();
  assert.equal(position(card).x, 24);
  const layout = layoutCanvas({shots: [], nodes: [card,other].map(item => ({id: item.id, type: 'text', position: position(item), width: 210, height: 100})), edges: []});
  assert.equal(layout.status, 'moved');
  const input = {operation: 'layout', requestId: f.requestId(), historyRevision: f.call('canvas.history.get').revision,
    ...readProjectContentStamp(f.store.db), moves: layout.moves.map(move => ({...move, revision: f.expectTarget(move).revision}))};
  const response = f.call('canvas.apply', input);
  assert.equal(response.history.undo?.operation, 'layout');
  f.reopen();
  assert.deepEqual(f.call('canvas.apply', {...input, moves: [...input.moves].reverse()}), response);
  assert.throws(() => f.call('canvas.apply', {...input, historyRevision: 0}), {code: 'REQUEST_ID_REUSED'});
  f.undo();
  assert.equal(position(card).x, 24);
  assert.deepEqual(position(other), {x:0,y:0});
});

test('stale or duplicate targets leave the cursor unchanged and unrelated history is preserved', t => {
  const f = fixture(t), card = f.node(), second = f.node(), target = f.expectTarget(card);
  f.call('canvas.apply', {operation:'move', requestId:f.requestId(), historyRevision:0, moves:[{...target,position:{x:1,y:2}}]});
  const latest = f.call('canvas.history.get');
  assert.throws(() => f.call('canvas.apply', {operation:'move',requestId:f.requestId(),historyRevision:latest.revision,
    moves:[{...target,position:{x:3,y:4}}]}), {code:'CANVAS_EDIT_CONFLICT'});
  assert.throws(() => f.edit('archive', [second,second]), {code:'CANVAS_EDIT_CONFLICT'});
  f.store.put('nodes', {...f.store.get('nodes',card.id) as object, id:card.id, projectId:f.projectId, revision:3, label:'External change'});
  assert.equal(f.call('canvas.history.get').conflict, true);
  assert.throws(f.undo, {code:'CANVAS_EDIT_CONFLICT'});
  assert.equal(f.call('canvas.history.get').revision, latest.revision);
  f.edit('archive',[second]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.canvas_history_entries').get()?.n, 2);
  assert.equal(f.call('canvas.history.get').undoConflict, false);
  f.undo();
  assert.equal(f.call('canvas.history.get').undoConflict, true);
  assert.equal(f.call('canvas.history.get').redoConflict, false);
  f.redo();
  assert.equal(f.archived(second), true);
});

test('undo and redo check their own guards and never rebase an older externally changed action', t => {
  const f = fixture(t), card = f.node(), other = f.node();
  const move = (target: CanvasTarget, x: number) => f.call('canvas.apply', {operation: 'move',
    requestId: f.requestId(), historyRevision: f.call('canvas.history.get').revision,
    moves: [{...f.expectTarget(target), position: {x,y:0}}]});
  move(card, 12);
  move(other, 24);
  f.store.put('nodes', {...f.store.get('nodes', card.id) as object, id: card.id, projectId: f.projectId, label: 'Edited externally'});
  assert.equal(f.call('canvas.history.get').undoConflict, false);
  f.undo();
  const conflict = f.call('canvas.history.get');
  assert.deepEqual([conflict.undoConflict, conflict.redoConflict], [true,false]);
  f.redo();
  move(card, 36);
  f.undo();
  f.undo();
  assert.throws(f.undo, {code: 'CANVAS_EDIT_CONFLICT', details: {reason: 'history-revision'}});
  assert.equal((f.store.get('nodes', card.id) as {label:string}).label, 'Edited externally');
});

test('order-only changes carry forward matching evidence without blessing a different revision', t => {
  const f = fixture(t), first = f.shot(0), second = f.shot(1);
  const move = (x: number) => f.call('canvas.apply', {operation: 'move', historyRevision: f.call('canvas.history.get').revision,
    requestId: f.requestId(), moves: [{...f.expectTarget(second), position: {x, y: 0}}]});
  move(12);
  f.edit('archive', [first]);
  f.undo();
  assert.equal(f.call('canvas.history.get').undoConflict, false);
  f.undo();
  assert.deepEqual((f.store.get('shots', second.id) as {position: object}).position, {x: 0, y: 0});
  f.redo();
  f.store.put('shots', {...f.store.get('shots', second.id) as object, id: second.id, projectId: f.projectId, title: 'External edit'});
  f.redo();
  f.undo();
  assert.equal(f.call('canvas.history.get').undoConflict, true);
  assert.throws(f.undo, {code: 'CANVAS_EDIT_CONFLICT', details: {reason: 'history-revision'}});
  assert.deepEqual(f.order(), [first.id, second.id]);
});

test('a full-size layout fits one history entry and undoes in one step', t => {
  const f = fixture(t);
  const cards = f.store.tx(() => Array.from({length: CANVAS_EDIT_LIMITS.targets}, () => f.node()));
  const input = {operation: 'layout', requestId: f.requestId(), historyRevision: 0, ...readProjectContentStamp(f.store.db),
    moves: cards.map((card, i) => ({...f.expectTarget(card), position: {x: i + 0.125, y: i * 2 + 0.75}}))};
  const result = f.call('canvas.apply', input);
  assert.equal(result.affected, cards.length);
  const sample = cards.at(-1)!;
  assert.deepEqual((f.store.get('nodes', sample.id) as {position: object}).position, input.moves.at(-1)!.position);
  assert.equal(f.undo().affected, cards.length);
  assert.deepEqual((f.store.get('nodes', sample.id) as {position: object}).position, {x: 0, y: 0});
});

test('a confirmed batch rechecks implicit hidden clip consumers and can replay after the confirmation expires', t => {
  const f = fixture(t), shot = f.shot(0), card = f.node(), assetId = f.id();
  f.store.put('assets', {id: assetId, projectId: f.projectId, name: 'Video'});
  f.store.put('versions', {id:f.id(), projectId:f.projectId, jobId:f.id(), shotId:shot.id, assetId, sha256:'a'.repeat(64)});
  const trackId = f.id(), targets = [shot,card].map(f.expectTarget);
  const preview = () => f.call('canvas.archive.preview', {operation:'archive',targets});
  const first = preview();
  assert.deepEqual([first.versions,first.clips,first.historyRevision], [1,0,0]);
  assert.ok(first.confirmation);
  const initial = {operation:'archive' as const, targets, requestId:f.requestId(), historyRevision:0, confirmation:first.confirmation};
  const timeline = {id:f.id(), projectId:f.projectId, fps:30, width:1920, height:1080, revision:1, durationFrames:30, createdAt:date, updatedAt:date,
    tracks:[{id:trackId,name:'Hidden track',kind:'video',orderIndex:0,hidden:true,muted:false}],
    clips:[{id:f.id(),trackId,assetId,name:'Retained',startFrame:0,durationFrames:30,sourceInFrame:0,gain:1,rect:{x:0,y:0,width:1920,height:1080}}]};
  f.store.put('timelines', timeline);
  assert.throws(() => f.apply(initial), {code:'CANVAS_CONFIRMATION_REQUIRED'});
  assert.equal(f.archived(shot), false);
  assert.equal(f.archived(card), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n, 0);
  const verified = preview();
  assert.equal(verified.clips, 1);
  const input = {...initial, confirmation:verified.confirmation!};
  const peer = createCanvasEditing(f.store, {now: () => date, time: () => Date.parse(date)});
  const result = canvasEditingResponses['canvas.apply'].parse(peer.call('canvas.apply', {projectId: f.projectId, ...input}));
  f.advanceTime();
  f.reopen();
  assert.deepEqual(f.apply({...input, targets:[...targets].reverse()}), result);
  assert.deepEqual(f.store.get('timelines', timeline.id), timeline);
  f.undo();
  assert.equal(f.archived(shot), false);
  assert.deepEqual(f.store.get('timelines', timeline.id), timeline);
});

test('expired or lost-history request keys cannot execute again, including after clock rollback', t => {
  const f = fixture(t), card = f.node();
  const moves = [{...f.expectTarget(card), position: {x: 0, y: 0}}];
  const first = {operation: 'move', requestId: f.requestId(), historyRevision: 0, moves};
  assert.equal(f.call('canvas.apply', first).affected, 0);
  f.advanceTime(CANVAS_EDIT_LIMITS.receiptLifetimeMs);
  assert.throws(() => f.call('canvas.apply', first), {code: 'CANVAS_REQUEST_OUTCOME_UNKNOWN'});
  f.call('canvas.apply', {...first, requestId: f.requestId()});
  assert.equal(f.store.db.prepare('SELECT requestId FROM main.canvas_requests WHERE requestId=?').get(first.requestId), undefined);
  f.advanceTime(-CANVAS_EDIT_LIMITS.receiptLifetimeMs);
  f.reopen();
  assert.throws(() => f.call('canvas.apply', first), {code: 'CANVAS_REQUEST_OUTCOME_UNKNOWN'});
  const oldEpoch = f.call('canvas.history.get').requestEpoch;
  f.store.close();
  rmSync(path.join(f.location.localDir, 'history.db'));
  f.reopen();
  assert.notEqual(f.call('canvas.history.get').requestEpoch, oldEpoch);
  assert.throws(() => f.call('canvas.apply', first), {code: 'CANVAS_REQUEST_OUTCOME_UNKNOWN'});
  assert.equal(f.call('canvas.apply', {...first, requestId: f.requestId(), moves: [{...f.expectTarget(card), position: {x: 0, y: 0}}]}).affected, 0);
});

test('the first request key survives a reopen before any canvas mutation', t => {
  const f = fixture(t), card = f.node(), db = f.store.db;
  const content = readProjectContentStamp(db), changes = db.prepare('SELECT total_changes() AS n').get()?.n;
  const history = f.call('canvas.history.get'), requestId = f.requestId();
  assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n, changes);
  assert.equal(db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n, 0);
  f.reopen();
  assert.equal(f.call('canvas.history.get').requestEpoch, history.requestEpoch);
  assert.deepEqual(readProjectContentStamp(f.store.db), content);
  const result = f.call('canvas.apply', {operation: 'move', requestId, historyRevision: history.revision,
    moves: [{...f.expectTarget(card), position: {x: 1, y: 0}}]});
  assert.equal(result.affected, 1);
  assert.equal(result.history.revision, 1);
});

test('a full receipt window reports retry time and makes space when old keys expire', t => {
  const f = fixture(t), card = f.node();
  const input = {operation: 'move', requestId: f.requestId(), historyRevision: 0,
    moves: [{...f.expectTarget(card), position: {x: 0, y: 0}}]};
  const response = f.call('canvas.apply', input);
  const db = f.store.db;
  const add = db.prepare(`INSERT INTO main.canvas_requests(requestId,projectId,operation,inputDigest,response,createdAt,issuedAt)
    VALUES(?,?,'move',?,?,?,?)`);
  const pad = 'a'.repeat(65_000);
  const receipt = JSON.stringify({...response, pad});
  f.store.tx(() => {
    for (let index = 0; index <= CANVAS_EDIT_LIMITS.receiptBytes / Buffer.byteLength(receipt); index++) {
      add.run(f.id(), f.projectId, 'a'.repeat(64), receipt, date, Date.parse(date));
    }
  });
  f.advanceTime(1);
  const waiting = {...input, requestId: f.requestId()};
  const retryAt = Date.parse(date) + CANVAS_EDIT_LIMITS.receiptLifetimeMs;
  assert.throws(() => f.call('canvas.apply', waiting), {code: 'CANVAS_RECEIPT_WINDOW_FULL', details: {retryAfter: new Date(retryAt).toISOString()}});
  f.advanceTime(CANVAS_EDIT_LIMITS.receiptLifetimeMs - 1);
  assert.equal(f.call('canvas.apply', waiting).affected, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n, 1);
});

test('history pruning keeps the original receipt and archived content remains recoverable', t => {
  const f = fixture(t), first = f.shot(0), shot = f.shot(1), last = f.shot(2), card = f.node();
  const input = {operation:'archive' as const, requestId:f.requestId(), historyRevision:0, targets:[f.expectTarget(shot)]};
  const archive = f.apply(input);
  for (let index=1; index<=101; index++) {
    f.call('canvas.apply', {operation:'move', requestId:f.requestId(), historyRevision:index,
      moves:[{...f.expectTarget(card),position:{x:index,y:0}}]});
  }
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.canvas_history_entries').get()?.n, 100);
  assert.deepEqual(f.apply(input), archive);
  assert.equal(f.call('canvas.archive.list').items[0]?.id, shot.id);
  f.store.db.prepare('DELETE FROM main.canvas_history_entries WHERE projectId=?').run(f.projectId);
  f.store.db.prepare('DELETE FROM main.canvas_history_state WHERE projectId=?').run(f.projectId);
  f.reopen();
  f.edit('restore',[shot]);
  assert.equal(f.archived(shot),false);
  assert.deepEqual(f.order(), [first.id, shot.id, last.id]);
  assert.ok(!Object.hasOwn(f.store.get('shots', shot.id) as object, 'canvasArchiveOrder'));
});

test('invalid receipt keys are rejected before writing and missing cursor evidence cannot authorize undo', t => {
  const f = fixture(t), card = f.node();
  const input = {operation: 'move', historyRevision: 0, moves: [{...f.expectTarget(card), position: {x:1,y:0}}]};
  assert.throws(() => f.call('canvas.apply', {...input, requestId: 'receipt\u0000bad'}), {code: 'VALIDATION_ERROR'});
  f.call('canvas.apply', {...input, requestId: f.requestId()});
  f.store.db.prepare("UPDATE main.canvas_history_state SET evidence='{}' WHERE projectId=?").run(f.projectId);
  assert.equal(f.call('canvas.history.get').conflict, true);
  assert.throws(f.undo, {code: 'CANVAS_EDIT_CONFLICT'});
});

test('project client retries an unacknowledged canvas write only with the original request', async t => {
  const f = fixture(t), card = f.node();
  const input = {projectId: f.projectId, operation: 'move', requestId: f.requestId(), historyRevision: 0,
    moves: [{...f.expectTarget(card), position: {x: 48, y: 24}}]};
  const requests: unknown[] = [];
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:9999', MIOON_TOKEN: 'a'.repeat(64)}, fetchImpl: async (url, options) => {
    assert.equal(new URL(String(url)).pathname, `/api/projects/${f.projectId}/rpc`);
    const sent = JSON.parse(String(options?.body));
    requests.push(sent);
    const data = f.call('canvas.apply', sent.input);
    if (requests.length === 1) return new Response('interrupted response');
    return Response.json({ok: true, data});
  }});
  await assert.rejects(client.rpc('canvas.apply', input), error => {
    assert.equal((error as {code: string}).code, 'BACKEND_PROTOCOL_ERROR');
    assert.equal((error as {details?: {requestId?: string}}).details?.requestId, input.requestId);
    assert.equal((error as {details?: {submissionMayHaveSucceeded?: boolean}}).details?.submissionMayHaveSucceeded, true);
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal((await client.rpc<CanvasEditingResponse<'canvas.apply'>>('canvas.apply', input)).history.revision, 1);
  assert.deepEqual(requests, [{operation: 'canvas.apply', input}, {operation: 'canvas.apply', input}]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n, 1);
});

test('default format exposes no canvas editing operations', t => {
  const f = fixture(t, false);
  assert.throws(() => f.call('canvas.history.get'), {code: 'UNKNOWN_OPERATION'});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name='canvas_requests'").get()?.n, 0);
});

for (const boundary of ['before-commit','after-commit'] as const) {
  test(`SIGKILL ${boundary} keeps archive, cursor, and receipt together`, {skip: process.platform === 'win32'}, t => {
    const f = fixture(t), shot = f.shot(0);
    const input = {projectId: f.projectId, operation:'archive', requestId: f.requestId(), historyRevision: 0, targets: [f.expectTarget(shot)]};
    f.store.close();
    const killed = spawnSync(process.execPath, [worker, JSON.stringify({projectFile:f.projectFile, location:f.location,input,boundary,clock:Date.parse(date)})], {
      stdio:'ignore', timeout:60000,
    });
    assert.equal(killed.error, undefined);
    assert.equal(killed.signal, 'SIGKILL');
    f.reopen();
    const committed = boundary === 'after-commit';
    assert.equal(f.archived(shot), committed);
    assert.equal(f.call('canvas.history.get').revision, committed ? 1 : 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM main.canvas_requests').get()?.n, committed ? 1 : 0);
    const result = f.call('canvas.apply', input);
    assert.equal(result.history.revision, 1);
    assert.ok(f.archived(shot));
    assert.deepEqual(foreignKeyCheck(f.store.db), []);
  });
}
