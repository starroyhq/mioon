import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as i18n from '../packages/i18n/src/index.ts';
import { timelineDeliveryMessages } from '../packages/i18n/src/catalogs/timeline-delivery.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import * as range from '../apps/web/src/export-range-state.ts';
import * as delivery from '../apps/web/src/export-delivery-state.ts';
import * as deliveryContracts from '@mioon/contracts/timeline-delivery';
import * as restored from '../apps/web/src/restored-workspace.js';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import { createLocalShotTextController } from '../apps/web/src/local-shot-text-state.ts';
import { LocalDeliveryRequestError } from '../apps/web/src/local-delivery-client.ts';
import { LocalShotTextRequestError } from '../apps/web/src/local-shot-text-client.ts';

const literal = '繁體 日本語 <literal> {name} 50%';
const projectId = '70000000-0000-4000-8000-000000000001';
const timelineId = '70000000-0000-4000-8000-000000000002';
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
function mounted(filename, getProps) {
  const storage = new Map(), store = createLanguageStore({ systemLanguages: ['en'], storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }) });
  let cursor = 0, tree, renders = 0; const slots = [];
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useId: () => slots[cursor++] ||= `stable-id-${cursor}`, useRef: current => slots[cursor++] ||= { current } }; react.default = react;
  const useI18n = () => { const { locale } = store.getSnapshot(); return { locale, t: (key, params) => i18n.translate(locale, key, params), renderMessage: value => i18n.renderMessage(locale, value), formatDate: (value, options) => i18n.formatDate(locale, value, options), formatNumber: (value, options) => i18n.formatNumber(locale, value, options) }; };
  const module = { exports: {} }, source = readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: filename.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(name => name === 'react' ? react : name === './i18n/I18nProvider.tsx' ? { useI18n } : name === './export-range-state.ts' ? range : name === './export-delivery-state.ts' ? delivery : name === '@mioon/contracts/timeline-delivery' ? deliveryContracts : name === './restored-workspace.js' ? restored : name.endsWith('packages/i18n/src/index.ts') ? i18n : name.endsWith('.css') ? {} : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const render = () => { cursor = 0; renders++; tree = module.exports.default(getProps()); };
  const release = store.subscribe(render); render();
  return { store, render, nodes: () => nodes(tree), text: () => text(tree), renders: () => renders, find: id => nodes(tree).find(node => node.props?.['data-testid'] === id), close: () => { release(); store.dispose(); } };
}

test('delivery/recovery catalog has complete four-language entries and parameter parity', () => {
  assert.deepEqual(i18n.validateCatalogs(timelineDeliveryMessages), []);
  for (const [key, row] of Object.entries(timelineDeliveryMessages)) {
    const template = typeof row['zh-Hans'] === 'string' ? row['zh-Hans'] : row['zh-Hans'].other;
    const params = Object.fromEntries([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => [name, name === 'count' ? 2 : literal]));
    for (const locale of i18n.LOCALES) assert.ok(i18n.translate(locale, key, params), `${key}/${locale}`);
  }
});

test('mounted range controls switch all labels while preserving raw numeric draft, version, IDs and handlers', async () => {
  let changes = 0;
  const controller = range.createExportRangeController({ onChange: () => changes++ });
  controller.setContext({ scope: 'scope:1', projectId, timelineId, revision: 7, durationFrames: 9000, enabled: true });
  controller.chooseRange({ mode: 'selected', startText: '00030', endText: '00120' }, 'scope:1');
  const state = controller.getState(), before = structuredClone(state), count = changes;
  const ui = mounted('ExportRangeControls.tsx', () => ({ draft: controller.getState().draft, value: controller.getState().value, durationFrames: 9000, onChange: value => controller.chooseRange(value, 'scope:1') }));
  const initialId = ui.find('export-range-start').props.id, texts = new Set();
  for (const locale of i18n.LOCALES) {
    await ui.store.setPreference(locale); texts.add(ui.text());
    assert.equal(ui.find('export-range-start').props.id, initialId);
    assert.equal(ui.find('export-range-start').props.value, '00030'); assert.equal(ui.find('export-range-end').props.value, '00120');
    assert.equal(controller.getState(), state); assert.deepEqual(controller.getState(), before); assert.equal(changes, count);
  }
  assert.equal(texts.size, 4);
  ui.find('export-range-start').props.onChange({ currentTarget: { value: '00060' } });
  assert.equal(changes, count + 1); assert.equal(controller.getState().draft.startText, '00060'); assert.equal(controller.getState().value.startFrame, 60);
  ui.close();
});

