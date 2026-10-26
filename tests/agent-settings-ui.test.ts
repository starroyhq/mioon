import type {Failure} from './helpers/strict-agent-workspace-types.ts';
import type {SettingsInput} from './helpers/strict-agent-ui-types.ts';
import type {FetchCapture,CallCapture} from './helpers/strict-agent-ui-types.ts';
import type {ElementType, ElementProps, Tree, Element, Hook, Module} from './helpers/strict-agent-ui-types.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import { createI18nTestContext as localeDisplay } from './helpers/i18n.ts';
const localizedSource = (source: string|string[]) => source + JSON.stringify(Object.entries(i18n.catalogs).filter(([key]) => source.includes(key)).map(([, entry]) => entry['zh-Hans']));
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as logic from '../apps/web/src/agent-settings.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';

const { agentBindingChanged, agentSettingsCanSave, agentSettingsIssue, createAgentSettingsClient, createAgentSettingsSession, safeAgentSettings } = logic;
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://api.example.com/v1', model: 'example-model', protocol: 'chat_completions' as const };
const presets = [
  { id: 'openai', label: 'OpenAI', description: 'Example only', platforms: [{ id: 'global', label: '全球', baseUrl: configuration.baseUrl, model: configuration.model, notes: '仅示例', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], supportedModelHints: { responses: ['gpt-4.1-mini'] }, sources: [{ label: '官方文档', url: 'https://example.com/docs' }] }, { id: 'other', label: '其他地区', baseUrl: 'https://other.example.com/v1', model: 'other-model', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], sources: [] }] },
  { id: 'custom', label: '自定义', description: '', platforms: [{ id: 'custom', label: '自定义 HTTPS', baseUrl: '', model: '', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], sources: [] }] },
  { id: 'ollama', label: 'Ollama', description: '', platforms: [{ id: 'local', label: '本地', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], sources: [] }] },
];
const snapshot = <Patch extends object = {}>(patch: Patch = {} as Patch) => ({ revision: 0, configuration: { ...configuration }, secret: { configured: false, storage: 'none' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets, scope: 'settings_only', verification: 'not_tested', ...patch });
const deferred = () => { let resolve!: (value?: unknown)=>void, reject!: (reason?: unknown)=>void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const codeError = (code: string) => Object.assign(new Error('do-not-reflect-this-dummy-secret'), { code });
function fixture({ initial = snapshot(), write, read }: {initial?: unknown;read?: ()=>unknown;write?: (input: {expectedRevision: number;configuration: unknown;secret: {action: string;storage: unknown}})=>unknown} = {}) {
  const calls: SettingsInput[] = [], emitted: logic.AgentSettingsState[] = [];
  const client = { read: read || (async () => initial), write: (input: SettingsInput) => {
    calls.push(structuredClone(input));
    return write ? write(input) : Promise.resolve(snapshot({ revision: input.expectedRevision + 1, configuration: input.configuration,
      secret: input.secret.action === 'replace' ? { configured: true, storage: input.secret.storage } : input.secret.action === 'remove' ? { configured: false, storage: 'none' } : (initial as ReturnType<typeof snapshot>).secret }));
  } };
  const session = (createAgentSettingsSession as (input_: Omit<NonNullable<Parameters<typeof createAgentSettingsSession>[0]>,'client'>&{client?: typeof client})=>ReturnType<typeof createAgentSettingsSession>)({ client, onChange: state => emitted.push(structuredClone(state)) });
  return { session, client, calls, emitted };
}

test('safe snapshot allowlists settings and strips secrets, server internals and unsafe source URLs', () => {
  const input = snapshot({ secret: { configured: false, storage: 'none', value: 'dummy-secret' }, extra: 'dummy-secret', presets: [{ ...presets[0], private: 'dummy-secret', platforms: [{ ...presets[0].platforms[0], secret: 'dummy-secret', sources: [{ url: 'javascript:alert(1)' }, { url: 'https://user:dummy-secret@example.com/' }, { label: 'Official', url: 'https://example.com/docs', private: 'dummy-secret' }] }] }] });
  const safe = safeAgentSettings(input);
  assert.doesNotMatch(JSON.stringify(safe), /dummy-secret|javascript|private|extra/);
  assert.deepEqual(safe.presets[0].platforms[0].sources, [{ label: 'Official', url: 'https://example.com/docs' }]);
  for (const patch of [{ revision: -1 }, { revision: '1' }, { configuration: null }, { secret: { configured: true, storage: 'none' } }, { storage: { persistentAvailable: true, sessionScope: 'browser', reasonCode: null } }, { scope: 'chat' }, { verification: 'connected' }, { presets: [] }] as const) assert.throws(() => safeAgentSettings(snapshot(patch)), /did not complete/);
});

test('binding includes preset/platform/normalized base but excludes the model', () => {
  assert.equal(agentBindingChanged(configuration, { ...configuration, model: 'new' }), false);
  assert.equal(agentBindingChanged(configuration, { ...configuration, baseUrl: ' HTTPS://API.EXAMPLE.COM/v1/ ' }), false);
  for (const patch of [{ presetId: 'custom' }, { platformId: 'other' }, { baseUrl: 'https://api.example.com/other' }] as const) assert.equal(agentBindingChanged(configuration, { ...configuration, ...patch }), true);
});

test('local validation admits editable model and Ollama but rejects missing values, URL credentials and invalid key input', () => {
  assert.equal(agentSettingsIssue({ ...configuration, model: 'custom-model-name' }), '');
  assert.equal(agentSettingsIssue({ ...configuration, presetId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }), '');
  for (const patch of [{ model: '' }, { baseUrl: '' }, { model: 'x'.repeat(201) }, { baseUrl: 'http://api.example.com/v1' }, { baseUrl: 'https://name:password@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { baseUrl: 'https://example.com#key' }, { baseUrl: 'not-a-url' }] as const) assert.notEqual(agentSettingsIssue({ ...configuration, ...patch }), '');
  for (const key of [' ', 'dummy\nsecret', 'x'.repeat(8193), '密'.repeat(2731)] as const) assert.notEqual(agentSettingsIssue(configuration, key), '');
});

test('client uses only authenticated local GET/PUT, no cache, and safe serialized request body', async () => {
  const requests: FetchCapture[] = [];
  const client = createAgentSettingsClient({ fetchImpl: async (url, options) => { requests.push(({ url, ...options }!)); return ({ ok: true, json: async () => ({ ok: true, data: snapshot() }) } as unknown as Response); } });
  await client.read();
  const body = { expectedRevision: 0, configuration, secret: { action: 'replace', value: 'dummy-only', storage: 'session' } };
  await client.write(body);
  assert.deepEqual(requests.map(item => [item.url, item.method, item.credentials, item.cache]), [['/api/agent/settings', 'GET', 'same-origin', 'no-store'], ['/api/agent/settings', 'PUT', 'same-origin', 'no-store']]);
  assert.equal(requests[0].body, undefined); assert.deepEqual(JSON.parse(requests[1].body! as string), body);
});

test('client never reflects raw error message, details, unexpected error codes or thrown credential text', async () => {
  for (const response of [{ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'AGENT_SETTINGS_VALIDATION', message: 'dummy-key', details: { value: 'dummy-key' } } }) }, { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'dummy-key', message: 'dummy-key' } }) }] as const) {
    const client = createAgentSettingsClient({ fetchImpl: async () => (response as unknown as Response) });
    await assert.rejects(client.read(), error => { assert.doesNotMatch(JSON.stringify(error) + (error as Failure).message, /dummy-key/); return true; });
  }
  await assert.rejects(createAgentSettingsClient({ fetchImpl: () => { throw Error('dummy-key'); } }).write({}), error => (error as Failure).code === 'NETWORK' && !(error as Failure).message.includes('dummy-key'));
});

