import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import * as subjectVideo from '../apps/web/src/subject-video.ts';
import * as settings from '../apps/web/src/generation-settings.ts';
import * as api from '../apps/web/src/api.ts';
import * as submissions from '../apps/web/src/submissions.ts';
import * as mutations from '../apps/web/src/mutation-submissions.ts';
import { RESTORE_DISABLED_REASON } from '../apps/web/src/restored-workspace.ts';
import { referenceForShot } from '../apps/web/src/reference-connections.ts';
import { imageEditSourceIssueDescriptor } from '../apps/web/src/image-generation.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const taskIntentModule = { exports: {} };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), firstId = id(3), tailId = id(4), otherId = id(5);
const asset = (assetId, name) => ({ id: assetId, projectId, name, mimeType: 'image/png', sha256: String(assetId === firstId ? 'a' : assetId === tailId ? 'b' : 'c').repeat(64), width: 720, height: 1280, sizeBytes: 100, relativePath: `assets/${assetId}.png` });
const assets = [asset(firstId, '晨光首帧'), asset(tailId, '暮色尾帧'), asset(otherId, '另一张图片')];
function provider(providerId = 'mock') {
  const profile = contracts.GENERATION_INPUT_PROFILES.find(item => item.providerId === providerId);
  return { id: providerId, name: providerId, mock: providerId === 'mock', status: 'available', enabled: true, configured: true,
    models: [profile.model], modelCapabilities: [{ id: profile.model, inputModes: profile.inputModes, aspectRatios: profile.aspectRatios, durations: profile.durationsSeconds, referenceImages: { min: profile.inputs.minReferences, max: profile.inputs.maxReferences } }],
    providerRegion: profile.regions[0], inputProfileVersion: contracts.INPUT_PROFILE_VERSION, inputProfiles: [profile], profileEvaluationDate: '2026-10-10',
    inputProfileEvaluations: [{ profileId: profile.profileId, ...contracts.evaluateCapabilityLifecycle(profile, { asOf: '2026-10-10' }) }] };
}
const shot = patch => ({ id: shotId, projectId, revision: 1, title: '日夜变化', prompt: 'A quiet sunrise', referenceAssetIds: [firstId], duration: 4, aspectRatio: '9:16', parameters: {}, orderIndex: 0, ...patch });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };
const equalDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));

