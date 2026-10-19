import * as removalState from '../apps/web/src/timeline-removal.ts';
import {hasOpenWorkbenchModal} from '../apps/web/src/workbench-modal-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { isTimelineRecord, sourceFrameCount } from '@mioon/contracts';
import * as draftState from '../apps/web/src/clip-draft-state.ts';
import * as opacityState from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as volumeState from '../apps/web/src/clip-volume-envelope-state.ts';
import * as opacityAssembly from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as imeSubmit from '../apps/web/src/opacity-ime-submit-guard.ts';
import { createClipDraftClient, isOpacityCandidateClipDraftClient } from '../apps/web/src/clip-draft-client.ts';
import { OPACITY_ENVELOPE_PROFILE } from '../packages/contracts/src/timeline-opacity-envelope.ts';
import { VOLUME_ENVELOPE_PROFILE } from '../packages/contracts/src/timeline-volume-envelope.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import { LOCALES, translate, message } from '../packages/i18n/src/index.ts';

const id = n => `a2000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-16T00:00:00.000Z';
const envelope = points => ({ profileId: OPACITY_ENVELOPE_PROFILE, points });
const rawEnvelope = opacity => envelope([{ frame: '0', opacity }]);
const savedClip = patch => ({ id: id(3), name: 'Synthetic', assetId: id(4), trackId: id(5), startFrame: 0, durationFrames: 10, sourceInFrame: 0, gain: 1, rect: { x: 0, y: 0, width: 720, height: 1280 }, opacityEnvelope: envelope([{ frame: 0, opacity: 1 }, { frame: 10, opacity: 0 }]), ...patch });
const savedTimeline = (clip, revision = 1) => ({ id: id(2), projectId: id(1), revision, fps: 30, width: 720, height: 1280, durationFrames: clip.startFrame + clip.durationFrames,
  tracks: [{ id: id(5), name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false }, { id: id(6), name: 'Audio', kind: 'audio', orderIndex: 1, hidden: false, muted: false }], clips: [clip], createdAt: stamp, updatedAt: stamp });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const tick = () => new Promise(resolve => setImmediate(resolve));
const inspectorCode = transformSync(readFileSync(new URL('../apps/web/src/TimelineInspector.tsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

/** Actual Inspector and controller, with inert visual children and a bounded
 * synthetic HTTP CAS transport. No server, browser, provider or media is run. */
function inspector(t, { locale = 'en', binding = 'exact', kind = 'image', clipPatch = {}, draftContext = {}, saveResponse } = {}) {
  const hooks = [], stubs = new Map(), calls = [], requests = [], checks = [], saves = [], hookOptions = [];
  let cursor = 0, tree, controller, envelopeAck = null;
  const initial = savedClip(clipPatch);
  const props = { clip: initial, timeline: savedTimeline(initial), asset: { id: id(4), projectId: id(1), mimeType: `${kind}/${kind === 'image' ? 'png' : kind === 'audio' ? 'wav' : 'mp4'}`, hasAudio: kind === 'video' || kind === 'audio', duration: 1, sha256: 'a'.repeat(64), name: 'Synthetic source' }, draftContext: { ...draftContext }, onDirtyChange() {}, onRemove() { calls.push('remove'); }, onSave: async (clipId, patch, baseRevision, options) => {
    saves.push({ clipId, patch: structuredClone(patch), baseRevision, canExecute: options.canExecute() });
    const next = savedTimeline({ ...props.clip, ...patch }, baseRevision + 1);
    const ack = saveResponse ? saveResponse(next) : next;
    if (!saveResponse) { props.clip = next.clips[0]; props.timeline = next; }
    return ack;
  } };
  const fetcher = async (url, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url, 'http://candidate.invalid').searchParams);
    requests.push({ method: options.method, input });
    if (options.method === 'GET') envelopeAck ??= { supported: true, workspaceScope: 'b'.repeat(64), instanceId: id(7), key: input, revision: 0, targetStatus: 'matching', draft: null };
    else {
      assert.ok(envelopeAck); assert.equal(input.expectedRevision, envelopeAck.revision);
      envelopeAck = { ...envelopeAck, revision: envelopeAck.revision + 1, draft: options.method === 'DELETE' ? null : { raw: input.raw, source: input.source, baseRevision: input.baseRevision, updatedAt: stamp } };
    }
    return new Response(JSON.stringify({ ok: true, data: envelopeAck }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const exact = opacityAssembly.createOpacityCandidateInspectorBinding(fetcher);
  const bindingValue = binding === 'exact' ? exact : binding === 'copy' ? { ...exact } : binding === 'fake' ? { kind: 'internal-opacity-inspector', opacityEnvelopeEditable: true } : undefined;
  props.opacityCandidate = bindingValue;
  const fallbackClient = createClipDraftClient(fetcher);
  const stub = name => { if (!stubs.has(name)) stubs.set(name, props => props); return stubs.get(name); };
  const react = { createElement: (type, properties, ...children) => type === removalModule.exports.ClipActionsMenu ? type({...properties,children}) : ({ type, props: { ...properties, children } }), useRef: initial => hooks[cursor++] ??= { current: initial }, useState: initial => { const i=cursor++; if (!(i in hooks)) hooks[i]=initial; return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}]; }, useEffect() {}, useLayoutEffect: callback => { callback(); } }; react.default = react;
  const removalModule = {exports:{}};
  Function('require','module','exports',transformSync(readFileSync(new URL('../apps/web/src/ClipRemovalControls.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code)(name=>{
    if(name==='react')return react;
    if(name.includes('I18nProvider'))return i18nTestModule(locale);
    if(name==='./timeline-removal.ts')return removalState;
    if(name==='./workbench-modal-state.ts')return {hasOpenWorkbenchModal};
    if(name==='lucide-react'||name.startsWith('@mioon/ui/'))return new Proxy({}, {get:(_,key)=>stub(key)});
    throw Error(name);
  },removalModule,removalModule.exports);
  const module = { exports: {} };
  Function('require', 'module', 'exports', inspectorCode)(name => {
    if (name === './UiPreferencesProvider.tsx') return {useUiPreferences:()=>({preferences:{timecodeFormat:'timecode'}})};
    if (name === './timeline-removal.ts') return removalState;
    if (name === './ClipRemovalControls.tsx') return removalModule.exports;
    if (name === 'react') return react;
    if (name.includes('I18nProvider')) return i18nTestModule(locale);
    if (name.includes('i18n/src/index')) return { message };
    if (name.includes('workbench-confirm')) return { useConfirmation: () => async () => { calls.push('confirm'); return true; } };
    if (name === '@mioon/contracts') return { sourceFrameCount, isTimelineRecord(value, options) { checks.push(structuredClone(value)); return isTimelineRecord(value, options); } };
    if (name.endsWith('/Timeline.jsx')) return { assetKind: value => value?.mimeType?.split('/')[0] || 'image', framesLabel: String };
    if (name.endsWith('clip-draft-hook.ts')) return { useClipDraft(options) {
      hookOptions.push(options);
      if (!controller) {
        controller = draftState.createClipDraftController({ ...options, client: options.client ?? fallbackClient, delay: 60000 });
        for (const method of ['beginOpacityComposition', 'updateOpacityComposition', 'editOpacityEnvelope', 'endOpacityComposition', 'beginVolumeComposition', 'updateVolumeComposition', 'editVolumeEnvelope', 'endVolumeComposition', 'save', 'discard']) {
          const original = controller[method]; controller[method] = (...args) => { const result = original(...args); calls.push({ method, args, result }); return result; };
        }
      } else controller.setContext(options.context);
      return { state: controller.getState(), controller };
    } };
    if (name.endsWith('clip-draft-state.ts')) return draftState;
    if (name.endsWith('clip-opacity-envelope-state.ts')) return opacityState;
    if (name.endsWith('clip-opacity-candidate-assembly.ts')) return opacityAssembly;
    if (name.endsWith('opacity-ime-submit-guard.ts')) return imeSubmit;
    if (name.endsWith('clip-volume-envelope-state.ts')) return volumeState;
    if (name.endsWith('clip-audio-role-state.ts')) return { clipAudioRoleChanged: () => false };
    if (name.endsWith('clip-audio-state.js')) return { clipAudioIssue: () => '' };
    if (name.endsWith('timeline-format-state.js')) return { timelineRectIssue: () => '', timelineRectMessage: () => '' };
    if (name.endsWith('workspace-visibility.jsx')) return { useWorkspaceVisibility: () => true };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/')) return new Proxy({}, { get: (_, key) => stub(key) });
    return { __esModule: true, default: stub(name) };
  }, module, module.exports);
  const h = { props, calls, saves, requests, checks, hookOptions, exact, bindingValue,
    get controller() { return controller; }, get state() { return controller.getState(); },
    render(patch = {}) { Object.assign(props, patch); cursor = 0; tree = module.exports.default(props); return tree; },
    all: () => nodes(tree), text: () => text(tree), editor: () => nodes(tree).find(node => node.type === stubs.get('./ClipOpacityEnvelopeControls.tsx')),
    volumeEditor: () => nodes(tree).find(node => node.type === stubs.get('./ClipVolumeEnvelopeControls.tsx')),
    button: testid => nodes(tree).find(node => node.props?.['data-testid'] === testid),
    discard: () => nodes(tree).find(node => node.type === stubs.get('Button') && text(node) === translate(locale, 'timeline.inspector.discard')),
    submit: () => nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    async ready() { await controller.load(); h.render(); },
  };
  h.render(); t.after(() => controller.dispose()); return h;
}

test('default, fake and copied candidate bindings never reveal controls or select the candidate client', async t => {
  for (const binding of ['default', 'fake', 'copy']) {
    const h = inspector(t, { binding, draftContext: { opacityEnvelopeEditable: true, opacityCandidate: true } }); await h.ready();
    assert.equal(h.editor(), undefined);
    assert.equal(h.hookOptions[0].client, undefined);
    assert.equal(h.hookOptions[0].context.opacityEnvelopeEditable, false);
    assert.equal(Object.hasOwn(h.hookOptions[0].context.saved, 'opacityEnvelope'), false);
    assert.equal(opacityAssembly.readOpacityCandidateInspectorBinding(h.bindingValue), null);
    assert.equal(h.requests.length, 1);
  }
});
test('exact internal binding selects its original candidate factory client and preserves saved opacity text', async t => {
  for (const kind of ['image', 'video']) {
    const h = inspector(t, { kind }); await h.ready();
    const exact = opacityAssembly.readOpacityCandidateInspectorBinding(h.exact);
    assert.ok(exact); assert.equal(h.hookOptions[0].client, exact.client); assert.equal(isOpacityCandidateClipDraftClient(exact.client), true);
    assert.equal(isOpacityCandidateClipDraftClient({ ...exact.client }), false);
    assert.equal(h.hookOptions[0].context.opacityEnvelopeEditable, true);
    assert.deepEqual(h.hookOptions[0].context.saved.opacityEnvelope, envelope([{ frame: '0', opacity: '1' }, { frame: '10', opacity: '0' }]));
    assert.ok(h.editor()); assert.equal(h.editor().props.disabled, false); assert.equal(h.editor().props.proposedDuration, 10);
    assert.deepEqual(h.editor().props.value, h.hookOptions[0].context.saved.opacityEnvelope);
  }
});
test('actual Inspector forwards opacity composition tokens and blocks Save, discard and Remove until settlement', async t => {
  const h = inspector(t); await h.ready();
  h.editor().props.onEdit(rawEnvelope('.5')); h.render(); assert.equal(h.state.dirty, true);
  const session = Symbol('opacity-owner'), editor = h.editor().props;
  editor.onCompositionChange({ session, pending: true, dirty: true, row: 0, field: 'opacity', text: '一' }); h.render();
  assert.equal(h.state.compositionPending, true);
  assert.equal(h.button('save-clip').props.disabled, true); assert.equal(h.button('remove-clip').props.disabled, true); assert.equal(h.discard().props.disabled, true);
  await h.submit(); await h.button('remove-clip').props.onClick(); h.discard().props.onClick(); await tick();
  assert.equal(h.saves.length, 0); assert.equal(h.calls.includes('confirm'), false); assert.equal(h.calls.some(call => call.method === 'discard'), false);
  const token = h.calls.find(call => call.method === 'beginOpacityComposition').result;
  assert.ok(token); assert.equal(h.calls.find(call => call.method === 'updateOpacityComposition').args[0], token);
  h.props.draftConnected = false; h.render(); assert.equal(h.editor().props.disabled, false);
  h.editor().props.onEdit(rawEnvelope('1e-'), session);
  h.editor().props.onCompositionChange({ session, pending: false, dirty: false }); h.render();
  assert.equal(h.state.compositionPending, false); assert.equal(h.state.raw.opacityEnvelope.points[0].opacity, '1e-');
  assert.equal(h.calls.find(call => call.method === 'editOpacityEnvelope' && call.args[1] === token).args[1], token);
  assert.equal(h.calls.find(call => call.method === 'endOpacityComposition').args[0], token);
  assert.equal(h.button('save-clip').props.disabled, true); // Incomplete text remains a retained draft.
});
test('old Inspector callbacks cannot route old sessions into a newer opacity composition', async t => {
  const h = inspector(t); await h.ready();
  const old = h.editor().props, first = Symbol('first'), second = Symbol('second');
  old.onCompositionChange({ session: first, pending: true, dirty: true, row: 0, field: 'opacity', text: '.2' });
  old.onEdit(rawEnvelope('.2'), first); old.onCompositionChange({ session: first, pending: false, dirty: false }); h.render();
  const current = h.editor().props; current.onCompositionChange({ session: second, pending: true, dirty: true, row: 0, field: 'opacity', text: '.3' }); h.render();
  const before = h.calls.length, raw = structuredClone(h.state.raw);
  old.onEdit(rawEnvelope('.9'), first); old.onCompositionChange({ session: first, pending: false, dirty: false });
  assert.equal(h.calls.length, before); assert.deepEqual(h.state.raw, raw); assert.equal(h.state.compositionPending, true);
  current.onEdit(rawEnvelope('.3'), second); current.onCompositionChange({ session: second, pending: false, dirty: false }); h.render();
  assert.equal(h.state.raw.opacityEnvelope.points[0].opacity, '.3'); assert.equal(h.state.compositionPending, false);
});
test('Inspector enables only the composing envelope owner and rejects cross-kind publication while all destructive actions stay blocked', async t => {
  for (const owner of ['opacity', 'volume']) {
    const h = inspector(t, { kind: 'video', draftContext: { volumeEnvelopeEditable: true }, clipPatch: { volumeEnvelope: { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: 0, multiplier: 1 }] } } });
    await h.ready(); h.editor().props.onEdit(rawEnvelope('.5')); h.render();
    assert.equal(h.editor().props.disabled, false); assert.equal(h.volumeEditor().props.disabled, false);
    const own = () => owner === 'opacity' ? h.editor().props : h.volumeEditor().props;
    const other = () => owner === 'opacity' ? h.volumeEditor().props : h.editor().props;
    const otherKind = owner === 'opacity' ? 'Volume' : 'Opacity', session = Symbol(owner), foreignSession = Symbol('foreign');
    own().onCompositionChange({ session, pending: true, dirty: true, row: 0, field: owner === 'opacity' ? 'opacity' : 'multiplier', text: '一' }); h.render();
    assert.equal(h.controller.getPendingEnvelopeKind(), owner);
    assert.equal(own().disabled, false); assert.equal(other().disabled, true);
    assert.equal(h.button('save-clip').props.disabled, true); assert.equal(h.button('remove-clip').props.disabled, true); assert.equal(h.discard().props.disabled, true);
    const raw = structuredClone(h.state.raw), beforeUpdates = h.calls.filter(call => call.method === `update${otherKind}Composition`).length;
    // Captured callbacks are independently fenced even if a caller ignores the
    // other fieldset's disabled state. No token means no transient publication.
    other().onCompositionChange({ session: foreignSession, pending: true, dirty: true, row: 0, field: owner === 'opacity' ? 'multiplier' : 'opacity', text: 'foreign' });
    other().onEdit(owner === 'opacity' ? { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: '0', multiplier: '.1' }] } : rawEnvelope('.1'));
    other().onCompositionChange({ session: foreignSession, pending: false, dirty: false });
    assert.equal(h.calls.findLast(call => call.method === `begin${otherKind}Composition`).result, null);
    assert.equal(h.calls.filter(call => call.method === `update${otherKind}Composition`).length, beforeUpdates);
    assert.deepEqual(h.state.raw, raw); assert.equal(h.controller.getPendingEnvelopeKind(), owner);
    await h.submit(); await h.button('remove-clip').props.onClick(); h.discard().props.onClick();
    assert.equal(h.saves.length, 0); assert.equal(h.calls.includes('confirm'), false); assert.equal(h.calls.some(call => call.method === 'discard'), false);
    h.props.draftConnected = false; h.render(); assert.equal(own().disabled, false); assert.equal(other().disabled, true);
    own().onEdit(owner === 'opacity' ? rawEnvelope('.4') : { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: '0', multiplier: '.4' }] }, session);
    own().onCompositionChange({ session, pending: false, dirty: false }); h.render();
    assert.equal(h.controller.getPendingEnvelopeKind(), null); assert.equal(h.state.compositionPending, false);
    assert.equal(owner === 'opacity' ? h.state.raw.opacityEnvelope.points[0].opacity : h.state.raw.volumeEnvelope.points[0].multiplier, '.4');
  }
});
test('candidate Inspector saves exact opacity through the shared controller and clears only the acknowledged raw draft', async t => {
  const h = inspector(t); await h.ready();
  h.editor().props.onEdit(rawEnvelope('.125')); h.render(); assert.equal(h.button('save-clip').props.disabled, false);
  await h.submit(); h.render();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].canExecute, true); assert.equal(h.saves[0].baseRevision, 1);
  assert.deepEqual(h.saves[0].patch.opacityEnvelope, envelope([{ frame: 0, opacity: .125 }]));
  assert.deepEqual(h.requests.map(request => request.method), ['GET', 'PUT', 'DELETE']);
  assert.deepEqual(h.requests[1].input.raw.opacityEnvelope, rawEnvelope('.125'));
  assert.equal(h.state.dirty, false); assert.equal(h.state.conflict, false); assert.equal(h.state.baseRevision, 2);
  assert.deepEqual(h.state.raw.opacityEnvelope, rawEnvelope('0.125'));
  assert.deepEqual(h.props.clip.opacityEnvelope, envelope([{ frame: 0, opacity: .125 }]));
});
test('Inspector discard restores exact saved absence or null after the v3 draft is acknowledged and deleted', async t => {
  for (const present of [false, true]) {
    const h = inspector(t);
    if (present) h.props.clip.opacityEnvelope = null; else delete h.props.clip.opacityEnvelope;
    h.render(); await h.ready();
    assert.equal(Object.hasOwn(h.state.raw, 'opacityEnvelope'), present);
    h.editor().props.onEdit(rawEnvelope('1e-')); h.render(); await h.controller.flush(); h.render();
    assert.equal(h.state.dirty, true); assert.equal(h.state.phase, 'saved');
    h.discard().props.onClick(); await tick(); h.render();
    assert.equal(h.state.dirty, false); assert.equal(Object.hasOwn(h.state.raw, 'opacityEnvelope'), present);
    if (present) assert.equal(h.state.raw.opacityEnvelope, null);
    assert.deepEqual(h.requests.map(request => request.method), ['GET', 'PUT', 'DELETE']);
    assert.deepEqual(h.requests[1].input.raw.opacityEnvelope, rawEnvelope('1e-')); assert.equal(h.saves.length, 0);
  }
});
test('candidate ACK projection validates the complete old timeline and rejects opacity outside the visual field path', async t => {
  const h = inspector(t); await h.ready(); const validate = h.hookOptions[0].validateTimeline;
  const original = structuredClone(h.props.timeline);
  original.clips[0].volumeEnvelope = { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: 0, multiplier: .75 }] };
  original.clips[0].audioRole = 'music';
  original.clips[0].colour = null;
  assert.equal(validate(original, id(1)), true);
  const projected = h.checks.at(-1);
  assert.equal(Object.hasOwn(projected.clips[0], 'opacityEnvelope'), false);
  assert.deepEqual(projected.clips[0].volumeEnvelope, original.clips[0].volumeEnvelope);
  assert.equal(projected.clips[0].audioRole, 'music'); assert.equal(projected.clips[0].colour, null);
  assert.ok(Object.hasOwn(original.clips[0], 'opacityEnvelope'));
  for (const mutate of [value => { value.extra = true; }, value => { value.clips[0].extra = true; }, value => { value.clips[0].gain = 3; }, value => { value.tracks[0].hidden = 'yes'; }, value => { value.opacityEnvelope = value.clips[0].opacityEnvelope; }]) {
    const bad = structuredClone(original); mutate(bad); assert.equal(validate(bad, id(1)), false);
  }
  for (const mutate of [value => { value.clips[0].opacityEnvelope.points[0].opacity = 1.1; }, value => { value.clips[0].trackId = id(6); }, value => { value.clips[0].opacityEnvelope.extra = 1; }, value => { value.clips[0].durationFrames = 9; }]) {
    const bad = structuredClone(original); mutate(bad); assert.equal(validate(bad, id(1)), false);
  }
  assert.equal(validate(original, id(9)), false);
});
test('incomplete or mismatching opacity ACK retains current input and never deletes its persisted draft', async t => {
  for (const saveResponse of [next => { delete next.clips[0].opacityEnvelope; return next; }, next => { next.clips[0].opacityEnvelope = envelope([{ frame: 0, opacity: .9 }]); return next; }, next => ({ ...next, clips: next.clips.map(clip => ({ ...clip, extra: true })) })]) {
    const h = inspector(t, { saveResponse }); await h.ready(); h.editor().props.onEdit(rawEnvelope('.2')); h.render();
    await h.submit(); h.render();
    assert.equal(h.saves.length, 1); assert.equal(h.state.dirty, true); assert.deepEqual(h.state.raw.opacityEnvelope, rawEnvelope('.2'));
    assert.deepEqual(h.requests.map(request => request.method), ['GET', 'PUT']); assert.ok(h.state.error);
  }
});
test('actual Inspector localizes unsupported recovered opacity and active input hints in all four languages', async t => {
  for (const locale of LOCALES) {
    const h = inspector(t, { locale }); await h.ready();
    h.editor().props.onEdit(rawEnvelope('.5')); h.render();
    const session = Symbol(locale); h.editor().props.onCompositionChange({ session, pending: true, dirty: true, row: 0, field: 'opacity', text: '一' }); h.render();
    assert.ok(h.text().includes(translate(locale, 'opacity.envelope.composing')));
    h.editor().props.onCompositionChange({ session, pending: false, dirty: false });
    h.props.asset = { ...h.props.asset, mimeType: 'audio/wav' }; h.render();
    assert.ok(h.editor()); assert.equal(h.editor().props.disabled, true); assert.ok(h.text().includes(translate(locale, 'opacity.envelope.unsupported')));
    assert.equal(h.button('save-clip').props.disabled, true);
  }
});
test('incomplete and infinite duration drafts remain visible and cannot submit through the candidate Inspector', async t => {
  for (const locale of LOCALES) for (const duration of ['1e-', '1e999']) {
    const h = inspector(t, { locale }); await h.ready();
    const before = structuredClone(h.state.raw.opacityEnvelope);
    assert.equal(h.controller.edit('durationFrames', duration), true); h.render();
    assert.ok(h.text().includes(translate(locale, 'opacity.envelope.durationInvalid')));
    assert.equal(h.button('save-clip').props.disabled, true); assert.equal(h.state.raw.durationFrames, duration);
    await h.submit(); assert.equal(h.saves.length, 0); assert.deepEqual(h.state.raw.opacityEnvelope, before);
    assert.equal(h.state.dirty, true); assert.deepEqual(h.requests.map(request => request.method), ['GET']);
  }
});
