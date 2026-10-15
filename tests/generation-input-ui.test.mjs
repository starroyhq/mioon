import { generationIssueDescriptor } from '../apps/web/src/generation-settings.js';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { GENERATION_INPUT_PROFILES, INPUT_PROFILE_VERSION, evaluateCapabilityLifecycle, getGenerationIssue } from '@mioon/contracts';
import { generationInputIssue, generationIssueMessage, generationProfileSelection, generationSelection } from '../apps/web/src/generation-settings.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (id = 'mock', date = '2026-10-10', region) => {
  const profile = GENERATION_INPUT_PROFILES.find(item => item.providerId === id);
  const providerRegion = region || profile.regions[0];
  return {
    id, name: id, mock: id === 'mock', status: 'available', configured: true, enabled: true,
    models: [profile.model], modelCapabilities: [{ id: profile.model, inputModes: profile.inputModes, aspectRatios: profile.aspectRatios, durations: profile.durationsSeconds }],
    ...(id === 'minimax' || id === 'vidu' ? { region: providerRegion } : {}),
    providerRegion, inputProfileVersion: INPUT_PROFILE_VERSION, inputProfiles: [structuredClone(profile)], profileEvaluationDate: date,
    inputProfileEvaluations: [{ profileId: profile.profileId, ...evaluateCapabilityLifecycle(profile, { asOf: date }) }],
  };
};
const shot = { prompt: 'Quiet sunrise', referenceAssetIds: [], aspectRatio: '9:16', duration: 4, parameters: {} };

test('profile selection requires exact server model, region, metadata version and evaluation without fallback', () => {
  const provider = fixture('vidu', '2026-10-10', 'cn'), model = provider.models[0];
  const selected = generationProfileSelection(provider, model);
  assert.equal(selected.profile, provider.inputProfiles[0]);
  assert.equal(selected.region, 'cn');
  assert.equal(selected.state, 'ready');
  assert.equal(generationProfileSelection(provider, 'unknown-model').state, 'unknown_model');
  for (const [patch, state] of [
    [{ providerRegion: null }, 'unknown_region'], [{ providerRegion: 'eu' }, 'missing_profile'],
    [{ inputProfiles: [] }, 'missing_profile'], [{ inputProfiles: undefined }, 'missing_profile'],
    [{ inputProfileVersion: undefined }, 'unknown_version'], [{ inputProfileVersion: 'future-version' }, 'unknown_version'],
    [{ inputProfiles: [{ ...provider.inputProfiles[0], model: 'other-model' }] }, 'missing_profile'],
    [{ inputProfiles: [{ ...provider.inputProfiles[0], inputs: {} }] }, 'incomplete_profile'],
    [{ profileEvaluationDate: undefined }, 'missing_evaluation'], [{ inputProfileEvaluations: [] }, 'missing_evaluation'],
    [{ profileEvaluationDate: '2026-10-11' }, 'missing_evaluation'],
  ]) {
    const result = generationProfileSelection({ ...provider, ...patch }, model);
    assert.equal(result.state, state); assert.equal(result.profile, null); assert.equal(result.evaluation, null);
  }
  assert.equal(generationProfileSelection(undefined, model).state, 'unloaded');
  assert.equal(generationProfileSelection(provider, '').state, 'unselected');
});

