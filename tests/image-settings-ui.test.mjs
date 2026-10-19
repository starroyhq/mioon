import * as i18n from '../packages/i18n/src/index.ts';
import { createI18nTestContext as localeDisplay } from './helpers/i18n.ts';
const localizedSource = source => source + JSON.stringify(Object.entries(i18n.catalogs).filter(([key]) => source.includes(key)).map(([, entry]) => entry['zh-Hans']));
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as logic from '../apps/web/src/image-settings.ts';
import { createImageReviewClient } from '../apps/web/src/image-review.ts';
import { IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY, isImageReviewResponse } from '../packages/contracts/src/image-reviews.ts';
import { createHash } from 'node:crypto';
import { canonicalImageInput } from '../packages/contracts/src/images.ts';

const { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, createImageSettingsClient, createImageSettingsSession, imageKeyIssue, imageSettingsCanSave, safeImageSettings } = logic;
const snapshot = (patch = {}) => ({ revision: 0, configuration: structuredClone(DEFAULT_IMAGE_CONFIGURATION), secret: { configured: false, storage: 'none' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, ...patch });
const vault = { persistentAvailable: true, sessionScope: 'server', reasonCode: null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const codeError = code => Object.assign(new Error('never-reflect-synthetic-secret'), { code });
function fixture({ initial = snapshot(), read, write, slot = 'official' } = {}) {
  const calls = [], changes = [], snapshots = []; let current = initial;
  const client = { read: read || (async () => current), write: input => { calls.push(structuredClone(input)); if (write) return write(input); current = snapshot({ revision: input.expectedRevision + 1, configuration: input.configuration, storage: current.storage, secret: input.secret.action === 'replace' ? { configured: true, storage: input.secret.storage } : input.secret.action === 'remove' ? { configured: false, storage: 'none' } : current.secret }); return Promise.resolve(current); } };
  const session = createImageSettingsSession({ client, slot, onChange: state => changes.push(state), onSnapshot: value => snapshots.push(value) }); return { session, client, calls, changes, snapshots, slot };
}

test('image settings expose only a fixed redacted contract and reject echoed secrets or destination edits', () => {
  assert.deepEqual(safeImageSettings(snapshot()), snapshot());
  for (const patch of [{ secret: { configured: false, storage: 'none', value: 'synthetic' } }, { key: 'synthetic' }, { configuration: { ...DEFAULT_IMAGE_CONFIGURATION, baseUrl: 'https://elsewhere.example.com' } }, { revision: -1 }, { storage: { persistentAvailable: true, sessionScope: 'server', reasonCode: 'LINUX_BASIC_TEXT' } }]) assert.throws(() => safeImageSettings(snapshot(patch)), /did not complete/);
  assert.equal(imageKeyIssue(''), ''); assert.equal(imageKeyIssue('synthetic-only'), ''); for (const value of [' ', 'x\ny', '密钥', 'x'.repeat(4097)]) assert.notEqual(imageKeyIssue(value), '');
});

test('image settings client uses dedicated authenticated no-store GET/PUT, never RPC or provider HTTP', async () => {
  const calls = [], client = createImageSettingsClient({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: snapshot() }) }; } });
  await client.read(); await client.write({ expectedRevision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: { action: 'replace', storage: 'session', value: 'synthetic-only' } });
  assert.deepEqual(calls.map(call => [call.url, call.method, call.credentials, call.cache]), [['/api/images/settings', 'GET', 'same-origin', 'no-store'], ['/api/images/settings', 'PUT', 'same-origin', 'no-store']]); assert.equal(calls[0].body, undefined); assert.equal(JSON.parse(calls[1].body).secret.value, 'synthetic-only');
});

test('settings transport strips raw errors and timeout makes exactly one aborted call', async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'IMAGE_SETTINGS_CONFLICT', message: 'synthetic-secret', details: 'synthetic-secret' } }) }), () => { throw Error('synthetic-secret'); }]) await assert.rejects(createImageSettingsClient({ fetchImpl }).read(), error => !JSON.stringify(error).includes('synthetic-secret') && !error.message.includes('synthetic-secret'));
  let calls = 0, signal; const held = deferred(), client = createImageSettingsClient({ timeoutMs: 5, fetchImpl: (_, options) => { calls++; signal = options.signal; return held.promise; } });
  await assert.rejects(client.write({}), error => error.code === 'NETWORK'); assert.equal(calls, 1); assert.equal(signal.aborted, true); held.resolve({ ok: true, json: async () => ({ ok: true, data: snapshot() }) }); await flush(); assert.equal(calls, 1);
});