test('client timeout aborts once, makes no retry and ignores late transport results', async () => {
  const held = deferred(); let signal, requests = 0;
  const client = createAgentSettingsClient({ timeoutMs: 5, fetchImpl: (_, options) => { signal = options!.signal; requests++; return (held.promise as unknown as Promise<Response>); } });
  await assert.rejects(client.write({}), error => (error as Failure).code === 'NETWORK');
  assert.equal(signal!.aborted, true); assert.equal(requests, 1);
  held.resolve!({ ok: true, json: async () => ({ ok: true, data: snapshot() }) }); await flush(); assert.equal(requests, 1);
});

test('saving no key stores nonsecret configuration without pretending to configure a secret', async () => {
  const f = fixture(); await f.session.load(); f.session.edit({ model: 'new-model' });
  assert.equal(await f.session.save(), true); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].secret, { action: 'keep' });
  assert.equal(f.session.getState().snapshot!.secret.configured, false);
  assert.match(f.session.getState().message, /未保存 API 密钥/);
});

test('replace uses explicitly selected storage while no emitted snapshot retains the dummy secret', async () => {
  const f = fixture({ initial: snapshot({ storage: { persistentAvailable: true, sessionScope: 'app', reasonCode: null } }) }); await f.session.load();
  assert.equal(f.session.setStorage('persistent'), true); assert.equal(await f.session.save('dummy-write-only'), true);
  assert.deepEqual(f.calls[0].secret, { action: 'replace', value: 'dummy-write-only', storage: 'persistent' });
  assert.doesNotMatch(JSON.stringify(f.emitted), /dummy-write-only/);
  assert.equal(f.session.getState().snapshot!.secret.storage, 'persistent');
});

test('unavailable persistence cannot be selected and storage-only change does not silently migrate a key', async () => {
  const f = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }) }); await f.session.load();
  assert.equal(f.session.setStorage('persistent'), false); assert.equal(f.session.getState().storage, 'session');
  const g = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: true, sessionScope: 'app', reasonCode: null } }) }); await g.session.load();
  g.session.setStorage('persistent'); g.session.edit({ model: 'new' }); await g.session.save();
  assert.deepEqual(g.calls[0].secret, { action: 'keep' });
});