// Deterministic real-component events/effects. Native desktop layout is separate QA.
function harness(patch = {}) {
  const slots = [], modules = new Map(), saves = [], generated = [], confirmations = [];
  let cursor = 0, layouts = [], effects = [], tree, needsRender = false, unmounted = false, locale = 'zh-Hans';
  const h = { visible: true, confirm: async message => { confirmations.push(renderCoreMessage('zh-Hans', message)); return true; }, saves, generated, confirmations };
  let props = { shot: shot(), project: { id: projectId }, assets, versions: [], jobs: [], providers: [provider()], busy: {}, tab: 'settings', generationOptions: { providerId: 'mock', model: provider().models[0], inputMode: 'image' },
    onDirtyChange() {}, setTab() {}, onOpenJobs() {}, onCompare() {}, onAddVersion() {}, onSelectVersion() {},
    onGenerationOptionsChange: (_, next) => { props = { ...props, generationOptions: next }; },
    onGenerate: (...args) => generated.push(args),
    onSave: async (savedId, revision, draft) => { saves.push({ id: savedId, revision, draft: structuredClone(draft) }); const saved = { ...props.shot, ...draft, revision: revision + 1 }; props = { ...props, shot: saved }; return saved; }, ...patch };
  const effect = (queue, callback, deps) => { const i = cursor++, prior = slots[i]; if (prior && equalDeps(deps, prior.deps)) return; slots[i] = { deps, callback, cleanup: prior?.cleanup }; queue.push(i); };
  const react = {
    createElement: (type, properties, ...children) => typeof type === 'function' ? type({ ...properties, children }) : { type, props: { ...properties, children } },
    useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; needsRender = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (callback, deps) => effect(effects, callback, deps), useLayoutEffect: (callback, deps) => effect(layouts, callback, deps),
  }; react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) });
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const code = transformSync(readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
    const module = { exports: {} };
    Function('require', 'module', 'exports', code)(name => {
      if (name === 'react') return react;
      if (name === './i18n/I18nProvider.tsx') return { useI18n: () => createI18nTestContext(locale) };
      if (name === './creation-i18n.ts') return creationI18n;
      if (name.includes('packages/i18n/src/index.ts')) return i18nCore;
      if (name === './local-shot-text-state.ts') return { useLocalShotText: ({ context }) => {
        assert.equal(context.restored, true, 'This legacy Inspector fixture has no shot-text context');
        return { state: {}, controller: { setContext() {} } };
      }, mergeFreshShotTextAck: () => { assert.fail('No shot-text acknowledgement is expected in this fixture'); } };
      if (name === './ShotTextDraftRecovery.tsx') return { default: 'ShotTextDraftRecovery', __esModule: true };
      // These passive leaves do not participate in saved frame drafts or their
      // confirmation epochs; keep the actual Inspector/frame controls below.
      if (['./AssetAnnotations.tsx','./CanvasOverview.tsx','./BoardInspectorGroup.tsx','./VersionCardPreview.tsx'].includes(name)) return { default: name, __esModule: true };
      if (name === './image-generation.ts') return { imageEditSourceIssueDescriptor };
      if (name === '@mioon/contracts') return contracts;
      if (name === '@mioon/contracts/local-shot-text') return { LOCAL_SHOT_TEXT_LIMITS };
      if (name === './generation-settings.ts') return settings;
      if (name === './subject-video.ts') return subjectVideo;
      if (['./SubjectVideoSelection.tsx', './SubjectVideoSummary.tsx'].includes(name)) return { default: name, __esModule: true };
      if (name === './api.ts') return api;
      if (name === './reference-connections.ts') return { referenceForShot };
      if (name === './VideoFrameControls.tsx') return load('VideoFrameControls.tsx');
      if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => h.visible };
      if (name === '@mioon/ui/components/workbench-confirm') return { useConfirmation: () => message => h.confirm(message) };
      if (name.endsWith('.css')) return {};
      if (name === './icons.tsx') return { default: 'Icon', __esModule: true };
      if (name.startsWith('@mioon/ui/')) return primitive;
      if (name === './Nodes.tsx') return { Media: 'Media' };
      if (name === './Timeline.tsx') return { dragAsset() {} };
      if (name === './ProviderSettings.tsx') return { default: 'ProviderSettings', __esModule: true };
      if (name === './ShotSubjectBindings.tsx') return { default: 'ShotSubjectBindings', __esModule: true };
      if (name === './WorkspaceControls.tsx') return { WorkbenchSelect: 'WorkbenchSelect' };
      if (name === './ReferenceConnections.tsx') return { BoundReference: 'BoundReference', ReferenceSourcePanel: 'ReferenceSourcePanel' };
      throw Error(`Unexpected dependency ${name}`);
    }, module, module.exports);
    modules.set(filename, module.exports); return module.exports;
  }
  const Component = load('Inspector.tsx').default;
  const flush = queue => { for (const i of queue) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } };
  Object.assign(h, {
    render(next = {}) { assert.equal(unmounted, false); props = { ...props, ...next }; let tries = 0; do { needsRender = false; cursor = 0; layouts = []; effects = []; tree = Component(props); flush(layouts); flush(effects); assert.ok(++tries < 20); } while (needsRender); return tree; },
    find(testId) { return nodes(tree).find(node => node.props?.['data-testid'] === testId || node.props?.id === testId); },
    all: () => nodes(tree), text: () => text(tree), props: () => props,
    setLanguage(next) { locale = next; return h.render(); },
    edit(testId, value) { h.find(testId).props.onChange({ target: { value } }); h.render(); },
    click(testId) { return h.find(testId).props.onClick(); },
    reset() { nodes(tree).find(node => node.type === 'Button' && text(node) === '放弃修改').props.onClick(); h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); unmounted = true; },
  });
  h.render(); return h;
}

