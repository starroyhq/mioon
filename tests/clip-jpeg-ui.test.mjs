import { i18nTestModule } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createClipLutController, clipLutSourceIssue, clipLutSourceMessage} from '../apps/web/src/clip-lut-state.ts';
import {createClipLutRecovery} from '../apps/web/src/clip-lut-recovery.ts';
import {clipDraftRaw, clipDraftPatch, createClipDraftController} from '../apps/web/src/clip-draft-state.ts';
import {clipDraftDiskSchema} from '../packages/contracts/src/local-drafts.ts';
import {clipReplacementAcknowledged} from '../apps/web/src/clip-source-replacement.js';

const id = n => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), clipId = id(2), assetId = id(3), timelineId = id(4), trackId = id(5);
const stamp = '2026-10-15T04:00:00.000Z', hash = 'a'.repeat(64);
const operation = 'timeline.colour.jpeg.inspect';
const evidence = patch => ({profileId: 'jfif-ycbcr8-srgb-v1', sha256: hash, sourceByteLength: 800,
  width: 17, height: 13, bitDepth: 8, alphaMode: 'opaque', orientation: 1, colourTag: 'untagged', sampling: '420',
  decoderPolicy: 'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1', ...patch});
const inspection = patch => ({projectId, assetId, assetSha256: hash, kind: 'image',
  status: 'needs_interpretation', evidence: evidence(), ...patch});
const source = {assetSha256: hash, profileId: 'jfif-ycbcr8-srgb-v1', interpretation: 'srgb',
  declaredBy: 'user', declaredAt: stamp, evidence: evidence()};
const colour = patch => ({profileId: 'mioon-jfif-image-clip-v1', source, look: null, ...patch});
const look = {resourceId: id(10), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1',
  purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: false, strength: 0.37};
const context = patch => ({scope: 'owned:project', projectId, timelineId, clipId, assetId,
  assetSha256: hash, blocked: false, kind: 'image', mimeType: 'image/jpeg', ...patch});
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function harness(t, {current = context(), handler} = {}) {
  let live = structuredClone(current);
  const calls = [], edits = [], storage = new Map();
  const recovery = createClipLutRecovery({lock: async (_name, action) => action(), storage: () => ({
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  })});
  const controller = createClipLutController({getContext: () => live, imports: new Map(), recovery,
    readWorkspace: async key => ({supported: true, workspaceScope: hash, instanceId: id(70), key, revision: 0, targetStatus: 'matching', draft: null}),
    now: () => stamp, newRequestId: () => id(20), timeoutMs: 1000,
    rpc: async (name, input) => {
      calls.push([name, structuredClone(input)]);
      if (handler) { const result = handler(name, input); if (result !== undefined) return result; }
      if (name === operation) return inspection();
      if (name === 'lut.list') return {projectId: input.projectId, items: [], nextAfter: null};
      throw Error(`Unexpected operation ${name}`);
    }, edit: value => { edits.push(structuredClone(value)); live.colour = value; }, onChange() {},
  });
  t.after(() => controller.dispose());
  return {controller, calls, edits, state: () => controller.getState(), live: () => live,
    set: patch => { live = {...live, ...patch}; }};
}

test('JPEG inspection uses its distinct route and never infers sRGB or saves a clip', async t => {
  const h = harness(t);
  assert.deepEqual(h.calls, []); assert.equal(h.controller.confirmSource(), false);
  h.controller.open(); await tick();
  assert.deepEqual(h.calls.map(([name]) => name), [operation, 'lut.list']);
  assert.equal(h.state().sourcePhase, 'ready'); assert.equal(h.state().sourceDeclared, false);
  assert.equal(h.state().inspection.status, 'needs_interpretation');
  assert.equal(h.controller.confirmSource(), false); assert.deepEqual(h.edits, []);
  h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true);
  assert.deepEqual(h.edits, [colour()]); assert.equal(h.state().sourceDeclared, false);
  assert.equal(Object.hasOwn(h.live().colour.source, 'range'), false, 'JPEG never borrows the video range selector');
  assert.deepEqual(h.live().colour.source.evidence, evidence());
  assert.equal(h.calls.some(([name]) => name === 'timeline.clip.update'), false, 'only common Save persists the draft');
});