test('first credential requires an explicit storage choice and unavailable vault never falls back', async () => {
  const f = fixture(); await f.session.load(); assert.equal(f.session.getState().storage, ''); assert.equal(await f.session.save('synthetic-only'), false); assert.equal(f.calls.length, 0); assert.equal(f.session.setStorage('persistent'), false); f.session.setStorage('session'); assert.equal(await f.session.save('synthetic-only'), true); assert.deepEqual(f.calls[0].secret, { action: 'replace', storage: 'session', value: 'synthetic-only' }); assert.doesNotMatch(JSON.stringify(f.changes) + JSON.stringify(f.snapshots), /synthetic-only/); f.session.dispose();
  const g = fixture({ initial: snapshot({ storage: vault }) }); await g.session.load(); assert.equal(g.session.setStorage('persistent'), true); await g.session.save('synthetic-vault-only'); assert.equal(g.session.getState().snapshot.secret.storage, 'persistent'); assert.doesNotMatch(JSON.stringify(g.changes), /synthetic-vault-only/); g.session.dispose();
});

test('save changes enabled only, keeps independent key by default and supports explicit removal', async () => {
  const f = fixture({ initial: snapshot({ secret: { configured: true, storage: 'session' } }) }); await f.session.load(); f.session.setEnabled(true); await f.session.save(); assert.deepEqual(f.calls[0].secret, { action: 'keep' }); assert.deepEqual(f.calls[0].configuration, { ...DEFAULT_IMAGE_CONFIGURATION, enabled: true }); f.session.removeKey(); f.session.removeKey(false); assert.equal(f.session.getState().secretAction, 'keep'); f.session.removeKey(); await f.session.save(); assert.deepEqual(f.calls[1].secret, { action: 'remove' }); f.session.dispose();
});

test('unknown save and CAS conflict read back once, retain drafts and never retry or infer confirmation', async () => {
  for (const code of ['NETWORK', 'IMAGE_SETTINGS_CONFLICT']) {
    let reads = 0; const latest = snapshot({ revision: 2 }); const f = fixture({ read: async () => ++reads === 1 ? snapshot({ storage: vault }) : latest, write: () => Promise.reject(codeError(code)) }); await f.session.load(); f.session.setEnabled(true); f.session.setStorage('persistent'); await f.session.save('synthetic-only');
    assert.equal(reads, 2); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().draft.enabled, true); assert.equal(f.session.getState().storage, ''); assert.equal(imageSettingsCanSave(f.session.getState()), false); assert.equal(await f.session.save('retry-forbidden'), false); assert.doesNotMatch(JSON.stringify(f.changes), /synthetic-only|never-reflect/); f.session.acknowledge(); assert.equal(imageSettingsCanSave(f.session.getState()), true); f.session.dispose();
  }
});

test('double save, hidden edits and disposed completions cannot write again or leak a secret', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }); await f.session.load(); f.session.setStorage('session'); const saving = f.session.save('synthetic-only'); assert.equal(await f.session.save('another-synthetic'), false); assert.equal(f.session.setEnabled(true), false); const count = f.changes.length; f.session.dispose(); held.resolve(snapshot({ revision: 1, secret: { configured: true, storage: 'session' } })); await saving; assert.equal(f.calls.length, 1); assert.equal(f.changes.length, count);
  const g = fixture(); await g.session.load(); g.session.setVisible(false); assert.equal(g.session.setEnabled(true), false); assert.equal(g.session.setStorage('session'), false); assert.equal(await g.session.save('synthetic'), false); g.session.setVisible(true); assert.equal(g.session.setEnabled(true), true); g.session.dispose();
});