test('tail omission stays omitted in legacy drafts/saves; explicit null and saved tail retain exact semantics', async () => {
  const legacy = harness(); legacy.edit('shot-prompt', 'Updated'); await legacy.click('save-shot');
  assert.equal(Object.hasOwn(legacy.saves[0].draft, 'lastFrameAssetId'), false);
  for (const value of [null, tailId]) {
    const h = harness({ shot: shot({ lastFrameAssetId: value }) }); h.edit('shot-title', 'Renamed'); await h.click('save-shot');
    assert.equal(h.saves[0].draft.lastFrameAssetId, value); assert.deepEqual(h.saves[0].draft.referenceAssetIds, [firstId]);
  }
});

test('tail picker persists through normal save/reload, reset restores omission, clear writes only explicit null', async () => {
  const h = harness(); h.click(`last-frame-choice-${tailId}`); h.render(); assert.match(h.text(), /暮色尾帧/);
  h.reset(); assert.equal(h.find('clear-last-frame'), undefined);
  h.click(`last-frame-choice-${tailId}`); h.render(); await h.click('save-shot'); h.render();
  assert.equal(h.saves[0].draft.lastFrameAssetId, tailId); assert.deepEqual(h.saves[0].draft.referenceAssetIds, [firstId]);
  const reopened = harness({ shot: h.props().shot }); assert.match(reopened.text(), /已选尾帧：暮色尾帧/);
  await reopened.click('clear-last-frame'); reopened.render(); await reopened.click('save-shot');
  assert.equal(reopened.saves[0].draft.lastFrameAssetId, null); assert.deepEqual(reopened.saves[0].draft.referenceAssetIds, [firstId]);
});

test('restored Inspector retains frame history and local tail edits while blocking save-and-generate', async () => {
  const frozen = { ...shot(), referenceAssetIds: [firstId, tailId], referenceAssets: assets.slice(0, 2), referenceBindings: [{ role: 'first_frame', assetId: firstId, sha256: assets[0].sha256 }, { role: 'last_frame', assetId: tailId, sha256: assets[1].sha256 }] };
  const h = harness({ generationUnavailableReason: RESTORE_DISABLED_REASON, shot: shot({ lastFrameAssetId: tailId }),
    versions: [{ id: id(8), shotId, number: 1, snapshot: frozen, createdAt: '2026-10-10T00:00:00Z' }],
    jobs: [{ id: id(9), shotId, status: 'running', progress: 35, createdAt: '2026-10-10T00:00:00Z' }] });
  assert.equal(text(h.find('generation-issue')), RESTORE_DISABLED_REASON);
  assert.equal(h.find('generate-shot').props.disabled, true);
  assert.equal(h.find('generate-shot').props.title, RESTORE_DISABLED_REASON);
  assert.equal(h.all().some(node => node.props?.className === 'progress-track'), false, 'captured running history must not appear to be executing');
  h.click(`last-frame-choice-${otherId}`); h.render();
  assert.equal(Boolean(h.find('save-shot').props.disabled), false);
  await h.click('generate-shot'); assert.equal(h.saves.length, 0); assert.equal(h.generated.length, 0, 'even a direct disabled callback cannot submit');
  await h.click('save-shot'); h.render();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].draft.lastFrameAssetId, otherId);
  assert.deepEqual(h.saves[0].draft.referenceAssetIds, [firstId]); assert.equal(h.generated.length, 0);
  const historical = h.all().find(node => node.props?.['data-testid'] === 'video-frame-summary');
  assert.match(text(historical), /晨光首帧/); assert.match(text(historical), /暮色尾帧/); assert.doesNotMatch(text(historical), /另一张图片/);
  assert.equal(nodes(historical).filter(node => node.type === 'img').length, 2);
  assert.match(text(h.find('selected-last-frame-label')), /另一张图片/); h.unmount();
});