test('PNG and video routing remain distinct from JPEG', async t => {
  const png = inspection({evidence: {profileId: 'png-rgb8-srgb-v1', sha256: hash, sourceByteLength: 100,
    width: 2, height: 1, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'untagged'}});
  const video = {projectId, assetId, assetSha256: hash, streamIndex: 0, status: 'compatible', reason: null,
    evidence: {primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'limited', pixelFormat: 'yuv420p', bitDepth: 8, hdrMetadata: false}};
  for (const [patch, name, reply] of [
    [{mimeType: 'image/png'}, 'timeline.colour.image.inspect', png],
    [{kind: 'video', mimeType: 'video/mp4'}, 'timeline.colour.source.inspect', video],
  ]) {
    const h = harness(t, {current: context(patch), handler: op => op === name ? reply : undefined});
    h.controller.open(); await tick(); assert.equal(h.calls[0][0], name); assert.equal(h.state().sourcePhase, 'ready');
    assert.equal(h.calls.some(([op]) => op === operation), false);
  }
});

test('JPEG controller rejects foreign SHA, legacy PNG evidence, unsupported metadata and forged compatibility', async t => {
  for (const reply of [
    inspection({projectId: id(90)}), inspection({assetId: id(91)}), inspection({assetSha256: 'f'.repeat(64)}),
    inspection({evidence: evidence({sha256: 'f'.repeat(64)})}), inspection({status: 'compatible'}),
    inspection({status: 'unsupported'}), inspection({kind: 'video'}),
    inspection({evidence: evidence({profileId: 'png-rgb8-srgb-v1'})}),
    inspection({evidence: evidence({colourTag: 'srgb'})}), inspection({evidence: evidence({colourTag: 'icc'})}),
    inspection({evidence: evidence({decoderPolicy: 'auto'})}), inspection({evidence: evidence({orientation: 6})}),
    inspection({evidence: evidence({alphaMode: 'straight'})}),
  ]) {
    const h = harness(t, {handler: op => op === operation ? reply : undefined}); h.controller.open(); await tick();
    assert.equal(h.state().sourcePhase, 'error'); assert.equal(h.state().inspection, null);
    h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), false); assert.deepEqual(h.edits, []);
  }
});

test('late JPEG inspection cannot act after navigation, source replacement, hash or MIME changes', async t => {
  for (const patch of [{projectId: id(90)}, {timelineId: id(91)}, {clipId: id(92)}, {assetId: id(93)},
    {assetSha256: 'f'.repeat(64)}, {scope: 'new-open'}, {kind: 'video'}, {mimeType: 'image/png'}]) {
    const gate = deferred(), h = harness(t, {handler: op => op === operation ? gate.promise : undefined});
    h.controller.open(); h.set(patch); gate.resolve(inspection()); await tick();
    assert.equal(h.state().opened, false); assert.equal(h.state().inspection, null);
    h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), false); assert.deepEqual(h.edits, []);
  }
});

test('JPEG reinspection revokes approval and stale inspection requests cannot win', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness(t, {handler: op => op === operation ? (++count === 1 ? first.promise : second.promise) : undefined});
  h.controller.open(); h.controller.declareSource(true);
  const next = h.controller.inspectSource(); assert.equal(h.state().sourceDeclared, false);
  first.resolve(inspection()); await tick(); assert.equal(h.state().sourcePhase, 'loading'); assert.equal(h.state().inspection, null);
  second.resolve(inspection()); await next; assert.equal(h.state().sourcePhase, 'ready');
  assert.equal(h.controller.confirmSource(), false); assert.deepEqual(h.edits, []);
  h.set({blocked: true}); h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), false);
});

test('reconfirming a replaced JPEG preserves the exact disabled Look and frozen source evidence', async t => {
  const h = harness(t, {current: context({colour: colour({source: null, look})})});
  h.controller.open(); await tick(); h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true);
  assert.deepEqual(h.live().colour, colour({look}));
  assert.equal(h.live().colour.source.assetSha256, h.live().colour.source.evidence.sha256);
  assert.deepEqual(h.live().colour.source.evidence.decoderPolicy, evidence().decoderPolicy);
  assert.equal(h.controller.removeLook(), true); assert.deepEqual(h.live().colour, colour());
});

const raw = {name: 'JPEG clip', trackId, startFrame: 0, durationFrames: 30, sourceInFrame: 0,
  rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1};