const source = readFileSync(new URL('../apps/web/src/ImageSettings.tsx', import.meta.url), 'utf8');
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function renderer(f) {
  let index = 0, effects = [], active = true, contextKey = 'project-one', ancestor = true, tree, dirty = false, locale = 'zh-Hans'; const slots = [];
  const react = { createElement(type, props = {}, ...children) { if (props?.ref && !props.ref.current) props.ref.current = { value: '' }; return { type, props: { ...props, children } }; }, useState(initial) { const slot = index++; slots[slot] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[slot].value, value => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }]; }, useRef(initial) { return slots[index++] ||= { current: initial }; }, useMemo(callback, deps) { const slot = index++; if (!slots[slot] || !equalDeps(slots[slot].deps, deps)) slots[slot] = { value: callback(), deps }; return slots[slot].value; }, useLayoutEffect(callback, deps) { const slot = index++, old = slots[slot]; if (old && equalDeps(old.deps, deps)) return; slots[slot] = { callback, deps, cleanup: old?.cleanup }; effects.push(slot); } }; react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) }), module = { exports: {} };
  const require = name => { if (name === './i18n/I18nProvider.tsx') return { useI18n: () => localeDisplay(locale) }; if (name === '../../../packages/i18n/src/index.ts') return i18n; if (name === 'react') return react; if (name === './settings-navigation-state.ts') return navigation; if (name === './image-settings.ts') return logic; if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => ancestor }; if (name === './icons.tsx') return { default: 'Icon' }; if (name.endsWith('.css')) return {}; if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitive; throw Error(name); };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, require);
  const ui = { render() { index = 0; effects = []; tree = module.exports.default({ active, contextKey, client: f.client, slot: f.slot, onSelectSlot: () => { active = false; }, onClose: () => { active = false; }, onDirtyChange: value => { dirty = value; } }); for (const slot of effects) { slots[slot].cleanup?.(); slots[slot].cleanup = slots[slot].callback(); } return tree; }, find(id) { return nodes(tree).find(node => node.props['data-testid'] === id); }, form() { return nodes(tree).find(node => node.type === 'form'); }, key(value) { const field = ui.find(f.slot === 'custom' ? 'custom-image-settings-key' : 'image-settings-key'); field.props.ref.current.value = value; field.props.onChange({ target: { value } }); ui.render(); }, show(value) { active = value; ui.render(); }, collapse(value) { ancestor = !value; ui.render(); }, project(value) { contextKey = value; ui.render(); }, change(id, value) { ui.find(id).props.onChange({ target: { value, checked: value } }); ui.render(); }, click(id) { ui.find(id).props.onClick(); ui.render(); }, get dirty() { return dirty; }, setLocale(value) { locale = value; return ui.render(); }, unmount() { for (const slot of slots) slot.cleanup?.(); } }; return ui;
}

test('actual password input clears before save dispatch and remains outside rendered/session state', async () => {
  const held = deferred(); let clearedAtDispatch = false, ui;
  const f = fixture({ write: () => { clearedAtDispatch = ui.find('image-settings-key').props.ref.current.value === ''; return held.promise; } }); ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-settings-storage', 'session'); ui.key('synthetic-dom-only'); assert.equal(ui.dirty, true); assert.equal(ui.find('image-settings-key').props.value, undefined); const submit = ui.form().props.onSubmit; submit({ preventDefault() {} }); ui.render(); assert.equal(clearedAtDispatch, true); assert.equal(ui.find('image-settings-key').props.ref.current.value, ''); submit({ preventDefault() {} }); assert.equal(f.calls.length, 1); held.resolve(snapshot({ revision: 1, secret: { configured: true, storage: 'session' } })); await flush(); ui.unmount(); f.session.dispose();
});

test('image enable uses shared Input and associated Label, preserving native checkbox keyboard and checked events', async () => {
  const f = fixture(), ui = renderer(f); ui.render(); await flush(); let tree = ui.render();
  const checkbox = ui.find('image-settings-enable'), label = nodes(tree).find(node => node.props.htmlFor === checkbox.props.id);
  assert.equal(checkbox.type, 'Input'); assert.equal(label.type, 'Label'); assert.equal(label.props.className, 'image-settings-enable'); assert.ok(nodes(label).includes(checkbox));
  assert.equal(checkbox.props.type, 'checkbox'); assert.equal(checkbox.props.checked, false); assert.equal(checkbox.props.disabled, false);
  // Do not replace native Space/Tab behavior with a custom role or key handler.
  for (const key of ['role', 'tabIndex', 'onKeyDown', 'onKeyUp', 'onClick']) assert.equal(checkbox.props[key], undefined, key);
  checkbox.props.onChange({ target: { checked: true, value: 'on' } }); ui.render(); assert.equal(ui.find('image-settings-enable').props.checked, true); assert.equal(ui.dirty, true);
  ui.find('image-settings-enable').props.onChange({ target: { checked: false, value: 'on' } }); ui.render(); assert.equal(ui.find('image-settings-enable').props.checked, false); assert.equal(ui.dirty, false); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(source, /<(?:input|label)\b/); ui.unmount(); f.session.dispose();
});