test('bound first frame does not lock tail; busy, pending and conflicting reference work block both', () => {
  const edge = { id: id(6), kind: 'reference', role: 'first_frame', source: id(7), target: shotId, sourceAssetId: firstId };
  const h = harness({ edges: [edge] });
  const first = h.all().find(node => node.props?.['aria-label'] === '参考图 晨光首帧');
  assert.equal(first.props.disabled, true); assert.equal(h.find(`last-frame-choice-${tailId}`).props.disabled, false);
  h.click(`last-frame-choice-${tailId}`); h.render(); assert.ok(h.find('clear-last-frame'));
  for (const patch of [{ referenceBusy: true }, { referencePending: true }, { shot: shot({ revision: 2, title: 'External edit' }) }]) {
    const blocked = harness(); blocked.click(`last-frame-choice-${tailId}`); blocked.render(); blocked.render(patch);
    assert.equal(blocked.find(`last-frame-choice-${otherId}`).props.disabled, true);
    assert.equal(blocked.find('generate-shot').props.disabled, true); assert.equal(blocked.find('save-shot').props.disabled, true);
  }
});

test('tail-only and same-image drafts remain saveable but cannot submit; provider switch retains tail visibly', async () => {
  const h = harness({ shot: shot({ referenceAssetIds: [] }) }); h.click(`last-frame-choice-${tailId}`); h.render();
  assert.match(h.find('generation-issue') && text(h.find('generation-issue')), /尾帧必须与一张首帧/);
  assert.equal(h.find('generate-shot').props.disabled, true); assert.equal(Boolean(h.find('save-shot').props.disabled), false);
  await h.click('save-shot'); assert.equal(h.saves[0].draft.lastFrameAssetId, tailId); assert.deepEqual(h.saves[0].draft.referenceAssetIds, []);
  const pair = harness({ shot: shot({ lastFrameAssetId: firstId }) }); assert.match(text(pair.find('generation-issue')), /不同素材.*当前应用限制/);
  const unsupported = provider('runway'); pair.render({ shot: shot({ lastFrameAssetId: tailId }), providers: [unsupported], generationOptions: { providerId: unsupported.id, model: unsupported.models[0], inputMode: 'text' } });
  assert.ok(pair.find('video-last-frame-controls')); assert.equal(pair.find('generate-shot').props.disabled, true);
});

test('text mode explicitly confirms clearing both frames and never invents null for old first-only shots', async () => {
  for (const hasTail of [false, true]) {
    const h = harness({ shot: shot(hasTail ? { lastFrameAssetId: tailId } : {}) }); h.edit('input-mode-select', 'text'); await Promise.resolve(); h.render();
    assert.match(h.confirmations[0], /首帧与尾帧/); await h.click('save-shot');
    assert.deepEqual(h.saves[0].draft.referenceAssetIds, []);
    assert.equal(Object.hasOwn(h.saves[0].draft, 'lastFrameAssetId'), hasTail);
    if (hasTail) assert.equal(h.saves[0].draft.lastFrameAssetId, null);
  }
});