test('mounted delivery title keeps literal user text and the same draft/capture across real store switches', async () => {
  let changes = 0;
  const controller = delivery.createTimelineDeliveryNameController({ onChange: () => changes++ });
  controller.setContext({ scope: 'scope:1', projectId, enabled: true }); controller.choose(literal, 'scope:1');
  const state = controller.getState(), snapshot = structuredClone(state), capture = controller.capture(), before = changes;
  const ui = mounted('TimelineDeliveryName.tsx', () => ({ value: controller.getState().value, onChange: value => controller.choose(value, 'scope:1') }));
  const initialId = ui.find('delivery-name-input').props.id, labels = new Set();
  for (const locale of i18n.LOCALES) {
    await ui.store.setPreference(locale); labels.add(ui.text());
    assert.equal(ui.find('delivery-name-input').props.id, initialId); assert.equal(ui.find('delivery-name-input').props.value, literal);
    assert.equal(controller.getState(), state); assert.deepEqual(controller.getState(), snapshot); assert.equal(controller.getName('scope:1'), capture.value); assert.equal(changes, before);
  }
  assert.equal(labels.size, 4);
  ui.find('delivery-name-input').props.onChange({ currentTarget: { value: literal + ' new' } }); assert.equal(changes, before + 1);
  assert.equal(controller.getState().value, literal + ' new'); ui.close();
});

test('mounted delivery workspace retains child identity and selected page without navigation on language change', async () => {
  const child = { type: 'textarea', props: { value: literal, 'data-testid': 'retained-user-child' } }, pages = [];
  const ui = mounted('DeliveryWorkspace.tsx', () => ({ page: 'history', onPage: page => pages.push(page), children: child })), labels = new Set();
  for (const locale of i18n.LOCALES) {
    await ui.store.setPreference(locale); labels.add(ui.text());
    assert.equal(ui.find('delivery-workspace').props['data-page'], 'history'); assert.equal(ui.find('retained-user-child'), child); assert.equal(child.props.value, literal); assert.deepEqual(pages, []);
  }
  assert.equal(labels.size, 4);
  ui.nodes().find(node => node.type === 'Tabs').props.onValueChange('compose'); assert.deepEqual(pages, ['compose']); ui.close();
});

test('mounted recovery disclosures relabel without opening, reading, restoring or executing', async () => {
  for (const domain of ['clip', 'delivery', 'shot-text', 'task-center']) {
    const props = domain === 'task-center' ? { domain, durableOperationCount: 22 } : { domain };
    const before = structuredClone(props), ui = mounted('RecoveryStorageDetails.tsx', () => props), labels = new Set();
    for (const locale of i18n.LOCALES) {
      await ui.store.setPreference(locale); labels.add(ui.text());
      const details = ui.nodes().find(node => node.type === 'details'); assert.equal(details.props.open, undefined);
      assert.ok(ui.nodes().every(node => !node.props?.onClick && !node.props?.onChange)); assert.deepEqual(props, before);
    }
    assert.equal(labels.size, 4); ui.close();
  }
});