test('shared enable checkbox is disabled while saving or hidden and stale checked events stay fenced', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-settings-enable', true);
  const beforeSave = ui.find('image-settings-enable').props.onChange; ui.form().props.onSubmit({ preventDefault() {} }); ui.render(); assert.equal(ui.find('image-settings-enable').props.disabled, true);
  beforeSave({ target: { checked: false, value: 'on' } }); ui.render(); assert.equal(ui.find('image-settings-enable').props.checked, true); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].configuration.enabled, true);
  held.resolve(snapshot({ revision: 1, configuration: { ...DEFAULT_IMAGE_CONFIGURATION, enabled: true } })); await flush(); ui.render(); assert.equal(ui.find('image-settings-enable').props.disabled, false);
  const beforeHide = ui.find('image-settings-enable').props.onChange; ui.show(false); assert.equal(ui.find('image-settings-enable').props.disabled, true); beforeHide({ target: { checked: false, value: 'on' } }); ui.render(); assert.equal(ui.find('image-settings-enable').props.checked, true);
  ui.show(true); assert.equal(ui.find('image-settings-enable').props.disabled, false); beforeHide({ target: { checked: false, value: 'on' } }); ui.render(); assert.equal(ui.find('image-settings-enable').props.checked, true); assert.equal(f.calls.length, 1); ui.unmount(); f.session.dispose();
});

test('actual hidden, collapsed, project-switched and closed settings clear key while retaining nonsecret drafts', async () => {
  for (const transition of ['hide', 'collapse', 'project', 'close']) {
    const f = fixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-settings-enable', true); ui.change('image-settings-storage', 'session'); ui.key('synthetic-dom-only'); const submit = ui.form().props.onSubmit, oldEnable = ui.find('image-settings-enable').props.onChange;
    if (transition === 'hide') ui.show(false); if (transition === 'collapse') ui.collapse(true); if (transition === 'project') ui.project('project-two'); if (transition === 'close') ui.click('image-settings-back');
    assert.equal(ui.find('image-settings-key').props.ref.current.value, '', transition); submit({ preventDefault() {} }); oldEnable({ target: { checked: false } }); ui.render(); assert.equal(f.calls.length, 0); assert.equal(ui.find('image-settings-enable').props.checked, true); assert.equal(ui.find('image-settings-storage').props.value, 'session'); assert.ok(ui.find('image-settings-key-notice')); ui.show(true); ui.collapse(false); submit({ preventDefault() {} }); assert.equal(f.calls.length, 0); ui.unmount(); f.session.dispose();
  }
});

test('settings remains a natural dock with no modal, secret cache or arbitrary provider fields', () => {
  assert.doesNotThrow(() => transformSync(source, { loader: 'tsx', format: 'esm' })); assert.doesNotMatch(source, /Dialog|localStorage|sessionStorage|console\.|dangerouslySetInnerHTML|value=\{(?:key|secret)/); assert.match(source, /type="password"/); assert.match(source, /hidden=\{!visible\} inert=\{!visible\}/); assert.match(localizedSource(source), /basic_text/); assert.match(localizedSource(source), /最多|一次配置/);
});

test('private review client binds exact receipt and posts once only to authenticated approval route', async () => {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at = '2026-10-10T10:00:00.000Z';
  const input = { projectId: id(1), requestId: 'synthetic-request', name: 'Exact', prompt: '  Exact prompt  ', providerId: 'openai', model: DEFAULT_IMAGE_CONFIGURATION.model, options: DEFAULT_IMAGE_CONFIGURATION.options };
  const review = { id: id(2), projectId: id(1), requestId: input.requestId, input, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex'), settingsRevision: 1, destination: IMAGE_REVIEW_DESTINATION, policy: IMAGE_REVIEW_POLICY, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null };
  const task = { ...input, id: id(3), groupId: id(4), state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at };
  const calls = [], client = createImageReviewClient({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: task }) }; } });
  assert.deepEqual(await client.approve(review), task); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/images/reviews/approve'); assert.equal(calls[0].credentials, 'same-origin'); assert.equal(calls[0].cache, 'no-store'); assert.deepEqual(JSON.parse(calls[0].body), { projectId: id(1), reviewId: id(2), expectedRevision: 1 });
  await assert.rejects(createImageReviewClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: { ...task, prompt: 'silently changed' } }) }) }).approve(review));
  for (const field of ['projectId', 'prompt', 'requestId', 'settingsRevision', 'createdAt']) {
    const altered = structuredClone(review); altered.state = 'rejected'; altered.revision = 2; altered.rejectedAt = at;
    if (field === 'projectId') { altered.projectId = id(90); altered.input.projectId = id(90); }
    if (field === 'prompt') altered.input.prompt = 'Changed immutable text';
    if (field === 'requestId') { altered.requestId = 'changed-request'; altered.input.requestId = 'changed-request'; }
    if (field === 'settingsRevision') altered.settingsRevision = 2;
    if (field === 'createdAt') altered.createdAt = '2026-10-10T11:00:00.000Z';
    altered.inputHash = createHash('sha256').update(canonicalImageInput(altered.input)).digest('hex');
    assert.equal(isImageReviewResponse(altered), true, field);
    await assert.rejects(createImageReviewClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: altered }) }) }).reject(review), undefined, field);
  }
  let attempts = 0; const held = deferred(); await assert.rejects(createImageReviewClient({ timeoutMs: 5, fetchImpl: () => { attempts++; return held.promise; } }).approve(review)); assert.equal(attempts, 1); held.resolve({ ok: true, json: async () => ({ ok: true, data: task }) }); await flush(); assert.equal(attempts, 1);
});