test('all four languages update an open frame confirmation while retaining the exact unsaved draft and approval', async () => {
  for (const operation of ['clear-last-frame', 'clear-manual-references', 'input-mode-select']) {
    const pending = deferred(), h = harness({ shot: shot({ lastFrameAssetId: tailId }) }), prompts = [];
    const title = '用户原始标题 <not a key>', prompt = 'Unchanged prompt 日本語';
    h.edit('shot-title', title); h.edit('shot-prompt', prompt);
    h.confirm = value => { prompts.push(value); return pending.promise; };
    const work = operation === 'input-mode-select' ? h.find(operation).props.onChange({ target: { value: 'text' } }) : h.click(operation);
    assert.equal(prompts.length, 1); assert.equal(typeof prompts[0], 'object', 'Confirmation owns a descriptor, not a resolved string');
    const expectedKey = operation === 'input-mode-select' ? 'inspector.confirm.textMode' : operation === 'clear-manual-references' ? 'inspector.confirm.clearManual' : 'inspector.confirm.clearLastFrame';
    assert.equal(prompts[0].key, expectedKey);
    const originalPrompt = structuredClone(prompts[0]), labels = new Set(), confirmations = new Set();
    for (const locale of i18nCore.LOCALES) {
      h.setLanguage(locale);
      assert.equal(h.find('shot-title').props.value, title); assert.equal(h.find('shot-prompt').props.value, prompt);
      assert.equal(h.find(`last-frame-choice-${tailId}`).props['aria-pressed'], true);
      assert.equal(h.props().shot.revision, 1); assert.equal(h.saves.length, 0); assert.equal(h.generated.length, 0);
      assert.equal(h.find('input-mode-select').props.value, 'image');
      assert.equal(text(h.find('clear-last-frame')), i18nCore.translate(locale, 'timeline.references.clear'));
      labels.add(text(h.find('clear-last-frame'))); confirmations.add(i18nCore.renderMessage(locale, prompts[0]));
      assert.deepEqual(prompts[0], originalPrompt); assert.equal(prompts.length, 1);
    }
    assert.equal(labels.size, 4); assert.equal(confirmations.size, 4);
    pending.resolve(true); await work; h.render();
    assert.equal(operation === 'clear-manual-references' ? h.find('clear-manual-references') : h.find('clear-last-frame'), undefined, 'The same approval remains valid after language-only updates');
    assert.equal(h.find('shot-title').props.value, title); assert.equal(h.find('shot-prompt').props.value, prompt);
    await h.click('save-shot'); assert.equal(h.saves.length, 1); assert.equal(h.generated.length, 0);
    assert.equal(h.saves[0].revision, 1); assert.equal(h.saves[0].draft.title, title); assert.equal(h.saves[0].draft.prompt, prompt);
    assert.equal(h.saves[0].draft.lastFrameAssetId, operation === 'clear-manual-references' ? tailId : null);
    assert.deepEqual(h.saves[0].draft.referenceAssetIds, operation === 'clear-last-frame' ? [firstId] : []);
  }
});

test('late clear/mode confirmations cannot overwrite edits, hidden/reopened panels, changed tabs or unmounted shots', async () => {
  for (const operation of ['clear-last-frame', 'input-mode-select']) for (const change of ['edit', 'hide', 'tab', 'scope', 'provider', 'unmount']) {
    const wait = deferred(), h = harness({ shot: shot({ lastFrameAssetId: tailId }) }); h.confirm = () => wait.promise;
    const work = operation === 'input-mode-select' ? h.find(operation).props.onChange({ target: { value: 'text' } }) : h.click(operation);
    if (change === 'edit') h.edit('shot-prompt', 'A newer edit');
    if (change === 'hide') { h.visible = false; h.render(); h.visible = true; h.render(); }
    if (change === 'tab') { h.render({ tab: 'versions' }); h.render({ tab: 'settings' }); }
    if (change === 'scope') { h.render({ actionScopeKey: 'agent' }); h.render({ actionScopeKey: 'properties' }); }
    if (change === 'provider') h.render({ generationOptions: { ...h.props().generationOptions, model: 'different' } });
    if (change === 'unmount') h.unmount();
    wait.resolve(true); await work; await Promise.resolve();
    if (change !== 'unmount') { h.render(); assert.ok(h.find('clear-last-frame'), `${operation}/${change} keeps selected tail`); }
    assert.equal(h.saves.length, 0); assert.equal(h.generated.length, 0);
  }
});

test('late save acknowledges the saved draft but cannot generate after tab/provider change or a newer tail edit', async () => {
  for (const change of ['tab', 'scope', 'provider', 'edit', 'unmount']) {
    const wait = deferred(), h = harness({ onSave: () => wait.promise }); h.click(`last-frame-choice-${tailId}`); h.render();
    const work = h.click('generate-shot');
    if (change === 'tab') h.render({ tab: 'versions' });
    if (change === 'scope') h.render({ actionScopeKey: 'image' });
    if (change === 'provider') h.render({ generationOptions: { ...h.props().generationOptions, model: 'changed' } });
    if (change === 'edit') { h.click(`last-frame-choice-${otherId}`); h.render(); }
    if (change === 'unmount') h.unmount();
    wait.resolve(shot({ revision: 2, lastFrameAssetId: tailId })); await work;
    assert.equal(h.generated.length, 0, change);
    if (change === 'edit') { h.render(); assert.match(text(h.find('selected-last-frame-label')), /另一张图片/); }
  }
});

