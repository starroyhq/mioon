import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
import * as contracts from '@mioon/contracts';
import {PREVIS_LIMITS, defaultPrevisScene, isPrevisScene} from '@mioon/contracts';
import type {PrevisNodeRecord, PrevisScene} from '@mioon/contracts';
import * as camera from '../apps/web/src/previs/previs-camera.ts';
import * as sceneEdits from '../apps/web/src/previs/previs-scene.ts';
import * as editorState from '../apps/web/src/previs/previs-editor-state.ts';
import * as keyframes from '../apps/web/src/previs/previs-keyframes.ts';
import * as output from '../apps/web/src/previs/previs-output.ts';
import type {PrevisShotView} from '../apps/web/src/previs/previs-output.ts';
import * as playback from '../apps/web/src/previs/previs-playback.ts';
import * as i18nIndex from '../packages/i18n/src/index.ts';
import {i18nTestModule, translate} from './helpers/i18n.ts';
import type {ElementNode, ElementTree} from './helpers/strict-timeline-audio-harness-types.ts';
type Row = Record<string, unknown>;
const zh = (key: string, params: Record<string, string | number> = {}): string => translate('zh-Hans', key as never, params as never);
const t = zh as keyframes.PrevisTranslate;
const root = fileURLToPath(new URL('../', import.meta.url));
const asset = (): string => randomUUID();
const cam = (focalLength: number, x = 0): contracts.PrevisCamera => ({position: [x, 1.6, 4], yaw: 0, pitch: -4, focalLength});
function withKeyframes(...focals: number[]): PrevisScene {
  let scene = defaultPrevisScene();
  for (const focal of focals) scene = keyframes.addPrevisKeyframe({...scene, camera: cam(focal)}).scene;
  return scene;
}
const shot = (patch: Partial<PrevisShotView> = {}): PrevisShotView => ({id: randomUUID(), title: '周屿撑伞等候', orderIndex: 2, aspectRatio: '9:16', referenceAssetIds: [], lastFrameAssetId: null, revision: 3, ...patch});