test('JPEG declaration and Look survive durable drafts and common Save rejects dropped evidence', async t => {
  const value = {...raw, colour: colour({look})};
  assert.deepEqual(clipDraftRaw(value), value); assert.deepEqual(clipDraftPatch(value), value);
  const key = {projectId, timelineId, clipId}, draft = {baseRevision: 1, source: {assetId, assetSha256: hash}, raw: value, updatedAt: stamp};
  const disk = {version: 1, workspaceScope: hash, entries: [{...key, revision: 1, draft}]};
  assert.deepEqual(clipDraftDiskSchema.parse(JSON.parse(JSON.stringify(disk))), disk);
  const ctx = {...key, scope: 's', restored: false, connected: true, busy: false, visible: true,
    timelineRevision: 1, source: {assetId, assetSha256: hash}, saved: raw};
  let record = {supported: true, workspaceScope: hash, instanceId: id(50), key, revision: 0, targetStatus: 'matching', draft: null}, deletes = 0;
  const client = {get: async () => structuredClone(record),
    put: async input => (record = {...record, revision: record.revision + 1, draft: {raw: structuredClone(input.raw), source: input.source, baseRevision: input.baseRevision, updatedAt: stamp}}),
    remove: async () => { deletes++; return record = {...record, revision: record.revision + 1, draft: null}; }};
  const c = createClipDraftController({context: ctx, client, delay: 100000, validateTimeline: () => true});
  t.after(() => c.dispose()); await c.load(); assert.equal(c.edit('colour', colour({look})), true); await c.flush();
  assert.deepEqual(record.draft.raw.colour, colour({look}));
  await c.save(async () => ({id: timelineId, projectId, revision: 2, clips: [{id: clipId, assetId, ...raw}]}));
  assert.equal(c.getState().dirty, true); assert.equal(deletes, 0);
  await c.save(async (_id, patch) => ({id: timelineId, projectId, revision: 2, clips: [{id: clipId, assetId, ...patch}]}));
  assert.equal(c.getState().dirty, false); assert.equal(deletes, 1);
});

test('JPEG source replacement acknowledgment requires cleared source but preserved exact Look', () => {
  const before = {id: clipId, assetId, ...raw, colour: colour({look})}, newId = id(60);
  const review = {timelineId, projectId, clipId, expectedRevision: 1, clip: before, candidate: {assetId: newId}};
  const response = value => ({id: timelineId, projectId, revision: 2, clips: [{...before, assetId: newId, colour: value}]});
  assert.equal(clipReplacementAcknowledged(review, response(colour({look}))), false);
  assert.equal(clipReplacementAcknowledged(review, response(colour({source: null, look}))), true);
  assert.equal(clipReplacementAcknowledged(review, response(colour({source: null, look: {...look, enabled: true}}))), false);
  assert.equal(clipReplacementAcknowledged(review, response(null)), false);
});

function renderControls(state, ctx) {
  const module = {exports: {}}, noop = () => {};
  const controller = new Proxy({getState: () => state}, {get: (target, key) => target[key] || noop});
  const react = {createElement: (type, props, ...children) => ({type, props: {...props, children}}),
    useRef: value => ({current: value}), useState: () => [state, noop], useLayoutEffect: noop}; react.default = react;
  const output = transformSync(readFileSync(new URL('../apps/web/src/ClipLutControls.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;
  Function('require', 'module', 'exports', output)(name => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name === './LookPackControls.tsx') return {default: 'LookPackControls', LookPackDetails: 'LookPackDetails'};
    if (name === './clip-draft-client.ts') return {createClipDraftClient: () => ({get: noop})};
    if (name === './clip-lut-state.ts') return {createClipLutController: () => controller, clipLutSourceIssue, clipLutSourceMessage};
    if (name.startsWith('@mioon/ui/components/')) return {[name.split('/').at(-1).replace(/^./, value => value.toUpperCase())]: name};
    throw Error(`Unexpected ${name}`);
  }, module, module.exports);
  return module.exports.default({context: ctx, kind: 'image', onEdit: noop, rpc: noop, Select: 'Select'});
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const textOf = tree => Array.isArray(tree) ? tree.map(textOf).join(' ') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree ?? '';
test('actual JPEG controls disclose format, interpretation limits, draft-only save and no video range control', async t => {
  const h = harness(t); h.controller.open(); await tick();
  let tree = renderControls(h.state(), h.live());
  const byId = id => nodes(tree).find(node => node.props?.['data-testid'] === id);
  assert.match(textOf(byId('clip-image-source-evidence')), /JFIF JPEG/);
  assert.doesNotMatch(textOf(byId('clip-image-source-evidence')), /已核验 PNG/);
  assert.match(textOf(byId('clip-image-colour-disclosure')), /无 EXIF、无 ICC.*基线 JFIF/);
  assert.match(textOf(byId('clip-image-colour-disclosure')), /标记本身不代表 sRGB/);
  assert.match(textOf(byId('clip-image-colour-disclosure')), /PNG 与 JPEG 合计/);
  assert.match(textOf(byId('clip-lut-save-reminder')), /草稿.*保存片段/);
  assert.equal(byId('clip-lut-source-range'), undefined);
  assert.equal(byId('confirm-clip-colour-source').props.disabled, true);
  h.controller.declareSource(true); assert.equal(h.controller.confirmSource(), true);
  tree = renderControls(h.state(), h.live());
  assert.match(textOf(byId('clip-lut-source-confirmed')), /sRGB JFIF JPEG.*用户解释/);
  assert.match(readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8'), /mimeType: asset\?\.mimeType/);
});