test('preflight counts and validates complete role-aware pair and never appends a present-day tail to frozen jobs', () => {
  const mock = provider(), pair = shot({ lastFrameAssetId: tailId });
  assert.equal(settings.generationInputIssue(pair, mock, mock.models[0], assets, 'image'), '');
  assert.equal(settings.generationSelection([mock], { inputMode: 'text' }, pair).inputMode, 'image');
  assert.deepEqual(settings.generationReferences(pair).references, [{ assetId: firstId, role: 'first_frame' }, { assetId: tailId, role: 'last_frame' }]);
  assert.match(settings.generationInputIssue(pair, mock, mock.models[0], [assets[0]], 'image'), /参考素材已不存在/);
  assert.match(settings.generationInputIssue(pair, mock, mock.models[0], assets, 'text'), /明确清除首帧与尾帧/);
  assert.match(settings.generationInputIssue(pair, mock, mock.models[0], [assets[0], { ...assets[1], sizeBytes: undefined }], 'image'), /元数据/);
  const frozen = { ...shot(), referenceAssets: [assets[0]] };
  assert.equal(settings.generationReferences(frozen, { frozen: true }).references.length, 1);
  assert.equal(settings.generationInputIssue(frozen, mock, mock.models[0], assets, 'image', { frozen: true }), '');
  assert.equal(settings.generationReferencePreview(frozen, assets, { frozen: true }).length, 1);
  assert.match(settings.generationInputIssue(frozen, mock, mock.models[0], [{ ...assets[0], sha256: 'f'.repeat(64) }], 'image', { frozen: true }), /冻结内容不一致/);
});

test('history summary includes both frozen human labels/thumbnails with collapsed expandable IDs and hash', () => {
  const frozen = { ...shot(), referenceAssetIds: [firstId, tailId], referenceAssets: assets.slice(0, 2), referenceBindings: [{ role: 'first_frame', assetId: firstId, sha256: assets[0].sha256 }, { role: 'last_frame', assetId: tailId, sha256: assets[1].sha256 }] };
  const h = harness({ shot: shot({ lastFrameAssetId: otherId }), versions: [{ id: id(8), shotId, number: 1, snapshot: frozen, createdAt: '2026-10-10T00:00:00Z' }] });
  const summaries = h.all().filter(node => node.props?.['data-testid'] === 'video-frame-summary'); assert.equal(summaries.length, 2);
  const historical = summaries[0]; assert.match(text(historical), /晨光首帧/); assert.match(text(historical), /暮色尾帧/); assert.doesNotMatch(text(historical), /另一张图片/);
  assert.equal(nodes(historical).filter(node => node.type === 'img').length, 2);
  assert.equal(nodes(historical).filter(node => node.type === 'details' && !node.props.open).length, 2);
  assert.match(text(historical), new RegExp(tailId)); assert.match(text(historical), /b{64}/);
});

test('App paid review wires complete frames and count, frozen retries, asset-use and tab scope without new submission fields', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /checkGeneration\(shot, provider, job.model, inputMode, true\)/);
  assert.match(app, /generationReferences\(realConfirm.shot, \{ frozen: Boolean\(realConfirm.retryJobId\), subjectReference: realConfirm.subjectReference \}\).references.length/);
  assert.match(app, /VideoFrameSummary shot=\{realConfirm.shot\} assets=\{realConfirm.referenceAssets\}/);
  assert.match(app, /shots.flatMap\(shot => generationReferences\(shot\).references.map/);
  const inspectorStart = app.indexOf('<Inspector '), inspectorEnd = app.indexOf('/>', inspectorStart);
  assert.ok(inspectorStart >= 0 && inspectorEnd > inspectorStart);
  const inspectorTag = app.slice(inspectorStart, inspectorEnd);
  assert.match(inspectorTag, /\bactionScopeKey=\{`\$\{rightDockTab\}:\$\{propertiesPage\}`\}/);
  assert.match(inspectorTag, /\bgenerationUnavailableReason=\{generationUnavailableReason(?: as never)?\}/);
  assert.match(app, /generationReferenceIdentity\(args.shot, dataRef.current!\.assets, \{ frozen, subjectReference: args.subjectReference \}\) !== args.referenceIdentity/);
  assert.match(app, /currentShot.revision !== args.shot.revision/);
  const submit = app.slice(app.indexOf('const submitGeneration ='), app.indexOf('function generate('));
  assert.doesNotMatch(submit, /lastFrameAssetId|referenceAssetIds|approve|budget|limit/);
});