test('changing destination removes old key unless a new key is explicitly supplied; model-only change retains it', async () => {
  for (const patch of [{ baseUrl: 'https://other.example.com/v1' }, { platformId: 'other' }, { presetId: 'custom' }] as const) {
    const f = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }) }); await f.session.load(); f.session.edit(patch); await f.session.save();
    assert.deepEqual(f.calls[0].secret, { action: 'remove' }); assert.equal(f.session.getState().snapshot!.secret.configured, false);
  }
  const g = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }) }); await g.session.load(); g.session.edit({ model: 'new' }); await g.session.save(); assert.equal(g.calls[0].secret.action, 'keep');
  g.session.edit({ baseUrl: 'https://other.example.com/v1' }); await g.session.save('new-dummy'); assert.equal(g.calls[1].secret.action, 'replace');
});

test('preset/platform switch fills only current defaults and custom endpoint/model remain editable', async () => {
  const f = fixture(); await f.session.load(); f.session.selectPlatform('other');
  assert.deepEqual(f.session.getState().draft, { ...configuration, platformId: 'other', baseUrl: 'https://other.example.com/v1', model: 'other-model' });
  f.session.selectPreset('custom'); assert.equal(f.session.getState().draft!.baseUrl, ''); assert.equal(f.session.getState().draft!.model, '');
  f.session.edit({ baseUrl: 'https://custom.example.com/v1', model: 'anything' }); assert.equal(await f.session.save(), true);
  assert.equal(f.session.selectPlatform('unknown'), false); assert.equal(f.session.selectPreset('unknown'), false);
});

test('remove can be undone before save and confirmed status changes only after acknowledgement', async () => {
  const held = deferred(), f = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }), write: () => held.promise }); await f.session.load();
  f.session.removeKey(); assert.equal(f.session.getState().snapshot!.secret.configured, true);
  f.session.removeKey(false); assert.equal(f.session.getState().secretAction, 'keep');
  f.session.removeKey(); const saving = f.session.save(); assert.deepEqual(f.calls[0].secret, { action: 'remove' }); assert.equal(f.session.getState().snapshot!.secret.configured, true);
  held.resolve!(snapshot({ revision: 1 })); await saving; assert.equal(f.session.getState().snapshot!.secret.configured, false);
});

test('double save, editing and selector changes are rejected while the real first write is outstanding', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }); await f.session.load(); f.session.edit({ model: 'new' });
  const first = f.session.save('dummy-only'); assert.equal(f.session.getState().phase, 'saving');
  assert.equal(await f.session.save('second'), false); assert.equal(f.session.edit({ model: 'later' }), false); assert.equal(f.session.selectPreset('custom'), false); assert.equal(f.session.removeKey(), false); assert.equal(f.session.setStorage('session'), false);
  assert.equal(f.calls.length, 1); held.resolve!(snapshot({ revision: 1, configuration: { ...configuration, model: 'new' }, secret: { configured: true, storage: 'session' } })); assert.equal(await first, true);
});

test('CAS conflict reads current state once, preserves draft and blocks blind overwrite until explicit review', async () => {
  let reads = 0; const latest = snapshot({ revision: 2, configuration: { ...configuration, model: 'other-window' }, secret: { configured: true, storage: 'session' } });
  const f = fixture({ read: async () => ++reads === 1 ? snapshot() : latest, write: () => Promise.reject(codeError('AGENT_SETTINGS_CONFLICT')) });
  await f.session.load(); f.session.edit({ model: 'my-draft' }); await f.session.save('dummy-secret');
  assert.equal(reads, 2); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().snapshot!.revision, 2); assert.equal(f.session.getState().draft!.model, 'my-draft'); assert.equal(f.session.getState().recovery, 'conflict'); assert.equal(agentSettingsCanSave(f.session.getState()), false);
  assert.equal(await f.session.save('must-not-send'), false); assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.emitted), /dummy-secret/);
  f.session.acknowledge(); assert.equal(agentSettingsCanSave(f.session.getState()), true); await f.session.save(); assert.equal(f.calls[1].expectedRevision, 2); assert.deepEqual(f.calls[1].secret, { action: 'keep' });
});

test('unknown save result rereads but never infers success or retries even when returned settings match', async () => {
  let reads = 0;
  const saved = snapshot({ revision: 1, configuration: { ...configuration, model: 'new' }, secret: { configured: true, storage: 'session' } });
  const f = fixture({ read: async () => ++reads === 1 ? snapshot() : saved, write: () => Promise.reject(codeError('NETWORK')) }); await f.session.load(); f.session.edit({ model: 'new' }); await f.session.save('dummy-only');
  assert.equal(reads, 2); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().recovery, 'unknown'); assert.match(f.session.getState().message, /未收到保存确认/); assert.doesNotMatch(f.session.getState().message, /设置已保存/);
  f.session.useLatest(); assert.equal(f.session.getState().recovery, null); assert.deepEqual(f.session.getState().draft, saved.configuration);
});