const customConfiguration = (patch = {}) => ({ ...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image-model', ...patch });
const customSnapshot = (patch = {}) => snapshot({ configuration: customConfiguration(), ...patch });

test('fixed custom settings slot uses its own private route and rejects official, unknown and unnormalized receipts', async () => {
  const calls = [], client = createImageSettingsClient({ slot: 'custom', fetchImpl: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: customSnapshot() }) }; } });
  await client.read(); await client.write({ expectedRevision: 0, configuration: customConfiguration(), secret: { action: 'keep' } });
  assert.deepEqual(calls.map(call => [call.url, call.method, call.credentials, call.cache]), [['/api/images/custom-settings', 'GET', 'same-origin', 'no-store'], ['/api/images/custom-settings', 'PUT', 'same-origin', 'no-store']]);
  assert.throws(() => createImageSettingsClient({ slot: 'typo' })); assert.throws(() => createImageSettingsSession({ slot: 'typo' }));
  assert.throws(() => safeImageSettings(snapshot(), 'custom')); assert.throws(() => safeImageSettings(customSnapshot()));
  assert.throws(() => safeImageSettings(customSnapshot({ configuration: customConfiguration({ baseUrl: 'https://IMAGES.example.com:443/v1/' }) }), 'custom'));
  assert.throws(() => safeImageSettings(customSnapshot({ secret: { configured: false, storage: 'none', value: 'not-allowed' } }), 'custom'));
});

test('custom settings normalize before PUT and never carry an existing key to another address or model', async () => {
  const f = fixture({ slot: 'custom', initial: customSnapshot({ revision: 2, secret: { configured: true, storage: 'session' } }) }); await f.session.load();
  f.session.setConfigurationField('baseUrl', 'https://NEW.example.com:443/prefix/');
  assert.equal(logic.imageSettingsDestination(f.session.getState().draft), 'https://new.example.com/prefix/images/generations');
  assert.equal(await f.session.save(), false); assert.equal(f.calls.length, 0); assert.match(f.session.getState().message, /重新输入.*新密钥/);
  assert.equal(await f.session.save('custom-synthetic-key'), true); assert.equal(f.calls[0].configuration.baseUrl, 'https://new.example.com/prefix'); assert.equal(f.calls[0].secret.action, 'replace');
  f.session.setConfigurationField('model', 'replacement-model'); assert.equal(await f.session.save(), false); f.session.removeKey(); assert.equal(await f.session.save(), true); assert.equal(f.calls[1].secret.action, 'remove');
  assert.doesNotMatch(JSON.stringify(f.changes) + JSON.stringify(f.snapshots), /custom-synthetic-key/); f.session.dispose();
});

test('custom malformed endpoints and partial empty configuration fail before save; official fields remain fixed', async () => {
  for (const baseUrl of ['http://images.example.com/v1', 'https://images.example.com:444/v1', 'https://user:secret@images.example.com/v1', 'https://images.example.com/v1?key=secret', 'https://images.example.com/../v1', '']) {
    const f = fixture({ slot: 'custom', initial: customSnapshot() }); await f.session.load(); f.session.setConfigurationField('baseUrl', baseUrl); assert.equal(await f.session.save(), false); assert.equal(f.calls.length, 0); f.session.dispose();
  }
  const f = fixture(); await f.session.load(); assert.equal(f.session.setConfigurationField('baseUrl', 'https://custom.example.com'), false); assert.equal(f.session.setConfigurationField('model', 'new-model'), false); f.session.dispose();
});