test('lifecycle display and shared preflight use server evaluation date, never browser time', () => {
  const before = fixture('veo', '2026-10-21'), after = fixture('veo', '2026-10-22'), model = before.models[0];
  assert.equal(generationProfileSelection(before, model).state, 'ready');
  assert.equal(generationProfileSelection(before, model).evaluation.warnings[0].code, 'MODEL_LIFECYCLE_WARNING');
  const blocked = generationProfileSelection(after, model);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.evaluation.issues[0].code, 'MODEL_LIFECYCLE_REVALIDATION_REQUIRED');
  assert.equal(generationInputIssue(shot, before, model, [], 'text'), '');
  assert.equal(generationInputIssue(shot, after, model, [], 'text'), generationIssueMessage(getGenerationIssue({ ...shot, model, referenceAssets: [] }, after)));
  assert.match(generationInputIssue(shot, after, model, [], 'text'), /服务器已阻止新提交/);
  const helper = readFileSync(resolve(root, 'apps/web/src/generation-settings.js'), 'utf8');
  const component = readFileSync(resolve(root, 'apps/web/src/GenerationInputSummary.jsx'), 'utf8');
  assert.doesNotMatch(helper + component, /Date\(|Date\.now|fetch\(|getCapabilityProfile\(/);
});

test('renderer preserves missing/full-reference checks and never converts subject bindings into generation inputs', () => {
  const provider = fixture(), model = provider.models[0];
  const asset = { id: 'image-one', mimeType: 'image/png', width: 720, height: 1280, sizeBytes: 100, sha256: 'a'.repeat(64) };
  const linked = { ...shot, referenceAssetIds: [asset.id] };
  assert.match(generationInputIssue(linked, provider, model, [], 'image'), /参考素材已不存在/);
  const fullSelection = { ...linked, referenceAssetIds: [asset.id, asset.id] };
  assert.equal(generationInputIssue(fullSelection, provider, model, [asset], 'image'), getGenerationIssue({ ...fullSelection, model, referenceAssets: [asset, asset] }, provider).message);
  assert.match(generationInputIssue(fullSelection, provider, model, [asset], 'image'), /张参考图片/);
  assert.match(generationInputIssue(shot, provider, model, [asset], 'image'), /选择一张首帧参考图/);
  const missingBytes = { ...asset }; delete missingBytes.sizeBytes;
  assert.equal(generationInputIssue(linked, provider, model, [missingBytes], 'image'), generationIssueMessage(getGenerationIssue({ ...linked, model, referenceAssets: [missingBytes] }, provider)));
  assert.match(generationInputIssue(linked, provider, model, [missingBytes], 'image'), /元数据不可用/);
  for (const role of ['last_frame', 'subject_reference', 'style_reference', 'motion_reference']) {
    const explicit = { ...asset, role };
    assert.equal(generationInputIssue(linked, provider, model, [explicit], 'image'), generationIssueMessage(getGenerationIssue({ ...linked, model, referenceAssets: [explicit] }, provider)));
    assert.match(generationInputIssue(linked, provider, model, [explicit], 'image'), role === 'last_frame' ? /首尾帧必须包含完整.*角色绑定/ : role === 'subject_reference' ? /必须冻结一个完整且有效的主体版本/ : /Mioon 当前适配器未接入此参考角色/);
  }
  const planning = { ...shot, subjectBindings: [{ role: 'subject_reference', assetId: asset.id }, { role: 'style_reference', assetId: asset.id }] };
  const original = structuredClone(planning);
  assert.equal(generationInputIssue(planning, provider, model, [asset], 'text'), '');
  assert.equal(generationSelection([provider], { model }, planning).inputMode, 'text');
  assert.deepEqual(planning, original);
});

test('new profile diagnostics are localized only in the renderer and preserve existing messages', () => {
  const rich = { code: 'REFERENCE_TOO_LARGE', message: 'Reference exceeds the current Mioon input byte limit.' };
  assert.match(generationIssueMessage(rich), /文件大小限制/);
  assert.equal(rich.message, 'Reference exceeds the current Mioon input byte limit.');
  for (const issue of [{ code: 'UNSUPPORTED_INPUT', message: '此模型不支持参考图输入' }, { code: 'REFERENCE_METADATA_UNAVAILABLE', message: '参考素材元数据缺失或与完整选择不一致，无法提交' }, { code: 'UNRECOGNIZED_FUTURE_CODE', message: 'Preserve a future diagnostic.' }]) assert.equal(generationIssueMessage(issue), issue.message);
});

test('wired ProviderSettings renders accessible compact summaries and all role details from actual server profiles', () => {
  const providers = GENERATION_INPUT_PROFILES.map(profile => fixture(profile.providerId));
  const blocked = fixture('veo', '2026-10-22');
  const fixtureSource = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ProviderSettings from './ProviderSettings.jsx';
    import GenerationInputSummary, { GenerationInputDetails } from './GenerationInputSummary.jsx';
    import { generationProfileSelection, generationSelection } from './generation-settings.js';
    import { WorkspaceVisibilityProvider } from './workspace-visibility.jsx';
    const providers = ${JSON.stringify(providers)};
    const blocked = ${JSON.stringify(blocked)};
    export const markup = Object.fromEntries(providers.map(provider => {
      const model = provider.models[0];
      const { capabilities } = generationSelection([provider], { model }, ${JSON.stringify(shot)});
      return [provider.id, {
        summary: renderToStaticMarkup(<ProviderSettings providers={providers} provider={provider} model={model} capabilities={capabilities} onChange={() => { throw Error('No side effects permitted'); }} />),
        details: renderToStaticMarkup(<GenerationInputDetails selection={generationProfileSelection(provider, model)} />),
      }];
    }));
    markup.blocked = renderToStaticMarkup(<GenerationInputSummary provider={blocked} model={blocked.models[0]} />);
    markup.unknown = renderToStaticMarkup(<GenerationInputSummary provider={providers[0]} model="stale-selected-model" />);
    markup.missing = renderToStaticMarkup(<GenerationInputSummary provider={{ ...providers[0], inputProfiles: [] }} model={providers[0].models[0]} />);
    markup.loading = renderToStaticMarkup(<GenerationInputSummary />);
    markup.hidden = renderToStaticMarkup(<WorkspaceVisibilityProvider visible={false}><GenerationInputSummary provider={providers[0]} model={providers[0].models[0]} /></WorkspaceVisibilityProvider>);
  `;
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(fixtureSource)}, loader: 'jsx', resolveDir: ${JSON.stringify(resolve(root, 'apps/web/src'))} }, bundle: true, format: 'esm', platform: 'browser', write: false, loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '\"production\"' }, logLevel: 'silent' });
    const { markup } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(markup)); process.exit(0);
  `;
  const markup = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }));
  for (const provider of providers) {
    const { summary, details } = markup[provider.id], profile = provider.inputProfiles[0];
    assert.match(summary, /aria-label="Mioon 模型输入限制"/);
    assert.match(summary, /data-profile-state="ready"/);
    assert.match(summary, /aria-expanded="false"/);
    assert.ok(summary.includes(profile.model)); assert.ok(summary.includes(profile.apiFamily)); assert.ok(summary.includes(provider.providerRegion));
    assert.doesNotMatch(summary, /generation-role-subject_reference|各参考角色的数量与限制/);
    assert.match(details, /不代表服务商全部能力/);
    for (const role of ['first_frame', 'last_frame', 'subject_reference', 'style_reference', 'motion_reference']) assert.ok(details.includes(`data-testid="generation-role-${role}"`));
    assert.equal((details.match(/尚无对应的生成输入映射/g) || []).length, profile.inputs.roles.subject_reference.implemented ? 2 : profile.inputs.roles.last_frame.implemented ? 3 : 4);
    if (profile.inputs.roles.last_frame.implemented) { assert.match(details, /一张首帧加一张尾帧/); assert.match(summary, /尾帧 0–1 张/); }
    assert.match(details, /主体与风格的策划关联不会自动作为生成输入/);
    assert.doesNotMatch(details, /主体库与风格关联仅用于本地策划|尚不作为生成输入/);
    assert.match(details, /首帧仍由现有参考图选择或首帧连接提供/);
    assert.ok(details.includes(profile.inputs.roles.first_frame.maxBytes.toLocaleString('en-US')));
    assert.match(details, /2026-10-10/);
  }
  assert.match(markup.mock.summary, /输出为测试图案，不会呈现参考图片或提示词描述的内容/);
  assert.match(markup.runway.details, /编码后 data URI.*5 MiB/);
  assert.match(markup.ark.details, /宽高均至少 300px；宽高均不超过 6000px；须与镜头画幅比例一致/);
  assert.match(markup.veo.summary, /2026-10-22.*2026-10-10/);
  assert.match(markup.blocked, /已阻止新提交/);
  assert.match(markup.blocked, /不会自动替换模型/);
  assert.match(markup.unknown, /stale-selected-model/);
  assert.match(markup.unknown, /data-profile-state="unknown_model"/);
  assert.match(markup.missing, /data-profile-state="missing_profile"/);
  assert.doesNotMatch(markup.missing + markup.unknown + markup.loading, /Mioon 首帧 0–1|Mioon 首帧 1/);
  assert.match(markup.loading, /未加载或不可用/);
  assert.match(markup.hidden, /disabled=""/);
  assert.match(markup.hidden, /aria-expanded="false"/);
});