test('mounted restored-workspace notice preserves original provenance and held records in every locale', async () => {
  const workspace = { restored: true, heldCounts: [{ kind: 'render', count: 1 }, { kind: 'generation', count: 0 }], operationPolicy: ['asset.import', 'shot.update', 'timeline.render'].map(operation => ({ operation, available: true })), createdAt: '2026-10-15T00:30:00.000Z', source: { backupId: literal }, workspaceOrigin: 'b'.repeat(64) };
  const before = structuredClone(workspace), ui = mounted('RestoredWorkspace.jsx', () => ({ workspace })), labels = new Set();
  for (const locale of i18n.LOCALES) {
    await ui.store.setPreference(locale); labels.add(ui.text());
    assert.ok(ui.text().includes(literal)); assert.ok(ui.text().includes(workspace.workspaceOrigin)); assert.deepEqual(workspace, before);
    assert.ok(ui.text().includes(i18n.translate(locale, 'recovery.restored.disabledReason')));
    assert.ok(ui.text().includes(i18n.translate(locale, 'recovery.restored.backupReason')));
    assert.ok(ui.text().includes(i18n.translate(locale, 'recovery.restored.historyCount', { availability: i18n.translate(locale, 'recovery.restored.localReady'), count: 1 })));
    assert.equal(ui.nodes().find(node => node.type === 'details').props.open, undefined);
    assert.ok(ui.nodes().every(node => !node.props?.onClick && !node.props?.onChange));
  }
  assert.equal(labels.size, 4); ui.close();
});