test('wrong successful secret acknowledgement is reconciled without claiming success or retrying', async () => {
  for (const action of ['replace', 'remove', 'keep'] as const) {
    let reads = 0;
    const initial = snapshot({ secret: { configured: action !== 'replace', storage: action !== 'replace' ? 'session' : 'none' } });
    const wrong = snapshot({ revision: 1, secret: action === 'replace' ? { configured: false, storage: 'none' } : action === 'remove' ? { configured: true, storage: 'session' } : { configured: true, storage: 'persistent' } });
    const f = fixture({ initial, read: async () => { reads++; return initial; }, write: async () => wrong }); await f.session.load();
    if (action === 'remove') f.session.removeKey();
    assert.equal(await f.session.save(action === 'replace' ? 'dummy-only' : ''), false);
    assert.equal(f.session.getState().phase, 'review', action); assert.equal(f.calls.length, 1); assert.equal(reads, 2);
    assert.doesNotMatch(f.session.getState().message, /设置已保存/);
  }
});

test('failed reconciliation keeps save blocked; retry performs only GET, then requires explicit review', async () => {
  let reads = 0; const f = fixture({ read: async () => { reads++; if (reads === 2) throw codeError('NETWORK'); return snapshot({ revision: reads > 2 ? 1 : 0 }); }, write: () => Promise.reject(codeError('NETWORK')) });
  await f.session.load(); f.session.edit({ model: 'retained' }); await f.session.save(); assert.equal(f.session.getState().phase, 'blocked'); assert.equal(f.session.acknowledge(), false); assert.equal(f.session.useLatest(), false); assert.equal(await f.session.save(), false);
  await f.session.reload(); assert.equal(reads, 3); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().draft!.model, 'retained'); assert.equal(f.session.getState().phase, 'review'); assert.equal(agentSettingsCanSave(f.session.getState()), false);
});

test('definitive validation/authentication failure never echoes errors or automatically resubmits', async () => {
  for (const code of ['UNAUTHORIZED', 'AGENT_SETTINGS_VALIDATION'] as const) {
    let reads = 0; const f = fixture({ read: async () => { reads++; return snapshot(); }, write: () => Promise.reject(codeError(code)) }); await f.session.load(); await f.session.save('dummy-secret');
    assert.equal(reads, 1); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().phase, 'error'); assert.doesNotMatch(JSON.stringify(f.emitted), /dummy-secret/);
  }
});

test('late initial read, late save and late reconciliation cannot publish or write after dispose', async () => {
  for (const stage of ['read', 'write', 'reconcile'] as const) {
    const held = deferred(); let reads = 0;
    const f = fixture({ read: () => { reads++; return stage === 'read' || stage === 'reconcile' && reads > 1 ? held.promise : Promise.resolve(snapshot()); }, write: () => stage === 'write' ? held.promise : Promise.reject(codeError('NETWORK')) });
    const loading = f.session.load(); if (stage !== 'read') await loading;
    const saving = stage === 'read' ? loading : f.session.save('dummy-only'); await flush();
    const count = f.emitted.length; f.session.dispose(); held.resolve!(snapshot({ revision: stage === 'read' ? 0 : 1 })); await saving; await flush();
    assert.equal(f.emitted.length, count, stage); assert.equal(await f.session.save('must-not-send'), false); assert.equal(f.session.edit({ model: 'stale' }), false); assert.equal(f.session.getState().snapshot, null);
  }
});

