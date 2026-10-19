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
import {DEFAULT_UI_PREFERENCES} from '../../packages/contracts/src/ui-preferences.ts';
import * as removalState from '../../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../../apps/web/src/workbench-modal-state.ts';

type AnyRecord = Record<string, unknown>;
interface RenderNode {type?: unknown; props?: AnyRecord}
const id = (n: number): string => `b4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
export const deferred = (): PromiseWithResolvers<unknown> => Promise.withResolvers();
export const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const nodes = (tree: unknown): RenderNode[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree as RenderNode, ...nodes((tree as RenderNode).props?.children)];
const text = (tree: unknown): string => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text((tree as RenderNode).props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const inspectorCode = transformSync(readFileSync(new URL('../../apps/web/src/TimelineInspector.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;
const controlsCode = transformSync(readFileSync(new URL('../../apps/web/src/ClipOpacityEnvelopeControls.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;

/** Synthetic React event execution of the actual Inspector and opacity input
 * component, backed by the real controller and v3 HTTP client. Inert visual
 * children and an in-memory CAS transport do not simulate a native OS IME. */
export interface OpacityImeGate {readonly promise: Promise<unknown>}
export interface OpacityInspectorImeOptions {locale?: string; restored?: boolean; restoredPersistence?: boolean; putGate?: OpacityImeGate; deleteGate?: OpacityImeGate; getGate?: OpacityImeGate; saveGate?: OpacityImeGate}
export function opacityInspectorImeFixture(t: unknown, {locale = 'en', restored = false, restoredPersistence = false, putGate, deleteGate, getGate, saveGate}: OpacityInspectorImeOptions = {}) {
  assert.ok(!restoredPersistence || restored);
  const workspace = createOpacityRestoredApplicationInspection({schemaVersion: 43, sourceSchema: 42, profile: 'restored-local-v10',
    workspaceOrigin: id(7), restorationId: id(8), sourceBackupId: id(9), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: stamp, heldCounts: {}});
  const savedClip = {id: id(3), assetId: id(4), trackId: id(5), name: 'Synthetic clip', startFrame: 0, durationFrames: 10, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
    opacityEnvelope: {profileId: opacityContract.OPACITY_ENVELOPE_PROFILE, points: [{frame: 0, opacity: .25}, {frame: 10, opacity: 1}]}};
  const timeline = (clip: AnyRecord, revision = 3): AnyRecord => ({id: id(2), projectId: id(1), revision, fps: 30, width: 720, height: 1280, durationFrames: 10,
    tracks: [{id: id(5), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false}], clips: [clip], createdAt: stamp, updatedAt: stamp});
  interface RequestRecord {method: string|undefined; input: AnyRecord}
  const requests: RequestRecord[] = [], saves: unknown[] = [], callbacks: unknown[] = [], stubs = new Map<string, (properties: unknown)=>unknown>();
  let row: AnyRecord|undefined, controller: ReturnType<typeof drafts.createClipDraftController>|undefined;
  let inspectorTree: unknown, controlsTree: RenderNode[], controlsProps: AnyRecord|undefined;
  const fetcher = async (url: string, options: {body?: string; method?: string} = {}) => {
    assert.ok(!restored || restoredPersistence, 'Restored43 memory-only input must not access storage');
    const input = (options.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url, 'http://synthetic.invalid').searchParams)) as AnyRecord;
    const address = new URL(url, 'http://synthetic.invalid');
    assert.equal(address.pathname, restoredPersistence ? '/api/local-drafts/restored43/clip' : '/api/local-drafts/clip');
    const localWorkspace = workspace as unknown as {localClipDrafts: {profileId: string}};
    if (restoredPersistence) {assert.equal(String(input.schemaVersion), '1');assert.equal(input.expectedWorkspaceOrigin, workspace.workspaceOrigin);}
    requests.push({method: options.method, input: structuredClone(input)});
    if (options.method === 'GET') {
      row ??= {supported: true, ...(restoredPersistence ? {schemaVersion: 1, profileId: localWorkspace.localClipDrafts.profileId, workspaceOrigin: workspace.workspaceOrigin} : {}), workspaceScope: 'c'.repeat(64), instanceId: id(6), key: {projectId: input.projectId, timelineId: input.timelineId, clipId: input.clipId}, revision: 0, targetStatus: 'matching', draft: null};
      const captured = structuredClone(row);if (getGate) await getGate.promise;return new Response(JSON.stringify({ok: true, data: captured}));
    }
    if (options.method === 'PUT' && putGate) await putGate.promise;
    if (options.method === 'DELETE' && deleteGate) await deleteGate.promise;
    assert.equal(input.expectedRevision, (row as AnyRecord).revision);
    row = {...(row as AnyRecord), revision: ((row as AnyRecord).revision as number) + 1, draft: options.method === 'DELETE' ? null : {raw: input.raw, source: input.source, baseRevision: input.baseRevision, updatedAt: stamp}};
    return new Response(JSON.stringify({ok: true, data: row}));
  };
  interface FixtureProps extends AnyRecord {
    clip: AnyRecord; timeline: AnyRecord; asset: AnyRecord; draftContext: AnyRecord; opacityCandidate: unknown;
    onDirtyChange(): void; onCompositionPendingChange(value: unknown): void; onPreview(): void; onRemove(): void;
    onSave(clipId: string, patch: AnyRecord, revision: number, options: {canExecute(): boolean}): Promise<AnyRecord>;
  }
  const props: FixtureProps = {clip: savedClip, timeline: timeline(savedClip), asset: {id: id(4), projectId: id(1), name: 'Synthetic image', mimeType: 'image/png', sha256: 'd'.repeat(64)},
    draftContext: {scope: `${restored ? 'restored43' : 'ordinary42'}:synthetic:inspector`, projectId: id(1), restored, ...(restoredPersistence ? {workspaceOrigin: workspace.workspaceOrigin} : {})},
    opacityCandidate: restoredPersistence ? assembly.createRestoredOpacityCandidateInspectorBinding(workspace, fetcher as unknown as typeof fetch) : assembly.createOpacityCandidateInspectorBinding(fetcher as unknown as typeof fetch),
    onDirtyChange() {}, onCompositionPendingChange(value: unknown) {callbacks.push(value);}, onPreview() {}, onRemove() {},
    async onSave(clipId: string, patch: AnyRecord, revision: number, options: {canExecute(): boolean}) {
      saves.push({clipId, patch: structuredClone(patch), revision, options});
      const result = timeline({...props.clip, ...patch}, revision + 1);
      if (saveGate) await saveGate.promise;
      if (options.canExecute()) {props.clip = (result as {clips: AnyRecord[]}).clips[0]!;props.timeline = result;}
      return result;
    }};
  interface OwnerState {hooks: unknown[]; cursor: number}
  const owners = new Map<string, OwnerState>();
  let current: OwnerState|undefined;
  function renderOwner<T>(name: string, callback: ()=>T): T {
    const previous = current; current = owners.get(name) ?? {hooks: [], cursor: 0}; owners.set(name, current); current.cursor = 0;
    try {return callback();} finally {current = previous;}
  }
  const removalModule: {exports: AnyRecord} = {exports:{}};
  const react: Record<string, unknown> = {createElement: (type: unknown, properties: AnyRecord|undefined, ...children: unknown[]) => type === removalModule.exports.ClipActionsMenu ? (type as (value: AnyRecord)=>unknown)({...properties, children}) : ({type, props: {...properties, children}}),
    useRef(initial: unknown) {const owner=current!;return (owner.hooks[owner.cursor++] ??= {current: initial});},
    useState(initial: unknown) {const owner = current!, at = owner.cursor++;owner.hooks[at] ??= {value: initial};const hook=owner.hooks[at] as {value: unknown};return [hook.value, (value: unknown) => {hook.value = value;}];},
    useId: () => 'synthetic-opacity', useEffect() {}, useLayoutEffect(callback: ()=>void) {callback();}};react.default = react;
  const stub = (name: string): ((properties: unknown)=>unknown) => {if (!stubs.has(name)) stubs.set(name, (properties: unknown) => properties);return stubs.get(name)!;};
  Function('require', 'module', 'exports', transformSync(readFileSync(new URL('../../apps/web/src/ClipRemovalControls.tsx', import.meta.url), 'utf8'), {loader:'tsx', format:'cjs'}).code)((name: string) => {
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return i18nTestModule(locale as never);
    if (name === './timeline-removal.ts') return removalState;
    if (name === './workbench-modal-state.ts') return {hasOpenWorkbenchModal};
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, {get: (_target, key) => stub(String(key))});
    return assert.fail(name);
  }, removalModule, removalModule.exports);
  function load(code: string, importer: (name: string)=>unknown): unknown {const module: {exports: AnyRecord} = {exports: {}};Function('require', 'module', 'exports', code)(importer, module, module.exports);return module.exports.default;}
  const Controls = load(controlsCode, (name: string) => name === 'react' ? react : name.includes('I18nProvider') ? i18nTestModule(locale as never)
    : name.endsWith('clip-opacity-envelope-state.ts') ? opacity : name.endsWith('timeline-opacity-envelope.ts') ? opacityContract : assert.fail(name));
  const Inspector = load(inspectorCode, (name: string) => {
    if (name === 'react') return react;
    if (name === './UiPreferencesProvider.tsx') return {useUiPreferences: () => ({preferences:DEFAULT_UI_PREFERENCES})};
    if (name === './timeline-removal.ts') return removalState;
    if (name === './ClipRemovalControls.tsx') return removalModule.exports;
    if (name.includes('I18nProvider')) return i18nTestModule(locale as never);
    if (name.includes('i18n/src/index')) return {message};
    if (name.includes('workbench-confirm')) return {useConfirmation: () => async () => true};
    if (name === '@mioon/contracts') return {isTimelineRecord, sourceFrameCount};
    if (name.endsWith('/Timeline.tsx')) return {assetKind: (asset: {mimeType: string}) => asset.mimeType.split('/')[0], framesLabel: String};
    if (name.endsWith('/clip-draft-state.ts')) return drafts;
    if (name.endsWith('/clip-opacity-envelope-state.ts')) return opacity;
    if (name.endsWith('/clip-volume-envelope-state.ts')) return volume;
    if (name.endsWith('/clip-opacity-candidate-assembly.ts')) return assembly;
    if (name.endsWith('/opacity-ime-submit-guard.ts')) return imeSubmit;
    if (name.endsWith('/clip-draft-hook.ts')) return {useClipDraft(options: AnyRecord & {client: unknown; context: unknown; onCompositionPendingChange?: (value: unknown)=>void; [key: string]: unknown}) {
      if (!controller) controller = drafts.createClipDraftController({...options, client: options.client as never, delay: 60000,
        onChange: (state: {compositionPending: unknown}) => {options.onCompositionPendingChange?.(state.compositionPending);}} as never);
      else controller.setContext(options.context as never);
      return {state: controller.getState(), controller};
    }};
    if (name.endsWith('/clip-audio-role-state.ts')) return {clipAudioRoleChanged: () => false};
    if (name.endsWith('/clip-audio-state.ts')) return {clipAudioIssue: () => ''};
    if (name.endsWith('/timeline-format-state.ts')) return {timelineRectIssue: () => '', timelineRectMessage: () => ''};
    if (name.endsWith('/workspace-visibility.tsx')) return {useWorkspaceVisibility: () => true};
    if (name.endsWith('/ClipOpacityEnvelopeControls.tsx')) return {__esModule: true, default: Controls};
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, {get: (_target, key) => stub(String(key))});
    return {__esModule: true, default: stub(name)};
  });
  const findNode = (list: RenderNode[], predicate: (node: RenderNode)=>boolean): RenderNode => {const found = list.find(predicate);assert.ok(found);return found;};
  const target = (field: string) => ({value: findNode(controlsTree, node => node.props?.['data-testid'] === `opacity-envelope-0-${field}`).props?.value, getAttribute: (key: string) => key === 'data-testid' ? `opacity-envelope-0-${field}` : null});
  interface KeyboardEventLike {key: string; keyCode: number; isComposing: boolean; repeat: boolean; nativeEvent: {isComposing: boolean; keyCode: number; repeat: boolean}; currentTarget: unknown; target: unknown; defaultPrevented: boolean; propagationStopped: boolean; preventDefault(): void; stopPropagation(): void}
  const h = {props, requests, saves, callbacks,
    get controller(): ReturnType<typeof drafts.createClipDraftController> {if(!controller)throw Error('Controller not created');return controller;}, get state() {return h.controller.getState();}, row: () => structuredClone(row),
    render(patch: AnyRecord = {}): unknown {Object.assign(props, patch);inspectorTree = renderOwner('inspector', () => (Inspector as (value: FixtureProps)=>unknown)(props));
      controlsProps = findNode(nodes(inspectorTree), node => node.type === Controls).props;
      controlsTree = nodes(renderOwner('controls', () => (Controls as (value: AnyRecord)=>{type?: unknown; props?: AnyRecord})(controlsProps!)));return inspectorTree;},
    input: (field = 'opacity', row = 0): RenderNode|undefined => nodes(controlsTree).find(node => node.props?.['data-testid'] === `opacity-envelope-${row}-${field}`),
    all: (): RenderNode[] => nodes(inspectorTree), controlNodes: (): RenderNode[] => nodes(controlsTree), text: (): string => text([inspectorTree, controlsTree]),
    button: (testId: string): RenderNode|undefined => nodes(inspectorTree).find(node => node.props?.['data-testid'] === testId),
    cancel: (): RenderNode|undefined => nodes(inspectorTree).find(node => node.type === stubs.get('Button') && text(node) === translate(locale as never, 'timeline.inspector.discard')),
    form: (): RenderNode => findNode(nodes(inspectorTree), node => node.type === 'form'),
    async ready(): Promise<void> {await h.controller.load();h.render();},
    async submit(): Promise<unknown> {const onSubmit = findNode(nodes(inspectorTree), node => node.type === 'form').props?.onSubmit as (event: {preventDefault(): void})=>unknown; return onSubmit({preventDefault() {}});},
    event(type: string, value: string, field = 'opacity', extra: AnyRecord = {}): AnyRecord {const element = target(field);element.value = value;const event = {currentTarget: element, target: element, ...extra};const handler = h.input(field)?.props?.[type] as ((value: unknown)=>unknown)|undefined;handler?.(event);return event;},
    key(key: string, {field = 'opacity', isComposing = false, keyCode = key === 'Enter' ? 13 : 27, repeat = false}: {field?: string; isComposing?: boolean; keyCode?: number; repeat?: boolean} = {}): KeyboardEventLike {
      const element = target(field), event: KeyboardEventLike = {key, keyCode, isComposing, repeat, nativeEvent: {isComposing, keyCode, repeat}, currentTarget: element, target: element,
        defaultPrevented: false, propagationStopped: false, preventDefault() {event.defaultPrevented = true;}, stopPropagation() {event.propagationStopped = true;}};
      const capture = h.form().props?.onKeyDownCapture as ((value: unknown)=>unknown)|undefined;
      capture?.(event);if (!event.propagationStopped) {const handler = h.input(field)?.props?.onKeyDown as ((value: unknown)=>unknown)|undefined;handler?.(event);}return event;
    },
    keyUp(key = 'Enter'): void {const handler = h.form().props?.onKeyUpCapture as ((value: unknown)=>unknown)|undefined;handler?.({key});},
  };
  h.render();(t as {after(callback: ()=>void): void}).after(() => h.controller.dispose());return h;
}