test('actual App confirmation sends once and rejects changed content, navigation, provider or stale view scope', () => {
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('  function reviewGeneration('), source.indexOf('  async function createProject('));
  function reviewHarness({ frozen = false } = {}) {
    const p = provider('ark'), current = shot({ lastFrameAssetId: tailId });
    const old = { ...shot(), referenceAssets: [assets[0]] }; delete old.id;
    const job = { id: id(44), snapshot: old };
    const state = { epoch: 0, notices: [], submitted: [], review: null };
    const scope = { msg, ...createI18nTestContext(), localizedError: value => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }), dataRef: { current: { shots: [current], assets: structuredClone(assets), jobs: [job] } }, providers: [p],
      generationOptionsRef: { current: { [shotId]: { providerId: p.id, model: p.models[0], inputMode: 'image' } } },
      realConfirmRef: { current: null }, generationReviewScope: { current: { key: 'original' } },
      context: () => ({ epoch: state.epoch }), isCurrent: value => value.epoch === state.epoch,
      setRealConfirm: value => { state.review = value; }, notify: message => state.notices.push(renderCoreMessage('zh-Hans', message)), submitGeneration: args => state.submitted.push(args),
      generationSelection: settings.generationSelection, generationReferences: settings.generationReferences, generationReferenceIdentity: settings.generationReferenceIdentity };
    const api = Function(...Object.keys(scope), `${functions}; return { reviewGeneration, confirmGeneration };`)(...Object.values(scope));
    api.reviewGeneration({ shot: frozen ? { ...old, id: shotId } : current, providerId: p.id, model: p.models[0], inputMode: 'image', ...(frozen ? { retryJobId: job.id } : {}) });
    return { ...api, state, scope, original: state.review };
  }
  for (const change of ['none', 'epoch', 'tab', 'revision', 'asset', 'provider', 'cancel']) {
    const h = reviewHarness(), { state, scope, original } = h;
    if (change === 'epoch') state.epoch++;
    if (change === 'tab') scope.generationReviewScope.current = { key: 'original' }; // away/back is a new scope
    if (change === 'revision') scope.dataRef.current.shots[0] = { ...scope.dataRef.current.shots[0], revision: 2 };
    if (change === 'asset') scope.dataRef.current.assets[1].sha256 = 'f'.repeat(64);
    if (change === 'provider') scope.generationOptionsRef.current[shotId].providerId = 'mock';
    if (change === 'cancel') scope.realConfirmRef.current = null;
    h.confirmGeneration(original); h.confirmGeneration(original);
    assert.equal(state.submitted.length, change === 'none' ? 1 : 0, change);
  }
  const retry = reviewHarness({ frozen: true });
  assert.equal(retry.original.referenceAssets.length, 1, 'Original job review does not add the current saved tail');
  retry.confirmGeneration(retry.original); assert.equal(retry.state.submitted.length, 1);
  assert.equal(retry.state.submitted[0].shot.referenceAssetIds.length, 1);
});