// Focused callback/effect checks; these are not a browser-layout claim.
function disclosureHarness() {
  const source = readFileSync(resolve(root, 'apps/web/src/GenerationInputSummary.jsx'), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  const slots = []; let cursor = 0, layouts = [], tree;
  const equal = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const h = { visible: true };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const i = cursor++; slots[i] ||= { value: initial }; return [slots[i].value, value => { slots[i].value = value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(factory, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: factory(), deps }; return slots[i].value; },
    useLayoutEffect(callback, deps) { const i = cursor++, old = slots[i]; if (old && equal(old.deps, deps)) return; slots[i] = { callback, deps, cleanup: old?.cleanup }; layouts.push(i); },
  }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, name => {
    const i18nDependency = creationTestDependency(name); if (i18nDependency) return i18nDependency;
    if (name === 'react') return react;
    if (name === './generation-settings.js') return { generationProfileSelection, generationIssueDescriptor };
    if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => h.visible };
    if (name.endsWith('.css')) return {};
    if (name === './icons.jsx') return { default: 'Icon', __esModule: true };
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, { get: (_, key) => String(key) });
    throw Error(`Unexpected dependency: ${name}`);
  });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  h.render = props => { cursor = 0; layouts = []; tree = module.exports.default(props); for (const i of layouts) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } return tree; };
  h.find = type => nodes(tree).find(node => node.type === type);
  h.unmount = () => slots.forEach(slot => slot.cleanup?.());
  return h;
}

