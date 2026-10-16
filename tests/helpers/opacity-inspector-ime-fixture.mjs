import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {isTimelineRecord, sourceFrameCount} from '@mioon/contracts';
import * as drafts from '../../apps/web/src/clip-draft-state.ts';
import * as opacity from '../../apps/web/src/clip-opacity-envelope-state.ts';
import * as volume from '../../apps/web/src/clip-volume-envelope-state.ts';
import * as assembly from '../../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as opacityContract from '../../packages/contracts/src/timeline-opacity-envelope.ts';
import * as imeSubmit from '../../apps/web/src/opacity-ime-submit-guard.ts';
import {i18nTestModule} from './i18n.ts';
import {message, translate} from '../../packages/i18n/src/index.ts';
import {createOpacityRestoredApplicationInspection} from '../../packages/contracts/src/opacity-restored-application.ts';

const id = n => `b4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
export const deferred = () => Promise.withResolvers();
export const turn = () => new Promise(resolve => setImmediate(resolve));
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const inspectorCode = transformSync(readFileSync(new URL('../../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8'), {loader: 'jsx', format: 'cjs'}).code;
const controlsCode = transformSync(readFileSync(new URL('../../apps/web/src/ClipOpacityEnvelopeControls.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;

/** Synthetic React event execution of the actual Inspector and opacity input
 * component, backed by the real controller and v3 HTTP client. Inert visual
 * children and an in-memory CAS transport do not simulate a native OS IME. */
export function opacityInspectorImeFixture(t, {locale = 'en', restored = false, restoredPersistence = false, putGate, deleteGate, getGate, saveGate} = {}) {
  assert.ok(!restoredPersistence || restored);
  const workspace = createOpacityRestoredApplicationInspection({schemaVersion: 43, sourceSchema: 42, profile: 'restored-local-v10',
    workspaceOrigin: id(7), restorationId: id(8), sourceBackupId: id(9), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: stamp, heldCounts: {}});
  const savedClip = {id: id(3), assetId: id(4), trackId: id(5), name: 'Synthetic clip', startFrame: 0, durationFrames: 10, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
    opacityEnvelope: {profileId: opacityContract.OPACITY_ENVELOPE_PROFILE, points: [{frame: 0, opacity: .25}, {frame: 10, opacity: 1}]}};
  const timeline = (clip, revision = 3) => ({id: id(2), projectId: id(1), revision, fps: 30, width: 720, height: 1280, durationFrames: 10,
    tracks: [{id: id(5), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false}], clips: [clip], createdAt: stamp, updatedAt: stamp});
  const requests = [], saves = [], callbacks = [], stubs = new Map();
  let row, controller, inspectorTree, controlsTree, controlsProps;
  const fetcher = async (url, options = {}) => {
    assert.ok(!restored || restoredPersistence, 'Restored43 memory-only input must not access storage');
    const input = options.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url, 'http://synthetic.invalid').searchParams);
    const address = new URL(url, 'http://synthetic.invalid');
    assert.equal(address.pathname, restoredPersistence ? '/api/local-drafts/restored43/clip' : '/api/local-drafts/clip');
    if (restoredPersistence) {assert.equal(String(input.schemaVersion), '1');assert.equal(input.expectedWorkspaceOrigin, workspace.workspaceOrigin);}
    requests.push({method: options.method, input: structuredClone(input)});
    if (options.method === 'GET') {
      row ??= {supported: true, ...(restoredPersistence ? {schemaVersion: 1, profileId: workspace.localClipDrafts.profileId, workspaceOrigin: workspace.workspaceOrigin} : {}), workspaceScope: 'c'.repeat(64), instanceId: id(6), key: {projectId: input.projectId, timelineId: input.timelineId, clipId: input.clipId}, revision: 0, targetStatus: 'matching', draft: null};
      const captured = structuredClone(row);if (getGate) await getGate.promise;return new Response(JSON.stringify({ok: true, data: captured}));
    }
    if (options.method === 'PUT' && putGate) await putGate.promise;
    if (options.method === 'DELETE' && deleteGate) await deleteGate.promise;
    assert.equal(input.expectedRevision, row.revision);
    row = {...row, revision: row.revision + 1, draft: options.method === 'DELETE' ? null : {raw: input.raw, source: input.source, baseRevision: input.baseRevision, updatedAt: stamp}};
    return new Response(JSON.stringify({ok: true, data: row}));
  };
  const props = {clip: savedClip, timeline: timeline(savedClip), asset: {id: id(4), projectId: id(1), name: 'Synthetic image', mimeType: 'image/png', sha256: 'd'.repeat(64)},
    draftContext: {scope: `${restored ? 'restored43' : 'ordinary42'}:synthetic:inspector`, projectId: id(1), restored, ...(restoredPersistence ? {workspaceOrigin: workspace.workspaceOrigin} : {})},
    opacityCandidate: restoredPersistence ? assembly.createRestoredOpacityCandidateInspectorBinding(workspace, fetcher) : assembly.createOpacityCandidateInspectorBinding(fetcher),
    onDirtyChange() {}, onCompositionPendingChange(value) {callbacks.push(value);}, onPreview() {}, onRemove() {},
    async onSave(clipId, patch, revision, options) {
      saves.push({clipId, patch: structuredClone(patch), revision, options});
      const result = timeline({...props.clip, ...patch}, revision + 1);
      if (saveGate) await saveGate.promise;
      if (options.canExecute()) {props.clip = result.clips[0];props.timeline = result;}
      return result;
    }};
  const owners = new Map();let current;
  function renderOwner(name, callback) {
    const previous = current;current = owners.get(name) ?? {hooks: [], cursor: 0};owners.set(name, current);current.cursor = 0;
    try {return callback();} finally {current = previous;}
  }
  const react = {createElement: (type, properties, ...children) => ({type, props: {...properties, children}}),
    useRef(initial) {return current.hooks[current.cursor++] ??= {current: initial};},
    useState(initial) {const owner = current, at = owner.cursor++;owner.hooks[at] ??= {value: initial};return [owner.hooks[at].value, value => {owner.hooks[at].value = value;}];},
    useId: () => 'synthetic-opacity', useLayoutEffect(callback) {callback();}};react.default = react;
  const stub = name => {if (!stubs.has(name)) stubs.set(name, properties => properties);return stubs.get(name);};
  function load(code, importer) {const module = {exports: {}};Function('require', 'module', 'exports', code)(importer, module, module.exports);return module.exports.default;}
  const Controls = load(controlsCode, name => name === 'react' ? react : name.includes('I18nProvider') ? i18nTestModule(locale)
    : name.endsWith('clip-opacity-envelope-state.ts') ? opacity : name.endsWith('timeline-opacity-envelope.ts') ? opacityContract : assert.fail(name));
  const Inspector = load(inspectorCode, name => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return i18nTestModule(locale);
    if (name.includes('i18n/src/index')) return {message};
    if (name.includes('workbench-confirm')) return {useConfirmation: () => async () => true};
    if (name === '@mioon/contracts') return {isTimelineRecord, sourceFrameCount};
    if (name.endsWith('/Timeline.jsx')) return {assetKind: asset => asset.mimeType.split('/')[0], framesLabel: String};
    if (name.endsWith('/clip-draft-state.ts')) return drafts;
    if (name.endsWith('/clip-opacity-envelope-state.ts')) return opacity;
    if (name.endsWith('/clip-volume-envelope-state.ts')) return volume;
    if (name.endsWith('/clip-opacity-candidate-assembly.ts')) return assembly;
    if (name.endsWith('/opacity-ime-submit-guard.ts')) return imeSubmit;
    if (name.endsWith('/clip-draft-hook.ts')) return {useClipDraft(options) {
      if (!controller) controller = drafts.createClipDraftController({...options, client: options.client, delay: 60000,
        onChange: state => {options.onCompositionPendingChange?.(state.compositionPending);}});
      else controller.setContext(options.context);
      return {state: controller.getState(), controller};
    }};
    if (name.endsWith('/clip-audio-role-state.ts')) return {clipAudioRoleChanged: () => false};
    if (name.endsWith('/clip-audio-state.js')) return {clipAudioIssue: () => ''};
    if (name.endsWith('/timeline-format-state.js')) return {timelineRectIssue: () => '', timelineRectMessage: () => ''};
    if (name.endsWith('/workspace-visibility.jsx')) return {useWorkspaceVisibility: () => true};
    if (name.endsWith('/ClipOpacityEnvelopeControls.tsx')) return {__esModule: true, default: Controls};
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, {get: (_, key) => stub(key)});
    return {__esModule: true, default: stub(name)};
  });
  const target = field => ({value: h.input(field).props.value, getAttribute: key => key === 'data-testid' ? `opacity-envelope-0-${field}` : null});
  const h = {props, requests, saves, callbacks,
    get controller() {return controller;}, get state() {return controller.getState();}, row: () => structuredClone(row),
    render(patch = {}) {Object.assign(props, patch);inspectorTree = renderOwner('inspector', () => Inspector(props));
      controlsProps = nodes(inspectorTree).find(node => node.type === Controls).props;
      controlsTree = renderOwner('controls', () => Controls(controlsProps));return inspectorTree;},
    input: (field = 'opacity', row = 0) => nodes(controlsTree).find(node => node.props?.['data-testid'] === `opacity-envelope-${row}-${field}`),
    all: () => nodes(inspectorTree), controlNodes: () => nodes(controlsTree), text: () => text([inspectorTree, controlsTree]),
    button: testId => nodes(inspectorTree).find(node => node.props?.['data-testid'] === testId),
    cancel: () => nodes(inspectorTree).find(node => node.type === stubs.get('Button') && text(node) === translate(locale, 'timeline.inspector.discard')),
    form: () => nodes(inspectorTree).find(node => node.type === 'form'),
    async ready() {await controller.load();h.render();},
    async submit() {return h.form().props.onSubmit({preventDefault() {}});},
    event(type, value, field = 'opacity', extra = {}) {const element = target(field);element.value = value;const event = {currentTarget: element, target: element, ...extra};h.input(field).props[type]?.(event);return event;},
    key(key, {field = 'opacity', isComposing = false, keyCode = key === 'Enter' ? 13 : 27, repeat = false} = {}) {
      const element = target(field), event = {key, keyCode, isComposing, repeat, nativeEvent: {isComposing, keyCode, repeat}, currentTarget: element, target: element,
        defaultPrevented: false, propagationStopped: false, preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.propagationStopped = true;}};
      h.form().props.onKeyDownCapture?.(event);if (!event.propagationStopped) h.input(field).props.onKeyDown?.(event);return event;
    },
    keyUp(key = 'Enter') {h.form().props.onKeyUpCapture?.({key});},
  };
  h.render();t.after(() => controller.dispose());return h;
}