function mutationRunner(t, result) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('  async function runSession('), app.indexOf('  async function inspect('));
  const state = { result, calls: [], notices: [], pending: [] }, locks = new Set();
  const scope = { msg, ...createI18nTestContext(), localizedError: value => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }), ...contracts, ...submissions, ...mutations, clipConnectionBlocked:{current:false},shotTextRef: { current: null }, dataRef: { current: { project: { id: projectId }, shots: [shot()], nodes: [] } }, currentProject: { current: projectId },
    context: () => ({ projectId, epoch: 1 }), isCurrent: () => true,
    isBusy: key => locks.has(key), markBusy: (_, key, busy) => busy ? locks.add(key) : locks.delete(key),
    setPending: value => { state.pending = value; }, rpc: async (operation, input) => { state.calls.push({ operation, input: structuredClone(input) }); return state.result; },
    refresh: async () => {}, notify: message => state.notices.push(renderCoreMessage('zh-Hans', message)), openTasks() {}, setAuth() {}, readableError: error => error.message,
  };
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify(captured.workspace || 'test-workspace') }; } });
  return { state, scope, values, run: Function(...Object.keys(scope), `${code}; return runSession;`)(...Object.values(scope)) };
}

test('actual save runner keeps malformed tail ACK pending and preserves draft; exact historical replay clears only original key', async t => {
  for (const desired of [tailId, null]) for (const malformed of ['missing', 'wrong', 'null-vs-present']) {
    await t.test(`${desired === null ? 'clear' : 'select'} / ${malformed}`, async t => {
      const acknowledged = shot({ revision: 2, lastFrameAssetId: desired });
      const bad = { ...acknowledged };
      if (malformed === 'missing') delete bad.lastFrameAssetId;
      if (malformed === 'wrong') bad.lastFrameAssetId = otherId;
      if (malformed === 'null-vs-present') bad.lastFrameAssetId = desired === null ? tailId : null;
      const runner = mutationRunner(t, bad), key = `save:${shotId}`;
      const h = harness({ shot: shot(desired === null ? { lastFrameAssetId: tailId } : {}),
        onSave: (savedId, revision, patch) => runner.run(key, 'shot.update', { shotId: savedId, expectedRevision: revision, patch }, undefined, { returnAfterNavigation: true }) });
      if (desired === null) await h.click('clear-last-frame'); else h.click(`last-frame-choice-${desired}`);
      h.render(); await h.click('save-shot'); h.render();
      assert.ok(h.find('save-shot'), 'Unacknowledged save must leave a dirty draft');
      assert.equal(h.generated.length, 0); assert.equal(runner.state.calls.length, 1);
      const original = submissions.readPending(projectId, key), originalBytes = [...runner.values.entries()];
      assert.equal(original.input.patch.lastFrameAssetId, desired);
      assert.match(runner.state.notices[0], /提交结果尚未确认.*原请求已保留/);
      h.click(`last-frame-choice-${otherId}`); h.render(); await h.click('save-shot'); h.render();
      assert.equal(runner.state.calls.length, 1, 'A changed draft is never implicitly sent as a replay');
      assert.deepEqual([...runner.values.entries()], originalBytes);
      runner.scope.dataRef.current.shots = [shot({ revision: 9, lastFrameAssetId: otherId })];
      runner.state.result = acknowledged;
      await runner.run(key, 'shot.update', original.input, undefined, { replay: true });
      h.render(); assert.equal(submissions.readPending(projectId, key), null);
      assert.match(text(h.find('selected-last-frame-label')), /另一张图片/, 'Historical recovery never installs the old saved tail into the current draft');
      assert.ok(h.find('save-shot')); assert.equal(runner.state.calls.length, 2);
      assert.deepEqual(runner.state.calls[1].input, original.input, 'Recovery sends the original exact key and patch');
    });
  }
});

test('actual create runner rejects missing explicit null or UUID tail ACK, while omitted-tail requests keep legacy ACK shape', async t => {
  for (const desired of [tailId, null, undefined]) await t.test(String(desired), async t => {
    const result = shot({ revision: 1 }), runner = mutationRunner(t, result);
    const input = { projectId, title: 'New shot', ...(desired === undefined ? {} : { lastFrameAssetId: desired }) };
    const response = await runner.run('shot-create', 'shot.create', input);
    assert.equal(Boolean(response), desired === undefined);
    assert.equal(Boolean(submissions.readPending(projectId, 'shot-create')), desired !== undefined);
  });
});