test('custom unknown save preserves complete nonsecret draft and requires explicit recovery with a freshly entered key', async () => {
  let reads = 0;
  const f = fixture({ slot: 'custom', read: async () => { reads++; return customSnapshot({ revision: reads, secret: { configured: true, storage: 'session' } }); }, write: () => Promise.reject(codeError('NETWORK')) });
  await f.session.load(); f.session.setConfigurationField('baseUrl', 'https://other.example.com/edge'); f.session.setConfigurationField('model', 'other-model'); await f.session.save('custom-synthetic-key');
  assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().draft.baseUrl, 'https://other.example.com/edge'); assert.equal(f.session.getState().draft.model, 'other-model');
  assert.equal(await f.session.save(), false); f.session.acknowledge(); assert.equal(await f.session.save(), false); assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.changes), /custom-synthetic-key/); f.session.dispose();
});

test('actual custom settings reuse shared controls, expose resolved destination and clear DOM key on slot or navigation', async () => {
  for (const transition of ['slot', 'hide', 'collapse', 'project']) {
    const f = fixture({ slot: 'custom', initial: customSnapshot({ secret: { configured: true, storage: 'session' } }) }), ui = renderer(f); ui.render(); await flush(); ui.render();
    ui.change('custom-image-settings-base-url', 'https://NEW.example.com:443/prefix/'); ui.change('custom-image-settings-model', 'new-model'); ui.key('custom-dom-only');
    assert.equal(ui.find('custom-image-settings-base-url').type, 'Input'); assert.equal(ui.find('custom-image-settings-enable').type, 'Input'); assert.ok(ui.find('custom-image-settings-binding-warning'));
    assert.deepEqual(ui.find('custom-image-settings-destination').props.children, ['https://new.example.com/prefix/images/generations']);
    const oldSubmit = ui.form().props.onSubmit;
    if (transition === 'slot') ui.click('custom-image-settings-slot-official'); if (transition === 'hide') ui.show(false); if (transition === 'collapse') ui.collapse(true); if (transition === 'project') ui.project('new-project');
    assert.equal(ui.find('custom-image-settings-key').props.ref.current.value, ''); assert.equal(ui.find('custom-image-settings-base-url').props.value, 'https://NEW.example.com:443/prefix/'); assert.equal(ui.find('custom-image-settings-model').props.value, 'new-model'); oldSubmit({ preventDefault() {} }); assert.equal(f.calls.length, 0); ui.unmount(); f.session.dispose();
  }
});

test('four-language rerenders preserve image connection draft, password DOM and single pending save', async () => {
  const held = deferred(), f = fixture({ write: () => held.promise }); let reads = 0;
  const originalRead = f.client.read; f.client.read = () => { reads++; return originalRead(); };
  const ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-settings-enable', true); ui.change('image-settings-storage', 'session'); ui.key('synthetic-language-only');
  const dom = ui.find('image-settings-key').props.ref.current;
  for (const locale of i18n.LOCALES) {
    ui.setLocale(locale); assert.equal(ui.find('image-settings-page').props['aria-label'], i18n.translate(locale, 'image.settings.aria'));
    assert.equal(ui.find('image-settings-enable').props.checked, true); assert.equal(ui.find('image-settings-storage').props.value, 'session');
    assert.equal(ui.find('image-settings-key').props.ref.current, dom); assert.equal(dom.value, 'synthetic-language-only'); assert.equal(reads, 1); assert.equal(f.calls.length, 0);
  }
  ui.form().props.onSubmit({ preventDefault() {} }); const request = structuredClone(f.calls[0]);
  for (const locale of i18n.LOCALES) { ui.setLocale(locale); assert.equal(ui.find('image-settings-page').props['data-phase'], 'saving'); assert.deepEqual(f.calls, [request]); assert.equal(reads, 1); }
  held.resolve(snapshot({ revision: 1, configuration: request.configuration, secret: { configured: true, storage: 'session' } })); await flush();
  for (const locale of i18n.LOCALES) { const tree = ui.setLocale(locale); assert.ok(JSON.stringify(tree).includes(i18n.translate(locale, 'image.settings.notice.savedSession'))); }
  ui.unmount(); f.session.dispose();
});