const source = readFileSync(new URL('../apps/web/src/AgentSettings.tsx', import.meta.url), 'utf8');
const transformed = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const element = (type: ElementType, props: Partial<ElementProps>|null = {}, ...children: Tree[]) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const nodes = (tree: Tree): Element[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const depsEqual = (a: readonly unknown[]|undefined, b: readonly unknown[]|undefined) => a?.length === b?.length && a!.every((value: unknown, i) => Object.is(value, b![i]));
function uiHarness(client: ReturnType<typeof fixture>['client']) {
  const slots: Hook[] = [], dom = new Map(); let cursor = 0, effects: number[] = [], tree: Tree, closes = 0, visible = true, locale: import('../packages/i18n/src/types.ts').Locale = 'zh-Hans';
  const react = { createElement: element,
    useState(initial: unknown) { const i = cursor++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (next: (arg0: unknown) => unknown) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useMemo(callback: () => unknown, deps: readonly unknown[]) { const i = cursor++; if (!slots[i] || !depsEqual(deps, slots[i].deps)) slots[i] = { value: callback(), deps }; return slots[i].value; },
    useRef(initial: unknown) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useLayoutEffect(callback: ()=>void|(()=>void), deps: readonly unknown[]) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { callback, deps, cleanup: old?.cleanup }; effects.push(i); },
  }; (react as typeof react & {default?: unknown}).default = react;
  const module: Module = { exports: {} } as Module, primitive = new Proxy({}, { get: (_, key) => String(key) });
  Function('module', 'exports', 'require', transformed)(module, module.exports, (id?: string|undefined) => {
    if (id === './i18n/I18nProvider.tsx') return { useI18n: () => localeDisplay(locale) };
    if (id === '../../../packages/i18n/src/index.ts') return i18n;
    if (id === 'react') return react;
    if (id === './settings-navigation-state.ts') return navigation;
    if (id === './AgentTaskPolicy.tsx') return {__esModule:true,default:'AgentTaskPolicy'};
    if (id === './AgentAuthorizations.tsx') return {__esModule:true,default:'AgentAuthorizations'};
    if (id === './agent-settings.ts') return { ...logic, createAgentSettingsSession: (options?: logic.AgentSettingsSessionOptions|undefined) => (logic.createAgentSettingsSession as (input_: Omit<NonNullable<Parameters<typeof logic.createAgentSettingsSession>[0]>,'client'>&{client?: typeof client})=>ReturnType<typeof logic.createAgentSettingsSession>)({ ...options, client }) };
    if (id === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    if (id === './icons.tsx') return { default: 'Icon' };
    if (id!.startsWith('@mioon/ui/') || id === './WorkspaceControls.tsx') return primitive;
    throw Error(id);
  });
  const h = {
    render() { cursor = 0; effects = []; tree = module.exports.default!({ onClose: () => { closes++; } }); for (const node of nodes(tree)) if ((node.props.ref as {current?: unknown}|undefined)) { const id = node.props.id; if (!dom.has(id)) dom.set(id, { value: '' }); (node.props.ref as {current?: unknown}|undefined)!.current = dom.get(id); } for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback!(); } return tree; },
    find(id: string) { return nodes(tree).find((node) => node.props['data-testid'] === id); },
    form() { return nodes(tree).find((node) => node.type === 'form'); },
    key(value: string) { const input = h.find('agent-settings-key'); input!.props.ref.current.value = value; input!.props.onChange({ target: { value } }); h.render(); },
    change(id: string, value: string) { h.find(id)!.props.onChange({ target: { value } }); h.render(); },
    setVisible(value: boolean) { visible = value; h.render(); },
    setLocale(value: import('../packages/i18n/src/types.ts').Locale) { locale = value; return h.render(); },
    get closes() { return closes; },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return h;
}

test('actual UI callback clears masked DOM key synchronously before request acknowledgement and never refills it', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }), h = uiHarness(f.client);
  h.render(); await flush(); h.render();
  const input = h.find('agent-settings-key'); assert.equal(input!.props.type, 'password'); assert.equal(input!.props.value, undefined); assert.equal(input!.props.defaultValue, undefined); assert.equal(input!.props.autoComplete, 'new-password');
  h.key('dummy-entered'); h.form()!.props.onSubmit({ preventDefault() {} }); assert.equal(input!.props.ref.current.value, ''); assert.equal(f.calls.length, 1);
  h.render(); assert.equal(h.find('agent-settings-page')!.props['data-phase'], 'saving'); assert.equal(h.find('agent-settings-save')!.props.disabled, true);
  held.resolve!(snapshot({ revision: 1, secret: { configured: true, storage: 'session' } })); await flush(); h.render();
  assert.equal(h.find('agent-settings-key')!.props.ref.current.value, ''); assert.match(h.find('agent-settings-key')!.props.placeholder, /留空保留/); h.unmount();
});

test('actual UI clears entered keys on endpoint/platform/preset edits, reset and dismiss', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render();
  for (const [id, value] of [['agent-settings-base-url', 'https://edited.example.com/v1'], ['agent-settings-platform', 'other'], ['agent-settings-preset', 'custom']] as const) {
    h.key('dummy-entered'); h.change(id, value); assert.equal(h.find('agent-settings-key')!.props.ref.current.value, '', id);
  }
  h.change('agent-settings-base-url', 'https://edited.example.com/v1'); h.key('dummy-entered'); h.find('agent-settings-reset')!.props.onClick(); h.render(); assert.equal(h.find('agent-settings-key')!.props.ref.current.value, '');
  h.key('dummy-entered'); const oldSubmit = h.form()!.props.onSubmit, input = h.find('agent-settings-key'); h.find('agent-settings-back')!.props.onClick(); assert.equal(input!.props.ref.current.value, ''); assert.equal(h.closes, 1);
  oldSubmit({ preventDefault() {} }); assert.equal(f.calls.length, 0); h.find('agent-settings-cancel')!.props.onClick(); assert.equal(h.closes, 1); h.unmount();
});

test('actual UI leaves the settings page during a pending save and old callbacks remain inert', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.key('dummy-only');
  const oldSubmit = h.form()!.props.onSubmit; oldSubmit({ preventDefault() {} }); h.render(); const oldDialog = h.find('agent-settings-page'); h.find('agent-settings-cancel')!.props.onClick();
  assert.equal(h.closes, 1); held.resolve!(snapshot({ revision: 1, secret: { configured: true, storage: 'session' } })); await flush(); oldSubmit({ preventDefault() {} });
  assert.equal(f.calls.length, 1); assert.equal(h.closes, 1); assert.equal(oldDialog!.props['data-phase'], 'saving'); h.unmount();
});

test('settings integration stays in the shared dock, uses local controls and has no modal or provider probe', () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<AgentWorkspace/); assert.match(app, /data-testid="agent-settings-open"/);
  assert.match(source, /from '\.\/WorkspaceControls\.tsx'/); assert.doesNotMatch(source, /DialogContent|<Dialog/);
  assert.match(localizedSource(source), /Mio 通过这里的模型理解你的要求并决定下一步/);
  assert.doesNotMatch(source, /尚无工具执行/); assert.match(localizedSource(source), /尚未验证连接/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|rpc\(|fetch\(|测试连接|立即连接|type="text"[^\n]*agent-settings-key/);
  assert.doesNotMatch(app, /showAgentSettings|showAgentChat/);
  assert.match(source, /useWorkspaceVisibility/);
});

