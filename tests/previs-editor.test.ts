import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
import * as contracts from '@mioon/contracts';
import {PREVIS_LIMITS, canonicalPrevisValue, defaultPrevisScene, isPrevisNodeRecord, isPrevisScene} from '@mioon/contracts';
import type {PrevisNodeRecord, PrevisScene} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {ApiError} from '../apps/web/src/api.ts';
import * as camera from '../apps/web/src/previs/previs-camera.ts';
import * as sceneEdits from '../apps/web/src/previs/previs-scene.ts';
import * as history from '../apps/web/src/previs/previs-history.ts';
import * as editorState from '../apps/web/src/previs/previs-editor-state.ts';
import * as keyframes from '../apps/web/src/previs/previs-keyframes.ts';
import * as output from '../apps/web/src/previs/previs-output.ts';
import {createPrevisSaver} from '../apps/web/src/previs/previs-save.ts';
import type {PrevisSaveState} from '../apps/web/src/previs/previs-save.ts';
import {createPrevisNode} from '../apps/web/src/previs/previs-create.ts';
import {createPrevisThumbnails, previsThumbnailUrl} from '../apps/web/src/previs/previs-thumbnails.ts';
import * as i18nIndex from '../packages/i18n/src/index.ts';
import {i18nTestModule, translate} from './helpers/i18n.ts';
import type {ElementNode, ElementTree} from './helpers/strict-timeline-audio-harness-types.ts';
type Row = Record<string, unknown>;
const zh = (key: string, params: Record<string, string | number> = {}): string => translate('zh-Hans', key as never, params as never);
const t = zh as editorState.PrevisTranslate;
const settle = async (): Promise<void> => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
const near = (actual: number, expected: number, epsilon = 1e-6): void => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≈ ${expected}`);
const root = fileURLToPath(new URL('../', import.meta.url));

// ---- Real services over a JSON wire, as the browser sees them ----
async function services(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mioon-previs-editor-'));
  const store = openStore(directory), service = createServices(store, new Map());
  const call = <T = Row>(operation: string, input: unknown): Promise<T> => service.call(operation, input) as Promise<T>;
  const wire = async (operation: string, input: unknown): Promise<unknown> => {
    try { return JSON.parse(JSON.stringify(await call(operation, input))); }
    catch (error) { const failure = error as {message?: string; code?: string; details?: unknown; status?: number}; throw new ApiError(failure.message || 'Refused', failure.code, failure.details === undefined ? undefined : JSON.parse(JSON.stringify(failure.details)), (failure.status ?? 500) < 500, failure.status); }
  };
  const projectId = (await call<{id: string}>('project.create', {name: 'Previs editor'})).id;
  const create = async (label = '机位预演'): Promise<PrevisNodeRecord> => await wire('previs.create', {projectId, label, position: {x: 0, y: 0}, requestId: randomUUID()}) as PrevisNodeRecord;
  const nodes = async (): Promise<Row[]> => ((await call<{nodes: Row[]}>('project.get', {projectId})).nodes ?? []);
  t.after(async () => { await service.drain?.(); store.close(); rmSync(directory, {recursive: true, force: true}); });
  return {projectId, call, wire, create, nodes};
}
// A canvas-style JPEG container the thumbnail validator accepts.
function jpeg(width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
    Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]), Buffer.alloc(64, 0x55), Buffer.from([0x12, 0x34, 0xff, 0xd9])]);
}
// Timers the test advances by hand.
function clock() {
  let now = 0, serial = 0;
  const timers = new Map<number, {at: number; callback: () => void}>();
  return {
    setTimer: (callback: () => void, delay: number): unknown => { const id = ++serial; timers.set(id, {at: now + delay, callback}); return id; },
    clearTimer: (id: unknown): void => { timers.delete(id as number); },
    pending: (): number => timers.size,
    async advance(ms: number): Promise<void> {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await settle();
      }
      now = end; await settle();
    },
  };
}

// ---- Camera math ----
test('camera math matches the scene conventions and the frame guide', () => {
  assert.deepEqual(camera.previsViewDirection(0, 0).map(value => Math.round(value * 1000) / 1000 || 0), [0, 0, -1], 'yaw 0 looks along -Z');
  const left = camera.previsViewDirection(90, 0);
  near(left[0], -1); near(left[2], 0);
  const look = camera.previsLookAt([0, 1.6, 4], [0, 1, 0]);
  near(look.yaw, 0); assert.ok(look.pitch < 0, 'looking down at the figure');
  const direction = camera.previsViewDirection(look.yaw, look.pitch), length = Math.hypot(0, -0.6, -4);
  near(direction[1], -0.6 / length); near(direction[2], -4 / length);
  // Orbiting keeps the distance to the pivot and keeps looking at it.
  const start: contracts.PrevisCamera = {position: [0, 1.6, 4], yaw: 0, pitch: -4, focalLength: 35};
  const pivot: camera.Vector3 = [0, 1, 0], orbited = camera.orbitPrevisCamera(start, pivot, 30, -10);
  const distance = (value: contracts.PrevisCamera): number => Math.hypot(value.position[0] - pivot[0], value.position[1] - pivot[1], value.position[2] - pivot[2]);
  near(distance(orbited), distance(start), 0.01);
  const aim = camera.previsLookAt(orbited.position, pivot);
  near(aim.yaw, orbited.yaw, 0.05); near(aim.pitch, orbited.pitch, 0.05);
  assert.ok(orbited.position[0] > 0, 'a positive yaw turn moves the camera towards +X');
  // Walking follows the yaw on the floor plane; normalising rounds and clamps.
  const walked = camera.walkPrevisCamera({...start, yaw: 90}, 1, 0, 0.5);
  assert.deepEqual(walked.position, [-1, 2.1, 4]);
  assert.deepEqual(camera.normalizePrevisCamera({position: [123.45678, -0.0001, 1], yaw: 190, pitch: -95, focalLength: 4}), {position: [100, 0, 1], yaw: -170, pitch: -89, focalLength: 10});
  near(camera.previsVerticalFov(35, 9 / 16), 2 * Math.atan(18 / 35) * 180 / Math.PI, 1e-9);
  near(camera.previsVerticalFov(35, 16 / 9), 2 * Math.atan(36 / (16 / 9) / 2 / 35) * 180 / Math.PI, 1e-9);
  // The frame guide is centred inside the margins and the viewport sees exactly it.
  const rect = camera.previsFrameRect(836, 686, 9 / 16);
  assert.deepEqual({height: rect.height, top: rect.top}, {height: 686 - 144, top: 72});
  near(rect.width, (686 - 144) * 9 / 16); near(rect.left, (836 - rect.width) / 2);
  const wide = camera.previsFrameRect(500, 686, 16 / 9);
  assert.equal(wide.width, 500 - 48, 'a wide frame is limited by the side margins');
  near(camera.previsViewportFov(35, 9 / 16, 542, 542), camera.previsVerticalFov(35, 9 / 16));
  const fov = camera.previsViewportFov(35, 9 / 16, 686, 542);
  near(Math.tan(fov * Math.PI / 360) / Math.tan(camera.previsVerticalFov(35, 9 / 16) * Math.PI / 360), 686 / 542, 1e-9);
  const front = camera.previsLightDirection(0, 0), side = camera.previsLightDirection(90, 0), top = camera.previsLightDirection(0, 90);
  near(front[2], 1); near(side[0], 1); near(top[1], 1);
  assert.deepEqual(camera.previsFrame(null), {width: 1080, height: 1920, aspect: 1080 / 1920, ratio: '9:16'});
  assert.equal(camera.previsFrame({width: 1920, height: 1080}).ratio, '16:9');
  assert.deepEqual(camera.PREVIS_FOCAL_PRESETS, [24, 35, 50, 85]);
});

// ---- Scene edits ----
test('scene edits stay inside the contract up to every limit', () => {
  let scene = defaultPrevisScene();
  for (let index = 1; index < PREVIS_LIMITS.figures; index++) scene = sceneEdits.addPrevisFigure(scene).scene;
  assert.deepEqual(scene.figures.map(item => item.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']);
  assert.equal(sceneEdits.canAddPrevisFigure(scene), false);
  assert.deepEqual(sceneEdits.addPrevisFigure(scene), {scene, id: ''}, 'a ninth figure is refused');
  assert.equal(new Set(scene.figures.map(item => item.position.join())).size, 8, 'new figures do not stack on one spot');
  for (let index = 0; index < PREVIS_LIMITS.props; index++) scene = sceneEdits.addPrevisProp(scene, sceneEdits.PREVIS_PROP_ORDER[index % 8]!).scene;
  assert.equal(scene.props.length, PREVIS_LIMITS.props);
  assert.equal(sceneEdits.addPrevisProp(scene, 'box').id, '');
  // Long, odd names are cleaned to what the scene accepts.
  scene = sceneEdits.updatePrevisFigure(scene, 'f1', {name: '林夏\n\u0007😀😀😀😀😀😀😀😀😀😀😀'});
  assert.equal(scene.figures[0]!.name, '林夏😀😀😀😀😀😀😀😀😀');
  scene = sceneEdits.updatePrevisProp(scene, 'p1', {name: 'x\ud800y', position: [200, -3, 0.12345], rotation: 270, size: [0, 30, 1.23456]});
  assert.deepEqual([scene.props[0]!.name, scene.props[0]!.position, scene.props[0]!.rotation, scene.props[0]!.size], ['xy', [100, -3, 0.123], -90, [0.01, 20, 1.235]]);
  scene = sceneEdits.updatePrevisLight(scene, {intensity: 9, azimuth: -190, elevation: 120});
  assert.deepEqual(scene.light, {visible: true, azimuth: 170, elevation: 90, intensity: 4});
  assert.ok(isPrevisScene(scene), 'every edit keeps the scene valid');
  assert.ok(contracts.previsSceneBytes(scene) < PREVIS_LIMITS.sceneBytes);
});
test('a prop has one holder and is let go when removed', () => {
  let scene = sceneEdits.addPrevisFigure(defaultPrevisScene()).scene;
  scene = sceneEdits.addPrevisProp(scene, 'umbrella').scene;
  scene = sceneEdits.addPrevisProp(scene, 'box').scene;
  assert.equal(sceneEdits.holdPrevisProp(scene, 'f1', 'p2'), scene, 'a box cannot be held');
  scene = sceneEdits.holdPrevisProp(scene, 'f1', 'p1', 'left');
  assert.deepEqual(scene.figures[0]!.held, {propId: 'p1', hand: 'left'});
  scene = sceneEdits.holdPrevisProp(scene, 'f2', 'p1', 'right');
  assert.deepEqual(scene.figures.map(item => item.held), [null, {propId: 'p1', hand: 'right'}], 'taking a prop takes it from its holder');
  assert.deepEqual(editorState.previsHoldableProps(scene, 'f1').map(item => item.id), [], 'a held umbrella is not offered to others');
  assert.deepEqual(editorState.previsHoldableProps(scene, 'f2').map(item => item.id), ['p1']);
  assert.equal(editorState.previsOutlineDetail(scene, 'p1', t), `${zh('previs.figure.default', {number: 2})} · ${zh('previs.hand.right')}`);
  scene = sceneEdits.removePrevisElement(scene, 'p1');
  assert.deepEqual(scene.figures.map(item => item.held), [null, null]);
  assert.ok(isPrevisScene(scene));
});

// ---- History and the editor model ----
test('undo steps coalesce one continuous change and stop at the limit', () => {
  const base = defaultPrevisScene();
  const moved = (x: number): PrevisScene => sceneEdits.updatePrevisFigure(base, 'f1', {position: [x, 0, 0]});
  let model = editorState.createPrevisEditorModel(base);
  model = editorState.editPrevisModel(model, moved(1), {key: 'drag:f1', now: 1000});
  model = editorState.editPrevisModel(model, moved(2), {key: 'drag:f1', now: 1400});
  model = editorState.editPrevisModel(model, moved(3), {key: 'drag:f1', now: 1900});
  assert.equal(model.history.past.length, 1, 'a drag is one step');
  model = editorState.editPrevisModel(model, moved(4), {key: 'drag:f1', now: 2600});
  assert.equal(model.history.past.length, 2, 'a pause starts a new step');
  model = editorState.editPrevisModel(model, sceneEdits.updatePrevisLight(model.scene, {intensity: 2}), {key: 'light:intensity', now: 2700});
  assert.equal(model.history.past.length, 3);
  model = editorState.undoPrevisModel(model);
  assert.deepEqual(model.scene.figures[0]!.position, [4, 0, 0]);
  model = editorState.undoPrevisModel(editorState.undoPrevisModel(model));
  assert.equal(canonicalPrevisValue(model.scene), canonicalPrevisValue(base));
  assert.equal(editorState.canUndoPrevisModel(model), false);
  model = editorState.redoPrevisModel(model);
  assert.deepEqual(model.scene.figures[0]!.position, [3, 0, 0]);
  assert.equal(editorState.editPrevisModel(model, JSON.parse(JSON.stringify(model.scene))).history, model.history, 'an equal scene is no step');
  let long = history.emptyPrevisHistory(), current = base;
  for (let index = 1; index <= history.PREVIS_HISTORY_LIMIT + 20; index++) { const next = moved(index / 100); long = history.recordPrevisEdit(long, current, next); current = next; }
  assert.equal(long.past.length, history.PREVIS_HISTORY_LIMIT);
});
test('the selection follows the scene and names fall back to defaults', () => {
  let model = editorState.createPrevisEditorModel(defaultPrevisScene());
  const added = sceneEdits.addPrevisProp(model.scene, 'cup');
  model = editorState.editPrevisModel(model, added.scene, {select: added.id});
  assert.equal(model.selection, 'p1');
  model = editorState.undoPrevisModel(model);
  assert.equal(model.selection, null, 'undoing the add drops the selection');
  assert.equal(editorState.selectPrevisElement(model, 'p9').selection, null);
  assert.equal(editorState.selectPrevisElement(model, editorState.PREVIS_LIGHT_SELECTION).selection, 'light');
  let scene = sceneEdits.addPrevisProp(sceneEdits.addPrevisProp(defaultPrevisScene(), 'umbrella').scene, 'umbrella').scene;
  scene = sceneEdits.addPrevisProp(scene, 'box').scene;
  assert.deepEqual(scene.props.map(item => editorState.previsPropName(scene, item, t)), [`${zh('previs.kind.umbrella')} 1`, `${zh('previs.kind.umbrella')} 2`, zh('previs.kind.box')]);
  assert.equal(editorState.previsFigureName(scene.figures[0]!, t), '人偶 1');
  assert.equal(editorState.previsSceneSummary(scene, t), '1 个人偶 · 3 个道具 · 1 盏主光');
  scene = sceneEdits.updatePrevisLight(scene, {visible: false});
  assert.equal(editorState.previsSceneSummary(scene, t), '1 个人偶 · 3 个道具 · 主光已关闭');
  const replaced = editorState.replacePrevisModel(editorState.editPrevisModel(model, scene), defaultPrevisScene());
  assert.equal(replaced.history.past.length, 0, 'a reload starts a fresh undo history');
  // Orbiting without a selection turns around the line of sight at the scene's depth.
  const pivot = editorState.previsOrbitPivot(defaultPrevisScene(), null), sight = camera.previsViewDirection(0, -4);
  near(pivot[0], 0, 1e-9); assert.ok(Math.abs(pivot[2]) < 0.1, 'as deep as the default figure');
  near((pivot[1] - 1.6) / (pivot[2] - 4), sight[1] / sight[2], 1e-9);
  const empty = {...defaultPrevisScene(), figures: []};
  const floor = editorState.previsOrbitPivot({...empty, camera: {...empty.camera, pitch: -30}}, null);
  near(floor[1], 0, 1e-9);
  assert.equal(Math.round(Math.hypot(...editorState.previsOrbitPivot(empty, null).map((value, index) => value - empty.camera.position[index]!)) * 1000) / 1000, 4, 'an empty scene orbits four metres ahead');
  assert.deepEqual(editorState.previsOrbitPivot(defaultPrevisScene(), 'f1'), [0, 1.05, 0]);
});

// ---- Autosave against the real service ----
let saveSerial = 0;
function saverFor(node: PrevisNodeRecord, rpc: (operation: string, input: Row) => Promise<unknown>, options: {readOnly?: boolean} = {}) {
  const time = clock(), states: PrevisSaveState[] = [], saved: PrevisNodeRecord[] = [], requests: Row[] = [];
  const saver = createPrevisSaver({node, readOnly: options.readOnly, requestId: () => `previs-save-${++saveSerial}`, setTimer: time.setTimer, clearTimer: time.clearTimer,
    rpc: (operation, input) => { requests.push({operation, ...input}); return rpc(operation, input as Row); }, onState: state => states.push(state), onSaved: value => saved.push(value)});
  return {saver, time, states, saved, requests, status: () => saver.state().status};
}
test('autosave waits for a pause, saves one at a time and replays an uncertain save', async t => {
  const f = await services(t), node = await f.create();
  let failNext = false;
  const harness = saverFor(node, async (operation, input) => {
    const result = await f.wire(operation, input);
    // The save is applied but its answer is lost: the saver must resend the same request.
    if (failNext) { failNext = false; throw Object.assign(new Error('offline'), {code: 'NETWORK'}); }
    return result;
  });
  const first = sceneEdits.updatePrevisFigure(node.scene, 'f1', {position: [1, 0, 0]});
  harness.saver.schedule(first);
  harness.saver.schedule(sceneEdits.updatePrevisFigure(node.scene, 'f1', {position: [2, 0, 0]}));
  assert.equal(harness.status(), 'pending');
  await harness.time.advance(700);
  assert.equal(harness.requests.length, 0, 'nothing is sent while edits keep coming');
  await harness.time.advance(200);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.status(), 'saved');
  assert.equal(harness.saver.state().node.sceneRevision, 2);
  failNext = true;
  harness.saver.schedule(sceneEdits.updatePrevisFigure(node.scene, 'f1', {position: [3, 0, 0]}));
  await harness.time.advance(800);
  assert.equal(harness.status(), 'retrying');
  await harness.time.advance(1000);
  assert.equal(harness.status(), 'saved');
  const ids = harness.requests.map(item => item.requestId);
  assert.ok(ids.length === 3 && ids[1] === ids[2] && ids[0] !== ids[1], 'the retry is the same request');
  const stored = (await f.nodes()).find(item => item.id === node.id) as PrevisNodeRecord;
  assert.equal(stored.sceneRevision, 3, 'the replay applied the save once');
  assert.deepEqual(stored.scene.figures[0]!.position, [3, 0, 0]);
  // While a save is in flight a newer scene waits and follows it under the new revision.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = saverFor(stored, async (operation, input) => { await gate; return f.wire(operation, input); });
  slow.saver.schedule(sceneEdits.updatePrevisFigure(stored.scene, 'f1', {rotation: 10}));
  await slow.time.advance(800);
  slow.saver.schedule(sceneEdits.updatePrevisFigure(stored.scene, 'f1', {rotation: 20}));
  await slow.time.advance(800);
  assert.equal(slow.requests.length, 1, 'the second save waits for the first');
  release();
  assert.equal((await slow.saver.flush()).status, 'saved');
  assert.deepEqual(slow.requests.map(item => item.expectedSceneRevision), [3, 4]);
  assert.equal(slow.saver.state().node.sceneRevision, 5);
});
test('a conflict is read back: reload keeps the other scene, overwrite saves this one', async t => {
  const f = await services(t), node = await f.create();
  const harness = saverFor(node, (operation, input) => f.wire(operation, input));
  // Another window saves first.
  const theirs = await f.wire('previs.scene.set', {projectId: f.projectId, nodeId: node.id, expectedSceneRevision: 1, scene: sceneEdits.addPrevisFigure(node.scene).scene, requestId: randomUUID()}) as PrevisNodeRecord;
  const mine = sceneEdits.updatePrevisLight(node.scene, {intensity: 2});
  harness.saver.schedule(mine);
  await harness.time.advance(800);
  assert.equal(harness.status(), 'conflict');
  assert.equal(harness.saver.state().conflict?.sceneRevision, theirs.sceneRevision);
  harness.saver.schedule(sceneEdits.updatePrevisLight(node.scene, {intensity: 3}));
  await harness.time.advance(800);
  assert.equal(harness.requests.length, 1, 'saving stops until the conflict is resolved');
  await harness.saver.overwrite();
  assert.equal(harness.status(), 'saved');
  const stored = (await f.nodes()).find(item => item.id === node.id) as PrevisNodeRecord;
  assert.equal(stored.sceneRevision, 3);
  assert.equal(stored.scene.light.intensity, 3, 'the latest local scene wins');
  assert.equal(stored.scene.figures.length, 1);
  // Reload adopts the other version instead.
  const second = saverFor(stored, (operation, input) => f.wire(operation, input));
  await f.wire('previs.scene.set', {projectId: f.projectId, nodeId: node.id, expectedSceneRevision: 3, scene: theirs.scene, requestId: randomUUID()});
  second.saver.schedule(sceneEdits.updatePrevisLight(stored.scene, {intensity: 1.5}));
  await second.time.advance(800);
  assert.equal(second.status(), 'conflict');
  const latest = second.saver.reload()!;
  assert.equal(latest.sceneRevision, 4);
  assert.equal(second.status(), 'saved');
  assert.equal((await second.saver.flush()).node.sceneRevision, 4, 'nothing more is sent after a reload');
});
test('an earlier attempt applied before its receipt was pruned is recognised; refusals and read-only stop saving', async t => {
  const f = await services(t), node = await f.create();
  const applied = sceneEdits.updatePrevisFigure(node.scene, 'f1', {pose: 'walk'});
  const current = {...node, revision: 2, sceneRevision: 2, scene: applied};
  const conflict = saverFor(node, async () => { throw new ApiError('conflict', 'REVISION_CONFLICT', {current}, true, 409); });
  conflict.saver.schedule(applied);
  await conflict.time.advance(800);
  assert.equal(conflict.status(), 'saved', 'the node already holds exactly this save');
  assert.equal(conflict.saver.state().node.sceneRevision, 2);
  const refused = saverFor(node, async () => { throw new ApiError('denied', 'PREVIS_STATE_CONFLICT', undefined, true, 403); });
  refused.saver.schedule(applied);
  await refused.time.advance(800);
  assert.equal(refused.status(), 'failed');
  assert.equal(refused.saver.state().errorCode, 'PREVIS_STATE_CONFLICT');
  void refused.saver.retry();
  await refused.time.advance(10);
  assert.equal(new Set(refused.requests.map(item => item.requestId)).size, 2, 'a retry after a refusal is a new request');
  const full = saverFor(node, async () => { throw new ApiError('full', 'PREVIS_CAPACITY', undefined, false, 507); });
  full.saver.schedule(applied);
  await full.time.advance(800);
  assert.equal(full.status(), 'failed', 'capacity is not retried');
  const readOnly = saverFor(node, async () => assert.fail('a read-only editor never saves'), {readOnly: true});
  readOnly.saver.schedule(applied);
  await readOnly.time.advance(5000);
  assert.equal(readOnly.status(), 'readOnly');
  assert.equal(readOnly.time.pending(), 0);
});
test('a newer node from elsewhere replaces an idle editor and waits for a busy one', async t => {
  const f = await services(t), node = await f.create();
  const harness = saverFor(node, (operation, input) => f.wire(operation, input));
  const renamed = await f.wire('node.update', {nodeId: node.id, expectedRevision: 1, patch: {label: '雨夜街口'}, requestId: randomUUID()}) as PrevisNodeRecord;
  assert.equal(harness.saver.external(renamed), 'kept');
  assert.equal(harness.saver.state().node.label, '雨夜街口', 'a rename is adopted without touching the scene');
  const elsewhere = await f.wire('previs.scene.set', {projectId: f.projectId, nodeId: node.id, expectedSceneRevision: 1, scene: sceneEdits.addPrevisFigure(node.scene).scene, requestId: randomUUID()}) as PrevisNodeRecord;
  assert.equal(harness.saver.external(elsewhere), 'reloaded');
  assert.equal(harness.saver.state().node.sceneRevision, 2);
  harness.saver.schedule(sceneEdits.updatePrevisLight(elsewhere.scene, {intensity: 2}));
  const later = await f.wire('previs.scene.set', {projectId: f.projectId, nodeId: node.id, expectedSceneRevision: 2, scene: elsewhere.scene, requestId: randomUUID()}) as PrevisNodeRecord;
  assert.equal(harness.saver.external(later), 'kept', 'pending local edits are not dropped');
  await harness.time.advance(800);
  assert.equal(harness.status(), 'conflict');
});

// ---- Creating a previs node and reading card thumbnails ----
test('creating a previs node resends one request after an uncertain answer', async t => {
  const f = await services(t), requests: Row[] = [];
  let lose = true;
  const outcome = await createPrevisNode({projectId: f.projectId, label: '机位预演', position: {x: 120.4, y: 80.6}}, {requestId: () => 'previs-create-1', wait: async () => {},
    rpc: async (operation, input) => { requests.push(input); const result = await f.wire(operation, input); if (lose) { lose = false; throw Object.assign(new Error('offline'), {code: 'NETWORK'}); } return result; }});
  assert.equal(outcome.status, 'created');
  assert.ok(outcome.status === 'created' && isPrevisNodeRecord(outcome.node));
  assert.deepEqual(requests.map(item => [item.requestId, item.position]), [['previs-create-1', {x: 120, y: 81}], ['previs-create-1', {x: 120, y: 81}]]);
  assert.equal((await f.nodes()).filter(item => item.type === 'previs').length, 1, 'the replay created one node');
  const refused = await createPrevisNode({projectId: randomUUID(), label: '', position: {x: 0, y: 0}}, {requestId: () => randomUUID(), wait: async () => {}, rpc: (operation, input) => f.wire(operation, input)});
  assert.equal(refused.status, 'failed');
  const full = await createPrevisNode({projectId: f.projectId, label: '', position: {x: 0, y: 0}}, {requestId: () => randomUUID(), wait: async () => {}, rpc: async () => { throw new ApiError('full', 'PREVIS_CAPACITY', undefined, false, 507); }});
  assert.deepEqual(full, {status: 'failed', code: 'PREVIS_CAPACITY'});
  const lost = await createPrevisNode({projectId: f.projectId, label: '', position: {x: 0, y: 0}}, {requestId: () => randomUUID(), wait: async () => {}, rpc: async () => { throw new Error('offline'); }});
  assert.deepEqual(lost, {status: 'unknown'});
});
test('card thumbnails are read per scene revision and refreshed while older than the scene', async t => {
  const f = await services(t), node = await f.create(), time = clock(), reads: Row[] = [];
  const published: Record<string, {url: string; sceneRevision: number}>[] = [];
  const thumbnails = createPrevisThumbnails({read: (operation, input) => { reads.push(input); return f.wire(operation, input); }, onChange: value => published.push({...value}), setTimer: time.setTimer, clearTimer: time.clearTimer});
  thumbnails.setNodes(f.projectId, [{id: node.id, sceneRevision: 1}]);
  await settle();
  assert.equal(reads.length, 1);
  assert.deepEqual(thumbnails.get(), {}, 'no thumbnail yet');
  const bytes = jpeg(384, 216).toString('base64');
  await f.wire('previs.thumbnail.set', {projectId: f.projectId, nodeId: node.id, slot: 'card', sceneRevision: 1, dataBase64: bytes});
  await time.advance(3000);
  assert.equal(reads.length, 2, 'an empty card asks again once the editor had time to upload');
  assert.deepEqual(thumbnails.get()[node.id], {url: previsThumbnailUrl(bytes), sceneRevision: 1});
  thumbnails.setNodes(f.projectId, [{id: node.id, sceneRevision: 1}]);
  await settle();
  assert.equal(reads.length, 2, 'an unchanged revision is not read again');
  // The editor's own upload shows at once.
  thumbnails.put(f.projectId, node.id, 2, bytes);
  assert.equal(thumbnails.get()[node.id]?.sceneRevision, 2);
  thumbnails.setNodes(f.projectId, [{id: node.id, sceneRevision: 2}]);
  await settle();
  assert.equal(reads.length, 2, 'a thumbnail as new as the scene needs no read');
  thumbnails.setNodes(randomUUID(), []);
  assert.deepEqual(thumbnails.get(), {}, 'another project starts empty');
  assert.ok(published.length >= 3);
  thumbnails.dispose();
});

// ---- Components ----
const nodes = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const byId = (tree: ElementTree, testId: string): ElementNode | undefined => nodes(tree).find(node => node.props?.['data-testid'] === testId);
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ElementNode).props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
// Renders a component and every function component below it, with hooks kept
// in call order between renders of the same tree.
function harness(file: string) {
  const slots: {value?: unknown; deps?: readonly unknown[]; current?: unknown}[] = [];
  let cursor = 0;
  const react = {
    Fragment: 'Fragment', Component: class {}, Suspense: 'Suspense',
    createElement: (type: unknown, props: Row | null, ...children: ElementTree[]) => ({type, props: {...props, children: children.length === 1 ? children[0] : children}}),
    memo: (component: unknown) => component, lazy: () => 'Lazy',
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ||= {current: value}; },
    useState: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = {value: typeof value === 'function' ? (value as () => unknown)() : value}; const slot = slots[index]!; return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next; }]; },
    useMemo: (fn: () => unknown, deps: readonly unknown[]) => { const index = cursor++; if (!slots[index] || deps.some((value, at) => value !== slots[index]!.deps![at])) slots[index] = {value: fn(), deps}; return slots[index]!.value; },
    useCallback: (fn: unknown) => { cursor++; return fn; },
    useLayoutEffect: () => { cursor++; }, useEffect: () => { cursor++; },
  };
  const visible = {value: true};
  const modules: Record<string, Row> = {};
  const real: Record<string, unknown> = {'previs-editor-state.ts': editorState, 'previs-scene.ts': sceneEdits, 'previs-camera.ts': camera, 'previs-keyframes.ts': keyframes, 'previs-output.ts': output};
  function load(name: string): Row {
    if (modules[name]) return modules[name]!;
    const source = readFileSync(path.join(root, 'apps/web/src', name), 'utf8'), module = {exports: {} as Row};
    const code = transformSync(source, {loader: name.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs'}).code;
    modules[name] = module.exports;
    Function('require', 'module', 'exports', code)((request: string) => {
      if (request === 'react') return {...react, default: react};
      if (request === '@mioon/contracts') return contracts;
      if (request === '@xyflow/react') return {Handle: 'Handle', Position: {Left: 'left', Right: 'right'}};
      if (request.endsWith('.css')) return {};
      if (request.endsWith('i18n/I18nProvider.tsx')) return {useI18n: () => i18nTestModule('zh-Hans').useI18n()};
      if (request.endsWith('workspace-visibility.tsx')) return {useWorkspaceVisibility: () => visible.value};
      if (request.endsWith('reference-connections.ts')) return {VISUAL_SOURCE_HANDLE: 'visual-source', VISUAL_TARGET_HANDLE: 'visual-target'};
      if (request.endsWith('packages/i18n/src/index.ts')) return i18nIndex;
      if (request.endsWith('BoardInspectorGroup.tsx')) return {__esModule: true, default: 'BoardInspectorGroup'};
      if (request.endsWith('WorkspaceControls.tsx')) return {WorkbenchSelect: 'WorkbenchSelect'};
      const base = path.basename(request);
      if (real[base]) return real[base];
      if (request.startsWith('.') && /\.tsx$/u.test(request)) return load(path.posix.normalize(path.posix.join(path.posix.dirname(name), request)));
      return new Proxy({}, {get: (_, key) => key === '__esModule' ? false : String(key)});
    }, module, module.exports);
    return modules[name] = module.exports;
  }
  const component = load(file);
  const expand = (value: unknown): ElementTree => {
    if (Array.isArray(value)) return value.map(expand) as ElementTree;
    if (!value || typeof value !== 'object') return value as ElementTree;
    const element = value as {type: unknown; props: Row};
    if (typeof element.type === 'function') return expand((element.type as (props: Row) => unknown)(element.props));
    return {type: element.type, props: {...element.props, children: expand(element.props.children)}} as ElementNode;
  };
  const render = (props: Row, name = 'default'): ElementTree => { cursor = 0; return expand((component[name] as (props: Row) => unknown)(props)); };
  return {render, visible, module: component};
}
const click = (node: ElementNode | undefined): unknown => { assert.ok(node, 'the control exists'); return (node.props.onClick as () => unknown)(); };
function previsRecord(scene: PrevisScene = defaultPrevisScene(), patch: Partial<PrevisNodeRecord> = {}): PrevisNodeRecord {
  return {id: randomUUID(), projectId: randomUUID(), type: 'previs', label: '机位预演 · 雨夜街口', text: '', position: {x: 0, y: 0}, revision: 3, sceneRevision: 2, scene, createdAt: new Date().toISOString(), ...patch};
}

test('the canvas card shows the thumbnail, keyframe count, frame and local rendering', () => {
  const {render} = harness('previs/PrevisNode.tsx'), record = previsRecord();
  let tree = render({data: {record, thumbnail: null, ratio: '9:16'}, selected: false});
  assert.match(text(tree), /机位预演 · 雨夜街口/);
  assert.match(text(tree), /双击打开预演/);
  assert.equal(byId(tree, `previs-node-keyframes-${record.id}`), undefined, 'no badge without keyframes');
  assert.match(text(tree), /9:16本地渲染/);
  const withKeyframes = {...record, scene: {...record.scene, keyframes: [{id: 'k1', name: '', camera: record.scene.camera, exports: []}, {id: 'k2', name: '', camera: record.scene.camera, exports: []}]}};
  tree = render({data: {record: withKeyframes, thumbnail: 'data:image/jpeg;base64,AAAA', ratio: '16:9'}, selected: true});
  assert.equal(byId(tree, `previs-node-thumbnail-${record.id}`)?.props.src, 'data:image/jpeg;base64,AAAA');
  assert.equal(text(byId(tree, `previs-node-keyframes-${record.id}`)), '2 个关键帧');
  assert.equal(byId(tree, `previs-node-${record.id}`)?.props.className, 'canvas-node previs-node is-selected');
});
test('the inspector names the node, follows the project frame and opens the editor', () => {
  const {render, visible} = harness('previs/PrevisInspector.tsx');
  let scene = sceneEdits.addPrevisFigure(defaultPrevisScene()).scene;
  scene = sceneEdits.addPrevisProp(sceneEdits.addPrevisProp(scene, 'umbrella').scene, 'box').scene;
  const renames: string[] = [], opened: number[] = [];
  const props = {node: previsRecord(scene), frame: {width: 1080, height: 1920, ratio: '9:16'}, readOnly: false, busy: false, onRename: (label: string) => { renames.push(label); }, onOpen: () => { opened.push(1); }};
  let tree = render(props);
  assert.equal(byId(tree, 'previs-node-name')?.props.value, '机位预演 · 雨夜街口');
  assert.match(text(byId(tree, 'previs-node-frame')), /^9:161080×1920跟随项目$/);
  assert.equal(text(byId(tree, 'previs-node-summary')), '2 个人偶 · 2 个道具 · 1 盏主光');
  const input = byId(tree, 'previs-node-name')!;
  (input.props.onFocus as () => void)();
  (input.props.onChange as (event: unknown) => void)({target: {value: '雨夜街口'}});
  tree = render(props);
  (byId(tree, 'previs-node-name')!.props.onBlur as () => void)();
  assert.deepEqual(renames, ['雨夜街口']);
  click(byId(tree, 'previs-open'));
  assert.deepEqual(opened, [1]);
  tree = render({...props, readOnly: true});
  assert.equal(byId(tree, 'previs-node-name')?.props.disabled, true);
  assert.match(text(tree), /恢复副本里只能查看预演/);
  assert.equal(byId(tree, 'previs-open')?.props.disabled, false, 'a restored copy can still be viewed');
  visible.value = false;
  assert.equal(byId(render(props), 'previs-open')?.props.disabled, true);
});
test('the toolbar adds a previs between the shot and text buttons', () => {
  const {render} = harness('CanvasToolbar.tsx'), calls: string[] = [];
  const props = {scope: 's', onAddShot: () => calls.push('shot'), onAddPrevis: () => calls.push('previs'), onAddText: () => calls.push('text'), onAddImage: () => {}, onAddVideo: () => {}, onGenerateImage: () => {}};
  const tree = render(props), ids = nodes(tree).map(node => node.props?.['data-testid']).filter(Boolean);
  assert.deepEqual(ids.slice(0, 3), ['add-shot', 'add-previs-node', 'add-text-node']);
  assert.equal(text(byId(tree, 'add-previs-node')), '预演');
  assert.equal(byId(render({...props, previsDisabled: true}), 'add-previs-node')?.props.disabled, true);
  assert.equal(byId(render({...props, onAddPrevis: undefined}), 'add-previs-node'), undefined);
});
test('the outline lists figures, props and the light with visibility toggles', () => {
  const {render} = harness('previs/PrevisOutline.tsx');
  let scene = sceneEdits.addPrevisProp(defaultPrevisScene(), 'umbrella').scene;
  scene = sceneEdits.holdPrevisProp(sceneEdits.updatePrevisFigure(scene, 'f1', {name: '周屿', pose: 'hold'}), 'f1', 'p1', 'right');
  const calls: unknown[][] = [];
  const props = {scene, selection: 'f1', readOnly: false, onSelect: (value: unknown) => calls.push(['select', value]), onVisible: (id: string, value: boolean) => calls.push(['visible', id, value]), onAddFigure: () => calls.push(['figure']), onAddProp: (kind: string) => calls.push(['prop', kind])};
  const tree = render(props);
  assert.equal(text(byId(tree, 'previs-outline-f1')), '周屿持物');
  assert.equal(text(byId(tree, 'previs-outline-p1')), '伞周屿 · 右手');
  assert.equal(text(byId(tree, 'previs-outline-light')), '主光强度 1');
  assert.equal(byId(tree, 'previs-outline-f1')?.props['aria-pressed'], true);
  click(byId(tree, 'previs-outline-f1'));
  click(byId(tree, 'previs-outline-p1'));
  click(byId(tree, 'previs-visible-light'));
  click(byId(tree, 'previs-add-figure'));
  click(byId(tree, 'previs-add-prop-cup'));
  assert.deepEqual(calls, [['select', null], ['select', 'p1'], ['visible', 'light', false], ['figure'], ['prop', 'cup']]);
  let full = defaultPrevisScene();
  for (let index = 1; index < PREVIS_LIMITS.figures; index++) full = sceneEdits.addPrevisFigure(full).scene;
  assert.equal(byId(render({...props, scene: full}), 'previs-add-figure')?.props.disabled, true);
  assert.equal(byId(render({...props, readOnly: true}), 'previs-visible-f1')?.props.disabled, true);
});
test('the properties panel edits poses, held props, transforms and the key light', () => {
  const {render} = harness('previs/PrevisProperties.tsx');
  let scene = sceneEdits.addPrevisFigure(defaultPrevisScene()).scene;
  scene = sceneEdits.addPrevisProp(sceneEdits.addPrevisProp(sceneEdits.addPrevisProp(scene, 'umbrella').scene, 'phone').scene, 'box').scene;
  scene = sceneEdits.holdPrevisProp(scene, 'f2', 'p2');
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const props = {scene, selection: 'f1', readOnly: false, shortcut: '⌘Z', onFigure: record('figure'), onProp: record('prop'), onLight: record('light'), onCamera: record('camera'), onHold: record('hold'), onRemove: record('remove')};
  let tree = render(props);
  click(byId(tree, 'previs-pose-walk'));
  assert.deepEqual(calls.pop(), ['figure', 'f1', {pose: 'walk'}]);
  const held = byId(tree, 'previs-held')!;
  assert.deepEqual(nodes(held.props.children as ElementTree).filter(node => node.type === 'option').map(node => node.props.value), ['', 'p1'], 'only free carriable props are offered');
  (held.props.onChange as (event: unknown) => void)({target: {value: 'p1'}});
  assert.deepEqual(calls.pop(), ['hold', 'f1', 'p1', 'right']);
  assert.equal(byId(tree, 'previs-hand-left')?.props.disabled, true, 'a hand is chosen once something is held');
  const x = byId(tree, 'previs-figure-position-0')!;
  (x.props.onBlur as (event: unknown) => void)({currentTarget: {value: '0.8'}});
  assert.deepEqual(calls.pop(), ['figure', 'f1', {position: [0.8, 0, 0]}, 'figure:f1:position']);
  click(byId(tree, 'previs-remove'));
  assert.deepEqual(calls.pop(), ['remove', 'f1']);
  (byId(tree, 'previs-light-intensity-slider')!.props.onChange as (event: unknown) => void)({target: {value: '2.5'}});
  assert.deepEqual(calls.pop(), ['light', {intensity: 2.5}, 'light:intensity']);
  assert.match(text(tree), /改动自动保存到节点，⌘Z 撤销/);
  tree = render({...props, selection: 'p2'});
  assert.match(text(byId(tree, 'previs-held-note')), /人偶 2拿着/);
  assert.equal(byId(tree, 'previs-prop-position-0')?.props.disabled, true, 'a held prop moves with its holder');
  tree = render({...props, selection: null});
  (byId(tree, 'previs-camera-focal')!.props.onBlur as (event: unknown) => void)({currentTarget: {value: '400'}});
  assert.deepEqual(calls.pop(), ['camera', {...scene.camera, focalLength: 300}, 'camera:focal']);
  tree = render({...props, readOnly: true});
  assert.equal(byId(tree, 'previs-pose-walk')?.props.disabled, true);
});

// ---- Source rules ----
function sources(directory: string): string[] {
  return readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? sources(`${directory}/${entry.name}`) : /\.(?:tsx?|css)$/u.test(entry.name) ? [`${directory}/${entry.name}`] : []);
}
test('only the lazily loaded editor imports three.js', () => {
  const files = sources('apps/web/src'), read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
  const three = files.filter(file => /from\s+['"]three['"]|import\(\s*['"]three['"]\s*\)|require\(\s*['"]three['"]\s*\)/u.test(read(file)));
  assert.deepEqual(three.sort(), ['apps/web/src/previs/previs-mannequin.ts', 'apps/web/src/previs/previs-props.ts', 'apps/web/src/previs/previs-viewport.ts']);
  const viewportUsers = files.filter(file => /from\s+['"]\.\/previs-viewport\.ts['"]/u.test(read(file)) && !/^import\s+type\b/mu.test(read(file).match(/^.*previs-viewport\.ts.*$/mu)?.[0] ?? ''));
  assert.deepEqual(viewportUsers, ['apps/web/src/previs/PrevisEditor.tsx']);
  for (const file of files.filter(item => item !== 'apps/web/src/previs/PrevisEditor.tsx')) {
    for (const line of read(file).split('\n').filter(item => /PrevisEditor\.tsx['"]/u.test(item) && /^\s*import\b/u.test(item)))
      assert.match(line, /^import type\b/u, `${file} imports the editor statically`);
  }
  assert.match(read('apps/web/src/previs/PrevisEditorHost.tsx'), /import\('\.\/PrevisEditor\.tsx'\)/u);
  assert.equal(JSON.parse(read('apps/web/package.json')).dependencies.three, '0.186.1', 'three.js is pinned exactly');
});
test('previs styles use workbench tokens and readable sizes', () => {
  const css = readFileSync(path.join(root, 'apps/web/src/previs/previs.css'), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, 'colours come from tokens');
  for (const match of css.matchAll(/font-size:\s*([^;}]+)/gu)) {
    const value = match[1]!.trim();
    if (value.startsWith('var(--wb-text-')) continue;
    const pixels = Number(/^(\d+(?:\.\d+)?)px$/u.exec(value)?.[1]);
    assert.ok(pixels >= 10, `font-size ${value} is at least 10px`);
  }
});