test('input disclosure closes on model/provider changes and ignores stale or hidden callbacks without changing drafts', () => {
  const h = disclosureHarness(), provider = fixture(), props = { provider, model: provider.models[0] };
  h.render(props); const old = h.find('Collapsible').props.onOpenChange;
  old(true); h.render(props); assert.equal(h.find('Collapsible').props.open, true);
  h.visible = false; h.render(props); assert.equal(h.find('Collapsible').props.open, false); assert.equal(h.find('CollapsibleTrigger').props.disabled, true);
  old(true); h.visible = true; h.render(props); assert.equal(h.find('Collapsible').props.open, false);
  old(true); h.render(props); assert.equal(h.find('Collapsible').props.open, false);
  h.find('Collapsible').props.onOpenChange(true); h.render(props); assert.equal(h.find('Collapsible').props.open, true);
  const previousModel = h.find('Collapsible').props.onOpenChange;
  h.render({ ...props, model: 'removed-model' }); assert.equal(h.find('Collapsible').props.open, false);
  previousModel(true); h.render({ ...props, model: 'removed-model' }); assert.equal(h.find('Collapsible').props.open, false);
  const replacement = fixture('ark'); h.render({ provider: replacement, model: replacement.models[0] }); assert.equal(h.find('Collapsible').props.open, false);
  const unmounted = h.find('Collapsible').props.onOpenChange; h.unmount(); unmounted(true);
  h.render({ provider: replacement, model: replacement.models[0] }); assert.equal(h.find('Collapsible').props.open, false);
  assert.deepEqual(provider, fixture());
});

test('input disclosure stays expanded across equivalent polling DTOs and unrelated runtime refreshes', () => {
  const h = disclosureHarness(), provider = fixture('minimax'), model = provider.models[0];
  h.render({ provider, model });
  h.find('Collapsible').props.onOpenChange(true);
  h.render({ provider, model }); assert.equal(h.find('Collapsible').props.open, true);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  for (const refreshed of [structuredClone(provider), reorder(provider), { ...structuredClone(provider), configuration: { requirements: ['Updated server-only instructions'] }, budget: { remaining: 2 } }]) {
    assert.notEqual(refreshed, provider);
    h.render({ provider: refreshed, model });
    assert.equal(h.find('Collapsible').props.open, true, 'Routine provider refresh must not interrupt reading or scrolling input limits');
  }
  h.find('Collapsible').props.onOpenChange(false);
  h.render({ provider: structuredClone(provider), model }); assert.equal(h.find('Collapsible').props.open, false);
});

test('input disclosure closes on meaningful route, role-limit, profile-version and server-evaluation changes', () => {
  for (const change of [
    provider => { provider.region = 'cn'; provider.providerRegion = 'cn'; },
    provider => { provider.inputProfiles[0].inputs.roles.first_frame.maxBytes -= 1; },
    provider => { provider.inputProfileVersion = 'future-profile-version'; },
    provider => { provider.profileEvaluationDate = '2026-10-11'; provider.inputProfileEvaluations[0].evaluatedAsOf = '2026-10-11'; },
  ]) {
    const h = disclosureHarness(), provider = fixture('minimax'), model = provider.models[0];
    h.render({ provider, model });
    const previousSelection = h.find('Collapsible').props.onOpenChange;
    previousSelection(true); h.render({ provider, model }); assert.equal(h.find('Collapsible').props.open, true);
    const changed = structuredClone(provider); change(changed);
    h.render({ provider: changed, model }); assert.equal(h.find('Collapsible').props.open, false);
    previousSelection(true);
    h.render({ provider: structuredClone(changed), model }); assert.equal(h.find('Collapsible').props.open, false, 'Callbacks from the previous semantic selection stay obsolete');
  }
});