test('offline backup guide translations preserve every command and immutable safety marker', () => {
  const original = readFileSync(new URL('../docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md', import.meta.url), 'utf8');
  const commands = [...original.matchAll(/node apps\/cli\/src\/backup\.mjs[^`\n]+/gu)].map(match => match[0]);
  for (const locale of ['zh-Hant', 'en', 'ja']) {
    const guide = readFileSync(new URL(`../docs/WORKSPACE-BACKUP-GUIDE.${locale}.md`, import.meta.url), 'utf8');
    for (const command of commands) assert.ok(guide.includes(command), `${locale}: ${command}`);
    for (const value of ['512MiB','8GiB','64GiB','20,000','8MiB','1MiB','64MiB','0700/0600','COMPLETE.json','SOURCE_LOCK_RELEASE_UNCONFIRMED','sourceLockRelease: unconfirmed','format1/schema24','observed_guarded','fsync']) assert.ok(guide.includes(value), `${locale}: ${value}`);
  }
});


for (const domain of ['delivery', 'shot-text']) {
  for (const failure of ['local-validation', 'unknown-preparation']) {
    test(`${domain} retained ${failure} relabels in place with unchanged controller, raw draft and request identity`, async t => {
      const shotText = domain === 'shot-text', id = n => `78000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const shotId = id(3), stamp = '2026-10-15T00:30:00.000Z';
      const invalid = failure === 'local-validation', raw = { title: literal, prompt: invalid ? 'x'.repeat(6001) : literal };
      const name = invalid ? 'x'.repeat(513) : literal, baseText = { title: 'Original user title', prompt: 'Original user prompt' };
      const context = { scope: 'stable-recovery', projectId, restored: false, connected: true, visible: true, busy: false,
        ...(shotText ? { shotId, revision: 7, baseRevision: 7, baseText, savedText: baseText, raw, textVersion: 1, formSerial: 1, textDirty: true, formDirty: true }
          : { timelineId, timelineRevision: 7, deliveryName: name, nameVersion: 1, dirty: true }) };
      let stored = { supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(4), projectId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset', ...(shotText ? { shotId, projectPendingIntent: null } : {}) };
      const calls = [], diagnostic = 'original backend diagnostic /private/path DO_NOT_DISPLAY'; let next = 10;
      const client = {
        async get() { calls.push({ method: 'get' }); return structuredClone(stored); },
        async put(input) {
          calls.push({ method: 'put', input: structuredClone(input) });
          stored = { ...stored, draftRevision: stored.draftRevision + 1, draftTargetStatus: 'matching',
            draft: { draftId: input.draftId, baseRevision: input.baseRevision, raw: structuredClone(input.raw), updatedAt: stamp,
              ...(shotText ? { baseText: structuredClone(input.baseText) } : { timelineId: input.timelineId }) } };
          return structuredClone(stored);
        },
        async prepare(input) { calls.push({ method: 'prepare', input: structuredClone(input) }); throw shotText ? new LocalShotTextRequestError(diagnostic, 'LOCAL_SHOT_TEXT_NETWORK_UNKNOWN') : new LocalDeliveryRequestError(diagnostic, 'LOCAL_DELIVERY_NETWORK_UNKNOWN'); },
        async execute(input) { calls.push({ method: 'execute', input }); assert.fail('An uncertain preparation must not execute.'); },
        async recover(input) { calls.push({ method: 'recover', input }); assert.fail('Rendering or switching languages must not recover.'); },
      };
      const options = { context, client, delay: 60000, createId: () => id(next++) };
      const controller = shotText ? createLocalShotTextController({ ...options, isShotUpdateInput: () => true })
        : createLocalDeliveryController({ ...options, isRenderInput: () => true, validateResponse: () => true });
      t.after(() => controller.dispose()); await controller.load();
      if (invalid) assert.equal(await controller.flush(), false);
      else assert.equal(await (shotText ? controller.submit() : controller.submit({ projectId, expectedRevision: 7, requestId: id(9), purpose: 'export', deliveryName: name })), null);
      assert.deepEqual(calls.map(call => call.method), invalid ? ['get'] : ['get', 'put', 'prepare']);
      const state = controller.getState(), snapshot = structuredClone(state), capture = controller.capture(), capturedInput = state.retainedPreparation?.input;
      const field = invalid ? 'draftErrorDisplay' : 'intentErrorDisplay';
      assert.equal(state[field].key, invalid ? (shotText ? 'recovery.text.localInvalid' : 'recovery.delivery.localInvalid') : 'recovery.notice.network');
      assert.equal(state.intentUncertain, !invalid); assert.equal(controller.isCurrent(capture), true);
      const beforeCalls = structuredClone(calls), ui = mounted(shotText ? 'ShotTextDraftRecovery.tsx' : 'DeliveryDraftRecovery.tsx', () => ({ state: controller.getState(), controller })), labels = new Set();
      t.after(() => ui.close());
      for (const locale of i18n.LOCALES) {
        await ui.store.setPreference(locale); labels.add(ui.text());
        const alerts = ui.nodes().filter(node => node.props?.role === 'alert').map(text);
        assert.ok(alerts.includes(i18n.renderMessage(locale, state[field])));
        assert.ok(!ui.text().includes(diagnostic));
        assert.equal(controller.getState(), state); assert.deepEqual(controller.getState(), snapshot);
        assert.equal(controller.getState().retainedPreparation?.input, capturedInput); assert.equal(controller.isCurrent(capture), true);
        assert.deepEqual(calls, beforeCalls);
        if (shotText) assert.deepEqual(controller.getState().raw, raw); else assert.equal(controller.getState().deliveryName, name);
        if (!invalid) assert.ok(ui.text().includes(literal));
      }
      assert.equal(labels.size, 4);
    });
  }
}


test('typed plural templates render count one and other without changing source counts', () => {
  for (const count of [1, 2]) {
    assert.equal(i18n.translate('en', 'timeline.view.clipCount', { duration: '00:01:00', count }), `00:01:00 · ${count} ${count === 1 ? 'clip' : 'clips'}`);
    assert.equal(i18n.translate('en', 'export.history.storyboard', { count }), `Storyboard-order export · ${count} ${count === 1 ? 'shot' : 'shots'}`);
    assert.equal(i18n.translate('en', 'recovery.restored.historyCount', { availability: 'Available', count }), `Available · ${count} historical ${count === 1 ? 'record' : 'records'} retained`);
    for (const locale of i18n.LOCALES) {
      assert.ok(i18n.translate(locale, 'timeline.view.clipCount', { duration: '00:01:00', count }).includes(String(count)));
      assert.ok(i18n.translate(locale, 'export.history.storyboard', { count }).includes(String(count)));
      assert.ok(i18n.translate(locale, 'recovery.restored.historyCount', { availability: literal, count }).includes(literal));
    }
  }
  assert.throws(() => i18n.translate('en', 'recovery.restored.historyCount', { availability: 'Available', count: '1' }), /finite count/);
});