test('protocol is required and strict in settings DTOs and catalog choices; missing legacy UI fields fail closed', async () => {
  for (const protocol of [undefined, null, '', 'Responses', 'auto', '__proto__', 1, {}] as const) {
    assert.throws(() => safeAgentSettings(snapshot({ configuration: { ...configuration, protocol } })), value => (value as Failure).code === 'INVALID_RESPONSE');
    assert.notEqual(agentSettingsIssue({ ...configuration, protocol } as unknown as Parameters<typeof agentSettingsIssue>[0]), '');
    const f = fixture({ initial: snapshot({ configuration: { ...configuration, protocol } }) });
    assert.equal(await f.session.load(), false); assert.equal(await f.session.save(), false); assert.equal(f.calls.length, 0); f.session.dispose();
  }
  for (const patch of [{ defaultProtocol: undefined }, { availableProtocols: [] }, { availableProtocols: ['auto'] }, { availableProtocols: ['responses'], defaultProtocol: 'chat_completions' }, { availableProtocols: ['responses', 'responses'] }, { supportedModelHints: { responses: [1] } }] as const) {
    assert.throws(() => safeAgentSettings(snapshot({ presets: [{ ...presets[0], platforms: [{ ...presets[0].platforms[0], ...patch }] }] })));
  }
});

test('protocol-only edit is dirty, increments revision and keeps same authenticated key without changing model', async () => {
  const f = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }) }); await f.session.load();
  f.session.edit({ protocol: 'responses' as const });
  assert.equal(logic.agentSettingsDirty(f.session.getState()), true);
  assert.equal(logic.agentConfigurationEqual(configuration, f.session.getState().draft), false);
  assert.equal(agentBindingChanged(configuration, f.session.getState().draft), false);
  assert.equal(f.session.getState().draft!.model, configuration.model);
  assert.equal(await f.session.save(), true); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].secret, { action: 'keep' }); assert.equal(f.calls[0].configuration.protocol, 'responses'); assert.equal(f.session.getState().snapshot!.revision, 1);
  const g = fixture({ initial: f.session.getState().snapshot }); await g.session.load();
  assert.equal(g.session.getState().draft!.protocol, 'responses'); assert.equal(g.session.getState().draft!.model, configuration.model);
  g.session.selectPlatform('other'); assert.equal(g.session.getState().draft!.protocol, 'chat_completions');
  g.session.edit({ protocol: 'responses' as const }); g.session.selectPreset('custom'); assert.equal(g.session.getState().draft!.protocol, 'chat_completions'); f.session.dispose(); g.session.dispose();
});

test('wrong protocol acknowledgement and protocol-only two-window conflict reconcile without overwriting draft or retry', async () => {
  for (const cause of ['wrong-ack', 'conflict'] as const) {
    let reads = 0;
    const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ revision: 1 }), write: async () => { if (cause === 'conflict') throw codeError('AGENT_SETTINGS_CONFLICT'); return snapshot({ revision: 1 }); } });
    await f.session.load(); f.session.edit({ protocol: 'responses' as const }); assert.equal(await f.session.save(), false);
    assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().draft!.protocol, 'responses'); assert.equal(f.session.getState().snapshot!.configuration.protocol, 'chat_completions');
    assert.equal(f.calls.length, 1); assert.equal(reads, 2); assert.equal(await f.session.save(), false); f.session.dispose();
  }
});

test('shared protocol selector exposes fixed endpoint, preserves arbitrary model, and explicit reset returns CC', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render();
  assert.equal(h.find('agent-settings-protocol')!.type, 'WorkbenchSelect');
  assert.deepEqual(nodes(h.find('agent-settings-protocol')).filter((node) => node.type === 'option').map((node) => node.props.value), ['chat_completions', 'responses', 'anthropic_messages']);
  h.change('agent-settings-model', 'my-explicit-model'); h.change('agent-settings-protocol', 'responses');
  assert.equal(h.find('agent-settings-model')!.props.value, 'my-explicit-model');
  assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /https:\/\/api.example.com\/v1\/responses/);
  assert.match(JSON.stringify(h.find('agent-settings-model-guidance')), /gpt-4.1-mini/); assert.match(JSON.stringify(h.find('agent-settings-model-guidance')), /手动填写/);
  assert.equal(f.calls.length, 0);
  h.find('agent-settings-reset')!.props.onClick(); h.render();
  assert.equal(h.find('agent-settings-protocol')!.props.value, 'chat_completions'); assert.equal(h.find('agent-settings-model')!.props.value, configuration.model); h.unmount();
});