// ---- Keyframe edits ----
test('keyframes are recorded, renamed, reordered and removed inside the contract', () => {
  let scene = withKeyframes(24, 35, 85);
  assert.deepEqual(scene.keyframes.map(item => item.id), ['k1', 'k2', 'k3']);
  assert.equal(scene.activeKeyframeId, 'k3', 'a new keyframe becomes active');
  assert.deepEqual(scene.keyframes.map(item => keyframes.previsKeyframeName(item, t)), ['全景', '中景', '近景'], 'unnamed keyframes are named by shot size');
  assert.deepEqual([18, 30, 50, 120].map(focal => camera.previsShotSize(focal)), ['wide', 'medium', 'mediumClose', 'close']);
  scene = keyframes.renamePrevisKeyframe(scene, 'k2', '  雨夜\n街口😀😀😀😀😀😀😀😀😀😀  ');
  assert.equal(scene.keyframes[1]!.name, '雨夜街口😀😀😀😀😀😀😀😀', 'names are trimmed, cleaned and kept within 20 units');
  assert.equal(keyframes.renamePrevisKeyframe(scene, 'k9', 'x'), scene);
  scene = keyframes.movePrevisKeyframe(scene, 'k3', 0);
  assert.deepEqual(scene.keyframes.map(item => item.id), ['k3', 'k1', 'k2']);
  assert.equal(keyframes.movePrevisKeyframe(scene, 'k3', -5), scene, 'moving past the start stays first');
  assert.deepEqual(keyframes.movePrevisKeyframe(scene, 'k3', 99).keyframes.map(item => item.id), ['k1', 'k2', 'k3']);
  assert.deepEqual(scene.keyframes.map((_, index) => keyframes.previsKeyframeLabel(index)), ['K1', 'K2', 'K3'], 'labels follow the order');
  scene = keyframes.removePrevisKeyframe(scene, 'k3');
  assert.equal(scene.activeKeyframeId, null, 'removing the active keyframe clears it');
  assert.equal(keyframes.addPrevisKeyframe(scene).id, 'k3', 'a saved scene without K3 frees its ID');
  assert.equal(keyframes.addPrevisKeyframe(scene, scene.camera, ['k1', 'k2', 'k3']).id, 'k4', 'IDs seen while editing are not reused');
  let full = defaultPrevisScene();
  for (let index = 0; index < PREVIS_LIMITS.keyframes; index++) full = keyframes.addPrevisKeyframe(full).scene;
  assert.equal(keyframes.canAddPrevisKeyframe(full), false);
  assert.deepEqual(keyframes.addPrevisKeyframe(full), {scene: full, id: ''});
  assert.ok(isPrevisScene(full) && isPrevisScene(scene));
});
test('jumping moves the camera to a keyframe, which stays current until the camera moves', () => {
  let scene = withKeyframes(24, 85);
  scene = {...scene, camera: cam(50, 2)};
  assert.equal(keyframes.isPrevisKeyframeCurrent(scene, 'k2'), false);
  scene = keyframes.jumpToPrevisKeyframe(scene, 'k1');
  assert.deepEqual(scene.camera, scene.keyframes[0]!.camera);
  assert.equal(scene.activeKeyframeId, 'k1');
  assert.equal(keyframes.isPrevisKeyframeCurrent(scene, 'k1'), true);
  assert.equal(keyframes.jumpToPrevisKeyframe(scene, 'k1'), scene, 'jumping to the current keyframe changes nothing');
  assert.equal(keyframes.isPrevisKeyframeCurrent({...scene, camera: cam(24, 0.5)}, 'k1'), false, 'moving the camera leaves the keyframe');
});
test('exports keep the newest four per keyframe, belong to one keyframe and survive undo', () => {
  const ids = Array.from({length: 6}, asset);
  let scene = withKeyframes(24, 35);
  for (const id of ids.slice(0, 5)) scene = keyframes.recordPrevisExport(scene, 'k1', id);
  assert.deepEqual(scene.keyframes[0]!.exports, ids.slice(1, 5));
  scene = keyframes.recordPrevisExport(scene, 'k1', ids[2]!.toUpperCase());
  assert.deepEqual(scene.keyframes[0]!.exports, [ids[1], ids[3], ids[4], ids[2]!.toUpperCase()], 'a re-recorded image moves to the end');
  scene = keyframes.recordPrevisExport(scene, 'k2', ids[4]!);
  assert.deepEqual([scene.keyframes[0]!.exports.length, scene.keyframes[1]!.exports], [3, [ids[4]]], 'another keyframe lets the image go');
  assert.ok(isPrevisScene(scene), 'an image belongs to one keyframe');
  // The editor model: an export is not an undo step, and undo keeps it.
  let model = editorState.createPrevisEditorModel(withKeyframes(24));
  model = editorState.editPrevisModel(model, sceneEdits.updatePrevisLight(model.scene, {intensity: 2}));
  model = editorState.recordPrevisModelExport(model, 'k1', ids[5]!);
  assert.equal(model.history.past.length, 1, 'recording an export adds no step');
  model = editorState.undoPrevisModel(model);
  assert.equal(model.scene.light.intensity, 1);
  assert.deepEqual(model.scene.keyframes[0]!.exports, [ids[5]], 'undo keeps the export');
  model = editorState.redoPrevisModel(model);
  assert.deepEqual([model.scene.light.intensity, model.scene.keyframes[0]!.exports], [2, [ids[5]]]);
  // Content keys: what a keyframe picture depends on.
  const base = withKeyframes(35), key = keyframes.previsKeyframeContentKey(base, base.keyframes[0]!);
  assert.equal(keyframes.previsKeyframeContentKey({...base, camera: cam(85, 3)}, base.keyframes[0]!), key, 'the current camera does not matter');
  assert.equal(keyframes.previsKeyframeContentKey(keyframes.recordPrevisExport(base, 'k1', asset()), base.keyframes[0]!), key, 'exports do not matter');
  assert.notEqual(keyframes.previsKeyframeContentKey(sceneEdits.updatePrevisFigure(base, 'f1', {pose: 'sit'}), base.keyframes[0]!), key);
});

