import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as i18n from '../packages/i18n/src/index.ts';
import { timelineMessages } from '../packages/i18n/src/catalogs/timeline.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import * as subtitles from '../apps/web/src/subtitle-state.js';
import { createFrameExtractionController } from '../apps/web/src/frame-extraction.js';
import { createTimelineFormatController } from '../apps/web/src/timeline-format-state.js';

const id = n => `95000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2);
const timeline = { id: timelineId, projectId, revision: 7, fps: 30, width: 720, height: 1280, durationFrames: 180, tracks: [], clips: [], subtitles: { profileId: 'bottom_cjk_v1', cues: [] } };
const literal = '原样 {name} <&> 50%';
function languageStore() {
  const storage = new Map();
  return createLanguageStore({ systemLanguages: ['en'], storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }) });
}
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);

test('timeline catalog has all four locales and exact placeholders for every presentation message', () => {
  assert.deepEqual(i18n.validateCatalogs(timelineMessages), []);
  for (const [key, row] of Object.entries(timelineMessages)) {
    const source = typeof row['zh-Hans'] === 'string' ? row['zh-Hans'] : row['zh-Hans'].other;
    const params = Object.fromEntries([...source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => [name, name === 'count' ? 2 : literal]));
    for (const locale of i18n.LOCALES) {
      const rendered = i18n.translate(locale, key, params);
      assert.ok(rendered.length, `${key}/${locale}`);
      if (Object.keys(params).some(key => key !== 'count')) assert.ok(rendered.includes(literal), `${key}/${locale} preserves literal interpolation`);
    }
  }
});

test('real language store relabels the mounted subtitle inspector without recreating its controller or replaying uncertain input', async () => {
  const calls = [], controller = subtitles.createSubtitleController({ createRequestId: () => 'original-subtitle-request', submit: async intent => { calls.push(structuredClone(intent)); return { status: 'unknown' }; } });
  controller.setContext({ projectId, scope: 'scope:1', timeline, connected: true, pending: false }); controller.setVisible(true);
  controller.begin(0); controller.edit('text', literal); await controller.save();
  assert.equal(calls.length, 1); assert.ok(controller.getState().uncertain);
  const before = structuredClone(controller.getState()), stateIdentity = controller.getState(), input = controller.getState().uncertain.input;
  const store = languageStore(); let slot = 0, layouts = 0; const slots = [];
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: current => slots[slot++] ||= { current }, useLayoutEffect: (fn, deps) => { const index = slot++, prior = slots[index]; if (prior && deps.every((value, index) => value === prior.deps[index])) return; slots[index] = { deps }; fn(); layouts++; } }; react.default = react;
  const context = () => { const { locale } = store.getSnapshot(); return { locale, t: (key, params) => i18n.translate(locale, key, params), renderMessage: value => i18n.renderMessage(locale, value) }; };
  const module = { exports: {} }, source = readFileSync(new URL('../apps/web/src/SubtitleInspector.jsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(name => name === 'react' ? react : name === './i18n/I18nProvider.tsx' ? { useI18n: context } : name.endsWith('packages/i18n/src/index.ts') ? i18n : name === './subtitle-state.js' ? subtitles : name === './workspace-visibility.jsx' ? { useWorkspaceVisibility: () => true } : name.endsWith('workbench-confirm') ? { useConfirmation: () => async () => false } : name.endsWith('.css') ? {} : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const seen = new Set(); let renders = 0;
  const render = () => { slot = 0; renders++; seen.add(textOf(module.exports.default({ state: controller.getState(), controller }))); };
  const release = store.subscribe(render);
  for (const locale of i18n.LOCALES) {
    await store.setPreference(locale);
    assert.equal(controller.getState(), stateIdentity); assert.equal(controller.getState().uncertain.input, input);
    assert.equal(controller.getState().draft.text, literal); assert.equal(calls.length, 1);
    assert.deepEqual(controller.getState(), before);
    assert.ok([...seen].at(-1).includes(i18n.translate(locale, 'subtitles.error.unknown')));
  }
  assert.equal(seen.size, 4); assert.equal(renders, 4); assert.equal(layouts, 1);
  release(); store.dispose();
});

test('language switches preserve frame extraction unknown identity, hash, source name and output format draft', async () => {
  const calls = [], source = { id: id(3), projectId, sha256: 'a'.repeat(64), name: literal + '.mp4', duration: 10, mimeType: 'video/mp4' };
  const frame = createFrameExtractionController({ rpc: async (operation, input) => { calls.push({ operation, input: structuredClone(input) }); if (operation === 'frame.task.list') return { projectId, items: [], nextCursor: null }; throw Error('unknown diagnostic'); }, createRequestId: () => 'same-frame-request' });
  frame.configure({ projectId, sourceScope: 'source:1', sourceAsset: source, assets: [], visible: true, blocked: false });
  await frame.refreshTasks(); await frame.capture({ sourceScope: 'source:1', sourceAssetId: source.id, sourceHash: source.sha256, sourceFrame: 40 });
  let reads = 0, submits = 0;
  const format = createTimelineFormatController({ read: async () => { reads++; return { projectId, projectRevision: 2, timelineId: null, timelineRevision: 0, presetId: 'portrait_1080', fps: 30, width: 1080, height: 1920, eligible: true, blockedReasons: [] }; }, submit: async () => { submits++; }, createRequestId: () => 'unused-format-request' });
  format.setContext({ scope: 'format:1', projectId, connected: true, pending: false }); format.setVisible(true); await format.load(); assert.equal(format.getState().phase, 'ready'); assert.equal(format.choose('landscape_1080'), true);
  assert.equal(format.getState().dirty, true); assert.equal(format.getState().draftPresetId, 'landscape_1080');
  const original = frame.getState(), originalFormat = format.getState(), snapshots = structuredClone({ frame: original, format: originalFormat, calls });
  const store = languageStore(), texts = new Set(); const release = store.subscribe(() => texts.add(i18n.renderMessage(store.getSnapshot().locale, frame.getState().messageDescriptor)));
  for (const locale of i18n.LOCALES) { await store.setPreference(locale); assert.equal(frame.getState(), original); assert.equal(format.getState(), originalFormat); }
  assert.equal(texts.size, 4); assert.equal(calls.length, 2); assert.equal(reads, 1); assert.equal(submits, 0);
  assert.deepEqual({ frame: frame.getState(), format: format.getState(), calls }, snapshots);
  assert.equal(frame.getState().pending.input.requestId, 'same-frame-request'); assert.equal(frame.getState().pending.sourceName, source.name);
  release(); store.dispose();
});

test('presentation lifecycle does not key controllers or business effects by language', () => {
  for (const name of ['Timeline.jsx', 'TimelineInspector.jsx', 'Preview.jsx', 'SubtitleInspector.jsx', 'SubtitleLane.jsx', 'SourceRangeInspector.jsx', 'FrameExtractionPanel.jsx', 'ClipLutControls.tsx', 'LookPackControls.tsx', 'TimelineAudioPreview.tsx', 'TimelineFormatPanel.jsx']) {
    const source = readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /key=\{(?:locale|language)\}/u, name);
    assert.doesNotMatch(source, /\},\s*\[[^\]]*\b(?:locale|language)\b[^\]]*\]\)/u, name);
  }
});


test('revision labels are localized rather than carrying English shorthand into non-English interfaces', () => {
  for (const [key, translations] of Object.entries(timelineMessages)) {
    for (const [locale, value] of Object.entries(translations)) {
      for (const template of typeof value === 'string' ? [value] : Object.values(value)) assert.doesNotMatch(template, /\brev\b/u, `${key}/${locale}`);
    }
  }
  assert.equal(i18n.translate('ja', 'export.revision', { revision: 7 }), 'リビジョン 7');
});