test('Anthropic selection uses its root endpoint and custom Messages selection preserves explicit edits in all locales', async () => {
  const f = fixture({initial: snapshot({presets: AGENT_PRESETS})}), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); h.change('agent-settings-preset', 'anthropic');
  assert.deepEqual(nodes(h.find('agent-settings-protocol')).filter(node => node.type === 'option').map(node => node.props.value), ['chat_completions', 'responses', 'anthropic_messages']);
  assert.equal(h.find('agent-settings-base-url')!.props.value, 'https://api.anthropic.com');
  assert.equal(h.find('agent-settings-model')!.props.value, 'claude-haiku-4-5');
  assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /https:\/\/api.anthropic.com\/v1\/messages/);
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    const rendered = JSON.stringify(h.setLocale(locale));
    assert.match(rendered, /https:\/\/api.anthropic.com/);
    assert.match(rendered, /\/v1\/messages/);
    assert.ok(h.find('agent-settings-anthropic-guidance'));
    assert.doesNotMatch(rendered, /agent\.settings\.anthropic(?:EndpointHelp|Scope|Note)/);
  }
  h.change('agent-settings-preset', 'custom');
  assert.deepEqual(nodes(h.find('agent-settings-protocol')).filter(node => node.type === 'option').map(node => node.props.value), ['chat_completions', 'responses', 'anthropic_messages']);
  h.change('agent-settings-base-url', 'https://compat.example.com/anthropic'); h.change('agent-settings-model', 'my-explicit-model');
  h.change('agent-settings-protocol', 'anthropic_messages');
  assert.equal(h.find('agent-settings-base-url')!.props.value, 'https://compat.example.com/anthropic');
  assert.equal(h.find('agent-settings-model')!.props.value, 'my-explicit-model');
  assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /https:\/\/compat.example.com\/anthropic\/v1\/messages/);
  h.change('agent-settings-preset', 'openai');
  assert.equal(h.find('agent-settings-protocol')!.props.value, 'chat_completions');
  assert.equal(h.find('agent-settings-anthropic-guidance'), undefined);
  assert.equal(f.calls.length, 0, 'selection never probes, retries, saves or sends inference'); h.unmount();
});

test('MiniMax selects Messages directly without replacing its preset, platform, typed URL or model', async () => {
  for (const platformId of ['china', 'international']) {
    const saved = {presetId: 'minimax', platformId, baseUrl: 'https://compat.example.com/user-prefix', model: 'user-selected-minimax-model', protocol: 'chat_completions'};
    const f = fixture({initial: snapshot({presets: AGENT_PRESETS, configuration: saved, secret: {configured: true, storage: 'session'}})}), h = uiHarness(f.client);
    h.render(); await flush(); h.render();
    assert.equal(h.find('agent-settings-preset')!.props.value, saved.presetId);
    assert.equal(h.find('agent-settings-platform')!.props.value, platformId);
    assert.equal(h.find('agent-settings-protocol')!.props.value, 'chat_completions');
    h.change('agent-settings-protocol', 'anthropic_messages');
    assert.equal(h.find('agent-settings-preset')!.props.value, saved.presetId);
    assert.equal(h.find('agent-settings-platform')!.props.value, platformId);
    assert.equal(h.find('agent-settings-base-url')!.props.value, saved.baseUrl);
    assert.equal(h.find('agent-settings-model')!.props.value, saved.model);
    assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /https:\/\/compat.example.com\/user-prefix\/v1\/messages/);
    for (const locale of i18n.LOCALES) {
      h.setLocale(locale);
      assert.ok(JSON.stringify(h.find('agent-settings-protocol-help')).includes(i18n.translate(locale, 'agent.settings.protocolHelp')));
      assert.ok(JSON.stringify(h.find('agent-settings-anthropic-guidance')).includes(i18n.translate(locale, 'agent.settings.anthropicScope')));
    }
    assert.equal(f.calls.length, 0);
    h.form()!.props.onSubmit({preventDefault() {}}); await flush(); h.render();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].configuration, {...saved, protocol: 'anthropic_messages'});
    assert.deepEqual(f.calls[0].secret, {action: 'keep'});
    h.unmount();
  }
});

test('Ollama protocol switching preserves its draft base until the user explicitly enters the Messages root', async () => {
  const f = fixture({initial: snapshot({presets: AGENT_PRESETS})}), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); h.change('agent-settings-preset', 'ollama');
  h.change('agent-settings-protocol', 'anthropic_messages');
  assert.equal(h.find('agent-settings-base-url')!.props.value, 'http://127.0.0.1:11434/v1');
  assert.equal(h.find('agent-settings-model')!.props.value, 'qwen3:8b');
  assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /http:\/\/127.0.0.1:11434\/v1\/v1\/messages/);
  h.change('agent-settings-base-url', 'http://127.0.0.1:11434');
  assert.match(JSON.stringify(h.find('agent-settings-endpoint')), /http:\/\/127.0.0.1:11434\/v1\/messages/);
  assert.equal(h.find('agent-settings-preset')!.props.value, 'ollama');
  assert.equal(f.calls.length, 0); h.unmount();
});

test('Qwen Responses guidance keeps qwen-plus until the user types the documented exact model', async () => {
  const qwen = { id: 'qwen', label: 'Qwen', platforms: [{ id: 'beijing', label: '北京', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], supportedModelHints: { responses: ['qwen3.8-flash'] }, protocolNotes: { responses: '供应商自动截断无法禁用；账户与区域必须匹配。' } }] };
  const initial = snapshot({ presets: [qwen], configuration: { presetId: qwen.id, platformId: 'beijing', baseUrl: qwen.platforms[0].baseUrl, model: 'qwen-plus', protocol: 'chat_completions' as const } });
  const f = fixture({ initial }), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-settings-protocol', 'responses');
  assert.equal(h.find('agent-settings-model')!.props.value, 'qwen-plus'); assert.match(JSON.stringify(h.find('agent-settings-model-guidance')), /qwen3.8-flash/); assert.match(JSON.stringify(h.find('agent-settings-model-guidance')), /自动截断无法禁用/);
  assert.equal(f.calls.length, 0); h.change('agent-settings-model', 'qwen3.8-flash'); assert.equal(h.find('agent-settings-model')!.props.value, 'qwen3.8-flash'); h.unmount();
});