// ---- Shots fed by the previs ----
test('links, frame labels and uses are derived from the shots\' current frames', () => {
  const first = asset(), last = asset(), unrelated = asset();
  let scene = withKeyframes(24, 35, 85);
  scene = keyframes.recordPrevisExport(keyframes.recordPrevisExport(scene, 'k2', first), 'k3', last);
  const nodeId = randomUUID(), a = shot({orderIndex: 2, referenceAssetIds: [first]}), b = shot({orderIndex: 0, lastFrameAssetId: last, referenceAssetIds: [unrelated]}), c = shot({orderIndex: 1});
  const edges = [{id: 'e1', source: nodeId, target: a.id}, {id: 'e2', source: nodeId, target: b.id}, {id: 'e3', source: randomUUID(), target: c.id, kind: 'reference'}, {id: 'e4', source: nodeId, target: c.id, kind: 'reference'}];
  assert.deepEqual(output.previsConnectedShots(nodeId, [a, b, c], edges).map(item => item.id), [b.id, a.id], 'visual links only, in storyboard order');
  assert.equal(output.previsEdgeLabel(scene, a, t), '首帧 · K2');
  assert.equal(output.previsEdgeLabel(scene, b, t), '尾帧 · K3');
  assert.equal(output.previsEdgeLabel(scene, {...a, lastFrameAssetId: last}, t), '首帧 · K2 / 尾帧 · K3');
  assert.equal(output.previsEdgeLabel(scene, c, t), null);
  assert.equal(output.previsEdgeLabel(keyframes.movePrevisKeyframe(scene, 'k2', 0), a, t), '首帧 · K1', 'labels follow the keyframe order');
  const uses = output.previsKeyframeUses(scene, [a, b, c]);
  assert.deepEqual([...uses.keys()], ['k3', 'k2'], 'uses are listed in storyboard order');
  assert.deepEqual(uses.get('k2')!.map(use => [use.shot.id, use.role]), [[a.id, 'first']]);
  assert.equal(output.previsKeyframeSupplies(scene, 'k2', a, 'first'), true);
  assert.equal(output.previsKeyframeSupplies(scene, 'k3', a, 'first'), false);
  assert.equal(output.previsShotNumber(a), '03');
});
test('a keyframe image cannot become a frame the shot cannot take', () => {
  const image = asset(), other = asset(), target = shot({lastFrameAssetId: other});
  const issue = (patch: Partial<PrevisShotView>, role: output.PrevisFrameRole, ratio = '9:16', edges: output.PrevisEdgeView[] = [], assetId: string | null = image) =>
    output.previsFrameIssue({shot: {...target, ...patch}, role, ratio, edges, assetId});
  assert.equal(issue({}, 'first'), null);
  assert.equal(issue({aspectRatio: '16:9'}, 'first'), 'aspect');
  assert.equal(issue({}, 'last', '1080:1920'), null, 'ratios compare by value');
  assert.equal(issue({}, 'first', '4:5'), 'aspect');
  assert.equal(issue({}, 'first', '9:16', [{id: 'r', source: randomUUID(), target: target.id, kind: 'reference'}]), 'reference', 'a canvas link controls the first frame');
  assert.equal(issue({}, 'last', '9:16', [{id: 'r', source: randomUUID(), target: target.id, kind: 'reference'}]), null, 'the last frame is free');
  assert.equal(issue({}, 'first', '9:16', [], other), 'duplicate', 'the same image cannot be both ends');
  assert.equal(issue({referenceAssetIds: [image]}, 'last'), 'duplicate');
  for (const reason of ['aspect', 'reference', 'duplicate', 'text', 'pending', 'missing'] as const) assert.ok(zh(output.PREVIS_FRAME_ISSUE_KEYS[reason]).trim(), reason);
});
test('a keyframe lists what its camera frames', () => {
  let scene = sceneEdits.addPrevisFigure(defaultPrevisScene()).scene;
  scene = sceneEdits.updatePrevisFigure(scene, 'f1', {name: '林夏', position: [0, 0, 0]});
  scene = sceneEdits.updatePrevisFigure(scene, 'f2', {name: '周屿', position: [0, 0, 8]});
  scene = sceneEdits.addPrevisProp(sceneEdits.addPrevisProp(scene, 'box').scene, 'umbrella').scene;
  scene = sceneEdits.updatePrevisProp(scene, 'p1', {name: '便利店门', position: [0.5, 0, -2]});
  scene = sceneEdits.holdPrevisProp(scene, 'f1', 'p2');
  const view: contracts.PrevisCamera = {position: [0, 1.6, 4], yaw: 0, pitch: -4, focalLength: 24};
  assert.deepEqual(output.previsFramedNames(scene, view, 9 / 16, t), ['林夏', '便利店门', '伞'], 'the figure behind the camera is not framed');
  assert.deepEqual(output.previsFramedNames(scene, {...view, yaw: 180}, 9 / 16, t), ['周屿']);
  assert.deepEqual(output.previsFramedNames(sceneEdits.updatePrevisFigure(scene, 'f1', {visible: false}), view, 9 / 16, t), ['便利店门'], 'a hidden holder hides its prop');
  assert.deepEqual(output.previsFramedNames(scene, {...view, focalLength: 300, yaw: 40}, 9 / 16, t), []);
  // Names come from the shared frustum estimate, which reports IDs in scene order.
  assert.deepEqual(contracts.previsFramedElements(scene, view, 9 / 16), {figures: ['f1'], props: ['p1', 'p2']});
});

