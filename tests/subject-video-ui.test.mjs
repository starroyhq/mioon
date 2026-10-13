import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import * as settings from '../apps/web/src/generation-settings.js';
import * as subjectVideo from '../apps/web/src/subject-video.js';
import * as subjectState from '../apps/web/src/subject-state.js';
import * as submissions from '../apps/web/src/submissions.js';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.js';
import * as api from '../apps/web/src/api.js';
import { referenceForShot } from '../apps/web/src/reference-connections.js';

const taskIntentModule = { exports: {} };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const id = n => `74000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), subjectId = id(3), date = '2026-10-11T08:00:00.000Z';
const asset = (n = 1, patch = {}) => ({ id: id(10 + n), projectId, name: `主体原图 ${n}`, mimeType: 'image/png', sha256: String(n).repeat(64), width: 1024, height: 1024, sizeBytes: 1000, relativePath: `assets/subject-${n}.png`, ...patch });
const version = (number = 1, patch = {}) => ({ id: id(20 + number), projectId, subjectId, number, assetId: asset(number).id, sha256: asset(number).sha256, mimeType: 'image/png', width: 1024, height: 1024, provenance: { kind: 'user-import', versionId: null, shotId: null, jobId: null }, createdAt: date, ...patch });
const subject = (number = 1, patch = {}) => ({ id: subjectId, projectId, kind: 'product', name: '方形产品', revision: number, headVersionId: version(number).id, headVersion: version(number), createdAt: date, updatedAt: date, ...patch });
const shot = (patch = {}) => ({ id: shotId, projectId, revision: 1, title: '产品镜头', prompt: 'The product turns slowly.', referenceAssetIds: [], aspectRatio: '9:16', duration: 4, parameters: {}, orderIndex: 0, ...patch });
const reference = (n = 1) => subjectVideo.subjectVideoChoice(subject(n), version(n));
const assets = [asset(), asset(2)];
function provider(id = 'ark') {
  const profile = contracts.GENERATION_INPUT_PROFILES.find(item => item.providerId === id);
  return { id, name: id, mock: id === 'mock', status: 'available', enabled: true, configured: true, models: [profile.model],
    modelCapabilities: [{ id: profile.model, inputModes: profile.inputModes, aspectRatios: profile.aspectRatios, durations: profile.durationsSeconds, referenceImages: { min: 0, max: profile.inputs.maxReferences, matchAspectRatio: id === 'ark' } }],
    providerRegion: profile.regions[0], inputProfileVersion: contracts.INPUT_PROFILE_VERSION, inputProfiles: [structuredClone(profile)], profileEvaluationDate: '2026-10-11',
    inputProfileEvaluations: [{ profileId: profile.profileId, ...contracts.evaluateCapabilityLifecycle(profile, { asOf: '2026-10-11' }) }] };
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const equalDeps = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };

function harness(file, initial) {
  let cursor = 0, layouts = [], effects = [], tree, props = initial, dirty = false;
  const slots = [], modules = new Map(), h = { visible: true };
  const effect = (queue, callback, deps) => { const i = cursor++, old = slots[i]; if (old && equalDeps(old.deps, deps)) return; slots[i] = { callback, deps, cleanup: old?.cleanup }; queue.push(i); };
  const react = {
    createElement: (type, properties, ...children) => typeof type === 'function' && type === modules.get('RecoveryStorageDetails.tsx')?.default ? type({ ...properties, children }) : ({ type, props: { ...properties, children } }),
    useState(initial) { const i = cursor++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { const next = typeof value === 'function' ? value(slots[i].value) : value; if (next !== slots[i].value) { dirty = true; slots[i].value = next; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(factory, deps) { const i = cursor++; if (!slots[i] || !equalDeps(slots[i].deps, deps)) slots[i] = { value: factory(), deps }; return slots[i].value; },
    useLayoutEffect: (callback, deps) => effect(layouts, callback, deps), useEffect: (callback, deps) => effect(effects, callback, deps),
  }; react.default = react;
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const module = { exports: {} }, code = transformSync(readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), { loader: filename.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code;
    Function('module', 'exports', 'require', code)(module, module.exports, name => {
      if (name === 'react') return react;
      if (name === './RecoveryStorageDetails.tsx') return load('RecoveryStorageDetails.tsx');
      if (name === './TaskWorkspace.tsx') return load('TaskWorkspace.tsx');
      if (name === './local-shot-text-state.ts') return { useLocalShotText: ({ context }) => {
        assert.equal(context.restored, true, 'This legacy Inspector fixture has no shot-text context');
        return { state: {}, controller: { setContext() {} } };
      }, mergeFreshShotTextAck: () => { assert.fail('No shot-text acknowledgement is expected in this fixture'); } };
      if (name === './ShotTextDraftRecovery.tsx') return { default: 'ShotTextDraftRecovery', __esModule: true };
      if (name === '@mioon/contracts') return contracts;
      if (name === '@mioon/contracts/local-shot-text') return { LOCAL_SHOT_TEXT_LIMITS };
      if (name === './mutation-submissions.js') return { isMutationOperation: () => false };
      if (name === './edit-task-client.js') return { isDurableEditOperation: () => false };
      if (name === './generation-settings.js') return settings;
      if (name === './subject-video.js') return subjectVideo;
      if (name === './subject-state.js') return subjectState;
      if (name === './use-subjects.js') return load('use-subjects.js');
      if (name === './api.js') return api;
      if (name === './submissions.js') return submissions;
      if (name === './workspace-origin.js') return workspaceOrigin;
      if (name === './reference-connections.js') return { referenceForShot };
      if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => h.visible };
      if (name === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => async () => true };
      if (name.startsWith('@mioon/ui/')) return new Proxy({}, { get: (_, key) => String(key) });
      if (name === './WorkspaceControls.jsx') return { WorkbenchSelect: 'WorkbenchSelect' };
      if (name === './SubjectLibrary.jsx') return { SubjectPager: 'SubjectPager' };
      if (name === './VideoFrameControls.jsx') return { default: 'VideoFrameControls', VideoFrameSummary: 'VideoFrameSummary', __esModule: true };
      if (name === './ReferenceConnections.jsx') return { ReferenceSourcePanel: 'ReferenceSourcePanel', BoundReference: 'BoundReference' };
      if (name === './Nodes.jsx') return { Media: 'Media' };
      if (name === './Timeline.jsx') return { dragAsset() {} };
      if (name.endsWith('.css')) return {};
      if (name.endsWith('.jsx')) return { default: name, __esModule: true };
      throw Error(`Unexpected dependency ${name}`);
    });
    modules.set(filename, module.exports); return module.exports;
  }
  const Component = load(file).default;
  Object.assign(h, {
    render(patch = {}) { props = { ...props, ...patch }; let count = 0; do { dirty = false; cursor = 0; layouts = []; effects = []; tree = Component(props); for (const i of [...layouts, ...effects]) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } assert.ok(++count < 20); } while (dirty); return tree; },
    find: id => nodes(tree).find(node => node.props?.['data-testid'] === id || node.props?.id === id),
    nodes: () => nodes(tree), text: () => text(tree), props: () => props,
    unmount: () => slots.forEach(slot => slot.cleanup?.()),
  });
  h.render(); return h;
}
function selectionProps(options = {}) {
  const s = subject(2), entries = { phase: 'ready', items: [s], nextCursor: 'next-page', history: [] };
  const state = { scope: `${projectId}:1`, subjects: { [subjectId]: s }, list: entries, versions: { [subjectId]: { ...entries, items: [version(2)], known: { [version().id]: version(), [version(2).id]: version(2) } } } };
  const reads = [], changes = [], controller = { getState: () => state, read: () => reads.push('list'), readVersions: id => reads.push(id), subjectPage: direction => reads.push(direction), versionPage: (_, direction) => reads.push(direction) };
  return { shot: shot(), draft: shot(), subjects: { state, controller }, assets, provider: provider(), model: provider().models[0], options, disabled: false, boundReference: false, onChange: patch => changes.push(patch), reads, changes };
}

test('explicit subject choice is immutable, kind-scoped, pinned to history and does not touch prompt or planning bindings', () => {
  const head = subject(2), old = version(), before = structuredClone(head), chosen = subjectVideo.subjectVideoChoice(head, old);
  assert.equal(chosen.subjectVersionId, old.id); assert.equal(chosen.subjectVersion.number, 1); assert.ok(Object.isFrozen(chosen.subjectVersion.provenance));
  head.headVersion.sha256 = 'f'.repeat(64); assert.equal(chosen.subjectVersion.sha256, old.sha256);
  for (const kind of ['character', 'product', 'location']) assert.ok(subjectVideo.subjectVideoChoice(subject(2, { kind }), old));
  for (const kind of ['look', 'style']) assert.equal(subjectVideo.subjectVideoChoice(subject(2, { kind }), old), null);
  assert.equal(subjectVideo.subjectVideoChoice(before, version(1, { projectId: id(999) })), null);
  const saved = shot({ subjectBindings: [{ subjectVersionId: version(2).id }] }), frozen = subjectVideo.subjectVideoSnapshot(saved, chosen, assets);
  assert.equal(frozen.prompt, saved.prompt); assert.deepEqual(saved.referenceAssetIds, []); assert.equal(frozen.subjectReference.subjectVersionId, old.id);
  assert.deepEqual(frozen.referenceBindings, [{ role: 'subject_reference', assetId: old.assetId, sha256: old.sha256 }]);
});

test('subject mode blocks saved or unsaved first/tail sources and edges without clearing any source', () => {
  const original = shot({ referenceAssetIds: [asset().id], lastFrameAssetId: asset(2).id }), before = structuredClone(original);
  assert.match(subjectVideo.subjectVideoConflictIssue(original), /手动清除.*保存镜头/);
  assert.match(subjectVideo.subjectVideoConflictIssue(shot(), { savedShot: original }), /保存镜头/);
  assert.match(subjectVideo.subjectVideoConflictIssue(shot(), { boundReference: true }), /明确断开/);
  assert.deepEqual(original, before);
  const p = provider(); assert.equal(settings.generationSelection([p], { inputMode: 'subject' }, original).inputMode, 'subject');
  assert.match(settings.generationInputIssue(original, p, p.models[0], assets, 'subject', { subjectReference: reference() }), /手动清除/);
});

test('exact server v3 Ark and Mock accept square references independently of output; unsupported routes and changed metadata fail closed', () => {
  for (const providerId of ['ark', 'mock']) {
    const p = provider(providerId); assert.equal(settings.subjectVideoProfileIssue(p, p.models[0]), '');
    assert.equal(settings.generationInputIssue(shot(), p, p.models[0], assets, 'subject', { subjectReference: reference() }), '');
  }
  const p = provider();
  for (const providerId of ['runway', 'veo', 'minimax', 'vidu']) { const other = provider(providerId); assert.match(settings.subjectVideoProfileIssue(other, other.models[0]), /仅接入 Mock 与 Ark/); }
  assert.match(settings.subjectVideoProfileIssue(p, `${p.models[0]}-other`), /不会自动切换/);
  assert.match(settings.subjectVideoProfileIssue({ ...p, inputProfiles: [] }, p.models[0]), /唯一输入配置/);
  assert.match(settings.generationInputIssue(shot(), p, p.models[0], assets, 'subject'), /明确选择/);
  assert.match(settings.generationInputIssue(shot(), p, p.models[0], [], 'subject', { subjectReference: reference() }), /已缺失/);
  assert.match(settings.generationInputIssue(shot(), p, p.models[0], [asset(1, { sha256: 'f'.repeat(64) })], 'subject', { subjectReference: reference() }), /内容或元数据已变化/);
  assert.match(settings.generationInputIssue(shot(), p, p.models[0], [asset(1, { sizeBytes: 11 * 1024 * 1024 })], 'subject', { subjectReference: reference() }), /大小.*限制/);
  const webp = subjectVideo.subjectVideoChoice(subject(), version(1, { mimeType: 'image/webp' }));
  assert.match(settings.generationInputIssue(shot(), p, p.models[0], [asset(1, { mimeType: 'image/webp' })], 'subject', { subjectReference: webp }), /格式/);
  const first = shot({ referenceAssetIds: [asset().id] });
  assert.match(settings.generationInputIssue(first, p, p.models[0], assets, 'image'), /画幅比例一致/, 'Existing Ark first-frame ratio requirement remains unchanged');
});

test('real selector requires a separate version action, uses paginated library, and preserves old/new labels', () => {
  const props = selectionProps({ inputMode: 'subject' }), h = harness('SubjectVideoSelection.jsx', props);
  assert.equal(h.find('subject-video-subject').props.value, ''); assert.equal(h.find('subject-video-version'), undefined); assert.equal(props.changes.length, 0);
  h.find('subject-video-subject').props.onChange({ target: { value: subjectId } });
  assert.deepEqual(props.changes[0], { subjectId, subjectReference: null });
  h.render({ options: { inputMode: 'subject', subjectId } });
  assert.equal(h.find('subject-video-version').props.value, '');
  h.find('subject-video-version').props.onChange({ target: { value: version().id } });
  assert.equal(props.changes[1].subjectReference.subjectVersionId, version().id);
  const pagers = h.nodes().filter(node => node.type === 'SubjectPager');
  pagers[0].props.onPage('next'); pagers[1].props.onPage('previous'); assert.deepEqual(props.reads, ['next', 'previous']);
  assert.match(h.text(), /Ark 不支持直接上传真实人脸图片/); assert.match(h.text(), /不进行人脸检测/); assert.match(h.text(), /仅保留在当前页面会话/);
  assert.doesNotMatch(h.text(), /保证检测所有|保证身份锁定/);
});

test('selector hidden/returned and obsolete model, choice, project, shot callbacks cannot change a session choice', () => {
  for (const change of ['hide', 'model', 'choice', 'project', 'shot', 'disabled', 'unmount']) {
    const props = selectionProps({ inputMode: 'subject', subjectId }), h = harness('SubjectVideoSelection.jsx', props);
    const old = h.find('subject-video-version').props.onChange;
    if (change === 'hide') { h.visible = false; h.render(); assert.equal(h.find('subject-video-enabled').props.disabled, true); h.visible = true; h.render(); }
    if (change === 'model') h.render({ model: 'unavailable' });
    if (change === 'choice') h.render({ options: { ...props.options, subjectReference: reference(2) } });
    if (change === 'project') { props.subjects.state.scope = `${id(99)}:2`; h.render(); }
    if (change === 'shot') h.render({ shot: shot({ id: id(88) }) });
    if (change === 'disabled') h.render({ disabled: true });
    if (change === 'unmount') h.unmount();
    old({ target: { value: version().id } }); assert.equal(props.changes.length, 0, change);
  }
});

test('selector exposes unavailable reasons and never auto-clears saved first or tail choices', () => {
  const saved = shot({ referenceAssetIds: [asset().id], lastFrameAssetId: asset(2).id }), props = selectionProps(), h = harness('SubjectVideoSelection.jsx', { ...props, shot: saved, draft: shot() });
  assert.equal(h.find('subject-video-enabled').props.disabled, true); assert.match(h.text(), /保存镜头/);
  h.find('subject-video-enabled').props.onCheckedChange(true); assert.deepEqual(props.changes, []);
  h.render({ shot: shot(), draft: shot(), provider: provider('mock'), model: provider('mock').models[0] });
  h.find('subject-video-enabled').props.onCheckedChange(true); assert.deepEqual(props.changes, [{ inputMode: 'subject' }]);
  assert.match(h.text(), /Mock 仅验证工作流，输出为测试图案/);
});

test('subject provenance summary shows human labels, pinned old/current versions and collapsed source identity', () => {
  const h = harness('SubjectVideoSummary.jsx', { reference: reference(), assets, latestSubject: subject(2) });
  assert.match(h.text(), /方形产品.*固定 V1.*用户导入图片/); assert.match(h.text(), /本次仍固定 V1；主体库当前为 V2/);
  assert.equal(h.nodes().filter(node => node.type === 'img').length, 1);
  const detail = h.nodes().find(node => node.type === 'details'); assert.equal(detail.props.open, undefined); assert.match(text(detail), new RegExp(version().id)); assert.match(text(detail), /1{64}/);
  h.render({ assets: [asset(1, { sha256: 'f'.repeat(64) })] }); assert.equal(h.nodes().filter(node => node.type === 'img').length, 0); assert.match(h.text(), /原图暂不可用/);
});

function reviewHarness({ retry = false } = {}) {
  const p = provider(), original = reference();
  const snapshot = { ...subjectVideo.subjectVideoSnapshot(shot(), original, assets), providerId: p.id, model: p.models[0], inputProfileId: p.inputProfiles[0].profileId, inputProfileVersion: p.inputProfiles[0].profileVersion, providerRegion: p.providerRegion };
  delete snapshot.id;
  const job = { id: id(66), snapshot }, state = { epoch: 1, review: null, sent: [], notices: [] };
  const scope = { ...settings, ...subjectVideo, providers: [p], dataRef: { current: { shots: [shot()], jobs: [job], assets: structuredClone(assets) } },
    generationOptionsRef: { current: { [shotId]: { providerId: p.id, model: p.models[0], inputMode: 'subject', subjectReference: original } } },
    realConfirmRef: { current: null }, generationReviewScope: { current: { key: 'view' } },
    context: () => ({ epoch: state.epoch }), isCurrent: value => value.epoch === state.epoch,
    setRealConfirm: value => { state.review = value; }, notify: message => state.notices.push(message), submitGeneration: args => state.sent.push(args),
  };
  const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('  function reviewGeneration('), source.indexOf('  async function createProject('));
  const app = Function(...Object.keys(scope), `${code}; return { reviewGeneration, confirmGeneration };`)(...Object.values(scope));
  app.reviewGeneration({ shot: retry ? { ...snapshot, id: shotId } : shot(), providerId: p.id, model: p.models[0], inputMode: 'subject', ...(retry ? { retryJobId: job.id, expectedRetrySnapshot: snapshot } : { subjectReference: original }) });
  return { ...app, scope, state, original: state.review };
}

test('actual paid review fixes version and source content; stale owner/view/choice/provider/model/profile/asset changes cannot submit', () => {
  for (const change of ['none', 'owner', 'view', 'shot', 'revision', 'version', 'provider', 'model', 'profile', 'assetHash', 'assetSize', 'assetPath', 'cancel']) {
    const h = reviewHarness(), { scope, state, original } = h;
    if (change === 'owner') state.epoch++;
    if (change === 'view') scope.generationReviewScope.current = { key: 'view' };
    if (change === 'shot') scope.dataRef.current.shots = [shot({ id: id(99) })];
    if (change === 'revision') scope.dataRef.current.shots[0].revision++;
    if (change === 'version') scope.generationOptionsRef.current[shotId].subjectReference = reference(2);
    if (change === 'provider') scope.generationOptionsRef.current[shotId].providerId = 'mock';
    if (change === 'model') scope.generationOptionsRef.current[shotId].model = 'unknown';
    if (change === 'profile') scope.providers[0].inputProfiles[0].inputs.roles.subject_reference.maxBytes--;
    if (change === 'assetHash') scope.dataRef.current.assets[0].sha256 = 'f'.repeat(64);
    if (change === 'assetSize') scope.dataRef.current.assets[0].sizeBytes++;
    if (change === 'assetPath') scope.dataRef.current.assets[0].relativePath = 'assets/other.png';
    if (change === 'cancel') scope.realConfirmRef.current = null;
    assert.equal(original.subjectReference.subjectVersionId, version().id);
    assert.equal(original.referenceAssets[0].sha256, version().sha256);
    h.confirmGeneration(original); h.confirmGeneration(original);
    assert.equal(state.sent.length, change === 'none' ? 1 : 0, change);
  }
});

test('frozen retry ignores newer subject head/planning choice and uses original version; current source substitution blocks', () => {
  const h = reviewHarness({ retry: true });
  h.scope.generationOptionsRef.current[shotId].subjectReference = reference(2);
  h.scope.dataRef.current.shots[0] = shot({ revision: 7, referenceAssetIds: [asset(2).id], lastFrameAssetId: asset().id });
  h.confirmGeneration(h.original); assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.sent[0].shot.subjectReference.subjectVersionId, version().id);
  assert.deepEqual(h.state.sent[0].shot.referenceAssetIds, [asset().id]);
  const changed = reviewHarness({ retry: true }); changed.scope.dataRef.current.assets[0].sha256 = 'f'.repeat(64);
  changed.confirmGeneration(changed.original); assert.equal(changed.state.sent.length, 0);
  const p = provider(), frozen = h.original.shot;
  assert.equal(settings.generationInputIssue(frozen, p, p.models[0], assets, 'subject', { frozen: true }), '');
});

function inspectorProps(save, generated) {
  const p = provider('mock');
  return { shot: shot(), project: { id: projectId }, assets, versions: [], jobs: [], providers: [p], tab: 'settings', busy: {},
    generationOptions: { providerId: p.id, model: p.models[0], inputMode: 'subject', subjectReference: reference() },
    onSave: save, onGenerate: (...args) => generated.push(args), onDirtyChange() {}, setTab() {}, onCompare() {}, onOpenJobs() {}, onSelectVersion() {}, onAddVersion() {}, onGenerationOptionsChange() {} };
}

test('Inspector saves only shot fields then generates explicit pinned option, and late save cannot act on changed selection', async () => {
  for (const change of ['none', 'version', 'provider', 'model', 'tab', 'scope', 'edit', 'unmount']) {
    const wait = deferred(), generated = [], saved = [], props = inspectorProps((id, revision, draft) => { saved.push(structuredClone(draft)); return wait.promise; }, generated);
    const h = harness('Inspector.jsx', props);
    h.find('shot-prompt').props.onChange({ target: { value: 'Saved words only.' } }); h.render();
    const sending = h.find('generate-shot').props.onClick();
    if (change === 'version') h.render({ generationOptions: { ...props.generationOptions, subjectReference: reference(2) } });
    if (change === 'provider') h.render({ generationOptions: { ...props.generationOptions, providerId: 'ark' } });
    if (change === 'model') h.render({ generationOptions: { ...props.generationOptions, model: 'other' } });
    if (change === 'tab') h.render({ tab: 'versions' });
    if (change === 'scope') h.render({ actionScopeKey: 'agent' });
    if (change === 'edit') { h.find('shot-prompt').props.onChange({ target: { value: 'New unsaved words.' } }); h.render(); }
    if (change === 'unmount') h.unmount();
    wait.resolve(shot({ prompt: 'Saved words only.', revision: 2 })); await sending;
    assert.equal(saved.length, 1); assert.equal(Object.hasOwn(saved[0], 'subjectReference'), false); assert.equal(Object.hasOwn(saved[0], 'subjectVersionId'), false);
    assert.equal(saved[0].prompt, 'Saved words only.'); assert.deepEqual(saved[0].referenceAssetIds, []);
    assert.equal(generated.length, change === 'none' ? 1 : 0, change);
    if (change === 'none') { assert.equal(generated[0][1].subjectReference.subjectVersionId, version().id); assert.equal(generated[0][0].prompt, 'Saved words only.'); }
  }
});

test('App uses subjectVersionId only on wire, exact expected reference beside pending input, and disclosures in review/history/tasks', () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const submit = app.slice(app.indexOf('const submitGeneration ='), app.indexOf('function generate('));
  assert.match(submit, /subjectVersionId: subjectReference.subjectVersionId/);
  assert.match(submit, /expectedSubjectReference: subjectReference/);
  assert.doesNotMatch(submit, /subjectBinding|headVersion|referenceAssetIds|referenceBindings|lastFrameAssetId/);
  assert.match(app, /isSubjectGenerationResponse\(operation, input, result, \{ projectId, subjectReference: stored.expectedSubjectReference \}\)/);
  assert.match(app, /paid-subject-face-warning/);
  const inspector = readFileSync(new URL('../apps/web/src/Inspector.jsx', import.meta.url), 'utf8');
  const tasks = readFileSync(new URL('../apps/web/src/TaskCenter.jsx', import.meta.url), 'utf8');
  assert.match(inspector, /SubjectVideoSummary reference=\{v.snapshot.subjectReference\}/);
  assert.match(tasks, /SubjectVideoSummary reference=\{job.snapshot\?\.subjectReference\}/);
});

test('actual App subject retry captures original public snapshot beside unchanged wire input; legacy retries remain unchanged', async () => {
  const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('  const submitGeneration ='), source.indexOf('  function reviewGeneration('));
  const p = provider('mock'), calls = [], notices = [];
  const original = { ...subjectVideo.subjectVideoSnapshot(shot(), reference(), assets), providerId: p.id, model: p.models[0], shotId, shotRevision: 1 }; delete original.id;
  const job = { id: id(88), shotId, providerId: p.id, model: p.models[0], snapshot: structuredClone(original) };
  const scope = { captureTaskWorkspaceIntent, readTaskRevealContext: () => ({ active: true, projectId, projectEpoch: 0, navigationEpoch: 0, panelIntent: 0, workspaceScope: 'test-workspace' }), openTasks() {}, providers: [p], checkGeneration: () => true, subjectVideoIdentity: subjectVideo.subjectVideoIdentity,
    run: (...args) => { calls.push(args); return Promise.resolve({ id: id(89) }); }, requestId: () => 'frozen-subject-retry-request', notify: message => notices.push(message) };
  const methods = Function(...Object.keys(scope), `${code}; return { submitGeneration, retryGeneration };`)(...Object.values(scope));
  methods.retryGeneration(job);
  job.snapshot.subjectReference = reference(2); job.snapshot.prompt = 'A changed current prompt';
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'job.retry'); assert.deepEqual(calls[0][2], { jobId: job.id, requestId: 'frozen-subject-retry-request' });
  assert.equal(calls[0][4].subjectRetry, true); assert.deepEqual(calls[0][4].expectedRetrySnapshot, original);
  assert.deepEqual(calls[0][4].expectedSubjectReference, original.subjectReference);
  await methods.submitGeneration({ shot: { ...original, id: shotId }, providerId: p.id, model: p.models[0], inputMode: 'subject', retryJobId: job.id });
  assert.equal(calls.length, 1); assert.match(notices.at(-1), /原主体任务快照缺失/);
  const legacy = { ...job, snapshot: { prompt: 'Legacy prompt', referenceAssetIds: [], duration: 4, aspectRatio: '9:16' } };
  methods.retryGeneration(legacy); assert.equal(calls.length, 2); assert.equal(calls[1].length, 4);
  assert.deepEqual(calls[1][2], { jobId: job.id, requestId: 'frozen-subject-retry-request' });
});

test('TaskCenter routes marked or observed subject retries to strict recovery and preserves genuine legacy options', () => {
  const calls = [], entries = [
    { key: 'retry:subject', projectId, operation: 'job.retry', input: { jobId: id(88), requestId: 'original-subject-request' }, subjectRetry: true },
    { key: 'retry:legacy', projectId, operation: 'job.retry', input: { jobId: id(89), requestId: 'original-legacy-request' } },
    { key: 'retry:stripped', projectId, operation: 'job.retry', input: { jobId: id(90), requestId: 'stripped-subject-request' } },
  ];
  const h = harness('TaskCenter.jsx', { captureView: () => () => true, taskViewScope: 'subject-retry-current-view', activeCount: 0, pending: entries, busy: {}, jobs: [], data: { assets: [], shots: [], jobs: [{ id: id(90), projectId, snapshot: { subjectReference: reference() } }] }, tasks: { phase: 'ready', items: [], uncertain: [], busy: [] }, run: (...args) => calls.push(args), onClose() {} });
  const rows = h.nodes().filter(node => node.type === './PendingSubmission.jsx'); assert.equal(rows.length, 3);
  rows[0].props.onReplay(); rows[1].props.onReplay(); rows[2].props.onReplay();
  assert.deepEqual(calls[0][4], { replay: true, subjectRetry: true }); assert.deepEqual(calls[1][4], { replay: true });
  assert.deepEqual(calls[0][2], entries[0].input); assert.deepEqual(calls[2][4], { replay: true, subjectRetry: true });
});