test('actual selected Responses guidance describes multi-step tasks constrained by execution tiers and authorization', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render();
  for (const preset of ['openai', 'custom', 'ollama'] as const) {
    h.change('agent-settings-preset', preset);
    assert.equal(h.find('agent-settings-model-guidance'), undefined);
    h.change('agent-settings-protocol', 'responses');
    const guidance = JSON.stringify(h.find('agent-settings-model-guidance'));
    assert.match(guidance, /支持连续多步执行/);
    assert.match(guidance, /实际操作受执行方式、授权和步数上限约束/);
    assert.doesNotMatch(guidance, /每轮最多 1 次只读工具调用|2 次模型请求|不支持媒体生成|自动批准/);
    if (preset === 'custom') assert.match(guidance, /兼容性未经验证/);
    h.change('agent-settings-protocol', 'chat_completions');
    assert.equal(h.find('agent-settings-model-guidance'), undefined);
  }
  assert.equal(f.calls.length, 0); h.unmount();
});

test('hidden settings retain nonsecret draft, clear transient key immediately, and reject all old actions after reveal', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-settings-model', 'retained-draft'); h.change('agent-settings-protocol', 'responses'); h.key('dummy-transient');
  const oldSubmit = h.form()!.props.onSubmit, oldEdit = h.find('agent-settings-model')!.props.onChange, oldBack = h.find('agent-settings-back')!.props.onClick;
  h.setVisible(false); assert.equal(h.find('agent-settings-key')!.props.ref.current.value, ''); h.render();
  assert.equal(h.find('agent-settings-page')!.props.inert, true); assert.equal(h.find('agent-settings-save')!.props.disabled, true);
  oldSubmit({ preventDefault() {} }); oldEdit({ target: { value: 'stale' } }); oldBack();
  h.setVisible(true); h.render(); oldSubmit({ preventDefault() {} }); oldEdit({ target: { value: 'still stale' } }); oldBack(); h.render();
  assert.equal(h.find('agent-settings-model')!.props.value, 'retained-draft'); assert.equal(h.find('agent-settings-protocol')!.props.value, 'responses');
  assert.match(JSON.stringify(h.find('agent-settings-key-cleared')), /已清空/); assert.equal(f.calls.length, 0); assert.equal(h.closes, 0); h.unmount();
});

test('settings save accepted while hidden stays attached without retry and reports the result when shown', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }), h = uiHarness(f.client); h.render(); await flush(); h.render();
  h.change('agent-settings-protocol', 'responses'); h.form()!.props.onSubmit({ preventDefault() {} }); h.setVisible(false);
  held.resolve!(snapshot({ revision: 1, configuration: { ...configuration, protocol: 'responses' as const } })); await flush(); h.setVisible(true); h.render();
  assert.equal(h.find('agent-settings-page')!.props['data-phase'], 'saved'); assert.equal(h.find('agent-settings-protocol')!.props.value, 'responses'); assert.equal(f.calls.length, 1); h.unmount();
});

test('four-language rerenders preserve Agent draft, password DOM, pending save and request identity', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }); let reads = 0;
  const originalRead = f.client.read; f.client.read = () => { reads++; return originalRead(); };
  const h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-settings-model', 'user-model-unchanged'); h.key('synthetic-language-only');
  const dom = h.find('agent-settings-key')!.props.ref.current;
  for (const locale of i18n.LOCALES) {
    h.setLocale(locale);
    assert.equal(h.find('agent-settings-page')!.props['aria-label'], i18n.translate(locale, 'agent.settings.title'));
    assert.equal(h.find('agent-settings-model')!.props.value, 'user-model-unchanged');
    assert.equal(h.find('agent-settings-key')!.props.ref.current, dom);
    assert.equal(dom.value, 'synthetic-language-only'); assert.equal(reads, 1); assert.equal(f.calls.length, 0);
  }
  h.form()!.props.onSubmit({ preventDefault() {} }); const request = structuredClone(f.calls[0]);
  for (const locale of i18n.LOCALES) { h.setLocale(locale); assert.equal(h.find('agent-settings-page')!.props['data-phase'], 'saving'); assert.deepEqual(f.calls, [request]); assert.equal(reads, 1); }
  held.resolve!(snapshot({ revision: 1, configuration: request.configuration, secret: { configured: true, storage: 'session' } })); await flush();
  for (const locale of i18n.LOCALES) { const tree: Tree = h.setLocale(locale); assert.ok(JSON.stringify(tree).includes(i18n.translate(locale, 'agent.settings.notice.savedSession'))); }
  h.unmount(); f.session.dispose();
});