// ---- Playback ----
test('playback eases from keyframe to keyframe in strip order and turns the short way round', () => {
  const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  const segment = playback.PREVIS_PLAYBACK_SEGMENT_MS, key = (id: string, view: contracts.PrevisCamera) => ({id, name: '', camera: view, exports: []});
  const frames = [key('k1', {position: [0, 1.6, 4], yaw: 170, pitch: -4, focalLength: 24}), key('k2', {position: [2, 1.2, 2], yaw: -170, pitch: 6, focalLength: 85}),
    key('k3', {position: [2, 1.2, 0], yaw: -90, pitch: 0, focalLength: 50})];
  assert.equal(playback.canPlayPrevisKeyframes(frames.slice(0, 1)), false);
  assert.equal(playback.canPlayPrevisKeyframes(frames), true);
  assert.equal(playback.previsPlaybackDuration(frames.length), 2 * segment);
  assert.equal(playback.previsPlaybackCamera([], 0), null);
  assert.deepEqual(playback.previsPlaybackCamera(frames, -16), frames[0]!.camera, 'an early frame shows the first keyframe');
  const middle = playback.previsPlaybackCamera(frames, segment / 2)!;
  middle.position.forEach((value, index) => near(value, [1, 1.4, 3][index]!));
  near(middle.yaw, 180); near(middle.pitch, 1); near(middle.focalLength, 54.5);
  // Smoothstep: a quarter of the way in time is 15.625% of the way along, then past ±180 the short way.
  const early = playback.previsPlaybackCamera(frames, segment / 4)!;
  near(early.focalLength, 24 + 61 * 0.15625); near(early.yaw, 170 + 20 * 0.15625);
  near(playback.previsPlaybackCamera(frames, segment * 3 / 4)!.yaw, 170 + 20 * 0.84375 - 360);
  assert.deepEqual(playback.previsPlaybackCamera(frames, segment), frames[1]!.camera, 'each keyframe is reached exactly');
  assert.deepEqual(playback.previsPlaybackCamera(frames, 2 * segment + playback.PREVIS_PLAYBACK_HOLD_MS), frames[2]!.camera, 'the last keyframe holds');
});

// ---- Components ----
const nodes = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const byId = (tree: ElementTree, testId: string): ElementNode | undefined => nodes(tree).find(node => node.props?.['data-testid'] === testId);
const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ElementNode).props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
function harness(file: string) {
  const slots: {value?: unknown; deps?: readonly unknown[]; current?: unknown}[] = [];
  let cursor = 0;
  const react = {
    Fragment: 'Fragment',
    createElement: (type: unknown, props: Row | null, ...children: ElementTree[]) => ({type, props: {...props, children: children.length === 1 ? children[0] : children}}),
    memo: (component: unknown) => component,
    useRef: (value: unknown) => { const index = cursor++; return slots[index] ||= {current: value}; },
    useState: (value: unknown) => { const index = cursor++; if (!slots[index]) slots[index] = {value: typeof value === 'function' ? (value as () => unknown)() : value}; const slot = slots[index]!; return [slot.value, (next: unknown) => { slot.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next; }]; },
    useMemo: (fn: () => unknown) => { cursor++; return fn(); },
    useCallback: (fn: unknown) => { cursor++; return fn; },
    useLayoutEffect: () => { cursor++; }, useEffect: () => { cursor++; },
  };
  const real: Record<string, unknown> = {'previs-editor-state.ts': editorState, 'previs-scene.ts': sceneEdits, 'previs-camera.ts': camera, 'previs-keyframes.ts': keyframes, 'previs-output.ts': output};
  function load(name: string): Row {
    const source = readFileSync(path.join(root, 'apps/web/src', name), 'utf8'), module = {exports: {} as Row};
    const code = transformSync(source, {loader: name.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs'}).code;
    Function('require', 'module', 'exports', code)((request: string) => {
      if (request === 'react') return {...react, default: react};
      if (request === '@mioon/contracts') return contracts;
      if (request.endsWith('.css')) return {};
      if (request.endsWith('i18n/I18nProvider.tsx')) return {useI18n: () => i18nTestModule('zh-Hans').useI18n()};
      if (request.endsWith('workspace-visibility.tsx')) return {useWorkspaceVisibility: () => true};
      if (request.endsWith('packages/i18n/src/index.ts')) return i18nIndex;
      if (request.endsWith('BoardInspectorGroup.tsx')) return {__esModule: true, default: 'BoardInspectorGroup'};
      const base = path.basename(request);
      if (real[base]) return real[base];
      return new Proxy({}, {get: (_, key) => key === '__esModule' ? false : String(key)});
    }, module, module.exports);
    return module.exports;
  }
  const component = load(file);
  const expand = (value: unknown): ElementTree => {
    if (Array.isArray(value)) return value.map(expand) as ElementTree;
    if (!value || typeof value !== 'object') return value as ElementTree;
    const element = value as {type: unknown; props: Row};
    if (typeof element.type === 'function') return expand((element.type as (props: Row) => unknown)(element.props));
    return {type: element.type, props: {...element.props, children: expand(element.props.children)}} as ElementNode;
  };
  return {render: (props: Row): ElementTree => { cursor = 0; return expand((component.default as (props: Row) => unknown)(props)); }};
}
test('the keyframe strip shows cards, their uses and the menu actions', () => {
  const {render} = harness('previs/PrevisKeyframes.tsx'), first = asset();
  let scene = keyframes.recordPrevisExport(withKeyframes(24, 35, 85), 'k2', first);
  scene = keyframes.jumpToPrevisKeyframe(scene, 'k2');
  const connectedShot = shot({orderIndex: 2, referenceAssetIds: [first]}), wide = shot({orderIndex: 4, aspectRatio: '16:9', title: ''});
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const props = {scene, thumbnails: {k1: 'blob:k1'}, uses: output.previsKeyframeUses(scene, [connectedShot, wide]), connected: [connectedShot], others: [wide], readOnly: false, exportIssue: null, busy: false,
    frameIssue: (target: PrevisShotView, role: output.PrevisFrameRole) => output.previsFrameIssue({shot: target, role, ratio: '9:16', edges: []}),
    onRecord: record('record'), onJump: record('jump'), onRename: record('rename'), onMove: record('move'), onRemove: record('remove'), onExport: record('export'), onSetFrame: record('frame'),
    camera: scene.camera, onFocal: record('focal'), aspect: 9 / 16};
  let tree = render(props);
  assert.equal(text(byId(tree, 'previs-keyframe-jump-k1')), 'K1全景24 mm');
  assert.equal(byId(tree, 'previs-keyframe-k2')?.props['data-current'], true, 'the keyframe the camera looks through is current');
  assert.match(text(byId(tree, 'previs-keyframe-use-k2')), /镜头 03 首帧/);
  assert.equal(byId(tree, 'previs-focal-35')?.props['aria-pressed'], true, 'the focal presets follow the current camera');
  assert.ok(nodes(byId(tree, 'previs-keyframe-jump-k1')).some(node => node.type === 'img' && node.props.src === 'blob:k1'));
  (byId(tree, 'previs-keyframe-jump-k3')!.props.onClick as () => void)();
  (byId(tree, 'previs-keyframe-export-k3')!.props.onClick as () => void)();
  (byId(tree, `previs-keyframe-first-${connectedShot.id}`)!.props.onClick as () => void)();
  (byId(tree, 'previs-keyframe-record')!.props.onClick as () => void)();
  assert.deepEqual(calls.map(call => call[0]), ['jump', 'export', 'frame', 'record']);
  assert.deepEqual(calls[2], ['frame', 'k1', connectedShot, 'first']);
  // The connected shot's first frame comes from K2: its item is checked there.
  const k2Items = nodes(byId(tree, 'previs-keyframe-k2')).filter(node => node.props?.['data-testid'] === `previs-keyframe-first-${connectedShot.id}`);
  assert.ok(nodes(k2Items[0]!).some(node => node.props?.className === 'previs-menu-check'));
  // Shots that cannot take the picture say why.
  const wideItems = nodes(byId(tree, 'previs-keyframe-k1')).filter(node => node.props?.['data-testid'] === `previs-keyframe-first-${wide.id}`);
  assert.equal(wideItems[0]!.props.disabled, true);
  assert.match(text(wideItems[0]), /镜头 05.*镜头画幅和预演不一致/);
  // Keyboard on a card: Alt+arrows move it, Delete removes it.
  calls.length = 0;
  const key = (id: string, event: Row) => (byId(tree, `previs-keyframe-jump-${id}`)!.props.onKeyDown as (event: Row) => void)({preventDefault() {}, stopPropagation() {}, ...event});
  key('k2', {key: 'ArrowLeft', altKey: true}); key('k2', {key: 'Delete'});
  assert.deepEqual(calls, [['move', 'k2', 0], ['remove', 'k2']]);
  // Dragging K3 before K1 moves it to the front.
  calls.length = 0;
  (byId(tree, 'previs-keyframe-k3')!.props.onDragStart as (event: Row) => void)({dataTransfer: {setData() {}, effectAllowed: ''}});
  tree = render(props);
  (byId(tree, 'previs-keyframe-k1')!.props.onDragOver as (event: Row) => void)({preventDefault() {}, dataTransfer: {dropEffect: ''}, clientX: 0, currentTarget: {getBoundingClientRect: () => ({left: 10, width: 100})}});
  tree = render(props);
  (byId(tree, 'previs-keyframe-k1')!.props.onDrop as (event: Row) => void)({preventDefault() {}, dataTransfer: {getData: () => 'k3'}});
  assert.deepEqual(calls, [['move', 'k3', 0]]);
  // A full strip and a read-only copy cannot record; exports explain why they are unavailable.
  let full = defaultPrevisScene();
  for (let index = 0; index < PREVIS_LIMITS.keyframes; index++) full = keyframes.addPrevisKeyframe(full).scene;
  tree = render({...props, scene: full, uses: new Map(), thumbnails: {}});
  assert.equal(byId(tree, 'previs-keyframe-record')!.props.disabled, true);
  tree = render({...props, readOnly: true, exportIssue: zh('previs.frame.issueReadOnly')});
  assert.equal(byId(tree, 'previs-keyframe-export-k1')!.props.disabled, true);
  assert.match(text(byId(tree, 'previs-keyframe-export-k1')), /恢复副本里不能导出/);
  assert.equal(byId(tree, 'previs-keyframe-k1')!.props.draggable, false);
  tree = render({...props, scene: {...scene, keyframes: []}, uses: new Map()});
  assert.match(text(byId(tree, 'previs-keyframe-list')), /还没有关键帧/);
  assert.equal(byId(tree, 'previs-keyframes-play'), undefined, 'no playback control without an editor to play it');
});
test('the strip plays the keyframes as a preview and says why it cannot', () => {
  const {render} = harness('previs/PrevisKeyframes.tsx'), scene = withKeyframes(24, 85), calls: string[] = [];
  const props = {scene, thumbnails: {}, uses: new Map(), connected: [], others: [], readOnly: true, exportIssue: null, busy: false, frameIssue: () => null,
    onRecord() {}, onJump() {}, onRename() {}, onMove() {}, onRemove() {}, onExport() {}, onSetFrame() {}, camera: scene.camera, onFocal() {}, aspect: 9 / 16,
    playing: false, playIssue: null, onPlay: () => { calls.push('play'); }};
  let button = byId(render(props), 'previs-keyframes-play');
  assert.deepEqual([text(button), button?.props.disabled, button?.props['aria-pressed']], ['播放', false, false], 'a restored copy can play too');
  assert.match(String(button?.props.title), /只是预览，不保存/);
  (button!.props.onClick as () => void)();
  assert.deepEqual(calls, ['play']);
  button = byId(render({...props, playing: true}), 'previs-keyframes-play');
  assert.deepEqual([text(button), button?.props.disabled, button?.props['aria-pressed']], ['停止', false, true]);
  button = byId(render({...props, playIssue: zh('previs.keyframes.playNeedsTwo')}), 'previs-keyframes-play');
  assert.deepEqual([button?.props.disabled, button?.props.title], [true, '至少要有两个关键帧才能播放']);
});
test('the inspector lists keyframes with what they frame and the shots they feed', () => {
  const {render} = harness('previs/PrevisInspector.tsx'), first = asset(), last = asset();
  let scene = sceneEdits.updatePrevisFigure(defaultPrevisScene(), 'f1', {name: '林夏'});
  scene = keyframes.recordPrevisExport(keyframes.recordPrevisExport(withKeyframesOn(scene, 24, 35), 'k1', first), 'k2', last);
  const nodeId = randomUUID(), fed = shot({orderIndex: 2, referenceAssetIds: [first], lastFrameAssetId: last}), plain = shot({orderIndex: 0, title: '城市夜景'});
  const node = {id: nodeId, projectId: randomUUID(), type: 'previs', label: '机位预演 · 雨夜街口', text: '', position: {x: 0, y: 0}, revision: 2, sceneRevision: 2, scene, createdAt: new Date().toISOString()} as PrevisNodeRecord;
  const props = {node, frame: {width: 1080, height: 1920, aspect: 9 / 16, ratio: '9:16'}, readOnly: false, busy: false, shots: [fed, plain], edges: [{id: 'e1', source: nodeId, target: fed.id}, {id: 'e2', source: nodeId, target: plain.id}],
    keyframeThumbnails: {k1: 'data:image/jpeg;base64,AAAA'}, onRename: () => {}, onOpen: () => {}};
  let tree = render(props);
  assert.equal(text(byId(tree, 'previs-inspector-keyframe-k1')), 'K1全景24 mm · 林夏镜头 03 首帧');
  assert.match(text(byId(tree, 'previs-inspector-keyframe-k2')), /K2中景35 mm · 林夏镜头 03 尾帧/);
  assert.equal(text(byId(tree, `previs-inspector-shot-${plain.id}`)), '镜头 01 · 城市夜景还没用到这个预演的关键帧');
  assert.equal(text(byId(tree, `previs-inspector-shot-${fed.id}`)), '镜头 03 · 周屿撑伞等候首帧参考 · K1 · 尾帧参考 · K2');
  assert.match(text(byId(tree, 'previs-inspector-output')), /PNG · 1080×1920/);
  tree = render({...props, edges: [], node: {...node, scene: {...scene, keyframes: []}}});
  assert.match(text(byId(tree, 'previs-inspector-output')), /还没有连接镜头/);
  assert.match(text(tree), /还没有关键帧/);
});
function withKeyframesOn(scene: PrevisScene, ...focals: number[]): PrevisScene {
  for (const focal of focals) scene = keyframes.addPrevisKeyframe({...scene, camera: cam(focal)}).scene;
  return scene;
}

// ---- Wiring ----
test('the app sets frames through ordinary shot edits and labels previs links', () => {
  const app = readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /run\(`save:\$\{shot\.id\}`, 'shot\.update', \{ shotId: shot\.id, expectedRevision: shot\.revision, patch \}/, 'set and undo go through the shot edit path');
  assert.match(app, /previsFrameIssue\(\{ shot, role: request\.role, ratio: previsFrame\(state\.timeline\)\.ratio, edges: state\.edges, assetId: request\.assetId \}\)/);
  assert.match(app, /'edge\.create', \{ projectId, source: node\.id, target: shot\.id \}/, 'a missing link is added');
  assert.match(app, /previsEdgeLabel\(source\.scene, shot,/);
  assert.match(app, /onImport=\{importPrevisImage\} onSetFrame=\{setPrevisFrame\} onUndoFrame=\{undoPrevisFrame\}/);
  assert.match(app, /if \(!current \|\| current\.toLowerCase\(\) !== undo\.assetId\.toLowerCase\(\)\) return \{ status: 'refused', reason: 'changed' \}/, 'undo restores only a frame that still has the set image');
  assert.equal(app.match(/const hold = previsFrameHold\(/g)?.length, 2, 'setting and undoing wait for unsaved shot text and pending edits');
  assert.match(app, /previsKeyframeOfAsset\(scene, other\) < 0/, 'the added link stays while the other frame still comes from the previs');
  const editor = readFileSync(path.join(root, 'apps/web/src/previs/PrevisEditor.tsx'), 'utf8');
  assert.match(editor, /renderViews\(\[\{ camera: keyframe\.camera, width: frame\.width, height: frame\.height \}\]\)/, 'exports render at the project frame size');
  assert.match(editor, /canvasBlob\(canvas, 'image\/png'\)/);
  assert.match(editor, /addPrevisKeyframe\(modelRef\.current\.scene, undefined, \[\.\.\.seenKeyframes\.current\]\)/, 'a new keyframe never takes an ID seen while editing');
  assert.match(editor, /onUndoFrame\(value, modelRef\.current\.scene\)/, 'undo reads the editor scene, which knows every export');
  assert.match(editor, /if \(exporting\.current && exportRun\.current\) \{\n\s*await Promise\.race\(\[exportRun\.current,/, 'leaving waits for an export to record its image before the last save');
});
